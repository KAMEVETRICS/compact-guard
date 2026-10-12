# Validation and known issues

## Reference versions

Requested references:
- [Compact grammar](https://docs.midnight.network/compact/reference/compact-grammar.md)
- [Compact keywords](https://docs.midnight.network/compact/reference/compact-keywords.md)

Retrieved 2026-10-12. The live grammar page now identifies itself as **0.27.0**.
The exact **0.26.0** grammar was checked against the official source at
[compiler tag compactc-v0.34.0](https://github.com/LFDT-Minokawa/compact/blob/1f671fc27818df2b2676b3a97f85b2b821756243/doc/compact-grammar.mdx),
commit `1f671fc27818df2b2676b3a97f85b2b821756243`.
Its difference from the retrieved main-branch grammar is only the version label.
Compiler and language version numbers are different: the task's compiler
0.31.x statement is not used as a language-version pin.

The reference includes type aliases, `new type`, `contract implements`,
`Bytes[...]`, `emit(...)`, `map`, `fold`, `slice`, destructuring, and arrow
functions; these are covered in addition to the explicitly listed constructs.

## Acceptance results — 2026-10-12

Final checks: `tree-sitter test` **14/14**, `tree-sitter test --wasm` **14/14**,
and `node --test test/runtime.test.mjs` **11/11**. Independent review led to
regressions and fixes for Unicode identifiers, malformed string escapes,
unescaped string newlines, and CR line continuations.

Artifact SHA-256:
- `src/node-types.json`: `2a56adbf9c35612c39cc2e291f21b268e10b84dd3f022acd581e843723e31125`
- `tree-sitter-compact.wasm`: `82dbe823e93b1dfa5b3b479717dc5a1446c28fb6a2b62f4a8d1872b49f5b2c1e`

**No failing acceptance files.** Every file listed below has zero ERROR and zero
MISSING nodes using the committed WASM and `web-tree-sitter` 0.25.10.

Repositories were shallow-cloned into a temporary directory outside this repo.
No generated contract JS or compiler output was substituted for source input.

| Source | Revision | Files | ERROR | MISSING |
| --- | --- | ---: | ---: | ---: |
| [example-bboard](https://github.com/midnightntwrk/example-bboard) | `f9df09ac83c4adf66a1177d2fcec3b3596f038e6` | 1 | 0 | 0 |
| [example-private-party](https://github.com/midnightntwrk/example-private-party) | `62ca6e7e35f9df725f7f77d280d294ac37f2aca7` | 1 | 0 | 0 |
| [midnight-rps-sample-app](https://github.com/mashharuki/midnight-rps-sample-app) | `195207f8bbf7e3e808280e7fed81cb6f7a2f1a62` | 1 | 0 | 0 |
| [Documentation contract examples](https://docs.midnight.network/examples/contracts.md) | retrieved 2026-10-12 | 6 | 0 | 0 |
| [example-battleship](https://github.com/midnightntwrk/example-battleship) (linked by the Battleship page) | `5d02f55f8371cb1a3f586f98fd30498025577f32` | 1 | 0 | 0 |

Files:
- `example-bboard/contract/src/bboard.compact`
- `example-private-party/contract/private-party.compact`: this repository ignores
  the source file and instructs readers to create it from its README. The exact
  README code block was extracted unchanged into the scratch clone. A clean
  clone alone contains **zero** `.compact` files; parse-all correctly returns 2
  for that empty case instead of reporting a passing acceptance run.
- `midnight-rps-sample-app/pkgs/contract/src/rps.compact`
- Documentation pages `calculator`, `token-transfers`, `private-guest-list`,
  `election`, `private-reserve-auction`, `battleship-simple`: each contains one
  complete contract code block, extracted unchanged to `<page>-1.compact`.
- `example-battleship/contract/battleship.compact`

The parse-all summaries, with the temporary path prefix omitted, are:

```text
example-bboard: 1 files, 0 ERROR, 0 MISSING, 0 files with errors
example-private-party: 1 files, 0 ERROR, 0 MISSING, 0 files with errors
midnight-rps-sample-app: 1 files, 0 ERROR, 0 MISSING, 0 files with errors
docs-contracts: 6 files, 0 ERROR, 0 MISSING, 0 files with errors
example-battleship: 1 files, 0 ERROR, 0 MISSING, 0 files with errors
```

No acceptance source needed a syntax extension beyond the 0.26 reference.
Their older language pragmas are parsed as written, not used to disable newer
syntax. This is syntax validation only; no claim of compiler acceptance or
contract correctness is made.

## Known parser limits and open questions

- The grammar deliberately accepts an expression superset: standalone arrow
  functions and generic function references, arbitrary expressions as callees,
  chained comparisons, and some operator nesting the reference restricts.
  All valid reference forms are represented, but absence of ERROR is not proof
  that the compiler accepts the program. A future strict-syntax mode could
  narrow hidden productions without renaming public nodes or fields.
- Identifier Unicode escapes retain their raw source spelling. Decoded
  identifier validity (including escaped keywords and out-of-range codepoints)
  is left to the compiler. String Unicode codepoint ranges, field-literal
  bounds, type sizes, and other semantic constraints are also not evaluated.
- `[a, b]` cannot be classified syntactically as tuple versus vector; both are
  `tuple_literal`. `MerkleTree` and `HistoricMerkleTree` are library type names,
  so they use `type_reference`, not separate built-in nodes.
- The Windows host blocks the tested stock Emscripten executables. The required
  `tree-sitter build --wasm` succeeds through the documented opt-in Zig adapter.
  Consumers load the shipped WASM with no native dependencies. Rebuilding with
  stock Emscripten on this host remains environment-blocked.

There are no unresolved valid-input grammar questions after reference comparison
and review. Whether to enforce exact compiler rejection of the expression
superset is a future strictness decision, not a requirement for AST consumers.
