# compact-guard registry contract

A Compact contract that records compact-guard scan results on Midnight.

For each scanned contract, identified by the hash of its source, it stores the
latest attestation: public finding counts (errors, warnings, reviews), the
compact-guard version used, the attester's public key, and a **commitment** to
the hash of the full SARIF report. Anyone can check a contract's status with
`isClean`. The full report stays off-chain and private; the attester can later
prove which report backed an attestation with `revealReport`.

## Circuits

| Circuit | Who | What it does |
| --- | --- | --- |
| constructor | deployer | Sets the admin to the hash of the deployer's secret key |
| `addAttester(pk)` / `removeAttester(pk)` | admin | Manages the set of authorized attester public keys |
| `attest(contractHash, reportHash, errors, warnings, reviews, toolVersion)` | attester | Records an attestation, replacing any earlier one for that contract |
| `revealReport(contractHash, reportHash)` | original attester | Publishes the report hash after proving it opens the stored commitment |
| `isClean(contractHash)` | anyone | True when the latest attestation has no error or warning findings |
| `attesterPublicKey(sk)` (pure) | attester, off-chain | Computes the public key the admin should register |

## Privacy and security design

- **Authentication proves knowledge of a secret.** The admin and attesters are
  identified by a domain-separated hash of their secret key, compared inside the
  circuit against public state. The secret key is a witness and never leaves the
  caller's machine. The contract never uses `ownPublicKey()`, whose value the
  prover chooses (compact-guard rule CG001).
- **The report is hidden in a commitment.** `persistentCommit(reportHash, opening)`
  with 32 fresh random bytes per attestation, supplied by the `reportOpening`
  witness. Two attestations of the same report produce unlinkable commitments
  (rule CG003). The attester keeps the opening in private state to reveal later.
- **Hashes are domain-separated** (`cg-registry:admin:`, `cg-registry:attester:`),
  so an admin key and an attester key derived from the same secret differ (rule CG006).
- **What is public by design:** contract hashes, finding counts, tool version and
  attester public keys. Scanning this contract with compact-guard gives 0 errors,
  0 warnings and 5 CG004 review notes, all on the contract hash used as a map key,
  which is intentionally public.

## Build and test

Requires the Compact compiler 0.31.1 (language 0.23). On Windows it runs in WSL;
install it with `scripts/setup-wsl.sh` at the repository root.

```sh
npm run compile -w contracts/registry       # compile without proving keys (fast)
npm run compile:keys -w contracts/registry  # also generate proving keys (~2 min), needed to deploy
npm test -w contracts/registry              # compile, type-check, run the simulator tests
```

Layout, following Midnight's example-bboard:

| File | Role |
| --- | --- |
| `src/registry.compact` | The contract |
| `src/witnesses.ts` | Witness implementations and the private state type (secret key, per-contract report openings), shared by the tests and the Preprod scripts |
| `src/test/registry-simulator.ts` | Runs the compiled contract off-chain through `@midnight-ntwrk/compact-runtime` 0.16.0, following the [JavaScript runtime guide](https://docs.midnight.network/guides/compact-javascript-runtime) |
| `src/test/registry.test.ts` | 10 tests: admin and attester authorization, attestation contents, commitment hiding and unlinkability, `isClean`, the reveal flow including rejected reveals, and domain separation between admin and attester keys |

Node.js 22.18 or later runs the TypeScript files directly. The `npm test` script
compiles without proving keys, which removes `src/managed/registry/keys`; run
`compile:keys` again before deploying or attesting.

Compiler output goes to `src/managed/` and is not committed.

## Deployment

Deployed to **Midnight Preprod** on 16 October 2026:

| | |
| --- | --- |
| Contract address | `e27624e00a5f3a1fcc64f1b370aaea3f5d028eb9fb4be92ff852dbb44be24538` |
| Deploy transaction | `00ab7c4bcd0cf6bd13ca528c7b162cc881d4324ac3044eb9fab5adf1067f65926d` |
| Block | 3,005,143 |

Search for the address on [Midnight Explorer](https://preprod.midnightexplorer.com/)
or [Subscan](https://midnight-preprod.subscan.io/). The record is in
`deployments/preprod.json`. `cd deploy && npm run verify:preprod` reads the
contract's public state back from the indexer.

## Deploy to Preprod

`deploy/deploy.mjs` follows Midnight's
[deploy guide](https://docs.midnight.network/guides/deploy-and-operate) with
Midnight.js 4.1.1 and wallet SDK 1.2.0. It needs:

1. **Proving keys:** `npm run compile:keys -w contracts/registry`.
2. **A local proof server** (Docker):
   `docker run -p 6300:6300 midnightntwrk/proof-server:8.1.3 midnight-proof-server -v`
3. **A Blockfrost project for Midnight Preprod.** Midnight's own Preprod endpoints
   shut down on 9 October 2026; Blockfrost now serves the Preprod indexer and RPC.
   Put the project ID in `deploy/.env.preprod`:
   `BLOCKFROST_PROJECT_ID=nightpreprod...`

Then:

```sh
cd contracts/registry/deploy
npm install
npm run deploy:preprod
```

On first run the script generates a wallet seed, the registry admin secret and
a private-state password, and saves them to `deploy/.env.preprod` without
printing them. It prints the wallet's unshielded address: request tNIGHT for it
at the [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/). The
script waits for the tokens, syncs the wallet, registers the NIGHT for DUST
generation to pay fees, deploys, and writes the address to
`deployments/preprod.json`.

A fresh Preprod wallet sync is slow (about 4 hours of awake time for us), so the
script saves sync state to `deploy/wallet-state.json` every five minutes and
resumes from it on the next run. If sync makes no progress for 10 minutes, or an
indexer error surfaces before the deploy step, it saves state and exits with
code 75; run it in a loop that restarts on 75. An error during the deploy step
itself exits with 1 and is not retried, so a second contract is never deployed
by accident.

Back up `deploy/.env.preprod` and the private-state store the script creates
in `deploy/`. They hold the admin secret and the contract's maintenance key.
`deploy/.gitignore` keeps everything except the scripts out of git.

The wallet, sync, restart and fee logic shared by the Preprod scripts lives in
`deploy/session.mjs`.

## Publishing attestations

`deploy/attest.mjs` scans contracts with compact-guard and records the results
in the deployed registry. It registers the wallet as an attester (the admin
secret also yields a separate, domain-separated attester key), then for each
target computes the source hash, runs the CLI for a SARIF report, and calls
`attest` with the finding counts and the report hash, using a fresh commitment
opening each time. Reports stay in `deploy/reports/` (gitignored). It then
reveals the registry's own report on-chain and publishes that SARIF in
`deployments/reports/registry.sarif`, so anyone can hash it and compare.
Attestations already on-chain with the same counts are skipped, so it is safe to
rerun. The public summary is `deployments/preprod-attestations.json`.

```sh
cd contracts/registry/deploy
node attest.mjs
```

## Web UI

`ui/` is a React app. The server in [`site/`](../../site/README.md) at the
repository root serves it with a small API that reads the live registry from the
Preprod indexer and runs compact-guard on submitted source; the Blockfrost token
stays in the server. The same server runs locally and on a host such as Render;
it is live at https://compact-guard.onrender.com.

Paste or drop a `.compact` file to see its findings and whether its source hash
is attested on-chain; the attestation table lists every contract in the
registry, its counts, and whether its report is private or revealed.
