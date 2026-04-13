/**
 * Settings tab for Engram Sync plugin.
 */
import { type App, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import { DeviceFlowModal } from "./device-flow-modal";
import type EngramSyncPlugin from "./main";

/** Directories that should never be synced — detect and warn if found in vault. */
const PROBLEMATIC_DIRS = [
	{ pattern: "node_modules/", label: "node_modules", desc: "Node.js dependencies" },
	{ pattern: ".venv/", label: ".venv", desc: "Python virtual environment" },
	{ pattern: "venv/", label: "venv", desc: "Python virtual environment" },
	{ pattern: "__pycache__/", label: "__pycache__", desc: "Python bytecode cache" },
	{ pattern: "vendor/", label: "vendor", desc: "Vendored dependencies" },
	{ pattern: ".gradle/", label: ".gradle", desc: "Gradle build cache" },
	{ pattern: "target/", label: "target", desc: "Rust/Java build output" },
	{ pattern: "build/", label: "build", desc: "Build output" },
	{ pattern: ".next/", label: ".next", desc: "Next.js build output" },
	{ pattern: "dist/", label: "dist", desc: "Distribution build output" },
	{ pattern: ".cargo/", label: ".cargo", desc: "Cargo cache" },
	{ pattern: "Pods/", label: "Pods", desc: "CocoaPods dependencies" },
	{ pattern: ".dart_tool/", label: ".dart_tool", desc: "Dart tool cache" },
	{ pattern: ".cache/", label: ".cache", desc: "Generic cache directory" },
];

export class EngramSyncSettingTab extends PluginSettingTab {
	plugin: EngramSyncPlugin;

	constructor(app: App, plugin: EngramSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Status indicator ──
		this.renderStatus(containerEl);

		// ── Connection ──
		new Setting(containerEl).setName("Connection").setHeading();

		new Setting(containerEl)
			.setName("Engram URL")
			.setDesc("Full URL to your Engram instance (e.g. http://10.0.20.214:8000)")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:8000")
					.setValue(this.plugin.settings.apiUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		// ── Authentication ──
		const isOAuth = !!this.plugin.settings.refreshToken;
		const hasApiKey = !!this.plugin.settings.apiKey;

		new Setting(containerEl).setName("Authentication").setHeading();

		if (isOAuth) {
			new Setting(containerEl)
				.setName(`Signed in as ${this.plugin.settings.userEmail ?? "unknown"}`)
				.setDesc("Authenticated via Engram account (OAuth)")
				.addButton((btn) =>
					btn.setButtonText("Sign Out").onClick(async () => {
						await this.plugin.clearOAuthTokens();
						this.display();
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
							this.plugin.settings.apiKey = "";
							await this.plugin.saveSettings();
							this.display();
						}),
				)
				.addButton((btn) =>
					btn
						.setButtonText("Switch to Sign In")
						.setCta()
						.onClick(async () => {
							this.plugin.settings.apiKey = "";
							await this.plugin.saveSettings();
							this.startDeviceFlow();
						}),
				);
		} else {
			new Setting(containerEl)
				.setName("Sign in with Engram")
				.setDesc(
					"Links your Obsidian vault to your Engram account. Opens a browser window.",
				)
				.addButton((btn) =>
					btn
						.setButtonText("Sign In")
						.setCta()
						.onClick(() => this.startDeviceFlow()),
				);

			// Show API key option as collapsible advanced section
			const details = containerEl.createEl("details");
			details.style.marginTop = "8px";
			details.createEl("summary", { text: "Use API key instead" }).style.cursor = "pointer";

			new Setting(details)
				.setName("API Key")
				.setDesc("Bearer token from Engram (starts with engram_)")
				.addText((text) => {
					text.setPlaceholder("engram_abc123...")
						.setValue(this.plugin.settings.apiKey)
						.onChange(async (value) => {
							this.plugin.settings.apiKey = value;
							await this.plugin.saveSettings();
						});
					text.inputEl.type = "password";
					text.inputEl.style.fontFamily = "monospace";
				});
		}

		// ── Vault Picker ──
		if (this.plugin.settings.apiKey || this.plugin.settings.refreshToken) {
			containerEl.createEl("h3", { text: "Vault" });

			new Setting(containerEl)
				.setName("Sync vault")
				.setDesc("Select which vault this plugin syncs with")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Loading vaults...");
					dropdown.setDisabled(true);

					this.plugin.api.listVaults().then((vaults) => {
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

						if (this.plugin.settings.vaultId) {
							dropdown.setValue(this.plugin.settings.vaultId);
						}

						dropdown.onChange(async (value) => {
							if (value && value !== this.plugin.settings.vaultId) {
								this.plugin.settings.vaultId = value;
								this.plugin.api.setVaultId(value);
								await this.plugin.saveSettings();
								this.display();
							}
						});
					});
				});

			if (this.plugin.settings.vaultId) {
				const infoEl = containerEl.createEl("p", {
					cls: "setting-item-description",
				});
				infoEl.setText("Connected");
				infoEl.style.marginTop = "-10px";
			}
		}

		new Setting(containerEl)
			.setName("Remote logging")
			.setDesc("Send sync events to the server for remote debugging.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.remoteLoggingEnabled)
					.onChange(async (value) => {
						this.plugin.settings.remoteLoggingEnabled = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Check if Engram is reachable and API key is valid")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					const { ok, error } = await this.plugin.api.ping();
					new Notice(ok ? "Engram: connected!" : `Engram: ${error}`);
				}),
			);

		// ── Ignore Patterns ──
		new Setting(containerEl).setName("Ignore patterns").setHeading();

		this.renderIgnoreWarnings(containerEl);

		const ignoreSetting = new Setting(containerEl)
			.setName("Custom patterns")
			.setDesc(
				"Paths to skip (one per line). Folder patterns end with /. Built-in: .obsidian/, .trash/, .git/",
			)
			.addTextArea((text) => {
				text.setPlaceholder("drafts/\nsecret.md")
					.setValue(this.plugin.settings.ignorePatterns)
					.onChange(async (value) => {
						this.plugin.settings.ignorePatterns = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.style.width = "100%";
			});
		ignoreSetting.settingEl.style.flexDirection = "column";
		ignoreSetting.settingEl.style.alignItems = "flex-start";
		ignoreSetting.settingEl.style.gap = "8px";

		// ── Sync Behavior ──
		new Setting(containerEl).setName("Sync behavior").setHeading();

		new Setting(containerEl)
			.setName("Conflict resolution")
			.setDesc(
				"How to handle conflicts. Automatic creates a conflict copy. Interactive shows a diff dialog.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", "Automatic (conflict files)")
					.addOption("modal", "Interactive (diff modal)")
					.setValue(this.plugin.settings.conflictResolution)
					.onChange(async (value) => {
						this.plugin.settings.conflictResolution = value as "auto" | "modal";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Debounce (ms)")
			.setDesc("Delay after editing before pushing. Prevents flooding during typing.")
			.addText((text) =>
				text
					.setPlaceholder("2000")
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						const num = Number.parseInt(value, 10);
						if (!Number.isNaN(num) && num >= 100) {
							this.plugin.settings.debounceMs = num;
							await this.plugin.saveSettings();
						}
					}),
			);

		// ── Progress bar (hidden until sync is active) ──
		const progressContainer = containerEl.createDiv({ cls: "engram-sync-progress" });
		progressContainer.style.display = "none";
		progressContainer.style.padding = "12px 0";

		const progressLabel = progressContainer.createEl("p", {
			text: "Syncing...",
			cls: "engram-progress-label",
		});
		progressLabel.style.margin = "0 0 4px 0";

		const progressBarOuter = progressContainer.createDiv({ cls: "engram-progress-bar-outer" });
		progressBarOuter.style.height = "6px";
		progressBarOuter.style.background = "var(--background-modifier-border)";
		progressBarOuter.style.borderRadius = "3px";
		progressBarOuter.style.overflow = "hidden";

		const progressBarInner = progressBarOuter.createDiv({ cls: "engram-progress-bar-inner" });
		progressBarInner.style.height = "100%";
		progressBarInner.style.width = "0%";
		progressBarInner.style.background = "var(--interactive-accent)";
		progressBarInner.style.transition = "width 0.2s ease";

		this.plugin.syncEngine.onSyncProgress = (progress) => {
			if (progress.phase === "complete") {
				progressContainer.style.display = "none";
				return;
			}
			progressContainer.style.display = "block";
			const pct =
				progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
			const phaseLabel =
				progress.phase === "pushing"
					? "Pushing notes"
					: progress.phase === "pulling"
						? "Pulling notes"
						: "Syncing attachments";
			progressLabel.setText(
				`${phaseLabel}... ${progress.current}/${progress.total}${progress.failed > 0 ? ` (${progress.failed} failed)` : ""}`,
			);
			progressBarInner.style.width = `${pct}%`;
		};

		// ── Actions ──
		new Setting(containerEl).setName("Actions").setHeading();

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Pull remote changes and push local changes")
			.addButton((btn) =>
				btn.setButtonText("Sync").onClick(async () => {
					try {
						btn.setDisabled(true);
						const plan = await this.plugin.syncEngine.computeSyncPlan("full");
						const { PreSyncModal } = await import("./pre-sync-modal");
						const confirmed = await new PreSyncModal(
							this.app,
							plan,
						).awaitConfirmation();
						if (!confirmed) {
							btn.setDisabled(false);
							return;
						}
						const { pulled, pushed } = await this.plugin.syncEngine.fullSync();
						const errors = this.plugin.syncEngine.syncLog?.errorCount() ?? 0;
						if (errors > 0) {
							new Notice(
								`Sync complete: pulled ${pulled}, pushed ${pushed}, ${errors} failed — run "Engram: Show sync log" for details`,
								10000,
							);
						} else {
							new Notice(`Engram Sync: pulled ${pulled}, pushed ${pushed}`);
						}
					} catch (e) {
						new Notice(
							`Engram Sync: ${e instanceof Error ? e.message : "sync failed"}`,
						);
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
							const plan = await this.plugin.syncEngine.computeSyncPlan("push-all");
							const { PreSyncModal } = await import("./pre-sync-modal");
							const confirmed = await new PreSyncModal(
								this.app,
								plan,
							).awaitConfirmation();
							if (!confirmed) {
								btn.setDisabled(false);
								return;
							}
							const count = await this.plugin.syncEngine.pushAll();
							const errors = this.plugin.syncEngine.syncLog?.errorCount() ?? 0;
							if (errors > 0) {
								new Notice(
									`Sync complete: ${count} pushed, ${errors} failed — run "Engram: Show sync log" for details`,
									10000,
								);
							} else {
								new Notice(`Sync complete: ${count} pushed`);
							}
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
			.setDesc("Force-pull every note and attachment, overwriting local copies.")
			.addButton((btn) =>
				btn
					.setButtonText("Pull All")
					.setWarning()
					.onClick(async () => {
						try {
							btn.setDisabled(true);
							const plan = await this.plugin.syncEngine.computeSyncPlan("pull-all");
							const { PreSyncModal } = await import("./pre-sync-modal");
							const confirmed = await new PreSyncModal(
								this.app,
								plan,
							).awaitConfirmation();
							if (!confirmed) {
								btn.setDisabled(false);
								return;
							}
							const count = await this.plugin.syncEngine.pullAll();
							const errors = this.plugin.syncEngine.syncLog?.errorCount() ?? 0;
							if (errors > 0) {
								new Notice(
									`Sync complete: ${count} pulled, ${errors} failed — run "Engram: Show sync log" for details`,
									10000,
								);
							} else {
								new Notice(`Sync complete: ${count} pulled`);
							}
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

	private async startDeviceFlow(): Promise<void> {
		const modal = new DeviceFlowModal(this.app, this.plugin);
		const result = await modal.waitForResult();
		if (result) {
			await this.plugin.saveOAuthTokens(
				result.refresh_token,
				String(result.vault_id),
				result.user_email,
			);
			new Notice(`Connected as ${result.user_email}`);
			this.display();
		}
	}

	/** Render connection status indicator at the top of settings. */
	private renderStatus(containerEl: HTMLElement): void {
		const statusEl = containerEl.createDiv({ cls: "engram-status-bar" });

		const status = this.plugin.syncEngine.getStatus();
		const live = this.plugin.isLiveConnected();

		let dotColor: string;
		let label: string;

		if (status.state === "offline") {
			dotColor = "#e03e3e";
			label = "Disconnected";
		} else if (status.state === "error") {
			dotColor = "#e03e3e";
			label = `Error: ${status.error || "unknown"}`;
		} else if (live) {
			dotColor = "#28a745";
			label = "Connected — live sync active";
		} else if (
			this.plugin.settings.apiUrl &&
			(this.plugin.settings.apiKey || this.plugin.settings.refreshToken)
		) {
			dotColor = "#e5a100";
			label = "Connected — polling";
		} else {
			dotColor = "#888";
			label = "Not configured";
		}

		statusEl.addClasses(["engram-status-container"]);

		const dot = statusEl.createSpan({ cls: "engram-status-dot" });
		dot.style.backgroundColor = dotColor;

		statusEl.createSpan({ text: label });

		if (status.lastSync) {
			const date = new Date(status.lastSync);
			const timeEl = statusEl.createDiv({ cls: "engram-status-time" });
			timeEl.setText(`Last sync: ${date.toLocaleString()}`);
		}
	}

	/** Scan vault for problematic directories and render warnings with add-to-ignore buttons. */
	private renderIgnoreWarnings(containerEl: HTMLElement): void {
		const currentIgnores = this.plugin.settings.ignorePatterns;
		const detected: { pattern: string; label: string; desc: string; count: number }[] = [];

		for (const dir of PROBLEMATIC_DIRS) {
			// Skip if already in ignore patterns
			if (currentIgnores.includes(dir.pattern)) continue;

			// Check if this directory exists in vault
			const folder = this.app.vault.getFolderByPath(dir.label);
			if (folder) {
				// Count files recursively
				let count = 0;
				const walk = (f: TFolder) => {
					for (const child of f.children) {
						if (child instanceof TFolder) walk(child);
						else count++;
					}
				};
				walk(folder);
				detected.push({ ...dir, count });
			}
		}

		if (detected.length === 0) return;

		for (const item of detected) {
			const warning = new Setting(containerEl)
				.setName(`⚠ Detected: ${item.label}/ (${item.count.toLocaleString()} files)`)
				.setDesc(`${item.desc} — should not be synced`)
				.addButton((btn) =>
					btn
						.setButtonText("Add to ignores")
						.setCta()
						.onClick(async () => {
							const current = this.plugin.settings.ignorePatterns.trim();
							this.plugin.settings.ignorePatterns = current
								? `${current}\n${item.pattern}`
								: item.pattern;
							await this.plugin.saveSettings();
							new Notice(`Added ${item.pattern} to ignore patterns`);
							this.display(); // Re-render to remove the warning
						}),
				);
			warning.settingEl.addClass("engram-status-warning");
		}
	}
}
