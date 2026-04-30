import { describe, expect, test } from "bun:test";
import { chooseEncryptionPollInterval, describeEncryptionBadge } from "../src/encryption-badge";

describe("describeEncryptionBadge", () => {
	test("encrypted shows lock + plain tooltip", () => {
		const out = describeEncryptionBadge("encrypted");
		expect(out.glyph).toBe("🔒");
		expect(out.tooltip).toContain("encrypted at rest");
	});

	test("encrypting shows lock + ellipsis and progress in tooltip", () => {
		const out = describeEncryptionBadge("encrypting", { processed: 4, total: 12 });
		expect(out.glyph).toBe("🔒…");
		expect(out.tooltip).toContain("4/12");
	});

	test("encrypting without progress falls back gracefully", () => {
		const out = describeEncryptionBadge("encrypting");
		expect(out.glyph).toBe("🔒…");
		expect(out.tooltip).toBe("Encrypting vault");
	});

	test("decrypt_pending warns about cancellable window", () => {
		const out = describeEncryptionBadge("decrypt_pending");
		expect(out.glyph).toBe("🔓⏳");
		expect(out.tooltip).toContain("cancel within 24h");
	});

	test("decrypting shows hourglass-free in-flight glyph", () => {
		const out = describeEncryptionBadge("decrypting", { processed: 1, total: 3 });
		expect(out.glyph).toBe("🔓…");
		expect(out.tooltip).toContain("1/3");
	});

	test("none shows open lock", () => {
		const out = describeEncryptionBadge("none");
		expect(out.glyph).toBe("🔓");
		expect(out.tooltip).toBe("Vault not encrypted");
	});

	test("null status returns empty glyph so caller can hide the badge", () => {
		// Used to render "🔓?" + "unknown" on first-load before refresh, after
		// sign-out, and when no vault is selected — which read as a security
		// indicator failure to users. Empty glyph + display:none in the caller
		// keeps the status bar clean until we have a real status.
		const out = describeEncryptionBadge(null);
		expect(out.glyph).toBe("");
		expect(out.tooltip).toBe("");
	});
});

describe("chooseEncryptionPollInterval", () => {
	test("encrypting polls at 5s for live N/M progress", () => {
		expect(chooseEncryptionPollInterval("encrypting")).toBe(5_000);
	});

	test("decrypting polls at 5s for live N/M progress", () => {
		expect(chooseEncryptionPollInterval("decrypting")).toBe(5_000);
	});

	test("decrypt_pending polls at 60s — server transitions autonomously after 24h", () => {
		// Regression: was previously null, so the badge stayed on
		// "Decryption scheduled — cancel within 24h" indefinitely after the
		// server moved on. 60s catches the encrypted→decrypting transition
		// without spamming an idle endpoint.
		expect(chooseEncryptionPollInterval("decrypt_pending")).toBe(60_000);
	});

	test("encrypted is terminal — no poll", () => {
		expect(chooseEncryptionPollInterval("encrypted")).toBeNull();
	});

	test("none is terminal — no poll", () => {
		expect(chooseEncryptionPollInterval("none")).toBeNull();
	});

	test("null status — no poll", () => {
		expect(chooseEncryptionPollInterval(null)).toBeNull();
	});
});
