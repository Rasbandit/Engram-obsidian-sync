import { Notice, Setting, setIcon } from "obsidian";
import type { TabContext } from "./types";

export function renderSelfHostedTab(ctx: TabContext): void {
	const { containerEl, plugin, redisplay, startDeviceFlow } = ctx;

	// ── Setup ──
	new Setting(containerEl).setName("Setup").setHeading();

	const repoSetting = new Setting(containerEl)
		.setName("Engram server")
		.setDesc("Engram is the backend that powers sync and semantic search. Run it yourself:");
	repoSetting.descEl.createEl("br");
	repoSetting.descEl.createEl("a", {
		text: "github.com/Rasbandit/engram",
		href: "https://github.com/Rasbandit/engram",
	});

	new Setting(containerEl)
		.setName("Engram URL")
		.setDesc("Full URL to your Engram instance (e.g. http://10.0.20.214:8000).")
		.addText((text) =>
			text
				.setPlaceholder("http://localhost:8000")
				.setValue(plugin.settings.apiUrl)
				.onChange(async (value) => {
					plugin.settings.apiUrl = value;
					await plugin.saveSettings();
				}),
		);

	new Setting(containerEl)
		.setName("Test connection")
		.setDesc("Check if Engram is reachable and credentials are valid.")
		.addButton((btn) =>
			btn.setButtonText("Test").onClick(async () => {
				const { ok, error } = await plugin.api.ping();
				new Notice(ok ? "Engram: connected!" : `Engram: ${error}`);
			}),
		);

	// ── Authentication ──
	const isOAuth = !!plugin.settings.refreshToken;
	const hasApiKey = !!plugin.settings.apiKey;

	new Setting(containerEl).setName("Authentication").setHeading();

	if (isOAuth) {
		new Setting(containerEl)
			.setName(`Signed in as ${plugin.settings.userEmail ?? "unknown"}`)
			.setDesc("Authenticated via Engram account (OAuth).")
			.addButton((btn) =>
				btn.setButtonText("Sign out").onClick(async () => {
					await plugin.clearOAuthTokens();
					redisplay();
				}),
			);
	} else if (hasApiKey) {
		new Setting(containerEl)
			.setName("Using API key")
			.setDesc("Authenticated via manual API key.")
			.addButton((btn) =>
				btn
					.setButtonText("Clear key")
					.setWarning()
					.onClick(async () => {
						plugin.settings.apiKey = "";
						await plugin.saveSettings();
						redisplay();
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Switch to sign in")
					.setCta()
					.onClick(async () => {
						plugin.settings.apiKey = "";
						await plugin.saveSettings();
						startDeviceFlow();
					}),
			);
	} else {
		new Setting(containerEl)
			.setName("Sign in with Engram")
			.setDesc("Links your Obsidian vault to your Engram account. Opens a browser window.")
			.addButton((btn) =>
				btn
					.setButtonText("Sign in")
					.setCta()
					.onClick(() => startDeviceFlow()),
			);

		const details = containerEl.createEl("details", { cls: "engram-api-key-toggle" });
		details.createEl("summary", { text: "Use API key instead" });

		new Setting(details)
			.setName("API key")
			.setDesc("Bearer token from Engram (starts with engram_).")
			.addText((text) => {
				text.setPlaceholder("engram_abc123...")
					.setValue(plugin.settings.apiKey)
					.onChange(async (value) => {
						plugin.settings.apiKey = value;
						await plugin.saveSettings();
					});
				text.inputEl.type = "password";
				text.inputEl.addClass("engram-api-key-input");
			});
	}

	// ── Vault ──
	if (plugin.settings.apiKey || plugin.settings.refreshToken) {
		new Setting(containerEl).setName("Vault").setHeading();

		new Setting(containerEl)
			.setName("Sync vault")
			.setDesc("Select which vault this plugin syncs with.")
			.addDropdown((dropdown) => {
				dropdown.addOption("", "Loading vaults...");
				dropdown.setDisabled(true);

				plugin.api.listVaults().then((vaults) => {
					dropdown.selectEl.empty();
					if (vaults.length === 0) {
						dropdown.addOption("", "No vaults found — first sync will create one");
					} else {
						for (const v of vaults) {
							const label = v.is_default ? `${v.name} (default)` : v.name;
							dropdown.addOption(String(v.id), label);
						}
					}
					dropdown.setDisabled(false);

					if (plugin.settings.vaultId) {
						dropdown.setValue(plugin.settings.vaultId);
					}

					dropdown.onChange(async (value) => {
						if (await applyVaultSwitch(plugin, value)) redisplay();
					});
				});
			});
	}

	// ── Support development ──
	new Setting(containerEl).setName("Support development").setHeading();

	const supportSetting = new Setting(containerEl).setDesc(
		"If this plugin saves you time, consider supporting development.",
	);

	const kofiLink = supportSetting.controlEl.createEl("a", {
		cls: "engram-kofi-button",
		href: "https://ko-fi.com/rasbandit",
		attr: { target: "_blank", rel: "noopener" },
	});
	const iconSpan = kofiLink.createSpan({ cls: "engram-kofi-icon" });
	setIcon(iconSpan, "coffee");
	kofiLink.createSpan({ text: "Support on Ko-fi" });
}

/** Subset of EngramSyncPlugin used by `applyVaultSwitch`. Defined here so the
 *  helper is unit-testable without dragging in the Obsidian DOM stack. */
export interface VaultSwitchTarget {
	settings: { vaultId: string | null };
	api: { setVaultId: (id: string | null) => void };
	saveSettings: () => Promise<void>;
	refreshEncryptionStatus: () => void | Promise<void>;
}

/**
 * Apply a user-driven vault switch. Returns `true` if the active vault
 * actually changed (caller should redisplay). Encryption state is per-vault,
 * so the badge MUST be refreshed on every successful switch — leaving the
 * prior tenant's lock state on screen is a security-indicator bug, not just
 * cosmetic drift.
 */
export async function applyVaultSwitch(plugin: VaultSwitchTarget, value: string): Promise<boolean> {
	if (!value || value === plugin.settings.vaultId) return false;
	plugin.settings.vaultId = value;
	plugin.api.setVaultId(value);
	await plugin.saveSettings();
	void plugin.refreshEncryptionStatus();
	return true;
}
