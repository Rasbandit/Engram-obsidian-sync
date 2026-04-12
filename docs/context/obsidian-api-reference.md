# Context Doc: Obsidian Plugin API Reference

_Last verified: 2026-04-11_

## Status
Working — comprehensive reference for correct Obsidian API usage in this plugin.

## What This Is
Quick-reference for Obsidian plugin API best practices, sourced from official docs.obsidian.md. Covers vault operations, events, workspace, UI, lifecycle, and mobile compatibility. Use this when writing new plugin code or reviewing existing patterns.

## Environment
Obsidian v1.5.7+ (desktop + mobile). Plugin uses TypeScript with Bun toolchain.

---

## Vault API

### Reading Files

| Method | When to use | Returns |
|--------|------------|---------|
| `vault.cachedRead(file)` | Display, hash, compare — no intent to write back | `Promise<string>` (may use cache) |
| `vault.read(file)` | Read-modify-write cycles (need freshest content) | `Promise<string>` (always from disk) |
| `vault.readBinary(file)` | Binary attachments | `Promise<ArrayBuffer>` |

**Key nuance:** `cachedRead` and `read` behave identically once Obsidian is notified of a change (internal save or filesystem watcher). The only divergence is a narrow race: external change + immediate read before the watcher fires.

### Writing Files

| Method | When to use | Notes |
|--------|------------|-------|
| `vault.process(file, fn)` | Background modification (sync, linting) | **Preferred.** Atomic read-modify-write. Callback must be sync. Preserves scroll position. |
| `vault.modify(file, data)` | Full replacement when `process` unavailable | Destroys cursor, scroll, folds on active file. |
| `vault.create(path, data)` | New files | Throws if file exists. Returns `TFile`. |
| `vault.createBinary(path, data)` | New binary files | Same as `create` but for `ArrayBuffer`. |
| `vault.modifyBinary(file, data)` | Update binary files | No `processBinary` equivalent exists. |
| `fileManager.processFrontMatter(file, fn)` | Modify YAML frontmatter | Atomic. Never parse YAML manually. |

**Critical:** Never use `vault.modify()` on the **active file** — use the Editor API (`editor.replaceRange()`, `editor.setValue()`) instead. `modify()` resets cursor, selection, scroll, and folded sections.

**`vault.process()` limitation:** The callback receives current content and must return new content **synchronously**. For async operations:
1. `cachedRead()` first
2. Do async work
3. Call `process()`, checking inside the callback that content hasn't changed

### File Lookup

| Method | Returns | Since |
|--------|---------|-------|
| `vault.getFileByPath(path)` | `TFile \| null` | v1.5.7 |
| `vault.getFolderByPath(path)` | `TFolder \| null` | v1.5.7 |
| `vault.getAbstractFileByPath(path)` | `TAbstractFile \| null` | v0.x |

**Prefer `getFileByPath`** when you know the target is a file — avoids `instanceof` checks. Use `getAbstractFileByPath` only when the target could be a file OR folder.

### Delete / Rename

| Method | Behavior |
|--------|----------|
| `vault.trash(file, true)` | System trash (recoverable) — **preferred** |
| `vault.trash(file, false)` | Local `.trash` folder |
| `vault.delete(file)` | Permanent deletion |
| `vault.rename(file, newPath)` | Raw rename — no link updates |
| `fileManager.renameFile(file, newPath)` | Rename with automatic link updates |

### Hidden Folders (`.obsidian/`)

Vault API cannot access hidden folders. Use `vault.adapter.read()` / `vault.adapter.write()` for:
- Plugin config files in `.obsidian/plugins/your-plugin/`
- The `loadData()` / `saveData()` Plugin methods already use the adapter

**Prefer Vault API otherwise** — it has a caching layer and serializes operations to prevent races.

---

## Events

### Vault Events

```ts
vault.on('create', (file: TAbstractFile) => any)   // File/folder created
vault.on('modify', (file: TAbstractFile) => any)    // File modified
vault.on('delete', (file: TAbstractFile) => any)    // File/folder deleted
vault.on('rename', (file: TAbstractFile, oldPath: string) => any)
```

**`create` fires on vault load** for every existing file. Guard with `onLayoutReady` or a `ready` flag.

**`modify` fires frequently** during typing (~every 2 seconds from internal save debounce). Always debounce handlers.

### MetadataCache Events

```ts
metadataCache.on('changed', (file: TFile, data: string, cache: CachedMetadata) => any)
metadataCache.on('resolved', () => any)  // All files resolved after batch
```

**`changed` does NOT fire on rename** (performance optimization). Use `vault.on('rename')` for renames.

### Registration (Mandatory Pattern)

```ts
// CORRECT — auto-cleanup on unload
this.registerEvent(this.app.vault.on('modify', handler));
this.registerDomEvent(element, 'click', handler);
this.registerInterval(window.setInterval(fn, ms));

// WRONG — leaks on plugin disable/reload
this.app.vault.on('modify', handler);
element.addEventListener('click', handler);
setInterval(fn, ms);
```

### Echo Suppression for Sync Plugins

When your plugin writes a file, it triggers `modify`. Suppress via content hashing:
```ts
// Track hashes of content we wrote
private syncState: Map<string, { hash: number }>;

// In push handler: skip if content matches what we last wrote
const hash = computeHash(content);
if (hash === this.syncState.get(path)?.hash) return; // echo — skip
```

