# CLAUDE.md / AGENTS.md

> `AGENTS.md` is a symlink to this file — one source of truth for both Claude Code and other agent runtimes, so they can never drift apart. Edit `CLAUDE.md`.

Obsidian plugin for bidirectional sync with Engram, distributed as "Engram Vault Sync" (plugin id `engram-vault-sync`). One half of the Engram project — backend repo is `engram-app/engram`, plugin repo is `engram-app/Engram-obsidian` (local dir name stayed `engram-obsidian-sync` after rename).

## Life OS
project: engram-obsidian
goal: income
value: financial-freedom
worklog_vault: Engram
worklog_path: 90 Work Log/todd

## Superpowers spec docs → Engram vault (overrides the skill default)

When `superpowers:brainstorming` produces a design/spec doc, save it to the **Engram vault** at `50 Engineering/_Superpowers Specs/YYYY-MM-DD-<topic>-design.md` via the engram MCP (`set_vault` → Engram `4c2057f9-a6cb-4e5e-9b4e-7ac50fb77c35`, `create_note`/`write_note`, then `set_vault()` to reset) — **not** to `docs/superpowers/specs/`. Specs are durable design rationale, so they live in the vault (searchable, dogfoods engram). This user instruction takes precedence over the skill's local-save step.

**Plans stay repo-local.** `superpowers:writing-plans` output is an ephemeral implementation checklist — keep it in `docs/superpowers/plans/` as the skill specifies; do not route plans to the vault.

## Issue Tracker

TODOs and open issues live in GitHub Issues for this repo — `gh issue list` to view, `gh issue create` to file. Don't track work in CLAUDE.md, docs/, or ad-hoc TODO.md files.

> **Multi-repo project.** This plugin is one half of Engram. For cross-project work (API changes, debugging plugin↔backend, deploy), open `../engram-workspace/` instead. See `../engram-workspace/docs/workspace-pattern.md` for when to use what.

See "Context Docs" below for the full doc-pointer index (plugin internals, ops, cross-repo, Obsidian API, sync/CRDT architecture, scripts).

## What This Plugin Does

A TypeScript sync client. It does NOT parse markdown, generate embeddings, or talk to Qdrant — Engram handles all of that. The plugin just pushes/pulls notes via REST.

### Responsibilities

1. **Watch vault events** — `app.vault.on("create")`, `on("modify")`, `on("delete")`, `on("rename")`
2. **Push changes to Engram** — `POST /api/notes` with file content + metadata
3. **Pull changes from Engram** — `GET /api/notes/changes` on startup and periodically (plus authoritative inventory via `GET /api/sync/manifest`)
4. **Write remote changes to vault** — files created/edited via MCP, the web SPA editor, or other devices
5. **Settings panel + Sync Center** — Engram URL, API key, ignore patterns, conflict resolution, sync preview, push/pull-all flows

### Does NOT

- Parse markdown or chunk text (Engram does this)
- Generate embeddings (Engram does this — Voyage AI on SaaS; Ollama is self-host only)
- Talk to Qdrant (Engram does this)
- Perform search indexing (Engram does this — plugin provides the search UI via `POST /api/search`)
- Manage auth/users (Engram does this)

## Git Workflow

**Everything goes through a PR. No exceptions, no admin bypass, no "doc-only" shortcuts that stretch into code.**

`main` is protected with `enforce_admins=true`. Required status checks (`build-and-test`, `version-check`, `backend/e2e`) must pass before merge. Stable releases are cut by merging the release-please PR into `main`: direct pushes skip the Release PR and break the release flow.

Workflow for any change, including doc updates:

1. `git switch -c <type>/<slug>` — `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`.
2. Commit on the branch. Conventional Commits, ≤50-char subject.
3. `git push -u origin <branch>` and open a PR with `gh pr create`.
4. Let CI run. If anything fails, fix it on the branch, never on main.
5. Merge through GitHub (`gh pr merge --squash` or the web UI). **Do not push directly to main, even to "fix the test" or "ship a doc tweak".**

The previous "doc-only changes can land on main" carve-out is rescinded — it drifted into code commits and bypassed the test gate that caught the missing README disclosure.

**Worktrees**: `git worktree add` fires a `post-checkout` hook (wired via `lefthook.yml`) that hardlinks `node_modules/` from the canonical checkout into the new tree — first build / lint runs without re-fetching ~500MB of deps. Just `git worktree add <path> -b <branch> origin/main`, no `bun install` needed on the fresh tree unless `mix.lock`/`bun.lock` is being edited.

## Testing

**Tests are the spec. If a test fails, fix the app — not the test.**

```bash
bun test              # Run the full unit-test suite
bun test --verbose    # Verbose output
bun test --coverage   # With coverage report
bun run build         # Build the plugin (production)
```

