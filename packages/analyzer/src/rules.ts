import { walk, type CircuitIR, type IRNode, type ProgramIR } from './ir.js';
import { privateValue, type AnalyzerOptions, type Event, type Finding, type Predicate, type RuleId, type Value } from './model.js';
import type { Evaluation } from './engine.js';

const DOC = 'https://docs.midnight.network/compact/smart-contract-security';
interface Fact { kind: 'eq' | 'neq' | 'member'; values: Value[]; target?: string; truth: boolean }
// Only facts that must hold are admitted. An OR does not establish either operand.
function facts(predicate: Predicate, truth = true): Fact[] {
  if (predicate.kind === 'not') return predicate.values[0]?.predicate ? facts(predicate.values[0].predicate, !truth) : [];
  if ((predicate.kind === 'and' && truth) || (predicate.kind === 'or' && !truth)) return predicate.values.flatMap(v => v.predicate ? facts(v.predicate, truth) : []);
  if (predicate.kind === 'and' || predicate.kind === 'or') return [];
  if ((predicate.kind === 'eq' || predicate.kind === 'neq') && predicate.values.length === 2) {
    const [a, b] = predicate.values;
    const literal = typeof a.literal === 'boolean' ? a : typeof b.literal === 'boolean' ? b : undefined;
    const other = literal === a ? b : a;
    if (literal && other.predicate) return facts(other.predicate, (predicate.kind === 'eq' ? truth : !truth) === literal.literal);
  }
  return [{ ...predicate, kind: predicate.kind, truth }];
}
function guardFacts(event: Event): Fact[] { return event.guards.flatMap(p => facts(p)); }
function compatible(a: Event, b: Event): boolean { return Object.entries(a.branchPath).every(([key, value]) => !(key in b.branchPath) || b.branchPath[key] === value); }
function guardUses(predicate: Predicate, value: Value): boolean {
  return predicate === value.predicate || predicate.values.some(v => v.id === value.id || !!v.predicate && guardUses(v.predicate, value));
}
function binding(event: Event, path: string): boolean {
  return guardFacts(event).some(f => (f.kind === 'eq' && f.truth || f.kind === 'neq' && !f.truth) && f.values.some((v, i) => {
    const other = f.values[1 - i];
    return v.id === `${path}.leaf` && other && other.id !== v.id &&
      (other.transforms.includes('hash') || other.transforms.includes('commit') || other.origins.every(o => o.kind === 'ledger' || o.kind === 'constant'));
  }));
}
function separated(value: Value): boolean { return value.domain || !!value.members?.['0']?.domain; }
function oneTime(program: ProgramIR, circuit: CircuitIR, options: AnalyzerOptions): boolean {
  if (options.oneTimeCircuits?.includes(circuit.qualifiedName)) return true;
  return [...walk(program.root)].some(n => n.kind === 'comment' && /^\/\/\s*compact-guard:\s*one-time\s+(\S+)\s*$/.exec(n.text)?.[1] === circuit.qualifiedName);
}
export function runRules(program: ProgramIR, circuit: CircuitIR, evaluation: Evaluation, options: AnalyzerOptions): Finding[] {
  const result: Finding[] = [], commits: Event[] = [];
  function add(rule: RuleId, severity: Finding['severity'], node: IRNode, message: string, event?: Event): void {
    if (options.rules && !options.rules.includes(rule)) return;
    const { file, line, column } = node.span;
    const detail = event ? `${event.callPath.join(' -> ')}; ${event.args.map(v => `${v.type.name}: ${v.origins.map(o => `${o.kind} ${o.name}`).join(', ')}${v.bits === undefined ? '' : `; domain <= 2^${v.bits}`}${v.transforms.length ? `; via ${v.transforms.join(', ')}` : ''}`).join(' | ')}` : `Explicit one-time intent for ${circuit.qualifiedName}; no unconditional matching absence check and insertion was recognized.`;
    if (!result.some(f => f.rule === rule && f.file === file && f.line === line && f.column === column)) result.push({ rule, severity, file, line, column, circuit: circuit.qualifiedName, message, docUrl: DOC, evidence: { kind: 'static', detail } });
  }
  for (const event of evaluation.events) {
    const input = event.args[0];
    if (event.kind === 'assert' && input.ownKey) add('CG001', 'warning', event.node, 'Authorization depends on ownPublicKey(), whose witness can be forged.', event);
    if (event.kind === 'branch' && input.ownKey && evaluation.events.some(e => ['write', 'insert'].includes(e.kind) && (input.id in e.branchPath || e.guards.some(p => guardUses(p, input))))) add('CG001', 'warning', event.node, 'A state-changing branch depends on the untrusted ownPublicKey() witness.', event);
    if (event.kind === 'hash' && input) {
      if (privateValue(input) && input.bits !== undefined && input.bits > 0 && input.bits <= (options.lowDomainBits ?? 16)) add('CG002', 'warning', event.node, `Hash input has a domain bounded by 2^${input.bits}; exhaustive guessing may recover its private value.`, event);
      if (!separated(input)) add('CG006', 'review', event.node, 'Hash input has no recognized nonempty literal domain prefix; review domain separation.', event);
    }
    if (event.kind === 'commit') {
      const randomizer = event.args[1];
      if (randomizer && commits.some(previous => previous.args[1]?.id === randomizer.id && compatible(previous, event))) add('CG003', 'warning', event.node, 'Two commitments reuse the same randomizer value; derive independent randomness for each context.', event);
      else if (randomizer && randomizer.origins.every(o => o.kind === 'constant' || o.kind === 'ledger')) add('CG003', 'review', event.node, 'Commitment randomizer is constant or public ledger data; review freshness and secrecy.', event);
      commits.push(event);
    }
    if (event.kind === 'member' && input && privateValue(input)) add('CG004', 'warning', event.node, 'Set/Map access uses private-derived data as a public key; review the disclosure or use a Merkle proof.', event);
    if (event.kind === 'merkle' && input && privateValue(input) && (!input.pathLeaves.length || input.pathLeaves.some(path => !binding(event, path)))) add('CG005', 'review', event.node, 'Witness-derived Merkle root lacks a preceding equality binding its path leaf to a recomputed or trusted leaf.', event);
    if (event.kind === 'assert' && input.predicate) {
      const comparedRoots = facts(input.predicate).filter(f => f.kind === 'eq' && f.truth || f.kind === 'neq' && !f.truth).flatMap(f => f.values).filter(v => v.pathLeaves.length && privateValue(v));
      const asserted = { ...event, guards: [...event.guards, input.predicate] };
      if (comparedRoots.some(v => v.pathLeaves.some(path => !binding(asserted, path)))) add('CG005', 'review', event.node, 'Asserted Merkle root comparison lacks an equality binding its witness path leaf to a recomputed or trusted leaf.', event);
    }
    if (event.kind === 'disclose' && input && privateValue(input) && (Object.keys(input.members ?? {}).length > 1 || (input.type.length ?? 0) > 1)) add('CG007', 'review', event.node, 'An entire private aggregate is disclosed; check whether disclosing selected fields would suffice.', event);
  }
  if (oneTime(program, circuit, options)) {
    const guarded = evaluation.events.some((e, i) => e.kind === 'insert' && !e.conditional &&
      !evaluation.events.slice(i + 1).some(later => later.kind === 'write' && later.target === e.target && compatible(e, later)) &&
      guardFacts(e).some(f => f.kind === 'member' && !f.truth && f.target === e.target && f.values[0]?.id === e.args[0]?.id));
    if (!guarded) add('CG008', 'review', circuit.node, 'One-time circuit has no recognized unconditional nullifier absence check followed by insertion.');
  }
  return result;
}
