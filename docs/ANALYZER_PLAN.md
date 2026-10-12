# Corpus and static analyzer

Specification: PLAN.md, CG001–CG008. No T2/T3 brief is present. Preserve the
published grammar schema and WASM. The public Finding shape stays exactly as
specified in PLAN.md; analysis diagnostics and per-circuit IR are separate.

## Deliverables

1. corpus/CG001…CG008/{vulnerable,fixed}.compact and corpus/manifest.json with
   `{version:1,cases:[{id,rule,vulnerable,fixed,description}]}`. Each pair must
   demonstrate the named rule and its repair. Extra findings are permitted but
   the target rule must appear only in the vulnerable member. Source examples
   must parse with the committed WASM. Compiler verification is a separate check.
2. packages/analyzer: TypeScript ESM library using web-tree-sitter only at runtime.
   Parse into owned IR objects so parser trees are disposed. Export analyzeSource,
   analyzeFile, analyzeDirectory and IR types. Results contain Finding[], explicit
   syntax/coverage diagnostics, per-circuit summaries, and a call graph.
3. Data flow tracks witness/argument/ledger/constant origins, type/domain size,
   aggregate fields, hash/commit/disclose transformations, and call provenance.
   Known helpers are interpreted with actual arguments, with bounded recursion;
   branches conservatively join, lexical bindings shadow correctly, and unknown
   calls retain provenance and generate coverage diagnostics.
4. Rules report evidence at the operation's source span. CG001/CG002/CG004 flag
   concrete risky data flows. CG003/CG005/CG006/CG007/CG008 are scoped heuristics
   where fresh randomness, binding, domain intent, or one-time intent cannot be
   proved; uncertain findings are `review`, never exploit claims. CG008 uses
   explicit one-time circuit configuration/annotation rather than guessing from
   function names. Absence of findings does not establish security.
5. Tests cover every corpus pair and adversarial variants: helpers/structs,
   aliases, branch joins, unused ownPublicKey, untrusted Bytes mistaken for
   guaranteed entropy, malformed source, recursive calls, shadowing, incorrect
   Merkle/nullifier checks, and import-resolution boundaries.

## Execution

- Implementation completed in the main session after the initial corpus/IR
  agents could not run because of usage limits.
- Main session owns configuration, corpus, IR, evaluation/rules, API and docs.
- Verify all tests plus grammar runtime regressions; independently review the
  integrated implementation, fix important findings, then commit only task files.

## Rulings

- Use PLAN.md for the two missing briefs unless the user supplies replacements.
- Keep this work in the existing checkout: parser is committed and the only
  pre-existing untracked files are PLAN.md and tasks/. Do not modify those files.
- Compiler execution may be unavailable on this Windows host (no WSL); report
  actual compilation status rather than equating parse success with compilation.