### Test files

Don't hardcode test counts here — they drift. Run `bun test` for the live total,
and `ls tests/*.test.ts` for the current file list. Coverage roughly tracks
~89% funcs / ~97% lines but check `bun test --coverage` for the real number.

Broad areas under test: SyncEngine (ignore/modify/delete/rename, pull, seq-replay
catch-up, WebSocket events, echo suppression, 3-way merge, state export/import),
manifest reconciliation, the offline queue, the API client, auth (ApiKey + OAuth
device flow), the Phoenix channel, diff/merge, remote logging, plan/limit state,
and a set of compliance tests (manifest, license, README disclosures,
source/styles hygiene, command IDs).

### Test configuration

- **Bun test config:** `bunfig.toml` — preloads `tests/preload.ts` for Obsidian module mocks
- **Obsidian mock:** `tests/__mocks__/obsidian.ts` — minimal mocks for TFile, Plugin, Modal, requestUrl, etc.
- **Coverage thresholds:** 40% minimum for branches, functions, lines, statements

### Untested files (UI-heavy — test via E2E in backend repo)

`settings.ts`, `conflict-modal.ts`, `search-modal.ts`, `search-view.ts`, `main.ts`

## Package Manager

**Use `bun`, not `npm`.** All commands (`install`, `test`, `build`, `run`, `lint`, `audit`) must use `bun`.

`package-lock.json` is not tracked. `bun.lock` must stay portable: never regenerate it with a `registry=` set in `~/.npmrc` or bun bakes that host into every entry, which breaks outside contributors and the Obsidian community scanner. `scripts/check-lockfile-registry.mjs` (lefthook + CI) enforces it; see `docs/context/scanner-type-resolution.md`.

## Build & Install

```bash
bun install
bun run build
```

**Before opening a PR** run the CI-only lints locally (they only run in CI, so a miss = a red round-trip): `bun test`, `./node_modules/.bin/biome ci` (NOT `check`, and not `bunx biome` — wrong version), `bun run lint:obsidian`, `bun run lint:css`, `bun run build`.

## Release Process

Releases are automated via GitHub Actions. Tags use `x.y.z` format (no `v` prefix) for BRAT/Obsidian compatibility.

**Do NOT bump `manifest.json` in feature PRs.** Versions are auto-derived (beta/per-PR). Stable releases are cut by merging the release-please PR.

### CI Workflows

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | Push to any branch | Build, lint, test + trigger backend E2E |
| `version-check.yml` | PR to main | Enforces `manifest.json`/`package.json`/`versions.json` consistency, but only when `manifest.json` is deliberately bumped; otherwise a no-op pass |
| `pr-build.yml` | PR to main (each push) | Publishes a prerelease tagged `X.Y.Z-pr.<num>.<sha>` with build assets, for BRAT frozen-version install by reviewers |
| `release-please.yml` | Push to main | Maintains a standing "Release PR"; on merge, bumps `manifest.json`/`package.json`, cuts the version, creates the release + bare `X.Y.Z` tag, then (gated on its own `release_created` output) builds, attests, and uploads `main.js`/`manifest.json`/`styles.css` to that release, updates `versions.json`, and posts the Discord announce |

There's also a rolling **beta** channel (`main` builds published as `X.Y.Z-beta.N`, installed via BRAT's "add beta plugin") that's part of this same release-channels initiative; its workflow lands in a separate commit.

### Cutting a release

1. **Open/merge feature PRs as usual.** Each push to a PR auto-publishes a per-PR prerelease via `pr-build.yml` (see above); no version bump needed.
2. **Edit the release notes.** `release-please.yml` keeps a Release PR up to date with a generated CHANGELOG; edit that PR's description to adjust the notes.
3. **Merge the release-please PR.** This bumps `manifest.json`/`package.json`, cuts the version, and publishes the stable GitHub release directly (build assets, `versions.json`, and the Discord announce), all from the same `release-please.yml` run. There is no separate tag-triggered workflow.

### Deploy to Local Vault

```bash
bun run build
cp main.js manifest.json styles.css "/home/open-claw/Obsidian Vault/.obsidian/plugins/engram-vault-sync/"
```

Restart Obsidian or disable/re-enable the plugin to pick up changes.

### Branch Protection (GitHub Settings)

Required status checks on `main`: `build-and-test`, `version-check / version-check`

## Context Docs

**Plugin internals & ops**
- Class map, sync algorithm, API endpoints, type definitions → `docs/internals.md`
- CDP + Obsidian remote debugging (MCP devtools, evaluate_script) → `docs/engram-ops.md`
- Version-bump.mjs foot-gun (running it directly drops `version` from `manifest.json`) → `docs/context/version-bump-script.md`
- Releases page full of orphaned `-pr.N` / `-rc.N` prereleases, or a closed PR's preview never got deleted (`pull_request: closed` never fires for superseded dependabot PRs; `prereleases.sh` + daily `preview-reconcile.yml`) → `docs/context/preview-release-cleanup.md`

