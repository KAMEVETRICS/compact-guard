// Scans contracts with compact-guard and records the results in the deployed
// registry on Midnight Preprod. For each target it publishes the source hash,
// finding counts and a commitment to the SARIF report's hash; the report stays
// in reports/ (gitignored). The registry's own report is then revealed and its
// SARIF copied to deployments/reports/, so anyone can check it against the
// on-chain value. Safe to rerun: matching attestations are skipped.
//
// The wallet is both admin and attester; each role uses a key derived from the
// same secret under a different domain tag (see registry.compact).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { toHex, withOpening } from '../src/witnesses.ts';
import { DEPLOYMENT_FILE, HERE, PRIVATE_STATE_ID, log, openSession } from './session.mjs';

const ROOT = join(HERE, '..', '..', '..');
const OFFICIAL = 'packages/analyzer/test/fixtures/official';
const TARGETS = [
  ['contracts/registry/src/registry.compact', 'compact-guard registry (this contract)'],
  [`${OFFICIAL}/example-bboard.compact`, 'Midnight example: bulletin board'],
  [`${OFFICIAL}/election.compact`, 'Midnight docs: election'],
  [`${OFFICIAL}/private-guest-list.compact`, 'Midnight docs: private guest list'],
  [`${OFFICIAL}/private-reserve-auction.compact`, 'Midnight docs: private reserve auction'],
  [`${OFFICIAL}/battleship-simple.compact`, 'Midnight docs: battleship'],
  [`${OFFICIAL}/calculator.compact`, 'Midnight docs: calculator'],
  [`${OFFICIAL}/token-transfers.compact`, 'Midnight docs: token transfers'],
  ['corpus/CG001/vulnerable.compact', 'Test contract CG001, deliberately vulnerable'],
  ['corpus/CG001/fixed.compact', 'Test contract CG001, fixed'],
  ['corpus/CG002/vulnerable.compact', 'Test contract CG002, deliberately vulnerable'],
];
const REVEAL = 'contracts/registry/src/registry.compact';
const ATTESTATIONS_FILE = join(HERE, '..', 'deployments', 'preprod-attestations.json');
const sha256 = (data) => new Uint8Array(createHash('sha256').update(data).digest());

const cliPackage = JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
const TOOL = `compact-guard ${cliPackage.version}`;
const { main: runCli } = await import(pathToFileURL(join(ROOT, 'packages', 'cli', 'dist', 'run.js')).href);

/** Runs the compact-guard CLI on one file and returns SARIF with a machine-independent SRCROOT. */
async function scan(path) {
  let out = '', err = '';
  const code = await runCli([path, '--format', 'sarif', '--fail-on', 'none'], { cwd: ROOT, stdout: (t) => { out += t; }, stderr: (t) => { err += t; } });
  if (code !== 0) throw new Error(`compact-guard failed on ${path}: ${err}`);
  const sarif = JSON.parse(out);
  sarif.runs[0].originalUriBaseIds.SRCROOT.uri = 'file:///compact-guard/';
  const text = `${JSON.stringify(sarif, null, 2)}\n`;
  const counts = { errors: 0n, warnings: 0n, reviews: 0n };
  for (const r of sarif.runs[0].results) {
    if (r.level === 'error') counts.errors++;
    else if (r.level === 'warning') counts.warnings++;
    else counts.reviews++;
  }
  return { text, counts };
}

const session = await openSession();
const { providers, compiledContract, contractModule, adminSecret } = session;
const { contractAddress } = JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8'));
const registry = await findDeployedContract(providers, { contractAddress, compiledContract, privateStateId: PRIVATE_STATE_ID });
const readLedger = async () => contractModule.ledger((await providers.publicDataProvider.queryContractState(contractAddress)).data);
const myKey = contractModule.pureCircuits.attesterPublicKey(adminSecret);
const sameBytes = (a, b) => toHex(a) === toHex(b);
const stored = await providers.privateStateProvider.get(PRIVATE_STATE_ID);
if (!(stored?.secretKey instanceof Uint8Array)) throw new Error('Stored private state is missing or malformed.');

