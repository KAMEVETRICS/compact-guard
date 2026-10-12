export interface Span { file: string; line: number; column: number; start: number; end: number }
export interface IRNode { kind: string; text: string; span: Span; named: boolean; fields: Record<string, IRNode[]>; children: IRNode[] }
export interface Diagnostic { code: string; severity: 'error' | 'warning'; message: string; file: string; line: number; column: number }
export interface CircuitIR { name: string; qualifiedName: string; node: IRNode; params: IRNode[]; returnType?: IRNode; body: IRNode; exported: boolean; pure: boolean; module?: string }
export interface ProgramIR {
  file: string; source: string; root: IRNode; circuits: Map<string, CircuitIR>;
  witnesses: Map<string, IRNode>; ledger: Map<string, IRNode>; structs: Map<string, IRNode>;
  enums: Map<string, IRNode>; typeAliases: Map<string, IRNode>; imports: IRNode[]; diagnostics: Diagnostic[];
}
export const field = (node: IRNode | undefined, name: string): IRNode | undefined => node?.fields[name]?.[0];
export const fields = (node: IRNode | undefined, name: string): IRNode[] => node?.fields[name] ?? [];
export function* walk(node: IRNode): Iterable<IRNode> { const pending = [node]; while (pending.length) { const n = pending.pop()!; yield n; pending.push(...n.children.slice().reverse()); } }
export function identifierName(node: IRNode | string | undefined): string {
  const text = typeof node === 'string' ? node : node?.text ?? '';
  return text.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (all, a, b) => {
    const code = parseInt(a ?? b, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}
export function callName(node: IRNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === 'identifier') return identifierName(node);
  if (node.kind === 'call_expression') return callName(field(node, 'function'));
  if (node.kind === 'generic_function') return callName(field(node, 'name'));
  if (node.kind === 'parenthesized_expression') return callName(field(node, 'expression'));
  if (node.kind === 'member_expression') { const object = callName(field(node, 'object')); return object ? `${object}.${identifierName(field(node, 'property'))}` : undefined; }
  return undefined;
}
