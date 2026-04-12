# Context Doc: Obsidian API Audit

_Last verified: 2026-04-11_

## Status
Working — audit complete, findings documented, no fixes applied yet.

## What This Is
Comprehensive audit of every Obsidian API usage in the engram-obsidian-sync plugin, cross-referenced against official docs at docs.obsidian.md and the obsidian.d.ts type definitions. Identifies misuses, anti-patterns, and improvement opportunities ranked by severity.

## Environment
Obsidian desktop + mobile, plugin targets Obsidian v1.5.7+ (based on API usage). Tested against official docs as of April 2026.

## Sources
- https://docs.obsidian.md/Plugins/Vault
- https://docs.obsidian.md/Plugins/Events
- https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins
- https://docs.obsidian.md/Reference/TypeScript+API
- https://github.com/obsidianmd/obsidian-api (obsidian.d.ts)
- Obsidian Forum (vault.process/modify debounce bug reports)

---

## HIGH — Should Fix

### H1: `vault.on('create')` fires for every existing file on vault load

**Location:** `main.ts:152-155`

**Problem:** The official docs state: _"[The create event] is also called when the vault is first loaded for each existing file. If you do not wish to receive create events on vault load, register your event handler inside `Workspace.onLayoutReady`."_

The plugin registers `vault.on('create')` in `onload()` (line 152), outside of `onLayoutReady`. This means the create handler fires for **every file in the vault** during startup.

**Current mitigation:** `handleModify()` has `if (!this.ready) return;` (sync.ts:284), and `setReady()` is called inside `onLayoutReady` (main.ts:320). So events are silently discarded. But the events still fire, and the handler still runs the `isSyncable()` and `shouldIgnore()` checks before hitting the guard — wasted CPU on every file during load.

**Fix:** Move the `vault.on('create')` registration inside `onLayoutReady`, or register all vault events there. This aligns with official guidance and avoids processing startup noise.

```ts
// BEFORE (main.ts:146-166)
this.registerEvent(this.app.vault.on("create", (file) => {
  this.syncEngine.handleModify(file);
}));

// AFTER — move inside onLayoutReady block (main.ts:306)
this.app.workspace.onLayoutReady(async () => {
  this.registerEvent(this.app.vault.on("create", (file) => {
    this.syncEngine.handleModify(file);
  }));
  // ... rest of onLayoutReady
});
```

**Note:** `modify`, `delete`, and `rename` do NOT fire on vault load — only `create` does. So only the create handler needs to move, but moving all four inside `onLayoutReady` is cleaner.

---

### H2: Never uses `vault.cachedRead()` — always uses `vault.read()`

**Locations:** sync.ts lines 504, 1017, 1569, 1708

**Problem:** The official docs differentiate two read methods:
- `vault.cachedRead(file)` — Returns cached content, avoids disk read. Use when you only need to **display or hash** content.
- `vault.read(file)` — Always reads from disk. Use when you intend to **read-modify-write**.

The plugin uses `vault.read()` everywhere, even when it only needs content for comparison or hashing:

| Location | Purpose | Should use |
|----------|---------|------------|
| sync.ts:504 | Read content before push (hash + send to server) | `cachedRead` — not modifying |
| sync.ts:1017 | Read for conflict detection (hash comparison) | `cachedRead` — not modifying |
| sync.ts:1569 | Reconciliation — reads every file to compute hash | `cachedRead` — massive perf win |
| sync.ts:1708 | Offline queue retry — read before push | `cachedRead` — not modifying |

**Impact:** The reconciliation path (line 1569) is the worst offender — it reads **every syncable file** from disk to compute hashes. With `cachedRead()`, most reads would hit Obsidian's in-memory cache, significantly reducing I/O.

**Fix:** Replace `vault.read()` with `vault.cachedRead()` in all four locations. Reserve `vault.read()` only for the `modifyFile()` path (which already uses `vault.process()`).

---

### H3: Uses `getAbstractFileByPath()` + `instanceof` instead of `getFileByPath()`

**Locations:** ~15 instances across sync.ts (lines 539, 591, 607, 635, 823, 932, 999, 1012, 1243, 1257, 1364, 1381, 1516, 1678, 1699) and search-view.ts:186

**Problem:** Every file lookup follows this pattern:
```ts
const existing = this.app.vault.getAbstractFileByPath(normalized);
if (existing && existing instanceof TFile) { ... }
```

Since Obsidian v1.5.7, `vault.getFileByPath(path)` returns `TFile | null` directly — no `instanceof` check needed. Similarly, `vault.getFolderByPath(path)` exists for folder lookups.

**Fix:**
```ts
// BEFORE
const existing = this.app.vault.getAbstractFileByPath(normalized);
if (existing && existing instanceof TFile) { ... }

// AFTER
const existing = this.app.vault.getFileByPath(normalized);
if (existing) { ... }
```

