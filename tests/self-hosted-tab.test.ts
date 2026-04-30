import { describe, expect, mock, test } from "bun:test";
import {
	type VaultSwitchTarget,
	applyVaultSwitch,
	describeListVaultsError,
	formatEncryptionRowLabel,
} from "../src/tabs/self-hosted-tab";
import type { VaultInfo } from "../src/types";

const baseVault: VaultInfo = {
	id: 1,
	name: "Personal",
	slug: "personal",
	is_default: true,
	created_at: "2026-04-01T00:00:00Z",
};

function makePlugin(initial: string | null): VaultSwitchTarget & {
	api: { setVaultId: ReturnType<typeof mock> };
	saveSettings: ReturnType<typeof mock>;
	refreshEncryptionStatus: ReturnType<typeof mock>;
} {
	return {
		settings: { vaultId: initial },
		api: { setVaultId: mock(() => {}) },
		saveSettings: mock(async () => {}),
		refreshEncryptionStatus: mock(() => {}),
	};
}

describe("applyVaultSwitch", () => {
	test("ignores empty value", async () => {
		const plugin = makePlugin("3");
		const changed = await applyVaultSwitch(plugin, "");
		expect(changed).toBe(false);
		expect(plugin.api.setVaultId).not.toHaveBeenCalled();
		expect(plugin.refreshEncryptionStatus).not.toHaveBeenCalled();
	});

	test("ignores no-op value (selecting the already-active vault)", async () => {
		const plugin = makePlugin("7");
		const changed = await applyVaultSwitch(plugin, "7");
		expect(changed).toBe(false);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.refreshEncryptionStatus).not.toHaveBeenCalled();
	});

	test("switches vault, persists, and refreshes encryption badge", async () => {
		// Regression for the multi-vault stale-badge bug surfaced in Codex
		// review: switching from an encrypted vault to an unencrypted one (or
		// vice-versa) used to leave the previous tenant's lock state on screen.
		// The badge MUST refresh on every successful switch.
		const plugin = makePlugin("3");
		const changed = await applyVaultSwitch(plugin, "9");

		expect(changed).toBe(true);
		expect(plugin.settings.vaultId).toBe("9");
		expect(plugin.api.setVaultId).toHaveBeenCalledWith("9");
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(plugin.refreshEncryptionStatus).toHaveBeenCalledTimes(1);
	});

	test("first-time switch from null vault still refreshes badge", async () => {
		const plugin = makePlugin(null);
		const changed = await applyVaultSwitch(plugin, "1");
		expect(changed).toBe(true);
		expect(plugin.refreshEncryptionStatus).toHaveBeenCalledTimes(1);
	});

	test("save persistence happens before badge refresh", async () => {
		// Refresh reads `api.getActiveVaultId()` (which we already updated via
		// `setVaultId`), but the badge tooltip is also derived from settings, so
		// we want save → refresh ordering to avoid the refresh racing against
		// half-applied state on slow disks.
		const order: string[] = [];
		const plugin: VaultSwitchTarget = {
			settings: { vaultId: "3" },
			api: {
				setVaultId: () => {
					order.push("setVaultId");
				},
			},
			saveSettings: async () => {
				order.push("saveSettings");
			},
			refreshEncryptionStatus: () => {
				order.push("refreshEncryptionStatus");
			},
		};

		await applyVaultSwitch(plugin, "9");

		expect(order).toEqual(["setVaultId", "saveSettings", "refreshEncryptionStatus"]);
	});
});

describe("formatEncryptionRowLabel", () => {
	test("returns null when vault is null (no active vault)", () => {
		expect(formatEncryptionRowLabel(null)).toBeNull();
	});

	test("undefined encryption_status defaults to 'not enabled' (legacy vault rows)", () => {
		// Vault rows that pre-date the encryption migration may still report
		// status: undefined from older servers — surface as "not enabled"
		// rather than a cryptic "?".
		const out = formatEncryptionRowLabel(baseVault);
		expect(out).not.toBeNull();
		expect(out!.label).toContain("not enabled");
	});

	test("encrypted shows enabled label", () => {
		const out = formatEncryptionRowLabel({ ...baseVault, encryption_status: "encrypted" });
		expect(out!.glyph).toBe("🔒");
		expect(out!.label).toContain("enabled");
	});

	test("encrypting shows enabling label", () => {
		const out = formatEncryptionRowLabel({ ...baseVault, encryption_status: "encrypting" });
		expect(out!.glyph).toBe("🔒…");
		expect(out!.label).toContain("enabling");
	});

	test("decrypt_pending shows scheduled label", () => {
		const out = formatEncryptionRowLabel({
			...baseVault,
			encryption_status: "decrypt_pending",
		});
		expect(out!.glyph).toBe("🔓⏳");
		expect(out!.label).toContain("scheduled");
	});

	test("decrypting shows disabling label", () => {
		const out = formatEncryptionRowLabel({ ...baseVault, encryption_status: "decrypting" });
		expect(out!.glyph).toBe("🔓…");
		expect(out!.label).toContain("disabling");
	});

	test("none shows not-enabled label with open lock", () => {
		const out = formatEncryptionRowLabel({ ...baseVault, encryption_status: "none" });
		expect(out!.glyph).toBe("🔓");
		expect(out!.label).toContain("not enabled");
	});
});

describe("describeListVaultsError", () => {
	test("401 → sign-in required", () => {
		expect(describeListVaultsError({ status: 401 })).toBe("Sign-in required to load vaults");
	});

	test("403 → sign-in required (forbidden surfaced same as 401)", () => {
		expect(describeListVaultsError({ status: 403 })).toBe("Sign-in required to load vaults");
	});

	test("5xx → server error with status", () => {
		expect(describeListVaultsError({ status: 500 })).toBe(
			"Server error (500) — check Engram logs",
		);
		expect(describeListVaultsError({ status: 503 })).toBe(
			"Server error (503) — check Engram logs",
		);
	});

	test("other 4xx → request failed with status", () => {
		expect(describeListVaultsError({ status: 404 })).toBe("Request failed (404)");
	});

	test("no status (timeout/network) → connection message", () => {
		expect(describeListVaultsError(new Error("ETIMEDOUT"))).toBe(
			"Could not reach Engram — check connection",
		);
		expect(describeListVaultsError(undefined)).toBe(
			"Could not reach Engram — check connection",
		);
	});
});
