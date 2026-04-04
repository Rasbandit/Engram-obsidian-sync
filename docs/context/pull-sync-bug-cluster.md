# Pull Sync Bug Cluster (Fixed 2026-03)

Four interrelated bugs made pull completely non-functional for existing files.

## Bug 1: mtime guard silently skips all updates (CRITICAL)

`applyChange` had `if (change.mtime > localMtime)` after conflict detection. Since `vault.modify()` sets local mtime to "now", localMtime was always > remote mtime, silently skipping every update.

**Fix:** Removed the guard. Conflict detection upstream already decides whether to apply.

## Bug 2: `applied` counter always increments

`applied++` ran unconditionally in the pull loop, even when changes were skipped. Status showed "pulled 5 changes" but nothing changed.

**Fix:** `applyChange`/`applyAttachmentChange` return `boolean`. Pull loop uses `if (await this.applyChange(change)) applied++`.

## Bug 3: pushModifiedFiles uses post-pull lastSync

`pull()` updates `this.lastSync` to server_time. `pushModifiedFiles()` then uses this newer timestamp, missing files modified between old and new lastSync.

**Fix:** Snapshot `this.lastSync` before `pull()`, pass it to `pushModifiedFiles(prePullSync)`.

## Bug 4: Pull failures are silent

Connection issues went unnoticed. No user feedback on failed or successful pulls.

**Fix:** Added `new Notice()` calls for pull failures and successful pulls with changes.

## Why This Matters

These bugs are tightly coupled to the sync algorithm's time-based change detection. Any future changes to `applyChange`, `pull()`, or `fullSync()` should be tested against these scenarios.
