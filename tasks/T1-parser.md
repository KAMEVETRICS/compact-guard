# T1: Tree-sitter grammar for Compact (owner: Codex, due Oct 14)

## Context
compact-guard is a security analyzer for Midnight's Compact smart-contract language. You are building the parser everything else uses. See `../PLAN.md`.

## Task
Write `grammar/` as a tree-sitter grammar for Compact language version 0.26.0.

- Source of truth: https://docs.midnight.network/compact/reference/compact-grammar (raw markdown: append `.md` to the URL). Also read https://docs.midnight.network/compact/reference/compact-keywords.md.
- Cover at least: `pragma`, `import`/`include`, `export`, `ledger` declarations (incl. `sealed`), `witness`, `circuit` (pure and impure, generic parameters like `<10, Bytes<32>>`), `constructor`, `struct`, `enum`, `module`, `contract` declarations, all statements and expressions, type expressions (`Uint<64>`, `Uint<0..255>`, `Bytes<32>`, `Vector<n, T>`, `Field`, `Boolean`, `Opaque<"string">`, `MerkleTree<n, T>`, user types), casts (`as`), struct literals, tuple/vector literals, `disclose(...)`, `assert(...)`.
- Use named fields (`name:`, `type:`, `body:`, `args:`) on nodes so the analyzer can query them.
- Build to WASM (`tree-sitter build --wasm`) so it runs via `web-tree-sitter` with no native dependencies (must work on Windows).

## Deliverables
1. `grammar/grammar.js`, generated parser, `tree-sitter.wasm` build.
2. **By end of Oct 13: commit `src/node-types.json` even if incomplete.** The analyzer (T3) codes against it.
3. `grammar/test/corpus/*.txt` tree-sitter tests: at least one per construct above.
4. A smoke script `grammar/scripts/parse-all.mjs <dir>` that parses every `.compact` file under a directory and reports files with ERROR nodes.

## Acceptance
- `tree-sitter test` passes.
- `parse-all.mjs` reports zero ERROR nodes on: `midnightntwrk/example-bboard`, `midnightntwrk/example-private-party`, the contract examples listed at https://docs.midnight.network/examples/contracts.md, and `mashharuki/midnight-rps-sample-app`. List any file that fails and why.
- Note anything the docs grammar gets wrong versus what the real compiler (0.31.x) accepts.

## Out of scope
Highlighting queries are a nice-to-have, not required.
