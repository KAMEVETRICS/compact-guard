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
npm test -w contracts/registry              # compile, then run the unit tests
```

Tests run the compiled contract off-chain through `@midnight-ntwrk/compact-runtime`
0.16.0, following Midnight's
[JavaScript runtime guide](https://docs.midnight.network/guides/compact-javascript-runtime).
They cover admin and attester authorization, attestation contents, commitment
hiding and unlinkability, `isClean`, and the reveal flow, including rejected reveals.

Compiler output goes to `src/managed/` and is not committed.

Not yet done: deployment to Preprod and a DApp front end.
