# Analyzer validation — 2026-10-13

Target: **Compact language 0.23**, **compiler 0.31.1**. Parser schema and WASM
are unchanged. The analyzer remains a JavaScript/WASM-only runtime on Windows.

## Checks

- `npm test`: **41 analyzer tests + 11 grammar runtime tests passed**.
- All seven vendored official examples compile with `compact compile --skip-zk`
  in WSL Ubuntu; generated output stays under /tmp.
- All 16 corpus files compile again using `scripts/compile-corpus.sh`; see
  [CORPUS_COMPILE_LOG.md](CORPUS_COMPILE_LOG.md).
- Every vulnerable fixture retains its target rule and every fixed fixture
  clears its target rule.
- Official regression tests use local fixtures only, assert zero error/warning
  findings, and pin every allowed review's rule, line, column and message category.
- All official and corpus files have zero syntax-error diagnostics.

## Official examples: before / after

Each count is **error / warning / review**. Baseline: analyzer commit 39bd582,
measured before these changes on the vendored sources. Source/revision pins and
compiler results are in [the fixture README](../packages/analyzer/test/fixtures/official/README.md).

| File | Before E / W / R | After E / W / R |
| --- | --- | --- |
| battleship-simple.compact | 0 / 6 / 4 | 0 / 0 / 3 |
| calculator.compact | 0 / 0 / 0 | 0 / 0 / 0 |
| election.compact | 0 / 6 / 2 | 0 / 0 / 7 |
| example-bboard.compact | 0 / 0 / 0 | 0 / 0 / 0 |
| private-guest-list.compact | 0 / 3 / 0 | 0 / 0 / 1 |
| private-reserve-auction.compact | 0 / 2 / 3 | 0 / 0 / 1 |
| token-transfers.compact | 0 / 0 / 0 | 0 / 0 / 0 |
| **Total** | **0 / 17 / 9** | **0 / 0 / 12** |

Total findings: **26 → 12**; warnings: **17 → 0**. The same helper location now
produces one finding with all reaching entry circuits in its evidence, including
battleship-simple:475 (formerly four copies), election:253 (two) and
private-reserve-auction:175 (three).

### Retained findings (all review)

| Source location | Rule | Justification |
| --- | --- | --- |
| battleship-simple.compact:241:13 | CG004 | An explicitly disclosed circuit input is used as a membership key; review the intended public disclosure. |
| battleship-simple.compact:285:13 | CG004 | An explicitly disclosed circuit input is used as a membership key; review the intended public disclosure. |
| battleship-simple.compact:475:18 | CG006 | Hash input has no literal domain prefix; review separation of cryptographic uses. |
| election.compact:89:13 | CG004 | The same voter-identifier derivation is queried from registerToVote, commitVote and revealVote; review intended linkability. |
| election.compact:129:12 | CG004 | The same voter-identifier derivation is queried from registerToVote, commitVote and revealVote; review intended linkability. |
| election.compact:131:13 | CG004 | The same voter-identifier derivation is queried from registerToVote, commitVote and revealVote; review intended linkability. |
| election.compact:165:12 | CG004 | The same voter-identifier derivation is queried from registerToVote, commitVote and revealVote; review intended linkability. |
| election.compact:167:12 | CG004 | The same voter-identifier derivation is queried from registerToVote, commitVote and revealVote; review intended linkability. |
| election.compact:181:12 | CG004 | The same voter-identifier derivation is queried from registerToVote, commitVote and revealVote; review intended linkability. |
| election.compact:253:21 | CG006 | Hash input has no literal domain prefix; review separation of cryptographic uses. |
| private-guest-list.compact:175:13 | CG004 | An explicitly disclosed circuit input is used as a membership key; review the intended public disclosure. |
| private-reserve-auction.compact:175:18 | CG006 | Hash input has no literal domain prefix; review separation of cryptographic uses. |

There are no retained findings on example-bboard, calculator or token-transfers.
These reviews are explicit protocol/disclosure questions, not claims that a
public key hash reveals the underlying high-entropy secret.

## Corpus: findings by file and severity

| File | E / W / R | Rules |
| --- | --- | --- |
| CG001/fixed.compact | 0 / 0 / 0 | — |
| CG001/vulnerable.compact | 0 / 1 / 0 | CG001 |
| CG002/fixed.compact | 0 / 0 / 0 | — |
| CG002/vulnerable.compact | 0 / 1 / 1 | CG002, CG006 |
| CG003/fixed.compact | 0 / 0 / 0 | — |
| CG003/vulnerable.compact | 0 / 1 / 0 | CG003 |
| CG004/fixed.compact | 0 / 0 / 0 | — |
| CG004/vulnerable.compact | 0 / 1 / 0 | CG004 |
| CG005/fixed.compact | 0 / 0 / 0 | — |
| CG005/vulnerable.compact | 0 / 0 / 1 | CG005 |
| CG006/fixed.compact | 0 / 0 / 0 | — |
| CG006/vulnerable.compact | 0 / 0 / 1 | CG006 |
| CG007/fixed.compact | 0 / 0 / 0 | — |
| CG007/vulnerable.compact | 0 / 0 / 1 | CG007 |
| CG008/fixed.compact | 0 / 0 / 0 | — |
| CG008/vulnerable.compact | 0 / 0 / 1 | CG008 |
| **Total** | **0 / 4 / 5** | |

CG004's former vulnerable hash-of-secret example was precisely the newly exempt
pattern. Its vulnerable variant now queries the raw witness key instead, so
it remains a meaningful warning regression. The fixed Merkle variant is unchanged.
CG008's fixed high-entropy nullifier is queried by only one exported circuit and
now correctly produces no CG004 finding.

## Compatibility and analysis boundaries

All new contracts start with `pragma language_version 0.23;`. Bboard and
Battleship's pragmas were relocated; token-transfers gained a pragma. The
upstream calculator example failed 0.31.1 until its witness-derived quotient
return was changed to `return disclose(quo);`. This sole logic adaptation is
recorded in the fixture README. Other contract bodies are unchanged.

High-entropy classification is type-based (at least 128 bits), not proof of
randomness or secrecy. Raw witnesses and low/unknown-domain derivations continue
to warn. Public salts and narrowed projections cannot manufacture secret entropy.
Cryptographic keys trigger a linkability review only when their symbolic
derivation appears in multiple exported entry circuits. No cross-file inference
or proof of run-time witness equality is claimed.

Coverage diagnostics remain separate from findings (for example opaque ledger
operations or unsupported library calls). Zero warning findings is not a claim
of complete semantic coverage. Compilation skips proof generation; dynamic
attacks and deployed behavior were not tested in this task.
