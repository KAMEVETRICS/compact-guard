# compact-guard registry site

The web UI (`contracts/registry/ui`) plus a read-only API over the registry
contract on Midnight Preprod, in one small Node server (`server.mjs`).
Live at **https://compact-guard.onrender.com** (Render).

| Route | What it does |
| --- | --- |
| `GET /api/registry` | Every attestation in the registry, read from the Preprod indexer and labelled from `contracts/registry/deployments/preprod-attestations.json` |
| `POST /api/scan` | Runs compact-guard on the posted Compact source (256 KB max, 20 scans per client per minute) and looks up that exact source's attestation |
| `GET /deployments/…` | The public deployment records, including the revealed `reports/registry.sarif` |
| `GET /healthz` | Liveness check |

The Blockfrost token stays in the server. Registry reads are cached for 15
seconds and shared between concurrent requests, so the indexer sees at most one
read per 15 seconds whatever the traffic.

`contract/index.js` is the Compact compiler's JavaScript output for the
registry, committed because hosts cannot run the compiler. After changing
`registry.compact`: `npm run compile -w contracts/registry && npm run sync-contract --prefix site`.

## Run locally

```sh
npm ci && npm run build -w packages/analyzer
npm ci --prefix contracts/registry/ui && npm run build --prefix contracts/registry/ui
npm ci --prefix site
node site/server.mjs          # http://localhost:5180
```

Locally the token is read from `contracts/registry/deploy/.env.preprod` when
`BLOCKFROST_PROJECT_ID` is not set in the environment.

## Host it (Render, or any Node host)

| Setting | Value |
| --- | --- |
| Root directory | repository root |
| Runtime | Node (`.node-version` pins 22) |
| Build command | `npm ci && npm run build -w packages/analyzer && npm ci --prefix contracts/registry/ui && npm run build --prefix contracts/registry/ui && npm ci --prefix site` |
| Start command | `node site/server.mjs` |
| Environment | `BLOCKFROST_PROJECT_ID` = a Blockfrost **Midnight Preprod** project ID |

The server listens on `PORT` (set by the host) on all interfaces, and on
127.0.0.1:5180 when `PORT` is not set.
