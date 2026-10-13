# Analyzer validation — 2026-10-12

`npm test` passed: **28 analyzer tests** and **11 grammar runtime tests**.
The analyzer test run includes TypeScript compilation with strict checking.
Independent review found five data-flow/identity issues; all were reproduced,
fixed and covered by regression tests before this final run.

`node grammar/scripts/parse-all.mjs corpus`:

```text
corpus: 16 files, 0 ERROR, 0 MISSING, 0 files with errors
```

All eight vulnerable fixtures report their target rule. Every fixed fixture
clears its target rule. Additional findings are expected:

| Pair | Vulnerable findings | Fixed findings |
| --- | --- | --- |
| CG001 | CG001 | — |
| CG002 | CG002, CG006 | — |
| CG003 | CG003 | — |
| CG004 | CG004 | — |
| CG005 | CG005 | — |
| CG006 | CG006 | — |
| CG007 | CG007 | — |
| CG008 | CG008 | CG004 |

CG008's fixed nullifier intentionally uses a disclosed private-derived key.
CG004 asks for disclosure review; it does not mean the replay guard is missing.

## Real-source smoke scans

The scratch sources and revisions are listed in
[the parser acceptance report](../grammar/KNOWN_ISSUES.md). No external source
was modified for these scans. Each analyzer scan completed without exceptions.
These finding counts are **untriaged static candidates**, not confirmed bugs.

| Source | Files | Syntax errors | Findings | Coverage diagnostic codes |
| --- | ---: | ---: | ---: | --- |
| example-bboard | 1 | 0 | 0 | ledger-operation |
| example-private-party | 1 | 0 | 3 | ledger-operation, opaque-builtin, unresolved-call |
| midnight-rps-sample-app | 1 | 0 | 6 | — |
| docs-contracts | 6 | 0 | 26 | ledger-operation, opaque-builtin, unresolved-call |
| example-battleship | 1 | 0 | 10 | ledger-operation |

`example-private-party` uses the README source extracted in the original parser
validation because the repository does not track the `.compact` file.

Parser files were not modified. Verified SHA-256 hashes still match the
published parser commit:

- node-types.json: `2a56adbf9c35612c39cc2e291f21b268e10b84dd3f022acd581e843723e31125`
- WASM: `82dbe823e93b1dfa5b3b479717dc5a1446c28fb6a2b62f4a8d1872b49f5b2c1e`

## Remaining validation

2026-10-13: all 16 corpus files compile with compiler 0.31.1 (language 0.23)
under WSL; see [CORPUS_COMPILE_LOG.md](CORPUS_COMPILE_LOG.md). The pragma was
changed from 0.26 to 0.23 because 0.31.1 rejects 0.26; no other source changed.
All manifest entries now have `compilerVerified: true`. The corpus has not been
executed with the runtime yet, so there are still no exploit-evidence claims.
Cross-file imports, generic substitution and the bounded/heuristic analysis
limits are described in [the analyzer README](../packages/analyzer/README.md).
