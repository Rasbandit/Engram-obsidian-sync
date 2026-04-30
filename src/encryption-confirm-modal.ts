import { type App, Modal } from "obsidian";

export type EncryptionAction = "encrypt" | "decrypt" | "cancel-decrypt";

/** Copy shown in the modal header + body for each action. Exported for testing. */
export function describeAction(
	action: EncryptionAction,
	vaultName: string,
): {
	title: string;
	body: string[];
	confirmLabel: string;
	confirmClass: string;
} {
	switch (action) {
		case "encrypt":
			return {
				title: "Enable encryption at rest",
				body: [
					`This will encrypt every note in "${vaultName}" on the server using a key only you control.`,
					"Search and sync continue to work, but the server stores ciphertext at rest.",
					"While the backfill runs, the vault is read-only.",
				],
				confirmLabel: "Encrypt vault",
				confirmClass: "mod-cta",
			};
		case "decrypt":
			return {
				title: "Disable encryption at rest",
				body: [
					`This schedules decryption of "${vaultName}". The server waits 24 hours before starting so you can cancel by mistake.`,
					"Once it runs, notes are stored as plaintext on the server again.",
					"Your operator may have set a cooldown that prevents toggling this back on quickly.",
				],
				confirmLabel: "Schedule decryption",
				confirmClass: "engram-btn-danger-solid",
			};
		case "cancel-decrypt":
			return {
				title: "Cancel pending decryption",
				body: [
					`This stops the scheduled decryption of "${vaultName}". The vault stays encrypted.`,
				],
				confirmLabel: "Cancel decryption",
				confirmClass: "mod-cta",
			};
	}
}

/** Returns true when the user-typed string matches the vault name exactly
 *  (after trimming whitespace). Empty input always returns false. */
export function isConfirmInputValid(input: string, vaultName: string): boolean {
	const typed = input.trim();
	if (typed.length === 0) return false;
	return typed === vaultName.trim();
}

export class EncryptionConfirmModal extends Modal {
	private resolved = false;
	private resolve: (confirmed: boolean) => void = () => {};

	constructor(
		app: App,
		private action: EncryptionAction,
		private vaultName: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("engram-encryption-confirm-modal");

		const copy = describeAction(this.action, this.vaultName);
		contentEl.createEl("h2", { text: copy.title });

		for (const line of copy.body) {
			contentEl.createEl("p", { text: line });
		}

		contentEl.createEl("p", {
			text: `Type "${this.vaultName}" to confirm:`,
			cls: "engram-confirm-prompt",
		});

		const input = contentEl.createEl("input", {
			type: "text",
			cls: "engram-confirm-input",
			attr: { autocomplete: "off", spellcheck: "false" },
		}) as HTMLInputElement;

		const buttons = contentEl.createDiv({ cls: "engram-button-row" });

		const cancelBtn = buttons.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve(false);
			this.close();
		});

		const confirmBtn = buttons.createEl("button", {
			text: copy.confirmLabel,
			cls: copy.confirmClass,
		}) as HTMLButtonElement;
		confirmBtn.disabled = true;

		input.addEventListener("input", () => {
			confirmBtn.disabled = !isConfirmInputValid(input.value, this.vaultName);
		});

		confirmBtn.addEventListener("click", () => {
			if (!isConfirmInputValid(input.value, this.vaultName)) return;
			this.resolved = true;
			this.resolve(true);
			this.close();
		});

		input.focus();
	}

	onClose(): void {
		if (!this.resolved) this.resolve(false);
		this.contentEl.empty();
	}

	awaitConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}
}
