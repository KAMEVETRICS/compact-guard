# compact-guard: Wave 2 progress

compact-guard is a security checker for Midnight Compact contracts. The Compact
compiler already refuses code that leaks private data without `disclose()`.
compact-guard looks for what the compiler can't: disclosures, hashes,
commitments and access checks that compile fine but are unsafe. It runs from the
command line, in GitHub CI and in a web UI, and its results are recorded on
Midnight in a registry contract that is live on Preprod with 11 attestations.

**Who it's for.** Every team building on Midnight, before they deploy; auditors
who want to publish what they checked; and users or investors who want to know
whether a contract was scanned, and with what result.

**Why it needs Midnight's privacy.** A security report is dangerous to publish
before its bugs are fixed. The registry stores public finding counts and only a
commitment to the full report, so a project can prove it was scanned without
exposing unfixed vulnerabilities. The attester can reveal the report later and
prove it is the one committed to on-chain.

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
- `src/witnesses.ts` implements the witnesses and the private state (secret key
  and per-contract report openings), shared by the tests and the deploy scripts.
- compact-guard scans its own registry with 0 errors, 0 warnings and 5 review
  notes, all on the contract hash, which is public by design.

**Deployed to Midnight Preprod, with real attestations.** Contract address
`e27624e00a5f3a1fcc64f1b370aaea3f5d028eb9fb4be92ff852dbb44be24538`, deployed
at block 3,005,143. It holds 11 attestations, each a real compact-guard scan:
the registry itself, Midnight's bulletin board example, the six contract
examples from the Midnight docs, and three test contracts (two deliberately
vulnerable, so they show as having issues). The registry's own report is revealed
on-chain (block 3,039,250), and its SARIF is in
`contracts/registry/deployments/reports/registry.sarif`; its SHA-256 matches
the revealed value. Every transaction and block is listed in
`contracts/registry/deployments/preprod-attestations.json`.

The deploy and attest scripts follow Midnight's deploy guide with Midnight.js
4.1.1. A fresh Preprod wallet sync took hours on our connection, so they save
wallet sync state every five minutes, resume from it, and restart automatically
when the indexer connection stalls or returns a transient error.

**Web UI.** A React app backed by a small local API. Paste or drop a Compact
contract to see its findings, each linked to the Midnight docs, and whether that
exact source is attested on-chain. The table lists every attestation read live
from the Preprod indexer: finding counts, clean or not, and whether the report
is private or revealed.

## Testing

- 41 analyzer tests, 12 CLI tests, 10 registry contract tests and 11 parser
  tests, all passing.
- The registry tests drive the compiled contract through a simulator
  (`src/test/registry-simulator.ts`) on `@midnight-ntwrk/compact-runtime`. They
  cover admin and attester authorization, rejected callers, commitment hiding and
  unlinkability, the reveal flow and domain separation between key roles. As a
  check on the tests themselves, deleting the attester check from the contract
  makes the matching test fail.

## Limits

- The analysis is static and heuristic. A clean result is not proof that a
  contract is safe.
- It does not follow imports across files yet.
- It runs from a clone of the repo; it is not published to npm yet.
- The web UI runs locally, because reading Preprod through Blockfrost needs a
  project token that must not ship to browsers.
- One attester today (us). Adding attesters is an admin call the contract
  already supports.

## Next, for Wave 3

- Publish attestations straight from CI, so every merge to main is attested.
- Host the lookup page publicly.
- Cross-file analysis and more rules.
