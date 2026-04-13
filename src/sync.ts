/**
 * Sync engine — handles push/pull logic, debouncing, and ignore patterns.
 */
import { type App, Notice, type TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { type EngramApi, arrayBufferToBase64, base64ToArrayBuffer } from "./api";
import type { BaseStore } from "./base-store";
import { devLog } from "./dev-log";
import { OfflineQueue } from "./offline-queue";
import { rlog } from "./remote-log";
import type { SyncLog } from "./sync-log";
import { threeWayMerge } from "./three-way-merge";
import type {
	AttachmentChange,
	ConflictInfo,
	ConflictResolution,
	EngramSyncSettings,
	FileSyncState,
	NoteChange,
	NoteStreamEvent,
	QueueEntry,
	ReconcileResult,
	SyncLogEntry,
	SyncPlan,
	SyncProgress,
	SyncStatus,
	VersionConflictResponse,
} from "./types";

/** Check if an error is an HTTP response with the given status code.
 *  Obsidian's requestUrl() throws objects with a `status` property on non-2xx. */
function isHttpStatus(e: unknown, status: number): boolean {
	return typeof e === "object" && e !== null && (e as { status?: number }).status === status;
}

/** How long (ms) after a push completes to suppress WebSocket echoes for that path. */
const ECHO_COOLDOWN_MS = 5000;

/** How often (ms) to check connectivity when offline. */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Paths that are always ignored regardless of user settings. */
const ALWAYS_IGNORED = [".obsidian/", ".trash/", ".git/"];

/** If we have no sync hash and the local file's mtime is older than the remote
 *  mtime by at least this many seconds, treat the file as stale (not locally
 *  modified) and skip conflict detection. 1 hour is conservative — if a user
 *  edited a file, its mtime will be within seconds/minutes of the remote push,
 *  not hours behind. */
const STALE_THRESHOLD_S = 3600;

/** Fast string hash (FNV-1a 32-bit). Not cryptographic — just for content change detection. */
export function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Binary file extensions that sync as attachments. */
const BINARY_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"svg",
	"webp",
	"pdf",
	"mp3",
	"wav",
	"ogg",
	"m4a",
	"webm",
	"flac",
	"mp4",
	"mov",
	"zip",
]);

/** All syncable extensions (text + binary). Canvas files are text (JSON). */
const TEXT_EXTENSIONS = new Set(["md", "canvas"]);

/** MIME types by extension. */
const MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	webp: "image/webp",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	flac: "audio/flac",
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	zip: "application/zip",
	canvas: "application/json",
};

export class SyncEngine {
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private ignorePatterns: string[] = [];
	private pushing: Set<string> = new Set();
	private recentlyPushed: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private pulling = false;
	private lastSync = "";
	private lastError = "";
	private offline = false;
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
	private ready = false;
	private activePushCount = 0;
	private maxConcurrentPushes = 5;
	private pushWaiters: (() => void)[] = [];
	private rateLimitRPM = 0; // 0 = unlimited
	private requestTimestamps: number[] = [];
	readonly queue: OfflineQueue = new OfflineQueue();

	/** Per-file sync metadata (content hash + server version).
	 *  Used to detect whether the user actually modified a file since
	 *  the last sync (Obsidian sets mtime to "now" on vault.modify(),
	 *  making mtime-based detection unreliable). */
	private syncState: Map<string, FileSyncState> = new Map();

	/** Optional base content store for 3-way merge (Step 2+). */
	baseStore: BaseStore | null = null;

	/** Called whenever sync status changes (for status bar updates). */
	onStatusChange: ((status: SyncStatus) => void) | null = null;

	/** Called when a conflict is detected. Return the user's resolution.
	 *  If null, conflicts are auto-resolved as keep-remote (legacy behavior). */
	onConflict: ((info: ConflictInfo) => Promise<ConflictResolution>) | null = null;

	/** Called after each batch during pushAll/pullAll to report progress. */
	onSyncProgress: ((progress: SyncProgress) => void) | null = null;

	/** Optional sync log — receives an entry for each push/pull outcome. */
	syncLog: SyncLog | null = null;

	constructor(
		private app: App,
		private api: EngramApi,
		private settings: EngramSyncSettings,
		private saveData: (data: { lastSync: string }) => Promise<void>,
	) {
		this.parseIgnorePatterns();
	}

	updateSettings(settings: EngramSyncSettings): void {
		this.settings = settings;
		this.parseIgnorePatterns();
	}

	/** Mark the engine as ready to handle vault events.
	 *  Called after layout is ready and initial sync completes. */
	setReady(): void {
		this.ready = true;
		devLog().log("lifecycle", "setReady — event handlers enabled");
		rlog().info("lifecycle", "Engine ready — event handlers enabled");
	}

	setLastSync(timestamp: string): void {
		this.lastSync = timestamp;
	}

	getLastSync(): string {
		return this.lastSync;
	}

	/** Export sync state for persistence across sessions. */
	exportSyncState(): Record<string, FileSyncState> {
		return Object.fromEntries(this.syncState);
	}

	/** Export hash-only projection for backwards-compatible dual-write. */
	exportHashes(): Record<string, number> {
		const result: Record<string, number> = {};
		for (const [path, state] of this.syncState) {
			result[path] = state.hash;
		}
		return result;
	}

	/** Import sync state from persisted data. */
	importSyncState(data: Record<string, FileSyncState>): void {
		for (const [path, state] of Object.entries(data)) {
			this.syncState.set(path, state);
		}
	}

	/** Import legacy hash-only format (migration from old plugin versions). */
	importHashes(data: Record<string, number>): void {
		for (const [path, hash] of Object.entries(data)) {
			this.syncState.set(path, { hash });
		}
	}

	/** Get current sync status snapshot. */
	getStatus(): SyncStatus {
		const isSyncing = this.pulling || this.pushing.size > 0;
		let state: SyncStatus["state"];
		if (this.offline) {
			state = "offline";
		} else if (this.lastError) {
			state = "error";
		} else if (isSyncing) {
			state = "syncing";
		} else {
			state = "idle";
		}
		return {
			state,
			pending: this.debounceTimers.size,
			queued: this.queue.size,
			lastSync: this.lastSync,
			error: this.lastError || undefined,
		};
	}

	/** Whether the engine is currently offline. */
	isOffline(): boolean {
		return this.offline;
	}

	/** Emit current status to listener. */
	private emitStatus(): void {
		this.onStatusChange?.(this.getStatus());
	}

	/** Append an entry to the sync log (no-op if syncLog is null). */
	private logEntry(
		action: SyncLogEntry["action"],
		path: string,
		result: SyncLogEntry["result"],
		error?: string,
		details?: string,
	): void {
		this.syncLog?.append({ timestamp: new Date(), action, path, result, error, details });
	}

	// --- Ignore pattern matching ---

	private parseIgnorePatterns(): void {
		this.ignorePatterns = this.settings.ignorePatterns
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
	}

	shouldIgnore(path: string): boolean {
		// Hardcoded ignores — always enforced, cannot be overridden
		for (const pattern of ALWAYS_IGNORED) {
			if (path.startsWith(pattern) || path.includes(`/${pattern}`)) {
				return true;
			}
		}
		return this.ignorePatterns.some((pattern) => {
			if (pattern.endsWith("/")) {
				return path.startsWith(pattern) || path.includes(`/${pattern}`);
			}
			return path === pattern || path.endsWith(`/${pattern}`);
		});
	}

	isMarkdown(file: TAbstractFile): boolean {
		return file instanceof TFile && file.extension === "md";
	}

	/** Check if a file should be synced (markdown, canvas, or binary attachment). */
	isSyncable(file: TAbstractFile): boolean {
		if (!(file instanceof TFile)) return false;
		return TEXT_EXTENSIONS.has(file.extension) || BINARY_EXTENSIONS.has(file.extension);
	}

	/** Check if a file is a binary attachment (not text). */
	isBinaryFile(file: TAbstractFile): boolean {
		if (!(file instanceof TFile)) return false;
		return BINARY_EXTENSIONS.has(file.extension);
	}

	/** Get MIME type for a file. */
	getMimeType(file: TFile): string {
		return MIME_TYPES[file.extension] || "application/octet-stream";
	}

	// --- Push: local → Engram ---

	/** Handle a vault modify/create event with debounce. */
	handleModify(file: TAbstractFile): void {
		if (!this.ready) return;
		if (!this.isSyncable(file)) return;
		if (this.shouldIgnore(file.path)) return;
		// During pull, vault events are usually echoes from sync writes.
		// But real user edits can happen too — queue them for post-pull push.
		if (this.pulling) {
			this.pendingPostPullPushes.add(file.path);
			return;
		}

		// Clear existing debounce timer for this file
		const existing = this.debounceTimers.get(file.path);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(async () => {
			this.debounceTimers.delete(file.path);
			await this.pushFile(file as TFile);
		}, this.settings.debounceMs);

		this.debounceTimers.set(file.path, timer);
		this.emitStatus();
	}

