import type { Diagnostic, IRNode, ProgramIR, Span } from './ir.js';
export type RuleId = 'CG001' | 'CG002' | 'CG003' | 'CG004' | 'CG005' | 'CG006' | 'CG007' | 'CG008';
export interface Finding {
  rule: string; severity: 'error' | 'warning' | 'review'; file: string; line: number; column: number;
  circuit?: string; message: string; docUrl: string;
  evidence?: { kind: 'static' | 'exploit'; detail: string; repro?: string };
}
export interface AnalyzerOptions {
  rules?: RuleId[]; oneTimeCircuits?: string[]; maxCallDepth?: number; lowDomainBits?: number;
}
export interface TypeInfo {
  name: string; bits?: number; members?: Record<string, TypeInfo>; element?: TypeInfo; length?: number;
}
export interface Origin { kind: 'witness' | 'argument' | 'ledger' | 'constant' | 'unknown'; name: string; span?: Span }
export interface Value {
  id: string; type: TypeInfo; origins: Origin[]; bits?: number; literal?: string | number | boolean;
  members?: Record<string, Value>; domain: boolean; ownKey: boolean;
  transforms: string[]; predicate?: Predicate; pathLeaves: string[]; callable?: IRNode;
  // A type-based entropy class, not a proof of randomness. Only direct crypto
  // outputs carry protectedKey; transformation history alone cannot hide raw data.
  highEntropy?: boolean; symbol?: string; protectedKey?: string; disclosed?: boolean;
}
export interface Predicate { kind: 'eq' | 'neq' | 'not' | 'and' | 'or' | 'member'; values: Value[]; target?: string }
export interface Event {
  kind: 'hash' | 'commit' | 'member' | 'insert' | 'assert' | 'merkle' | 'disclose' | 'write' | 'branch';
  node: IRNode; args: Value[]; result: Value; name?: string; target?: string; conditional: boolean;
  // Guard identities are copied at the operation, never filled retroactively.
  guards: Predicate[]; callPath: string[];
  branchPath: Record<string, boolean>;
}
export interface ValueSummary { type: string; domainBitsUpperBound?: number; origins: Origin[]; transforms: string[] }
export interface CircuitSummary { name: string; file: string; calls: string[]; returnValue: ValueSummary; events: Array<{kind: Event['kind']; span: Span; inputs: ValueSummary[]}> }
export interface AnalysisResult { findings: Finding[]; diagnostics: Diagnostic[]; circuits: CircuitSummary[]; callGraph: Record<string, string[]> }
export const UNKNOWN: TypeInfo = { name: 'unknown' };
export const unique = <T>(values: T[]): T[] => [...new Set(values)];
export function origins(values: Value[]): Origin[] { const out = new Map<string, Origin>(); for (const v of values) for (const o of v.origins) out.set(`${o.kind}:${o.name}:${o.span?.file}:${o.span?.start}`, o); return [...out.values()]; }
export function privateValue(value: Value): boolean { return value.origins.some(o => o.kind === 'witness' || o.kind === 'argument'); }
export function summary(value: Value): ValueSummary { return { type: value.type.name, domainBitsUpperBound: value.bits, origins: value.origins, transforms: value.transforms }; }
export function unknown(id: string, from: Value[] = []): Value { return { id, type: UNKNOWN, origins: from.length ? origins(from) : [{ kind: 'unknown', name: id }], domain: false, ownKey: from.some(v => v.ownKey), transforms: unique(from.flatMap(v => v.transforms)), pathLeaves: unique(from.flatMap(v => v.pathLeaves)) }; }
export function controlled(value: Value, condition: Value): Value {
  return { ...value, origins: origins([value, condition]), ownKey: value.ownKey || condition.ownKey,
    symbol: JSON.stringify(['controlled', condition.symbol ?? condition.id, value.symbol ?? value.id]),
    members: value.members && Object.fromEntries(Object.entries(value.members).map(([key, member]) => [key, controlled(member, condition)])) };
}
export function merge(values: Value[], id: string, type: TypeInfo = UNKNOWN): Value {
  if (!values.length) return unknown(id);
  const same = values.every(v => v.id === values[0].id);
  const members: Record<string, Value> = {};
  const keys = unique(values.flatMap(v => Object.keys(v.members ?? {})));
  for (const key of keys) members[key] = merge(values.map(v => v.members?.[key] ?? unknown(`${v.id}.${key}`)), `${id}.${key}`);
  return { id: same ? values[0].id : id, type: type.name === 'unknown' && values.every(v => v.type.name === values[0].type.name) ? values[0].type : type,
    origins: origins(values), bits: values.every(v => v.bits !== undefined) ? Math.max(...values.map(v => v.bits!)) + (same ? 0 : Math.ceil(Math.log2(values.length))) : undefined,
    literal: values.every(v => v.literal !== undefined && v.literal === values[0].literal) ? values[0].literal : undefined,
    domain: values.every(v => v.domain), ownKey: values.some(v => v.ownKey), transforms: unique(values.flatMap(v => v.transforms)),
    predicate: same ? values[0].predicate : undefined,
    highEntropy: values.every(v => v.highEntropy),
    disclosed: values.every(v => v.disclosed),
    symbol: values.every(v => v.symbol === values[0].symbol) ? values[0].symbol : JSON.stringify(['merge', ...values.map(v => v.symbol ?? v.id)]),
    protectedKey: values.every(v => v.protectedKey === values[0].protectedKey) ? values[0].protectedKey : undefined,
    members: keys.length ? members : undefined, pathLeaves: unique(values.flatMap(v => v.pathLeaves)) };
}
export function lookup<T>(map: Map<string, T>, name: string, module?: string): T | undefined {
  let scope = module;
  while (scope) { const item = map.get(`${scope}.${name}`); if (item) return item; scope = scope.includes('.') ? scope.slice(0, scope.lastIndexOf('.')) : undefined; }
  return map.get(name);
}
export function typeOf(node: IRNode | undefined, program: ProgramIR, module?: string, seen = new Set<string>()): TypeInfo {
  if (!node) return UNKNOWN;
  const f = (key: string) => node.fields[key]?.[0];
  const numeric = (n?: IRNode) => n?.kind === 'number_literal' ? Number(n.text) : undefined;
  const clamp = (x?: number) => x !== undefined && Number.isFinite(x) ? Math.min(x, 1024) : undefined;
  switch (node.kind) {
    case 'primitive_type': return { name: node.text, bits: node.text === 'Boolean' ? 1 : 254 };
    case 'uint_type': { const range = f('range'); const a = numeric(range?.fields.start?.[0]), b = numeric(range?.fields.end?.[0]); return { name: node.text, bits: range ? a !== undefined && b !== undefined && b >= a ? clamp(Math.ceil(Math.log2(b - a + 1))) : undefined : clamp(numeric(f('size'))) }; }
    case 'bytes_type': return { name: node.text, bits: clamp(numeric(f('size')) === undefined ? undefined : numeric(f('size'))! * 8) };
    case 'opaque_type': return { name: node.text };
    case 'vector_type': { const element = typeOf(f('type'), program, module, seen), length = numeric(f('size')); return { name: node.text, element, length, bits: length !== undefined && element.bits !== undefined ? clamp(length * element.bits) : undefined }; }
    case 'tuple_type': { const members = Object.fromEntries((node.fields.type ?? []).map((n, i) => [String(i), typeOf(n, program, module, seen)])); return { name: node.text, members, bits: Object.values(members).every(t => t.bits !== undefined) ? clamp(Object.values(members).reduce((sum, t) => sum + t.bits!, 0)) : undefined }; }
    case 'type_reference': {
      const name = f('name')?.text ?? node.text; if (seen.has(name)) return { name };
      const next = new Set(seen).add(name), alias = lookup(program.typeAliases, name, module);
      if (alias) return typeOf(alias.fields.type?.[0], program, module, next);
      const enumeration = lookup(program.enums, name, module);
      if (enumeration) return { name, bits: Math.ceil(Math.log2(enumeration.fields.body?.[0].fields.member?.length ?? 1)) };
      const struct = lookup(program.structs, name, module);
      if (struct) { const members = Object.fromEntries((struct.fields.body?.[0].fields.member ?? []).map(n => [n.fields.name?.[0].text ?? '?', typeOf(n.fields.type?.[0], program, module, next)])); return { name, members, bits: Object.values(members).every(t => t.bits !== undefined) ? clamp(Object.values(members).reduce((sum, t) => sum + t.bits!, 0)) : undefined }; }
      return { name: node.text };
    }
    default: return UNKNOWN;
  }
}
