/**
 * Settings tab for Engram Sync plugin.
 */
import { type App, PluginSettingTab, Setting } from "obsidian";
import { DeviceFlowModal } from "./device-flow-modal";
import type EngramSyncPlugin from "./main";
import { SyncProgressModal } from "./sync-progress-modal";
import { renderAccountTab } from "./tabs/account-tab";
import { renderAdvancedTab } from "./tabs/advanced-tab";
import { renderSelfHostedTab } from "./tabs/self-hosted-tab";
import type { TabContext } from "./tabs/types";

export class EngramSyncSettingTab extends PluginSettingTab {
	plugin: EngramSyncPlugin;
	private activeTab = "account";

	constructor(app: App, plugin: EngramSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Status indicator (persists across tabs) ──
		this.renderStatus(containerEl);

		// ── Progress bar (hidden until sync is active, persists across tabs) ──
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
				progress.phase === "deleting"
					? "Deleting local files"
					: progress.phase === "pushing"
						? "Pushing notes"
						: progress.phase === "pulling"
							? "Pulling notes"
							: "Syncing attachments";
			progressLabel.setText(
				`${phaseLabel}... ${progress.current}/${progress.total}${progress.failed > 0 ? ` (${progress.failed} failed)` : ""}`,
			);
			progressBarInner.style.width = `${pct}%`;
		};

		// ── Tab bar ──
		const tabs = [
			{ id: "account" as const, label: "Account", render: renderAccountTab },
			{ id: "self-hosted" as const, label: "Self-Hosted", render: renderSelfHostedTab },
			{ id: "advanced" as const, label: "Advanced", render: renderAdvancedTab },
		];

		const tabBar = containerEl.createEl("nav", { cls: "engram-tab-bar" });
		const contentEl = containerEl.createEl("section", { cls: "engram-tab-content" });

		const ctx: TabContext = {
			containerEl: contentEl,
			app: this.app,
			plugin: this.plugin,
			redisplay: () => this.display(),
			startDeviceFlow: () => this.startDeviceFlow(),
			openProgressModal: () => this.openProgressModal(),
		};

		const activateTab = (tabId: string) => {
			this.activeTab = tabId;
			for (const btn of Array.from(tabBar.querySelectorAll<HTMLElement>(".engram-tab"))) {
				btn.removeClass("is-active");
			}
			contentEl.empty();
			const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];
			const btn = tabBar.querySelector<HTMLElement>(`[data-tab="${tab.id}"]`);
			btn?.addClass("is-active");
			tab.render({ ...ctx, containerEl: contentEl });
		};

		for (const tab of tabs) {
			const btn = tabBar.createEl("button", {
				text: tab.label,
				cls: "engram-tab",
			});
			btn.dataset.tab = tab.id;
			btn.addEventListener("click", () => activateTab(tab.id));
		}

		// Activate the remembered tab (or default to "account")
		const startTab = tabs.find((t) => t.id === this.activeTab) ? this.activeTab : "account";
		activateTab(startTab);
	}

	/** Open a progress modal and wire it to the sync engine's progress callback. */
	async openProgressModal(): Promise<SyncProgressModal> {
		const modal = new SyncProgressModal(this.app);
		const prevCallback = this.plugin.syncEngine.onSyncProgress;
		this.plugin.syncEngine.onSyncProgress = (progress) => {
			modal.update(progress);
			prevCallback?.(progress);
		};
		modal.open();
		// Yield to allow the modal to render before sync starts
		await new Promise((resolve) => requestAnimationFrame(resolve));
		return modal;
	}

	async startDeviceFlow(): Promise<void> {
		const modal = new DeviceFlowModal(this.app, this.plugin);
		const result = await modal.waitForResult();
		if (result) {
			await this.plugin.saveOAuthTokens(
				result.refresh_token,
				String(result.vault_id),
				result.user_email,
			);
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
}