---

## Workspace

### Getting Active Editor

```ts
// CORRECT
const view = this.app.workspace.getActiveViewOfType(MarkdownView);
if (view) { const editor = view.editor; }

// ALSO CORRECT
const editor = this.app.workspace.activeEditor?.editor;

// WRONG (deprecated)
const leaf = this.app.workspace.activeLeaf;
```

### Managing Views

```ts
// Register
this.registerView(TYPE, (leaf) => new MyView(leaf));

// Access (never store references to views)
const leaves = this.app.workspace.getLeavesOfType(TYPE);

// Get sidebar leaf
const leaf = this.app.workspace.getRightLeaf(false);
await leaf.setViewState({ type: TYPE, active: true });
this.app.workspace.revealLeaf(leaf);
```

**Never detach leaves in `onunload()`** — they persist across plugin reloads.

### Layout Ready

```ts
this.app.workspace.onLayoutReady(async () => {
  // Safe to start sync, register create handlers, etc.
});
```

---

## UI Components

### ItemView (Sidebar Panels)

```ts
class MyView extends ItemView {
  getViewType(): string { return 'my-type'; }
  getDisplayText(): string { return 'My View'; }
  getIcon(): string { return 'search'; }

  async onOpen() {
    // Use this.contentEl (not this.containerEl.children[1])
    this.contentEl.empty();
    this.contentEl.createEl('h4', { text: 'Title' });
  }
}
```

### Settings

- Use `setHeading()` for section headers, not raw HTML
- Use sentence case, not Title Case
- Avoid "Settings" in section names (redundant — they're already in Settings)
- Default pattern: `Object.assign({}, DEFAULTS, await this.loadData())` (shallow only)

### Notices

```ts
new Notice('Short message');           // Default timeout
new Notice('Longer message', 10000);   // 10 second timeout
```

### DOM Creation

```ts
// CORRECT — safe from XSS
containerEl.createEl('p', { text: 'Hello' });
containerEl.createDiv({ cls: 'my-class' });

// WRONG — XSS risk, flagged in plugin review
containerEl.innerHTML = '<p>Hello</p>';
```

---

## Plugin Lifecycle

```ts
class MyPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    // Register everything here — all auto-cleaned on unload
    this.registerEvent(...);
    this.registerInterval(window.setInterval(...));
    this.registerDomEvent(...);
    this.register(() => { /* custom cleanup */ });
    this.addChild(new MyComponent());
    this.registerView(...);
    this.addSettingTab(...);
    this.addCommand(...);
    this.addRibbonIcon(...);
  }

  onunload() {
    // Only for cleanup NOT handled by register* methods
    // Do NOT detach leaves here
  }
}
```

---

## Mobile Compatibility

### Unavailable on Mobile
- Node.js modules: `fs`, `crypto`, `os`, `path`, `child_process`
- Electron APIs
- `FileSystemAdapter` (mobile uses `CapacitorAdapter`)

### Alternatives
- `crypto.subtle` (SubtleCrypto) instead of Node `crypto`
- `navigator.clipboard` for clipboard
- Vault API abstracts adapter differences — prefer it over direct adapter

### Platform Detection
```ts
import { Platform } from 'obsidian';
Platform.isMobile     // true on iOS or Android
Platform.isDesktop    // true on desktop
Platform.isIosApp     // iOS specifically
Platform.isAndroidApp // Android specifically
```

---

## `requestUrl` (HTTP Client)

```ts
import { requestUrl } from 'obsidian';

const resp = await requestUrl({
  url: 'https://api.example.com/data',
  method: 'POST',
  headers: { 'Authorization': 'Bearer token', 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'value' }),
  throw: false,  // Handle errors manually (default: true = throws on 4xx/5xx)
});
```

**Always use `requestUrl`** — not `fetch` or `XMLHttpRequest`. It bypasses CORS, works on mobile, and passes plugin review.

---

## `normalizePath`

**Mandatory** for any user-provided or server-provided path before passing to vault methods:
```ts
import { normalizePath } from 'obsidian';
const safe = normalizePath(userPath);
```

Normalizes slashes, removes leading/trailing slashes, replaces non-breaking spaces.

---

## Common Anti-Patterns (from Plugin Guidelines)

1. Using `window.app` instead of `this.app`
2. Using `workspace.activeLeaf` (deprecated) instead of `getActiveViewOfType()`
3. Using `vault.modify()` on the active file (destroys editor state)
4. Using `vault.modify()` in background instead of `vault.process()`
5. Storing references to views (use `getLeavesOfType()` on demand)
6. Not using `registerEvent()`/`registerInterval()` (memory leaks)
7. Detaching leaves in `onunload()` (loses user's layout)
8. Using `innerHTML` (XSS risk)
9. Hardcoding styles (use CSS classes + CSS variables)
10. Iterating all files to find by path (use `getFileByPath()`)
11. Setting default hotkeys for commands (causes conflicts)
12. Excessive `console.log` in production

## References
- Official Obsidian Plugin Docs: https://docs.obsidian.md/Plugins
- Plugin Guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Submission Requirements: https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins
- TypeScript API Reference: https://docs.obsidian.md/Reference/TypeScript+API
- obsidian.d.ts source: https://github.com/obsidianmd/obsidian-api
- Audit findings: `docs/context/obsidian-api-audit.md`
