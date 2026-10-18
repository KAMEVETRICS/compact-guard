import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RegistrySimulator } from './registry-simulator.ts';

const bytes = (n: number): Uint8Array => { const a = new Uint8Array(32); a[31] = n; return a; };

const ADMIN = bytes(1), ALICE = bytes(2), MALLORY = bytes(3);
const CONTRACT = bytes(10), REPORT = bytes(20), OTHER_REPORT = bytes(21);
const pk = RegistrySimulator.attesterPublicKey;

/** A registry where ALICE is an authorized attester, acting as ALICE. */
function withAlice(): RegistrySimulator {
  const sim = new RegistrySimulator(ADMIN);
  sim.addAttester(pk(ALICE));
  return sim.as(ALICE);
}

test('starts with no attesters or attestations', () => {
  const s = new RegistrySimulator(ADMIN).ledger;
  assert.equal(s.admin.length, 32);
  assert.equal(s.attesters.size(), 0n);
  assert.equal(s.attestations.size(), 0n);
  assert.equal(s.totalAttestations, 0n);
});

test('only the admin can add and remove attesters', () => {
  const sim = new RegistrySimulator(ADMIN);
  assert.throws(() => sim.as(MALLORY).addAttester(pk(ALICE)), /Only the admin can add attesters/);

  sim.as(ADMIN).addAttester(pk(ALICE));
  assert.ok(sim.ledger.attesters.member(pk(ALICE)));

  assert.throws(() => sim.as(MALLORY).removeAttester(pk(ALICE)), /Only the admin can remove attesters/);
  sim.as(ADMIN).removeAttester(pk(ALICE));
  assert.equal(sim.ledger.attesters.member(pk(ALICE)), false);
});

test('an authorized attester records public counts and a hidden report', () => {
  const sim = withAlice();
  sim.attest(CONTRACT, REPORT, { warnings: 2n, reviews: 5n }, bytes(99));
  const record = sim.ledger.attestations.lookup(CONTRACT);
  assert.equal(record.errors, 0n);
  assert.equal(record.warnings, 2n);
  assert.equal(record.reviews, 5n);
  assert.deepEqual(record.attester, pk(ALICE));
  assert.deepEqual(record.toolVersion, bytes(99));
  assert.notDeepEqual(record.reportCommitment, REPORT, 'the report hash is not stored in the clear');
  assert.equal(sim.ledger.totalAttestations, 1n);
});

test('fresh openings make commitments to the same report unlinkable', () => {
  const sim = withAlice();
  sim.attest(CONTRACT, REPORT);
  const first = sim.ledger.attestations.lookup(CONTRACT).reportCommitment;
  sim.attest(CONTRACT, REPORT);
  const second = sim.ledger.attestations.lookup(CONTRACT).reportCommitment;
  assert.notDeepEqual(first, second);
});

test('unauthorized and removed attesters cannot attest', () => {
  const sim = withAlice();
  assert.throws(() => sim.as(MALLORY).attest(CONTRACT, REPORT), /Not an authorized attester/);
  sim.as(ADMIN).removeAttester(pk(ALICE));
  assert.throws(() => sim.as(ALICE).attest(CONTRACT, REPORT), /Not an authorized attester/);
});

test('isClean reflects the latest attestation', () => {
  const sim = withAlice();
  assert.equal(sim.isClean(CONTRACT), false, 'unknown contract');
  sim.attest(CONTRACT, REPORT, { reviews: 3n });
  assert.equal(sim.isClean(CONTRACT), true, 'review notes do not count');
  sim.attest(CONTRACT, REPORT, { warnings: 1n });
  assert.equal(sim.isClean(CONTRACT), false);
});

test('the original attester can reveal the report behind an attestation', () => {
  const sim = withAlice();
  sim.attest(CONTRACT, REPORT);
  sim.revealReport(CONTRACT, REPORT);
  assert.deepEqual(sim.ledger.revealedReports.lookup(CONTRACT), REPORT);
});

test('a reveal must match the commitment and come from the original attester', () => {
  const sim = withAlice();
  sim.as(ADMIN).addAttester(pk(MALLORY));
  sim.as(ALICE).attest(CONTRACT, REPORT);
  assert.throws(() => sim.revealReport(CONTRACT, OTHER_REPORT), /Report hash does not match the attestation/);
  assert.throws(() => sim.as(MALLORY).revealReport(CONTRACT, REPORT), /Only the original attester can reveal its report/);
  assert.throws(() => sim.as(ALICE).revealReport(bytes(11), REPORT), /No attestation for this contract/);
});

test('a new attestation clears an earlier reveal', () => {
  const sim = withAlice();
  sim.attest(CONTRACT, REPORT);
  sim.revealReport(CONTRACT, REPORT);
  sim.attest(CONTRACT, OTHER_REPORT);
  assert.equal(sim.ledger.revealedReports.member(CONTRACT), false);
});

test('admin and attester keys from the same secret differ (domain separation)', () => {
  const sim = new RegistrySimulator(ADMIN);
  assert.notDeepEqual(sim.ledger.admin, pk(ADMIN));
});
