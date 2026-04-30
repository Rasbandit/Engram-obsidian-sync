import { describe, expect, mock, test } from "bun:test";
import { type VaultSwitchTarget, applyVaultSwitch } from "../src/tabs/self-hosted-tab";

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
