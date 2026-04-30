# Context Doc: Encryption User Guide (Plugin Side)

_Last verified: 2026-04-30 — plugin v1.1.3_

## Status
Live. Encryption tab + persistent status row + status-bar badge ship in v1.1.0+. Decrypt-and-cancel UX guarded by a 24-hour window enforced server-side.

## What This Is
The user-facing copy and behaviors the plugin exposes for encryption-at-rest, plus a bug-triage cheat sheet for support questions that come in by way of the plugin (not the server).

## What the User Sees

### Status bar lock badge
- 🔒 — vault encrypted at rest
- 🔒… — encrypting (tooltip shows N/M progress)
- 🔓 — vault not encrypted
- 🔓⏳ — decryption scheduled (cancel within 24h)
- 🔓… — decrypting (tooltip shows N/M progress)
- _hidden_ — no vault selected, signed out, or status unknown (used to be "🔓?", removed in 1.1.3)

Click → opens the Encryption settings tab.

### Persistent encryption status row
Above the settings tab bar, alongside the connection-status dot. One-line summary:
- "🔒 Encryption: enabled (at rest)"
- "🔓 Encryption: not enabled"
- "🔒… Encryption: enabling…"
- "🔓⏳ Encryption: decryption scheduled"
- "🔓… Encryption: disabling…"

Click anywhere on the row → opens the Encryption tab. Hidden when not signed in or no vault selected.

### Encryption tab
- Live status with `encrypted_at` timestamp, in-flight progress (N of M notes), decrypt-pending countdown.
- Action button matches state: "Enable encryption" / "Disable encryption" / "Cancel decryption" / disabled-while-in-flight.
- Confirmation modal requires the user to type the vault name before the destructive button enables. Same UX for enable and disable to preserve the gravity.

## The 24-Hour Decrypt Window

When a user clicks "Disable encryption":
1. Plugin POSTs `/api/vaults/:id/decrypt`.
2. Server transitions the vault to `decrypt_pending` and stamps `decrypt_requested_at`.
3. **No data is decrypted yet.** The vault sits in `decrypt_pending` for 24h.
4. Within those 24h, the user can click "Cancel decryption" → DELETE `/api/vaults/:id/decrypt` → vault returns to `encrypted` without consuming a cooldown cycle.
5. After 24h, server-side cron (or explicit user action) flips to `decrypting`, kicks the `DecryptVault` Oban worker, and the vault eventually returns to `none`.

**Why the delay:** prevents accidental destructive decryption — encryption is opt-in, but disabling is irreversibly visible to the server, so we give the user time to back out. The grace window is intentional, not a bug.

The plugin polls `/encryption_progress` at 60s during `decrypt_pending` so the badge catches the autonomous transition without manual refresh. Encrypting/decrypting in-flight states poll at 5s for live N/M counts.

## Cooldown Behavior

If the operator has set `encryption_toggle_cooldown_days` for the user (default: NULL = no cooldown), the server returns `429` with an ISO-8601 `retry_after` body when a second toggle would land inside the window.

The plugin reads `cooldown_days` from the vault JSON and surfaces "Next toggle available <date>" in the Encryption tab so the user doesn't need to attempt-and-fail to discover the limit. On a 429, the modal copy includes the parsed `retry_after`.

Self-hosted users default to NULL — no cooldown — which is the documented design intent. Don't add a self-hosted cooldown without explicit operator opt-in.

## What's NOT Encrypted Today

The current implementation encrypts **note bodies only**. Attachments (images, PDFs, binaries) are stored plaintext in both Postgres and the object store. Vaults with attachments are not "fully encrypted at rest" until Phase 7 ships — flag this in support if it matters.

## Triage Cheat Sheet

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Badge shows "🔒…" forever | Backfill worker stuck or discarded | Server-side: check `oban_jobs` for the user's vault. See `backend/docs/context/encryption-operations.md`. |
| Badge missing entirely on signed-in vault | First-load before refresh OR `getEncryptionProgress` failing | Reload Obsidian; if persistent, check server `/api/vaults/:id/encryption_progress` returns 200. |
| "Sign-in required to load vaults" in status row | Stale OAuth tokens | User clicks "Sign in" on the self-hosted tab. |
| 429 on every toggle | Operator-set cooldown still in effect | Check the `retry_after` date in the modal Notice. |
| Decrypt countdown doesn't progress | 24h window hasn't elapsed | Expected — cancel-or-wait UX is intentional. |
| Cancel decrypt does nothing | Already past the 24h window | Server has moved to `decrypting`; user must wait for it to complete then re-toggle. |

## References

- Backend operator runbook: `backend/docs/context/encryption-operations.md`
- Plugin internals: `plugin/docs/internals.md` (search for `encryption-tab`, `encryption-badge`)
- Status row + badge: `src/settings.ts`, `src/encryption-badge.ts`, `src/main.ts`
