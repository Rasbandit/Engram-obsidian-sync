## Engram Operations — Quick Reference

### Connection / Auth

| Path | What | How it's used |
|------|------|---------------|
| `.env` (project root, gitignored) | `ENGRAM_API_URL`, `ENGRAM_API_KEY` | Source this to curl endpoints directly |
| Obsidian plugin settings | Same URL + key | Configured in Obsidian UI, stored in `data.json` (gitignored) |
| `api_keys` table (engram-postgres) | SHA256 hashes only | Cannot retrieve raw keys from DB — user must provide |

**Test connectivity:**
```bash
source .env
curl -s "$ENGRAM_API_URL/health/deep"
curl -s "$ENGRAM_API_URL/search" -X POST -H "Authorization: Bearer $ENGRAM_API_KEY" -H "Content-Type: application/json" -d '{"query":"test","limit":1}'
```

**If the key is lost:** User must log into Engram web UI (`http://10.0.20.214:8000/login`) and create a new API key. Update `.env` and Obsidian plugin settings.

### Infrastructure Map

| Entity | Address | Access |
|--------|---------|--------|
| Engram API | `10.0.20.214:8000` | HTTP, `Authorization: Bearer engram_...` |
| FastRaid SSH | `root@10.0.20.214` | SSH key auth |
| PostgreSQL | `engram-postgres:5432` | Via `docker exec` only (not exposed) |
| Redis | `engram-redis:6379` | Via `docker exec` only (not exposed) |
| Qdrant | `qdrant:6333` | Internal to `ai` network |
| Ollama | `ollama:11434` (aka `10.0.20.214:11434`) | Internal to `ai` network |
| Jina Reranker | `jina-reranker:8082` (aka `10.0.20.214:8082`) | Internal to `ai` network |
| Obsidian Vault | `~/Obsidian Vault/` | Local filesystem |
| Plugin deploy path | `~/Obsidian Vault/.obsidian/plugins/engram-sync/` | `cp main.js manifest.json styles.css` here |
| Backend repo | `/home/open-claw/documents/code-projects/engram/` | Read-only reference |

### Common Operations

**Check server logs for errors:**
```bash
ssh root@10.0.20.214 "docker logs engram --tail 100 2>&1" | grep -i "error\|traceback\|500"
```

**Follow logs in real-time (while reproducing a bug):**
```bash
ssh root@10.0.20.214 "docker logs engram -f --tail 5"
```

**Filter logs for a specific endpoint:**
```bash
ssh root@10.0.20.214 "docker logs engram --tail 500 2>&1" | grep "POST /search"
```

**Check container health:**
```bash
ssh root@10.0.20.214 "docker ps --filter name=engram"
```

**Restart engram (if hung or misbehaving):**
```bash
ssh root@10.0.20.214 "docker restart engram"
```

**Run SQL queries:**
```bash
ssh root@10.0.20.214 "docker exec engram-postgres psql -U engram -d engram -c 'SELECT count(*) FROM notes WHERE deleted_at IS NULL'"
```

**Test any endpoint with auth:**
```bash
source .env
curl -s "$ENGRAM_API_URL/<endpoint>" -H "Authorization: Bearer $ENGRAM_API_KEY" -H "Content-Type: application/json" -d '<json>'
```

**Build + deploy to local vault:**
```bash
npm run build && cp main.js manifest.json styles.css ~/Obsidian\ Vault/.obsidian/plugins/engram-sync/
```

**Full release (what "deploy" means):**
Version bump (package.json + manifest.json + versions.json) → `npm run build` → commit → merge to main → `git tag -a vX.Y.Z` → `git push origin main --tags` → `gh release create vX.Y.Z main.js manifest.json styles.css` → copy to local vault.

### Debugging Workflow

1. **Plugin shows error** → check server logs first (`docker logs engram`)
2. **No server-side error** → issue is client-side (Obsidian dev console: Ctrl+Shift+I)
3. **Endpoint returns error** → curl it directly with `.env` creds to isolate
4. **Auth issue (401/403)** → verify key works: `curl $ENGRAM_API_URL/folders -H "Authorization: Bearer $ENGRAM_API_KEY"`
5. **Search returns 0 results** → check Qdrant: `curl -s $ENGRAM_API_URL/health/deep` (look for qdrant status)
6. **Rerank scores are 0.0** → Jina may be down: check `health/deep` for jina status, or search still works (vector-only fallback)

### Database Schema (Quick Ref)

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `notes` | `user_id text, path, title, content, folder, tags text[], mtime, deleted_at` | `UNIQUE(user_id, path)` |
| `attachments` | `user_id, path, content bytea, mime_type, size_bytes, mtime, deleted_at` | `UNIQUE(user_id, path)` |
| `users` | `id serial, email unique, password_hash, display_name` | bcrypt |
| `api_keys` | `id, user_id FK, key_hash text, name` | SHA256 hash, raw key never stored |

### Obsidian Remote Debugging (CDP)

Obsidian exposes Chrome DevTools Protocol when launched with `--remote-debugging-port`.
A project-scoped MCP server (`obsidian-devtools`) connects to it for runtime inspection.

**Port assignments:**

| App | Debug Port | MCP Server |
|-----|-----------|------------|
| Obsidian | 9222 | `obsidian-devtools` (project-scoped) |
| Headless Chrome | 9224 | `chrome-devtools` (global) |

**Key quirk:** When launching Obsidian from an SSH or headless shell, you must set `DISPLAY=:0` or CDP won't bind. The desktop launcher inherits this from the graphical session automatically. The `--remote-debugging-port` flag works as expected — Obsidian binds to the specified port. (2026-03, corrected)

