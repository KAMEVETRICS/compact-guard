// Local API for the registry UI. Reads the deployed registry from the Preprod
// indexer and runs compact-guard on submitted contracts. The Blockfrost token
// stays in this process; the server listens on 127.0.0.1 only.
//
//   GET  /api/registry  registry state: every attestation, labelled where known
//   POST /api/scan      body = Compact source; returns findings and the
//                       on-chain attestation for that source's hash, if any
//
// It also serves the built UI (../ui/dist) at /.
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { toHex } from '../src/witnesses.ts';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..', '..', '..');
const UI_DIST = join(HERE, '..', 'ui', 'dist');
const PORT = Number(process.env.PORT ?? 5180);
const MAX_SOURCE = 256 * 1024;
const CACHE_MS = 15_000;

process.loadEnvFile(join(HERE, '.env.preprod'));
setNetworkId('preprod');
const id = encodeURIComponent(process.env.BLOCKFROST_PROJECT_ID.trim());
const provider = indexerPublicDataProvider(
  `https://midnight-preprod.blockfrost.io/api/v0?project_id=${id}`,
  `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${id}`,
);
const deployment = JSON.parse(readFileSync(join(HERE, '..', 'deployments', 'preprod.json'), 'utf8'));
const contractModule = await import(pathToFileURL(join(HERE, 'managed', 'registry', 'contract', 'index.js')).href);
const { analyzeSource, RULE_BY_ID } = await import(pathToFileURL(join(ROOT, 'packages', 'analyzer', 'dist', 'index.js')).href);

function knownAttestations() {
  try { return JSON.parse(readFileSync(join(HERE, '..', 'deployments', 'preprod-attestations.json'), 'utf8')); }
  catch { return { attestations: [] }; }
}

let cache;
async function registryState() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const state = await provider.queryContractState(deployment.contractAddress);
  if (!state) throw new Error('Registry contract state not found on the indexer.');
  const l = contractModule.ledger(state.data);
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
  const value = {
    network: deployment.network,
    contractAddress: deployment.contractAddress,
    deployTx: deployment.txId,
    deployBlock: deployment.blockHeight,
    attesterCount: Number(l.attesters.size()),
    totalAttestations: Number(l.totalAttestations),
    attestations,
    readAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), value };
  return value;
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

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.sarif': 'application/json' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/registry') return send(res, 200, await registryState());
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_SOURCE) return send(res, 413, { error: 'Source too large.' }); chunks.push(chunk); }
      return send(res, 200, await scan(Buffer.concat(chunks)));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/deployments/')) {
      const file = normalize(join(HERE, '..', url.pathname));
      if (file.startsWith(join(HERE, '..', 'deployments')) && existsSync(file)) return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'text/plain');
      return send(res, 404, { error: 'Not found.' });
    }
    if (req.method === 'GET' && existsSync(UI_DIST)) {
      const file = normalize(join(UI_DIST, url.pathname === '/' ? 'index.html' : url.pathname));
      if (file.startsWith(UI_DIST) && existsSync(file)) return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
      return send(res, 200, readFileSync(join(UI_DIST, 'index.html')), 'text/html');
    }
    send(res, 404, { error: 'Not found.' });
  } catch (error) {
    send(res, 502, { error: error.message.replace(/project_id=[^&"\s]+/g, 'project_id=REDACTED') });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Registry UI and API on http://localhost:${PORT}`));
