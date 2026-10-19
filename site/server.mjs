// The compact-guard registry site: serves the web UI (contracts/registry/ui/dist)
// and a read-only API over the registry contract on Midnight Preprod.
//
//   GET  /api/registry  every attestation in the registry, labelled where known
//   POST /api/scan      body = Compact source; returns findings and the
//                       on-chain attestation for that exact source, if any
//   GET  /healthz       liveness check for the host
//
// Config: BLOCKFROST_PROJECT_ID (a Midnight Preprod project ID) from the
// environment, or, when running locally, from contracts/registry/deploy/.env.preprod.
// PORT defaults to 5180; HOST to 127.0.0.1 locally and 0.0.0.0 when PORT is set by a host.
// The token never leaves this process.
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

// Midnight's clients can log endpoint URLs, which carry the Blockfrost project ID.
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[method].bind(console);
  console[method] = (...args) => original(...args.map((a) => (typeof a === 'string' ? a.replace(/project_id=[^&"\s]+/g, 'project_id=REDACTED') : a)));
}

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ledger } from './contract/index.js';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const REGISTRY = join(ROOT, 'contracts', 'registry');
const DEPLOYMENTS = join(REGISTRY, 'deployments');
const UI_DIST = join(REGISTRY, 'ui', 'dist');
const LOCAL_ENV = join(REGISTRY, 'deploy', '.env.preprod');

const PORT = Number(process.env.PORT ?? 5180);
const HOST = process.env.HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const MAX_SOURCE = 256 * 1024;
const CACHE_MS = 15_000;
// Scans run the analyzer on untrusted input, so each client gets a small budget.
const SCAN_LIMIT = 20;
const SCAN_WINDOW_MS = 60_000;

if (!process.env.BLOCKFROST_PROJECT_ID && existsSync(LOCAL_ENV)) process.loadEnvFile(LOCAL_ENV);
const projectId = process.env.BLOCKFROST_PROJECT_ID?.trim();
if (!projectId?.startsWith('nightpreprod')) {
  console.error('BLOCKFROST_PROJECT_ID must be set to a Blockfrost "Midnight Preprod" project ID (it starts with "nightpreprod").');
  process.exit(1);
}
const mask = (text) => String(text).replace(/project_id=[^&"\s]+/g, 'project_id=REDACTED');

setNetworkId('preprod');
const id = encodeURIComponent(projectId);
const provider = indexerPublicDataProvider(
  `https://midnight-preprod.blockfrost.io/api/v0?project_id=${id}`,
  `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${id}`,
);
const deployment = JSON.parse(readFileSync(join(DEPLOYMENTS, 'preprod.json'), 'utf8'));
const { analyzeSource, RULE_BY_ID } = await import(pathToFileURL(join(ROOT, 'packages', 'analyzer', 'dist', 'index.js')).href);

const toHex = (bytes) => Buffer.from(bytes).toString('hex');

function knownAttestations() {
  try { return JSON.parse(readFileSync(join(DEPLOYMENTS, 'preprod-attestations.json'), 'utf8')); }
  catch { return { attestations: [] }; }
}

async function readRegistry() {
  const state = await provider.queryContractState(deployment.contractAddress);
  if (!state) throw new Error('Registry contract state not found on the indexer.');
  const l = ledger(state.data);
  const known = knownAttestations();
  const labels = new Map(known.attestations.map((a) => [a.contractHash, a]));
  const revealed = new Map([...l.revealedReports].map(([k, v]) => [toHex(k), toHex(v)]));
  const attestations = [...l.attestations].map(([key, a]) => {
    const contractHash = toHex(key);
    const meta = labels.get(contractHash);
    return {
      contractHash,
      label: meta?.label ?? null,
      path: meta?.path ?? null,
      errors: Number(a.errors), warnings: Number(a.warnings), reviews: Number(a.reviews),
      clean: a.errors === 0n && a.warnings === 0n,
      attester: toHex(a.attester),
      toolVersion: toHex(a.toolVersion),
      tool: toHex(a.toolVersion) === known.toolVersionHash ? known.tool : null,
      reportCommitment: toHex(a.reportCommitment),
      revealedReport: revealed.get(contractHash) ?? null,
      revealedSarif: known.revealed?.contractHash === contractHash ? known.revealed.sarif : null,
      txId: meta?.txId ?? null, blockHeight: meta?.blockHeight ?? null,
    };
  });
  return {
    network: deployment.network,
    contractAddress: deployment.contractAddress,
    deployTx: deployment.txId,
    deployBlock: deployment.blockHeight,
    attesterCount: Number(l.attesters.size()),
    totalAttestations: Number(l.totalAttestations),
    attestations,
    readAt: new Date().toISOString(),
  };
}

// At most one indexer read per CACHE_MS, however many visitors arrive at once.
let cache;
let inFlight;
async function registryState() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  inFlight ??= readRegistry().then((value) => { cache = { at: Date.now(), value }; return value; }).finally(() => { inFlight = undefined; });
  return inFlight;
}

async function scan(source) {
  const contractHash = toHex(createHash('sha256').update(source).digest());
  const result = await analyzeSource(source.toString('utf8'), 'submitted.compact');
  const findings = result.findings.map((f) => ({
    rule: f.rule, title: RULE_BY_ID.get(f.rule)?.title ?? f.rule, severity: f.severity,
    line: f.line, column: f.column, circuit: f.circuit ?? null, message: f.message, docUrl: f.docUrl,
  }));
  const syntaxErrors = result.diagnostics.filter((d) => d.severity === 'error').map((d) => ({ line: d.line, column: d.column, message: d.message }));
  const registry = await registryState();
  return { contractHash, findings, syntaxErrors, attestation: registry.attestations.find((a) => a.contractHash === contractHash) ?? null };
}

const scanBudget = new Map();
function allowScan(client) {
  const now = Date.now();
  const entry = scanBudget.get(client);
  if (!entry || now - entry.start >= SCAN_WINDOW_MS) { scanBudget.set(client, { start: now, count: 1 }); return true; }
  entry.count++;
  return entry.count <= SCAN_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [client, entry] of scanBudget) if (now - entry.start >= SCAN_WINDOW_MS) scanBudget.delete(client);
}, SCAN_WINDOW_MS).unref();

// Behind a host's proxy the client is the first X-Forwarded-For address.
const clientOf = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.sarif': 'application/json', '.png': 'image/png' };
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
/** Serves a file under `dir`, refusing paths that escape it. */
function serveFile(res, dir, relative) {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(dir + sep) || !existsSync(file)) return false;
  send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
  return true;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/registry') return send(res, 200, await registryState());
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      if (!allowScan(clientOf(req))) return send(res, 429, { error: `Too many scans; try again in a minute (limit ${SCAN_LIMIT} per minute).` });
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_SOURCE) return send(res, 413, { error: 'Source too large (256 KB limit).' });
        chunks.push(chunk);
      }
      return send(res, 200, await scan(Buffer.concat(chunks)));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/deployments/')) {
      if (serveFile(res, DEPLOYMENTS, url.pathname.slice('/deployments/'.length))) return;
      return send(res, 404, { error: 'Not found.' });
    }
    if (req.method === 'GET' && existsSync(UI_DIST)) {
      if (url.pathname !== '/' && serveFile(res, UI_DIST, url.pathname.slice(1))) return;
      return send(res, 200, readFileSync(join(UI_DIST, 'index.html')), TYPES['.html']);
    }
    send(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(mask(error?.stack ?? error));
    send(res, 502, { error: mask(error.message) });
  }
}).listen(PORT, HOST, () => console.log(`compact-guard registry site on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
