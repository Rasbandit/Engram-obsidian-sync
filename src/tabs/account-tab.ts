import { Notice, Setting } from "obsidian";
import { PreSyncModal, WipeConfirmModal } from "../pre-sync-modal";
import type { TabContext } from "./types";

export function renderAccountTab(ctx: TabContext): void {
	const { containerEl, app, plugin, redisplay, startDeviceFlow, openProgressModal } = ctx;

	// ── Authentication ──
	const isOAuth = !!plugin.settings.refreshToken;
	const hasApiKey = !!plugin.settings.apiKey;

	new Setting(containerEl).setName("Authentication").setHeading();

	if (isOAuth) {
		new Setting(containerEl)
			.setName(`Signed in as ${plugin.settings.userEmail ?? "unknown"}`)
			.setDesc("Authenticated via Engram account (OAuth)")
			.addButton((btn) =>
				btn.setButtonText("Sign Out").onClick(async () => {
					await plugin.clearOAuthTokens();
					redisplay();
				}),
			);
	} else if (hasApiKey) {
		new Setting(containerEl)
			.setName("Using API key")
			.setDesc("Authenticated via manual API key")
			.addButton((btn) =>
				btn
					.setButtonText("Clear Key")
					.setWarning()
					.onClick(async () => {
						plugin.settings.apiKey = "";
						await plugin.saveSettings();
						redisplay();
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Switch to Sign In")
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
					.setButtonText("Sign In")
					.setCta()
					.onClick(() => startDeviceFlow()),
			);

		const details = containerEl.createEl("details", { cls: "engram-api-key-toggle" });
		details.createEl("summary", { text: "Use API key instead" });

		new Setting(details)
			.setName("API Key")
			.setDesc("Bearer token from Engram (starts with engram_)")
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

	// ── Connection (DEV: move to self-hosted-tab when cloud URL is hardcoded) ──
	new Setting(containerEl).setName("Connection").setHeading();

	new Setting(containerEl)
		.setName("Engram URL")
		.setDesc("Full URL to your Engram instance (e.g. http://10.0.20.214:8000)")
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
		.setDesc("Check if Engram is reachable and API key is valid")
		.addButton((btn) =>
			btn.setButtonText("Test").onClick(async () => {
				const { ok, error } = await plugin.api.ping();
				new Notice(ok ? "Engram: connected!" : `Engram: ${error}`);
			}),
		);

	// ── Vault Picker ──
	if (plugin.settings.apiKey || plugin.settings.refreshToken) {
		new Setting(containerEl).setName("Vault").setHeading();

		new Setting(containerEl)
			.setName("Sync vault")
			.setDesc("Select which vault this plugin syncs with")
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
						if (value && value !== plugin.settings.vaultId) {
							plugin.settings.vaultId = value;
							plugin.api.setVaultId(value);
							await plugin.saveSettings();
							redisplay();
						}
					});
				});
			});
	}

	// ── Actions ──
	new Setting(containerEl).setName("Actions").setHeading();

	new Setting(containerEl)
		.setName("Sync now")
		.setDesc("Pull remote changes and push local changes")
		.addButton((btn) =>
			btn.setButtonText("Sync").onClick(async () => {
				try {
					btn.setDisabled(true);
					const plan = await plugin.syncEngine.computeSyncPlan("full");
					const confirmed = await new PreSyncModal(app, plan).awaitConfirmation();
					if (!confirmed) {
						btn.setDisabled(false);
						return;
					}
					const progressModal = await openProgressModal();
					const { pulled, pushed } = await plugin.syncEngine.fullSync();
					const errors = plugin.syncEngine.syncLog?.errorCount() ?? 0;
					progressModal.update({
						phase: "complete",
						current: pulled + pushed,
						total: pulled + pushed,
						failed: errors,
					});
				} catch (e) {
					new Notice(`Engram Sync: ${e instanceof Error ? e.message : "sync failed"}`);
				} finally {
					btn.setDisabled(false);
				}
			}),
		);

	new Setting(containerEl)
		.setName("Push entire vault")
		.setDesc("Push all syncable files to Engram. Only needed for initial import.")
		.addButton((btn) =>
			btn
				.setButtonText("Push All")
				.setWarning()
				.onClick(async () => {
					try {
						btn.setDisabled(true);
						const plan = await plugin.syncEngine.computeSyncPlan("push-all");
						const confirmed = await new PreSyncModal(app, plan).awaitConfirmation();
						if (!confirmed) {
							btn.setDisabled(false);
							return;
						}
						await openProgressModal();
						await plugin.syncEngine.pushAll();
					} catch (e) {
						new Notice(
							`Engram Sync: ${e instanceof Error ? e.message : "push failed"}`,
						);
					} finally {
						btn.setDisabled(false);
					}
				}),
		);

	new Setting(containerEl)
		.setName("Pull all from server")
		.setDesc(
			"Pull every note and attachment from the server. Wipe & Pull deletes all local files first.",
		)
		.addButton((btn) =>
			btn
				.setButtonText("Pull All")
				.setWarning()
				.onClick(async () => {
					try {
						btn.setDisabled(true);
						const plan = await plugin.syncEngine.computeSyncPlan("pull-all");
						const action = await new PreSyncModal(app, plan, true).awaitPullAction();
						if (action === "cancel") {
							btn.setDisabled(false);
							return;
						}
						if (action === "wipe-pull") {
							const confirmed = await new WipeConfirmModal(
								app,
								plan.localNoteCount,
								plan.localAttachmentCount,
								plan.serverNoteCount,
							).awaitConfirmation();
							if (!confirmed) {
								btn.setDisabled(false);
								return;
							}
							await openProgressModal();
							await plugin.syncEngine.wipePullAll();
							return;
						}
						await openProgressModal();
						await plugin.syncEngine.pullAll();
					} catch (e) {
						new Notice(
							`Engram Sync: ${e instanceof Error ? e.message : "pull failed"}`,
						);
					} finally {
						btn.setDisabled(false);
					}
				}),
		);
}
