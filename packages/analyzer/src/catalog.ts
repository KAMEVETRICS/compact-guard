import type { Finding, RuleId } from './model.js';

const SECURITY = 'https://docs.midnight.network/compact/smart-contract-security';
const PRIVATE = 'https://docs.midnight.network/concepts/how-midnight-works/keeping-data-private';

export interface RuleInfo {
  id: RuleId;
  title: string;
  description: string;
  // Strongest severity the rule emits; SARIF uses it as the default level.
  defaultSeverity: Finding['severity'];
  docUrl: string;
}

export const RULES: readonly RuleInfo[] = [
  { id: 'CG001', title: 'Authorization via ownPublicKey()', defaultSeverity: 'warning',
    description: 'ownPublicKey() is a witness: the prover chooses its value, so checks built on it can be bypassed. Authorize by proving knowledge of a secret.',
    docUrl: `${SECURITY}#ownpublickey-is-a-witness-function` },
  { id: 'CG002', title: 'Guessable hash of a low-entropy value', defaultSeverity: 'warning',
    description: 'Hashing a private value from a small domain (Boolean, enum, small Uint) without randomness lets anyone recover it by hashing every candidate.',
    docUrl: `${PRIVATE}#hashes-and-commitments` },
  { id: 'CG003', title: 'Reused or public commitment randomness', defaultSeverity: 'warning',
    description: 'Commitments that share randomness, or use constant or public randomness, can be linked or opened by observers.',
    docUrl: `${PRIVATE}#randomness-and-rounds-in-commitments` },
  { id: 'CG004', title: 'Private value used as a public Set/Map key', defaultSeverity: 'warning',
    description: 'Set and Map operations publish their arguments. Membership keyed on private data exposes or links it; a MerkleTree proves membership without revealing which entry.',
    docUrl: `${PRIVATE}#making-use-of-merkle-trees` },
  { id: 'CG005', title: 'Merkle path not bound to the caller\'s leaf', defaultSeverity: 'review',
    description: 'A witness-supplied Merkle path proves that some leaf is in the tree, not that the caller\'s leaf is, unless the path leaf is checked against a recomputed or trusted value.',
    docUrl: `${PRIVATE}#making-use-of-merkle-trees` },
  { id: 'CG006', title: 'Hash without domain separation', defaultSeverity: 'review',
    description: 'Hash inputs without a distinct literal domain tag can collide across different uses of the same primitive.',
    docUrl: `${SECURITY}#best-practice-use-domain-separation` },
  { id: 'CG007', title: 'Whole private aggregate disclosed', defaultSeverity: 'review',
    description: 'disclose() around a whole struct or tuple publishes every field; disclose only the fields that must be public.',
    docUrl: `${SECURITY}#best-practice-place-disclose-strategically` },
  { id: 'CG008', title: 'One-time action without a nullifier', defaultSeverity: 'review',
    description: 'A circuit declared one-time has no recognized nullifier absence check followed by insertion, so it can be replayed.',
    docUrl: `${SECURITY}#double-spend-prevention-with-nullifiers` },
];

export const RULE_BY_ID: ReadonlyMap<string, RuleInfo> = new Map(RULES.map(r => [r.id, r]));
