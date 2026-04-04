# V8 OOM Prevention

## Background

In v0.3.5, Obsidian crashed with V8 out-of-memory errors when multiple plugins were enabled alongside engram-sync. Root cause: other plugins' startup file modifications flooded the sync engine with push requests before it was ready.

## Mitigations (all in place since v0.3.5)

1. **Ready gate** — `handleModify`, `handleDelete`, `handleRename` return immediately until `setReady()` is called after initial sync completes.
2. **Content-free offline queue** — queue entries store path/action/kind/mtime only, not file content. Content is re-read from vault on flush. Prevents O(n^2) serialization.
3. **Debounced persistence** — `OfflineQueue.schedulePersist()` coalesces writes (default 1s debounce).
4. **Push concurrency limiter** — semaphore caps concurrent pushes at 5 (`acquirePushSlot`/`releasePushSlot`).

## Heap Profile

After fixes, heap stable at ~37MB during normal operation (was unbounded before).

## Discovery

2026-03. Full investigation in memory entry `cdp-oom-investigation.md` (investigation was incomplete — the mitigations resolved the symptom but root cause in Electron's memory management was not fully traced).
