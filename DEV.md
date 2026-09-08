# Engram Vault Sync: Developer Guide

Implementation and contributor notes for Engram Vault Sync, the Obsidian plugin that syncs your vault with an [Engram](https://github.com/engram-app/engram) server. For the end-user overview, see [README.md](README.md).

## Architecture

The plugin is a thin sync client. It watches the vault for changes, pushes them to an Engram server over REST, and pulls remote changes on startup, on a timer, and in real time over a WebSocket channel. It does **no** AI work itself. No markdown parsing, no embedding generation, no vector search. All of that lives on the Engram backend.

```
┌──────────┐     ┌──────────────────────────┐     ┌───────────────────┐
│ Obsidian │ ⇄  │      Engram server       │ ⇄  │  AI client (MCP)  │
│  vault   │     │  notes + vector search   │     │  Claude, Cursor…  │
└──────────┘     └──────────────────────────┘     └───────────────────┘
     ↑                       ↑
 This repo            engram-app/engram
```

The Engram backend is an Elixir/Phoenix app that stores notes in PostgreSQL, generates embeddings via Voyage AI or a local Ollama, serves semantic search through Qdrant, and speaks MCP. Setup, deployment, and the full REST contract live in [engram-app/engram](https://github.com/engram-app/engram).

### What this plugin is responsible for

1. **Watch vault events**: `app.vault.on("create" | "modify" | "delete" | "rename")`.
2. **Push changes**: `POST /notes`, `POST /attachments`, `DELETE /notes/:path`.
3. **Pull changes**: `GET /notes/changes` on startup, on a timer, and via WebSocket push.
4. **Apply remote changes locally**: files created or edited via MCP or other devices.
5. **Settings UI**: Engram URL, auth, ignore patterns, conflict resolution.

### What it explicitly is not responsible for

- Parsing markdown or chunking text (Engram does this).
- Generating embeddings (Engram does this via Voyage or Ollama).
- Talking to Qdrant (Engram does this).
- Indexing for search (Engram does this; the plugin only calls `POST /search`).
- Auth or user management (Engram does this).

Internals beyond this overview (class map, sync algorithm, type definitions) are documented in [`docs/internals.md`](docs/internals.md). CDP and Obsidian remote debugging are covered in [`docs/engram-ops.md`](docs/engram-ops.md).

## Repo layout

```
src/
  main.ts              Plugin entry: registers commands, views, ribbon, status bar
  sync.ts              SyncEngine: push/pull/merge orchestration
  api.ts               REST client for the Engram backend
  channel.ts           Phoenix WebSocket channel for real-time pushes
  auth.ts              ApiKeyAuth and OAuthAuth providers
  diff.ts              Hunk-based diff utilities
  three-way-merge.ts   diff-match-patch-based 3-way merge
  conflict-modal.ts    Interactive conflict resolution UI
  search-modal.ts      Semantic search modal
  search-view.ts       Persistent search sidebar
  sync-center-render.ts  Sync Center dashboard rendering
  settings.ts + tabs/  Settings UI (tabs/: account, sync-center, self-hosted, advanced, about, start)
  offline-queue.ts     Persistent queue for offline edits
  remote-log.ts        Opt-in lifecycle logging back to the user's own Engram
  …
tests/                 Unit tests (Bun + custom Obsidian mocks); run `bun test` for the count
docs/                  Internals, ops, API audit, submission notes
```

## Toolchain

- **Runtime/package manager:** [Bun](https://bun.sh). Use `bun`, not `npm`.
- **Bundler:** esbuild (`esbuild.config.mjs`).
- **Type check:** TypeScript (`tsc -noEmit`); runs as part of `bun run build`.
- **Lint/format:** Biome (`bun run lint`, `bun run format`) plus an Obsidian-specific ESLint pass (`bun run lint:obsidian`).
- **Styles:** Stylelint over `styles.css`.
- **Git hooks:** Lefthook (auto-installed via `bun run prepare`).

## Building

```bash
bun install
bun run build         # production bundle → main.js
bun run dev           # esbuild watch mode
```

## Testing

**Tests are the spec. If a test fails, fix the implementation, not the test.**

```bash
bun test              # full unit-test suite
bun test --verbose
bun test --coverage   # check the report for the live coverage number (~89% funcs / ~97% lines)
```

### Test layout

Don't hardcode counts; run `bun test` for the live total and `ls tests/*.test.ts`
for the file list. The suite spans the SyncEngine (ignore/modify/delete/rename,
pull, seq-replay catch-up, WebSocket, echo suppression, 3-way merge, state export/import),
manifest reconciliation, the API client, the offline queue, auth (ApiKey + OAuth
device flow), the Phoenix channel, diff/merge, remote logging, plan/limit state,
plus compliance tests (manifest, license, README disclosures, source/styles
hygiene, command IDs).

### Test config

- `bunfig.toml` preloads `tests/preload.ts`, which wires `tests/__mocks__/obsidian.ts`.
- The Obsidian mock provides minimal `TFile`, `Plugin`, `Modal`, `requestUrl`, etc.
- Coverage thresholds: 40% minimum across branches, functions, lines, statements.

### Untested files

UI-heavy modules are exercised end-to-end from the backend repo: `settings.ts`, `conflict-modal.ts`, `search-modal.ts`, `search-view.ts`, `main.ts`.

## Deploying to your local vault

```bash
bun run build
cp main.js manifest.json styles.css \
  "/path/to/Your Vault/.obsidian/plugins/engram-vault-sync/"
```

Then restart Obsidian, or toggle the plugin off and on, to pick up the new build.

## Release process

Releases are automated via GitHub Actions. Tags use `x.y.z` format (no `v` prefix) for BRAT and Obsidian compatibility.

### Workflows

| Workflow | Trigger | Effect |
|----------|---------|--------|
| `ci.yml` | Push to any branch | Build + lint + test, plus backend E2E trigger |
| `version-check.yml` | PR to `main` | Enforces `manifest.json`/`package.json`/`versions.json` agreement, but only when `manifest.json` is deliberately bumped; otherwise passes without requiring a bump |
| `pr-build.yml` | Each push to a PR | Publishes a prerelease tagged `X.Y.Z-pr.<num>.<sha>` with build assets, the frozen version BRAT installs for reviewing that PR |
| `release-please.yml` | Push to `main` | Keeps a standing "Release PR" up to date with the generated CHANGELOG; on merge, cuts the version, creates the release + bare `X.Y.Z` tag, then (gated on its own `release_created` output) builds, attests, and uploads `main.js`/`manifest.json`/`styles.css` to that release, updates `versions.json`, and posts the Discord announce |

A rolling **beta** channel (from `main`, tagged `X.Y.Z-beta.N`, installed via BRAT's "add beta plugin") is part of this same release-channels initiative; its workflow lands in a separate commit.

### Cutting a release

Do **not** bump `manifest.json` by hand in feature PRs: versions are auto-derived for the per-PR and beta channels. The only manual step is editing release notes:

1. **Land feature PRs as usual.** Each push auto-publishes a per-PR prerelease via `pr-build.yml` (see above); no version bump required.
2. **Edit the release notes.** `release-please.yml` maintains a Release PR with a generated CHANGELOG; edit that PR's description to adjust the notes before cutting.
3. **Merge the release-please PR.** This bumps `manifest.json` and `package.json`, cuts the version, and publishes the final GitHub release directly (`main.js`, `manifest.json`, and `styles.css` attached, `versions.json` updated, and the Discord announce posted), all from the same `release-please.yml` run. There is no separate tag-triggered workflow.

### Testing a specific PR

Contributors can test a feature PR's frozen build without waiting for merge or stable release. Each PR generates a prerelease tag (`X.Y.Z-pr.<num>.<sha>`) on every push. To install it:

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) if you haven't already.
2. In Obsidian, go to **Settings → BRAT** → **Add beta plugin**.
3. Enter `engram-app/Engram-obsidian` as the repo.
4. Select the PR's frozen version from the version list (format: `X.Y.Z-pr.<num>.<sha>`).

This lets you verify the fix before it merges, and revert back to stable by reinstalling the official version.

### Branch protection

`main` requires two passing checks: `build-and-test` and `version-check / version-check`.

## Settings reference

The plugin's settings are stored in `<vault>/.obsidian/plugins/engram-vault-sync/data.json` and shaped by `EngramSyncSettings` in `src/types.ts`.

| Key | Default | Purpose |
|-----|---------|---------|
| `apiUrl` | `""` | Engram base URL. |
| `apiKey` | `""` | Static API key (falls back when OAuth isn't configured). |
| `refreshToken` | unset | OAuth refresh token. Takes precedence over `apiKey`. |
| `userEmail` | unset | Display only; populated after OAuth sign-in. |
| `authMethod` | `null` | `"oauth"`, `"api_key"`, or `null`. |
| `vaultId` | `null` | Server-assigned vault ID, populated on first registration. |
| `clientId` | `""` | SHA-256 of the vault path. Stable across restarts, used for idempotent registration. |
| `ignorePatterns` | `""` | One pattern per line. Trailing `/` = folder match anywhere in the path; otherwise exact filename or path suffix. `.obsidian/`, `.trash/`, `.git/` are always ignored. |
| `debounceMs` | `2000` | Delay between the last `modify` event and the push. |
| `conflictResolution` | `"auto"` | `"auto"` writes a conflict copy; `"modal"` opens the interactive diff. |
| `conflictViewMode` | `"unified"` | `"unified"` or `"side-by-side"` diff layout. |
| `remoteLoggingEnabled` | `false` | Opt-in lifecycle logging to the user's own Engram server. |

## Commands

All registered in `src/main.ts`, exposed in the palette under `Engram:`.

| ID | Name | Effect |
|----|------|--------|
| `sync-now` | Sync now | Push pending, then pull. |
| `push-all` | Push entire vault | Force-push every syncable file. |
| `pull-all` | Pull all from server (force overwrite) | Download everything; overwrite local. Confirmation prompt. |
| `check-sync` | Check sync status | Compare local and remote state; report drift. |
| `show-sync-log` | Show sync log | In-app sync log modal. |
| `open-sync-center` | Open sync center | Sync dashboard view. |
| `search` | Semantic search | Search modal. |
| `open-search-sidebar` | Open search sidebar | Persistent sidebar view. |

Two ribbon icons: 🔍 (search) and 🔄 (Sync Center). One status-bar item shows live sync state.

## Supported file types

Defined in `src/sync.ts`:

- `TEXT_EXTENSIONS`: `md`, `canvas` (canvas is JSON text).
- `BINARY_EXTENSIONS`: `png`, `jpg`, `jpeg`, `gif`, `bmp`, `svg`, `webp`, `pdf`, `mp3`, `wav`, `ogg`, `m4a`, `flac`, `mp4`, `mov`, `webm`, `zip`.

Anything outside both sets is silently ignored by `isSyncable()`.

## Contributing

- **Everything goes through a PR: no exceptions, including doc-only changes.** The old "docs can land on `main` directly" carve-out is rescinded (it drifted into code commits and bypassed the test gate). `main` is protected with `enforce_admins=true`; the release pipeline only fires on PR merge, so direct pushes break the deploy. See `CLAUDE.md` → Git Workflow.
- Code changes: CI must pass and the version must be bumped before merge.
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`; subject ≤50 chars.
- Tests are the spec. Add or update tests alongside code changes; never modify tests to mask a regression.

## Multi-repo notes

This plugin is one half of the Engram project. For cross-repo work (API changes, plugin↔backend debugging, deploys), the workspace pattern lives at `../engram-workspace/`. See `../engram-workspace/docs/workspace-pattern.md` for when to use the workspace vs this repo standalone.

## License

[MIT](LICENSE)
