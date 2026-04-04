# 3-Way Merge Conflict Resolution (v0.6.0)

## How It Works

When a conflict is detected (both local and remote changed since lastSync), the plugin attempts automatic 3-way merge before showing the conflict modal.

### Components

1. **BaseStore** (`base-store.ts`) — Persists the "base" content (last-synced version) of each note. Stored via plugin data persistence.
2. **threeWayMerge()** (`three-way-merge.ts`) — Uses `diff-match-patch` to merge local and remote against the base. Returns merged text or signals overlap.
3. **diff engine** (`diff.ts`) — Myers' algorithm for line-level diffs, used by the conflict modal's visual diff display.

### Flow

```
conflict detected
  → baseStore.get(path) → has base content?
    → yes: threeWayMerge(base, local, remote)
      → clean merge: apply automatically, no modal
      → overlap: show conflict modal with diff view
    → no base: show conflict modal (can't 3-way merge without base)
```

### Edge Cases

- First sync has no base content — all conflicts go to modal
- BaseStore is updated after every successful push or pull
- If base content is stale (e.g., plugin was disabled during edits), merge may produce unexpected results — overlap detection catches most of these
