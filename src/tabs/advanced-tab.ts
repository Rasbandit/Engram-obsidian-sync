import { Notice, Setting, TFolder } from "obsidian";
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
	const { containerEl, app, plugin, redisplay } = ctx;

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

	// ── Ignore Patterns ──
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
			text.inputEl.style.width = "100%";
			text.inputEl.style.boxSizing = "border-box";
			text.inputEl.style.resize = "none";
			text.inputEl.style.overflow = "auto";
		});
	ignoreSetting.settingEl.style.flexDirection = "column";
	ignoreSetting.settingEl.style.alignItems = "stretch";
	ignoreSetting.settingEl.style.gap = "8px";

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
