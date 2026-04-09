/** Plugin settings stored in data.json */
export interface EngramSyncSettings {
	/** Engram base URL (e.g. "http://10.0.20.214:8000") */
	apiUrl: string;
	/** Bearer token for Engram (e.g. "engram_abc123...") */
	apiKey: string;
	/** Glob patterns to ignore (one per line). Defaults: .obsidian/, .trash/, .git/ */
	ignorePatterns: string;
	/** Debounce delay in ms for modify events */
	debounceMs: number;
	/** Preferred conflict diff view: unified or side-by-side */
	conflictViewMode: "unified" | "side-by-side";
	/** Send errors and sync lifecycle events to the server for remote debugging */
	remoteLoggingEnabled: boolean;
	/** How to handle conflicts that can't be auto-merged.
	 *  "auto" creates a conflict copy file (non-blocking).
	 *  "modal" shows the interactive diff modal. */
	conflictResolution: "auto" | "modal";
	/** Server-assigned vault ID. Populated after registration. Null until first sync. */
	vaultId: string | null;
	/** Stable client-generated vault identifier (SHA-256 of vault absolute path).
	 *  Generated once on first load, persisted forever. Used for idempotent registration. */
	clientId: string;
	/** OAuth refresh token (device flow). When set, OAuth takes precedence over apiKey. */
	refreshToken?: string;
	/** Email of the OAuth-authenticated user (for display). */
	userEmail?: string;
	/** Active auth method. */
	authMethod?: "oauth" | "api_key" | null;
}

export const DEFAULT_SETTINGS: EngramSyncSettings = {
	apiUrl: "",
	apiKey: "",
	ignorePatterns: "",
	debounceMs: 2000,
	conflictViewMode: "unified",
	remoteLoggingEnabled: false,
	conflictResolution: "auto",
	vaultId: null,
	clientId: "",
};

/** A note as returned by POST /notes */
export interface NoteResponse {
	note: {
		id: number;
		user_id: string;
		path: string;
		title: string;
		folder: string;
		tags: string[];
		mtime: number;
		created_at: string;
		updated_at: string;
		version?: number;
	};
	chunks_indexed: number;
}

/** A change entry from GET /notes/changes */
export interface NoteChange {
	path: string;
	title: string;
	content: string;
	folder: string;
	tags: string[];
	mtime: number;
	updated_at: string;
	deleted: boolean;
	version?: number;
}

/** Response from GET /notes/changes */
export interface ChangesResponse {
	changes: NoteChange[];
	server_time: string;
}

/** Response from DELETE /notes/{path} */
export interface DeleteResponse {
	deleted: boolean;
	path: string;
}

/** A note change event from the WebSocket stream */
export interface NoteStreamEvent {
	event_type: "upsert" | "delete";
	path: string;
	timestamp: number;
	kind?: "note" | "attachment";
}

/** A queued change waiting to be pushed when connectivity returns. */
export interface QueueEntry {
	path: string;
	action: "upsert" | "delete";
	/** Note content (only for text upserts). */
	content?: string;
	/** Base64 content (only for attachment upserts). */
	contentBase64?: string;
	/** MIME type (only for attachment upserts). */
	mimeType?: string;
	/** File mtime in seconds (only for upserts). */
	mtime?: number;
	/** When this entry was queued (epoch ms). */
	timestamp: number;
	/** Whether this is a note or attachment. */
	kind?: "note" | "attachment";
	/** Vault ID for dedup isolation. */
	vaultId?: string;
}

/** Request body for POST /search */
export interface SearchRequest {
	query: string;
	limit?: number;
	tags?: string[];
	folder?: string;
}

/** A single search result from Engram. */
export interface SearchResult {
	text: string;
	title?: string;
	heading_path?: string;
	source_path?: string;
	tags: string[];
	wikilinks: string[];
	score: number;
	vector_score: number;
	rerank_score: number;
}

/** Response from POST /search */
export interface SearchResponse {
	query: string;
	results: SearchResult[];
}

/** Sync engine status for UI updates. */
export type SyncState = "idle" | "syncing" | "error" | "offline";

export interface SyncStatus {
	state: SyncState;
	/** Number of files waiting in debounce queue. */
	pending: number;
	/** Number of changes queued for retry (offline queue). */
	queued: number;
	/** Last sync ISO timestamp, or empty string if never synced. */
	lastSync: string;
	/** Error message when state is "error". */
	error?: string;
}

/** Info passed to conflict resolution UI. */
export interface ConflictInfo {
	path: string;
	localContent: string;
	localMtime: number;
	remoteContent: string;
	remoteMtime: number;
	/** Common ancestor content from last successful sync (for 3-way merge). */
	baseContent?: string;
	/** Vault name for display in conflict modal. */
	vaultName?: string;
}

/** User's choice for resolving a sync conflict. */
export type ConflictChoice = "keep-local" | "keep-remote" | "keep-both" | "merge" | "skip";

/** Result returned by the conflict resolution modal. */
export interface ConflictResolution {
	choice: ConflictChoice;
	/** Merged content when choice is "merge". */
	mergedContent?: string;
}

/** Full note as returned by GET /notes/{path} */
export interface NoteDetail {
	path: string;
	title: string;
	content: string;
	folder: string;
	tags: string[];
	mtime: number;
	created_at: string;
	updated_at: string;
	version?: number;
}

/** Attachment metadata as returned by POST /attachments */
export interface AttachmentResponse {
	attachment: {
		id: number;
		user_id: string;
		path: string;
		mime_type: string;
		size_bytes: number;
		mtime: number;
		created_at: string;
		updated_at: string;
	};
}

/** Full attachment as returned by GET /attachments/{path} */
export interface AttachmentDetail {
	id: number;
	path: string;
	content_base64: string;
	mime_type: string;
	size_bytes: number;
	mtime: number;
	created_at: string;
	updated_at: string;
}

/** A change entry from GET /attachments/changes */
export interface AttachmentChange {
	path: string;
	mime_type: string;
	size_bytes: number;
	mtime: number;
	updated_at: string;
	deleted: boolean;
}

/** Response from GET /attachments/changes */
export interface AttachmentChangesResponse {
	changes: AttachmentChange[];
	server_time: string;
}

/** A single entry in the sync manifest (path + content hash). */
export interface ManifestEntry {
	path: string;
	content_hash: string;
	version?: number;
}

/** Per-file sync metadata tracked by the plugin. */
export interface FileSyncState {
	/** FNV-1a 32-bit content hash of last synced content. */
	hash: number;
	/** Server version counter (monotonic, from backend). */
	version?: number;
}

/** 409 conflict response from the server when expected_version mismatches. */
export interface VersionConflictResponse {
	conflict: true;
	server_note: {
		id: number;
		path: string;
		title: string;
		content: string;
		folder: string;
		tags: string[];
		mtime: number;
		created_at: string;
		updated_at: string;
		version: number;
	};
}

/** Response from GET /sync/manifest */
export interface ManifestResponse {
	notes: ManifestEntry[];
	attachments: ManifestEntry[];
	total_notes: number;
	total_attachments: number;
}

/** Response from POST /api/vaults/register */
export interface VaultRegistrationResponse {
	id: number;
	name: string;
	slug: string;
	is_default: boolean;
}

/** Result of reconciliation — files that differ between local and server. */
export interface ReconcileResult {
	missing: string[];
	diverged: string[];
	extraOnServer: string[];
}
