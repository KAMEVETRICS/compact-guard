import { Parser, Language, type Node } from 'web-tree-sitter';
import { fileURLToPath } from 'node:url';
import { field, fields, identifierName, type IRNode, type ProgramIR } from './ir.js';
let language: Promise<Language> | undefined;
async function loadLanguage(): Promise<Language> {
  await Parser.init();
  return Language.load(fileURLToPath(new URL('../../../grammar/tree-sitter-compact.wasm', import.meta.url)));
}
export async function parseSource(source: string, file = '<memory>'): Promise<ProgramIR> {
  const lang = await (language ??= loadLanguage());
  const parser = new Parser(); parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) { parser.delete(); throw new Error('Parser returned no syntax tree'); }
  const diagnostics: ProgramIR['diagnostics'] = [];
  function clone(node: Node): IRNode {
    const span = { file, line: node.startPosition.row + 1, column: node.startPosition.column + 1, start: node.startIndex, end: node.endIndex };
    if (node.isError || node.isMissing) diagnostics.push({ ...span, severity: 'error', code: node.isMissing ? 'syntax-missing' : 'syntax-error', message: node.isMissing ? `Missing ${node.type}` : 'Unrecognized Compact syntax' });
    const result: IRNode = { kind: node.type, text: node.text, span, named: node.isNamed, fields: {}, children: [] };
    node.children.forEach((child, index) => {
      if (!child) return;
      const owned = clone(child); result.children.push(owned);
      const name = node.fieldNameForChild(index);
      if (name) (result.fields[name] ??= []).push(owned);
    });
    return result;
  }
  let root: IRNode;
  try { root = clone(tree.rootNode); } finally { tree.delete(); parser.delete(); }
  const program: ProgramIR = { file, source, root, diagnostics, circuits: new Map(), witnesses: new Map(), ledger: new Map(), structs: new Map(), enums: new Map(), typeAliases: new Map(), imports: [] };
  function collect(body: IRNode, module?: string): void {
    const qualify = (name: string) => module ? `${module}.${name}` : name;
    const exports = new Set(body.children.filter(n => n.kind === 'export_declaration').flatMap(n => fields(n, 'name').map(identifierName)));
    for (const node of body.children) {
      const name = identifierName(field(node, 'name')), key = qualify(name);
      if (node.kind === 'module_declaration') { collect(field(node, 'body')!, key); continue; }
      if (node.kind === 'import_declaration' || node.kind === 'include_declaration') { program.imports.push(node); continue; }
      if (node.kind === 'circuit_declaration' || node.kind === 'constructor_declaration') {
        const circuitName = node.kind === 'constructor_declaration' ? '<constructor>' : name;
        program.circuits.set(qualify(circuitName), { name: circuitName, qualifiedName: qualify(circuitName), node, params: fields(field(node, 'params'), 'param'), returnType: field(node, 'return_type'), body: field(node, 'body')!, exported: !!field(node, 'export') || exports.has(name), pure: !!field(node, 'pure'), module });
      } else {
        const map = ({ witness_declaration: program.witnesses, ledger_declaration: program.ledger, struct_declaration: program.structs, enum_declaration: program.enums, type_alias_declaration: program.typeAliases } as Record<string, Map<string, IRNode>>)[node.kind];
        if (map) map.set(key, node);
      }
    }
  }
  collect(root); return program;
}
