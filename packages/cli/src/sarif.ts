import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RULES, type Finding } from '@compact-guard/analyzer';
import type { ScannedFile } from './scan.js';

type Level = 'error' | 'warning' | 'note';
const LEVEL: Record<Finding['severity'], Level> = { error: 'error', warning: 'warning', review: 'note' };

// Files under the scan root are relative to SRCROOT so results stay stable across
// checkouts; anything outside it gets an absolute file URI.
function artifactLocation(file: string, root: string) {
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { uri: pathToFileURL(file).href };
  return { uri: rel.split(sep).map(encodeURIComponent).join('/'), uriBaseId: 'SRCROOT' };
}

function region(line: number, column: number) {
  return { startLine: Math.max(1, line), startColumn: Math.max(1, column) };
}

function fingerprint(f: Finding, root: string): string {
  const path = relative(root, f.file).split(sep).join('/');
  return createHash('sha256').update([f.rule, path, f.circuit ?? '', f.message].join('\0')).digest('hex').slice(0, 32);
}

export function renderSarif(files: ScannedFile[], root: string, tool: { version: string; informationUri?: string }): string {
  const ruleIndex = new Map(RULES.map((r, i) => [r.id as string, i]));
  const rootUri = pathToFileURL(root).href;
  const results = files.flatMap(({ result }) => result.findings.map(f => ({
    ruleId: f.rule,
    ...(ruleIndex.has(f.rule) ? { ruleIndex: ruleIndex.get(f.rule) } : {}),
    level: LEVEL[f.severity],
    message: { text: f.evidence?.detail ? `${f.message} Evidence: ${f.evidence.detail}` : f.message },
    locations: [{ physicalLocation: { artifactLocation: artifactLocation(f.file, root), region: region(f.line, f.column) } }],
    partialFingerprints: { 'compactGuardFindingHash/v1': fingerprint(f, root) },
    properties: {
      severity: f.severity,
      ...(f.circuit ? { circuit: f.circuit } : {}),
      ...(f.evidence ? { evidenceKind: f.evidence.kind } : {}),
      ...(f.evidence?.repro ? { repro: f.evidence.repro } : {}),
    },
  })));
  const notifications = files.flatMap(({ result }) => result.diagnostics.map(d => ({
    level: d.severity,
    message: { text: d.message },
    descriptor: { id: d.code },
    locations: [{ physicalLocation: { artifactLocation: artifactLocation(d.file, root), region: region(d.line, d.column) } }],
  })));

  const log = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'compact-guard',
          version: tool.version,
          ...(tool.informationUri ? { informationUri: tool.informationUri } : {}),
          rules: RULES.map(r => ({
            id: r.id,
            name: r.title,
            shortDescription: { text: r.title },
            fullDescription: { text: r.description },
            helpUri: r.docUrl,
            help: { text: `${r.description} See ${r.docUrl}` },
            defaultConfiguration: { level: LEVEL[r.defaultSeverity] },
          })),
        },
      },
      originalUriBaseIds: { SRCROOT: { uri: rootUri.endsWith('/') ? rootUri : `${rootUri}/` } },
      columnKind: 'utf16CodeUnits',
      results,
      invocations: [{ executionSuccessful: true, toolExecutionNotifications: notifications }],
    }],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}
