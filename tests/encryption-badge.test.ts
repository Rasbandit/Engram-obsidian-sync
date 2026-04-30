import { describe, expect, test } from "bun:test";
import { describeEncryptionBadge } from "../src/encryption-badge";

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

	test("null status shows unknown", () => {
		const out = describeEncryptionBadge(null);
		expect(out.glyph).toBe("🔓?");
		expect(out.tooltip).toContain("unknown");
	});
});
