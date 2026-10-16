# compact-guard: Wave 2 progress

compact-guard is a security checker for Midnight Compact contracts. The Compact
compiler already refuses code that leaks private data without `disclose()`.
compact-guard looks for what the compiler can't: disclosures, hashes,
commitments and access checks that compile fine but are unsafe. It runs from the
command line or in GitHub CI, and scan results can be recorded on Midnight
through a registry contract.

This is a new project, started in Wave 2. Everything below was built during the
Wave 2 build period.

## What we built

**Compact parser.** A tree-sitter grammar for Compact, compiled to WASM so it
runs anywhere Node.js runs, Windows included. It parses every official example we
tested with zero errors: example-bboard, example-private-party,
example-battleship, the six contract examples in the Midnight docs, and the
midnight-rps-sample-app.

**Static analyzer with 8 rules.** For every value it tracks where it came from
(witness, circuit argument, ledger, constant), how many values it can take, and
whether it passed through `disclose`, a hash or a commitment, following helper
circuits and struct fields.

| Rule | Catches |
| --- | --- |
| CG001 | Authorization through `ownPublicKey()`, which the prover controls |
| CG002 | Hash of a small-domain private value (a vote, an age) that anyone can brute-force |
| CG003 | Reused or public commitment randomness |
| CG004 | Private value used as a public Set/Map key |
| CG005 | Merkle path not bound to the caller's own leaf |
| CG006 | Hash without domain separation |
| CG007 | Whole private struct disclosed when one field would do |
| CG008 | One-time action with no nullifier, so it can be replayed |

Every finding links to the section of the Midnight docs it enforces.

**Tested against Midnight's own code.** Our first version reported 17 warnings
on the official examples, mostly noise from the standard hash-of-secret-key
pattern. We reworked the analysis: now 0 warnings and 12 review notes, each a
real design question. For example, the election example queries the same voter
identifier from three circuits, which makes a voter's actions linkable.

**Test corpus.** 8 pairs of small contracts, one vulnerable and one fixed per
rule. All 16 compile with compiler 0.31.1 (language 0.23).

**CLI and CI.** `compact-guard` prints text, JSON or SARIF 2.1.0 (validated
against the official SARIF schema), with exit codes for CI. A GitHub Action
uploads results to GitHub code scanning so findings appear on pull requests.

**Registry contract.** A Compact contract that records scan results on Midnight.
For each contract, identified by its source hash, it stores public finding counts
and the tool version. The full report stays off-chain behind a
`persistentCommit`, and the attester can later prove which report it was.

- The admin and attesters authenticate by proving knowledge of a secret key
  inside the circuit, never with `ownPublicKey()`.
- Hashes are domain-separated, and every commitment uses fresh randomness.
- 5 circuits plus a pure helper. It compiles with proving keys.
- compact-guard scans its own registry with 0 errors, 0 warnings and 5 review
  notes, all on the contract hash, which is public by design.

**Deployed to Midnight Preprod.** Contract address
`e27624e00a5f3a1fcc64f1b370aaea3f5d028eb9fb4be92ff852dbb44be24538`, deploy
transaction `00ab7c4bcd0cf6bd13ca528c7b162cc881d4324ac3044eb9fab5adf1067f65926d`
at block 3,005,143. Reading the contract back through the Preprod indexer shows
the admin key set and an empty registry. The deploy script follows Midnight's
deploy guide with Midnight.js 4.1.1. Because a fresh Preprod wallet sync took
hours on our connection, the script saves wallet sync state every five minutes,
resumes from it after an interruption, and restarts automatically if the
indexer connection stalls.

## Testing

- 41 analyzer tests, 12 CLI tests, 9 registry contract tests and 11 parser
  tests, all passing on a clean checkout.
- The registry tests run the compiled contract off-chain through
  `@midnight-ntwrk/compact-runtime`. They cover admin and attester authorization,
  rejected callers, commitment hiding and the reveal flow. As a check on the
  tests themselves, deleting the attester check from the contract makes the
  matching test fail.

## Limits

- The analysis is static and heuristic. A clean result is not proof that a
  contract is safe.
- It does not follow imports across files yet.
- It runs from a clone of the repo; it is not published to npm yet.

## Next, for Wave 3

- `compact-guard attest`: publish a scan result to the registry from the CLI or CI.
- A small web page to look up a contract's attestation.
- Cross-file analysis and more rules.
