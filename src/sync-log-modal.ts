import { type App, Modal } from "obsidian";
import type { SyncLog } from "./sync-log";

const ACTION_ICONS: Record<string, string> = {
	push: "↑",
	pull: "↓",
	delete: "✕",
	conflict: "⚡",
	skip: "⏭",
	error: "✗",
};

export class SyncLogModal extends Modal {
	private syncLog: SyncLog;

	constructor(app: App, syncLog: SyncLog) {
		super(app);
		this.syncLog = syncLog;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("engram-sync-log-modal");

		contentEl.createEl("h2", { text: "Sync Log" });

		const entries = this.syncLog.entries();
		const errorCount = this.syncLog.errorCount();

		const header = contentEl.createEl("p", {
			cls: "engram-sync-log-header",
		});
		header.setText(
			entries.length === 0
				? "No sync activity this session."
				: `Showing ${entries.length} entries${errorCount > 0 ? ` (${errorCount} errors)` : ""}`,
		);

		if (entries.length === 0) return;

		const list = contentEl.createEl("div", { cls: "engram-sync-log-list" });
		list.style.maxHeight = "400px";
		list.style.overflowY = "auto";
		list.style.fontFamily = "var(--font-monospace)";
		list.style.fontSize = "0.85em";

		for (const entry of entries) {
			const row = list.createEl("div", { cls: "engram-sync-log-entry" });
			row.style.padding = "2px 0";

			const time = entry.timestamp.toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});
			const icon = ACTION_ICONS[entry.action] ?? "?";
			const status = entry.result === "ok" ? "✓" : entry.result === "error" ? "✗" : "⏭";

			const line = `${time}  ${icon} ${entry.action.padEnd(8)} ${entry.path}  ${status}`;
			const span = row.createEl("span", { text: line });

			if (entry.result === "error") {
				span.style.color = "var(--text-error)";
				if (entry.error) {
					const errLine = row.createEl("div", {
						text: `         └ ${entry.error}`,
						cls: "engram-sync-log-error",
					});
					errLine.style.color = "var(--text-error)";
					errLine.style.opacity = "0.8";
				}
			}

			if (entry.details) {
				const detailLine = row.createEl("div", {
					text: `         └ ${entry.details}`,
				});
				detailLine.style.opacity = "0.7";
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