**Note:** Keep `getAbstractFileByPath()` only where you genuinely need both files and folders (e.g., `ensureFolder` at line 1364 and `removeEmptyFolders` at line 1381 which check for TFolder).

---

### H4: Status bar click handler not auto-cleaned via `registerDomEvent`

**Location:** `main.ts:281`

**Problem:** The status bar uses `addEventListener("click", ...)` directly:
```ts
this.statusBarEl.addEventListener("click", () => { ... });
```

Obsidian's `registerDomEvent()` method automatically removes event listeners when the plugin unloads. Raw `addEventListener` requires manual cleanup, which the plugin doesn't do.

**Fix:**
```ts
// BEFORE
this.statusBarEl.addEventListener("click", () => { ... });

// AFTER
this.registerDomEvent(this.statusBarEl, "click", () => { ... });
```

---

### H5: `setInterval` not registered with `registerInterval`

**Location:** `main.ts:651`

**Problem:** The periodic sync interval uses `setInterval()` directly:
```ts
this.syncInterval = setInterval(async () => { ... }, EngramSyncPlugin.FALLBACK_POLL_MS);
```

Obsidian's `registerInterval(window.setInterval(...))` auto-clears on unload and uses `window.setInterval` (the correct global for Obsidian).

**Current mitigation:** Manual cleanup in `onunload()` at line 334. This works but is fragile — if `onunload` throws before reaching that line, the interval leaks.

**Fix:**
```ts
// BEFORE
this.syncInterval = setInterval(async () => { ... }, POLL_MS);

// AFTER
this.syncInterval = window.setInterval(async () => { ... }, POLL_MS);
this.registerInterval(this.syncInterval);
```

**Note:** Even with `registerInterval`, keep the manual `clearInterval` in `startSyncInterval()` (line 644-646) since that method restarts the interval on settings change.

---

## MEDIUM — Should Improve

### M1: Inline style on status bar element

**Location:** `main.ts:280`

**Problem:** `this.statusBarEl.style.cursor = "pointer";` hardcodes a style directly on the element. The official Plugin Guidelines say: _"Use CSS classes and Obsidian CSS variables instead."_ Inline styles bypass theme customization and don't respect user CSS snippets.

**Fix:** Add a CSS class in `styles.css` and apply it:
```css
.engram-status-bar-clickable { cursor: pointer; }
```
```ts
this.statusBarEl.addClass("engram-status-bar-clickable");
```

---

### M2: `MarkdownView` imported but never used

**Location:** `sync.ts:5`

**Problem:** `MarkdownView` is imported from `"obsidian"` but never referenced in the file. Dead import.

**Fix:** Remove from the import statement.

---

### M3: `vault.process()` callback ignores current content

**Location:** `sync.ts:1332`

**Problem:**
```ts
await this.app.vault.process(file, () => content);
```

The callback receives the current file content as its argument but ignores it — it always replaces with the outer `content` variable. This loses the **atomicity benefit** of `process()`. The purpose of `process()` is to read-modify-write atomically: the callback gets the latest content and should transform it.

For a sync engine doing full-content replacement, this is technically fine — we **want** to overwrite. The scroll-preservation benefit of `process()` over `modify()` still applies. But the callback should ideally check that nothing unexpected happened:

```ts
// Slightly more defensive (optional — not strictly needed for sync)
await this.app.vault.process(file, (current) => {
  // Could log a warning if current !== expected, but for sync, overwrite is correct
  return content;
});
```

**Verdict:** Acceptable as-is. The `process()` usage is correct for its purpose (scroll preservation). The atomicity benefit is secondary here. Document this as an intentional design choice, not a bug.

---

### M4: `requestUrl` default `throw: true` inconsistent error handling

**Location:** `api.ts:81-86`

**Problem:** `requestUrl` defaults to `throw: true`, meaning 4xx/5xx responses throw. The plugin handles errors via try/catch in individual methods:
- `health()` catches everything → returns false
- `pushNote()` catches 409 specifically → returns conflict response
- `ping()` catches 401/403 → returns error message
- All other methods let errors propagate to callers

This is functional but inconsistent. The official docs recommend setting `throw: false` for manual error handling, but the current pattern is also valid. No change strictly needed.

---

### M5: Search view DOM listeners not using `registerDomEvent`

**Location:** `search-view.ts:64-65, 67-78`

**Problem:** Event listeners on `inputEl` and `folderEl` use raw `addEventListener` instead of `this.registerDomEvent()`. Since these elements are owned by the view and destroyed on `onClose()`, the listeners will be garbage-collected. But `registerDomEvent` is the idiomatic Obsidian pattern and provides defense-in-depth.

---

### M6: `containerEl.children[1]` magic index in SearchView

**Location:** `search-view.ts:38`

**Problem:**
```ts
const container = this.containerEl.children[1];
```

This assumes `containerEl` always has at least 2 children and the content area is at index 1. This is the standard Obsidian `ItemView` pattern (index 0 is the header, index 1 is the content area), but it's fragile if Obsidian changes the DOM structure.

