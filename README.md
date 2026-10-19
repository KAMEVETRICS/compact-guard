# compact-guard

Static security checks for Midnight Compact contracts. The parser follows the
published Compact grammar (0.26.0 and later) and runs through `web-tree-sitter`
and the committed WASM. Contracts in this repo target language 0.23, the version
compiler 0.31.1 supports (the compiler pinned in Midnight's compatibility matrix).
The analyzer implements PLAN.md's CG001–CG008 with provenance through local
helpers, aggregate fields, casts, branches, hashes, commitments and disclosures.

## Run locally

Node.js 22 or newer is recommended. From this directory:

```sh
npm ci
npm test
```

This installs only JavaScript/WASM runtime dependencies and the TypeScript
compiler. No native Node addon, Compact compiler, WSL, or tree-sitter compiler
is needed to consume the parser or run analyzer tests on Windows.

## Command line

```sh
npm run build -w packages/analyzer -w packages/cli
npx compact-guard corpus                      # text report
npx compact-guard --format sarif --output compact-guard.sarif contracts
```

Exit code 1 means a finding at or above `--fail-on` (default `error`). SARIF
output works with GitHub code scanning; `action.yml` wraps it as a GitHub
Action. See [the CLI README](packages/cli/README.md).

## Library

After `npm run build`, use the library from an ESM script:

```js
import { analyzeDirectory } from '@compact-guard/analyzer';

const result = await analyzeDirectory('corpus');
console.log(JSON.stringify({
  findings: result.findings,
  diagnostics: result.diagnostics,
}, null, 2));
```

See [the analyzer API and rule boundaries](packages/analyzer/README.md),
[corpus assumptions](corpus/README.md), and [parser build instructions](grammar/README.md).
Findings are static evidence, not reproduced exploits.

## Registry contract

[contracts/registry](contracts/registry/README.md) is a Compact contract that
records scan attestations on Midnight: public finding counts per contract, with
the full report kept private behind a commitment that the attester can reveal.
It is deployed on Midnight Preprod and holds real attestations; its React UI
scans a pasted contract and shows whether that source is attested on-chain.
[site/](site/README.md) serves the UI and its API, locally or on a Node host.

The analyzer is a bounded heuristic analysis, not a proof of security. Review
coverage diagnostics alongside findings. All corpus contracts compile with
compiler 0.31.1 (`scripts/compile-corpus.sh`, run inside WSL on Windows).

## License

Apache License 2.0. See [LICENSE](LICENSE).
