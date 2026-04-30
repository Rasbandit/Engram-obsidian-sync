import { Notice, Setting } from "obsidian";
import { type EncryptionAction, EncryptionConfirmModal } from "../encryption-confirm-modal";
import type { EncryptionProgress, VaultEncryptionStatus, VaultInfo } from "../types";
import { describeListVaultsError } from "./self-hosted-tab";
import type { TabContext } from "./types";

type FetchVaultResult =
	| { kind: "ok"; vault: VaultInfo | null }
	| { kind: "error"; message: string };

/** Format a status string for the user. Pure for testing. */
export function formatStatusLabel(status: VaultEncryptionStatus | undefined): string {
	switch (status) {
		case "encrypted":
			return "Encrypted at rest";
		case "encrypting":
			return "Encrypting…";
		case "decrypt_pending":
			return "Decryption scheduled";
		case "decrypting":
			return "Decrypting…";
		case "none":
		case undefined:
			return "Not encrypted";
	}
}

/** Compute the next-toggle-available timestamp from vault data. Returns null
 *  when no cooldown applies. Pure for testing. */
export function nextToggleAvailable(vault: VaultInfo | null): Date | null {
	if (!vault) return null;
	const days = vault.cooldown_days;
	const last = vault.last_toggle_at;
	if (!last || days == null || days <= 0) return null;
	const ts = new Date(last);
	if (Number.isNaN(ts.getTime())) return null;
	return new Date(ts.getTime() + days * 24 * 60 * 60 * 1000);
}

interface EncryptionError {
	status?: number;
	json?: { error?: string; retry_after?: string };
}

function describeError(e: unknown): string {
	const err = e as EncryptionError;
	if (err?.status === 429) {
		const retry = err.json?.retry_after;
		return retry
			? `Cooldown active until ${new Date(retry).toLocaleString()}`
			: "Cooldown active";
	}
	if (err?.status === 409) return "Vault is in an incompatible state for this action";
	return "Request failed — check the server logs";
}

export function renderEncryptionTab(ctx: TabContext): void {
	const { containerEl, plugin, app, redisplay } = ctx;

	new Setting(containerEl).setName("Encryption at rest").setHeading();

	containerEl.createEl("p", {
		text: "When enabled, your notes are encrypted on the server with a key only you control. Sync and search continue to work; the server stores ciphertext at rest.",
	});

	const statusBox = containerEl.createDiv({ cls: "engram-encryption-status" });
	statusBox.setText("Loading vault status…");

	void loadAndRender();

	async function loadAndRender(): Promise<void> {
		const result = await fetchActiveVault();
		if (result.kind === "error") {
			statusBox.empty();
			statusBox.setText(result.message);
			return;
		}
		const vault = result.vault;
		if (!vault) {
			statusBox.empty();
			statusBox.setText(
				"No vault registered yet. Connect to your Engram server first, then return here.",
			);
			return;
		}

		const progress =
			vault.encryption_status === "encrypting" || vault.encryption_status === "decrypting"
				? await safeProgress(vault.id)
				: null;

		statusBox.empty();
		statusBox.createEl("p", {
			text: `Status: ${formatStatusLabel(vault.encryption_status)}`,
			cls: "engram-encryption-status-line",
		});

		if (vault.encrypted_at) {
			statusBox.createEl("p", {
				text: `Encrypted at: ${new Date(vault.encrypted_at).toLocaleString()}`,
			});
		}

		if (progress && progress.total > 0) {
			statusBox.createEl("p", {
				text: `Progress: ${progress.processed} of ${progress.total} notes processed.`,
			});
		}

		if (vault.encryption_status === "decrypt_pending" && vault.decrypt_requested_at) {
			const requestedAt = new Date(vault.decrypt_requested_at);
			const runsAt = new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000);
			statusBox.createEl("p", {
				text: `Scheduled to decrypt at ${runsAt.toLocaleString()}. Cancel before then to keep the vault encrypted.`,
			});
		}

		const nextToggle = nextToggleAvailable(vault);
		if (nextToggle && nextToggle > new Date()) {
			statusBox.createEl("p", {
				cls: "engram-encryption-cooldown-line",
				text: `Next toggle available ${nextToggle.toLocaleString()} (operator-imposed cooldown).`,
			});
		}

		renderActionButton(vault);
	}

	function renderActionButton(vault: VaultInfo): void {
		// Drop any prior button before rendering
		const existing = containerEl.querySelector(".engram-encryption-action");
		existing?.remove();

		const setting = new Setting(containerEl);
		setting.settingEl.addClass("engram-encryption-action");

		const status = vault.encryption_status ?? "none";

		switch (status) {
			case "none":
				setting
					.setName("Enable encryption")
					.setDesc("Re-encrypts every note in this vault on the server.")
					.addButton((btn) =>
						btn
							.setButtonText("Enable encryption")
							.setCta()
							.onClick(() => runAction("encrypt", vault)),
					);
				break;
			case "encrypted":
				setting
					.setName("Disable encryption")
					.setDesc(
						"Schedules decryption. The server waits 24 hours before running so you can cancel by mistake.",
					)
					.addButton((btn) =>
						btn
							.setButtonText("Disable encryption")
							.setWarning()
							.onClick(() => runAction("decrypt", vault)),
					);
				break;
			case "decrypt_pending":
				setting
					.setName("Cancel pending decryption")
					.setDesc("Stops the scheduled decryption — vault stays encrypted.")
					.addButton((btn) =>
						btn
							.setButtonText("Cancel decryption")
							.setCta()
							.onClick(() => runAction("cancel-decrypt", vault)),
					);
				break;
			case "encrypting":
			case "decrypting":
				setting
					.setName("Backfill in progress")
					.setDesc("Toggles are disabled while the server is processing notes.")
					.addButton((btn) =>
						btn.setButtonText("Refresh").onClick(() => loadAndRender()),
					);
				break;
		}
	}

	async function runAction(action: EncryptionAction, vault: VaultInfo): Promise<void> {
		const modal = new EncryptionConfirmModal(app, action, vault.name);
		const confirmed = await modal.awaitConfirmation();
		if (!confirmed) return;

		try {
			if (action === "encrypt") await plugin.api.encryptVault(vault.id);
			if (action === "decrypt") await plugin.api.requestDecryptVault(vault.id);
			if (action === "cancel-decrypt") await plugin.api.cancelDecryptVault(vault.id);
			new Notice("Encryption update requested.");
			void plugin.refreshEncryptionStatus();
			redisplay();
		} catch (e) {
			new Notice(`Encryption: ${describeError(e)}`, 8000);
		}
	}

	async function fetchActiveVault(): Promise<FetchVaultResult> {
		const activeId = plugin.api.getActiveVaultId();
		if (!activeId) return { kind: "ok", vault: null };
		const idNum = Number(activeId);
		if (Number.isNaN(idNum)) return { kind: "ok", vault: null };
		try {
			const vaults = await plugin.api.listVaults();
			return { kind: "ok", vault: vaults.find((v) => v.id === idNum) ?? null };
		} catch (e) {
			return { kind: "error", message: describeListVaultsError(e) };
		}
	}

	async function safeProgress(vaultId: number): Promise<EncryptionProgress | null> {
		try {
			return await plugin.api.getEncryptionProgress(vaultId);
		} catch {
			return null;
		}
	}
}