if (!(await readLedger()).attesters.member(myKey)) {
  log('Registering this wallet as an attester...');
  const tx = await registry.callTx.addAttester(myKey);
  log(`Attester added (tx ${tx.public.txId}, block ${tx.public.blockHeight}).`);
} else {
  log('This wallet is already an attester.');
}

const toolVersion = sha256(TOOL);
const records = [];
const previous = (() => { try { return JSON.parse(readFileSync(ATTESTATIONS_FILE, 'utf8')).attestations; } catch { return []; } })();
const revealHash = sha256(readFileSync(join(ROOT, REVEAL)));

/** Writes the public summary; called after every attestation so a crash never loses block numbers. */
function writeSummary() {
  const merged = records.map((r) => r.status === 'unchanged' ? { ...previous.find((p) => p.contractHash === r.contractHash), ...r, status: undefined } : r);
  writeFileSync(ATTESTATIONS_FILE, `${JSON.stringify({
    network: 'preprod', contractAddress, tool: TOOL, toolVersionHash: toHex(toolVersion),
    attester: toHex(myKey), updatedAt: new Date().toISOString(),
    revealed: { path: REVEAL, contractHash: toHex(revealHash), sarif: 'deployments/reports/registry.sarif' },
    attestations: [...merged, ...previous.filter((p) => !merged.some((m) => m.contractHash === p.contractHash))],
  }, null, 2)}\n`);
}
mkdirSync(join(HERE, 'reports'), { recursive: true });
for (const [path, label] of TARGETS) {
  const source = readFileSync(join(ROOT, path));
  const contractHash = sha256(source);
  const { text, counts } = await scan(path);
  const reportHash = sha256(text);
  writeFileSync(join(HERE, 'reports', `${toHex(contractHash)}.sarif`), text);
  const record = {
    label, path, contractHash: toHex(contractHash),
    errors: Number(counts.errors), warnings: Number(counts.warnings), reviews: Number(counts.reviews),
  };

  const ledgerNow = await readLedger();
  const existing = ledgerNow.attestations.member(contractHash) ? ledgerNow.attestations.lookup(contractHash) : undefined;
  if (existing && sameBytes(existing.attester, myKey) && sameBytes(existing.toolVersion, toolVersion)
      && existing.errors === counts.errors && existing.warnings === counts.warnings && existing.reviews === counts.reviews) {
    log(`Already attested: ${label}`);
    records.push({ ...record, status: 'unchanged' });
    continue;
  }

  // A fresh opening per attestation keeps commitments to the same report unlinkable.
  const current = await providers.privateStateProvider.get(PRIVATE_STATE_ID);
  await providers.privateStateProvider.set(PRIVATE_STATE_ID, withOpening(current, contractHash, new Uint8Array(randomBytes(32))));
  log(`Attesting: ${label} (${counts.errors} error, ${counts.warnings} warning, ${counts.reviews} review)...`);
  const tx = await registry.callTx.attest(contractHash, reportHash, counts.errors, counts.warnings, counts.reviews, toolVersion);
  log(`  recorded in block ${tx.public.blockHeight} (tx ${tx.public.txId})`);
  records.push({ ...record, txId: tx.public.txId, blockHeight: Number(tx.public.blockHeight) });
  writeSummary();
}

// Reveal one report end to end: publish its hash on-chain and its SARIF in the repo.
const revealText = readFileSync(join(HERE, 'reports', `${toHex(revealHash)}.sarif`));
const ledgerBeforeReveal = await readLedger();
if (ledgerBeforeReveal.revealedReports.member(revealHash) && sameBytes(ledgerBeforeReveal.revealedReports.lookup(revealHash), sha256(revealText))) {
  log('Registry report already revealed.');
} else {
  log('Revealing the registry\'s own report...');
  const tx = await registry.callTx.revealReport(revealHash, sha256(revealText));
  log(`  revealed in block ${tx.public.blockHeight} (tx ${tx.public.txId})`);
}
const publicReports = join(HERE, '..', 'deployments', 'reports');
mkdirSync(publicReports, { recursive: true });
writeFileSync(join(publicReports, 'registry.sarif'), revealText);
writeSummary();

const finalLedger = await readLedger();
log(`Done. Registry holds ${finalLedger.attestations.size()} attestation(s); total recorded ${finalLedger.totalAttestations}.`);
await session.close(0);
