import { type App, Modal } from "obsidian";
import type { SyncPlan } from "./types";

function plural(count: number, singular: string): string {
	return count === 1 ? `${count} ${singular}` : `${count} ${singular}s`;
}

/** Pure function: builds the text summary lines for testing without Obsidian UI. */
export function formatPlanSummary(plan: SyncPlan): string {
	const lines: string[] = [];
	lines.push(`Vault: ${plan.vaultName}`);
	lines.push(`Server: ${plan.serverNoteCount} notes · Local: ${plan.localNoteCount} notes`);
	lines.push("");
	lines.push(`↑  ${plural(plan.toPush.notes.length, "note")} to push`);
	lines.push(`↓  ${plural(plan.toPull.notes.length, "note")} to pull`);
	lines.push(`⚡  ${plural(plan.conflicts.length, "conflict")}`);
	const totalDeletes = plan.toDeleteLocal.length + plan.toDeleteRemote.length;
	lines.push(`✕  ${plural(totalDeletes, "deletion")}`);

	if (plan.toPush.attachments.length > 0 || plan.toPull.attachments.length > 0) {
		lines.push("");
		if (plan.toPush.attachments.length > 0) {
			lines.push(`↑  ${plural(plan.toPush.attachments.length, "attachment")} to push`);
		}
		if (plan.toPull.attachments.length > 0) {
			lines.push(`↓  ${plural(plan.toPull.attachments.length, "attachment")} to pull`);
		}
	}

	return lines.join("\n");
}

export class PreSyncModal extends Modal {
	private plan: SyncPlan;
	private resolved = false;
	private resolve: (confirmed: boolean) => void = () => {};

	constructor(app: App, plan: SyncPlan) {
		super(app);
		this.plan = plan;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("engram-pre-sync-modal");

		contentEl.createEl("h2", { text: "Sync Preview" });

		const summary = contentEl.createEl("pre", {
			text: formatPlanSummary(this.plan),
			cls: "engram-sync-summary",
		});
		summary.style.whiteSpace = "pre-wrap";
		summary.style.fontFamily = "var(--font-monospace)";
		summary.style.fontSize = "0.9em";
		summary.style.padding = "12px";
		summary.style.background = "var(--background-secondary)";
		summary.style.borderRadius = "6px";

		if (this.plan.toDeleteLocal.length > 0) {
			const warn = contentEl.createEl("p", {
				cls: "engram-sync-warning",
			});
			warn.style.color = "var(--text-error)";
			warn.style.marginTop = "8px";
			warn.setText(
				`${this.plan.toDeleteLocal.length} notes deleted on server will be removed locally.`,
			);
		}

		const buttons = contentEl.createDiv({ cls: "engram-sync-buttons" });
		buttons.style.display = "flex";
		buttons.style.justifyContent = "flex-end";
		buttons.style.gap = "8px";
		buttons.style.marginTop = "16px";

		const cancelBtn = buttons.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve(false);
			this.close();
		});

		const confirmBtn = buttons.createEl("button", {
			text: "Start Sync",
			cls: "mod-cta",
		});
		confirmBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve(true);
			this.close();
		});
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolve(false);
		}
		this.contentEl.empty();
	}

	/** Opens the modal and returns a promise that resolves when the user confirms or cancels. */
	awaitConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}
}
