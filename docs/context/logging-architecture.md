# Logging Architecture & Planned Refactor

## Current State

Three-layer pattern in catch blocks (redundant):

```ts
console.error(`Engram Sync: failed to push ${file.path}`, e);  // layer 1
devLog().log("error", `push failed: ...`);                       // layer 2 (dev only, CDP)
rlog().error("push", `Push failed: ...`, e.stack);               // layer 3 (backend)
```

### Layers

- **`devLog()`** (`src/dev-log.ts`): In-memory ring buffer, CDP queryable via `__engramLog`, tree-shaken in production (DEV_MODE guard). Uses `console.debug` — hidden by default in Obsidian console (requires Verbose level).
- **`rlog()`** (`src/remote-log.ts`): Ships to backend `POST /logs` endpoint. Batched (30s timer + 20-entry threshold). Leveled: error/warn/info. Always active in production when configured.
- **`console.error`**: Direct browser console output — always visible. Added as a stopgap before rlog existed. Now redundant.

## Ecosystem Comparison

Most OSS Obsidian plugins (Templater, obsidian-git, Dataview) use raw `console.*` throughout with no abstraction. Engram's two-layer approach is already significantly more mature. No comparable plugin ships logs to a backend.

## The Problem

`console.error` is redundant now that rlog() covers production visibility. The only real gap: devLog() uses `console.debug` which requires Verbose mode in Obsidian DevTools to see. So errors aren't visible at normal console filter levels during local dev.

## Planned Refactor: Unified Logger

Replace three call sites with one. Create `src/logger.ts`:

```ts
import { devLog } from "./dev-log";
import { rlog } from "./remote-log";

class UnifiedLogger {
    error(cat: string, msg: string, err?: Error): void {
        devLog().error(cat, msg);   // DEV_MODE: console.error (always visible)
        rlog().error(cat, msg, err?.stack);
    }
    warn(cat: string, msg: string): void {
        devLog().warn(cat, msg);    // DEV_MODE: console.warn
        rlog().warn(cat, msg);
    }
    info(cat: string, msg: string): void {
        devLog().log(cat, msg);     // DEV_MODE: console.debug
        rlog().info(cat, msg);
    }
}

let _logger: UnifiedLogger | null = null;

export function initLogger(): UnifiedLogger {
    _logger = new UnifiedLogger();
    return _logger;
}

export function log(): UnifiedLogger {
    return _logger ?? new UnifiedLogger();
}
```

Also extend `devLog()` to support error/warn levels (not just `console.debug`):
- `devLog().error(cat, msg)` → writes to ring buffer + calls `console.error` in DEV_MODE
- `devLog().warn(cat, msg)` → writes to ring buffer + calls `console.warn` in DEV_MODE

### Call site change (everywhere in sync.ts, main.ts, etc.):

Before:
```ts
} catch (e) {
    // biome-ignore lint/suspicious/noConsole: error boundary
    console.error(`Engram Sync: failed to push ${file.path}`, e);
    devLog().log("error", `push failed: ${file.path} — ${e.message}`);
    rlog().error("push", `Push failed: ${file.path} — ${e.message}`, e.stack);
}
```

After:
```ts
} catch (e) {
    log().error("push", `Failed to push ${file.path}`, e instanceof Error ? e : undefined);
}
```

## Implementation Scope

Files to change:
- Create: `src/logger.ts`
- Modify: `src/dev-log.ts` — add error/warn methods using `console.error/warn`
- Modify: `src/main.ts` — replace ~7 triple-call patterns
- Modify: `src/sync.ts` — replace ~11 triple-call patterns
- Modify: `src/search-modal.ts`, `src/search-view.ts` — replace ~2 patterns
- Remove: all `// biome-ignore lint/suspicious/noConsole: error boundary` suppressions (no longer needed)

## Benefits

- One call per event instead of three
- `console.error` never appears in business logic
- Error-level events visible in Obsidian console without Verbose mode
- All biome-ignore suppressions for noConsole go away
- Logging behavior fully encapsulated — easy to add future destinations (Sentry, etc.)
