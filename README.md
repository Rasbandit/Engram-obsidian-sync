# Engram Sync

Bidirectional sync between your Obsidian vault and an [Engram](https://github.com/Rasbandit/engram) server, with AI-powered semantic search.

> **Engram is required.** This plugin is a sync client — it does not run AI locally. You need access to an Engram instance, either self-hosted or via a hosted plan (coming soon). Without an Engram server, this plugin does nothing.

## What it does

- **Bidirectional sync** — vault changes push to Engram automatically; remote changes pull back on startup and periodically.
- **Semantic search** — search your notes by meaning, not just keywords, via Engram's vector search. Available from the command palette or a dedicated sidebar view.
- **Conflict resolution** — 3-way merge with an interactive side-by-side diff modal, or automatic conflict-copy creation.
- **Offline queue** — edits made while offline are queued and synced when connectivity returns.
- **Real-time updates** — optional WebSocket channel for instant push/pull without polling.
- **Ignore patterns** — configurable glob patterns to exclude files and folders. Auto-detects and warns about problematic directories (`node_modules`, `.venv`, etc.).
- **OAuth and API key auth** — authenticate via device flow OAuth or a static API key.
- **Mobile and desktop** — works on both. No Node.js or filesystem dependencies.

## What it does NOT do

- Generate embeddings, parse markdown, or run any AI model locally — Engram handles all of that on the server.
- Talk to OpenAI, Anthropic, or any third-party AI service. The plugin only talks to your configured Engram server.
- Phone home, collect telemetry, or contact any analytics service.

## Privacy and data flow

```
Obsidian vault  ⇄  Engram Sync (this plugin)  ⇄  Your Engram server  →  Qdrant + Ollama (on your server)
```

All note content is sent to the Engram URL you configure. Nothing is sent to any third party. The plugin includes an optional remote-logging feature (default OFF) that sends sync lifecycle events back to your own Engram server for debugging.

## Installation

### From Obsidian Community Plugins

1. Open **Settings → Community plugins**.
2. Search for **Engram Sync**.
3. Click **Install**, then **Enable**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Rasbandit/Engram-obsidian-sync/releases/latest).
2. Create a folder at `<your vault>/.obsidian/plugins/engram-sync/`.
3. Copy the three files into that folder.
4. Restart Obsidian and enable the plugin in **Settings → Community plugins**.

### BRAT (beta channel)

For pre-release builds, install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add `Rasbandit/Engram-obsidian-sync`.

## Configuration

1. Open **Settings → Engram Sync**.
2. Enter your **Engram URL** (e.g. `http://your-server:8000`).
3. Authenticate via one of:
   - **OAuth** — click "Sign in with Engram" and follow the device flow.
   - **API key** — paste your Engram API key directly.
4. Optionally configure ignore patterns, debounce delay, and conflict resolution mode.

## Commands

| Command | What it does |
|---------|--------------|
| Engram: Sync now | Push pending changes and pull remote changes immediately. |
| Engram: Push entire vault | Force push every syncable file to Engram. |
| Engram: Pull all from server | Download all notes from Engram into the vault. |
| Engram: Check sync status | Compare local and remote state, report drift. |
| Engram: Show sync log | Open the in-app sync log modal. |
| Engram: Semantic search | Open a modal to search notes by meaning. |
| Engram: Open search sidebar | Open Engram search as a persistent sidebar view. |

## Conflict resolution

When the same note changes both locally and remotely between syncs, the plugin runs a 3-way merge using `diff-match-patch`. If both sides edited disjoint regions, the merge applies cleanly. If they overlap, the plugin opens a side-by-side diff modal where you pick a resolution per hunk. You can also configure automatic "conflict-copy" creation so neither version is lost.

## Troubleshooting

| Symptom | Things to check |
|---------|-----------------|
| Sync silently fails | Verify the Engram URL is reachable from your device and the API key/OAuth token is valid. Open the sync log (`Engram: Show sync log`). |
| Files not syncing | Check ignore patterns in settings. Files matching any pattern are skipped. |
| Conflicts every sync | Likely a clock-skew issue between client and server. Check both system clocks. |
| Plugin won't load on mobile | This shouldn't happen — file an issue with the desktop/mobile flag and Obsidian version. |
| OAuth sign-in fails | Confirm the Engram server has OAuth enabled. Falls back to API key. |

## Disclosures

- **Network use** — communicates only with the Engram URL you configure. No third-party services.
- **Account required** — you must provide an API key or OAuth credentials for your Engram instance.
- **Remote logging** — opt-in feature, default OFF, sends only to your own Engram server.
- **Telemetry** — none.

## Funding

If this plugin saves you time, you can [buy me a coffee on Ko-fi](https://ko-fi.com/rasbandit). Optional and appreciated.

## Attribution

This plugin uses [diff-match-patch](https://github.com/google/diff-match-patch) by Google for 3-way merge conflict resolution, licensed under Apache 2.0.

## License

[MIT](LICENSE)