**Cross-repo (workspace)**
- Server ops, infra, deployment → `../engram-workspace/docs/deployment.md`
- Backend REST API contract (endpoints, pipelines, auth, config) → `../engram-workspace/docs/api-contract.md`
- Cross-project debugging workflows (plugin → backend tracing) → `../engram-workspace/docs/debugging.md`

**Obsidian API & plugin listing**
- Obsidian API best practices and correct usage patterns → `docs/context/obsidian-api-reference.md`
- Submitting to the Community Plugins directory (new flow as of 2026-05-12) → `docs/context/obsidian-community-submission.md`
- Obsidian mtime quirk (`vault.modify()` sets mtime to "now" — can't use mtime comparison to decide whether to apply a remote change) → `docs/context/obsidian-mtime-quirk.md`
- Community-scanner `no-unsafe-*` false-positive flood / outside contributors can't `bun install` (registry-poisoned lockfile; `scripts/check-lockfile-registry.mjs` guard) → `docs/context/scanner-type-resolution.md`

**Sync / CRDT architecture & bug classes**
- Adding a `Map`/`Set` field to `SyncEngine`, or state survived a vault switch and addressed the new vault with the old vault's ids → `docs/context/sync-engine-sweep-registry.md`
- 3-way merge conflict-resolution algorithm → `docs/context/three-way-merge.md`
- Logging architecture (dev-log categories, remote-log thresholds) → `docs/context/logging-architecture.md`
- V8 OOM prevention on large-vault operations → `docs/context/v8-oom-prevention.md`
- Editor-binding stale-buffer race (note content copied into a DIFFERENT file on file-switch, PR #194 — bindTo await gap, sync-detach-before-await + bindEpoch + drift view-identity-guard fix) → `docs/context/crdt-editor-bind-race-pollution.md`
- Missed CRDT delivery healing (catch-up convergence: id adoption parity, base_hash CAS 409, pull backfill, socket vault-catchup via `catchupViaSocket()`) → `docs/context/sync-catchup-convergence.md`
- Prod `auth-failure-burst` alert traced to our own client (`Bearer ` with an empty token logs `reason=no_auth`, not `signature_error`; unlinked installs loop 401s and the log push re-reports them) → `docs/context/empty-bearer-no-auth-401-loop.md`
- Convergence sim tier fidelity gaps (`tests/sim/` — differential gate pays rent; seeded random-op suite does NOT converge, kept as a runnable tool not a test) → `docs/context/crdt-convergence-sim-fidelity-gaps.md`
- A new note "never gets created" after a rename+delete at the same name, a create logs `crdt_create ADOPT`, or you are about to drop bookkeeping on a path move (a rename must CARRY the sync-evidence row, not destroy it; plus: the sim shim used to make every delete a no-op) → `docs/context/rename-drops-sync-evidence.md`
- A note that logs `re-handshake fired` and then goes silent forever (the create-ack gate swallowing syncStep1; plus how to read `ci-debug` client logs without misordering them) → `docs/context/crdt-pull-gated-by-create-ack.md`
- Touching create-ack bookkeeping, or wondering what actually opens the live-send gate (`setCrdtHead`/`hasServerNote`, NOT `confirmNoteId` — and the ordering `adoptCreateAck` must keep) → `docs/context/crdt-pull-gated-by-create-ack.md`
- Bulk first sync opens a CRDT room per idle (non-editor-open) note (`flushHeldEditsOnCreateAck`'s self-heal was the one `enroll()` call site not gated on `isLiveBound`; #1409 handshake half) → `docs/context/crdt-createack-selfheal-ungated-enroll.md`
- About to treat a 0-byte file as "nothing to protect" (three ways an empty file lies: a converged clear, undelivered ops, a `cachedRead` that invented it) → `docs/context/crdt-empty-placeholder-cold-rooms.md`
- Wondering why a catch-up leg records no `serverHash`/`seq`, or tempted to add one (a row can lag its own `content_hash`; recording it marks the note in sync at bytes you cannot verify and every later row compares equal and is skipped) → `docs/context/crdt-empty-placeholder-cold-rooms.md`
- Closing a note strips its `---` block while the web app still shows the keys, or you are adding ANY path that writes a CRDT doc to disk (`ProviderRegistry.getText` is the body alone — teardown must use `projectedText`/`residentProjection`; #483) → `docs/context/crdt-teardown-flush-strips-frontmatter.md`

@/home/open-claw/documents/code-projects/ops-agent/docs/self-updating-docs.md
