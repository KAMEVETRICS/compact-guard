import { stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { analyzeDirectory, analyzeFile, type AnalysisResult, type AnalyzerOptions } from '@compact-guard/analyzer';
import { UsageError } from './args.js';

export interface ScannedFile { file: string; result: AnalysisResult }

export const RANK = { review: 0, warning: 1, error: 2 } as const;

export async function scan(paths: string[], cwd: string, options: AnalyzerOptions): Promise<ScannedFile[]> {
  const byFile = new Map<string, ScannedFile>();
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    let info;
    try { info = await stat(absolute); } catch { throw new UsageError(`cannot read ${path}`); }
    if (info.isDirectory()) {
      const result = await analyzeDirectory(absolute, options);
      for (const entry of result.files) byFile.set(entry.file, entry);
    } else if (info.isFile() && absolute.endsWith('.compact')) {
      byFile.set(absolute, { file: absolute, result: await analyzeFile(absolute, options) });
    } else {
      throw new UsageError(`${path} is not a .compact file or a directory`);
    }
  }
  if (!byFile.size) throw new UsageError(`no .compact files found in ${paths.join(', ')}`);
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

// Report paths are relative to the working directory, with forward slashes on every OS.
export function displayPath(file: string, cwd: string): string {
  const rel = relative(cwd, file);
  return (rel || file).split(sep).join('/');
}
