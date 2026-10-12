# Vulnerable / fixed corpus

Eight original pairs target PLAN.md's CG001–CG008. Every `.compact` file is
self-contained, targets language 0.26, and parses through the committed WASM.
`manifest.json` version 1 records paths and expected presence/absence of the
target rule. Additional rules may fire: a fixed member addresses its pair's
target issue, not every security concern in a complete application.

Run `npm test` at the root to verify all pairs against the analyzer. Run
`node grammar/scripts/parse-all.mjs corpus` for syntax-only validation.

| Pair | Vulnerability | Change in fixed variant |
| --- | --- | --- |
| CG001 | Witness-controlled public key authorizes a write | Assert knowledge of a secret matching the stored domain-separated hash |
| CG002 | Publish the hash of a Boolean vote | Publish a randomized commitment |
| CG003 | Two commitments share the same opening | Request a separate opening for each commitment |
| CG004 | Public Set query reveals a private-derived member key | Use a Merkle path and bind the leaf to the derived member |
| CG005 | Merkle path proves any leaf | Assert the path leaf matches the derived member |
| CG006 | Hash secret without a protocol tag | Prefix the input with a literal domain tag |
| CG007 | Disclose profile including recovery secret | Disclose only age |
| CG008 | Repeating a claim has no replay guard | Check and insert a domain-separated nullifier |

## Harness assumptions

- CG001: initialize `owner` with the intended admin public key (vulnerable) or
  the documented `cg:owner` hash of the admin secret (fixed). A malicious
  `ownPublicKey` witness must not be accepted as evidence of secret knowledge.
- CG002/CG003: honest randomizer witnesses must return cryptographically random,
  independent 32-byte outputs and retain openings if later needed. Separate
  witness invocations are not proof of freshness; malicious/buggy witness
  implementations can still reuse them. Cross-transaction context/counters
  belong in the application protocol and are outside these tiny fixtures.
- CG004/CG005: initialize the Merkle tree with the `cg:member` hash of an
  enrolled secret and generate the corresponding `MerkleTreePath<8,Bytes<32>>`.
  An arbitrary valid path must not grant knowledge of that enrolled secret.
- CG007 deliberately changes the output type to expose only the requested age.
- CG008 models one claim **per fixed secret**. Replaying the same secret must
  fail in the fixed version. Eligibility and secret-to-user binding are not
  implemented; choosing new secrets is not prevented. The public nullifier
  lookup intentionally also triggers CG004 for disclosure review.

## Validation status

The fixtures are parser/analyzer tests, not deployed contracts or reproduced
exploits. `compilerVerified: false` is explicit for every case. The Compact
compiler requires a supported environment; this Windows host has no WSL
toolchain. Compiler type checking, generated witness implementations and
off-chain execution remain to be verified by the attack-harness task.

API signatures were checked against the official
[standard-library exports](https://docs.midnight.network/compact/standard-library/exports.md).
The [security guide](https://docs.midnight.network/compact/smart-contract-security.md)
provides the rule rationale. The code here is original fixture code.
