# tree-sitter-compact

Compact **0.26.0** parser for compact-guard. The generated parser uses tree-sitter
ABI 15. `src/node-types.json` is the public AST contract. The committed
`tree-sitter-compact.wasm` loads in `web-tree-sitter` 0.25.10 on Windows without
native runtime dependencies. No Compact compiler is needed to parse a file.

## Use the committed WASM

From this directory, with Node.js 22 or later:

```sh
npm ci --omit=dev
node scripts/parse-all.mjs /path/to/contracts
npm run test:runtime
```

`parse-all.mjs` visits regular `.compact` files recursively, in deterministic
order. Symlinks are not followed. It prints every ERROR and MISSING node as
`absolute-path:line:column: kind`, followed by totals. Positions are **one-based**;
columns use web-tree-sitter's UTF-16 code units. Nested ERROR nodes count
separately. Exit codes: **0** = clean, **1** = syntax diagnostics, **2** = usage,
I/O/loading failure, or no input files. A missing punctuation token is reported
even though it is anonymous and zero-width.

```js
import { Parser, Language } from 'web-tree-sitter';

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load('/absolute/path/to/tree-sitter-compact.wasm'));
const tree = parser.parse('export sealed ledger owner: Bytes<32>;');
const declaration = tree.rootNode.namedChildren[0];
console.log(declaration.childForFieldName('name').text); // owner
console.log(declaration.childForFieldName('type').type); // bytes_type
tree.delete();
parser.delete();
```

For browser use, serve the grammar WASM and web-tree-sitter's runtime WASM;
configure `Parser.init({ locateFile })` if the runtime is not beside its JS file.

## AST interface

Use fields, not positional child indexes. Keywords and punctuation are anonymous
children, so `childForFieldName('pure')` works although `pure` is not a named node.
`export`, `sealed`, and `pure` are present only when written. An impure circuit
is a `circuit_declaration` without `pure`. Comments are named extra nodes.

| Nodes | Principal fields |
| --- | --- |
| `pragma` | `name`, `version` |
| `import_declaration` | `selection`, `name`, `args`, `prefix` |
| `ledger_declaration` | `export`, `sealed`, `name`, `type` |
| `circuit_declaration`, `witness_declaration` | `export`, `pure` (circuit only), `name`, `type_params`, `params`, `return_type`, `body` (circuit only) |
| `constructor_declaration` | `params`, `body` |
| `module_declaration`, `struct_declaration`, `enum_declaration`, `contract_declaration` | `export`, `name`, `body`; module/struct also `type_params` |
| `type_alias_declaration`, `implements_declaration` | `type`; alias also `export`, `new`, `name`, `type_params` |
| parameter and binding nodes | `name` (identifier or destructuring pattern), `type`; bindings also `value` |
| `type_reference` | `name`, `args`; includes user types and library types such as `MerkleTree` and `HistoricMerkleTree` |
| `uint_type`, `bytes_type`, `vector_type`, `opaque_type` | `size`/`range`, `size`, `size` + `type`, `name`, respectively |
| `call_expression` | `function`, `args` (`argument_list`) |
| `generic_function` | `name`, `args` (`generic_arguments`); appears under a call's `function` |
| `member_expression`, `index_expression` | `object` + `property`, `object` + `index` |
| `binary_expression`, `assignment_expression` | `left`, `operator`, `right` |
| `cast_expression` | `value`, `type` |
| `disclose_expression`, `assert_expression` | `value`; `condition` + `message`, respectively |
| `if_statement`, `conditional_expression` | `condition`, `consequence`, `alternative` |
| `for_statement` | `name`, `iterable` (range or expression), `body` |
| `arrow_function` | `params`, optional `return_type`, `body` (block or expression) |
| `map_expression`, `fold_expression` | `function`, repeated `argument`; fold also `initial` |

`tuple_literal` represents both tuples and vectors: `[1, 2]` has no syntactic
distinction until type resolution. `tuple_type` represents `[T, U]`, including
the empty return type `[]`. `Bytes[...]` has its own `bytes_literal` node.
`tuple_pattern` preserves omitted positions as anonymous commas; do not infer
destructuring positions from named children alone. List fields such as `arg`,
`param`, `element`, `member`, and `binding` are repeated; use
`childrenForFieldName`. The four abstract categories `expression`, `statement`,
`type`, and `pattern` are tree-sitter supertypes, not extra wrapper nodes.

See **all** fields and possible node types in `src/node-types.json`. Once the
initial schema is committed, every node/field rename must appear in `CHANGES.md`.

## Regenerate and test

Development requires the pinned CLI and a build-time C toolchain. Consumers of
the committed WASM need neither. Install all dependencies with `npm ci`.
If npm blocks the CLI's install script, explicitly approve `tree-sitter-cli`
with your npm version's script-approval command, then rebuild that package.

With Emscripten's `emcc` on PATH (or Docker/Podman available):

```sh
npx tree-sitter generate
npx tree-sitter build --wasm
npx tree-sitter test --wasm
npm run test:runtime
```

Bare `npx tree-sitter test` uses a **native development compiler** (for example
MSVC on Windows). Its corpus is the same as the WASM corpus. On this machine,
the native test DLL was compiled with Zig 0.14.1 and placed in tree-sitter's
native cache; bare `tree-sitter test` passes against that DLL.

### Optional Windows Zig build adapter

Windows Application Control blocked executables from the tested Emscripten
3.1.74 and 4.0.15 SDKs on the development machine. The shipped WASM was built by
`tree-sitter build --wasm` using the explicitly selected adapter below, backed
by **Zig 0.14.1** and the Emscripten **3.1.74 sysroot headers**. No security setting
was changed. These are build-time tools, not npm runtime dependencies.

```powershell
$env:COMPACT_ZIG = 'C:/path/to/zig.exe'
$env:COMPACT_EMSCRIPTEN_SYSROOT = 'C:/path/to/emsdk/upstream/emscripten/cache/sysroot'
$env:PATH = "$PWD/scripts/zig-emcc;$env:PATH"
npx tree-sitter build --wasm
npx tree-sitter test --wasm
npm run test:runtime
```

The adapter accepts only tree-sitter-cli 0.25.10's known invocation for this
scanner-free grammar and rejects unknown options. It uses Zig's Emscripten
target, position-independent code, imported memory, and an explicit
`tree_sitter_compact` export. It is not a general Emscripten replacement.

Acceptance revisions, results, source links, and parser limitations are recorded
in `KNOWN_ISSUES.md`.
