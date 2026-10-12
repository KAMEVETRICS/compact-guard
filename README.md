# compact-guard

Static security checks for Midnight Compact contracts. The parser targets
language 0.26.0 and runs through `web-tree-sitter` and the committed WASM.
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
Findings are static evidence, not reproduced exploits. The attack harness,
product CLI/SARIF, registry contract and CI are separate project tasks.

The analyzer is a bounded heuristic analysis, not a proof of security. Review
coverage diagnostics alongside findings. Corpus parsing is tested; compilation
with a Compact compiler is still pending on this Windows host.
