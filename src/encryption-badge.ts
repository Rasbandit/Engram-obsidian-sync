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
