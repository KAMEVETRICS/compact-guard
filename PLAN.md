# compact-guard: plan

Security analyzer for Midnight Compact contracts. Target: Midnight Buildathon Wave 2 (deadline **Oct 19, 2026, 15:00 UTC**), then extend in Wave 3.

**Pitch:** The compiler stops leaks you didn't mean. compact-guard finds the ones you *did* mean but got wrong, and proves each one with a working exploit.

## Why this, and what already exists

- The Compact compiler already rejects undeclared witness→public flows (the "witness protection program", an abstract interpreter). We do not repeat that.
- What it does not check: whether a *declared* disclosure, hash, or auth check is actually safe. The docs list these pitfalls (security guide, "Private data" page, DUST sponsorship guide) but no tool enforces them.
- Competitors: `wbaxterh/compact-lint` (1 rule: unbound Merkle path; pattern-based, plain Node) and `smog123/Compact-Disclosure-Auditor` (README only). Neither does dataflow analysis or runs anything.

## Three layers

| Layer | What it does | Why it beats pattern matching |
|---|---|---|
| **L1 Parser** | Tree-sitter grammar for Compact 0.26 (from the published grammar), compiled to WASM. Produces a typed AST with source spans. | Real structure instead of regex. The grammar doubles as an ecosystem contribution (editor highlighting). |
| **L2 Static analysis** | Builds a per-circuit IR and call graph, then runs a provenance analysis. Each value carries: its source (witness / circuit argument / ledger / constant), its *entropy class* (Boolean, enum, small `Uint<n>` vs `Bytes<32>`), and whether it passed through `disclose`, a hash, or a commit. Rules are queries over this. | Catches `persistentHash(vote)` even through helper circuits and struct fields. |
| **L3 Dynamic attacks** | Loads the compiler's JS output (`managed/<c>/contract/index.js`), swaps in adversarial witness functions, and runs the circuits off-chain with `@midnight-ntwrk/compact-runtime`. | Turns a warning into a reproduced exploit. A finding with an exploit is not a false positive. |

L3 attack modes:
1. **Witness forgery:** for each `assert`-guarded impure circuit, try to pass with attacker witnesses (`ownPublicKey()` returning the victim's key, a Merkle path rebuilt from public ledger data, etc.).
2. **Non-interference diff:** hold public inputs fixed, vary one private witness value, and diff the public transcript in `call.proofData`. Any difference outside a declared `disclose` is reported, and *where* it differs shows what leaks.
3. **Brute-force guessability:** for low-entropy witnesses (Boolean, enum, `Uint<8>`, age-like ranges), enumerate the domain and check whether the public outputs uniquely identify the secret.
4. **Replay:** call a one-time action twice with the same secret and check whether the second call succeeds.

Limits (say these in the README): off-chain runs do not generate proofs or price transactions; fuzzing finds bugs but does not prove their absence.

## Rule set (v1)

| ID | Rule | Layer |
|---|---|---|
| CG001 | `ownPublicKey()` used for authorization | L2 + L3 forgery |
| CG002 | `persistentHash` / `transientHash` on a low-entropy value with no randomness | L2 + L3 brute force |
| CG003 | Commitment randomness reused without a round counter (linkable) | L2 |
| CG004 | `Set` / `Map` membership on witness-derived data (reveals the value; use `MerkleTree`) | L2 + L3 diff |
| CG005 | Merkle path from a witness not bound to the recomputed leaf | L2 + L3 forgery |
| CG006 | Hash without a domain separator | L2 |
| CG007 | `disclose()` wraps a whole struct/tuple when one field would do | L2 + L3 diff |
| CG008 | One-time action with no nullifier (replayable) | L2 + L3 replay |

## Shared interfaces (fixed up front so parallel work fits together)

`Finding` (all layers emit this; the CLI renders it as text, JSON, and SARIF):
```ts
type Finding = {
  rule: string;                 // "CG002"
  severity: "error" | "warning" | "review";
  file: string; line: number; column: number;
  circuit?: string;
  message: string;              // one sentence
  docUrl: string;               // the docs.midnight.network page the rule enforces
  evidence?: { kind: "static" | "exploit"; detail: string; repro?: string }; // repro = runnable test file path
};
```

AST: the tree-sitter node types are the contract between L1 and L2. L1 must publish `node-types.json` early (day 3), even if incomplete.

## Repo layout

```
compact-guard/
  grammar/            L1 tree-sitter-compact (+ WASM build)
  packages/analyzer/  L2 IR, provenance analysis, rules
  packages/attack/    L3 dynamic attack harness
  packages/cli/       CLI, SARIF, GitHub Action
  contracts/registry/ Compact contract: on-chain registry of scanned contract hashes (satisfies the hackathon's "Compact contract must compile" gate)
  corpus/             vulnerable/fixed contract pairs, one per rule, plus expected findings
```

## Who does what

Briefs are in `tasks/`. Each is self-contained. Paste it into the agent as-is.

| Brief | Owner | Depends on | Due |
|---|---|---|---|
| T1 Parser | Codex | none | Oct 8 |
| T2 Corpus | Grok | none | Oct 8 |
| T3 Static analyzer | Codex | T1 node types, T2 corpus | Oct 13 |
| T4 Attack harness | Codex (2nd session) or Grok | T2 corpus | Oct 13 |
| T5 CLI, SARIF, registry contract, CI | Grok | Finding schema | Oct 14 |
| Integration, review, real-world scan, demo | Claude + you | all | Oct 15–18 |

T1, T2, T4 and T5 can start today in parallel. Oct 19 is submission day; nothing new gets built that day.

## Submission checklist (from the rules)

- [ ] Public GitHub repo, `midnightntwrk` topic, Apache-2.0
- [ ] `contracts/registry` compiles with `compact compile`
- [ ] README: setup, architecture, Midnight integration, how judges test it (`npx compact-guard corpus/`)
- [ ] Test suite passes (corpus = test fixtures)
- [ ] Slide deck, demo video (show a real exploit reproduced)
- [ ] Wave 2 progress description

## Risks

- **Toolchain on Windows:** the Compact compiler needs WSL. Set up WSL before T2/T4 start.
- **Grammar drift:** the docs grammar is for language 0.26.0; the support matrix lists compiler 0.31.1. Test the parser against real repos, not just the spec.
- **Generated JS internals change between compiler versions:** L3 must only use the documented API (`new Contract(witnesses)`, `initialState`, `createCircuitContext`, `impureCircuits.*`, `ledger()`, `call.proofData`).
- **Scanning other teams' public repos** is fine for the demo, but report real bugs to the authors privately before showing them.
