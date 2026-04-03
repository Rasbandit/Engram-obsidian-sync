# CLAUDE.md

Obsidian plugin for bidirectional sync with Engram. This is Phase 2 of the Engram project.

## Life OS
project: engram-obsidian-sync
goal: income
value: financial-freedom

> **Multi-repo project.** This plugin is one half of Engram. For cross-project work (API changes, debugging plugin↔backend, deploy), open `../engram-workspace/` instead. See `../engram-workspace/docs/workspace-pattern.md` for when to use what.

For plugin internals (class map, sync algorithm, API endpoints, type definitions), read `docs/internals.md`.
For CDP and Obsidian remote debugging (MCP devtools, evaluate_script), read `docs/engram-ops.md`.
For server ops, infrastructure, and deployment, read `../engram-workspace/docs/deployment.md`.
For backend REST API (all endpoints, pipelines, auth, config), read `../engram-workspace/docs/api-contract.md`.
For cross-project debugging workflows, read `../engram-workspace/docs/debugging.md`.

## What This Plugin Does

A TypeScript sync client. It does NOT parse markdown, generate embeddings, or talk to Qdrant — Engram handles all of that. The plugin just pushes/pulls notes via REST.

### Responsibilities

1. **Watch vault events** — `app.vault.on("create")`, `on("modify")`, `on("delete")`, `on("rename")`
2. **Push changes to Engram** — POST /notes with file content + metadata
3. **Pull changes from Engram** — GET /notes/changes on startup and periodically
4. **Write remote changes to vault** — files created/edited via MCP or other devices
5. **Settings panel** — Engram URL, API key, ignore patterns, sync interval

### Does NOT

- Parse markdown or chunk text (Engram does this)
- Generate embeddings (Engram does this via Ollama)
- Talk to Qdrant (Engram does this)
- Perform search indexing (Engram does this — plugin provides the search UI via `POST /search`)
- Manage auth/users (Engram does this)

## Git Workflow

Doc-only changes (CLAUDE.md, docs/) can be committed and pushed directly to main without asking. No branch needed.

## Testing

**Tests are the spec. If a test fails, fix the app — not the test.**

```bash
npm test              # Run all 201 unit tests
npm test -- --verbose # Verbose output
npm test -- --coverage # With coverage report
npm run build         # Build the plugin (production)
```

### Test files (201 tests across 7 files)

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/sync.test.ts` | ~100 | SyncEngine: shouldIgnore, handleModify/Delete/Rename, pull, SSE events, echo suppression, status tracking, first sync detection, destroy |
| `tests/diff.test.ts` | ~30 | computeDiff, groupIntoHunks, buildMergedContent (line-by-line diff, hunk context, merge choices) |
| `tests/search.test.ts` | ~4 | EngramApi.search, SearchModal debounce |
| `tests/api.test.ts` | 25 | All EngramApi methods (pushNote, getChanges, deleteNote, getRateLimit, getManifest, search), base64 utilities, auth headers, URL encoding, error handling |
| `tests/offline-queue.test.ts` | 17 | Enqueue/dequeue, deduplication by path, oldest-first ordering, load/clear, debounced persistence, coalesced writes, destroy cancels timers |
| `tests/remote-log.test.ts` | 15 | Buffer management, flush threshold (20 entries), ring buffer overflow (200 cap), flush-on-disable, singleton lifecycle |

### Test configuration

- **Jest config:** `jest.config.js` — ts-jest preset, roots in `src/` and `tests/`
- **Test tsconfig:** `tsconfig.test.json` — extends main tsconfig with `noImplicitAny: false` (tests use `as any` for mocks)
- **Obsidian mock:** `tests/__mocks__/obsidian.ts` — minimal mocks for TFile, Plugin, Modal, requestUrl, etc.
- **Coverage thresholds:** 40% minimum for branches, functions, lines, statements

### Untested files (UI-heavy, minimal testable logic)

`settings.ts`, `conflict-modal.ts`, `first-sync-modal.ts`, `search-modal.ts`, `search-view.ts`, `main.ts`, `dev-log.ts`

## Build & Install

```bash
npm install
npm run build
```

## Release Process

No CI/CD — releases are manual. Full steps:

### 1. Version Bump

Update version string in all three files:

- `package.json` → `"version": "X.Y.Z"`
- `manifest.json` → `"version": "X.Y.Z"`
- `versions.json` → add `"X.Y.Z": "1.0.0"` (value = minAppVersion)

### 2. Commit, Merge, Tag

```bash
git switch main
git merge <branch> --no-edit
git tag -a vX.Y.Z -m "short description"
git push origin main --tags
```

### 3. GitHub Release

```bash
gh release create vX.Y.Z \
  main.js manifest.json styles.css \
  --title "vX.Y.Z: Short title" \
  --notes "Release notes in markdown"
```

Required assets: `main.js`, `manifest.json`, `styles.css` — Obsidian reads these from the release.

### 4. Deploy to Local Vault

```bash
npm run build
cp main.js manifest.json styles.css "/home/open-claw/Obsidian Vault/.obsidian/plugins/engram-sync/"
```

Restart Obsidian or disable/re-enable the plugin to pick up changes.

@/home/open-claw/documents/code-projects/ops-agent/docs/self-updating-docs.md
