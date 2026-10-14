import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseSource } from './parser.js';
import { Evaluator } from './engine.js';
import { runRules } from './rules.js';
import type { AnalysisResult, AnalyzerOptions, Finding } from './model.js';
export { parseSource } from './parser.js';
export { RULES, RULE_BY_ID, type RuleInfo } from './catalog.js';
export type { AnalysisResult, AnalyzerOptions, Finding, RuleId, CircuitSummary, ValueSummary } from './model.js';
export type { ProgramIR, CircuitIR, IRNode, Span, Diagnostic } from './ir.js';

export async function analyzeSource(source: string, file = '<memory>', options: AnalyzerOptions = {}): Promise<AnalysisResult> {
  const program = await parseSource(source, file);
  const result: AnalysisResult = { findings: [], diagnostics: [...program.diagnostics], circuits: [], callGraph: {} };
  if (result.diagnostics.some(d => d.severity === 'error')) return result;
  const evaluator = new Evaluator(program, options);
  result.callGraph = evaluator.callGraph;
  const declared = [...program.circuits.values()];
  // Evaluate helpers at actual call sites to preserve caller facts.
  const topLevel = declared.filter(c => !c.module);
  const roots = topLevel.some(c => c.exported) ? topLevel.filter(c => c.exported || c.name === '<constructor>') : topLevel.length ? topLevel : declared;
  const evaluations = roots.map(circuit => ({ circuit, evaluation: evaluator.evaluate(circuit) }));
  const users = new Map<string, Set<string>>();
  for (const { circuit, evaluation } of evaluations) if (circuit.exported) {
    for (const event of evaluation.events) if (event.kind === 'member' && event.args[0]?.protectedKey) {
      const key = event.args[0].protectedKey;
      const entries = users.get(key) ?? new Set<string>(); entries.add(circuit.qualifiedName); users.set(key, entries);
    }
  }
  const keyUsers = new Map([...users].map(([key, names]) => [key, [...names].sort()]));
  for (const { circuit, evaluation } of evaluations) {
    result.circuits.push(evaluation.summary);
    result.findings.push(...runRules(program, circuit, evaluation, options, keyUsers));
  }
  result.findings = deduplicate(result.findings);
  result.diagnostics.push(...evaluator.diagnostics);
  result.findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return result;
}
function deduplicate(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  const rank = { review: 0, warning: 1, error: 2 };
  for (const finding of findings) {
    const key = JSON.stringify([finding.rule, finding.file, finding.line, finding.column]);
    const group = groups.get(key) ?? []; group.push(finding); groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const strongest = group.reduce((a, b) => rank[b.severity] > rank[a.severity] ? b : a);
    const entries = [...new Set(group.map(f => f.circuit).filter((s): s is string => !!s))].sort();
    const details = [...new Set(group.map(f => f.evidence?.detail).filter(Boolean))];
    return { ...strongest, evidence: { kind: 'static', detail: `Entry circuits: ${entries.join(', ')}. ${details.join(' | ')}` } } as Finding;
  });
}
export async function analyzeFile(file: string, options: AnalyzerOptions = {}): Promise<AnalysisResult> {
  const absolute = resolve(file); return analyzeSource(await readFile(absolute, 'utf8'), absolute, options);
}
export interface DirectoryResult extends AnalysisResult { files: Array<{file: string; result: AnalysisResult}> }
export async function analyzeDirectory(directory: string, options: AnalyzerOptions = {}): Promise<DirectoryResult> {
  const result: DirectoryResult = { files: [], findings: [], diagnostics: [], circuits: [], callGraph: {} };
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || ['.git', 'node_modules', 'managed', 'dist'].includes(entry.name)) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.compact')) {
        const analysis = await analyzeFile(file, options); result.files.push({ file, result: analysis });
        result.findings.push(...analysis.findings); result.diagnostics.push(...analysis.diagnostics); result.circuits.push(...analysis.circuits);
        for (const [name, calls] of Object.entries(analysis.callGraph)) result.callGraph[`${file}::${name}`] = calls;
      }
    }
  }
  await visit(resolve(directory)); return result;
}
