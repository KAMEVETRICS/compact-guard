import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv-draft-04';
import { main } from '../dist/run.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = new URL('./fixtures/', import.meta.url);
const OFFICIAL = 'packages/analyzer/test/fixtures/official';

async function cli(...argv) {
  let stdout = '', stderr = '';
  const code = await main(argv, { cwd: ROOT, stdout: t => { stdout += t; }, stderr: t => { stderr += t; } });
  return { code, stdout, stderr };
}

const schema = JSON.parse(await readFile(new URL('sarif-schema-2.1.0.json', FIXTURES), 'utf8'));
// The official schema is draft-04. Formats are not validated here; URIs are checked explicitly below.
const validateSarif = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);

test('text output for CG001 matches the golden file', async () => {
  const { code, stdout } = await cli('corpus/CG001');
  assert.equal(code, 0);
  assert.equal(stdout.replace(/\r\n/g, '\n'), (await readFile(new URL('cg001.txt', FIXTURES), 'utf8')).replace(/\r\n/g, '\n'));
});

test('exit codes follow --fail-on', async () => {
  assert.equal((await cli('corpus/CG001/fixed.compact', '--fail-on', 'review')).code, 0);
  assert.equal((await cli('corpus/CG001/vulnerable.compact', '--fail-on', 'warning')).code, 1);
  assert.equal((await cli('corpus/CG001/vulnerable.compact')).code, 0, 'default --fail-on error ignores warnings');
  assert.equal((await cli('corpus', '--fail-on', 'review')).code, 1);
  assert.equal((await cli('corpus', '--fail-on', 'none')).code, 0);
});

test('usage errors exit 2 without a report', async () => {
  for (const argv of [['--bogus'], ['--format', 'xml'], ['--fail-on', 'high'], ['--rules', 'CG999'], ['does-not-exist'], ['package.json']]) {
    const { code, stdout, stderr } = await cli(...argv);
    assert.equal(code, 2, argv.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, /^compact-guard: /);
  }
  const empty = await mkdtemp(join(tmpdir(), 'cg-empty-'));
  try {
    const { code, stderr } = await cli(empty);
    assert.equal(code, 2);
    assert.match(stderr, /no \.compact files found/);
  } finally { await rm(empty, { recursive: true, force: true }); }
});

test('diagnostics alone never fail the run', async () => {
  const { code, stdout } = await cli(OFFICIAL, '--fail-on', 'warning', '--format', 'json');
  assert.equal(code, 0, 'official examples have review findings only');
  const report = JSON.parse(stdout);
  assert.ok(report.summary.diagnostics > 0);
  assert.equal(report.summary.error + report.summary.warning, 0);
});

test('--rules restricts findings', async () => {
  const report = JSON.parse((await cli('corpus/CG002', '--rules', 'cg006', '--format', 'json')).stdout);
  const rules = report.files.flatMap(f => f.findings.map(x => x.rule));
  assert.deepEqual([...new Set(rules)], ['CG006']);
});

test('JSON report uses relative paths and consistent counts', async () => {
  const report = JSON.parse((await cli('corpus', '--format', 'json')).stdout);
  assert.equal(report.summary.files, 16);
  assert.equal(report.files.length, 16);
  for (const file of report.files) {
    assert.match(file.file, /^corpus\/CG00\d\/(fixed|vulnerable)\.compact$/);
    for (const f of file.findings) assert.equal(f.file, file.file);
  }
  const counted = report.files.flatMap(f => f.findings).length;
  assert.equal(counted, report.summary.error + report.summary.warning + report.summary.review);
});

test('SARIF output validates against the SARIF 2.1.0 schema', async () => {
  for (const target of ['corpus', OFFICIAL]) {
    const log = JSON.parse((await cli(target, '--format', 'sarif')).stdout);
    const ok = validateSarif(log);
    assert.ok(ok, `${target}: ${JSON.stringify(validateSarif.errors?.slice(0, 5), null, 2)}`);
  }
});

test('SARIF maps severities, rules, locations and diagnostics', async () => {
  const json = JSON.parse((await cli('corpus', '--format', 'json')).stdout);
  const run = JSON.parse((await cli('corpus', '--format', 'sarif')).stdout).runs[0];

  assert.equal(run.tool.driver.name, 'compact-guard');
  assert.deepEqual(run.tool.driver.rules.map(r => r.id), ['CG001', 'CG002', 'CG003', 'CG004', 'CG005', 'CG006', 'CG007', 'CG008']);
  for (const rule of run.tool.driver.rules) assert.match(rule.helpUri, /^https:\/\/docs\.midnight\.network\/.+#.+/);

  const findings = json.files.flatMap(f => f.findings);
  assert.equal(run.results.length, findings.length, 'every finding becomes exactly one result');
  assert.equal(run.invocations[0].toolExecutionNotifications.length, json.summary.diagnostics, 'diagnostics go to notifications only');

  const levels = { error: 'error', warning: 'warning', review: 'note' };
  for (const [i, result] of run.results.entries()) {
    const f = findings[i];
    assert.equal(result.ruleId, f.rule);
    assert.equal(run.tool.driver.rules[result.ruleIndex].id, f.rule);
    assert.equal(result.level, levels[f.severity]);
    const { artifactLocation, region } = result.locations[0].physicalLocation;
    assert.equal(artifactLocation.uriBaseId, 'SRCROOT');
    assert.equal(artifactLocation.uri, f.file);
    assert.deepEqual(region, { startLine: f.line, startColumn: f.column });
    assert.match(result.partialFingerprints['compactGuardFindingHash/v1'], /^[0-9a-f]{32}$/);
  }
  assert.ok(run.results.some(r => r.level === 'note'), 'review findings appear as notes');

  const root = new URL(run.originalUriBaseIds.SRCROOT.uri);
  assert.equal(root.protocol, 'file:');
  assert.ok(root.href.endsWith('/'));
  assert.equal(run.columnKind, 'utf16CodeUnits');
});

test('SARIF fingerprints are stable across runs', async () => {
  const prints = async () => JSON.parse((await cli('corpus', '--format', 'sarif')).stdout).runs[0].results.map(r => r.partialFingerprints['compactGuardFindingHash/v1']);
  const first = await prints();
  assert.deepEqual(await prints(), first);
  assert.equal(new Set(first).size, first.length, 'distinct findings get distinct fingerprints');
});

test('--output writes the report to a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-out-'));
  try {
    const out = join(dir, 'report.sarif');
    const { code, stdout } = await cli('corpus/CG006', '--format', 'sarif', '--output', out);
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.ok(validateSarif(JSON.parse(await readFile(out, 'utf8'))));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--version and --help', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(await cli('--version'), { code: 0, stdout: `${pkg.version}\n`, stderr: '' });
  const help = await cli('--help');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--fail-on <level>/);
});

test('every finding links its own rule documentation', async () => {
  const report = JSON.parse((await cli('corpus', '--format', 'json')).stdout);
  const urls = new Map();
  for (const f of report.files.flatMap(x => x.findings)) {
    assert.match(f.docUrl, /^https:\/\/docs\.midnight\.network\/.+#.+/);
    urls.set(f.rule, f.docUrl);
  }
  assert.notEqual(urls.get('CG001'), urls.get('CG006'));
});
