#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';

// Use the module's location, never the caller's current working directory.
const wasmPath = fileURLToPath(new URL('../tree-sitter-compact.wasm', import.meta.url));

async function* compactFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* compactFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.compact')) yield path;
    // Do not follow symlinks: they may cycle or escape the requested directory.
  }
}

function diagnostics(root) {
  const result = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (node.isError || node.isMissing) {
      result.push({ kind: node.isMissing ? 'MISSING' : 'ERROR',
        type: node.type, ...node.startPosition });
    }
    // children, not namedChildren: missing punctuation is often anonymous.
    for (let i = node.childCount - 1; i >= 0; i--) pending.push(node.child(i));
  }
  return result;
}

async function main() {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/parse-all.mjs <dir>');
    return 2;
  }
  const dir = resolve(process.argv[2]);
  if (!(await stat(dir)).isDirectory()) throw new Error(`Not a directory: ${dir}`);
  await Parser.init();
  const parser = new Parser();
  let files = 0, errors = 0, missing = 0, failedFiles = 0;
  try {
    parser.setLanguage(await Language.load(wasmPath));
    for await (const path of compactFiles(dir)) {
      const source = await readFile(path, 'utf8');
      const tree = parser.parse(source);
      if (!tree) throw new Error(`Parser did not return a tree for ${path}`);
      try {
        files++;
        const issues = diagnostics(tree.rootNode);
        if (issues.length) failedFiles++;
        for (const issue of issues) {
          if (issue.kind === 'ERROR') errors++; else missing++;
          const detail = issue.kind === 'MISSING' ? ` ${issue.type}` : '';
          console.log(`${path}:${issue.row + 1}:${issue.column + 1}: ${issue.kind}${detail}`);
        }
      } finally { tree.delete(); }
    }
  } finally { parser.delete(); }
  console.log(`${dir}: ${files} files, ${errors} ERROR, ${missing} MISSING, ${failedFiles} files with errors`);
  if (!files) {
    console.error('No .compact files found. This is not a successful validation run.');
    return 2;
  }
  return failedFiles ? 1 : 0;
}

try { process.exitCode = await main(); }
catch (error) { console.error(`parse-all: ${error.message}`); process.exitCode = 2; }
