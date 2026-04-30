import { describe, expect, test } from "bun:test";
import { formatStatusLabel, nextToggleAvailable } from "../src/tabs/encryption-tab";
import type { VaultInfo } from "../src/types";

const baseVault: VaultInfo = {
	id: 1,
	name: "Personal",
	slug: "personal",
	is_default: true,
	created_at: "2026-04-01T00:00:00Z",
};

describe("formatStatusLabel", () => {
	test("maps each status to a label", () => {
		expect(formatStatusLabel("encrypted")).toBe("Encrypted at rest");
		expect(formatStatusLabel("encrypting")).toBe("Encrypting…");
		expect(formatStatusLabel("decrypt_pending")).toBe("Decryption scheduled");
		expect(formatStatusLabel("decrypting")).toBe("Decrypting…");
		expect(formatStatusLabel("none")).toBe("Not encrypted");
	});

	test("treats undefined as not encrypted", () => {
		expect(formatStatusLabel(undefined)).toBe("Not encrypted");
	});
});

describe("nextToggleAvailable", () => {
	test("returns null when vault is null", () => {
		expect(nextToggleAvailable(null)).toBeNull();
	});

	test("returns null when cooldown_days is unset", () => {
		const vault = { ...baseVault, last_toggle_at: "2026-04-30T00:00:00Z" };
		expect(nextToggleAvailable(vault)).toBeNull();
	});

	test("returns null when cooldown_days is zero", () => {
		const vault: VaultInfo = {
			...baseVault,
			last_toggle_at: "2026-04-30T00:00:00Z",
			cooldown_days: 0,
		};
		expect(nextToggleAvailable(vault)).toBeNull();
	});

	test("returns null when last_toggle_at is missing", () => {
		const vault: VaultInfo = { ...baseVault, cooldown_days: 7 };
		expect(nextToggleAvailable(vault)).toBeNull();
	});

	test("computes last_toggle_at + cooldown_days", () => {
		const vault: VaultInfo = {
			...baseVault,
			last_toggle_at: "2026-04-30T00:00:00Z",
			cooldown_days: 7,
		};
		const result = nextToggleAvailable(vault);
		expect(result).not.toBeNull();
		expect(result!.toISOString()).toBe("2026-05-07T00:00:00.000Z");
	});

	test("returns null on malformed timestamp", () => {
		const vault: VaultInfo = {
			...baseVault,
			last_toggle_at: "not-a-date",
			cooldown_days: 7,
		};
		expect(nextToggleAvailable(vault)).toBeNull();
	});
});
