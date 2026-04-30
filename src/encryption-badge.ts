import type { VaultEncryptionStatus } from "./types";

/** Pure mapping from encryption status → status-bar glyph + tooltip. */
export function describeEncryptionBadge(
	status: VaultEncryptionStatus | null,
	progress?: { processed: number; total: number },
): { glyph: string; tooltip: string } {
	switch (status) {
		case "encrypted":
			return { glyph: "🔒", tooltip: "Vault encrypted at rest" };
		case "encrypting": {
			const counts = progress ? ` — ${progress.processed}/${progress.total} notes` : "";
			return { glyph: "🔒…", tooltip: `Encrypting vault${counts}` };
		}
		case "decrypt_pending":
			return {
				glyph: "🔓⏳",
				tooltip: "Decryption scheduled — cancel within 24h",
			};
		case "decrypting": {
			const counts = progress ? ` — ${progress.processed}/${progress.total} notes` : "";
			return { glyph: "🔓…", tooltip: `Decrypting vault${counts}` };
		}
		case "none":
			return { glyph: "🔓", tooltip: "Vault not encrypted" };
		default:
			return { glyph: "🔓?", tooltip: "Encryption status unknown" };
	}
}

/**
 * Decide how often the client should re-poll `/encryption_progress`. Returns
 * an interval in ms, or `null` to stop polling.
 *
 * - `encrypting`/`decrypting`: server is mutating the vault, poll every 5s so
 *   the badge tracks N/M counts.
 * - `decrypt_pending`: server is idle until the 24h cancellable window ends,
 *   then transitions to `decrypting` autonomously. Poll at 60s — slow enough
 *   not to spam, fast enough that the badge catches the transition without a
 *   manual refresh.
 * - everything else (`encrypted`, `none`, `null`): no transition is pending,
 *   stop polling.
 */
export function chooseEncryptionPollInterval(status: VaultEncryptionStatus | null): number | null {
	switch (status) {
		case "encrypting":
		case "decrypting":
			return 5_000;
		case "decrypt_pending":
			return 60_000;
		default:
			return null;
	}
}