	/** Handle a vault delete event. */
	async handleDelete(file: TAbstractFile): Promise<void> {
		if (!this.ready) return;
		if (!this.isSyncable(file)) return;
		if (this.shouldIgnore(file.path)) return;

		const isBinary = this.isBinaryFile(file);

		// Cancel any pending push for this file
		const existing = this.debounceTimers.get(file.path);
		if (existing) {
			clearTimeout(existing);
			this.debounceTimers.delete(file.path);
		}

		try {
			if (isBinary) {
				await this.api.deleteAttachment(file.path);
			} else {
				await this.api.deleteNote(file.path);
			}
			this.goOnline();
		} catch (e) {
			// 404 means already deleted — treat as success
			if (isHttpStatus(e, 404)) {
				this.goOnline();
				return;
			}
			// biome-ignore lint/suspicious/noConsole: error boundary
			console.error(`Engram Sync: failed to delete ${file.path}`, e);
			await this.enqueueChange({
				path: file.path,
				action: "delete",
				kind: isBinary ? "attachment" : "note",
				timestamp: Date.now(),
				vaultId: this.settings.vaultId ?? undefined,
			});
		}
	}

	/** Handle a vault rename event. */
	async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!this.ready) return;
		if (!this.isSyncable(file)) return;

		const isBinary = this.isBinaryFile(file);

		// Delete old path if it wasn't ignored
		if (!this.shouldIgnore(oldPath)) {
			try {
				if (isBinary) {
					await this.api.deleteAttachment(oldPath);
				} else {
					await this.api.deleteNote(oldPath);
				}
				this.goOnline();
			} catch (e) {
				// 404 means already deleted — treat as success
				if (isHttpStatus(e, 404)) {
					this.goOnline();
				} else {
					// biome-ignore lint/suspicious/noConsole: error boundary
					console.error(`Engram Sync: failed to delete old path ${oldPath}`, e);
					await this.enqueueChange({
						path: oldPath,
						action: "delete",
						kind: isBinary ? "attachment" : "note",
						timestamp: Date.now(),
						vaultId: this.settings.vaultId ?? undefined,
					});
				}
			}
		}

		// Move base content entry to new path before pushing
		if (!isBinary) {
			this.baseStore?.rename(normalizePath(oldPath), normalizePath(file.path));
		}

		// Push new path if it isn't ignored
		if (!this.shouldIgnore(file.path)) {
			await this.pushFile(file as TFile);
		}
	}

	/** Acquire a push slot, blocking if at max concurrency. */
	private async acquirePushSlot(): Promise<void> {
		if (this.activePushCount < this.maxConcurrentPushes) {
			this.activePushCount++;
			return;
		}
		await new Promise<void>((resolve) => {
			this.pushWaiters.push(resolve);
		});
		this.activePushCount++;
	}

	/** Release a push slot and wake the next waiter if any. */
	private releasePushSlot(): void {
		this.activePushCount--;
		const next = this.pushWaiters.shift();
		if (next) next();
	}

	/** Query the server's rate limit and configure the pacer.
	 *  Applies a 10% safety margin (e.g. 100 RPM → 90 effective). */
	async configureRateLimit(): Promise<void> {
		try {
			const serverRPM = await this.api.getRateLimit();
			if (serverRPM > 0) {
				this.rateLimitRPM = Math.floor(serverRPM * 0.9);
				devLog().log(
					"pacer",
					`server limit=${serverRPM} RPM, effective=${this.rateLimitRPM} RPM`,
				);
				rlog().info(
					"pacer",
					`Rate limit: server=${serverRPM} RPM, effective=${this.rateLimitRPM} RPM`,
				);
			} else {
				this.rateLimitRPM = 0;
				devLog().log("pacer", "server reports unlimited — pacer disabled");
				rlog().info("pacer", "Server reports unlimited — pacer disabled");
			}
		} catch {
			this.rateLimitRPM = 0;
			devLog().log("pacer", "failed to query rate limit — assuming unlimited");
			rlog().warn("pacer", "Failed to query rate limit — assuming unlimited");
		}
	}

	/** Wait if needed to stay within the server's rate limit. */
	private async paceRequest(): Promise<void> {
		if (this.rateLimitRPM <= 0) return;

		const now = Date.now();
		const windowMs = 60_000;
		const cutoff = now - windowMs;

		// Prune timestamps outside the window
		this.requestTimestamps = this.requestTimestamps.filter((t) => t > cutoff);

		if (this.requestTimestamps.length < this.rateLimitRPM) {
			this.requestTimestamps.push(now);
			return;
		}

		// At capacity — wait until the oldest request exits the window
		const oldest = this.requestTimestamps[0];
		const waitMs = oldest + windowMs - now + 50; // +50ms buffer
		devLog().log(
			"pacer",
			`at capacity (${this.requestTimestamps.length}/${this.rateLimitRPM}), waiting ${waitMs}ms`,
		);
		rlog().info(
			"pacer",
			`Throttled: ${this.requestTimestamps.length}/${this.rateLimitRPM} RPM, waiting ${waitMs}ms`,
		);
		await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

		// Prune again and record
		this.requestTimestamps = this.requestTimestamps.filter((t) => t > Date.now() - windowMs);
		this.requestTimestamps.push(Date.now());
	}

	/** Paths modified during a pull that need pushing once pull completes. */
	private pendingPostPullPushes: Set<string> = new Set();

	/** Push a single file to Engram. Returns true on success.
	 *  When force is true, skip echo suppression (used by pushAll). */
	private async pushFile(file: TFile, force = false): Promise<boolean> {
		if (this.pushing.has(file.path)) return false;
		await this.acquirePushSlot();
		this.pushing.add(file.path);
		this.lastError = "";
		this.emitStatus();

		const isBinary = this.isBinaryFile(file);
		let success = false;
		devLog().log(
			"push",
			`start ${isBinary ? "attachment" : "note"}: ${file.path} (active=${this.activePushCount})`,
		);
		rlog().info(
			"push",
			`Push start: ${file.path} | type=${isBinary ? "attachment" : "note"} | active=${this.activePushCount}`,
		);

		try {
			await this.paceRequest();
			const mtime = file.stat.mtime / 1000; // Obsidian uses ms, Engram uses seconds
			if (isBinary) {
				const buffer = await this.app.vault.readBinary(file);
				const base64 = arrayBufferToBase64(buffer);
				const mimeType = this.getMimeType(file);
				await this.api.pushAttachment(file.path, base64, mimeType, mtime);
			} else {
				const content = await this.app.vault.cachedRead(file);
				// Echo suppression — skip pushing if content matches what the
				// sync engine last wrote (pull/WebSocket). Prevents the pull→push loop
				// where vault.modify() triggers handleModify() for every pulled file.
				const hash = fnv1a(content);
				const existing = this.syncState.get(normalizePath(file.path));
				if (!force && existing !== undefined && hash === existing.hash) {
					devLog().log("push", `skip (echo): ${file.path}`);
					rlog().info("push", `Echo skip: ${file.path} | hash=${hash}`);
					return false;
				}
				const resp = await this.api.pushNote(file.path, content, mtime, existing?.version);

				// 409 = version conflict — server has a newer version
				if ("conflict" in resp) {
					const serverNote = (resp as VersionConflictResponse).server_note;
					devLog().log(
						"push",
						`version conflict: ${file.path} (local=${existing?.version} server=${serverNote.version})`,
					);
					rlog().warn(
						"conflict",
						`Version conflict on push: ${file.path} | localVer=${existing?.version} | serverVer=${serverNote.version}`,
					);

					// Attempt 3-way auto-merge if we have a base
					const pushBase = this.baseStore?.get(normalizePath(file.path));
					if (pushBase) {
						const merge = threeWayMerge(pushBase.content, content, serverNote.content);
						if (merge.clean) {
							const mergeResp = await this.api.pushNote(
								file.path,
								merge.merged,
								mtime,
							);
							const localFile = this.app.vault.getFileByPath(file.path);
							if (localFile) {
								await this.modifyFile(localFile, merge.merged);
							}
							if (!("conflict" in mergeResp)) {
								const np = normalizePath(file.path);
								this.syncState.set(np, {
									hash: fnv1a(merge.merged),
									version: mergeResp.note.version,
								});
								if (mergeResp.note.version != null) {
									this.baseStore?.set(np, merge.merged, mergeResp.note.version);
								}
							}
							rlog().info(
								"conflict",
								`Auto-merged (push): ${file.path}` +
									` | baseLen=${pushBase.content.length} | localLen=${content.length}` +
									` | remoteLen=${serverNote.content.length} | mergedLen=${merge.merged.length}`,
							);
							return false;
						}
						rlog().info(
							"conflict",
							`Auto-merge failed (push): ${file.path}` +
								` | conflicts=${merge.conflicts.length}` +
								` | baseLen=${pushBase.content.length} | localLen=${content.length}` +
								` | remoteLen=${serverNote.content.length}`,
						);
					}

					// Fall back to interactive conflict resolution
					const resolution = await this.resolveConflict({
						path: file.path,
						localContent: content,
						localMtime: mtime,
						remoteContent: serverNote.content,
						remoteMtime: serverNote.mtime,
						baseContent: pushBase?.content,
						vaultName: this.app.vault.getName(),
					});
					if (resolution.choice === "keep-local") {
						// Re-push without version (unconditional overwrite)
						const forceResp = await this.api.pushNote(file.path, content, mtime);
						if (!("conflict" in forceResp)) {
							const np = normalizePath(file.path);
							this.syncState.set(np, { hash, version: forceResp.note.version });
							if (forceResp.note.version != null) {
								this.baseStore?.set(np, content, forceResp.note.version);
							}
						}
					} else if (resolution.choice === "keep-remote") {
						const localFile = this.app.vault.getFileByPath(file.path);
						if (localFile) {
							await this.modifyFile(localFile, serverNote.content);
							const np = normalizePath(file.path);
							this.syncState.set(np, {
								hash: fnv1a(serverNote.content),
								version: serverNote.version,
							});
							this.baseStore?.set(np, serverNote.content, serverNote.version);
						}
					} else if (resolution.choice === "merge" && resolution.mergedContent != null) {
						const mergeResp = await this.api.pushNote(
							file.path,
							resolution.mergedContent,
							mtime,
						);
						const localFile = this.app.vault.getFileByPath(file.path);
						if (localFile) {
							await this.modifyFile(localFile, resolution.mergedContent);
						}
						if (!("conflict" in mergeResp)) {
							const np = normalizePath(file.path);
							this.syncState.set(np, {
								hash: fnv1a(resolution.mergedContent),
								version: mergeResp.note.version,
							});
							if (mergeResp.note.version != null) {
								this.baseStore?.set(
									np,
									resolution.mergedContent,
									mergeResp.note.version,
								);
							}
						}
					}
					// skip and keep-both handled by returning false / not pushing
					return false;
				}

				// Server may sanitize the path (strip chars illegal on mobile).
				// If so, rename the local file to match.
				const serverPath = resp.note.path;
				const serverVersion = resp.note.version;
				if (serverPath && serverPath !== file.path) {
					const localFile = this.app.vault.getFileByPath(file.path);
					if (localFile) {
						await this.app.vault.rename(localFile, serverPath);
						devLog().log(
							"push",
							`renamed: ${file.path} → ${serverPath} (server sanitized)`,
						);
						rlog().info(
							"push",
							`Renamed: ${file.path} → ${serverPath} (server sanitized)`,
						);
						new Notice(
							`Engram Sync: renamed "${file.path.split("/").pop()}" (unsupported characters)`,
						);
					}
					this.syncState.delete(normalizePath(file.path));
					this.syncState.set(normalizePath(serverPath), { hash, version: serverVersion });
					this.baseStore?.delete(normalizePath(file.path));
					if (serverVersion != null) {
						this.baseStore?.set(normalizePath(serverPath), content, serverVersion);
					}
				} else {
					this.syncState.set(normalizePath(file.path), { hash, version: serverVersion });
					if (serverVersion != null) {
						this.baseStore?.set(normalizePath(file.path), content, serverVersion);
					}
				}
			}
			success = true;
			devLog().log("push", `ok: ${file.path}`);
			rlog().info("push", `Push ok: ${file.path} | type=${isBinary ? "attachment" : "note"}`);
			this.goOnline();
		} catch (e) {
			// biome-ignore lint/suspicious/noConsole: error boundary
			console.error(`Engram Sync: failed to push ${file.path}`, e);
			const errMsg = e instanceof Error ? e.message : String(e);
			devLog().log("error", `push failed: ${file.path} — ${errMsg}`);
			rlog().error(
				"push",
				`Push failed: ${file.path} — ${errMsg}`,
				e instanceof Error ? e.stack : undefined,
			);
			this.logEntry("push", file.path, "error", errMsg);
			// Queue for retry — content-free to avoid O(n²) serialization.
			// Content will be re-read from vault when flushing.
			await this.enqueueChange({
				path: file.path,
				action: "upsert",
				kind: isBinary ? "attachment" : "note",
				mtime: file.stat.mtime / 1000,
				timestamp: Date.now(),
				vaultId: this.settings.vaultId ?? undefined,
			});
		} finally {
			this.pushing.delete(file.path);
			this.releasePushSlot();
			// Keep path suppressed for a cooldown period after push completes.
			// WebSocket events often arrive after the push finishes, and without this
			// the echo suppression in handleStreamEvent would miss them.
			this.markRecentlyPushed(file.path);
			this.emitStatus();
		}
		return success;
	}

	/** Suppress WebSocket echoes for a path for ECHO_COOLDOWN_MS after push. */
	private markRecentlyPushed(path: string): void {
		const existing = this.recentlyPushed.get(path);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.recentlyPushed.delete(path);
		}, ECHO_COOLDOWN_MS);
		this.recentlyPushed.set(path, timer);
	}

	/** Check if a path was recently pushed (for echo suppression). */
	isRecentlyPushed(path: string): boolean {
		return this.recentlyPushed.has(path);
	}

	// --- Pull: Engram → local vault ---

	/** Pull remote changes and apply to vault. */
	async pull(): Promise<number> {
		if (this.pulling) return 0;
		if (!this.lastSync) {
			// First sync — use epoch
			this.lastSync = "1970-01-01T00:00:00Z";
		}

		this.pulling = true;
		this.lastError = "";
		this.emitStatus();
		devLog().log("pull", `start since=${this.lastSync}`);
		rlog().info("pull", `Pull started since=${this.lastSync}`);
		try {
			// Fetch note and attachment changes in parallel
			const [noteResp, attachResp] = await Promise.all([
				this.api.getChanges(this.lastSync),
				this.api.getAttachmentChanges(this.lastSync),
			]);
			devLog().log(
				"pull",
				`fetched ${noteResp.changes.length} notes, ${attachResp.changes.length} attachments`,
			);
			rlog().info(
				"pull",
				`Fetched ${noteResp.changes.length} notes, ${attachResp.changes.length} attachments`,
			);
			let applied = 0;
			let skipped = 0;

			for (const change of noteResp.changes) {
				try {
					if (await this.applyChange(change)) applied++;
				} catch (e) {
					skipped++;
					const msg = e instanceof Error ? e.message : String(e);
					// biome-ignore lint/suspicious/noConsole: error boundary
					console.error(`Engram Sync: skipping note ${change.path}: ${msg}`);
					devLog().log("error", `apply skipped: ${change.path} — ${msg}`);
					rlog().error(
						"pull",
						`Skipped note: ${change.path} — ${msg}`,
						e instanceof Error ? e.stack : undefined,
					);
				}
			}

			for (const change of attachResp.changes) {
				try {
					if (await this.applyAttachmentChange(change)) applied++;
				} catch (e) {
					skipped++;
					const msg = e instanceof Error ? e.message : String(e);
					// biome-ignore lint/suspicious/noConsole: error boundary
					console.error(`Engram Sync: skipping attachment ${change.path}: ${msg}`);
					devLog().log("error", `apply skipped: ${change.path} — ${msg}`);
					rlog().error(
						"pull",
						`Skipped attachment: ${change.path} — ${msg}`,
						e instanceof Error ? e.stack : undefined,
					);
				}
			}

			// Use the later server_time
			const serverTime =
				noteResp.server_time > attachResp.server_time
					? noteResp.server_time
					: attachResp.server_time;
			this.lastSync = serverTime;
			await this.saveData({ lastSync: this.lastSync });

			devLog().log(
				"pull",
				`done — applied ${applied}, skipped ${skipped}, lastSync=${this.lastSync}`,
			);
			rlog().info("pull", `Pull done — applied ${applied}, skipped ${skipped}`);
			return applied;
		} catch (e) {
			// biome-ignore lint/suspicious/noConsole: error boundary
			console.error("Engram Sync: pull failed", e);
			devLog().log("error", `pull failed: ${e instanceof Error ? e.message : e}`);
			rlog().error(
				"pull",
				`Pull failed: ${e instanceof Error ? e.message : e}`,
				e instanceof Error ? e.stack : undefined,
			);
			this.lastError = e instanceof Error ? `Pull failed: ${e.message}` : "Pull failed";
			return 0;
		} finally {
			this.pulling = false;
			this.emitStatus();
			await this.flushPostPullPushes();
		}
	}

	/** Push any files that were modified during pull. Echo suppression will
	 *  naturally skip sync-engine writes; only real user edits get pushed. */
	private async flushPostPullPushes(): Promise<void> {
		if (this.pendingPostPullPushes.size === 0) return;
		const paths = [...this.pendingPostPullPushes];
		this.pendingPostPullPushes.clear();
		devLog().log("push", `flushing ${paths.length} post-pull pushes`);
		rlog().info("push", `Post-pull flush: ${paths.length} files`);
		for (const path of paths) {
			const file = this.app.vault.getFileByPath(path);
			if (file) {
				await this.pushFile(file);
			}
		}
	}

	/** Force-pull ALL notes and attachments from the server, overwriting local files.
	 *  Ignores lastSync — fetches everything. Skips conflict detection. */
	async pullAll(): Promise<number> {
		return this._pullAll(false);
	}

	/** Wipe all local syncable files, reset sync state, then pull everything from server. */
	async wipePullAll(): Promise<number> {
		return this._pullAll(true);
	}

	private async _pullAll(wipe: boolean): Promise<number> {
		if (this.pulling) return 0;

		this.syncLog?.clear();
		this.pulling = true;
		this.lastError = "";
		this.emitStatus();

		if (wipe) {
			devLog().log("pull", "wipePullAll: deleting all local syncable files");
			rlog().info("pull", "WipePullAll started — deleting local files");
			const files = this.app.vault.getFiles() as TFile[];
			const syncable = files.filter((f) => this.isSyncable(f) && !this.shouldIgnore(f.path));
			const wipeTotal = syncable.length;
			this.onSyncProgress?.({ phase: "deleting", current: 0, total: wipeTotal, failed: 0 });
			let wipeFailed = 0;
			for (let i = 0; i < syncable.length; i++) {
				const file = syncable[i];
				try {
					await this.app.vault.trash(file, true);
					this.logEntry("delete", file.path, "ok", undefined, "wipe");
				} catch (e) {
					wipeFailed++;
					const msg = e instanceof Error ? e.message : String(e);
					this.logEntry("delete", file.path, "error", msg);
				}
				this.onSyncProgress?.({
					phase: "deleting",
					current: i + 1,
					total: wipeTotal,
					failed: wipeFailed,
				});
				// Yield to UI thread periodically so progress modal can repaint
				if ((i + 1) % 20 === 0) {
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
			}
			// Reset sync state — everything will be re-synced from server
			this.syncState.clear();
			this.lastSync = "";
			await this.saveData({ lastSync: "" });
			devLog().log(
				"pull",
				`wipePullAll: deleted ${syncable.length} local files, sync state reset`,
			);
			rlog().info("pull", `WipePullAll deleted ${syncable.length} local files`);
		}

		devLog().log(
			"pull",
			`${wipe ? "wipePullAll" : "pullAll"}: fetching everything from server`,
		);
		rlog().info(
			"pull",
			`${wipe ? "WipePullAll" : "PullAll"} started — fetching everything from epoch`,
		);
		try {
			const epoch = "1970-01-01T00:00:00Z";
			const [noteResp, attachResp] = await Promise.all([
				this.api.getChanges(epoch),
				this.api.getAttachmentChanges(epoch),
			]);
			devLog().log(
				"pull",
				`pullAll: fetched ${noteResp.changes.length} notes, ${attachResp.changes.length} attachments`,
			);
			rlog().info(
				"pull",
				`PullAll fetched ${noteResp.changes.length} notes, ${attachResp.changes.length} attachments`,
			);

			// Pre-filter: skip notes whose local content already matches server.
			// Skip filtering after a wipe — nothing local to compare against, and
			// Obsidian's file cache may still return stale data for trashed files.
			let noteChanges: typeof noteResp.changes;
			let attachChanges: typeof attachResp.changes;

			if (wipe) {
				noteChanges = noteResp.changes;
				attachChanges = attachResp.changes;
			} else {
				noteChanges = [];
				for (const change of noteResp.changes) {
					if (change.deleted || this.shouldIgnore(change.path)) {
						noteChanges.push(change);
						continue;
					}
					const existing = this.app.vault.getFileByPath(normalizePath(change.path));
					if (existing) {
						const localContent = await this.app.vault.cachedRead(existing);
						if (localContent === change.content) {
							// Content identical — update sync state but skip the work
							const normalized = normalizePath(change.path);
							this.syncState.set(normalized, {
								hash: fnv1a(localContent),
								version: change.version,
							});
							if (change.version != null) {
								this.baseStore?.set(normalized, change.content, change.version);
							}
							continue;
						}
					}
					noteChanges.push(change);
				}

				attachChanges = attachResp.changes.filter((change) => {
					if (change.deleted) return true;
					return !this.app.vault.getFileByPath(normalizePath(change.path));
				});
			}

			let applied = 0;
			let failed = 0;
			const noteCount = noteChanges.length;
			const attachCount = attachChanges.length;
			const total = noteCount + attachCount;

			// biome-ignore lint/suspicious/noConsole: temporary debug
			console.log(
				`[engram-debug] pullAll: server returned ${noteResp.changes.length} notes, ${attachResp.changes.length} attachments`,
			);
			// biome-ignore lint/suspicious/noConsole: temporary debug
			console.log(
				`[engram-debug] pullAll: after filter: ${noteCount} notes, ${attachCount} attachments to apply (wipe=${wipe})`,
			);

			this.onSyncProgress?.({ phase: "pulling", current: 0, total, failed: 0 });

			for (let i = 0; i < noteChanges.length; i++) {
				const change = noteChanges[i];
				try {
					const ok = await this.applyChange(change, true);
					if (ok) {
						applied++;
						this.logEntry("pull", change.path, "ok");
					} else {
						this.logEntry("skip", change.path, "skipped", undefined, "unchanged");
					}
				} catch (e) {
					failed++;
					const msg = e instanceof Error ? e.message : String(e);
					// biome-ignore lint/suspicious/noConsole: error boundary
					console.error(`Engram Sync: skipping note ${change.path}: ${msg}`);
					rlog().error("pull", `Skipped note: ${change.path} — ${msg}`);
					this.logEntry("pull", change.path, "error", msg);
				}
				this.onSyncProgress?.({ phase: "pulling", current: i + 1, total, failed });
			}

			for (let i = 0; i < attachChanges.length; i++) {
				const change = attachChanges[i];
				try {
					const ok = await this.applyAttachmentChange(change);
					if (ok) {
						applied++;
						this.logEntry("pull", change.path, "ok");
					} else {
						this.logEntry("skip", change.path, "skipped", undefined, "unchanged");
					}
				} catch (e) {
					failed++;
					const msg = e instanceof Error ? e.message : String(e);
					// biome-ignore lint/suspicious/noConsole: error boundary
					console.error(`Engram Sync: skipping attachment ${change.path}: ${msg}`);
					rlog().error("pull", `Skipped attachment: ${change.path} — ${msg}`);
					this.logEntry("pull", change.path, "error", msg);
				}
				this.onSyncProgress?.({
					phase: "pulling",
					current: noteCount + i + 1,
					total,
					failed,
				});
			}

			this.onSyncProgress?.({ phase: "complete", current: total, total, failed });

			// Update lastSync to server time
			const serverTime =
				noteResp.server_time > attachResp.server_time
					? noteResp.server_time
					: attachResp.server_time;
			this.lastSync = serverTime;
			await this.saveData({ lastSync: this.lastSync });

			devLog().log(
				"pull",
				`pullAll: done — applied=${applied}, failed=${failed}, lastSync=${this.lastSync}`,
			);
			rlog().info("pull", `PullAll done — applied=${applied}, failed=${failed}`);
			return applied;
		} catch (e) {
			// biome-ignore lint/suspicious/noConsole: error boundary
			console.error("Engram Sync: pullAll failed", e);
			devLog().log("error", `pullAll failed: ${e instanceof Error ? e.message : e}`);
			rlog().error(
				"pull",
				`PullAll failed: ${e instanceof Error ? e.message : e}`,
				e instanceof Error ? e.stack : undefined,
			);
			this.lastError =
				e instanceof Error ? `Pull all failed: ${e.message}` : "Pull all failed";
			return 0;
		} finally {
			this.pulling = false;
			this.emitStatus();
			await this.flushPostPullPushes();
		}
	}

	/** Handle a WebSocket stream event (upsert or delete). */
	async handleStreamEvent(event: NoteStreamEvent): Promise<void> {
		if (this.shouldIgnore(event.path)) return;
		devLog().log("ws", `${event.event_type} ${event.kind ?? "note"}: ${event.path}`);
		rlog().info("ws", `Event: ${event.event_type} ${event.kind ?? "note"}: ${event.path}`);

		// Echo suppression — skip events for notes we're currently pushing
		// or have recently finished pushing (WebSocket events arrive after push completes)
		if (this.pushing.has(event.path)) {
			rlog().info("ws", `Echo skip (pushing): ${event.path}`);
			return;
		}
		if (this.recentlyPushed.has(event.path)) {
			rlog().info("ws", `Echo skip (recently pushed): ${event.path}`);
			return;
		}

		const isAttachment = event.kind === "attachment";

		if (event.event_type === "delete") {
			const normalized = normalizePath(event.path);
			const existing = this.app.vault.getFileByPath(normalized);
			if (existing) {
				await this.app.vault.trash(existing, true);
				await this.removeEmptyFolders(normalized);
			}
			return;
		}

		if (event.event_type === "upsert") {
			try {
				if (isAttachment) {
					const attachment = await this.api.getAttachment(event.path);
					await this.applyAttachmentChange(
						{
							path: attachment.path,
							mime_type: attachment.mime_type,
							size_bytes: attachment.size_bytes,
							mtime: attachment.mtime,
							updated_at: attachment.updated_at,
							deleted: false,
						},
						attachment.content_base64,
					);
				} else if (event.content !== undefined) {
					// Use inline content from the broadcast — no extra HTTP roundtrip
					await this.applyChange({
						path: event.path,
						title: event.title ?? "",
						content: event.content,
						folder: event.folder ?? "",
						tags: event.tags ?? [],
						mtime: event.mtime ?? Date.now(),
						updated_at: event.updated_at ?? new Date().toISOString(),
						deleted: false,
						version: event.version,
					});
				} else {
					// Fallback: fetch content via GET (e.g., folder rename broadcasts)
					const note = await this.api.getNote(event.path);
					await this.applyChange({
						path: note.path,
						title: note.title,
						content: note.content,
						folder: note.folder,
						tags: note.tags,
						mtime: note.mtime,
						updated_at: note.updated_at,
						deleted: false,
					});
				}
			} catch (e) {
				// biome-ignore lint/suspicious/noConsole: error boundary
				console.error(`Engram Sync: failed to apply WebSocket event ${event.path}`, e);
			}
		}
	}

	/** Apply a single remote change to the vault, with conflict detection.
	 *  Returns true when a file was actually created, modified, or trashed.
	 *  When forceOverwrite is true, skip conflict detection and always apply. */
	async applyChange(change: NoteChange, forceOverwrite = false): Promise<boolean> {
		if (this.shouldIgnore(change.path)) return false;

		const normalized = normalizePath(change.path);

		if (change.deleted) {
			// Delete local file if it exists
			const existing = this.app.vault.getFileByPath(normalized);
			if (existing) {
				await this.app.vault.trash(existing, true);
				await this.removeEmptyFolders(normalized);
				this.syncState.delete(normalized);
				this.baseStore?.delete(normalized);
				rlog().info("pull", `Deleted: ${change.path}`);
				return true;
			}
			return false;
		}

		// Create or update the file
		const existing = this.app.vault.getFileByPath(normalized);
		if (existing) {
			// Conflict detection — content-hash based.
			// Mtime is unreliable because Obsidian sets it to "now" on every
			// vault.modify(), so we track hashes of content we last wrote.
			const localContent = await this.app.vault.cachedRead(existing);
			const localHash = fnv1a(localContent);
			const lastSynced = this.syncState.get(normalized);
			const lastSyncedHash = lastSynced?.hash;

			// Local was modified by the user if its content hash differs from
			// what we last wrote during sync (or if we never wrote it).
			let localModified: boolean;
			if (lastSyncedHash !== undefined) {
				localModified = localHash !== lastSyncedHash;
			} else {
				// No sync hash — first sync for this file. Use a staleness
				// heuristic: if the local mtime is well before the remote mtime,
				// the user almost certainly didn't edit locally — the file is
				// just stale and the remote is newer.
				const localMtimeS = existing.stat.mtime / 1000;
				const stale = change.mtime - localMtimeS > STALE_THRESHOLD_S;
				localModified = stale ? false : localContent !== change.content;
			}

			if (!forceOverwrite && localModified && localContent !== change.content) {
				// Both sides differ — real conflict
				const localMtime = existing.stat.mtime / 1000;

				devLog().log(
					"pull",
					`conflict: ${change.path} (localHash=${localHash} syncedHash=${lastSyncedHash})`,
				);
				const firstSync = lastSyncedHash === undefined;
				rlog().warn(
					"conflict",
					`Detected: ${change.path} | firstSync=${firstSync}` +
						` | localHash=${localHash} | syncedHash=${lastSyncedHash ?? "none"}` +
						` | localMtime=${new Date(localMtime * 1000).toISOString()}` +
						` | remoteMtime=${new Date(change.mtime * 1000).toISOString()}` +
						` | localLen=${localContent.length} | remoteLen=${change.content.length}`,
				);

				// Attempt 3-way auto-merge if we have a base
				const pullBase = this.baseStore?.get(normalized);
				if (pullBase) {
					const merge = threeWayMerge(pullBase.content, localContent, change.content);
					if (merge.clean) {
						await this.modifyFile(existing, merge.merged);
						this.syncState.set(normalized, {
							hash: fnv1a(merge.merged),
							version: change.version,
						});
						if (change.version != null) {
							this.baseStore?.set(normalized, merge.merged, change.version);
						}
						// Push merged result to server (force=true to bypass echo suppression,
						// since syncState.hash was just updated to match merged content)
						try {
							await this.pushFile(existing, true);
						} catch (e) {
							rlog().error(
								"conflict",
								`Auto-merge push failed: ${change.path} | err=${e instanceof Error ? e.message : e}`,
							);
						}
						rlog().info(
							"conflict",
							`Auto-merged (pull): ${change.path}` +
								` | baseLen=${pullBase.content.length} | localLen=${localContent.length}` +
								` | remoteLen=${change.content.length} | mergedLen=${merge.merged.length}`,
						);
						return true;
					}
					rlog().info(
						"conflict",
						`Auto-merge failed (pull): ${change.path}` +
							` | conflicts=${merge.conflicts.length}` +
							` | baseLen=${pullBase.content.length} | localLen=${localContent.length}` +
							` | remoteLen=${change.content.length}`,
					);
				}

				// Fall back to interactive conflict resolution
				const resolution = await this.resolveConflict({
					path: change.path,
					localContent,
					localMtime,
					remoteContent: change.content,
					remoteMtime: change.mtime,
					baseContent: pullBase?.content,
					vaultName: this.app.vault.getName(),
				});

				if (resolution.choice === "skip") {
					rlog().info("conflict", `Resolved: ${change.path} → skip`);
					return false;
				}
				if (resolution.choice === "keep-local") {
					// Push local version to server
					try {
						await this.pushFile(existing);
						this.syncState.set(normalized, {
							hash: localHash,
							version: lastSynced?.version,
						});
						rlog().info(
							"conflict",
							`Resolved: ${change.path} → keep-local | pushOk=true`,
						);
					} catch (e) {
						rlog().error(
							"conflict",
							`Resolved: ${change.path} → keep-local | pushOk=false | err=${e instanceof Error ? e.message : e}`,
							e instanceof Error ? e.stack : undefined,
						);
					}
					return false;
				}
				if (resolution.choice === "keep-both") {
					// Save remote as a conflict copy, keep local as-is
					const date = new Date().toISOString().slice(0, 10);
					const baseName = normalized.replace(/\.md$/, "");
					const conflictPath = `${baseName} (conflict ${date}).md`;
					try {
						await this.createFileWithFolders(conflictPath, change.content);
						this.syncState.set(normalizePath(conflictPath), {
							hash: fnv1a(change.content),
							version: change.version,
						});
						if (change.version != null) {
							this.baseStore?.set(
								normalizePath(conflictPath),
								change.content,
								change.version,
							);
						}
						rlog().info(
							"conflict",
							`Resolved: ${change.path} → keep-both | copyPath=${conflictPath}`,
						);
					} catch (e) {
						rlog().error(
							"conflict",
							`Resolved: ${change.path} → keep-both | copyFailed=true | err=${e instanceof Error ? e.message : e}`,
							e instanceof Error ? e.stack : undefined,
						);
					}
					return true;
				}
				if (resolution.choice === "merge" && resolution.mergedContent != null) {
					// Apply user-merged content locally and push to server
					try {
						await this.modifyFile(existing, resolution.mergedContent);
						this.syncState.set(normalized, {
							hash: fnv1a(resolution.mergedContent),
							version: change.version,
						});
						if (change.version != null) {
							this.baseStore?.set(
								normalized,
								resolution.mergedContent,
								change.version,
							);
						}
						await this.pushFile(existing, true);
						rlog().info(
							"conflict",
							`Resolved: ${change.path} → merge | mergedLen=${resolution.mergedContent.length} | pushOk=true`,
						);
					} catch (e) {
						rlog().error(
							"conflict",
							`Resolved: ${change.path} → merge | pushOk=false | err=${e instanceof Error ? e.message : e}`,
							e instanceof Error ? e.stack : undefined,
						);
					}
					return true;
				}
				// "keep-remote" falls through to overwrite below
				rlog().info("conflict", `Resolved: ${change.path} → keep-remote`);
			} else if (localContent === change.content) {
				// Content identical — nothing to do
				this.syncState.set(normalized, { hash: localHash, version: change.version });
				if (change.version != null) {
					this.baseStore?.set(normalized, change.content, change.version);
				}
				rlog().info("pull", `Unchanged: ${change.path}`);
				return false;
			}

			// Apply remote change (no conflict, or keep-remote chosen)
			await this.modifyFile(existing, change.content);
			this.syncState.set(normalized, {
				hash: fnv1a(change.content),
				version: change.version,
			});
			if (change.version != null) {
				this.baseStore?.set(normalized, change.content, change.version);
			}
			rlog().info(
				"pull",
				`Applied: ${change.path} | localLen=${localContent.length} | remoteLen=${change.content.length}`,
			);
			return true;
		}
		// New file — create it
		await this.createFileWithFolders(normalized, change.content);
		this.syncState.set(normalized, {
			hash: fnv1a(change.content),
			version: change.version,
		});
		if (change.version != null) {
			this.baseStore?.set(normalized, change.content, change.version);
		}
		rlog().info("pull", `Created: ${change.path} | len=${change.content.length}`);
		return true;
	}

	/** Apply a remote attachment change to the vault.
	 *  If contentBase64 is provided (from WebSocket), use it directly. Otherwise fetch it.
	 *  Returns true when a file was actually created, modified, or trashed. */
	async applyAttachmentChange(
		change: AttachmentChange,
		contentBase64?: string,
	): Promise<boolean> {
		if (this.shouldIgnore(change.path)) return false;

		const normalized = normalizePath(change.path);

		if (change.deleted) {
			const existing = this.app.vault.getFileByPath(normalized);
			if (existing) {
				await this.app.vault.trash(existing, true);
				await this.removeEmptyFolders(normalized);
				rlog().info("pull", `Attachment deleted: ${change.path}`);
				return true;
			}
			return false;
		}

		// Fetch content if not provided
		const resolvedBase64 =
			contentBase64 ?? (await this.api.getAttachment(change.path)).content_base64;
		const buffer = base64ToArrayBuffer(resolvedBase64);
		const existing = this.app.vault.getFileByPath(normalized);

		if (existing) {
			// Skip if content is identical — prevents modify event and push-back loop
			if (existing.stat.size === buffer.byteLength) {
				const localBuffer = await this.app.vault.readBinary(existing);
				if (this.arrayBuffersEqual(localBuffer, buffer)) {
					rlog().info(
						"pull",
						`Attachment unchanged: ${change.path} | bytes=${buffer.byteLength}`,
					);
					return false;
				}
			}
			await this.app.vault.modifyBinary(existing, buffer);
			rlog().info("pull", `Attachment applied: ${change.path} | bytes=${buffer.byteLength}`);
			return true;
		}
		await this.createBinaryFileWithFolders(normalized, buffer);
		rlog().info("pull", `Attachment created: ${change.path} | bytes=${buffer.byteLength}`);
		return true;
	}

	/** Resolve a conflict via callback or auto-resolve as keep-remote. */
	private async resolveConflict(info: ConflictInfo): Promise<ConflictResolution> {
		// Auto mode: create conflict copy file instead of blocking modal
		if (this.settings.conflictResolution === "auto") {
			const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15); // YYYYMMDDTHHmmss
			const normalized = normalizePath(info.path);
			const baseName = normalized.replace(/\.md$/, "");
			const conflictPath = `${baseName} (conflict ${ts}).md`;
			try {
				await this.createFileWithFolders(conflictPath, info.remoteContent);
				this.syncState.set(normalizePath(conflictPath), {
					hash: fnv1a(info.remoteContent),
					version: undefined,
				});
				rlog().info(
					"conflict",
					`Auto-resolved: ${info.path} → conflict file ${conflictPath}` +
						` | localLen=${info.localContent.length} | remoteLen=${info.remoteContent.length}` +
						` | hasBase=${info.baseContent != null}`,
				);
				new Notice(
					`Engram Sync: conflict — saved copy as "${conflictPath.split("/").pop()}"`,
					8000,
				);
			} catch (e) {
				rlog().error(
					"conflict",
					`Failed to create conflict file: ${conflictPath} | err=${e instanceof Error ? e.message : e}`,
				);
			}
			// Keep local as-is, remote saved as conflict copy
			return { choice: "keep-local" };
		}

		if (this.onConflict) {
			return this.onConflict(info);
		}
		// No handler — default to keep-remote (legacy behavior)
		rlog().warn(
			"conflict",
			`Auto-resolved: ${info.path} → keep-remote (no handler) | localLen=${info.localContent.length} | remoteLen=${info.remoteContent.length}`,
		);
		return { choice: "keep-remote" };
	}

	/** Create a text file, ensuring parent folders exist. */
	/** Modify a file using vault.process() when available (scroll-safe),
	 *  falling back to vault.modify() for older Obsidian versions. */
	private async modifyFile(file: TFile, content: string): Promise<void> {
		if (this.app.vault.process) {
			// vault.process() does an atomic read-modify-write that updates
			// the editor in-place without resetting scroll position.
			await this.app.vault.process(file, () => content);
		} else {
			await this.app.vault.modify(file, content);
		}
	}

	private async createFileWithFolders(normalized: string, content: string): Promise<void> {
		const folder = normalized.includes("/")
			? normalized.substring(0, normalized.lastIndexOf("/"))
			: "";
		if (folder) {
			await this.ensureFolder(folder);
		}
		await this.app.vault.create(normalized, content);
	}

	/** Create a binary file, ensuring parent folders exist. */
	private async createBinaryFileWithFolders(
		normalized: string,
		data: ArrayBuffer,
	): Promise<void> {
		const folder = normalized.includes("/")
			? normalized.substring(0, normalized.lastIndexOf("/"))
			: "";
		if (folder) {
			await this.ensureFolder(folder);
		}
		await this.app.vault.createBinary(normalized, data);
	}

	/** Recursively create folder if it doesn't exist. */
	private async ensureFolder(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) return;

		// Ensure parent first
		if (path.includes("/")) {
			const parent = path.substring(0, path.lastIndexOf("/"));
			if (parent) await this.ensureFolder(parent);
		}

		await this.app.vault.createFolder(path);
	}

	/** Remove empty parent folders after a file deletion, walking up the tree. */
	private async removeEmptyFolders(filePath: string): Promise<void> {
		let folder = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "";

		while (folder) {
			const existing = this.app.vault.getAbstractFileByPath(folder);
			if (!(existing instanceof TFolder)) break;
			if (existing.children.length > 0) break;

			await this.app.vault.trash(existing, true);

			// Walk up to parent
			folder = folder.includes("/") ? folder.substring(0, folder.lastIndexOf("/")) : "";
		}
	}

	// --- Full sync (startup) ---

	/** Full bidirectional sync: pull remote changes, then push local changes. */
	async fullSync(): Promise<{ pulled: number; pushed: number }> {
		devLog().log("lifecycle", "fullSync start");
		rlog().info("lifecycle", "FullSync started");
		// Verify auth before syncing to give a clear error on bad API key
		const { ok, error } = await this.api.ping();
		if (!ok) {
			this.lastError = error ?? "Connection failed";
			this.emitStatus();
			devLog().log("error", `fullSync auth failed: ${this.lastError}`);
			rlog().error("lifecycle", `Auth failed: ${this.lastError}`);
			throw new Error(this.lastError);
		}

		// Configure request pacer from server-reported rate limit
		await this.configureRateLimit();

		// Snapshot lastSync before pull — pull updates it to server_time,
		// which would cause pushModifiedFiles to miss files modified between
		// the old and new lastSync values.
		const prePullSync = this.lastSync;

		const pulled = await this.pull();
		const pushed = await this.pushModifiedFiles(prePullSync);

		// Persist syncState updated during push (pull already saved its own)
		if (pushed > 0) {
			await this.saveData({ lastSync: this.lastSync });
		}

		devLog().log("lifecycle", `fullSync done — pulled=${pulled} pushed=${pushed}`);
		rlog().info("lifecycle", `FullSync done — pulled=${pulled} pushed=${pushed}`);
		return { pulled, pushed };
	}

	/** Push all files that have been modified since last sync. */
	private async pushModifiedFiles(sinceTimestamp?: string): Promise<number> {
		const since = sinceTimestamp || this.lastSync;
		if (!since) return 0;

		const sinceMs = new Date(since).getTime();
		const files = this.app.vault.getFiles();
		let pushed = 0;

		// Batch in groups of 10
		const toSync = files.filter(
			(f: TFile) =>
				this.isSyncable(f) && !this.shouldIgnore(f.path) && f.stat.mtime > sinceMs,
		);
		devLog().log("push", `pushModifiedFiles: ${toSync.length} files modified since ${since}`);
		rlog().info("push", `PushModified: ${toSync.length} files modified since ${since}`);

		for (let i = 0; i < toSync.length; i += 10) {
			const batch = toSync.slice(i, i + 10);
			const results = await Promise.all(batch.map((f: TFile) => this.pushFile(f)));
			pushed += results.filter(Boolean).length;
		}

		return pushed;
	}

	/** Count files that would be synced (not ignored). */
	countSyncableFiles(): number {
		const files = this.app.vault.getFiles();
		return files.filter((f: TFile) => this.isSyncable(f) && !this.shouldIgnore(f.path)).length;
	}

	/** Check if this is a first sync (no prior sync state). */
	isFirstSync(): boolean {
		return !this.lastSync;
	}

	/** Compute what a sync would do without executing it (dry-run preview).
	 *
	 *  mode:
	 *  - "full"     — bidirectional: compute toPush, toPull, conflicts, deletions
	 *  - "push-all" — push only: compute toPush, skip toPull
	 *  - "pull-all" — pull only: compute toPull, skip toPush
	 */
	async computeSyncPlan(mode: "push-all" | "pull-all" | "full"): Promise<SyncPlan> {
		const epoch = "1970-01-01T00:00:00Z";
		const since = mode === "full" ? this.lastSync || epoch : epoch;

		const [noteResp, attachResp] = await Promise.all([
			this.api.getChanges(since),
			this.api.getAttachmentChanges(since),
		]);

		// Build lookup sets from server state
		const serverNotes = new Map<string, { deleted: boolean }>();
		for (const c of noteResp.changes) {
			serverNotes.set(c.path, { deleted: c.deleted });
		}

		const serverAttachments = new Map<string, { deleted: boolean }>();
		for (const c of attachResp.changes) {
			serverAttachments.set(c.path, { deleted: c.deleted });
		}

		// Enumerate local files
		const allFiles = this.app.vault.getFiles() as TFile[];
		const syncable = allFiles.filter((f) => this.isSyncable(f) && !this.shouldIgnore(f.path));

		const localNotes: string[] = [];
		const localAttachments: string[] = [];
		for (const f of syncable) {
			if (this.isBinaryFile(f)) {
				localAttachments.push(f.path);
			} else {
				localNotes.push(f.path);
			}
		}

		const localNoteSet = new Set(localNotes);
		const localAttachSet = new Set(localAttachments);

		// Categorise server note changes
		const toPullNotes: string[] = [];
		const conflictNotes: string[] = [];
		const toDeleteLocal: string[] = [];

		for (const [path, { deleted }] of serverNotes) {
			if (deleted) {
				// Server deleted — mark for local deletion if present
				if (localNoteSet.has(path)) {
					toDeleteLocal.push(path);
				}
				continue;
			}
			if (localNoteSet.has(path)) {
				// Both sides have it — compare content to see if pull is needed
				const file = this.app.vault.getFileByPath(path);
				if (file) {
					const content = await this.app.vault.cachedRead(file);
					const localHash = fnv1a(content);

					// Check if server content actually differs from local
					const serverChange = noteResp.changes.find((c) => c.path === path);
					const serverHash = serverChange ? fnv1a(serverChange.content) : undefined;

					if (serverHash !== undefined && localHash === serverHash) {
						// Content identical — nothing to do, skip entirely
						continue;
					}

					const synced = this.syncState.get(path);
					if (synced?.hash !== undefined && localHash !== synced.hash) {
						// Local changed since last sync AND server changed — conflict
						conflictNotes.push(path);
					} else {
						// Local unchanged or never synced — server has new content
						toPullNotes.push(path);
					}
				} else {
					toPullNotes.push(path);
				}
			} else {
				// Only on server — need to pull
				toPullNotes.push(path);
			}
		}

		// Categorise server attachment changes
		const toPullAttachments: string[] = [];
		const toDeleteLocalAttach: string[] = [];

		for (const [path, { deleted }] of serverAttachments) {
			if (deleted) {
				if (localAttachSet.has(path)) {
					toDeleteLocalAttach.push(path);
				}
				continue;
			}
			if (!localAttachSet.has(path)) {
				toPullAttachments.push(path);
			}
		}

		// Files only local → need to push (not on server at all)
		const toPushNotes: string[] = [];
		for (const path of localNotes) {
			if (!serverNotes.has(path)) {
				toPushNotes.push(path);
			}
		}

		const toPushAttachments: string[] = [];
		for (const path of localAttachments) {
			if (!serverAttachments.has(path)) {
				toPushAttachments.push(path);
			}
		}

		return {
			vaultName: this.app.vault.getName(),
			serverNoteCount: [...serverNotes.values()].filter((v) => !v.deleted).length,
			localNoteCount: localNotes.length,
			localAttachmentCount: localAttachments.length,
			toPush: {
				notes: mode === "pull-all" ? [] : toPushNotes,
				attachments: mode === "pull-all" ? [] : toPushAttachments,
			},
			toPull: {
				notes: mode === "push-all" ? [] : toPullNotes,
				attachments: mode === "push-all" ? [] : toPullAttachments,
			},
			conflicts: mode === "push-all" || mode === "pull-all" ? [] : conflictNotes,
			toDeleteLocal: [...toDeleteLocal, ...toDeleteLocalAttach],
			toDeleteRemote: [], // computed during execution (local deletes since last sync)
		};
	}

	/** DEBUG: Delete all local syncable files. Temporary test method. */
	async debugWipeLocal(): Promise<number> {
		// Delete all files first
		const files = this.app.vault.getFiles() as TFile[];
		// biome-ignore lint/suspicious/noConsole: debug method
		console.log(`[engram-debug] getFiles() returned ${files.length} files`);
		let deletedFiles = 0;
		for (const file of files) {
			if (this.shouldIgnore(file.path)) continue;
			try {
				await this.app.vault.trash(file, true);
				deletedFiles++;
			} catch (e) {
				// biome-ignore lint/suspicious/noConsole: debug method
				console.error(`[engram-debug] failed to trash file ${file.path}:`, e);
			}
		}

		// Then delete all empty folders (deepest first to avoid parent-before-child)
		const allFolders = this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/")
			.sort((a, b) => b.path.length - a.path.length); // deepest first

		// biome-ignore lint/suspicious/noConsole: debug method
		console.log(`[engram-debug] found ${allFolders.length} folders to check`);
		let deletedFolders = 0;
		for (const folder of allFolders) {
			if (this.shouldIgnore(folder.path)) continue;
			if (folder.path.startsWith(".")) continue; // skip .obsidian etc
			try {
				// Re-check if folder still exists and is empty (children may have been deleted)
				const current = this.app.vault.getAbstractFileByPath(folder.path);
				if (current instanceof TFolder && current.children.length === 0) {
					await this.app.vault.trash(current, true);
					deletedFolders++;
				}
			} catch (e) {
				// biome-ignore lint/suspicious/noConsole: debug method
				console.error(`[engram-debug] failed to trash folder ${folder.path}:`, e);
			}
		}

		// biome-ignore lint/suspicious/noConsole: debug method
		console.log(
			`[engram-debug] done: deleted ${deletedFiles} files + ${deletedFolders} folders`,
		);
		return deletedFiles + deletedFolders;
	}

	/** Push ALL syncable files (initial import). */
	async pushAll(): Promise<number> {
		this.syncLog?.clear();

		// Verify auth before pushing to give a clear error on bad API key
		const { ok, error } = await this.api.ping();
		if (!ok) {
			this.lastError = error ?? "Connection failed";
			this.emitStatus();
			throw new Error(this.lastError);
		}

		const files = this.app.vault.getFiles();
		const toSync = files.filter((f: TFile) => this.isSyncable(f) && !this.shouldIgnore(f.path));

		let pushed = 0;
		let failed = 0;
		const total = toSync.length;

		devLog().log("push", `pushAll: ${total} files`);
		rlog().info("push", `PushAll started — ${total} files`);

		this.onSyncProgress?.({ phase: "pushing", current: 0, total, failed: 0 });

		for (let i = 0; i < toSync.length; i += 10) {
			const batch = toSync.slice(i, i + 10);
			const results = await Promise.all(
				batch.map(async (f: TFile) => {
					try {
						const ok = await this.pushFile(f, true);
						if (ok) {
							this.logEntry("push", f.path, "ok");
						} else {
							this.logEntry("skip", f.path, "skipped", undefined, "unchanged");
						}
						return ok;
					} catch (e) {
						failed++;
						const msg = e instanceof Error ? e.message : String(e);
						this.logEntry("push", f.path, "error", msg);
						return false;
					}
				}),
			);
			pushed += results.filter(Boolean).length;
			this.onSyncProgress?.({ phase: "pushing", current: i + batch.length, total, failed });
		}

		this.onSyncProgress?.({ phase: "complete", current: total, total, failed });

		const skipped = total - pushed - failed;
		devLog().log(
			"push",
			`pushAll done — pushed=${pushed}, skipped=${skipped}, failed=${failed}`,
		);
		rlog().info(
			"push",
			`PushAll done — pushed=${pushed}, skipped=${skipped}, failed=${failed}`,
		);

		// Post-push reconciliation
		const reconcileResult = await this.reconcile();
		if (reconcileResult) {
			const { missing, diverged } = reconcileResult;
			const toFix = [...missing, ...diverged];
			if (toFix.length > 0) {
				devLog().log("reconcile", `fixing ${toFix.length} files after pushAll`);
				rlog().warn(
					"reconcile",
					`Fixing ${toFix.length} files after pushAll (${missing.length} missing, ${diverged.length} diverged)`,
				);
				for (const path of toFix) {
					const file = this.app.vault.getFileByPath(normalizePath(path));
					if (file) {
						await this.pushFile(file, true);
					}
				}
			}
		}

		// Persist all hashes accumulated during pushAll + reconcile
		await this.saveData({ lastSync: this.lastSync });

		return pushed;
	}

	/** Compute MD5 hex hash of a UTF-8 string using Web Crypto API. */
	private async md5(content: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(content);
		const hashBuffer = await crypto.subtle.digest("MD5", data);
		const hashArray = new Uint8Array(hashBuffer);
		return Array.from(hashArray)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	/** Reconcile local vault against server manifest.
	 *  Returns null if server doesn't support the manifest endpoint. */
	async reconcile(): Promise<ReconcileResult | null> {
		devLog().log("reconcile", "start");
		rlog().info("reconcile", "Reconcile started");
		const manifest = await this.api.getManifest();
		if (!manifest) {
			devLog().log("reconcile", "server does not support manifest — skipping");
			rlog().info("reconcile", "Server does not support manifest — skipping");
			return null;
		}

		const serverNotes = new Map(manifest.notes.map((n) => [n.path, n.content_hash]));
		const missing: string[] = [];
		const diverged: string[] = [];

		// Check local files against server manifest
		const files = this.app.vault.getFiles();
		const syncable = files.filter(
			(f: TFile) => this.isSyncable(f) && !this.isBinaryFile(f) && !this.shouldIgnore(f.path),
		);

		for (const file of syncable) {
			const serverHash = serverNotes.get(file.path);
			if (!serverHash) {
				missing.push(file.path);
			} else {
				const content = await this.app.vault.cachedRead(file);
				const localHash = await this.md5(content);
				if (localHash !== serverHash) {
					diverged.push(file.path);
				}
				serverNotes.delete(file.path);
			}
		}

		// Remaining server entries are files not in the local vault
		const extraOnServer = [...serverNotes.keys()];

		devLog().log(
			"reconcile",
			`done — missing=${missing.length} diverged=${diverged.length} extraOnServer=${extraOnServer.length}`,
		);
		rlog().info(
			"reconcile",
			`Reconcile done — missing=${missing.length} diverged=${diverged.length} extraOnServer=${extraOnServer.length}`,
		);
		return { missing, diverged, extraOnServer };
	}

	// --- Offline queue ---

	/** Queue a change for retry and go offline. */
	private async enqueueChange(entry: QueueEntry): Promise<void> {
		await this.queue.enqueue(entry);
		this.goOffline();
	}

	/** Transition to offline mode and start health checking. */
	private goOffline(): void {
		if (this.offline) return;
		this.offline = true;
		this.lastError = "";
		devLog().log("lifecycle", `went offline — queue=${this.queue.size}`);
		rlog().warn("lifecycle", `Went offline — queue=${this.queue.size}`);
		this.emitStatus();
		this.startHealthCheck();
	}

	/** Transition back to online mode. */
	private goOnline(): void {
		if (!this.offline) return;
		this.offline = false;
		this.lastError = "";
		this.stopHealthCheck();
		devLog().log("lifecycle", `went online — flushing queue (${this.queue.size} entries)`);
		rlog().info("lifecycle", `Went online — flushing queue (${this.queue.size} entries)`);
		this.emitStatus();
		// Flush the queue now that we're online
		this.flushQueue().catch((e) => {
			// biome-ignore lint/suspicious/noConsole: error boundary
			console.error("Engram Sync: queue flush failed", e);
		});
	}

	/** Start periodic health checks while offline. */
	private startHealthCheck(): void {
		if (this.healthCheckTimer) return;
		this.healthCheckTimer = setInterval(async () => {
			try {
				const ok = await this.api.health();
				if (ok) {
					this.goOnline();
				}
			} catch {
				// Still offline
			}
		}, HEALTH_CHECK_INTERVAL_MS);
	}

	/** Stop periodic health checks. */
	private stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
	}

	/** Flush queued changes oldest-first. Stops on first failure. */
	async flushQueue(): Promise<number> {
		const entries = this.queue.all();
		if (entries.length === 0) return 0;
		devLog().log("queue", `flush start — ${entries.length} entries`);
		rlog().info("queue", `Queue flush start — ${entries.length} entries`);

		let flushed = 0;
		for (const entry of entries) {
			try {
				await this.paceRequest();
				if (entry.action === "delete") {
					try {
						if (entry.kind === "attachment") {
							await this.api.deleteAttachment(entry.path);
						} else {
							await this.api.deleteNote(entry.path);
						}
					} catch (e) {
						// 404 means already deleted — dequeue and continue
						if (!isHttpStatus(e, 404)) throw e;
					}
				} else if (entry.kind === "attachment") {
					// Legacy entries may have content inline; new entries are content-free
					let base64 = entry.contentBase64;
					let mimeType = entry.mimeType;
					let mtime = entry.mtime;
					if (!base64) {
						const file = this.app.vault.getFileByPath(entry.path);
						if (!file) {
							await this.queue.dequeue(
								entry.path,
								this.settings.vaultId ?? undefined,
							);
							flushed++;
							continue;
						}
						const buffer = await this.app.vault.readBinary(file);
						base64 = arrayBufferToBase64(buffer);
						mimeType = this.getMimeType(file);
						mtime = file.stat.mtime / 1000;
					}
					// biome-ignore lint/style/noNonNullAssertion: mimeType and mtime are always set for attachments above
					await this.api.pushAttachment(entry.path, base64, mimeType!, mtime!);
				} else {
					// Note upsert — legacy entries have content; new entries are content-free
					let content = entry.content;
					let mtime = entry.mtime;
					if (content === undefined) {
						const file = this.app.vault.getFileByPath(entry.path);
						if (!file) {
							await this.queue.dequeue(
								entry.path,
								this.settings.vaultId ?? undefined,
							);
							flushed++;
							continue;
						}
						content = await this.app.vault.cachedRead(file);
						mtime = file.stat.mtime / 1000;
					}
					// biome-ignore lint/style/noNonNullAssertion: mtime is always set for notes above
					await this.api.pushNote(entry.path, content, mtime!);
				}
				await this.queue.dequeue(entry.path, this.settings.vaultId ?? undefined);
				flushed++;
			} catch {
				// Lost connectivity again — stop flushing
				this.goOffline();
				break;
			}
		}

		devLog().log(
			"queue",
			`flush done — ${flushed}/${entries.length} flushed, ${this.queue.size} remaining`,
		);
		rlog().info(
			"queue",
			`Queue flush done — ${flushed}/${entries.length} flushed, ${this.queue.size} remaining`,
		);
		this.emitStatus();
		return flushed;
	}

	/** Fast byte-level comparison of two ArrayBuffers. */
	private arrayBuffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
		if (a.byteLength !== b.byteLength) return false;
		const va = new Uint8Array(a);
		const vb = new Uint8Array(b);
		for (let i = 0; i < va.length; i++) {
			if (va[i] !== vb[i]) return false;
		}
		return true;
	}

	/** Cancel all pending debounce, cooldown, and health check timers. */
	destroy(): void {
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const timer of this.recentlyPushed.values()) {
			clearTimeout(timer);
		}
		this.recentlyPushed.clear();
		this.pendingPostPullPushes.clear();
		this.stopHealthCheck();
		this.queue.destroy();
	}
}
