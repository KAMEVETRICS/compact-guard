// Unit tests for the registry contract, run off-chain through the compiler's
// JavaScript output (no node, indexer or proof server), following
// https://docs.midnight.network/guides/compact-javascript-runtime
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits } from '../src/managed/registry/contract/index.js';

const COIN = '0'.repeat(64);
const ADDR = RT.sampleContractAddress();
const bytes = (n) => { const a = new Uint8Array(32); a[31] = n; return a; };
const hex = (b) => Buffer.from(b).toString('hex');

const ADMIN = bytes(1), ALICE = bytes(2), MALLORY = bytes(3);
const CONTRACT = bytes(10), REPORT = bytes(20), OTHER_REPORT = bytes(21);

// Private state: the caller's secret key plus one commitment opening per contract hash.
const witnesses = {
  localSecretKey: ({ privateState }) => [privateState, privateState.secretKey],
  reportOpening: ({ privateState }, contractHash) => {
    const opening = privateState.openings[hex(contractHash)];
    if (!opening) throw new Error('no stored opening for this contract');
    return [privateState, opening];
  },
};

const contract = new Contract(witnesses);
const as = (ctx, secretKey) => ({ ...ctx, currentPrivateState: { secretKey, openings: ctx.currentPrivateState.openings ?? {} } });
const state = (ctx) => ledger(ctx.currentQueryContext.state);

function deploy() {
  const ps = { secretKey: ADMIN, openings: {} };
  const ctor = contract.initialState(RT.createConstructorContext(ps, COIN));
  return RT.createCircuitContext(ADDR, COIN, ctor.currentContractState, ps);
}

function withAttester(secretKey = ALICE) {
  return contract.impureCircuits.addAttester(deploy(), pureCircuits.attesterPublicKey(secretKey)).context;
}

// The attester draws a fresh opening for each attestation and keeps it in private state.
function attest(ctx, secretKey, { contractHash = CONTRACT, report = REPORT, errors = 0n, warnings = 0n, reviews = 0n } = {}) {
  const caller = as(ctx, secretKey);
  caller.currentPrivateState.openings = { ...caller.currentPrivateState.openings, [hex(contractHash)]: randomBytes(32) };
  return contract.impureCircuits.attest(caller, contractHash, report, errors, warnings, reviews, bytes(99)).context;
}

test('starts with no attesters or attestations', () => {
  const s = state(deploy());
  assert.equal(s.admin.length, 32);
  assert.equal(s.attesters.size(), 0n);
  assert.equal(s.attestations.size(), 0n);
  assert.equal(s.totalAttestations, 0n);
});

test('only the admin can add and remove attesters', () => {
  const pk = pureCircuits.attesterPublicKey(ALICE);
  assert.throws(() => contract.impureCircuits.addAttester(as(deploy(), MALLORY), pk), /Only the admin can add attesters/);

  const added = contract.impureCircuits.addAttester(deploy(), pk).context;
  assert.ok(state(added).attesters.member(pk));

  assert.throws(() => contract.impureCircuits.removeAttester(as(added, MALLORY), pk), /Only the admin can remove attesters/);
  const removed = contract.impureCircuits.removeAttester(added, pk).context;
  assert.equal(state(removed).attesters.member(pk), false);
});

test('an authorized attester records public counts and a hidden report', () => {
  const ctx = attest(withAttester(), ALICE, { errors: 0n, warnings: 2n, reviews: 5n });
  const s = state(ctx);
  const record = s.attestations.lookup(CONTRACT);
  assert.equal(record.errors, 0n);
  assert.equal(record.warnings, 2n);
  assert.equal(record.reviews, 5n);
  assert.deepEqual(record.attester, pureCircuits.attesterPublicKey(ALICE));
  assert.deepEqual(record.toolVersion, bytes(99));
  assert.notDeepEqual(record.reportCommitment, REPORT, 'the report hash is not stored in the clear');
  assert.equal(s.totalAttestations, 1n);
});

test('fresh openings make commitments to the same report unlinkable', () => {
  const base = withAttester();
  const first = state(attest(base, ALICE)).attestations.lookup(CONTRACT).reportCommitment;
  const second = state(attest(base, ALICE)).attestations.lookup(CONTRACT).reportCommitment;
  assert.notDeepEqual(first, second);
});

test('unauthorized and removed attesters cannot attest', () => {
  const ctx = withAttester();
  assert.throws(() => attest(ctx, MALLORY), /Not an authorized attester/);
  const removed = contract.impureCircuits.removeAttester(ctx, pureCircuits.attesterPublicKey(ALICE)).context;
  assert.throws(() => attest(removed, ALICE), /Not an authorized attester/);
});

test('isClean reflects the latest attestation', () => {
  const ctx = withAttester();
  assert.equal(contract.impureCircuits.isClean(ctx, CONTRACT).result, false, 'unknown contract');
  const clean = attest(ctx, ALICE, { reviews: 3n });
  assert.equal(contract.impureCircuits.isClean(clean, CONTRACT).result, true, 'review notes do not count');
  const dirty = attest(clean, ALICE, { warnings: 1n });
  assert.equal(contract.impureCircuits.isClean(dirty, CONTRACT).result, false);
});

test('the original attester can reveal the report behind an attestation', () => {
  const ctx = attest(withAttester(), ALICE);
  const revealed = contract.impureCircuits.revealReport(ctx, CONTRACT, REPORT).context;
  assert.deepEqual(state(revealed).revealedReports.lookup(CONTRACT), REPORT);
});

test('a reveal must match the commitment and come from the original attester', () => {
  const base = contract.impureCircuits.addAttester(withAttester(ALICE), pureCircuits.attesterPublicKey(MALLORY)).context;
  const ctx = attest(base, ALICE);
  assert.throws(() => contract.impureCircuits.revealReport(ctx, CONTRACT, OTHER_REPORT), /Report hash does not match the attestation/);
  assert.throws(() => contract.impureCircuits.revealReport(as(ctx, MALLORY), CONTRACT, REPORT), /Only the original attester can reveal its report/);
  assert.throws(() => contract.impureCircuits.revealReport(ctx, bytes(11), REPORT), /No attestation for this contract/);
});

test('a new attestation clears an earlier reveal', () => {
  const revealed = contract.impureCircuits.revealReport(attest(withAttester(), ALICE), CONTRACT, REPORT).context;
  const reattested = attest(revealed, ALICE, { report: OTHER_REPORT });
  assert.equal(state(reattested).revealedReports.member(CONTRACT), false);
});