**Launch config:** `~/.local/share/applications/obsidian.desktop` has `--remote-debugging-port=9222` in the Exec line. The flag must be present to enable CDP — without it, no debug server starts.

**CLI launch:** `DISPLAY=:0 /home/open-claw/Applications/Obsidian.AppImage --no-sandbox --remote-debugging-port=9222`

**Verify it's working:**
```bash
curl -s http://127.0.0.1:9222/json/version   # Should return Chrome/Electron version info
curl -s http://127.0.0.1:9222/json/list       # Lists inspectable pages
```

**MCP config location:** `~/.claude.json` → project section for engram-obsidian-sync → `mcpServers.obsidian-devtools`

### Obsidian DevTools MCP — Capabilities

The `obsidian-devtools` MCP server exposes 27 tools for interacting with the running Obsidian instance via CDP. Grouped by use case:

#### Inspection & Snapshots

| Tool | Purpose |
|------|---------|
| `take_snapshot` | A11y-tree text snapshot of the current page — lists all elements with UIDs for interaction. **Prefer this over screenshots.** |
| `take_screenshot` | Visual screenshot (PNG/JPEG/WebP). Can target a specific element by UID or capture full page. |
| `list_pages` | List all open pages/tabs in Obsidian's Electron renderer. |
| `select_page` | Switch context to a specific page (by ID from `list_pages`). |

#### JavaScript Execution

| Tool | Purpose |
|------|---------|
| `evaluate_script` | Run arbitrary JS in Obsidian's renderer process. Access `app`, `app.vault`, `app.workspace`, plugin APIs, DOM, etc. Return value must be JSON-serializable. |

**This is the most powerful tool.** Examples:
- `() => app.vault.getFiles().length` — count vault files
- `() => app.plugins.plugins` — list loaded plugins
- `() => app.workspace.activeLeaf?.view?.getViewType()` — get active view type
- `() => app.vault.adapter.read("path/to/note.md")` — read a file via Obsidian's API
- `() => { const p = app.plugins.plugins["engram-sync"]; return p?.settings; }` — inspect plugin settings at runtime

#### UI Interaction

| Tool | Purpose |
|------|---------|
| `click` | Click an element by UID (from snapshot). Supports double-click. |
| `hover` | Hover over an element by UID. |
| `fill` | Type into an input/textarea or select from a `<select>`. |
| `fill_form` | Fill multiple form elements at once. |
| `type_text` | Type text via keyboard into a focused input. |
| `press_key` | Press keys/combos (e.g., `Enter`, `Control+P`, `Control+Shift+R`). |
| `drag` | Drag one element onto another. |
| `handle_dialog` | Accept or dismiss browser dialogs (confirm/alert/prompt). |
| `upload_file` | Upload a file through a file input element. |
| `wait_for` | Block until specified text appears on the page. |

#### Console & Debugging

| Tool | Purpose |
|------|---------|
| `list_console_messages` | List all console messages (filterable by type: log, error, warn, etc.). |
| `get_console_message` | Get details of a specific console message by ID. |

**Key for debugging:** Filter for `error` and `warn` types to catch plugin exceptions, failed API calls, or deprecation warnings at runtime.

#### Performance & Memory

| Tool | Purpose |
|------|---------|
| `performance_start_trace` | Start a Chrome performance trace (find bottlenecks, Core Web Vitals). |
| `performance_stop_trace` | Stop trace, save to `.json.gz`. |
| `performance_analyze_insight` | Drill into specific performance insights from a trace. |
| `take_memory_snapshot` | Capture a heap snapshot (`.heapsnapshot`) for memory leak debugging. |
| `lighthouse_audit` | Run Lighthouse for accessibility, SEO, best practices (not performance). |

#### Page Control

| Tool | Purpose |
|------|---------|
| `navigate_page` | Navigate to URL, go back/forward, or reload. |
| `new_page` | Open a new tab with a URL. |
| `close_page` | Close a tab by ID. |
| `resize_page` | Resize the window to specific dimensions. |
| `emulate` | Emulate dark/light mode, viewports, network throttling, CPU throttling. |

### Practical Workflows

**1. Debug plugin at runtime:**
```
take_snapshot → find plugin UI elements
evaluate_script → inspect plugin state (settings, sync status, timers)
list_console_messages(types: ["error"]) → check for exceptions
```

**2. Test plugin UI after deploy:**
```
take_snapshot → find settings tab or sync status elements
click → navigate to plugin settings
fill → change a setting value
take_screenshot → capture result for verification
```

**3. Investigate sync issues:**
```
evaluate_script → check app.plugins.plugins["engram-sync"] internals
evaluate_script → read lastSync, pending queue, connection state
list_console_messages → look for failed HTTP requests or errors
```

**4. Performance profiling:**
```
performance_start_trace → trigger sync operation → performance_stop_trace
performance_analyze_insight → identify bottlenecks
take_memory_snapshot → check for leaks during long sessions
```

### Limitations

- **Cannot reload/restart the Obsidian plugin** — user must toggle it off/on in Settings → Community Plugins (but `evaluate_script` can call `app.plugins.disablePlugin()` / `app.plugins.enablePlugin()` to automate this)
- **Cannot retrieve API keys from the database** — only SHA256 hashes are stored; user must provide the raw key
- **`evaluate_script` return values must be JSON-serializable** — cannot return functions, circular refs, or DOM nodes directly
- **Obsidian must be running with CDP enabled** — if Obsidian is closed or launched without `--remote-debugging-port`, all tools fail
- **Jina reranker may be offline** — search still works (vector-only), but scores won't have rerank component