**Alternative:** Obsidian's `ItemView` provides `this.contentEl` which is equivalent to `this.containerEl.children[1]` but named and stable. However, checking the obsidian.d.ts: `contentEl` is available on `ItemView` and is the recommended approach.

**Fix:**
```ts
// BEFORE
const container = this.containerEl.children[1];

// AFTER
const container = this.contentEl;
```

---

## LOW — Minor Improvements

### L1: `(app.vault.adapter as any).getBasePath?.()` — non-public API

**Location:** `main.ts:33`

**Problem:** Uses `as any` to access `getBasePath()` which is not in the public type definitions. The official guidelines warn against using non-public APIs.

**Current mitigation:** Has a mobile fallback (`vault.getName()`), and the biome-ignore comment acknowledges it. This is a pragmatic choice — there's no public API to get the vault's absolute filesystem path, and the plugin needs it for stable client ID generation.

**Verdict:** Acceptable. Document as intentional. If Obsidian ever adds a public API for this, switch to it.

---

### L2: BaseStore uses `vault.adapter` directly

**Location:** `base-store.ts` via `main.ts:106`

**Problem:** BaseStore reads/writes via `vault.adapter.read()` and `vault.adapter.write()` instead of using the Vault API.

**Verdict:** This is **correct and intentional**. The base store file lives in `.obsidian/plugins/engram-sync/sync-bases.json` — a hidden folder that the Vault API cannot access. The adapter is the correct tool for plugin config/data files. The `loadData()`/`saveData()` Plugin methods use the adapter internally too.

---

### L3: `vault.getFiles()` called multiple times for batch operations

**Locations:** sync.ts lines 1435, 1457, 1476, 1559

**Problem:** `getFiles()` is called separately in `pushModifiedFiles()`, `countSyncableFiles()`, `pushAll()`, and `reconcile()`. Each call returns all vault files. In a large vault (10k+ files), this creates significant array allocations.

**Verdict:** Low priority. These are batch operations that run infrequently (manual triggers or startup). Caching the file list would add complexity for minimal gain.

---

## Correct Patterns (Already Right)

These patterns in the codebase are correct and should not be changed:

1. **`vault.process()` with `vault.modify()` fallback** (sync.ts:1328-1335) — Correctly handles older Obsidian versions that lack `process()`. The `process` check (`if (this.app.vault.process)`) is the right approach.

2. **`registerEvent()` for all vault events** (main.ts:147-165) — Properly ensures auto-cleanup on unload.

3. **`registerDomEvent()` for visibility change** (main.ts:169) — Correctly uses the managed pattern for the document event.

4. **`requestUrl` for all HTTP** (api.ts) — Correctly uses Obsidian's built-in HTTP client instead of `fetch`. This handles CORS, works cross-platform, and passes plugin review.

5. **`normalizePath()` usage** (sync.ts, ~18 occurrences) — Properly normalizes all paths before vault operations.

6. **Echo suppression via hash tracking** (sync.ts:508-514) — Correct pattern for sync plugins to avoid push→modify→push loops. Uses content hashing rather than timed suppression.

7. **Debounced modify handling** (sync.ts:294-303) — Per-file debounce timers prevent excessive pushes during typing.

8. **`vault.trash(file, true)` instead of `vault.delete()`** (sync.ts:934, 1001, 1245, 1385) — Correctly uses system trash for user recoverability.

9. **`onLayoutReady` for initial sync** (main.ts:306) — Correctly defers startup sync until workspace is ready.

10. **`workspace.getLeavesOfType()` for view access** (main.ts:248) — Does not store view references, accesses via workspace. Correct per guidelines.

---

## Decision Tree: Which Vault API to Use

```
Need to read file content?
├─ For display/hashing/comparison only → vault.cachedRead(file)
├─ For read-modify-write → vault.process(file, fn)
└─ For full replacement (no current content needed) → vault.modify(file, data)

Need to look up a file by path?
├─ Know it's a file → vault.getFileByPath(path)         [v1.5.7+]
├─ Know it's a folder → vault.getFolderByPath(path)      [v1.5.7+]
└─ Could be either → vault.getAbstractFileByPath(path) + instanceof

Need to write to hidden folders (.obsidian/)?
└─ vault.adapter.read() / vault.adapter.write()

Need to modify frontmatter?
└─ app.fileManager.processFrontMatter(file, fn)

Need to rename with link updates?
└─ app.fileManager.renameFile(file, newPath)

Need to delete?
├─ Recoverable → vault.trash(file, true)
└─ Permanent → vault.delete(file)
```

## References
- Official Obsidian Plugin Docs: https://docs.obsidian.md/Plugins
- Plugin Guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- TypeScript API Reference: https://docs.obsidian.md/Reference/TypeScript+API
- obsidian.d.ts source: https://github.com/obsidianmd/obsidian-api
- Related context doc: `docs/context/obsidian-mtime-quirk.md`
