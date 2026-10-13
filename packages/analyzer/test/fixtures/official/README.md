# Official Compact regression fixtures

Retrieved 2026-10-13. Tests read only these local files; no network or compiler
is invoked by npm test. Each documentation fixture is extracted from the first
contract code block of its linked Markdown page. Bboard is pinned to the Git
commit below. Documentation pages expose no Git revision, so their exact fetched
Markdown snapshots are identified by SHA-256 content revisions. sources.json
also records the normalized LF SHA-256 of every vendored contract.

| Fixture and source URL | Upstream revision | Compact 0.31.1 --skip-zk |
| --- | --- | --- |
| [example-bboard.compact](https://github.com/midnightntwrk/example-bboard/blob/f9df09ac83c4adf66a1177d2fcec3b3596f038e6/contract/src/bboard.compact) | `f9df09ac83c4adf66a1177d2fcec3b3596f038e6` | pass |
| [election.compact](https://docs.midnight.network/examples/contracts/election.md) | `sha256:f121dd5df554e24ae6a3b5b954a298ebbb35c90023a6404710b1ff8d84e26b73` | pass |
| [private-guest-list.compact](https://docs.midnight.network/examples/contracts/private-guest-list.md) | `sha256:abc606f14fb1705ac011827da68616052de911ee1853e4acf556538f3f8fb131` | pass |
| [private-reserve-auction.compact](https://docs.midnight.network/examples/contracts/private-reserve-auction.md) | `sha256:d512100f1e5892ffe1020cae0e46fb952218918f0ab4a69b4fd9f4ade53998ff` | pass |
| [calculator.compact](https://docs.midnight.network/examples/contracts/calculator.md) | `sha256:09fd69ce6d76527a8416f27a7b477f768233264f921f2a896710163110d2a1fc` | pass |
| [token-transfers.compact](https://docs.midnight.network/examples/contracts/token-transfers.md) | `sha256:64078654f971e7e61f639fd11445ce67ca1e8d49b38b58a606ddc160a3a1535c` | pass |
| [battleship-simple.compact](https://docs.midnight.network/examples/contracts/battleship-simple.md) | `sha256:70a8f51e30d186bc45158848a442dd7b9ea5f56edb4c5fd5728f685d5145e420` | pass |

## Compatibility changes

Every fixture starts with `pragma language_version 0.23;`. The existing pragma
was moved to line 1 for bboard and battleship-simple; token-transfers had no
pragma, so one was added. Other existing pragmas were already 0.23. Comments,
including bboard's copyright and Apache notice, are retained. Its upstream
license is included in LICENSE-example-bboard.

Calculator requires one additional compiler compatibility fix: line 55 changes
`return quo;` to `return disclose(quo);`. The untouched official block fails
0.31.1 with "potential witness-value disclosure must be declared but is not"
because divide returns a value from divMod. This explicit disclosure makes the
example compile and creates no analyzer finding. No other contract logic was
changed; existing blank lines are retained for stable diagnostic locations.

## Compile results

All seven files passed on 2026-10-13 using compiler **0.31.1**, language **0.23**,
and `compact compile --skip-zk` in WSL Ubuntu. Generated output was written
under `/tmp/compact-official.xB8Jcg`, outside the repository. Proof generation
and execution are not part of this check.

Reproduce from the repository root in PowerShell:

```powershell
wsl -d Ubuntu -- bash -lc 'cd /mnt/c/Users/THIS-PC/Documents/backhat/compact-guard && bash scripts/compile-official.sh'
```

The script sets the compiler PATH and allocates a fresh /tmp directory. Exact
expected reviews are listed in ../../official.test.mjs; all fixtures must have
zero findings of severity warning or error. Coverage diagnostics are reported
separately and do not constitute a clean semantic-analysis claim.
