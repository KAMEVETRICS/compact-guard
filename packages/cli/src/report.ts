import type { Finding } from '@compact-guard/analyzer';
import { displayPath, type ScannedFile } from './scan.js';

export interface Summary { error: number; warning: number; review: number; diagnostics: number; files: number }

export function summarize(files: ScannedFile[]): Summary {
  const summary: Summary = { error: 0, warning: 0, review: 0, diagnostics: 0, files: files.length };
  for (const { result } of files) {
    for (const finding of result.findings) summary[finding.severity]++;
    summary.diagnostics += result.diagnostics.length;
  }
  return summary;
}

export function renderText(files: ScannedFile[], cwd: string, opts: { quiet: boolean; verbose: boolean }): string {
  const lines: string[] = [];
  for (const { result } of files) {
    for (const f of result.findings) {
      lines.push(`${displayPath(f.file, cwd)}:${f.line}:${f.column}  ${f.severity}  ${f.rule}  ${f.message}${f.circuit ? `  [${f.circuit}]` : ''}`);
    }
  }
  if (opts.verbose) {
    for (const { result } of files) {
      for (const d of result.diagnostics) {
        lines.push(`${displayPath(d.file, cwd)}:${d.line}:${d.column}  diagnostic(${d.severity})  ${d.code}  ${d.message}`);
      }
    }
  }
  if (!opts.quiet) {
    const s = summarize(files);
    const total = s.error + s.warning + s.review;
    const fileWord = s.files === 1 ? 'file' : 'files';
    lines.push(total
      ? `${total} finding${total === 1 ? '' : 's'} (${s.error} error, ${s.warning} warning, ${s.review} review) in ${s.files} ${fileWord}; ${s.diagnostics} diagnostic${s.diagnostics === 1 ? '' : 's'}`
      : `No findings in ${s.files} ${fileWord}; ${s.diagnostics} diagnostic${s.diagnostics === 1 ? '' : 's'}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function renderJson(files: ScannedFile[], cwd: string, version: string): string {
  const relativeFinding = (f: Finding) => ({ ...f, file: displayPath(f.file, cwd) });
  const report = {
    version,
    files: files.map(({ file, result }) => ({
      file: displayPath(file, cwd),
      findings: result.findings.map(relativeFinding),
      diagnostics: result.diagnostics.map(d => ({ ...d, file: displayPath(d.file, cwd) })),
    })),
    summary: summarize(files),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
