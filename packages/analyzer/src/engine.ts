import { callName, field, fields, identifierName, walk, type CircuitIR, type Diagnostic, type IRNode, type ProgramIR } from './ir.js';
import { controlled, lookup, merge, origins, summary, typeOf, unique, unknown, UNKNOWN, type AnalyzerOptions, type CircuitSummary, type Event, type Origin, type Predicate, type TypeInfo, type Value } from './model.js';

class Environment {
  frames: Map<string, Value>[] = [new Map()];
  clone(): Environment { const result = new Environment(); result.frames = this.frames.map(f => new Map(f)); return result; }
  get(name: string): Value | undefined { for (const frame of this.frames.slice().reverse()) if (frame.has(name)) return frame.get(name); }
  define(name: string, value: Value): void { this.frames[this.frames.length - 1].set(name, value); }
  set(name: string, value: Value): boolean { for (const frame of this.frames.slice().reverse()) if (frame.has(name)) { frame.set(name, value); return true; } return false; }
}
interface Context {
  circuit: CircuitIR; root: string; env: Environment; guards: Predicate[]; branchPath: Record<string, boolean>;
  stack: string[]; events: Event[]; returns: Value[]; terminated: boolean;
  publicIds: Set<string>;
}
export interface Evaluation { events: Event[]; summary: CircuitSummary }
const STANDARD = new Set(['ownPublicKey', 'persistentHash', 'transientHash', 'persistentCommit', 'transientCommit', 'merkleTreePathRoot', 'merkleTreePathRootNoLeafHash', 'some', 'none', 'isSome', 'isNone', 'left', 'right', 'isLeft', 'isRight', 'either', 'ownContractAddress', 'nativeToken', 'tokenType', 'mintToken', 'send', 'receive', 'createZswapInput', 'createZswapOutput', 'currentBlockTime', 'blockTimeGte', 'blockTimeLt']);

