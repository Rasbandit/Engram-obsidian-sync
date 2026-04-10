# Engram Sync

Bidirectional sync between your Obsidian vault and an [Engram](https://github.com/Rasbandit/engram) server. Push notes for AI-powered semantic search, pull notes created via MCP or other devices back into your vault.

## Features

- **Bidirectional sync** — vault changes push to Engram automatically; remote changes pull back on startup and periodically.
- **Semantic search** — search your notes by meaning, not just keywords, using Engram's vector search. Available via command palette or a dedicated sidebar view.
- **Conflict resolution** — 3-way merge with an interactive side-by-side diff modal, or automatic conflict-copy creation.
- **Offline queue** — edits made while offline are queued and synced when connectivity returns.
- **Ignore patterns** — configurable glob patterns to exclude files and folders from sync. Automatically detects and warns about problematic directories (node_modules, .venv, etc.).
- **Real-time updates** — optional WebSocket channel for instant push/pull without polling.
- **OAuth and API key auth** — authenticate via device flow OAuth or a static API key.

## Requirements

- An [Engram](https://github.com/Rasbandit/engram) server instance (self-hosted).
- An API key or OAuth credentials for your Engram instance.

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

## Configuration

1. Open **Settings → Engram Sync**.
2. Enter your **Engram URL** (e.g. `http://your-server:8000`).
3. Authenticate using one of:
   - **OAuth** — click "Sign in with Engram" and follow the device flow.
   - **API key** — paste your Engram API key directly.
4. Optionally configure ignore patterns, debounce delay, and conflict resolution mode.

## Commands

| Command | Description |
|---------|-------------|
| Semantic search | Open a search modal to query your notes by meaning. |
| Open search sidebar | Open Engram search as a persistent sidebar view. |

## Disclosures

### Network use

This plugin communicates with a self-hosted Engram server that you configure. All note content is sent to your Engram instance for indexing and search. No data is sent to any third-party service. The plugin does not phone home or contact any external servers beyond the Engram URL you provide.

### Account required

An Engram server account (self-hosted) is required. You must provide either an API key or authenticate via OAuth to use this plugin.

### Remote logging

The plugin includes an optional remote logging feature (disabled by default) that sends sync lifecycle events and errors to your Engram server for debugging. This can be toggled in settings.

### No telemetry

This plugin does not collect or transmit any telemetry, analytics, or usage data.

## License

[MIT](LICENSE)
