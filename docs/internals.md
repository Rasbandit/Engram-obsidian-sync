## Engram Vault Sync — Internals Quick Reference

_Last verified: 2026-07-08_

### Source Map

> Line counts are rough orientation only — run `wc -l src/*.ts` for current figures (the codebase has grown well past these as features landed).

| File | Lines | Purpose |
|------|-------|---------|
| `src/main.ts` | ~1100 | Plugin lifecycle, vault event wiring, commands, status bar, settings I/O |
| `src/sync.ts` | ~3500 | Core sync engine: push, pull, fullSync, seq-replay catch-up, manifest reconciliation, debounce, offline queue, conflicts, 3-way merge, request pacer |
| `src/api.ts` | ~430 | HTTP client wrapping `requestUrl()` for all Engram REST calls |
| `src/types.ts` | ~270 | All interfaces: settings, API responses, queue entries, sync status |
| `src/settings.ts` + `src/tabs/` | — | Settings UI (PluginSettingTab) split into per-tab modules (Account, Sync Center, Self-hosted, Advanced, About, Start) |
| `src/channel.ts` | ~185 | Phoenix WebSocket channel client for real-time sync |
| `src/conflict-modal.ts` | ~350 | Conflict resolution modal (Keep Local / Keep Remote / Keep Both / Skip) |
| `src/diff.ts` | ~305 | Line-level diff engine (Myers' algorithm) for conflict resolution |
| `src/three-way-merge.ts` | ~160 | 3-way merge using diff-match-patch with overlap detection |
| `src/base-store.ts` | ~110 | Persists last-synced note content for 3-way merge base |
| `src/remote-log.ts` | ~160 | Ships plugin errors and lifecycle events to backend |
| `src/offline-queue.ts` | ~90 | Persistent offline retry queue (Map-based, dedupes by path, debounced persistence) |
| `src/dev-log.ts` | ~100 | Dev-only diagnostic ring buffer (compile-time stripped in production) |
| `src/search-modal.ts` | ~165 | Quick search modal — semantic search with debounce, arrow nav (command-palette only, no hotkey) |
| `src/search-view.ts` | ~220 | Sidebar search view (ItemView) — persistent search panel with preview pane |
| `src/sync-center-render.ts` | — | Sync Center dashboard rendering (paired with `src/tabs/sync-center-tab.ts`) |

### Class Relationships

```
EngramSyncPlugin (main.ts)
├── api: EngramApi (api.ts)
│   └── getRateLimit() → GET /rate-limit
├── syncEngine: SyncEngine (sync.ts)
│   ├── api: EngramApi (shared instance)
│   ├── queue: OfflineQueue (offline-queue.ts, debounced persistence)
│   ├── baseStore: BaseStore (base-store.ts, last-synced content for 3-way merge)
│   ├── ready gate: events suppressed until setReady()
│   ├── push semaphore: max 5 concurrent (acquirePushSlot/releasePushSlot)
│   ├── request pacer: sliding window from configureRateLimit()
│   ├── 3-way merge: threeWayMerge() (three-way-merge.ts) + diff engine (diff.ts)
│   └── onConflict: (path, local, remote) → ConflictChoice (wired to ConflictModal)
├── noteChannel: NoteChannel (channel.ts) — Phoenix WebSocket for real-time sync
├── remoteLog: RemoteLog (remote-log.ts) — ships errors/lifecycle to backend
├── SearchModal (search-modal.ts) — opened via the "Semantic search" command (no hotkey)
├── SearchView (search-view.ts) — registered as "engram-search-view" ItemView
├── devLog: DevLogBuffer (dev-log.ts) — globalThis.__engramLog (dev builds only)
└── statusBarEl: HTMLElement
```

### Settings Defaults

Shape is `EngramSyncSettings` in `src/types.ts` (`DEFAULT_SETTINGS`). Core persisted keys:

```typescript
{ apiUrl: "", apiKey: "", ignorePatterns: "", debounceMs: 2000,
  conflictViewMode: "unified", remoteLoggingEnabled: false,
  conflictResolution: "auto", vaultId: null, clientId: "" }
```

Optional / runtime-populated fields (absent until set): `remoteVaultName`,
`refreshToken`, `accessToken`, `accessTokenExpiresAt`, `accessTokenVaultId`,
`userEmail`, `authMethod`, `planState`.

### Plugin API Endpoints

All endpoints require `Authorization: Bearer <api_key>`. Path params use `encodeURIComponent()`.

| Method | Path | Body/Params | Response |
|--------|------|-------------|----------|
| `POST` | `/notes` | `{path, content, mtime}` | `{note, chunks_indexed}` |
| `GET` | `/notes/{path}` | — | Full note content |
| `GET` | `/notes/changes?since={iso}` | — | `{changes[], server_time}` |
| ~~`GET`~~ | ~~`/sync/changes?cursor={c}&limit={n}`~~ | — | **Removed** (backend REST-purge Bucket A, #1036) — catch-up now runs entirely over the socket (`catchupViaSeqReplay`) |
| `GET` | `/sync/manifest` | — | Authoritative `{path, content_hash}` inventory for bootstrap/reconciliation |
| `POST` | `/notes/batch` | `{notes: [{path, content, mtime}...]}` (≤100) | Bulk push (protocol rev) |
| `DELETE` | `/notes/{path}` | — | `{deleted, path}` |
| `GET` | `/folders` | — | Folder tree with note counts |
| `POST` | `/attachments` | `{path, content_base64, mime_type, mtime}` | `{attachment}` |
| `GET` | `/attachments/{path}` | — | `{id, path, content_base64, mime_type, size_bytes, mtime, ...}` |
| `GET` | `/attachments/changes?since={iso}` | — | `{changes[], server_time}` |
| `DELETE` | `/attachments/{path}` | — | `{deleted, path}` |
| `POST` | `/search` | `{query, limit?, tags?}` | `{query, results[{text, title?, heading_path?, source_path?, tags[], wikilinks[], score, vector_score, rerank_score}]}` |
| `WS` | `/notes/ws` | Phoenix WebSocket channel (replaces former SSE `/notes/stream`) | `{event_type, path, timestamp, kind?}` via `note:changes` topic |
| `GET` | `/rate-limit` | — | `{requests_per_minute}` (0 = unlimited) |
| `GET` | `/health` | No auth required | Health check |

**POST /notes example:**
```json
// Request
{"path": "2. Knowledge Vault/Health/Omega Oils.md", "content": "---\ntags: [health]\n---\n# Omega Oils\n...", "mtime": 1709234567.0}
// Response
{"note": {"id": 1, "path": "...", "title": "Omega Oils", "folder": "2. Knowledge Vault/Health", "tags": ["health"], ...}, "chunks_indexed": 3}
```

**GET /notes/changes example:**
```json
{
  "changes": [
    {"path": "...", "title": "...", "content": "...", "folder": "...", "tags": [...], "mtime": 1709345678.0, "updated_at": "2026-02-28T14:30:00Z", "deleted": false},
    {"path": "Old Note.md", "content": "...", "updated_at": "...", "deleted": true}
  ],
  "server_time": "2026-02-28T15:00:00Z"
}
```

Plugin uses `server_time` as `since` for the next sync — no missed changes even with clock drift.

For the full backend endpoint list, see `../engram-workspace/docs/api-contract.md`.

### Sync Algorithm — Key Flows

**fullSync() (startup + periodic):**
1. `ping()` → `GET /folders` (validates auth, throws on 401/403)
2. `configureRateLimit()` → `GET /rate-limit` (sets pacer, applies 10% safety margin)
3. Snapshot `prePullSync = lastSync` (critical — pull updates lastSync)
4. `pull()` → fetch note + attachment changes since lastSync, apply each
5. `pushModifiedFiles(prePullSync)` → push local files modified since the OLD lastSync

**pull():**
1. Parallel fetch: `GET /notes/changes` + `GET /attachments/changes`
2. Apply each change via `applyChange()` / `applyAttachmentChange()`
3. Update `lastSync` to later of the two `server_time` values
4. If no lastSync exists, defaults to `"1970-01-01T00:00:00Z"`

**applyChange() conflict detection:**
- Conflict = local file exists AND local mtime > lastSync AND remote mtime > lastSync AND content differs
- Resolution choices: `skip` | `keep-local` (push ours) | `keep-remote` (overwrite) | `keep-both` (copy as `name (conflict YYYY-MM-DD).md`)

**Push pipeline:**
1. Vault event → `handleModify/Create/Delete/Rename` (suppressed until `setReady()`)
2. Modify: debounce timer per-file (configurable, default 2s)
3. Timer fires → `acquirePushSlot()` (max 5 concurrent) → `paceRequest()` → read content → POST to API
4. On failure → `enqueueChange()` with path only (content-free) → offline queue
5. Batch operations (pushAll, pushModifiedFiles): chunks of 10, sequential batches

**WebSocket echo suppression:**
- After successful push: `markRecentlyPushed(path, 5000ms)`
- Channel handler skips events for paths that are `pushing` or `recentlyPushed`
- Prevents write-back loops

**Offline cycle:**
1. Push fails → `goOffline()` → start health check every 30s
2. Health check succeeds → `goOnline()` → `flushQueue()` (oldest-first)
3. Queue flush fails → back to offline

### File Type Handling

```
isSyncable(path):  .md, .canvas, or isBinaryFile(path)
isMarkdown(path):  .md
isBinaryFile(path): .png .jpg .jpeg .gif .bmp .svg .webp .pdf
                    .mp3 .wav .ogg .m4a .webm .flac .mp4 .mov .zip
```

Binary files use `/attachments` endpoints with base64 encoding.
Text files use `/notes` endpoints with raw content string.

### Ignore Pattern Logic

```
Always ignored (hardcoded): .obsidian/, .trash/, .git/
User patterns (from settings textarea, one per line):
  - Ends with "/" → folder pattern: path.startsWith(p) or path contains "/"+p
  - No trailing "/" → file pattern: exact match or endsWith("/"+name)
```

### Internal State (SyncEngine)

| Field | Type | Purpose |
|-------|------|---------|
| `debounceTimers` | `Map<path, timeout>` | Active debounce timers per file |
| `pushing` | `Set<path>` | Files currently being pushed (prevents re-entry) |
| `recentlyPushed` | `Map<path, timeout>` | Echo suppression cooldowns (5s) |
| `lastSync` | `string` | ISO 8601 timestamp, persisted to plugin data |
| `syncState` | `Map<path, FileSyncState>` | Per-file synced state (replaced the old `syncedHashes` map). `exportSyncState()`/`importSyncState()` |
| `syncStateVaultId` | `string \| null` | The server vaultId `syncState`/`lastSync` belong to; on vault change the stale state is invalidated |
| `offline` | `boolean` | Current connectivity state |
| `healthCheckTimer` | `interval` | 30s poll when offline |
| `ready` | `boolean` | Event handlers suppressed until true (ready gate) |
| `activePushCount` | `number` | Current in-flight push requests |
| `maxConcurrentPushes` | `number` | Push semaphore limit (5) |
| `pushWaiters` | `(() => void)[]` | Queued resolvers waiting for a push slot |
| `rateLimitRPM` | `number` | Server-reported RPM with 10% margin (0 = unlimited) |
| `requestTimestamps` | `number[]` | Sliding window of recent request times for pacing |

### Time Handling

- Obsidian `file.stat.mtime`: epoch **milliseconds**
- API mtime fields: epoch **seconds** (divide by 1000 when sending)
- `lastSync` / `server_time`: ISO 8601 strings
- Conflict detection compares epoch seconds

### Known Quirks

- **Obsidian resets mtime on vault.modify()** — cannot use mtime to decide whether to apply remote changes. Conflict detection uses lastSync comparison instead. (2026-03)
- **Real-time sync uses Phoenix WebSocket** — native WebSocket via `channel.ts`, not SSE (migrated in v0.6.0)
- **requestUrl()** — Obsidian's built-in HTTP, bypasses CORS, required for mobile support
- **Conflict copies** — named `{stem} (conflict YYYY-MM-DD).{ext}`, not timestamped to the second

### Ready Gate (V8 OOM Prevention)

Event handlers (`handleModify`, `handleDelete`, `handleRename`) return immediately until `setReady()` is called. This prevents other plugins' startup file modifications from flooding the sync engine.

```
Plugin.onload()
  └── workspace.onLayoutReady() callback:
      1. doSyncWithFirstSyncCheck()   ← initial sync
      2. syncEngine.setReady()        ← events now flow through (in finally block)
```

### Request Pacer

Self-regulating rate limiter that queries the server's limit on startup.

```
configureRateLimit():
  1. GET /rate-limit → { requests_per_minute: N }
  2. If N > 0: effective = floor(N * 0.9)   ← 10% safety margin
  3. If N == 0 or error: pacer disabled

paceRequest():
  1. If rateLimitRPM == 0: return immediately
  2. Prune timestamps older than 60s
  3. If under limit: record timestamp, proceed
  4. At capacity: sleep until oldest timestamp exits window (+50ms buffer)
```

Called in `pushFile()` (after acquiring push slot) and `flushQueue()` (before each API call).

### Offline Queue (Debounced Persistence)

`OfflineQueue` deduplicates by path and debounces persistence writes.

- `enqueue()`: adds entry, calls `schedulePersist()` (debounced, default 1s)
- `dequeue()` / `clear()`: immediate `persistNow()`
- `destroy()`: clears pending timer
- Queue entries are **content-free** (path, action, kind, mtime only) — content re-read from vault on flush
- Legacy entries with inline `content`/`contentBase64` are still honored for backward compat

### Push Concurrency Limiter

Semaphore pattern limiting concurrent push requests to 5.

- `acquirePushSlot()`: increments counter or queues a waiter promise
- `releasePushSlot()`: decrements counter, resolves next waiter
- Prevents request flooding during bulk syncs and startup reconciliation

### Dev-Only Diagnostic Logger (`dev-log.ts`)

Compile-time gated via `DEV_MODE` constant (set in `esbuild.config.mjs`).

- **Dev builds** (`bun run dev`): ring buffer of 500 entries on `globalThis.__engramLog`
- **Production builds** (`bun run build`): all methods are no-ops, zero overhead
- Categories: `lifecycle`, `push`, `pull`, `error`, `sse` (legacy name, covers WebSocket), `queue`, `pacer`
- CDP queryable: `globalThis.__engramLog.dump(50)`, `.filter("push")`, `.stats()`

### CRDT Sync Layer (`src/crdt/`)

CRDT sync persists one `Y.Doc` per note to IndexedDB via `y-indexeddb`, **keyed by stable `note_id`** (not vault path) so a rename is a metadata change rather than a delete+create. `src/crdt/` splits into a core sync layer and a `live/` editor-binding subsystem.

**Core sync (`src/crdt/`):**
- `manager.ts` — `CrdtManager`: opens/rehydrates Y.Docs, routes local edits and remote updates, owns persistence; stamps `REMOTE_ORIGIN` on inbound server bytes so they flush to disk but are not re-broadcast.
- `channel.ts` — `CrdtChannel`: y-protocols framing (STEP1/STEP2/UPDATE), per-doc `startSync(noteId)` handshake guard.
- `enrollment.ts` — `CrdtEnrollment`: calls `startSync(noteId)` once per note_id per channel session so the state-vector handshake fires on first open (down-sync gap fix). Wired from `active-leaf-change` in `main.ts`.
- `note-id-map.ts` — `NoteIdMap`: path → note_id sidecar that survives renames; the plugin-side bridge that makes id-keying work.
- `bridge.ts` — `seedOnce()`: seeds disk content into a fresh doc exactly once, guarded so it never clobbers a history another device already owns.
- `frontmatter-codec.ts` — splits/rejoins the frontmatter fence so it lives apart from the body Y.Text.
- `schema.ts` — `ensureDocSchema()`: one-time IndexedDB wipe when upgrading pre-1.10 (proto-1) local docs.
- `uuid7.ts` — `uuid7()`: client-mintable, time-ordered note_id for brand-new notes (`crypto.randomUUID()` is v4-only, no ordering).
- `wiring.ts` — structural `CrdtWiringDeps` seam so tests wire the CRDT layer without standing up the whole SyncEngine.

**Live editing (`src/crdt/live/`)** — binds an open note's Y.Doc to the CodeMirror 6 editor and reading view for real-time collaborative editing:
- `editor-controller.ts` — owns the bind lifecycle + 3s drift check; refuses to dispatch into a view showing a different file (the bind-race pollution guard, PR #194).
- `ycollab-binding.ts` — the single CM6 `Compartment` reconfigured to the active note's yCollab binding on note switch.
- `cm-yjs-bridge.ts` — converts Y.Text deltas ↔ CM6 `ChangeSpec`s.
- `annotations.ts` — `ySyncAnnotation` marks CRDT-originated CM6 transactions so the binding does not re-capture them as local edits.
- `live-views.ts` — `ViewerRefcount`: per-path viewer refcount; suppresses disk writes while a pane or reading-view holds the note open, flushes once on last release.
- `reading-view.ts`, `frontmatter-hook.ts`, `obsidian-internals.ts` — reading-mode binding, live frontmatter-update hook, and Obsidian-internal `EditorView` access.

#### iOS / Mobile IndexedDB assumption

**v1 assumes a normal vault stays well under the WKWebView per-origin IndexedDB quota** (historically ~50 MB, subject to OS eviction under storage pressure). If eviction occurs:
- `CrdtManager.onPersistError` is called (a warning is logged via `rlog()`).
- Sync continues in-memory + over the WebSocket; only **local offline durability** degrades.
- The conflict modal is NOT shown — persistence errors are not corruption.

Real-device testing on iOS and Android is required before GA. This is an open validation item.

#### Flatten-on-bloat threshold

`CrdtManager.flattenIfBloated(path)` compacts a doc to a single-client-ID snapshot. It fires **only** when **both** axes of the two-dimensional threshold are crossed (spec §11 + backend AND gate — not OR):

- Encoded state > **500 KB** (`MAX_CONTENT_BYTES`)
- Distinct client-IDs > **1000** (`MAX_CLIENT_IDS`)

A large single-author doc (many bytes, one client-ID) or a multi-client but tiny doc are left alone. v1 wires the check on doc open (`flattenIfBloated` is called conservatively); the trigger cadence may be tightened in a later release.

**Correctness caveat:** flatten breaks CRDT lineage. A device that flattens and one that did not will re-merge as two distinct histories on the next handshake. The high threshold keeps flatten rare. The plugin pushes the flattened state with a local origin so the server adopts the new lineage (spec §4.2) rather than re-expanding the bloated history.

#### Cold-start reconcile (`reconcileColdStart`)

Called at plugin startup (after `setReady()`) for every markdown file in the vault. Diffs on-disk content into the Y.Doc for notes that changed while the app was closed (external editor, OS write, another sync app). The CRDT converges the change with any remote history once the handshake runs.

The try/catch is split so `onCorruption` fires **only** on Y.Doc decode failure — a transient storage write error in `applyLocalEdit` is swallowed (not treated as corruption).

### Build & Test Commands

```bash
bun test                    # Unit tests (Bun test runner)
bun run build               # tsc check + esbuild → main.js
bun run dev                 # esbuild watch mode with sourcemaps
npm version patch           # Bumps package.json + manifest.json + versions.json (requires npm)
```

Build output: `main.js` (CommonJS, ES2018 target). Externals: obsidian, electron, @codemirror/*, @lezer/*.
