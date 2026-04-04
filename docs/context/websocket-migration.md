# SSE to WebSocket Migration (v0.6.0)

## What Changed

Real-time sync moved from Server-Sent Events (SSE via `NoteStream` in `note-stream.ts`) to Phoenix WebSocket channels (`NoteChannel` in `channel.ts`).

## Why

- SSE required `fetch()` instead of `EventSource` because EventSource doesn't support custom Authorization headers
- Phoenix channels provide bidirectional communication, heartbeat/reconnect built-in
- Backend (Elixir/Phoenix) has native WebSocket support — SSE was a workaround

## Architecture

- `channel.ts` implements a minimal Phoenix protocol client (join, heartbeat, message dispatch)
- Connects to the backend's `/notes/ws` endpoint
- Subscribes to `note:changes` topic
- Echo suppression still works identically (markRecentlyPushed → skip incoming events for that path)

## Cleanup

- `note-stream.ts` deleted (was the SSE implementation)
- Dev-log still has `sse` category name (legacy, not renamed to avoid churn)
- Backend may still expose `/notes/stream` SSE endpoint for backward compat — plugin no longer uses it
