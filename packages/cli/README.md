# compact-guard CLI

Command-line front end for `@compact-guard/analyzer`. Scans Midnight Compact
contracts and reports findings as text, JSON, or SARIF 2.1.0.

## Run

From a clone of the repository:

```sh
npm ci
npm run build -w packages/analyzer -w packages/cli
npx compact-guard corpus
```

`npx compact-guard` resolves to this workspace's binary after `npm ci`. You can
also call it directly: `node packages/cli/bin/compact-guard.js corpus`.
The analyzer loads `grammar/tree-sitter-compact.wasm` by its path inside this
repository, so run the CLI from a clone; it is not published to npm.

## Usage

```
compact-guard [options] [paths...]
```

Paths are `.compact` files or directories (searched recursively; `.git`,
`node_modules`, `managed` and `dist` are skipped). No paths means the current
directory. A path with no `.compact` files is a usage error.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--format text\|json\|sarif` | `text` | Output format |
| `--output <file>` | stdout | Write the report to a file |
| `--rules CG001,CG004` | all | Only run these rules (case-insensitive) |
| `--one-time <circuit>` | none | Treat a circuit as one-time for CG008 (repeatable). Same as a `// compact-guard: one-time <circuit>` comment in the source |
| `--fail-on error\|warning\|review\|none` | `error` | Lowest severity that makes the run fail |
| `--quiet` | off | Text: findings only, no summary line |
| `--verbose` | off | Text: also print analyzer diagnostics |
| `--version`, `--help` | | |

Exit codes: **0** no finding at or above `--fail-on`; **1** at least one;
**2** usage error or internal failure. Analyzer diagnostics (coverage notes such
as unsupported library calls) never change the exit code.

Report paths are relative to the current directory, with forward slashes.

### Text

```
corpus/CG001/vulnerable.compact:8:3  warning  CG001  Authorization depends on ownPublicKey(), whose witness can be forged.  [change]
1 finding (0 error, 1 warning, 0 review) in 2 files; 0 diagnostics
```

### JSON

`{ version, files: [{ file, findings, diagnostics }], summary: { error, warning, review, diagnostics, files } }`.
Findings use the `Finding` shape from PLAN.md.

### SARIF

One run with all eight rules in `tool.driver.rules`, each with its own Midnight
docs link as `helpUri`. Mapping:

| compact-guard | SARIF |
| --- | --- |
| severity `error` / `warning` / `review` | `level` `error` / `warning` / `note` |
| finding file | `artifactLocation` relative to `SRCROOT` (the working directory); files outside it use absolute `file://` URIs |
| line / column (one-based, UTF-16) | `region.startLine` / `startColumn`, with `columnKind: utf16CodeUnits` |
| `evidence.detail` | appended to `message.text` after `Evidence:` |
| `circuit`, `evidence.kind`, `severity` | `result.properties` |
| analyzer diagnostics | `invocations[0].toolExecutionNotifications` (never `results`) |

Each result has `partialFingerprints["compactGuardFindingHash/v1"]`, a hash of
rule, relative path, circuit and message, so GitHub code scanning can track a
finding across commits when line numbers move.

## GitHub Action

`action.yml` at the repository root runs the CLI and writes SARIF:

```yaml
- id: scan
  uses: <owner>/compact-guard@<ref>
  with:
    paths: contracts          # space-separated
    fail-on: warning          # error | warning | review | none
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: ${{ steps.scan.outputs.sarif }}
    category: compact-guard
```

The job needs `security-events: write`. See
`.github/workflows/compact-guard.yml` for a working example on this repo's corpus.

## Tests

`npm test -w packages/cli` builds and runs the suite. It validates SARIF output
against the official SARIF 2.1.0 JSON schema, vendored at
`test/fixtures/sarif-schema-2.1.0.json` from
https://github.com/oasis-tcs/sarif-spec (no network access at test time).