export class Evaluator {
  readonly diagnostics: Diagnostic[] = [];
  readonly callGraph: Record<string, string[]> = {};
  private sequence = 0;
  private budget = 0;
  private standardAll = false;
  private standardAliases = new Map<string, string>();
  private moduleAliases = new Map<string, string>();
  constructor(readonly program: ProgramIR, readonly options: AnalyzerOptions = {}) {
    for (const node of program.imports) {
      const name = field(node, 'name')?.text, prefix = identifierName(field(node, 'prefix'));
      const selected = fields(field(node, 'selection'), 'element');
      if (name === 'CompactStandardLibrary') {
        if (!selected.length && !prefix) this.standardAll = true;
        for (const original of selected.length ? selected.map(n => identifierName(field(n, 'name'))) : [...STANDARD]) {
          const alias = selected.find(n => identifierName(field(n, 'name')) === original);
          this.standardAliases.set(prefix + (identifierName(field(alias, 'alias')) || original), original);
        }
      } else if (name && node.kind === 'import_declaration' && field(node, 'name')?.kind === 'identifier') {
        const moduleName = identifierName(name);
        for (const circuit of program.circuits.values()) if (circuit.module === moduleName && circuit.exported && (!selected.length || selected.some(n => identifierName(field(n, 'name')) === circuit.name))) {
          const select = selected.find(n => identifierName(field(n, 'name')) === circuit.name);
          this.moduleAliases.set(prefix + (identifierName(field(select, 'alias')) || circuit.name), circuit.qualifiedName);
        }
        if (![...program.circuits.values()].some(c => c.module === moduleName)) this.diagnostic(node, 'unresolved-import', `Module ${moduleName} is not available; imported calls will remain unknown.`);
      } else this.diagnostic(node, 'unresolved-import', 'External imports/includes are not linked by source analysis; analyze their files separately.');
    }
    for (const circuit of program.circuits.values()) {
      const calls = [...walk(circuit.body)].filter(n => n.kind === 'call_expression').map(callName).filter((s): s is string => !!s);
      this.callGraph[circuit.qualifiedName] = unique(calls.map(name => lookup(program.circuits, this.moduleAliases.get(name) ?? name, circuit.module)?.qualifiedName ?? name));
    }
  }
  diagnostic(node: IRNode, code: string, message: string): void {
    const { file, line, column } = node.span;
    if (!this.diagnostics.some(d => d.code === code && d.file === file && d.line === line && d.column === column)) this.diagnostics.push({ code, severity: 'warning', message, file, line, column });
  }
  private id(prefix: string): string { return `${prefix}#${++this.sequence}`; }
  private ledgerId(node: IRNode): string { return `ledger:${node.span.file}:${node.span.start}`; }
  private typed(type: TypeInfo, id: string, source: Origin[], depth = 0, symbol = id): Value {
    // Domain bound is conditional on already public ledger values.
    const value: Value = { id, type, bits: source.every(o => o.kind === 'ledger' || o.kind === 'constant') ? 0 : type.bits, origins: source, domain: false, ownKey: false, transforms: [], pathLeaves: [] };
    value.symbol = symbol;
    value.highEntropy = source.some(o => o.kind === 'witness' || o.kind === 'argument') && (value.bits ?? 0) >= 128;
    if (type.members && depth < 12) {
      value.members = Object.fromEntries(Object.entries(type.members).map(([key, t]) => [key, this.typed(t, `${id}.${key}`, source, depth + 1, `${symbol}.${key}`)]));
      value.highEntropy = Object.values(value.members).some(v => v.highEntropy);
    }
    return value;
  }
  private event(ctx: Context, kind: Event['kind'], node: IRNode, args: Value[], result: Value, name?: string, target?: string): void {
    ctx.events.push({ kind, node, args, result, name, target, conditional: Object.keys(ctx.branchPath).length > 0, branchPath: { ...ctx.branchPath }, guards: [...ctx.guards], callPath: [...ctx.stack] });
  }
  evaluate(circuit: CircuitIR): Evaluation {
    this.budget = 0;
    const ctx: Context = { circuit, root: circuit.qualifiedName, env: new Environment(), guards: [], branchPath: {}, stack: [circuit.qualifiedName], events: [], returns: [], terminated: false, publicIds: new Set() };
    for (const p of circuit.params) this.bind(field(p, 'name'), this.typed(typeOf(field(p, 'type'), this.program, circuit.module), `arg:${circuit.qualifiedName}:${field(p, 'name')?.text}`, [{ kind: 'argument', name: `${circuit.qualifiedName}.${field(p, 'name')?.text}`, span: p.span }]), ctx, true);
    this.statement(circuit.body, ctx);
    const result = ctx.returns.length ? merge(ctx.returns, `return:${circuit.qualifiedName}`) : this.aggregate([], 'tuple', 'unit');
    return { events: ctx.events, summary: { name: circuit.qualifiedName, file: circuit.node.span.file, calls: this.callGraph[circuit.qualifiedName] ?? [], returnValue: summary(result), events: ctx.events.map(e => ({ kind: e.kind, span: e.node.span, inputs: e.args.map(summary) })) } };
  }
  private fork(ctx: Context, condition?: Value, truth = true): Context {
    const child = { ...ctx, env: ctx.env.clone(), guards: [...ctx.guards], branchPath: { ...ctx.branchPath }, returns: [], terminated: false, publicIds: new Set(ctx.publicIds) };
    if (condition) { child.branchPath[condition.id] = truth; child.guards.push(truth ? condition.predicate ?? { kind: 'and', values: [condition] } : { kind: 'not', values: [condition] }); }
    return child;
  }
  private join(ctx: Context, yes: Context, no: Context, condition: Value): void {
    // A value exposed on either feasible path cannot be assumed secret.
    ctx.publicIds = new Set([...yes.publicIds, ...no.publicIds]);
    for (let i = 0; i < ctx.env.frames.length; i++) for (const [name, original] of ctx.env.frames[i]) {
      const a = yes.env.frames[i]?.get(name) ?? original, b = no.env.frames[i]?.get(name) ?? original;
      const value = yes.terminated ? b : no.terminated ? a : merge([a, b], this.id('join'));
      ctx.env.frames[i].set(name, a.id === b.id ? value : controlled(value, condition));
    }
    ctx.guards = yes.terminated ? no.guards : no.terminated ? yes.guards : yes.guards.filter(p => no.guards.some(q => predicateKey(p) === predicateKey(q)));
    ctx.returns.push(...[...yes.returns, ...no.returns].map(value => controlled(value, condition)));
    ctx.terminated = yes.terminated && no.terminated;
  }
  private statement(node: IRNode | undefined, ctx: Context): void {
    if (!node || ctx.terminated) return;
    switch (node.kind) {
      case 'block': {
        ctx.env.frames.push(new Map());
        for (const child of node.children) if (child.named && child.kind !== 'comment') this.statement(child, ctx);
        ctx.env.frames.pop(); break;
      }
      case 'const_declaration':
        for (const binding of fields(node, 'binding')) this.bind(field(binding, 'name'), this.expression(field(binding, 'value'), ctx), ctx, true);
        break;
      case 'expression_statement': this.expression(field(node, 'expression'), ctx); break;
      case 'return_statement': ctx.returns.push(this.expression(field(node, 'value'), ctx)); ctx.terminated = true; break;
      case 'if_statement': {
        const condition = this.expression(field(node, 'condition'), ctx);
        if (condition.literal === true || condition.literal === false) { this.statement(field(node, condition.literal ? 'consequence' : 'alternative'), ctx); break; }
        this.event(ctx, 'branch', node, [condition], condition);
        const yes = this.fork(ctx, condition), no = this.fork(ctx, condition, false);
        this.statement(field(node, 'consequence'), yes); this.statement(field(node, 'alternative'), no); this.join(ctx, yes, no, condition); break;
      }
      case 'for_statement': {
        const iterable = this.expression(field(node, 'iterable'), ctx), loop = this.fork(ctx, unknown(this.id('loop')));
        loop.env.frames.push(new Map());
        loop.env.define(identifierName(field(node, 'name')), iterable.members ? merge(Object.values(iterable.members), this.id('item')) : this.typed(iterable.type.element ?? { name: 'Field', bits: 254 }, this.id('item'), iterable.origins));
        this.statement(field(node, 'body'), loop); loop.env.frames.pop();
        this.join(ctx, loop, this.fork(ctx), iterable);
        this.diagnostic(node, 'loop-summary', 'Loop data flow is joined with zero iterations; repeated effects and invariants require review.'); break;
      }
      default: this.diagnostic(node, 'unsupported-statement', `No data-flow model for ${node.kind}.`);
    }
  }
  private bind(pattern: IRNode | undefined, value: Value, ctx: Context, declaration: boolean): void {
    if (!pattern) return;
    if (pattern.kind === 'identifier') {
      const name = identifierName(pattern);
      if (declaration) ctx.env.define(name, value);
      else if (!ctx.env.set(name, value)) {
        const ledger = lookup(this.program.ledger, name, ctx.circuit.module);
        if (!ledger) this.diagnostic(pattern, 'unresolved-binding', `Assignment target ${name} is not a known local or ledger declaration.`);
        this.event(ctx, 'write', pattern, [value], value, name, ledger ? this.ledgerId(ledger) : name); ctx.guards = [];
      }
    } else if (pattern.kind === 'tuple_pattern') {
      let index = 0;
      for (const child of pattern.children) {
        if (child.kind === ',') index++;
        else if (child.named) this.bind(child, this.select(value, String(index)), ctx, declaration);
      }
    } else if (pattern.kind === 'struct_pattern') {
      for (const p of fields(pattern, 'field')) this.bind(field(p, 'pattern') ?? field(p, 'name'), this.select(value, identifierName(field(p, 'name'))), ctx, declaration);
    } else if (pattern.kind === 'member_expression' || pattern.kind === 'index_expression') {
      const objectNode = field(pattern, 'object'), object = this.expression(objectNode, ctx);
      const key = pattern.kind === 'member_expression' ? identifierName(field(pattern, 'property')) : String(this.expression(field(pattern, 'index'), ctx).literal ?? '?');
      const members = { ...object.members, [key]: value };
      this.bind(objectNode, { ...this.aggregate(Object.values(members), object.type.name, this.id('update')), members, type: object.type }, ctx, false);
    } else this.diagnostic(pattern, 'unsupported-binding', `Cannot bind ${pattern.kind}.`);
  }
  private select(object: Value, key: string): Value {
    if (object.members?.[key]) return object.members[key];
    const value = this.typed(object.type.members?.[key] ?? object.type.element ?? UNKNOWN, `${object.id}.${key}`, object.origins, 0, `${object.symbol ?? object.id}.${key}`);
    return { ...value, highEntropy: object.highEntropy && value.highEntropy,
      bits: object.bits === undefined ? value.bits : value.bits === undefined ? object.bits : Math.min(object.bits, value.bits),
      ownKey: object.ownKey, transforms: object.transforms, pathLeaves: object.pathLeaves };
  }
  private published(value: Value): Value {
    return { ...value, disclosed: true, highEntropy: false, bits: 0,
      members: value.members && Object.fromEntries(Object.entries(value.members).map(([key, member]) => [key, this.published(member)])) };
  }
  private visible(value: Value, ctx: Context): Value {
    if ([...ctx.publicIds].some(id => value.id === id || value.id.startsWith(`${id}.`))) return this.published(value);
    if (!value.members) return value;
    const members = Object.fromEntries(Object.entries(value.members).map(([key, member]) => [key, this.visible(member, ctx)]));
    if (Object.entries(members).every(([key, member]) => member === value.members![key])) return value;
    const values = Object.values(members);
    return { ...value, members, highEntropy: values.some(v => v.highEntropy), bits: values.every(v => v.bits !== undefined) ? values.reduce((sum, v) => sum + v.bits!, 0) : undefined };
  }
  private aggregate(values: Value[], name: string, id: string): Value {
    const different = [...new Map(values.map(v => [v.id, v])).values()];
    return { id, symbol: JSON.stringify([name, ...values.map(v => v.symbol ?? v.id)]), highEntropy: values.some(v => v.highEntropy), type: { name, members: Object.fromEntries(values.map((v, i) => [String(i), v.type])) }, members: Object.fromEntries(values.map((v, i) => [String(i), v])),
      origins: origins(values), bits: different.every(v => v.bits !== undefined) ? Math.min(1024, different.reduce((sum, v) => sum + v.bits!, 0)) : undefined,
      domain: false, ownKey: values.some(v => v.ownKey), transforms: unique(values.flatMap(v => v.transforms)), pathLeaves: unique(values.flatMap(v => v.pathLeaves)) };
  }
  private expression(node: IRNode | undefined, ctx: Context): Value {
    if (!node) return this.aggregate([], '[]', 'unit');
    if (++this.budget > 50000) { this.diagnostic(node, 'analysis-budget', 'Expression evaluation budget exceeded; remaining values are unknown.'); return unknown('budget'); }
    const get = (name: string) => this.expression(field(node, name), ctx);
    switch (node.kind) {
      case 'identifier': {
        const name = identifierName(node), local = ctx.env.get(name); if (local) return this.visible(local, ctx);
        const ledger = lookup(this.program.ledger, name, ctx.circuit.module);
        if (ledger) return this.typed(typeOf(field(ledger, 'type'), this.program, ctx.circuit.module), this.ledgerId(ledger), [{ kind: 'ledger', name, span: ledger.span }]);
        const enumeration = lookup(this.program.enums, name, ctx.circuit.module);
        if (enumeration) return { ...unknown(`enum:${name}`), type: { name, bits: 0 }, origins: [{ kind: 'constant', name }], bits: 0 };
        return unknown(name);
      }
      case 'number_literal': case 'boolean_literal': case 'string_literal': {
        const number = Number(node.text);
        const literal = node.kind === 'number_literal' ? (Number.isSafeInteger(number) ? number : undefined) : node.kind === 'boolean_literal' ? node.text === 'true' : node.text.slice(1, -1);
        return { id: `constant:${node.text}`, type: { name: node.kind === 'boolean_literal' ? 'Boolean' : node.kind === 'number_literal' ? 'Field' : 'string' }, bits: 0, literal, origins: [{ kind: 'constant', name: node.text }], domain: node.kind === 'string_literal' && !!String(literal).trim(), ownKey: false, transforms: [], pathLeaves: [] };
      }
      case 'parenthesized_expression': return get('expression');
      case 'sequence_expression': { let value = unknown('empty'); for (const e of fields(node, 'expression')) value = this.expression(e, ctx); return value; }
      case 'tuple_literal': case 'bytes_literal': {
        const elements: Value[] = [];
        for (const e of fields(node, 'element')) { const v = this.expression(e.kind === 'spread_element' ? field(e, 'value') : e, ctx); if (e.kind === 'spread_element' && v.members) elements.push(...Object.values(v.members)); else elements.push(v); }
        return this.aggregate(elements, node.kind === 'bytes_literal' ? `Bytes<${elements.length}>` : 'tuple', `[${elements.map(v => v.id).join(',')}]`);
      }
      case 'struct_literal': {
        const type = typeOf(field(node, 'type'), this.program, ctx.circuit.module), members: Record<string, Value> = {};
        const getValue = (n: IRNode | undefined): Value => this.expression(n, ctx);
        const names = Object.keys(type.members ?? {}); let index = 0;
        for (const n of fields(node, 'field')) {
          if (n.kind === 'spread_element') Object.assign(members, getValue(field(n, 'value'))?.members);
          else if (n.kind === 'field_initializer') members[identifierName(field(n, 'name'))] = getValue(field(n, 'value'));
          else members[n.kind === 'identifier' && names.includes(identifierName(n)) ? identifierName(n) : names[index++] ?? String(index)] = getValue(n);
        }
        return { ...this.aggregate(Object.values(members), type.name, `${type.name}{${Object.values(members).map(v => v.id)}}`), type, members };
      }
      case 'member_expression': {
        const object = get('object'), key = identifierName(field(node, 'property'));
        if (object.id.startsWith('enum:')) return { ...object, id: `${object.id}.${key}`, literal: `${object.type.name}.${key}`, bits: 0 };
        return this.select(object, key);
      }
      case 'index_expression': {
        const object = get('object'), index = get('index');
        if (index.literal !== undefined) return this.select(object, String(index.literal));
        const members = Object.values(object.members ?? {});
        return controlled(members.length ? merge(members, this.id('index')) : this.select(object, `[${index.symbol ?? index.id}]`), index);
      }
      case 'cast_expression': {
        const value = get('value'), type = typeOf(field(node, 'type'), this.program, ctx.circuit.module);
        const retained = (type.bits ?? 0) >= (value.type.bits ?? Infinity);
        return { ...value, type, id: retained ? value.id : `cast:${type.name}(${value.id})`, symbol: retained ? value.symbol : JSON.stringify(['cast', type.name, value.symbol ?? value.id]),
          highEntropy: retained && value.highEntropy, protectedKey: retained ? value.protectedKey : undefined,
          bits: value.bits === undefined ? type.bits : type.bits === undefined ? value.bits : Math.min(type.bits, value.bits) };
      }
      case 'default_expression': { const type = typeOf(field(node, 'type'), this.program, ctx.circuit.module); return { ...this.typed(type, `default:${type.name}`, [{ kind: 'constant', name: 'default' }]), bits: 0 }; }
      case 'pad_expression': { const value = get('value'), size = get('size'); return { ...value, symbol: JSON.stringify(['pad', size.symbol ?? size.id, value.symbol ?? value.id]), type: { name: `Bytes<${size.literal}>` }, domain: value.domain && typeof size.literal === 'number' && size.literal >= Buffer.byteLength(String(value.literal ?? '')) }; }
      case 'disclose_expression': {
        const value = get('value'), result = { ...this.published(value), transforms: unique([...value.transforms, 'disclose']) };
        ctx.publicIds.add(value.id);
        this.event(ctx, 'disclose', node, [value], result); return result;
      }
      case 'assert_expression': {
        const condition = get('condition'); this.event(ctx, 'assert', node, [condition], condition);
        if (condition.predicate) ctx.guards.push(condition.predicate);
        if (condition.literal === false) ctx.terminated = true;
        return this.aggregate([], '[]', 'unit');
      }
      case 'assignment_expression': {
        let value = get('right');
        if (field(node, 'operator')?.text !== '=') value = this.operation(field(node, 'operator')!.text[0], get('left'), value);
        this.bind(field(node, 'left'), value, ctx, false); return value;
      }
      case 'unary_expression': { const value = get('argument'); return { ...value, highEntropy: false, protectedKey: undefined, symbol: `!(${value.symbol ?? value.id})`, id: `!(${value.id})`, type: { name: 'Boolean', bits: 1 }, bits: 1, literal: typeof value.literal === 'boolean' ? !value.literal : undefined, predicate: { kind: 'not', values: [value] } }; }
      case 'binary_expression': {
        const op = field(node, 'operator')!.text, left = get('left');
        if (op !== '&&' && op !== '||') return this.operation(op, left, get('right'));
        if (typeof left.literal === 'boolean') return left.literal === (op === '&&') ? get('right') : left;
        this.event(ctx, 'branch', node, [left], left);
        const evaluated = this.fork(ctx, left, op === '&&'), skipped = this.fork(ctx, left, op !== '&&');
        const right = this.expression(field(node, 'right'), evaluated);
        this.join(ctx, evaluated, skipped, left);
        return this.operation(op, left, right);
      }
      case 'conditional_expression': {
        const condition = get('condition');
        if (typeof condition.literal === 'boolean') return get(condition.literal ? 'consequence' : 'alternative');
        this.event(ctx, 'branch', node, [condition], condition);
        const yes = this.fork(ctx, condition), no = this.fork(ctx, condition, false), a = this.expression(field(node, 'consequence'), yes), b = this.expression(field(node, 'alternative'), no);
        this.join(ctx, yes, no, condition); const value = merge([a, b], this.id('conditional'));
        return controlled(value, condition);
      }
      case 'call_expression': return this.call(node, ctx);
      case 'generic_function': case 'arrow_function': return { ...unknown(`function:${node.span.start}`), callable: node };
      case 'map_expression': case 'fold_expression': return this.higherOrder(node, ctx);
      case 'slice_expression': {
        const value = get('value'), start = get('start'), size = Number(field(node, 'size')?.text);
        if (value.members && typeof start.literal === 'number' && Number.isFinite(size)) return this.aggregate(Object.values(value.members).slice(start.literal, start.literal + size), 'tuple', this.id('slice'));
        const bits = value.type.element?.bits !== undefined && Number.isSafeInteger(size) && size >= 0 ? value.type.element.bits * size : undefined;
        return { ...unknown(this.id('slice'), [value, start]), type: { name: `Vector<${size},${value.type.element?.name ?? 'unknown'}>`, element: value.type.element, length: size },
          symbol: JSON.stringify(['slice', size, start.symbol ?? start.id, value.symbol ?? value.id]),
          bits: bits === undefined ? undefined : Math.min(bits, value.bits ?? bits), highEntropy: value.highEntropy && bits !== undefined && bits >= 128 };
      }
      case 'range_expression': return { ...this.aggregate([get('start'), get('end')], 'range', this.id('range')), type: { name: 'range', element: { name: 'Field', bits: 254 } } };
      case 'emit_expression': { const value = get('value'); this.event(ctx, 'write', node, [value], value, 'emit'); return value; }
      default: this.diagnostic(node, 'unsupported-expression', `No precise data-flow model for ${node.kind}.`); return unknown(node.kind, node.children.filter(n => n.named && n.kind !== 'comment').map(n => this.expression(n, ctx)));
    }
  }
  private operation(op: string, a: Value, b: Value): Value {
    const bool = ['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(op), result = this.aggregate([a, b], bool ? 'Boolean' : a.type.name, `${op}(${a.id},${b.id})`);
    result.members = undefined; result.type = bool ? { name: 'Boolean', bits: 1 } : a.type; result.bits = bool ? 1 : result.bits;
    // Arbitrary arithmetic/comparisons can collapse even a large input domain.
    result.highEntropy = false; result.symbol = JSON.stringify([op, a.symbol ?? a.id, b.symbol ?? b.id]);
    if (op === '==' || op === '!=' || op === '&&' || op === '||') result.predicate = { kind: ({ '==': 'eq', '!=': 'neq', '&&': 'and', '||': 'or' } as const)[op as '=='], values: [a, b] };
    if (a.literal !== undefined && b.literal !== undefined) {
      if (op === '==') result.literal = a.literal === b.literal;
      if (op === '!=') result.literal = a.literal !== b.literal;
      if (typeof a.literal === 'number' && typeof b.literal === 'number') {
        if (op === '+') result.literal = a.literal + b.literal; if (op === '-') result.literal = a.literal - b.literal; if (op === '*') result.literal = a.literal * b.literal;
      }
      if (result.literal !== undefined) result.bits = 0;
    }
    return result;
  }
  private invoke(circuit: CircuitIR, args: Value[], node: IRNode, ctx: Context): Value {
    if (ctx.stack.includes(circuit.qualifiedName)) { this.diagnostic(node, 'recursive-call', `Recursive call to ${circuit.qualifiedName}; result is unknown.`); return unknown(this.id('recursive'), args); }
    if (ctx.stack.length >= (this.options.maxCallDepth ?? 24)) { this.diagnostic(node, 'call-depth', 'Call depth limit reached; result is unknown.'); return unknown(this.id('depth'), args); }
    const child: Context = { ...ctx, circuit, env: new Environment(), stack: [...ctx.stack, circuit.qualifiedName], returns: [], terminated: false, guards: [...ctx.guards] };
    circuit.params.forEach((p, i) => this.bind(field(p, 'name'), args[i] ?? unknown(`missing:${i}`), child, true));
    this.statement(circuit.body, child); ctx.guards = child.guards; ctx.publicIds = child.publicIds;
    return child.returns.length ? merge(child.returns, this.id('return')) : this.aggregate([], '[]', 'unit');
  }
  private call(node: IRNode, ctx: Context): Value {
    const fun = field(node, 'function'), args = fields(field(node, 'args'), 'argument').map(n => this.expression(n, ctx));
    return this.invokeFunction(fun, args, node, ctx);
  }
  private invokeFunction(fun: IRNode | undefined, args: Value[], node: IRNode, ctx: Context): Value {
    if (fun?.kind === 'parenthesized_expression') return this.invokeFunction(field(fun, 'expression'), args, node, ctx);
    if (fun?.kind === 'arrow_function') {
      const child = this.fork(ctx); child.env.frames.push(new Map());
      fields(field(fun, 'params'), 'param').forEach((p, i) => this.bind(field(p, 'name'), args[i] ?? unknown('arg'), child, true));
      const body = field(fun, 'body'); if (body?.kind !== 'block') return this.expression(body, child);
      this.statement(body, child); return child.returns.length ? merge(child.returns, this.id('arrow')) : this.aggregate([], '[]', 'unit');
    }
    const raw = callName(fun);
    if (raw && ctx.env.get(raw)) {
      const local = ctx.env.get(raw)!; if (local.callable) return this.invokeFunction(local.callable, args, node, ctx);
      this.diagnostic(node, 'unresolved-call', `Local binding ${raw} is not a known function.`); return unknown(this.id('call'), [local, ...args]);
    }
    const name = raw ? this.moduleAliases.get(raw) ?? raw : undefined;
    const circuit = name && lookup(this.program.circuits, name, ctx.circuit.module);
    if (circuit) return this.invoke(circuit, args, node, ctx);
    const witness = name && lookup(this.program.witnesses, name, ctx.circuit.module);
    if (witness) return this.typed(typeOf(field(witness, 'return_type'), this.program, ctx.circuit.module), this.id(`witness:${name}`), [{ kind: 'witness', name: name!, span: node.span }], 0, JSON.stringify(['witness', witness.span.file, witness.span.start, ...args.map(v => v.symbol ?? v.id)]));
    if (fun?.kind === 'member_expression') return this.method(fun, args, node, ctx);
    const builtin = raw ? this.standardAliases.get(raw) ?? (this.standardAll && STANDARD.has(raw) ? raw : undefined) : undefined;
    if (!builtin) { this.diagnostic(node, 'unresolved-call', `No implementation or standard-library model for ${raw ?? 'computed callee'}.`); return unknown(this.id('call'), args); }
    if (builtin === 'ownPublicKey') return { ...this.typed({ name: 'ZswapCoinPublicKey', bits: 256 }, this.id('ownPublicKey'), [{ kind: 'witness', name: 'ownPublicKey', span: node.span }]), ownKey: true };
    if (builtin === 'persistentHash' || builtin === 'transientHash' || builtin === 'persistentCommit' || builtin === 'transientCommit') {
      const isCommit = builtin.endsWith('Commit'), input = this.aggregate(args, 'inputs', this.id('input'));
      const result: Value = { ...input, members: undefined, id: `${builtin}(${args.map(v => v.id).join(',')})`, type: { name: builtin.startsWith('persistent') ? 'Bytes<32>' : 'Field', bits: builtin.startsWith('persistent') ? 256 : 254 }, transforms: unique([...input.transforms, isCommit ? 'commit' : 'hash']) };
      result.symbol = JSON.stringify([builtin, ...args.map(v => v.symbol ?? v.id)]);
      result.protectedKey = input.highEntropy ? result.symbol : undefined;
      this.event(ctx, isCommit ? 'commit' : 'hash', node, args, result, builtin); return result;
    }
    if (builtin.startsWith('merkleTreePathRoot')) return { ...unknown(`${builtin}(${args[0]?.id})`, args), type: { name: 'MerkleTreeDigest' }, pathLeaves: args[0] ? [args[0].id] : [] };
    if (builtin === 'some' || builtin === 'left' || builtin === 'right') return { ...this.aggregate(args, builtin, this.id(builtin)), members: { value: args[0] ?? unknown('value') } };
    if (builtin === 'none') return { ...unknown('none'), origins: [{ kind: 'constant', name: 'none' }], bits: 0 };
    const result = unknown(this.id(builtin), args);
    this.diagnostic(node, 'opaque-builtin', `Standard-library ${builtin} is modeled conservatively; semantics require review.`); return result;
  }
  private method(fun: IRNode, args: Value[], node: IRNode, ctx: Context): Value {
    const object = this.expression(field(fun, 'object'), ctx), method = identifierName(field(fun, 'property'));
    const target = object.id, type = object.type.name.replace(/\s/g, '');
    const result = unknown(`${target}.${method}(${args.map(v => v.id)})`, [object, ...args]);
    if (/^(Set|Map)</.test(type) && ['member', 'lookup'].includes(method)) {
      result.type = method === 'member' ? { name: 'Boolean', bits: 1 } : UNKNOWN;
      result.bits = method === 'member' ? 1 : undefined;
      if (method === 'member') result.predicate = { kind: 'member', values: args, target };
      this.event(ctx, 'member', node, args, result, method, target); return result;
    }
    if (/^(Set|Map)</.test(type) && method === 'insert') { this.event(ctx, 'insert', node, args, result, method, target); return result; }
    if (/^(Historic)?MerkleTree</.test(type) && method === 'checkRoot') { this.event(ctx, 'merkle', node, args, result, method, target); result.type = { name: 'Boolean', bits: 1 }; result.bits = 1; return result; }
    if (object.origins.some(o => o.kind === 'ledger')) { this.event(ctx, 'write', node, args, result, method, target); ctx.guards = []; this.diagnostic(node, 'ledger-operation', `Ledger operation ${method} is modeled as an opaque effect.`); return result; }
    this.diagnostic(node, 'unresolved-call', `Unknown method ${method} on ${type}.`); return result;
  }
  private higherOrder(node: IRNode, ctx: Context): Value {
    const arrays = fields(node, 'argument').map(n => this.expression(n, ctx));
    const length = arrays[0]?.members ? Object.keys(arrays[0].members).length : undefined;
    if (length === undefined || length > 128 || arrays.some(v => !v.members || Object.keys(v.members).length !== length)) { this.diagnostic(node, 'higher-order-summary', `${node.kind} has unknown/large vector dimensions; callback effects are not fully analyzed.`); return unknown(this.id('higher-order'), arrays); }
    let accumulator = this.expression(field(node, 'initial'), ctx); const values: Value[] = [];
    for (let i = 0; i < length; i++) { const args = arrays.map(v => v.members![String(i)]); const result = this.invokeFunction(field(node, 'function'), node.kind === 'fold_expression' ? [accumulator, ...args] : args, node, ctx); values.push(result); accumulator = result; }
    return node.kind === 'fold_expression' ? accumulator : this.aggregate(values, 'tuple', this.id('map'));
  }
}
export function predicateKey(p: Predicate): string { return `${p.kind}:${p.target ?? ''}:${p.values.map(v => v.id).join('|')}`; }
