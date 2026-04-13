import { type App, Modal } from "obsidian";
import type { SyncProgress } from "./types";

const PHASE_LABELS: Record<SyncProgress["phase"], string> = {
	deleting: "Deleting local files",
	pushing: "Pushing notes",
	pulling: "Pulling notes",
	attachments: "Syncing attachments",
	complete: "Complete",
};

/** Minimum ms to display each phase before transitioning to the next. */
const MIN_PHASE_MS = 800;

/** How often to update the count/bar within a phase (ms). */
const TICK_INTERVAL_MS = 50;

/** Modal that stays open during sync, showing live progress with phase transitions.
 *  Updates are buffered so each phase is visible for at least MIN_PHASE_MS,
 *  even if the underlying operation completes faster. */
export class SyncProgressModal extends Modal {
	private phaseEl!: HTMLElement;
	private countEl!: HTMLElement;
	private pathEl!: HTMLElement;
	private barInner!: HTMLElement;
	private failedEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private bgBtn!: HTMLButtonElement;
	private closeBtn!: HTMLButtonElement;

	/** Latest progress update received from the sync engine (may be ahead of display). */
	private latest: SyncProgress | null = null;
	/** Currently displayed phase. */
	private displayedPhase: SyncProgress["phase"] | null = null;
	/** Timestamp when the current phase started displaying. */
	private phaseStartTime = 0;
	/** Interval for ticking the display forward. */
	private tickTimer: number | null = null;
	/** Queue of phase-changing updates waiting for min display time. */
	private pendingPhaseChange: SyncProgress | null = null;

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
		this.countEl.style.margin = "0 0 2px 0";
		this.countEl.style.fontFamily = "var(--font-monospace)";
		this.countEl.style.fontSize = "0.9em";

		this.pathEl = contentEl.createEl("p", {
			text: "",
			cls: "engram-progress-path",
		});
		this.pathEl.style.margin = "0 0 8px 0";
		this.pathEl.style.fontFamily = "var(--font-monospace)";
		this.pathEl.style.fontSize = "0.8em";
		this.pathEl.style.opacity = "0.6";
		this.pathEl.style.overflow = "hidden";
		this.pathEl.style.textOverflow = "ellipsis";
		this.pathEl.style.whiteSpace = "nowrap";

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

		// Start the display tick loop
		this.tickTimer = window.setInterval(() => this.tick(), TICK_INTERVAL_MS);
	}

	/** Called by the sync engine's progress callback. Buffers the update. */
	update(progress: SyncProgress): void {
		this.latest = progress;
	}

	/** Periodic tick: apply buffered updates with minimum phase display time. */
	private tick(): void {
		if (!this.latest || !this.phaseEl) return;

		const now = Date.now();

		// If a phase change is pending, check if enough time has passed
		if (this.pendingPhaseChange) {
			const elapsed = now - this.phaseStartTime;
			if (elapsed < MIN_PHASE_MS) {
				// Still showing the old phase — update its final count (show 100%)
				this.renderProgress({
					...this.pendingPhaseChange,
					phase: this.displayedPhase ?? this.pendingPhaseChange.phase,
				});
				return;
			}
			// Enough time passed — apply the phase change
			this.displayedPhase = this.pendingPhaseChange.phase;
			this.phaseStartTime = now;
			this.pendingPhaseChange = null;
		}

		// Check if the latest update is a new phase
		if (this.displayedPhase !== null && this.latest.phase !== this.displayedPhase) {
			const elapsed = now - this.phaseStartTime;
			if (elapsed < MIN_PHASE_MS) {
				// Queue the phase change — keep showing current phase at 100%
				this.pendingPhaseChange = { ...this.latest };
				this.renderProgress({
					phase: this.displayedPhase,
					current: this.latest.total || 1,
					total: this.latest.total || 1,
					failed: this.latest.failed,
				});
				return;
			}
		}

		// Apply the update directly
		if (this.displayedPhase !== this.latest.phase) {
			this.displayedPhase = this.latest.phase;
			this.phaseStartTime = now;
			this.barInner.style.width = "0%";
		}
		this.renderProgress(this.latest);
	}

	/** Render a progress state to the DOM. */
	private renderProgress(progress: SyncProgress): void {
		const label = PHASE_LABELS[progress.phase] ?? progress.phase;
		const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

		if (progress.phase === "complete") {
			if (this.tickTimer) {
				window.clearInterval(this.tickTimer);
				this.tickTimer = null;
			}
			this.phaseEl.setText("Sync complete");
			this.countEl.setText("");
			this.pathEl.setText("");
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
		this.pathEl.setText(progress.currentPath ?? "");
		this.barInner.style.width = `${pct}%`;
		this.barInner.style.background = "var(--interactive-accent)";

		if (progress.failed > 0) {
			this.failedEl.setText(`${progress.failed} failed so far`);
			this.failedEl.style.display = "block";
		} else {
			this.failedEl.style.display = "none";
		}
	}

	onClose(): void {
		if (this.tickTimer) {
			window.clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		this.contentEl.empty();
	}
}
