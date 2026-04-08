/**
 * Engram Sync — Obsidian plugin for bidirectional note sync with Engram.
 *
 * Pushes vault changes to Engram for indexing/search.
 * Pulls MCP-created notes and changes from other devices.
 */
import { Notice, Platform, Plugin } from "obsidian";
import { EngramApi } from "./api";
import { ApiKeyAuth, OAuthAuth, type AuthProvider, type RefreshFn } from "./auth";
import { EngramSyncSettings, DEFAULT_SETTINGS, FileSyncState, SyncStatus } from "./types";
import { SyncEngine } from "./sync";
import { EngramSyncSettingTab } from "./settings";
import { NoteChannel } from "./channel";
import { FirstSyncModal } from "./first-sync-modal";
import { ConflictModal } from "./conflict-modal";
import { SearchModal } from "./search-modal";
import { SearchView, SEARCH_VIEW_TYPE } from "./search-view";

import { QueueEntry } from "./types";
import { BaseStore } from "./base-store";
import { initDevLog, destroyDevLog, devLog } from "./dev-log";
import { initRemoteLog, destroyRemoteLog, rlog } from "./remote-log";

/** Generate a stable client ID for vault registration.
 *  Uses SHA-256 of the vault's absolute path (desktop) or name (mobile fallback). */
