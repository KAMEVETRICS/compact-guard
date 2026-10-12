# Compact parser implementation plan

Specification: the task brief and ../PLAN.md. Work is confined to grammar/.

The parser is a tree-sitter grammar generated to C and compiled with
`tree-sitter build --wasm`. Consumers load the committed WASM through
web-tree-sitter. No native runtime package is required. Named nodes and fields
in src/node-types.json are the public interface; after publication, renames
must be recorded in CHANGES.md.

1. Capture reference syntax and create construct-focused corpus fixtures.
2. Implement declarations, types, patterns, statements and expression precedence.
   Use name/type/body/params/args/return_type fields consistently. Tuple/vector
   literals share tuple_literal because their syntax is identical.
3. Generate parser and node schema, build WASM, verify corpus and runtime fields.
4. Parse all .compact files from the three requested repositories and all six
   linked documentation examples in a temporary directory. Record exact revisions,
   diagnostics, compatibility extensions and open questions in KNOWN_ISSUES.md.
5. Verify schema stability and deliver a commit containing generated artifacts.

Review focus: angle brackets versus comparisons; expression precedence;
destructuring versus literals; keyword rejection; ERROR and zero-width MISSING
diagnostics, including Unicode source locations and empty input directories.
