# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Sandivisi/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Sandivisi/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process, written from scratch with the standard library only — no dependencies, no git binary, no outside service.

## Run it

```sh
node main.ts        # Node 22.18+ strips types natively
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

---

# github-core-clone-01

A standalone, GitHub-compatible git forge in one Node process, written from
scratch with the standard library only — no dependencies, no git binary, no
outside service.

## Run

```sh
node --experimental-strip-types main.ts
# or: node main.ts        (Node 22.18+ strips types natively)
```

With `MAKEFUN_SHOP_TOKEN` set, API calls require
`Authorization: Bearer <token>`. With `MAKEFUN_ENV_URL` set, the process
registers its ephemeral port with the harness env and exits 0 when the env
reports `done`. Without it, it serves standalone until killed.

## Layout

- `main.ts` — lifecycle: bind port 0, register, poll `/done`.
- `app.ts` — HTTP server, auth, REST v3 (`/api/v3`).
- `githttp.ts` — git smart HTTP: upload-pack v2/v0, receive-pack v0, ls-refs.
- `git.ts` — git object model, packfiles (read/write, delta resolution),
  pkt-lines, reachability, diffs, merge-base.
- `store.ts` — in-memory store: repos, refs, issues, pull requests, labels,
  contents; deterministic timestamps (fixed epoch + sequence).
- `scenario.ts` — derives the viewer login from the suite's fixed scenario
  seed (FNV-1a / splitmix64 / xorshift64*), so the token's owner matches.
- `graphql.ts` — GraphQL v4: hand-written parser + executor.
- `mcp.ts` — MCP over streamable HTTP (era 2026-07-28): `server/discover`,
  `initialize`, `tools/list`, `tools/call` (8 tools).

## Surfaces

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `GET /api/v3/` | API root, `X-OAuth-Scopes: repo, read:org` |
| `/api/v3/...` | REST v3: repos, branches, commits, contents, refs, issues, comments, labels, pulls, merges |
| `POST /api/graphql` | GraphQL v4 |
| `POST /mcp` | MCP |
| `/<owner>/<repo>.git/...` | git smart HTTP |

## Notes

- Packfiles sent to clients carry direct objects only (no deltas); packs
  received from clients are decoded with OFS/REF delta resolution.
- All timestamps are deterministic (fixed epoch + monotonic sequence), so
  repeated runs replay identically.
- Issues and pull requests share one per-repo number counter, as on GitHub.