async function generateClientId(app: import("obsidian").App): Promise<string> {
	const basePath = (app.vault.adapter as any).getBasePath?.() as string | undefined;
	const input = basePath || app.vault.getName();
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface PluginData {
	settings: EngramSyncSettings;
	lastSync: string;
	offlineQueue?: QueueEntry[];
	/** New unified sync state (hash + version per file). */
	syncState?: Record<string, FileSyncState>;
	/** @deprecated Legacy hash-only format. Kept for rollback safety (dual-write). */
	syncedHashes?: Record<string, number>;
}

export default class EngramSyncPlugin extends Plugin {
	settings: EngramSyncSettings = DEFAULT_SETTINGS;
	api: EngramApi = new EngramApi("", "");
	authProvider: AuthProvider | null = null;
	syncEngine: SyncEngine = null!;
	private syncInterval: ReturnType<typeof setInterval> | null = null;
	noteStream: NoteChannel | null = null;
	private statusBarEl: HTMLElement | null = null;
	private liveConnected: boolean = false;

	/** Whether the WebSocket channel is currently connected (for settings UI). */
	isLiveConnected(): boolean {
		return this.liveConnected;
	}

	private baseStore: BaseStore | null = null;

	async onload(): Promise<void> {
		initDevLog();
		devLog().log("lifecycle", "plugin loading");
		await this.loadSettings();

		this.api = new EngramApi(this.settings.apiUrl, this.settings.apiKey);
		if (this.settings.vaultId) {
			this.api.setVaultId(this.settings.vaultId);
		}

		this.authProvider = this.createAuthProvider();
		if (this.authProvider) {
			this.api.setAuthProvider(this.authProvider);
		}

		// Remote logging for mobile debugging
		const remoteLogger = initRemoteLog();
		remoteLogger.configure(
			(entries) => this.api.pushLogs(entries),
			this.manifest.version,
			Platform.isMobile ? "mobile" : "desktop",
		);
		remoteLogger.setEnabled(this.settings.remoteLoggingEnabled);
		rlog().info("lifecycle", `Plugin loading | v${this.manifest.version} | ${Platform.isMobile ? "mobile" : "desktop"}`);

		this.syncEngine = new SyncEngine(
			this.app,
			this.api,
			this.settings,
			async (data) => {
				await this.savePluginData(data.lastSync);
			},
		);

		// Base content store for 3-way merge (lazy-loaded after layout ready)
		const basesPath = `${this.manifest.dir}/sync-bases.json`;
		this.baseStore = new BaseStore(this.app.vault.adapter, basesPath);
		this.syncEngine.baseStore = this.baseStore;

		this.syncEngine.onStatusChange = (status) => {
			this.updateStatusBar(status);
		};

		this.syncEngine.onConflict = async (info) => {
			const modal = new ConflictModal(this.app, info, this.settings, async (mode) => {
				this.settings.conflictViewMode = mode;
				await this.saveSettings();
			});
			return modal.waitForChoice();
		};

		// Wire up queue persistence
		this.syncEngine.queue.onPersist(async (entries) => {
			await this.savePluginData(this.syncEngine.getLastSync(), entries);
		});

		// Restore last sync timestamp, offline queue, and sync state
		const saved = await this.loadData();
		if (saved?.lastSync) {
			this.syncEngine.setLastSync(saved.lastSync);
		}
		if (saved?.offlineQueue?.length) {
			this.syncEngine.queue.load(saved.offlineQueue);
		}
		if (saved?.syncState) {
			// New format — hash + version per file
			this.syncEngine.importSyncState(saved.syncState);
		} else if (saved?.syncedHashes) {
			// Legacy format — migrate hash-only data
			this.syncEngine.importHashes(saved.syncedHashes);
			devLog().log("lifecycle", "Migrated legacy syncedHashes → syncState");
		}

		// Register settings tab
		this.addSettingTab(new EngramSyncSettingTab(this.app, this));

		// Register vault events
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				this.syncEngine.handleModify(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.syncEngine.handleModify(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.syncEngine.handleDelete(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.syncEngine.handleRename(file, oldPath);
			}),
		);

		// Flush remote logs when app goes to background (mobile)
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				rlog().flush();
				this.savePluginData(this.syncEngine.getLastSync());
				this.baseStore?.save();
			}
		});

		// Add commands
		this.addCommand({
			id: "engram-sync-now",
			name: "Sync now",
			callback: async () => {
				new Notice("Engram Sync: syncing...");
				const { pulled, pushed } =
					await this.syncEngine.fullSync();
				new Notice(
					`Engram Sync: pulled ${pulled}, pushed ${pushed}`,
				);
			},
		});

		this.addCommand({
			id: "engram-push-all",
			name: "Push entire vault",
			callback: async () => {
				const count = await this.syncEngine.pushAll();
				new Notice(`Engram Sync: pushed ${count} files`);
			},
		});

		this.addCommand({
			id: "engram-check-sync",
			name: "Check sync status",
			callback: async () => {
				new Notice("Engram Sync: checking...");
				const result = await this.syncEngine.reconcile();
				if (!result) {
					new Notice("Engram Sync: server does not support reconciliation (update backend)");
					return;
				}
				const { missing, diverged, extraOnServer } = result;
				if (missing.length === 0 && diverged.length === 0 && extraOnServer.length === 0) {
					new Notice("Engram Sync: everything in sync");
				} else {
					const parts: string[] = [];
					if (missing.length > 0) parts.push(`${missing.length} missing on server`);
					if (diverged.length > 0) parts.push(`${diverged.length} diverged`);
					if (extraOnServer.length > 0) parts.push(`${extraOnServer.length} only on server`);
					new Notice(`Engram Sync: ${parts.join(", ")}`);
				}
			},
		});

		this.addCommand({
			id: "engram-pull-all",
			name: "Pull all from server (force overwrite)",
			callback: async () => {
				new Notice("Engram Sync: pulling all from server...");
				const count = await this.syncEngine.pullAll();
				new Notice(`Engram Sync: pulled ${count} files from server`);
			},
		});

		// Register search view
		this.registerView(SEARCH_VIEW_TYPE, (leaf) => new SearchView(leaf, this.api));

		this.addCommand({
			id: "engram-search",
			name: "Semantic search",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "s" }],
			callback: () => {
				new SearchModal(this.app, this.api).open();
			},
		});

		this.addCommand({
			id: "engram-search-view",
			name: "Open search sidebar",
			callback: async () => {
				const existing = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
				if (existing.length) {
					this.app.workspace.revealLeaf(existing[0]);
					return;
				}
				const leaf = this.app.workspace.getRightLeaf(false);
				if (leaf) {
					await leaf.setViewState({ type: SEARCH_VIEW_TYPE, active: true });
					this.app.workspace.revealLeaf(leaf);
				}
			},
		});

		this.addRibbonIcon("search", "Engram Search", async () => {
			const existing = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
			if (existing.length) {
				this.app.workspace.revealLeaf(existing[0]);
				return;
			}
			const leaf = this.app.workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: SEARCH_VIEW_TYPE, active: true });
				this.app.workspace.revealLeaf(leaf);
			}
		});

		// Start periodic sync if configured
		this.startSyncInterval();

		// Status bar (click to sync)
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.setText("Engram: ready");
		this.statusBarEl.style.cursor = "pointer";
		this.statusBarEl.addEventListener("click", () => {
			if (this.settings.apiUrl && this.settings.apiKey) {
				new Notice("Engram Sync: syncing...");
				this.syncEngine.fullSync().then(({ pulled, pushed }) => {
					new Notice(`Engram Sync: pulled ${pulled}, pushed ${pushed}`);
				}).catch((e) => {
					console.error("Engram Sync: manual sync failed", e);
					rlog().error("lifecycle", `Manual sync failed: ${e instanceof Error ? e.message : e}`, e instanceof Error ? e.stack : undefined);
					new Notice("Engram Sync: sync failed");
				});
			}
		});

		// WebSocket live sync
		this.setupNoteStream();

		// Initial sync on startup (after workspace is ready)
		this.app.workspace.onLayoutReady(async () => {
			devLog().log("lifecycle", "layout ready — starting initial sync");
			rlog().info("lifecycle", "Layout ready — starting initial sync");
			await this.baseStore?.load();
			try {
				if (this.settings.apiUrl && this.settings.apiKey) {
					const registered = await this.registerVault();
					if (!registered) {
						rlog().info("lifecycle", "Vault not registered — skipping initial sync");
						return;
					}
					await this.doSyncWithFirstSyncCheck();
				}
			} finally {
				this.syncEngine.setReady();
			}
		});
	}

	onunload(): void {
		devLog().log("lifecycle", "plugin unloading");
		rlog().info("lifecycle", "Plugin unloading");
		// Best-effort save before teardown — hashes must be exported before destroy
		this.savePluginData(this.syncEngine.getLastSync());
		this.baseStore?.prune();
		this.baseStore?.save();
		this.syncEngine?.destroy();
		this.noteStream?.disconnect();
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
			this.syncInterval = null;
		}
		destroyRemoteLog();
		destroyDevLog();
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			data?.settings,
		);
		// Generate stable client ID on first load (persisted forever)
		if (!this.settings.clientId) {
			this.settings.clientId = await generateClientId(this.app);
			await this.saveData({ ...data, settings: this.settings });
		}
	}

	async saveSettings(): Promise<void> {
		this.api.updateConfig(this.settings.apiUrl, this.settings.apiKey);
		this.api.setVaultId(this.settings.vaultId);
		this.syncEngine.updateSettings(this.settings);
		rlog().setEnabled(this.settings.remoteLoggingEnabled);
		this.startSyncInterval();
		this.setupNoteStream();
		await this.savePluginData(this.syncEngine.getLastSync());

		// Trigger sync when settings are configured (shows modal on first sync)
		if (this.settings.apiUrl && this.settings.apiKey) {
			this.registerVault().then((registered) => {
				if (!registered) return;
				return this.doSyncWithFirstSyncCheck();
			}).catch((e) => {
				console.error("Engram Sync: sync after settings change failed", e);
				rlog().error("lifecycle", `Sync after settings change failed: ${e instanceof Error ? e.message : e}`);
			});
		}
	}

	/** Register this vault with the backend. Must be called before sync starts.
	 *  Returns true if registration succeeded (or vault was already registered).
	 *  Returns false if the user hit their vault limit (402). */
	private async registerVault(): Promise<boolean> {
		if (this.settings.vaultId) {
			this.api.setVaultId(this.settings.vaultId);
			return true;
		}

		try {
			const result = await this.api.registerVault(
				this.app.vault.getName(),
				this.settings.clientId,
			);
			this.settings.vaultId = String(result.id);
			this.api.setVaultId(this.settings.vaultId);
			await this.saveSettings();
			rlog().info("lifecycle", `Vault registered: id=${result.id} slug=${result.slug}`);
			return true;
		} catch (e: unknown) {
			if (typeof e === "object" && e !== null && (e as { status?: number }).status === 402) {
				new Notice("Engram: Upgrade to Pro for multi-vault sync.");
				rlog().info("lifecycle", "Vault registration blocked — vault limit reached (402)");
				return false;
			}
			console.error("Engram Sync: vault registration failed", e);
			rlog().error("lifecycle", `Vault registration failed: ${e instanceof Error ? e.message : e}`);
			return false;
		}
	}

	private async savePluginData(lastSync: string, offlineQueue?: QueueEntry[]): Promise<void> {
		await this.saveData({
			settings: this.settings,
			lastSync,
			offlineQueue: offlineQueue ?? this.syncEngine.queue.all(),
			syncState: this.syncEngine.exportSyncState(),
			// Dual-write legacy format for rollback safety (remove after one release cycle)
			syncedHashes: this.syncEngine.exportHashes(),
		} as PluginData);
	}

	private createAuthProvider(): AuthProvider | null {
		if (this.settings.refreshToken) {
			const refreshFn: RefreshFn = async (token) => {
				const resp = await fetch(`${this.settings.apiUrl}/auth/token/refresh`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ refresh_token: token }),
				});
				if (!resp.ok) throw new Error(`Refresh failed: ${resp.status}`);
				return resp.json();
			};
			return new OAuthAuth(this.settings.refreshToken, this.settings.vaultId, this.settings.userEmail ?? null, refreshFn);
		}

		if (this.settings.apiKey) {
			return new ApiKeyAuth(this.settings.apiKey, this.settings.vaultId);
		}

		return null;
	}

	async saveOAuthTokens(refreshToken: string, vaultId: string, userEmail: string): Promise<void> {
		this.settings.refreshToken = refreshToken;
		this.settings.userEmail = userEmail;
		this.settings.authMethod = "oauth";
		this.settings.vaultId = vaultId;
		await this.saveSettings();

		this.authProvider = this.createAuthProvider();
		if (this.authProvider) {
			this.api.setAuthProvider(this.authProvider);
			if (this.noteStream) {
				this.noteStream.setAuthProvider(this.authProvider);
			}
		}
	}

	async clearOAuthTokens(): Promise<void> {
		delete this.settings.refreshToken;
		delete this.settings.userEmail;
		this.settings.authMethod = null;
		await this.saveSettings();
		this.authProvider = this.settings.apiKey
			? new ApiKeyAuth(this.settings.apiKey, this.settings.vaultId)
			: null;
		if (this.authProvider) {
			this.api.setAuthProvider(this.authProvider);
		}
	}

	setupNoteStream(): void {
		// Disconnect existing channel
		this.noteStream?.disconnect();
		this.noteStream = null;

		const { apiUrl, apiKey } = this.settings;
		if (!apiUrl || !apiKey) {
			this.liveConnected = false;
			this.updateStatusBar(this.syncEngine.getStatus());
			return;
		}

		this.connectChannel();
	}

	/** Attempt to connect the WebSocket channel with retry on getMe() failure. */
	private connectChannel(attempt = 0): void {
		const maxAttempts = 5;
		const baseDelay = 2000;

		this.api.getMe().then((user) => {
			const channel = new NoteChannel(
				this.settings.apiUrl,
				this.settings.apiKey,
				String(user.id),
				this.settings.vaultId,
			);

			channel.onEvent = (event) => {
				this.syncEngine.handleStreamEvent(event);
			};

			channel.onStatusChange = (connected) => {
				this.liveConnected = connected;
				this.updateStatusBar(this.syncEngine.getStatus());
				// Catch-up pull on reconnect to cover missed events during disconnect
				if (connected) {
					this.syncEngine.pull().catch((e) => {
						console.error("Engram Sync: catch-up pull failed", e);
						rlog().error("channel", `Catch-up pull on reconnect failed: ${e instanceof Error ? e.message : e}`);
					});
				}
			};

			channel.onVaultDeleted = () => {
				new Notice("Engram: This vault has been deleted on the server.");
				rlog().info("lifecycle", "Vault deleted on server — clearing vaultId");
				this.settings.vaultId = null;
				this.api.setVaultId(null);
				// Use savePluginData instead of saveSettings to avoid triggering re-registration
				this.savePluginData(this.syncEngine.getLastSync());
				this.noteStream?.disconnect();
			};

			this.noteStream = channel;
			if (this.authProvider) {
				this.noteStream.setAuthProvider(this.authProvider);
			}
			channel.connect();
		}).catch((e) => {
			console.error("Engram Sync: failed to fetch user id for channel", e);
			rlog().error("channel", `getMe() failed (attempt ${attempt + 1}/${maxAttempts}): ${e instanceof Error ? e.message : e}`);

			if (attempt < maxAttempts - 1) {
				const delay = baseDelay * Math.pow(2, attempt);
				setTimeout(() => this.connectChannel(attempt + 1), delay);
			}
		});
	}

	/** Run sync, showing first-sync modal if no prior sync state exists. */
	async doSyncWithFirstSyncCheck(): Promise<void> {
		if (this.syncEngine.isFirstSync()) {
			const localCount = this.syncEngine.countSyncableFiles();
			const modal = new FirstSyncModal(this.app, localCount);
			const choice = await modal.waitForChoice();

			if (choice === "cancel") {
				return;
			}

			// Always pull first
			const pulled = await this.syncEngine.pull();
			if (pulled > 0) {
				new Notice(`Engram Sync: pulled ${pulled} notes from server`);
			}

			if (choice === "push-all") {
				const pushed = await this.syncEngine.pushAll();
				new Notice(`Engram Sync: pushed ${pushed} files`);
			} else {
				new Notice("Engram Sync: pull complete. Local notes were not pushed.");
			}
		} else {
			try {
				const { pulled, pushed } = await this.syncEngine.fullSync();
				if (pulled > 0 || pushed > 0) {
					new Notice(`Engram Sync: pulled ${pulled}, pushed ${pushed}`);
				}
			} catch (e) {
				console.error("Engram Sync: sync failed", e);
				new Notice("Engram Sync: sync failed — check connection");
			}
		}
	}

	/** Update status bar text and tooltip based on sync state + WebSocket connection. */
	private updateStatusBar(status: SyncStatus): void {
		if (!this.statusBarEl) return;

		let text: string;
		let tooltip: string;

		if (status.state === "offline") {
			text = status.queued > 0
				? `Engram: offline (${status.queued} queued)`
				: "Engram: offline";
			tooltip = "Server unreachable — changes will sync when connected";
		} else if (status.state === "error") {
			text = "Engram: error";
			tooltip = status.error || "Unknown error";
		} else if (status.state === "syncing") {
			text = status.pending > 0 ? `Engram: syncing (${status.pending})` : "Engram: syncing";
			tooltip = "Sync in progress...";
		} else if (status.pending > 0) {
			text = `Engram: pending (${status.pending})`;
			tooltip = `${status.pending} file(s) queued`;
		} else if (this.liveConnected) {
			text = "Engram: live";
			tooltip = "WebSocket connected — live sync active";
		} else {
			text = "Engram: ready";
			tooltip = "Click to sync";
		}

		if (status.lastSync) {
			const date = new Date(status.lastSync);
			tooltip += `\nLast sync: ${date.toLocaleString()}`;
		}

		this.statusBarEl.setText(text);
		this.statusBarEl.setAttribute("aria-label", tooltip);
	}

	private static readonly FALLBACK_POLL_MS = 5 * 60 * 1000;

	private startSyncInterval(): void {
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
			this.syncInterval = null;
		}

		if (!this.settings.apiUrl || !this.settings.apiKey) return;

		this.syncInterval = setInterval(
			async () => {
				try {
					const pulled = await this.syncEngine.pull();
					if (pulled > 0) {
						new Notice(`Engram Sync: pulled ${pulled} changes`);
					}
				} catch (e) {
					console.error("Engram Sync: periodic pull failed", e);
				}
			},
			EngramSyncPlugin.FALLBACK_POLL_MS,
		);
	}
}
