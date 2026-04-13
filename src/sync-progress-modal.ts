import { type App, Modal } from "obsidian";
import type { SyncProgress } from "./types";

const PHASE_LABELS: Record<SyncProgress["phase"], string> = {
	deleting: "Deleting local files",
	pushing: "Pushing notes",
	pulling: "Pulling notes",
	attachments: "Syncing attachments",
	complete: "Complete",
};

/** Modal that stays open during sync, showing live progress with phase transitions. */
export class SyncProgressModal extends Modal {
	private phaseEl!: HTMLElement;
	private countEl!: HTMLElement;
	private barInner!: HTMLElement;
	private failedEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private bgBtn!: HTMLButtonElement;
	private closeBtn!: HTMLButtonElement;
	private done = false;

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("engram-sync-progress-modal");

		contentEl.createEl("h2", { text: "Syncing..." });

		this.phaseEl = contentEl.createEl("p", {
			text: "Preparing...",
			cls: "engram-progress-phase",
		});
		this.phaseEl.style.fontWeight = "bold";
		this.phaseEl.style.margin = "8px 0 4px 0";

		this.countEl = contentEl.createEl("p", {
			text: "",
			cls: "engram-progress-count",
		});
		this.countEl.style.margin = "0 0 8px 0";
		this.countEl.style.fontFamily = "var(--font-monospace)";
		this.countEl.style.fontSize = "0.9em";

		const barOuter = contentEl.createDiv({ cls: "engram-progress-bar-outer" });
		barOuter.style.height = "8px";
		barOuter.style.background = "var(--background-modifier-border)";
		barOuter.style.borderRadius = "4px";
		barOuter.style.overflow = "hidden";

		this.barInner = barOuter.createDiv({ cls: "engram-progress-bar-inner" });
		this.barInner.style.height = "100%";
		this.barInner.style.width = "0%";
		this.barInner.style.background = "var(--interactive-accent)";
		this.barInner.style.transition = "width 0.15s ease";

		this.failedEl = contentEl.createEl("p", {
			text: "",
			cls: "engram-progress-failed",
		});
		this.failedEl.style.color = "var(--text-error)";
		this.failedEl.style.margin = "8px 0 0 0";
		this.failedEl.style.display = "none";

		this.summaryEl = contentEl.createEl("p", {
			text: "",
			cls: "engram-progress-summary",
		});
		this.summaryEl.style.margin = "12px 0 0 0";
		this.summaryEl.style.display = "none";

		const buttons = contentEl.createDiv({ cls: "engram-progress-buttons" });
		buttons.style.display = "flex";
		buttons.style.justifyContent = "flex-end";
		buttons.style.gap = "8px";
		buttons.style.marginTop = "16px";

		this.bgBtn = buttons.createEl("button", { text: "Run in Background" });
		this.bgBtn.addEventListener("click", () => this.close());

		this.closeBtn = buttons.createEl("button", {
			text: "Done",
			cls: "mod-cta",
		});
		this.closeBtn.style.display = "none";
		this.closeBtn.addEventListener("click", () => this.close());
	}

	/** Call this from the onSyncProgress callback to update the modal. */
	update(progress: SyncProgress): void {
		if (!this.phaseEl) return;

		const label = PHASE_LABELS[progress.phase] ?? progress.phase;
		const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

		if (progress.phase === "complete") {
			this.done = true;
			this.phaseEl.setText("Sync complete");
			this.countEl.setText("");
			this.barInner.style.width = "100%";
			this.barInner.style.background = "var(--text-success, var(--interactive-accent))";
			this.bgBtn.style.display = "none";
			this.closeBtn.style.display = "block";

			const parts: string[] = [];
			if (progress.current > 0) parts.push(`${progress.current} synced`);
			if (progress.failed > 0) parts.push(`${progress.failed} failed`);
			this.summaryEl.setText(parts.join(", "));
			this.summaryEl.style.display = "block";

			if (progress.failed > 0) {
				this.failedEl.setText(
					`${progress.failed} failed — run "Engram: Show sync log" for details`,
				);
				this.failedEl.style.display = "block";
			}
			return;
		}

		this.phaseEl.setText(label);
		this.countEl.setText(`${progress.current} / ${progress.total}`);
		this.barInner.style.width = `${pct}%`;

		// Reset bar color on phase change (in case prior phase was complete/error)
		this.barInner.style.background = "var(--interactive-accent)";

		if (progress.failed > 0) {
			this.failedEl.setText(`${progress.failed} failed so far`);
			this.failedEl.style.display = "block";
		} else {
			this.failedEl.style.display = "none";
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
