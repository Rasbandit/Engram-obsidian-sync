import { type App, Modal } from "obsidian";
import type { PullAction, SyncPlan } from "./types";

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
	private showWipePull: boolean;
	private resolved = false;
	private resolve: (result: boolean | PullAction) => void = () => {};

	constructor(app: App, plan: SyncPlan, showWipePull = false) {
		super(app);
		this.plan = plan;
		this.showWipePull = showWipePull;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("engram-pre-sync-modal");

		contentEl.createEl("h2", { text: "Sync Preview" });

		contentEl.createEl("pre", {
			text: formatPlanSummary(this.plan),
			cls: "engram-sync-summary",
		});

		if (this.plan.toDeleteLocal.length > 0) {
			contentEl.createEl("p", {
				cls: "engram-sync-warning",
				text: `${this.plan.toDeleteLocal.length} notes deleted on server will be removed locally.`,
			});
		}

		const buttons = contentEl.createDiv({ cls: "engram-button-row" });

		const cancelBtn = buttons.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve(this.showWipePull ? "cancel" : false);
			this.close();
		});

		if (this.showWipePull) {
			const wipeBtn = buttons.createEl("button", {
				text: "Wipe & Pull",
				cls: "engram-btn-danger-outline",
			});
			wipeBtn.addEventListener("click", () => {
				this.resolved = true;
				this.resolve("wipe-pull");
				this.close();
			});
		}

		const confirmBtn = buttons.createEl("button", {
			text: "Start Sync",
			cls: "mod-cta",
		});
		confirmBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve(this.showWipePull ? "pull" : true);
			this.close();
		});
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolve(this.showWipePull ? "cancel" : false);
		}
		this.contentEl.empty();
	}

	/** Opens the modal and returns a promise that resolves when the user confirms or cancels. */
	awaitConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve as (result: boolean | PullAction) => void;
			this.open();
		});
	}

	/** Opens the modal and returns the chosen pull action. Only use when showWipePull is true. */
	awaitPullAction(): Promise<PullAction> {
		return new Promise((resolve) => {
			this.resolve = resolve as (result: boolean | PullAction) => void;
			this.open();
		});
	}
}

/** Second confirmation gate for wipe & pull — forces user to acknowledge destruction. */
export class WipeConfirmModal extends Modal {
	private localNoteCount: number;
	private localAttachmentCount: number;
	private serverNoteCount: number;
	private resolved = false;
	private resolve: (confirmed: boolean) => void = () => {};

	constructor(
		app: App,
		localNoteCount: number,
		localAttachmentCount: number,
		serverNoteCount: number,
	) {
		super(app);
		this.localNoteCount = localNoteCount;
		this.localAttachmentCount = localAttachmentCount;
		this.serverNoteCount = serverNoteCount;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("engram-wipe-confirm-modal");

		contentEl.createEl("h2", { text: "⚠ Confirm Wipe & Pull" });

		contentEl.createEl("p", {
			cls: "engram-wipe-warning-strong",
			text: "This action cannot be undone.",
		});

		const deleteParts: string[] = [];
		if (this.localNoteCount > 0) {
			deleteParts.push(`${this.localNoteCount} notes`);
		}
		if (this.localAttachmentCount > 0) {
			deleteParts.push(`${this.localAttachmentCount} attachments`);
		}

		contentEl.createEl("p", {
			text: `This will permanently delete all ${deleteParts.join(" and ")} from your local vault, then pull ${this.serverNoteCount} notes fresh from the server.`,
		});

		contentEl.createEl("p", {
			cls: "engram-wipe-warning",
			text: "Any notes that exist only locally and have not been pushed will be lost forever.",
		});

		const buttons = contentEl.createDiv({ cls: "engram-button-row" });

		const goBackBtn = buttons.createEl("button", {
			text: "Go Back",
			cls: "mod-cta",
		});
		goBackBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve(false);
			this.close();
		});

		const confirmBtn = buttons.createEl("button", {
			text: "Delete Everything & Pull",
			cls: "engram-btn-danger-solid",
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

	awaitConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}
}
