import { Notice, Setting, TFolder, setIcon } from "obsidian";
import { PreSyncModal, WipeConfirmModal } from "../pre-sync-modal";
import type { TabContext } from "./types";

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

export function renderAdvancedTab(ctx: TabContext): void {
	const { containerEl, app, plugin, redisplay, openProgressModal } = ctx;

	// ── Actions ──
	new Setting(containerEl).setName("Actions").setHeading();

	new Setting(containerEl)
		.setName("Sync now")
		.setDesc("Pull remote changes and push local changes.")
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
				.setButtonText("Push all")
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
			"Pull every note and attachment from the server. Wipe & pull deletes all local files first.",
		)
		.addButton((btn) =>
			btn
				.setButtonText("Pull all")
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

	// ── Sync behavior ──
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
				.setValue(plugin.settings.conflictResolution)
				.onChange(async (value) => {
					plugin.settings.conflictResolution = value as "auto" | "modal";
					await plugin.saveSettings();
				}),
		);

	new Setting(containerEl)
		.setName("Debounce (ms)")
		.setDesc("Delay after editing before pushing. Prevents flooding during typing.")
		.addText((text) =>
			text
				.setPlaceholder("2000")
				.setValue(String(plugin.settings.debounceMs))
				.onChange(async (value) => {
					const num = Number.parseInt(value, 10);
					if (!Number.isNaN(num) && num >= 100) {
						plugin.settings.debounceMs = num;
						await plugin.saveSettings();
					}
				}),
		);

	// ── Ignore patterns ──
	new Setting(containerEl).setName("Ignore patterns").setHeading();

	renderIgnoreWarnings(containerEl, app, plugin, redisplay);

	const ignoreSetting = new Setting(containerEl)
		.setName("Custom patterns")
		.setDesc(
			"Paths to skip (one per line). Folder patterns end with /. Built-in: .obsidian/, .trash/, .git/",
		)
		.addTextArea((text) => {
			text.setPlaceholder("drafts/\nsecret.md")
				.setValue(plugin.settings.ignorePatterns)
				.onChange(async (value) => {
					plugin.settings.ignorePatterns = value;
					await plugin.saveSettings();
				});
			text.inputEl.rows = 6;
			text.inputEl.addClass("engram-ignore-textarea");
		});
	ignoreSetting.settingEl.addClass("engram-ignore-setting");

	// ── Diagnostics ──
	new Setting(containerEl).setName("Diagnostics").setHeading();

	new Setting(containerEl)
		.setName("Remote logging")
		.setDesc("Send sync events to the server for remote debugging.")
		.addToggle((toggle) =>
			toggle.setValue(plugin.settings.remoteLoggingEnabled).onChange(async (value) => {
				plugin.settings.remoteLoggingEnabled = value;
				await plugin.saveSettings();
			}),
		);

	// ── About ──
	new Setting(containerEl).setName("About").setHeading();

	const aboutList = containerEl.createEl("ul", { cls: "engram-about-list" });

	const versionItem = aboutList.createEl("li");
	versionItem.createSpan({ text: "Version: " });
	versionItem.createSpan({ text: plugin.manifest.version });

	const repoItem = aboutList.createEl("li");
	repoItem.createSpan({ text: "Source: " });
	repoItem.createEl("a", {
		text: "github.com/Rasbandit/Engram-obsidian-sync",
		href: "https://github.com/Rasbandit/Engram-obsidian-sync",
	});

	const licenseItem = aboutList.createEl("li");
	licenseItem.createSpan({ text: "License: MIT" });

	const supportSetting = new Setting(containerEl)
		.setName("Support development")
		.setDesc(
			"If this plugin saves you time, consider supporting development. Optional and appreciated.",
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

/** Scan vault for problematic directories and render warnings with add-to-ignore buttons. */
function renderIgnoreWarnings(
	containerEl: HTMLElement,
	app: TabContext["app"],
	plugin: TabContext["plugin"],
	redisplay: () => void,
): void {
	const currentIgnores = plugin.settings.ignorePatterns;
	const detected: { pattern: string; label: string; desc: string; count: number }[] = [];

	for (const dir of PROBLEMATIC_DIRS) {
		if (currentIgnores.includes(dir.pattern)) continue;

		const folder = app.vault.getFolderByPath(dir.label);
		if (folder) {
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
						const current = plugin.settings.ignorePatterns.trim();
						plugin.settings.ignorePatterns = current
							? `${current}\n${item.pattern}`
							: item.pattern;
						await plugin.saveSettings();
						new Notice(`Added ${item.pattern} to ignore patterns`);
						redisplay();
					}),
			);
		warning.settingEl.addClass("engram-status-warning");
	}
}
