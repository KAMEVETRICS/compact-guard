# Static analyzer

`@compact-guard/analyzer` is a TypeScript ESM library. Run `npm ci` and
`npm run build` at the repository root. Runtime dependency: `web-tree-sitter`
0.25.10, using `grammar/tree-sitter-compact.wasm`. Keep that file with this
workspace; the package is private and is not yet a standalone npm distribution.

## API

```ts
analyzeSource(source: string, file?: string, options?: AnalyzerOptions): Promise<AnalysisResult>
analyzeFile(file: string, options?: AnalyzerOptions): Promise<AnalysisResult>
analyzeDirectory(directory: string, options?: AnalyzerOptions): Promise<DirectoryResult>
parseSource(source: string, file?: string): Promise<ProgramIR>
```

`AnalysisResult` contains `findings`, `diagnostics`, `circuits` (entry-point
summaries) and `callGraph`. `Finding` matches PLAN.md exactly, including
`evidence.kind: "static"`. Positions are one-based lines and UTF-16 columns;
IR offsets are zero-based UTF-16 indices. Syntax errors skip rule evaluation
for that file. Filesystem and WASM-loading failures reject the promise.

Findings are deduplicated by `(rule, file, line, column)`. The strongest severity
wins and `evidence.detail` lists every entry circuit that produced the finding,
along with its distinct call-path evidence. `circuit` retains a representative
entry point for compatibility; consumers should use the evidence for all paths.

`parseSource` returns an owned IR with named fields, declarations, circuit
parameters/bodies, and spans. Native tree objects are deleted before return;
IR objects remain valid across later/concurrent parses. No analysis logic is
embedded in the grammar and its published schema is unchanged.

Directory results additionally contain `files: {file, result}[]`, ordered by
path. Traversal skips symlinks, `.git`, `node_modules`, `managed`, and `dist`.
An empty directory returns an empty files array; callers should check it.
The aggregate call graph uses `absoluteFile::circuit` keys. Source/file call
graphs use qualified circuit names; unresolved/library callees retain their
source names. Higher-order callbacks are evaluated when statically known but
are not expanded into the syntactic call graph.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `rules` | All eight | Exact rule IDs to emit; `[]` disables findings |
| `oneTimeCircuits` | `[]` | Explicit qualified names requiring replay review |
| `maxCallDepth` | 24 | Bound on nested known circuit evaluation |
| `lowDomainBits` | 16 | CG002 search-space threshold |

CG008 also accepts a source comment `// compact-guard: one-time claim`.
It names the circuit explicitly; the analyzer does not guess one-time intent
from names like `claim` or `withdraw`.

## Data flow and rules

The evaluator tracks witness, circuit argument, ledger, constant and unknown
origins. Arguments are private by default in Compact. `disclose` and hashing
preserve provenance. Values carry type/domain bounds, aggregate fields,
transformation history, value identity, and path/guard facts. A domain-size
bound is **not an entropy guarantee**; public ledger values contribute zero
unknown bits to the conditional search space. Bytes types never prove that
a witness returns fresh randomness.

Helpers are evaluated with actual arguments. Exported top-level circuits and
constructors are entry points; when there are no top-level exports, all
top-level circuits are evaluated. A file containing only modules evaluates
their circuits as library entry points. Same-file module circuit imports and
standard-library selection/aliases/prefixes are recognized. Branch states
are joined conservatively; short-circuited effects are conditional.

| Rule | Recognized pattern | Severity |
| --- | --- | --- |
| CG001 | `ownPublicKey` provenance in an assertion or a branch controlling a ledger effect | warning |
| CG002 | Private-derived persistent/transient hash input with a small bounded domain | warning |
| CG003 | Same randomizer identity in compatible commitment paths; constant/public randomizers | warning / review |
| CG004 | Raw/guessable private membership keys; protected-key reuse across exported circuits | warning / review |
| CG005 | Witness/private-derived Merkle `checkRoot` or asserted root equality without leaf binding | review |
| CG006 | Hash lacks a nonempty literal domain tag or literal prefix (including `pad`) | review |
| CG007 | Disclosure of an aggregate containing private provenance | review |
| CG008 | Explicit one-time action lacks a recognized matching nullifier check and insertion | review |

CG004 assigns a high-entropy **class** to private witness/argument types with
at least 128 bits of domain (for example `Bytes<32>` and `Field`). It recognizes
hashes/commitments that include such an input, including a high-domain randomizer.
These keys produce no warning: a review is emitted only if the same symbolic
derivation is used for membership in more than one exported circuit. Derivations
include witness declaration/arguments, domain prefixes and transformations;
different domains or witness declarations do not match. This is a potential
linkability check, not proof that repeated witness calls return identical values.
Only actual cryptographic outputs carry this protection: including a hash next
to a raw secret does not exempt an aggregate. Narrowing casts and arbitrary
arithmetic drop the high-entropy class. Raw witnesses, low-domain hashes, unknown
derivations and commitments with only public/constant randomness still warn.
Explicitly disclosed circuit inputs with no witness/unknown provenance produce
disclosure reviews, so intentional public inputs such as Battleship shots do
not become privacy warnings. Witness disclosure does not receive that exception.

CG005 requires the same path's `.leaf` to equal a computed hash/commitment or
trusted ledger/constant value. Wrong paths, disjunctions and checks after use
do not qualify. Other valid binding idioms can still need review.

CG008 recognizes an unconditional insertion preceded by an absence assertion
for the same container and value identity. Wrong polarity, keys, containers,
conditional insertions and later recognized container resets do not qualify.
This recognizes a guard pattern; it does not prove nullifier uniqueness,
eligibility, per-user identity, or cross-transaction security.

## Limits and coverage diagnostics

- External file imports/includes are not linked. Imported calls can have
  unknown behavior; `unresolved-import` and `unresolved-call` expose this.
- Standard-library models cover the listed primitives. Other calls retain
  input provenance and emit `opaque-builtin` or `unresolved-call` diagnostics.
  Ledger operations outside the recognized methods emit `ledger-operation`.
- Generic type substitution, full nominal typing, contract interfaces and
  compiler type checking are not implemented. Opaque or unresolved types may
  have unknown domains. Syntax validity is not compiler validity.
- Loops join a single iteration with zero iterations and emit `loop-summary`.
  Reuse across loop iterations or transactions is not proven. `map`/`fold`
  evaluate known literal aggregates up to 128 elements; other dimensions emit
  `higher-order-summary`. Recursion, call depth and expression budgets are bounded
  and emit diagnostics when exceeded.
- Ledger state is not symbolically executed across calls or transactions.
  Unknown ledger effects discard guard facts. Recognized facts remain a
  deliberately limited approximation rather than a satisfiability proof.
- CG001 treats assertions as potential authorization and can flag non-auth
  assertions. CG002 checks hash inputs even without a proven public sink.
  CG003 distinguishes separate witness calls but cannot prove their outputs
  independent; it cannot establish freshness across transactions. CG006 cannot
  prove tags are unique across protocols. CG007 cannot decide which fields the
  application actually needs. Review findings express those uncertainties.
- Findings are not exhaustive. Unsupported constructs and analysis limits can
  hide flows. No zero-finding result certifies security or a working exploit.

Rule rationale follows the official [Compact security guide](https://docs.midnight.network/compact/smart-contract-security.md)
and [standard-library API](https://docs.midnight.network/compact/standard-library/exports.md),
checked on 2026-10-12.
