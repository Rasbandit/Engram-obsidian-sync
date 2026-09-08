/**
 * Sync engine — handles push/pull logic, debouncing, and ignore patterns.
 */
import {
	type App,
	MarkdownView,
	Notice,
	normalizePath,
	type TAbstractFile,
	TFile,
	TFolder,
	type WorkspaceLeaf,
} from "obsidian";
import { arrayBufferToBase64, base64ToArrayBuffer, type EngramApi } from "./api";
import type { BaseStore } from "./base-store";
import type { GenesisOutcome } from "./channel";
import { fnv1a } from "./content-hash";
import type { NoteIdMap } from "./crdt/note-id-map";
import type { ProviderRegistry } from "./crdt/provider-registry";
import { uuid7 } from "./crdt/uuid7";
import { encodeUpdateFrame, fromB64 } from "./crdt/wire";
import { crdtOpFailureReason, type GenesisFrame } from "./crdt-op-dispatch";
import { devLog } from "./dev-log";
import { errMsg, isHttpStatus } from "./error-util";
import type { ExplicitFolders } from "./explicit-folders";
import { isCanvasPath as canvasPath, isCrdtEligiblePath as crdtEligiblePath } from "./file-kind";
import { IgnoredFiles } from "./ignored-files";
import {
	categorizeError,
	healthCheckDelay,
	IssueStore,
	issueDisposition,
	parseStatusToIssue,
	shouldGoOffline,
	shouldRetryAfterFailure,
} from "./issue-store";
import { isTextAttachment } from "./mime";
import { noteRef } from "./note-ref";
import {
	// Aliased: the SyncEngine method below has the same name, and an unqualified
	// call resolving to the module function while `this.queuedReason` resolves to
	// the method is exactly the kind of thing that reads wrong at 3am.
	queuedReason as computeQueuedReason,
	OfflineQueue,
	type QueuedReason,
	QueuePriority,
} from "./offline-queue";
import { attachmentCapabilityGained, type PlanState } from "./plan-state";
import { rlog } from "./remote-log";
import type { SyncLog } from "./sync-log";
import { SyncedFileTable } from "./synced-file";
import { DefaultTimeProvider, type TimeProvider } from "./time-provider";
import type {
	AttachmentChange,
	EngramSyncSettings,
	FileSyncState,
	ManifestResponse,
	NoteChange,
	NoteStreamEvent,
	ParseReason,
	QueueEntry,
	ReconcileResult,
	SyncChange,
	SyncIssueCategory,
	SyncLogEntry,
	SyncOp,
	SyncPlan,
	SyncProgress,
	SyncStatus,
} from "./types";

/**
 * Pure routing helper: for a markdown note, apply the disk content into the
 * CRDT doc (no full-document POST); for binary files, return false so the
 * caller falls through to the existing attachment push path.
 */
/** Notes larger than this are NOT routed through CRDT — see routeModify. The
 *  channel base64-encodes each update (~+33%), so the cap stays well under
 *  Bandit's 8 MB WebSocket fragmented-message limit even after encoding. Large
 *  notes still sync via the legacy push path (server-gated at 10 MB / 413). */
export const MAX_CRDT_NOTE_BYTES = 4 * 1024 * 1024;

/** Sentinel `crdtHead` recorded locally the moment `crdt_create` succeeds, so
 *  the `hasServerNote` oracle flips to true immediately (the server row exists)
 *  without waiting for the first server-delivered head. Never equals a real
 *  server content-hash head, so the convergence cost gate (`getCrdtHead ===
 *  serverHead → skip`) always runs at least once after create and overwrites
 *  this with the authoritative head. */
export const CRDT_HEAD_CREATED = "__crdt_created__";

/** True when `content` is too large to enter the Yjs doc: seeding it would
 *  produce a base64 `crdt_msg` past Bandit's 8 MB WebSocket frame limit → 1009,
 *  killing the socket (and re-crashing on every reconnect). Every CRDT seed
 *  path MUST gate on this — a caller that forgets recreates that crash loop.
 *  Measures UTF-8 bytes (not code units) so multi-byte content can't slip past.
 *  `maxBytes <= 0` disables the cap. */
export function exceedsCrdtNoteLimit(content: string, maxBytes: number): boolean {
	return maxBytes > 0 && new TextEncoder().encode(content).length > maxBytes;
}

export async function routeModify(
	file: { crdtEligible: boolean; noteId: string; readContent: () => Promise<string> },
	crdt: {
		applyLocalEdit: (
			noteId: string,
			content: string,
			hasLca?: boolean,
			reread?: () => Promise<string>,
		) => Promise<string | null>;
	},
	maxBytes: number,
): Promise<string | null> {
	// CRDT-eligible = markdown OR canvas (both ride the Yjs transport). The
	// manager's docKind selects the schema (body Y.Text vs nodes/edges Y.Maps);
	// this gate just keeps binary/attachment types off the CRDT path.
	if (!file.crdtEligible) return null;
	const content = await file.readContent();
	// Oversized notes must NOT enter the Yjs doc. The channel transmits each
	// update as a base64 crdt_msg (~+33%), so a multi-MB note becomes a
	// WebSocket frame past Bandit's 8 MB fragmented-message limit, which closes
	// the socket (1009) and — because the bloated doc persists in IndexedDB —
	// re-crashes on every reconnect, killing all sync for the vault. Fall through
	// to the legacy push path, which the server gates with a 413.
	if (exceedsCrdtNoteLimit(content, maxBytes)) {
		return null;
	}
	// readContent doubles as the stale-snapshot reread: when a remote update
	// merges between this read and the diff, the manager re-reads instead of
	// diffing a snapshot that would delete the remote ops (e2e test_83). The
	// wrapper re-enforces the size cap on every reread — the file can grow
	// past MAX_CRDT_NOTE_BYTES between the check above and the manager's
	// re-read (review sync.ts:2099); the throw makes the manager report
	// NOT-consumed so the legacy path (413-gated server-side) owns the edit.
	const cappedReread = async (): Promise<string> => {
		const fresh = await file.readContent();
		if (exceedsCrdtNoteLimit(fresh, maxBytes)) {
			throw new Error("reread exceeds MAX_CRDT_NOTE_BYTES");
		}
		return fresh;
	};
	// Returns the exact content the manager consumed (which the caller stamps
	// as its echo baseline), or null when declined/not consumed — the legacy
	// push path then owns the write convergently (backend PR #846).
	return await crdt.applyLocalEdit(file.noteId, content, undefined, cappedReread);
}

/** At startup, the on-disk file may have changed while the app was closed
 *  (external editor, another sync app, OS). For a synced note this is NOT a
 *  3-way merge: diff the disk content into the Y.Doc as a local edit. The CRDT
 *  converges it with any remote history once the handshake runs. `onCorruption`
 *  is only a last resort if the doc itself cannot be opened/decoded.
 *
 *  The try/catch is split into two distinct error categories:
 *  - `getText` (decode) failure → `onCorruption` — the Y.Doc state is unreadable,
 *    so we surface a notice and fall back to the on-disk content.
 *  - `applyLocalEdit` (write) failure → swallowed — a transient storage write error
 *    must not masquerade as CRDT corruption. The CRDT handshake will converge the
 *    state once connectivity is restored. */
export async function reconcileColdStart(
	// `path` is retained purely for log messages (a note_id is meaningless to a
	// human reading the console); every CRDT call below routes on `noteId`.
	// `reread` is the live disk read forwarded to the manager's stale-snapshot
	// guard: startup is the LONGEST entry-await window in the codebase
	// (IndexedDB whenSynced replay), and a frozen diskContent diffed after a
	// concurrent remote merge would delete the remote ops (review sync.ts:153,
	// same class as the pushFile/test_83 fix).
	file: { path: string; noteId: string; diskContent: string; reread?: () => Promise<string> },
	crdt: {
		// Returns the consumed content (or null when declined) but the value is
		// intentionally ignored here — a DECLINED write (handshake gate) is
		// treated identically to a successful write: the legacy fullSync /
		// pushModifiedFiles path owns those files until their STEP2 handshake
		// completes.
		applyLocalEdit: (
			noteId: string,
			content: string,
			hasLca?: boolean,
			reread?: () => Promise<string>,
		) => Promise<string | null | boolean | undefined>;
		getText: (noteId: string) => Promise<string>;
		projectedText: (noteId: string) => Promise<string>;
		enroll?: (noteId: string) => void;
	},
	onCorruption: () => void,
	maxBytes: number = MAX_CRDT_NOTE_BYTES,
): Promise<void> {
	// Same cap as routeModify: an oversized note must NEVER enter the Yjs doc.
	// Seeding it here produces a base64 crdt_msg past Bandit's 8 MB frame limit
	// → 1009 → and because cold-start reconcile re-runs on every reconnect, a
	// permanent crash loop that kills all sync for the vault. Leave it to the
	// legacy push path (server-gated at 10 MB / 413). Default-capped so a future
	// caller cannot reintroduce this by forgetting to pass the limit.
	if (exceedsCrdtNoteLimit(file.diskContent, maxBytes)) {
		return;
	}
	let current: string;
	try {
		current = await crdt.projectedText(file.noteId);
	} catch {
		onCorruption(); // notice + disk-content fallback, only on decode failure
		return;
	}
	if (current === file.diskContent) return; // already in sync
	try {
		// Positional-args pattern: only pass the trailing reread when the caller
		// supplied one — an explicit trailing `undefined` changes
		// Function.arguments.length, which existing tests pin exactly.
		if (file.reread) {
			await crdt.applyLocalEdit(file.noteId, file.diskContent, undefined, file.reread);
		} else {
			await crdt.applyLocalEdit(file.noteId, file.diskContent);
		}
	} catch (e) {
		// Storage write failure: do not masquerade as corruption. The CRDT
		// handshake will converge the state once connectivity is restored.
		rlog().warn(
			"crdt",
			`reconcileColdStart: write failed for ${noteRef(file.path)}: ${errMsg(e, file.path)}`,
		);
	}
	// A drifted note must always get a handshake: when the doc is history-less
	// and the adopt-first seed gate skipped inside applyLocalEdit (IDB-evicted
	// doc whose disk content matches the last-synced hash), the note converges
	// ONLY via STEP1/STEP2 — without enrolling here it would silently sit out
	// live sync until the user opens it. Enrollment is idempotent (once per
	// session), so seeding paths pay nothing extra.
	crdt.enroll?.(file.noteId);
}

/** Count distinct parent folders across the given file paths. Files at the
 *  root contribute nothing; "a/b/c.md" contributes "a/b". Used by the sync
 *  preview to surface "how many folders contain files" per side. */
function countFolders(paths: Iterable<string>): number {
	const set = new Set<string>();
	for (const p of paths) {
		const idx = p.lastIndexOf("/");
		if (idx > 0) set.add(p.substring(0, idx));
	}
	return set.size;
}

/** How long (ms) after a push completes to suppress WebSocket echoes for that path. */
const ECHO_COOLDOWN_MS = 5000;

/** How long (ms) after THIS device deletes a note to refuse resurrecting it
 *  via either CRDT convergence path (catch-up head map or vault-channel
 *  fan-out). Keyed by note_id — a recreate at the same path mints a fresh id
 *  (handleDelete clears the mapping), so this only suppresses the tombstoned
 *  id, never a legitimate recreation. Sized to backend #970's same-user
 *  delete-then-recreate window: within it the server won't have a live row for
 *  this id anyway (delete-wins), so honoring the local tombstone is exact. */
const RECENT_DELETE_COOLDOWN_MS = 60_000;
/** How long a relocation's origin stays available to a later materialization.
 *  Generous next to the milliseconds a racing flush needs, and short next to
 *  the lifetime of a path that might legitimately be recreated. */
const RELOCATION_MEMORY_MS = 30_000;
/** How long the serialized stream queue waits on one event before moving on.
 *  Generous next to any real apply (disk + a manifest fetch), short next to a
 *  session. */
const STREAM_EVENT_STALL_MS = 30_000;

/** Debounce window for the ok->degraded transition Notice: aggregates a
 *  burst of newly-degraded notes (e.g. a batch push) into one Notice. */
const DEGRADED_NOTICE_DEBOUNCE_MS = 1500;
const DEGRADED_NOTICE_DURATION_MS = 10_000;

/** Paths that are always ignored regardless of user settings.
 *  Note: Obsidian's config dir defaults to `.obsidian` but can be customized;
 *  shouldIgnore() reads `app.vault.configDir` at runtime to handle that. */
const ALWAYS_IGNORED = [".trash/", ".git/"];

// Re-exported so existing importers keep working; the implementation moved to
// content-hash.ts to stop a hash-only consumer pulling this module in.
export { fnv1a };

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

/** Per-batch concurrency for the per-file push loop (both the incremental and
 *  the force pipeline). Was a magic 10 in two places. */
const PUSH_BATCH_SIZE = 10;

type CrdtCatchupSinceFn = (
	cursorSeq: number,
	limit?: number,
	cursorId?: string | null,
) => Promise<{
	changes: SyncChange[];
	has_more: boolean;
	next_seq: number | null;
	next_id?: string | null;
}>;

/** Socket frame name for the room-free doc read, latched in `unsupportedFrames`
 *  when a server proves it does not implement it. */
const DOC_STATE_FRAME = "crdt_doc_state";

/** Room-free full Yjs state for one note — see `CrdtChannel.crdtDocState`. */
type CrdtDocStateFn = (docId: string) => Promise<{ b64: string; head: string }>;

/** Byte size at or below which a `Yjs.encodeStateAsUpdate` result carries no
 *  content. An empty v1 update is a 2-byte header (`0x00 0x00`) and the
 *  smallest one carrying a single character is 11B, so there is no small note
 *  this can misread as empty.
 *
 *  Pinned to encodeStateAsUpdate WITHOUT a state vector, and to v1: the same
 *  empty doc encodes to 13B under `encodeStateAsUpdateV2`, and a FULL doc
 *  encodes to 2B when diffed against its own state vector. Either change turns
 *  this constant from a guard into a silent no-op or a false positive. */
const EMPTY_YJS_UPDATE_BYTES = 2;

/** Socket frame name for the room-free doc WRITE, latched in
 *  `unsupportedFrames` alongside the read. */
const DOC_UPDATE_FRAME = "crdt_doc_update";

/** Room-free delivery of this device's ops for one note — see
 *  `CrdtChannel.crdtDocUpdate`. */
type CrdtDocUpdateFn = (docId: string, b64: string) => Promise<{ head: string }>;

/** Late-injection wiring for the CRDT stack (#376 prerequisite 2). main.ts
 *  wires these in stages — boot, channel join, teardown — each stage passing
 *  only its subset to `setCrdtPorts`. A key must be PRESENT in the patch to
 *  be assigned; an explicitly-null key clears that port. The individual
 *  `setX` methods on SyncEngine are thin shims over this, kept because they
 *  are harness-facing surface (engram/e2e/headless/run.ts and
 *  tests/sim/replica.ts drive them). */
export interface CrdtPorts {
	manager?: ProviderRegistry | null;
	deviceId?: string | null;
	noteIdMap?: NoteIdMap | null;
	enrollment?: { enroll(path: string): void; reset(path: string): void } | null;
	create?:
		| ((
				docId: string,
				path: string,
				b64?: string,
		  ) => Promise<{ docId: string; seeded: boolean; genesisOutcome: GenesisOutcome }>)
		| null;
	delete?: ((docId: string) => Promise<{ doc_id: string }>) | null;
	enqueue?: ((op: { kind: "create" | "delete"; docId: string; path: string }) => void) | null;
	/** Drop every outbound CRDT op still pending delivery, plus the unsent-doc
	 *  tracking set. Both key work by note_id with no vault attached, so both are
	 *  per-vault state that a vault change must discard (engram #1318). */
	resetOutbox?: (() => void) | null;
	live?: (() => boolean) | null;
	/** Nulling this restores the default never-bound check rather than leaving
	 *  the port empty — `isLiveBound` is called unconditionally on the push
	 *  path, so it is the one port with no null state to fall into. */
	liveBound?: ((path: string) => boolean) | null;
	catchupSince?: CrdtCatchupSinceFn | null;
	/** Room-FREE full-state read for one note (#1409). Null on a backend too
	 *  old to serve `crdt_doc_state`; callers fall back to the room
	 *  handshake, so an unwired port costs rooms, never convergence. */
	docState?: CrdtDocStateFn | null;
	/** Room-FREE delivery of a queued edit for an IDLE note (#1493). Null on a
	 *  backend too old to serve `crdt_doc_update`; the caller falls back to the
	 *  room re-handshake, so an unwired port costs rooms, never delivery. */
	docUpdate?: CrdtDocUpdateFn | null;
	/** #1409: tell the server this device is done with a note's room, so its
	 *  `auto_exit` can fire now instead of after the 5-minute idle drain. */
	release?: ((docId: string) => void) | null;
}

/** Thrown by `walkOpLog` when the op-log FETCH itself fails, so a caller can
 *  swallow a transport failure WITHOUT also swallowing errors raised by its own
 *  `onRow` / `onPage` work. The seq-replay needs exactly that distinction: a
 *  dropped socket is recoverable (keep the pages already applied, resume next
 *  pass), but a failed cursor persist is not — reporting success there would
 *  hand a destructive caller a server-id set built from a walk that stopped
 *  early. The original failure is folded into the message rather than passed as
 *  `cause` — `lib` is ES2021 here, where `Error`'s options argument isn't typed. */
class OpLogFetchError extends Error {
	constructor(
		readonly cursorSeq: number,
		cause: unknown,
	) {
		super(`op-log fetch failed at cursor=${cursorSeq} — ${errMsg(cause)}`);
		this.name = "OpLogFetchError";
	}
}

/** A collection the engine can sweep on teardown. Map and Set both satisfy it. */
type Sweepable = { clear(): void };

/**
 * The two teardowns a collection can die in. They are INDEPENDENT, not a
 * severity ladder: `syncState` is swept on a vault switch but must survive
 * `destroy()` (it is the persisted sync baseline, and blanking it there would
 * force a full re-scan), while `debounceTimers` is the exact inverse — a
 * debounce pending across a vault switch still describes a real local edit
 * that still deserves a push. Collapsing these into one axis is what let the
 * two hand-written lists drift apart in the first place.
 */
type SweepEvent = "vault" | "destroy";

export class SyncEngine {
	/**
	 * Every collection that a teardown has to sweep, declared WITH its scope so
	 * that neither teardown path enumerates anything by hand.
	 *
	 * This replaces two independently-maintained lists — `destroy()` and
	 * `wipePerVaultState()` — that had been drifting apart since March 2026.
	 * Each was correct for its own job: `destroy()` swept the transient
	 * per-note maps and deliberately spared the persisted `syncState`, while
	 * `wipePerVaultState()` swept `syncState` + cursors + identity and left the
	 * per-note maps alone. Nothing owned their INTERSECTION — state that is both
	 * vault-scoped and transient — so eleven note_id- and path-keyed maps
	 * survived a vault switch and went on addressing the NEW vault with the OLD
	 * vault's ids (#1409). Six separate bug fixes added a field to one list and
	 * not the other, because a declaration 3,000 lines from either list carries
	 * no hint that a decision is owed.
	 *
	 * `["vault", "destroy"]` — describes the remote vault (paths, note_ids,
	 *             cursors). Swept on a vault switch AND on destroy.
	 * `["destroy"]` — local operating state that legitimately outlives a vault
	 *             switch (in-flight push guards, debounce timers).
	 *
	 * Declared FIRST: class field initializers run top-to-bottom, and every
	 * `track()` call below pushes into this array.
	 */
	private readonly sweepable: Array<{
		on: readonly SweepEvent[];
		collection: Sweepable;
		dispose?: (value: unknown) => void;
	}> = [];

	/**
	 * Register a collection for teardown and return it, so the scope decision
	 * lives at the declaration rather than in a list somewhere else.
	 * `dispose` runs per map value before the clear — that is where a timer
	 * gets cancelled, so sweeping can never strand one.
	 */
	private track<T extends Sweepable>(
		on: readonly SweepEvent[],
		collection: T,
		dispose?: (value: T extends Map<unknown, infer V> ? V : never) => void,
	): T {
		this.sweepable.push({ on, collection, dispose });
		return collection;
	}

	/** Dispose + clear every tracked collection registered for `event`.
	 *
	 *  Each entry is isolated. A throw used to abandon the whole sweep at the
	 *  first bad entry, leaving every collection AFTER it fully populated — and
	 *  since the registry exists precisely so a vault switch cannot leave the
	 *  previous vault's note_ids behind, one throwing dispose would reinstate
	 *  the bug for all of them, silently and in registration order. Failures are
	 *  collected and logged; the `clear()` still runs even when the dispose for
	 *  that same entry threw, because a leaked timer is a smaller problem than a
	 *  retained cross-vault map. */
	private sweep(event: SweepEvent): void {
		const failures: string[] = [];
		for (const entry of this.sweepable) {
			if (!entry.on.includes(event)) continue;
			if (entry.dispose) {
				for (const value of (entry.collection as Map<unknown, unknown>).values()) {
					try {
						entry.dispose(value);
					} catch (e) {
						failures.push(`dispose: ${errMsg(e)}`);
					}
				}
			}
			try {
				entry.collection.clear();
			} catch (e) {
				failures.push(`clear: ${errMsg(e)}`);
			}
		}
		if (failures.length > 0) {
			rlog().warn(
				"lifecycle",
				`sweep(${event}): ${failures.length} entr${failures.length === 1 ? "y" : "ies"} ` +
					`failed but the rest were swept — ${failures.join("; ")}`,
			);
		}
	}

	private debounceTimers = this.track(["destroy"], new Map<string, number>(), (timer) =>
		this.time.clearTimeout(timer),
	);
	/** Paths that newly degraded (ok/none -> frontmatter issue) since the last
	 *  flush, awaiting the debounced Notice below. */
	private pendingDegraded = this.track(["destroy"], new Set<string>());
	private degradedNoticeTimer: number | null = null;
	private ignorePatterns: string[] = [];
	private pushing = this.track(["destroy"], new Set<string>());
	/** Per-path echo-suppression markers (#358). Replaces three parallel
	 *  path-keyed TTL maps — `recentlyPushed`, `remotelyDeleted`,
	 *  `recentlyFlushed` — with one object per file. See synced-file.ts for the
	 *  meaning of each marker and why `flushed` must stay distinct from `pushed`.
	 *  Unlike the maps it replaces, its timers are cancelled on teardown.
	 *
	 *  Vault-scoped: the markers are PATH-keyed, so one stranded from the old
	 *  vault suppresses a real event for the same path in the new one — push
	 *  `Notes/a.md` to vault A, switch within the 5s echo window, and vault B's
	 *  DIFFERENT note at that path is dropped as an echo. `remotelyDeleted` has
	 *  the same shape and swallows a genuine user delete. It escaped the
	 *  registry only because it is a composed object rather than a Map. */
	private readonly files = this.track(
		["vault", "destroy"],
		new SyncedFileTable({
			setTimeout: (cb, ms) => this.time.setTimeout(cb, ms),
			clearTimeout: (id) => this.time.clearTimeout(id),
		}),
	);
	/** note_ids THIS device recently deleted. Both CRDT convergence paths
	 *  (the op-log replay's `applyOp` and `applyPushedNoteUpdate`'s fan-out)
	 *  refuse to resurrect an id in here for RECENT_DELETE_COOLDOWN_MS. A stale
	 *  UPSERT replayed (or fanned out) before the server's tombstone lands would
	 *  otherwise re-materialize a just-deleted note; a later tombstone op still
	 *  applies. Keyed by note_id (the key both paths check by), unlike the
	 *  path-keyed offline-queue `hasPendingDelete` guard which only covers a
	 *  delete STILL queued (this covers one already sent/dequeued). */
	private recentlyDeleted = this.track(
		["vault", "destroy"],
		new Map<string, { timer: number; path: string }>(),
		({ timer }) => this.time.clearTimeout(timer),
	);
	private pulling = false;
	private lastSync = "";
	private lastError = "";
	private offline = false;
	private healthCheckTimer: number | null = null;
	/** Consecutive failed health probes — drives exponential backoff. */
	private healthCheckFailures = 0;
	/** In-flight queue flush, for single-flight coalescing (see flushQueue). */
	private flushInFlight: Promise<number> | null = null;
	private ready = false;
	/** When true, all sync actions (file events, stream events, bulk methods)
	 *  short-circuit to a no-op. Controlled by the plugin layer based on
	 *  whether the user has accepted a sync direction in SyncPreviewModal for
	 *  the current auth+vault fingerprint. */
	private syncBlocked = false;
	/** Whether THIS gate closure has already announced itself. One notice per
	 *  closure: the gate stays shut until the user acts, and a nag on every
	 *  keystroke is how a useful message becomes one people dismiss on sight. */
	private blockedEditReported = false;
	/** Announce a gate-blocked edit. Set by main.ts; unset in tests and in any
	 *  headless construction, so the engine stays usable without a UI. */
	onSyncBlockedEdit?: () => void;
	private activePushCount = 0;
	private maxConcurrentPushes = 5;
	/** >0 while a bulk sweep (pushAll / fullSync) is running. Queue entries it
	 *  produces get Background priority — see priorityForPath. */
	private bulkDepth = 0;
	private pushWaiters: (() => void)[] = [];
	readonly queue: OfflineQueue = new OfflineQueue();

	/** Per-file sync metadata (content hash + server version).
	 *  Used to detect whether the user actually modified a file since
	 *  the last sync (Obsidian sets mtime to "now" on vault.modify(),
	 *  making mtime-based detection unreliable). */
	private syncState = this.track(["vault"], new Map<string, FileSyncState>());

	/** The server vaultId that the current syncState belongs to. lastSync and
	 *  per-file hashes are scoped to one server vault; if the active vault
	 *  changes out from under us, this stale bookkeeping must be invalidated
	 *  or fullSync compares against the wrong vault and pushes nothing / wrong
	 *  files. `null` means "not yet recorded" (fresh install or pre-upgrade
	 *  data) and is adopted without wiping. */
	private syncStateVaultId: string | null = null;

	/** Monotonic identity-swap counter (#283). Bumped by main.ts on every OAuth
	 *  token save/clear — the points where `this.api`'s auth provider is swapped.
	 *  A destructive manifest-diff reconcile captures this before fetching the
	 *  manifest and refuses to trash if it changed while the fetch was in flight:
	 *  a manifest resolved across an identity swap can be a stale snapshot that
	 *  omits live notes, and trashing those as "server-deleted" is data loss.
	 *  Same-vault token refresh (test_48) can't be caught by the vaultId guard,
	 *  so this is a separate, swap-precise signal. */
	private authGeneration = 0;

	/** This user's server content_hash for EMPTY content, learned from an
	 *  authoritative op-log ROW that carries "" beside its hash (the hash is a
	 *  per-user HMAC — underivable client-side but deterministic; the old
	 *  learn-by-fetch died with the Phase E3 REST purge). Lets the ingress
	 *  guard trust inline-empty bodies carrying this exact hash. Session-
	 *  scoped; a stale value after a DEK rotation or account swap stops
	 *  matching, and the distrusted event routes to the op-log catch-up —
	 *  the failure direction is a replay round-trip, never a 0-byte write. */
	private emptyContentHash: string | null = null;

	/** Optional base content store for 3-way merge (Step 2+). */
	baseStore: BaseStore | null = null;

	/** Persisted set of server-side "explicit empty folder" markers. Owned by
	 *  the plugin layer (main.ts) and assigned after construction, matching the
	 *  baseStore pattern. */
	explicitFolders: ExplicitFolders | null = null;

	/** Called whenever sync status changes (for status bar updates). */
	onStatusChange: ((status: SyncStatus) => void) | null = null;

	/** Called after each batch during pushAll/pullAll to report progress. */
	onSyncProgress: ((progress: SyncProgress) => void) | null = null;

	/** Fired (fire-and-forget) when a sync step swallows an error to keep the
	 *  flow alive — the swallowing is deliberate (one bad file must not abort a
	 *  sync), but a vault-scoped HTTP 404 buried this way is how a DEAD VAULT
	 *  presents, and the dead-vault self-heal (main.ts healDeadVault) can only
	 *  run if it sees the error (review finding 2). */
	onVaultScopedError: ((e: unknown) => void) | null = null;

	/** Last-known plan/entitlement state, fed by the channel's `onPlanState`
	 *  callback (user-topic join reply + `subscription_activated`). Drives the
	 *  upgrade-triggered re-sync of plan-skipped attachments. Null until the
	 *  first plan event arrives (or an older backend that never sends one). */
	private planState: PlanState | null = null;

	/** Set by main.ts to persist plan state to settings when it changes. */
	onPlanStatePersist: ((p: PlanState) => void) | null = null;

	/** Optional sync log — receives an entry for each push/pull outcome. */
	syncLog: SyncLog | null = null;

	/** Optional CRDT manager — when set, markdown saves route through it instead
	 *  of the full-document pushNote POST. dbPrefix must equal the active vaultId
	 *  for IndexedDB namespacing; the CRDT doc itself is keyed by the note's bare
	 *  note_id, matching the backend's note_id lookup. */
	private crdt: ProviderRegistry | null = null;

	/** Wire (a subset of) the CRDT ports in one call — see CrdtPorts. Only
	 *  keys present in the patch are assigned, so each lifecycle stage names
	 *  exactly what it wires (or clears, via explicit null). */
	setCrdtPorts(ports: CrdtPorts): void {
		if ("manager" in ports) this.crdt = ports.manager ?? null;
		if ("deviceId" in ports) this.deviceId = ports.deviceId ?? null;
		if ("noteIdMap" in ports) this.noteIdMap = ports.noteIdMap ?? null;
		if ("enrollment" in ports) this.crdtEnrollment = ports.enrollment ?? null;
		if ("create" in ports) this.crdtCreate = ports.create ?? null;
		if ("delete" in ports) this.crdtDelete = ports.delete ?? null;
		if ("enqueue" in ports) this.crdtEnqueue = ports.enqueue ?? null;
		if ("resetOutbox" in ports) this.crdtResetOutbox = ports.resetOutbox ?? null;
		if ("live" in ports) this.crdtLive = ports.live ?? null;
		if ("liveBound" in ports) this.isLiveBound = ports.liveBound ?? (() => false);
		if ("catchupSince" in ports) this.crdtCatchupSince = ports.catchupSince ?? null;
		if ("docState" in ports) this.crdtDocState = ports.docState ?? null;
		if ("docUpdate" in ports) this.crdtDocUpdate = ports.docUpdate ?? null;
		if ("release" in ports) this.crdtRelease = ports.release ?? null;
	}

	setCrdtManager(mgr: ProviderRegistry | null): void {
		this.setCrdtPorts({ manager: mgr });
	}

	/** This install's opaque device id (main.ts mints + persists it; the API
	 *  client sends it as X-Device-Id on every REST call). The server stamps
	 *  it into `note_changed` delete broadcasts (#970) so we can drop our own
	 *  fanout echoes — the origin-attributed guard used below (and by the
	 *  editor-detach/rebind wiring just after it). Null in tests/older
	 *  callers: the drop is then skipped. */
	private deviceId: string | null = null;

	setDeviceId(id: string | null): void {
		this.setCrdtPorts({ deviceId: id });
	}

	/** Detaches every live editor binding (CrdtLiveViews.detachAll, wired by
	 *  main.ts). Replace-remote's crdtDelete destroys Y.Docs whose files stay
	 *  on disk and may be OPEN — unlike the WS-delete path, no trashFile
	 *  closes the view, so a still-attached binding would write keystrokes
	 *  into a destroyed doc (the never-span-a-load class,
	 *  crdt-editor-bind-race-pollution.md). Bindings re-establish via the
	 *  normal refresh events; meanwhile edits flow through handleModify as
	 *  plain pushes.
	 *
	 *  DEAD as of #258 (main.ts:443 — "the old setCrdtEditorDetach /
	 *  setCrdtEditorRebind wiring is gone"): nothing reads this field any more.
	 *  The setter is retained because it is still part of the harness-facing
	 *  surface — engram/e2e/headless/run.ts:330 and tests/sim/replica.ts:447
	 *  both call it. Removing the pair therefore needs a paired backend PR. */
	/** No-op harness-compat shim (paired-cleanup pending): the field and port
	 *  behind this were deleted — nothing ever read them. engram/e2e/headless/
	 *  run.ts:330 and tests/sim/replica.ts:447 still call the setter, so it
	 *  stays until a paired backend PR drops those calls. */
	setCrdtEditorDetach(_fn: (() => void) | null): void {}

	/** No-op harness-compat shim, same shape as `setCrdtEditorDetach` above.
	 *  The field and port behind it are gone: the CM6 ViewPlugin
	 *  (live-binding.ts) re-resolves path -> note_id on every update and
	 *  re-attaches itself, so nothing external ever needs to rebind an editor.
	 *  engram/e2e/headless/run.ts:331 and tests/sim/replica.ts:448 still call
	 *  this setter, so it stays until a paired backend PR drops those calls. */
	setCrdtEditorRebind(_fn: ((path: string) => void) | null): void {}

	/** Path -> note_id sidecar (Task 4, `src/crdt/note-id-map.ts`). Owned by
	 *  main.ts (persisted in data.json); wired here so pushFile can mint/send
	 *  client_id for new notes, the pull path can learn ids, and handleRename
	 *  can keep the mapping stable across a move (Task 5). Null in tests/older
	 *  callers that never wire it — id-minting and pull-learning are then
	 *  simply skipped (pre-existing legacy path-keyed behavior). */
	private noteIdMap: NoteIdMap | null = null;

	setNoteIdMap(map: NoteIdMap | null): void {
		this.setCrdtPorts({ noteIdMap: map });
		// Follow identity with the bytes. The store reports a claim MOVING; this
		// engine owns the vault, so it performs the corresponding file move.
		//
		// Optional call: several suites pass structural doubles for this port
		// (a bare `{ tag: "map" }`, a stub with only the two methods under test),
		// and wiring a diagnostic-adjacent hook must not be what breaks them. In
		// production this is always a real NoteIdMap, so the method is always there.
		map?.setRelocateHandler?.((from, to) => {
			// RECORD FIRST, move second. The move can lose: a concurrent flush or
			// the discovery create may reach the new path first, and then this
			// rename finds the target occupied and gives up -- which is exactly how
			// a rename degraded into create-here + trash-there. The record is what
			// lets whoever DOES materialize the path turn its create into a move,
			// so the outcome no longer depends on who wins.
			this.rememberRelocation(normalizePath(from), normalizePath(to));
			void this.renameFollowingIdentity(from, to);
		});
	}

	/** Move a note's file to follow a relocation of its identity.
	 *
	 *  A rename arrives as identity first: some path now claims a note that lived
	 *  somewhere else. The map is updated early (the doc-ready announce,
	 *  discovery) and the file is not, so by the time the rename's upsert is
	 *  applied `pathForId` already reports the new location -- the relocation
	 *  check sees nothing to do, the create branch finds the target empty and
	 *  writes a NEW file, and the rename's delete leg trashes the old one. The
	 *  note survives with its id and loses its file identity: open tabs close,
	 *  backlinks and creation date reset. That is the "it deleted and remade my
	 *  note" report.
	 *
	 *  Doing it here means the move happens the moment identity moves, whichever
	 *  path moved it, instead of being reconstructed later from a delete/create
	 *  pair that no longer carries both halves.
	 *
	 *  `vault.rename`, deliberately, NOT `fileManager.renameFile`: the server has
	 *  already rewritten links for a rename it originated, and renameFile would
	 *  rewrite them a second time (the exactly-one-rewriter invariant).
	 *
	 *  Best effort by construction. If the source is gone the move already
	 *  happened (a local rename this device performed reaches the store the same
	 *  way, after Obsidian moved the file). If the target is occupied, something
	 *  else materialized it and overwriting is not this function's call -- the
	 *  existing convergence paths own that. */
	/** New path -> the path its note came from, for as long as a materialization
	 *  might still arrive. Bounded by a TTL: a note that is never materialized at
	 *  the new path must not pin a stale origin forever, or a LATER genuine
	 *  create at that path would be turned into a move of an unrelated file. */
	private relocatedFrom = this.track(
		["vault", "destroy"],
		new Map<string, { from: string; timer: number }>(),
		({ timer }) => this.time.clearTimeout(timer),
	);

	/** note_id -> where THIS engine last put that note's file.
	 *
	 *  The registry Relay has as `files: Map<guid, IFile>`: an engine-owned
	 *  id->file binding, separate from the shared identity map. It exists because
	 *  the shared map cannot answer "where is this note's file" during a rename --
	 *  a claim erases the old key by design, which is precisely what makes a
	 *  rename indistinguishable from a note appearing from nowhere.
	 *
	 *  It supersedes the `data.json` cache fallback, which only ever knew notes
	 *  present at load: a note learned during the session is written to the
	 *  store's overlay, never its seed cache, so a rename of a freshly-received
	 *  note had no origin to recover and recreated the file. Caught by e2e
	 *  test_93 (inode changed), invisible to a manual test on a note that
	 *  predated a plugin reload.
	 *
	 *  Best-effort by nature -- an in-memory record of what this process did, not
	 *  an authority. Consumers verify against the disk before acting on it. */
	private fileForNote = this.track(["vault", "destroy"], new Map<string, string>());

	/** Record that `path` currently holds whichever note claims it. Called after
	 *  this engine puts a note's bytes somewhere: a create, a move, a local
	 *  rename. Cheap enough to call on every write, and a miss only costs the
	 *  recreate this exists to avoid. */
	private rememberFileFor(path: string): void {
		const at = normalizePath(path);
		const id = this.noteIdMap?.get(at) ?? null;
		if (id) this.fileForNote.set(id, at);
	}

	/** Remember where a note came from, for as long as a materialization might
	 *  still arrive. The expiry timer is HELD, not fired and forgotten: every
	 *  other TTL map here is swept by `destroy()`, and one that is not leaves
	 *  timers firing against a torn-down engine after a plugin reload. That is
	 *  the exact trap `SyncedFileTable` was written to close -- "adding a fourth
	 *  marker meant remembering to add a fourth loop" -- so this one holds its
	 *  handle and is swept with the rest. */
	private rememberRelocation(from: string, to: string): void {
		const existing = this.relocatedFrom.get(to);
		if (existing) this.time.clearTimeout(existing.timer);
		this.relocatedFrom.set(to, {
			from,
			timer: this.time.setTimeout(() => this.relocatedFrom.delete(to), RELOCATION_MEMORY_MS),
		});
	}

	/** Fallback origin for a note being materialized at `target`, for the case
	 *  `relocatedFrom` never saw the move.
	 *
	 *  The live record only exists when the relocation ran through the store's
	 *  claim path. In the field the map is reached other ways -- the doc-ready
	 *  announce, catch-up, discovery -- and then the move is already done by the
	 *  time anything observable happens, with no record of where the note came
	 *  from. data.json's cached mapping is not erased by a claim, so it still
	 *  remembers, and this asks it.
	 *
	 *  Strictly a hint: the cache is a load-time snapshot, so the candidate is
	 *  returned only if a file is actually sitting there. The caller additionally
	 *  requires `target` to be empty before moving anything. */
	private staleOriginFor(target: string): string | undefined {
		const id = this.noteIdMap?.get(target) ?? null;
		if (!id) return undefined;
		// The registry first: it knows notes learned this session, which the
		// data.json cache never does. Both are hints, and both go through the same
		// verification below.
		const remembered = this.fileForNote.get(id);
		const candidates = [
			...(remembered && remembered !== target ? [remembered] : []),
			...(this.noteIdMap?.priorPathsForId?.(id) ?? []),
		];
		for (const candidate of candidates) {
			const at = normalizePath(candidate);
			if (at === target) continue;
			// The remembered path may have been REUSED by a different note since
			// the snapshot was taken. Moving it then would hand one note's file to
			// another -- silent data loss, and worse than the recreate this exists
			// to avoid. Only an unclaimed path, or one still claimed by this same
			// note, is safe to move.
			const holder = this.noteIdMap?.get(at) ?? null;
			if (holder && holder !== id) continue;
			// EVIDENCE: this engine must have synced that path itself. A note the
			// user created locally and never synced carries NO claim, so the check
			// above waves it through -- and a path we vacated is exactly where a
			// user is likely to make one ("Foo.md" again). Moving it would hand
			// their file to a different note. Sync evidence is the cheap
			// discriminator (no read), and its absence fails toward an ordinary
			// create, which is recoverable.
			// Either form of bookkeeping counts. Requiring sync-state alone would
			// gate the recovery on state that other paths legitimately drop, and
			// this fallback is the ONLY thing standing between a remote rename and
			// a recreate -- narrowing it too far silently reinstates the bug. A
			// stranger's never-synced file has neither.
			if (!this.syncState.has(at) && !this.baseStore?.get(at)) continue;
			if (this.app.vault.getFileByPath?.(at)) return at;
		}
		return undefined;
	}

	private async renameFollowingIdentity(from: string, to: string): Promise<void> {
		const src = normalizePath(from);
		const dest = normalizePath(to);
		if (src === dest) return;
		const file = this.app.vault.getFileByPath?.(src);
		if (!file) return;
		if (this.app.vault.getAbstractFileByPath?.(dest)) return;
		try {
			const folder = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : "";
			if (folder) await this.ensureFolder(folder);
			// Obsidian fires a vault `rename` for this move exactly as it would for
			// a user drag; without the marker the echo is pushed back as a fresh
			// rename. Marked on BOTH ends -- the event carries both, and which one
			// a guard reads depends on the caller.
			this.files.mark(src, "remotelyRenamed", ECHO_COOLDOWN_MS);
			this.files.mark(dest, "remotelyRenamed", ECHO_COOLDOWN_MS);
			await this.app.vault.rename(file, dest);
			// Relay's `doc.move(path)` step: having moved the bytes, move the
			// bookkeeping that was filed under the old path. Skipping it is not
			// harmless — the rename echo guard below returns early precisely
			// BECAUSE it assumes the mover already did this ("the id map, base and
			// sync-state were all re-keyed by the mover"), so a mover that does not
			// leaves the merge base and sync-state stranded on a path that no
			// longer exists. The next convergence then has no common ancestor for
			// the note and resolves by writing a conflict copy.
			//
			// Same shape as the other mover: carry the base across (the content did
			// not change, only its name), then drop the old path's sync-state.
			// Done AFTER the rename, not before, so a failed move leaves the
			// bookkeeping intact rather than destroying state for a file that never
			// went anywhere.
			this.baseStore?.rename(src, dest);
			this.dropPath(src, { dropBase: false });
			this.rememberFileFor(dest);
			rlog().info("pull", `Followed identity move: ${noteRef(src)} -> ${noteRef(dest)}`);
		} catch (e) {
			this.files.clearMarker(src, "remotelyRenamed");
			this.files.clearMarker(dest, "remotelyRenamed");
			// Not fatal and not silent: the note still converges through the
			// create/delete pair, just without keeping its file identity.
			rlog().warn(
				"pull",
				`Identity move could not follow on disk (${noteRef(src)} -> ${noteRef(dest)}): ${errMsg(e, dest)}`,
			);
		}
	}

	/** Populate `noteIdMap` authoritatively from the server manifest's
	 *  `{ id, path }` for every note, WITHOUT a full content pull (manifest is
	 *  id+path+hash only, ~µs/row server-side).
	 *
	 *  This is the fix for inbound CRDT updates stranding with "no known path"
	 *  after the id-keying cutover: live pull of an existing note is CRDT-only
	 *  and `onFlushToDisk` resolves the disk path via `noteIdMap.pathForId`. The
	 *  map was only ever rebuilt during a no-cursor `bootstrap()`, so a device
	 *  whose sync cursor is already set (every normal reconnect) never repaired
	 *  a stale map — `pathForId` returned null and every inbound frame was
	 *  dropped until a manual full sync. Reconciling from the manifest on connect
	 *  keeps the map authoritative so live pull just works.
	 *
	 *  Idempotent; `NoteIdMap.set` overwrites a stale/locally-minted id for a
	 *  path (the manifest is the source of truth). Returns mappings applied. */
	/** Server-authoritative path -> owning note_id snapshot, refreshed by
	 *  reconcileNoteIdMapFromManifest or (re)fetched on demand by
	 *  manifestOwnerOf. Used to verify the local map before DESTRUCTIVE ops
	 *  (moveIfIdRelocated's trash) — the local map itself can be cross-wired,
	 *  so it cannot vouch for itself. */
	/** The snapshot and its freshness stamp, as ONE sweepable unit.
	 *
	 *  They must move together. `owners` being null means "no trustworthy
	 *  snapshot" (callers get `undefined` and refuse to destroy); an EMPTY but
	 *  non-null map means "a fresh manifest says every path is absent", which
	 *  authorizes trashing. So a bare `.clear()` on the map alone would be
	 *  strictly worse than leaking it — which is exactly why this could not be
	 *  a plain tracked Map, and why it was the one collection that survived the
	 *  vault sweep (#1409 review). Encapsulated so it cannot be half-cleared.
	 *
	 *  `fetchedAt` stamps the last fetch ATTEMPT, success or failure, so a
	 *  manifest-less backend negative-caches instead of refetching per event. */
	private manifestOwners = this.track(["vault", "destroy"], {
		owners: null as Map<string, string> | null,
		fetchedAt: 0,
		clear(): void {
			this.owners = null;
			this.fetchedAt = 0;
		},
	});
	private static readonly MANIFEST_OWNERS_TTL_MS = 30_000;

	/** Paths whose id-keyed-move trash was REFUSED (ownership unknowable or
	 *  cross-wired). If such a path is genuinely a renamed-away old copy, the
	 *  refusal leaves a duplicate file no id references — nothing else would
	 *  ever clean it. Swept by the next reconcile against a fresh manifest:
	 *  absent from the manifest + unclaimed by the local map -> trash then. */
	private pendingOrphanSweep = this.track(["vault", "destroy"], new Set<string>());

	/** Who does the server say owns `path` (normalized)? Returns the owning id,
	 *  null when a FRESH manifest confirms the path is absent, or undefined
	 *  when ownership is unknowable (no manifest endpoint / fetch failed) —
	 *  callers must treat undefined as "not safe to destroy". Refreshes the
	 *  snapshot when older than the TTL; trash decisions are rare (renames),
	 *  so the refresh cost lands only on that cold path. */
	private async manifestOwnerOf(path: string): Promise<string | null | undefined> {
		const age = Date.now() - this.manifestOwners.fetchedAt;
		const fresh = this.manifestOwners.fetchedAt > 0 && age <= SyncEngine.MANIFEST_OWNERS_TTL_MS;
		if (!fresh) {
			this.manifestOwners.fetchedAt = Date.now();
			// A failed/absent refresh leaves NO trustworthy snapshot: keeping a
			// stale one would let its false "absent" answers authorize a wrong
			// trash. Refusing (undefined) is always recoverable; a trash is not.
			this.manifestOwners.owners = null;
			try {
				const manifest = await this.api.getManifest();
				if (manifest) this.cacheManifestOwners(manifest);
			} catch {
				// negative-cached by the attempt stamp above
			}
		}
		if (!this.manifestOwners.owners) return undefined;
		return this.manifestOwners.owners.get(path) ?? null;
	}

	private cacheManifestOwners(manifest: ManifestResponse): void {
		this.manifestOwners.owners = new Map(
			manifest.notes.filter((n) => n.id).map((n) => [normalizePath(n.path), n.id as string]),
		);
		this.manifestOwners.fetchedAt = Date.now();
	}

	/** Trash files whose refused id-keyed-move turned out to be a genuine
	 *  rename after all: the path is absent from the (fresh) manifest and no
	 *  local id claims it — a duplicate old copy nothing else will clean. */
	private async sweepPendingOrphans(): Promise<void> {
		for (const p of [...this.pendingOrphanSweep]) {
			this.pendingOrphanSweep.delete(p);
			if (this.manifestOwners.owners?.has(p)) continue; // live server-side note
			if (this.noteIdMap?.get(p)) continue; // locally claimed again
			const file = this.app.vault.getFileByPath(p);
			if (!file) continue;
			this.dropPath(p);
			await this.trashRemotelyDeleted(file);
			rlog().info("pull", `Orphan sweep: trashed renamed-away duplicate ${p}`);
		}
	}

	async reconcileNoteIdMapFromManifest(): Promise<number> {
		if (!this.noteIdMap) return 0;
		const manifest = await this.api.getManifest();
		if (!manifest) return 0; // pre-B1 backend: no manifest endpoint, nothing to reconcile
		this.cacheManifestOwners(manifest); // keep the destructive-op guard's snapshot fresh
		let applied = 0;
		// Every path the server currently holds a note at. Lets us tell a
		// CROSS-WIRE from an IN-FLIGHT RENAME below.
		const manifestPaths = new Set(manifest.notes.map((n) => n.path));
		for (const note of manifest.notes) {
			if (!note.id) continue; // pre-T3.6 backend omitted id — cannot map it
			// A note THIS device just deleted must not be re-mapped, however this
			// reconcile was reached. `ensureNoteIdMapped` skips tombstoned ids so
			// a `note_not_found` costs no fetch, but the other three callers
			// (wiring's stranded-flush drain, main's cold-start and manual
			// reconciles) come straight here — and a manifest fetched inside the
			// delete-wins window still lists the note, because the delete has not
			// landed or the snapshot predates it. Re-`set`ting it undoes
			// `handleDelete`'s `release()`: `sweepPendingOrphans` then sees the
			// path as locally claimed and skips it, and a later recreate at that
			// path adopts the buried id through `getOrMint` instead of minting.
			// Reconciling ANY id against a snapshot older than our own delete is
			// the engine believing stale news over a fact it authored (#491).
			if (this.recentlyDeleted.has(note.id)) continue;
			const localPath = this.noteIdMap.pathForId(note.id);
			if (localPath === note.path) continue; // already correct — nothing to do
			if (localPath !== null && !manifestPaths.has(localPath)) {
				// The id maps to a path the server does NOT list. That's an
				// in-flight rename (or a local-only note) whose new path this
				// manifest snapshot hasn't caught up to — the local mapping is
				// newer. Re-setting the stale manifest path would clobber the
				// reverse index and resurrect the old path (test_10 regression).
				continue;
			}
			// Otherwise the manifest wins. Either the id is unknown locally
			// (drifted/empty map, or a wrong id minted by getOrMint), OR it is
			// cross-wired onto another note's real path (localPath is itself a
			// manifest path, owned by a different id). Both are data-loss vectors:
			// a stale/cross-wired pathForId sends inbound CRDT content to the wrong
			// file. Rebind to the authoritative path (set() evicts the stale
			// forward + reverse entries so the map stays a clean bijection).
			this.noteIdMap.set(note.path, note.id);
			applied++;
		}
		if (applied > 0) {
			await this.saveData({ noteIds: this.noteIdMap.toJSON() });
		}
		// The manifest in hand is as fresh as it gets — resolve any trashes the
		// destructive-op guard deferred while ownership was unknowable.
		await this.sweepPendingOrphans();
		return applied;
	}

	/** Coalesced LIVE id-map reconcile. Called when a crdt_doc_ready announce
	 *  names a note_id the map cannot resolve — the create-race signature:
	 *  another writer (MCP/web) owns the note under an id this device never
	 *  learned, so every announce/frame for it is undeliverable. Today's only
	 *  other heal is the cold-start reconcile, which leaves the note deaf for
	 *  the whole session. Runs the full manifest reconcile (already the
	 *  authoritative {id,path} source; per-id fetch not worth a new endpoint),
	 *  single-flight with one trailing rerun so an announce burst costs at most
	 *  two manifest fetches. */
	ensureNoteIdMapped(noteId: string): void {
		if (!this.noteIdMap || !noteId) return;
		// Intrinsic gate check (not caller-dependent): the reconcile this
		// triggers ends with sweepPendingOrphans, which can trashFile — never
		// run that while the sync gate is closed. Callers may also gate for
		// their own reasons, but safety must not depend on them remembering.
		if (this.syncBlocked) return;
		// Same rule, second trigger (#491): a note THIS device just deleted is
		// not map drift. `note_not_found` for a tombstoned id is the server
		// answering CORRECTLY — the row is gone because we removed it — and the
		// frame that provokes it is routine (a still-bound editor's in-flight
		// crdt_msg, which also throws NoteDestroyedError once teardownCrdtDoc
		// has run). Reconciling on it spends a whole-vault manifest sweep that
		// MOVES files (set → onRelocate → renameFollowingIdentity) and TRASHES
		// them (sweepPendingOrphans) to answer a question we already know the
		// answer to. Users saw a note flash into existence and delete itself.
		//
		// The delete unmaps the id, so the `pathForId` early return below stops
		// covering exactly the ids that need covering — this must come first.
		// `applyPushedNoteUpdate`'s fan-out path already gates on the same
		// tombstone, by the same key, before it calls this; the check belongs
		// HERE so no caller has to remember (see the gate note above).
		//
		// This one saves the pointless manifest FETCH. It is not the safety
		// boundary — `reconcileNoteIdMapFromManifest` has three other callers
		// and carries its own tombstone skip; see there.
		if (this.recentlyDeleted.has(noteId)) return;

		if (this.noteIdMap.pathForId(noteId) !== null) return; // already mapped
		if (this.idMapReconcileInflight) {
			this.idMapReconcileQueued = true;
			return;
		}
		this.idMapReconcileInflight = (async () => {
			try {
				do {
					this.idMapReconcileQueued = false;
					await this.reconcileNoteIdMapFromManifest();
				} while (this.idMapReconcileQueued);
			} catch (e) {
				rlog().warn(
					"sync",
					`live id-map reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			} finally {
				this.idMapReconcileInflight = null;
			}
		})();
	}

	/** Re-drive the create for a note whose index claim the server cannot honour
	 *  (#1550).
	 *
	 *  THE STATE: `filemeta_v0` holds `path → note_id`, no server row exists for
	 *  that id, and the file is still on disk. `getOrMint` publishes a claim as
	 *  soon as it mints, without waiting for `crdt_create` to be acked, so any
	 *  create that fails to land leaves the claim behind. The note then exists on
	 *  exactly one device, every `crdt_msg` for it is dropped `note_not_found`,
	 *  and the server's projection worker retries the unresolvable entry forever
	 *  (`applied=0 unresolved=N`, permanently, for that whole vault).
	 *
	 *  Neither existing heal reaches it. `ensureNoteIdMapped` early-returns on
	 *  `pathForId !== null`, and for an orphan the mapping IS the claim — the id
	 *  vouches for itself. Even past that guard the manifest reconcile iterates
	 *  the notes the SERVER lists, so an id the server has never had appears
	 *  nowhere in it. This is a create that went missing, not a mapping that
	 *  drifted, and the repair for a missing create is to make it again.
	 *
	 *  ONLY CALLED FROM THE `note_not_found` REPLY (`wiring.ts`
	 *  `onCrdtNoteNotFound`), never from the `crdt_doc_ready` announce. That
	 *  matters: the reply is the SERVER stating it has no row for this id, which
	 *  is the only authoritative form of that fact available here. An earlier
	 *  revision hung this off `ensureNoteIdMapped`, which the announce path also
	 *  calls — and `hasServerNote` alone does NOT mean "the server lacks the
	 *  row", because a missing `crdtHead` is a routine state for a healthy note:
	 *  `renamePath` deliberately drops the head at the new path on every rename
	 *  (so `pushFile` takes the genesis branch), and the converge legs only mark
	 *  a note server-known when the staged content is non-empty (#339 — an empty
	 *  converged doc is not proof). An empty note that another device opens, or
	 *  any note inside the window after a rename, would have fired a spurious
	 *  create on every announce.
	 *
	 *  Re-created under the SAME id, deliberately, not a fresh mint: the local
	 *  Y.Doc holding the user's content is keyed by this id, and the existing
	 *  claim already names it. Creating the row under it makes all three sources
	 *  agree at once and carries the body up through the queue's genesis frame. A
	 *  re-mint would strand that doc and leave a second claim to clean up.
	 *
	 *  Gated exactly like every other `crdtEnqueue({kind:"create"})` site: an
	 *  ineligible path (canvas, non-markdown) or an over-cap note is kept OFF the
	 *  CRDT path by design and therefore never has a `crdtHead` — so without
	 *  these it would satisfy every condition here, build an over-cap genesis
	 *  frame, and burn the queue's whole retry budget before surfacing a drop to
	 *  the user. `stat.size` is the file's UTF-8 byte count, the same quantity
	 *  `exceedsCrdtNoteLimit` measures, without reading the file.
	 *
	 *  ONCE PER ID PER SESSION. The durable queue owns retrying a create that
	 *  fails; re-enqueuing on every subsequent `note_not_found` would add nothing
	 *  but a Loki warn per reconnect. Every sibling heal in this file is
	 *  similarly bounded (see `healCooldownMs`).
	 *
	 *  TRIGGER REQUIREMENT worth knowing: this needs a `crdt_msg` to go out for
	 *  the orphan, and `canSendLive` holds ordinary ops behind `hasServerNote`.
	 *  What escapes is a handshake — so the note must be enrolled: open in an
	 *  editor, or in `unsentDocIds` and re-STEP1'd by `reEnrollUnsent` on rejoin
	 *  (which is what fired in the 2026-09-01 prod case, on every reconnect). An
	 *  orphan that is never opened and never edited is not reached from here. */
	repairOrphanedClaim(noteId: string): boolean {
		if (!this.crdtEnqueue || !this.crdt) return false;
		if (this.repairedClaims.has(noteId)) return false;
		const path = this.noteIdMap?.pathForId(noteId);
		if (!path || this.hasServerNote(noteId)) return false;
		if (!this.isCrdtEligiblePath(path)) return false;
		const file = this.app.vault.getFileByPath(normalizePath(path));
		if (!file) return false;
		if ((file.stat?.size ?? 0) > MAX_CRDT_NOTE_BYTES) return false;

		this.repairedClaims.add(noteId);
		// warn, not info: client `info` never reaches Loki, and this is the only
		// client-side signal that a note is stranded on one device.
		rlog().warn(
			"sync",
			`Orphaned index claim for ${noteRef(path)} note_id=${noteId} — the server has no ` +
				`row for it; re-enqueuing the create`,
		);
		this.crdtEnqueue({ kind: "create", docId: noteId, path });
		return true;
	}

	/** Ids `repairOrphanedClaim` has already re-driven. Vault-scoped: a vault
	 *  switch moves us to a different backend, where the same id's status is a
	 *  fresh question. */
	private repairedClaims = this.track(["vault", "destroy"], new Set<string>());

	private idMapReconcileInflight: Promise<void> | null = null;
	private idMapReconcileQueued = false;

	/** note_ids the SERVER is known to already have a note row for — learned
	 *  either from a seq-replay catch-up (`applySyncChange`) or confirmed by a
	 *  successful REST push response. The backend's CRDT channel now requires
	 *  the note to pre-exist (note_in_vault?) and silently drops a crdt_msg for
	 *  an unknown note_id — it can no longer bootstrap a note row from a bare
	 *  wire doc_id (no path on the frame). So a note's FIRST push must go via
	 *  REST (which creates the row and adopts the client-minted id); only once
	 *  confirmed here may subsequent edits route through CRDT. Keyed by note_id
	 *  (not path) so a delete+recreate at the same path — which mints a fresh
	 *  id — starts unconfirmed again rather than inheriting the old note's
	 *  confirmed status. Pruned when the note's server row is deleted
	 *  (handleRename tombstones the old path): the invariant is "the server has
	 *  a LIVE row for this id", and a tombstoned id no longer does — so the
	 *  next push (the rename's new-path push, same id) must go REST-first to
	 *  move/resurrect the row, not CRDT (which the channel drops for a note the
	 *  server sees as absent). Routing it CRDT would silently strand the rename. */
	/** Vault-scoped: a confirmed id from the OLD vault would key CRDT frames and
	 *  rooms against the NEW one — the cross-vault flavor of the 2026-07-07
	 *  cross-wire class (plugin #200). Ids re-learn via manifest reconcile. */
	private confirmedNoteIds = this.track(["vault", "destroy"], new Set<string>());

	/** Per-note re-handshake attempt tracking for the live-bound catch-up path,
	 *  keyed by note_id. `hash` is the server content_hash being retried; a new
	 *  hash starts a fresh episode. Purely diagnostic now (the logged attempt
	 *  number, and cleared on commit) — convergence recording lives entirely in
	 *  `commitCrdtConvergence`; this map never gates a retry. */
	private crdtRehandshakeAttempts = this.track(
		["vault", "destroy"],
		new Map<string, { hash: string; attempts: number }>(),
	);

	/** Fix wave 1 (single-path D3 review): staged convergence for a diverged
	 *  note, keyed by note_id — staged by the LIVE-BOUND leg and, since Phase
	 *  E3, the cold catch-up leg too. `socketConverge` no longer
	 *  verifies-and-records by text equality — text equality does not prove
	 *  the doc holds the server's actual Yjs ops (two independently-typed
	 *  identical bodies are a disjoint lineage; recording on that basis is the
	 *  duplication class this replaces). Instead a diverged pull entry STAGES
	 *  what it would record here, and `commitCrdtConvergence` (wired from
	 *  CrdtManager's onSynced, fired once per handshake cycle when the room's
	 *  syncStep2 lands) commits it — actual op-level proof, not a text guess. A
	 *  fresh content_hash overwrites any prior stage (new episode); nothing
	 *  else prunes it — `commitCrdtConvergence` re-resolves the current path
	 *  via noteIdMap and no-ops if the id was deleted, so a stale stage can
	 *  never write syncState at a dead path.
	 *
	 *  Fix wave 5: `content` is the staged row's own plaintext, so
	 *  `commitCrdtConvergence` can CONTENT-VERIFY the commit instead of
	 *  trusting that the next `onSynced` fire is FOR this row — an unrelated
	 *  inbound frame (a different concurrent edit on the same doc) could
	 *  otherwise commit the stage a millisecond after it was staged, before
	 *  the staged row's own ops ever arrived (CI run 29920053637: committed
	 *  1ms after the re-handshake fired, fence-blinding every later row —
	 *  deaf until teardown). The diverged live-bound leg has the row's
	 *  `content` in scope and stages it; `healDivergedLiveBoundNotes` (the
	 *  manifest heal) has no plaintext — only a keyed HMAC hash it cannot
	 *  compute client-side — so it stages `content: null`, which keeps the
	 *  pre-wave-5 best-effort behavior (commit on the next non-empty frame,
	 *  unverified). */
	private pendingConvergence = this.track(
		["vault", "destroy"],
		new Map<
			string,
			{
				path: string;
				serverHash: string;
				content: string | null;
				version?: number;
				seq?: number;
			}
		>(),
	);

	/** Fix wave 1: per-note_id cooldown for `socketConverge`'s STEP1
	 *  re-handshake — bounds how often a live-bound note can re-fire reset+
	 *  enroll (open, catch-up, and manifest heal can all independently detect
	 *  the same divergence in quick succession; unconditional firing drains
	 *  the handshake budget, the #193 starvation class). Value = last-fired
	 *  `Date.now()`, set ONLY when a handshake actually fires — never on a
	 *  suppressed attempt. `healCooldownMs` is a public instance field so
	 *  tests can shrink it. */
	private crdtHealCooldown = this.track(["vault", "destroy"], new Map<string, number>());

	/** Fix wave 2 (CI-found defect: `test_deaf_note_survives_handshake_rate_
	 *  limit_and_heals_on_restore`): a poke suppressed by the cooldown must
	 *  NOT be silently dropped — a deaf note's one recovery poke landing
	 *  inside the window would otherwise never retry, stranding it until the
	 *  next unrelated edit or the 5-min manifest pass. Mirrors
	 *  `scheduleSeqHeal`'s trailing-edge throttle: a suppressed poke arms ONE
	 *  trailing timer per note_id for the remaining window; further pokes for
	 *  the same note while a trailing timer is armed coalesce into it (no
	 *  second timer). Cleared in `destroy()`. */
	private crdtHealTrailingTimers = this.track(
		["vault", "destroy"],
		new Map<string, number>(),
		(timer) => this.time.clearTimeout(timer),
	);

	/** See `crdtHealCooldown`. 15s (fix wave 2, was 30s): long enough that
	 *  open+catch-up+heal racing on the same note collapse to one handshake,
	 *  short enough that a genuinely-still-diverged note keeps retrying
	 *  within a session. */
	healCooldownMs = 15_000;

	/** Durable-queue entries whose delivery re-handshake has been FIRED but
	 *  not yet proven (Phase E3 review): the entry stays in the durable queue
	 *  until an inbound frame for its note arrives (`commitCrdtConvergence`
	 *  fires on every frame), which proves the room round-tripped on the live
	 *  socket — the client's STEP2 reply to the server's STEP1 carried the
	 *  pending local ops on that same round-trip. A nudge lost to a socket
	 *  drop leaves the entry queued; the next flush re-fires (cooldown-
	 *  bounded). Keyed by note_id → the entry's dequeue coordinates. */
	private pendingQueueDeliveries = this.track(
		["vault", "destroy"],
		new Map<string, { path: string; vaultId?: string }>(),
	);

	/** Public: true once this SESSION observed this note's create-ack. Was
	 *  formerly wired as `CrdtManagerOptions.canSendLive` in main.ts, but that
	 *  gate is session-scoped (`confirmedNoteIds` is cleared on every WS
	 *  reconnect — see `clearConfirmedNoteIds`) while `canSendLive` needs a
	 *  signal that SURVIVES reconnect, so `canSendLive` is now wired to
	 *  `hasServerNote` instead (below). Still used for in-session bookkeeping
	 *  (e.g. `healNoteOnOpen`'s catch-up-vs-heal branch). */
	isNoteConfirmed(noteId: string | null): boolean {
		return noteId !== null && this.confirmedNoteIds.has(noteId);
	}

	/** Called immediately after a note's `crdt_create` is acked (its server row
	 *  now exists) — from every create-ack path (inline pushFile genesis and the
	 *  durable queued create-ack, `applyCrdtCreateAck`). Task 1's `canSendLive`
	 *  gate silently HELD every local Y.Doc update for this note (including a
	 *  create-ack path's own disk-content seed) while the row didn't exist yet,
	 *  so nothing individually reached the wire. Sends the note's CURRENT full
	 *  state once via `CrdtManager.flushHeldState`, which reuses the manager's
	 *  existing `onUpdate` transport directly (bypassing `canSendLive`) rather
	 *  than introducing a second send path. Never throws into the caller —
	 *  logged and swallowed, matching this file's sibling error-handling
	 *  pattern (e.g. `applyCrdtCreateAck`'s body-seed catch).
	 *
	 *  Self-heal on failure (Defect 2 hardening): a thrown flush leaves the
	 *  held body UNSENT this session (data-safe — it's still in the Y.Doc,
	 *  never lost) but with no retry of its own. `reset+enroll` re-establishes
	 *  the room's sync half (the same pairing used at every other re-handshake
	 *  site here, e.g. `applyCrdtCreateAck`'s ADOPT branch) — but, like every
	 *  other enroll call site in this file, ONLY for a live-bound note (#1409):
	 *  a bulk import's create-ack runs for hundreds of idle notes with no
	 *  editor anywhere near them, and re-enrolling unconditionally there was
	 *  exactly the room-per-imported-note storm #1409 exists to kill.
	 *
	 *  CORRECTED 2026-08-25: an earlier version of this comment claimed "the
	 *  backend never STEP1s back, so the handshake does NOT re-push the held
	 *  body". That is FALSE. `y_ex`'s `encode_sync_step1_response_v1`
	 *  (deps/y_ex/native/yex/src/sync.rs) answers a client STEP1 with BOTH a
	 *  STEP2 and the server's OWN STEP1, so the client's reply to that carries
	 *  its pending ops — a re-handshake really is a two-way delivery. Do not
	 *  reason about any re-handshake site from the old claim; it is why
	 *  `socketConverge` can deliver a durably-queued edit at all.
	 *
	 *  Skipping the re-enroll for an idle note is still right, but for a
	 *  different reason than that comment gave: the provider's buffered frames
	 *  flush on the next `setConnected(true)` edge UNCONDITIONALLY — that flush
	 *  is not gated on `advertised` (see NoteProvider.setConnected) — so a held
	 *  body still ships on the next reconnect, room-free. The note's next local
	 *  edit is a second path: `hasServerNote` is true by now (create-ack set
	 *  `crdtHead`), so `canSendLive` no longer holds it.
	 *
	 *  Race note: a keystroke can land during the awaited `flushHeldState`
	 *  (the gate is already open by now, so it streams its own delta). That is
	 *  accepted-safe: the flush sends full state, the racing delta is a subset,
	 *  and Yjs merges both idempotently — worst case is a harmless duplicate. */
	async flushHeldEditsOnCreateAck(noteId: string, path: string): Promise<void> {
		if (!this.crdt) return;
		try {
			await this.crdt.flushHeldState(noteId);
		} catch (e) {
			rlog().warn("crdt", `create-ack flush failed for ${noteRef(path)}: ${errMsg(e, path)}`);
			if (!this.isLiveBound(normalizePath(path))) return;
			this.crdtEnrollment?.reset(noteId);
			this.crdtEnrollment?.enroll(noteId);
		}
	}

	private confirmNoteId(noteId: string | null | undefined): void {
		if (noteId) this.confirmedNoteIds.add(noteId);
	}

	/** The bookkeeping every "the server acked our `crdt_create`" path runs once
	 *  the authoritative id is known. TWO callers reach it — pushFile's live
	 *  genesis branch and the durable queued ack (`applyCrdtCreateAck`) — and a
	 *  step going missing from one of them is exactly the drift this exists to
	 *  end (the queued path once leaked the mint-retire the live path did).
	 *
	 *  The ADOPT half (transfer a live mint buffer, retire the orphaned mint doc)
	 *  stays with each caller: it legitimately differs by path — a live editor
	 *  buffer vs a queued disk seed.
	 *
	 *  Order is load-bearing:
	 *   - `setCrdtHead` BEFORE the flush. The sentinel flips `hasServerNote`,
	 *     and THAT is what Task 1's `canSendLive` gate reads (main.ts wires
	 *     `canSendLive: (id) => hasServerNote(id)` — deliberately NOT
	 *     `isNoteConfirmed`, which is session-scoped and dies on reconnect; see
	 *     `isNoteConfirmed`'s doc). So the oracle flip is what opens the gate and
	 *     lets the flush actually ship the held edits. `confirmNoteId` rides
	 *     along before the flush too, but it only feeds in-session bookkeeping.
	 *   - the baseline BEFORE the awaited flush. Stamping after leaves a window
	 *     where the create's own broadcast returns before the baseline that
	 *     suppresses it exists. The queued path already had this order; the live
	 *     path did not (see #377).
	 *
	 *  `consumed` is what the manager actually took (null = nothing was
	 *  transmitted, so there is no echo to suppress and no baseline is stamped —
	 *  the seed-declined and post-create-throw exits). `flushHeld: false` is the
	 *  batch path only: it seeds no local doc, so it has no held edits. */
	private async adoptCreateAck(
		effectiveId: string,
		path: string,
		consumed: string | null,
		opts?: { flushHeld?: boolean },
	): Promise<void> {
		const normalized = normalizePath(path);
		this.noteIdMap?.set(normalized, effectiveId);
		// Oracle flip: the server row exists, so hasServerNote must be true for
		// this id immediately. The first convergence overwrites the sentinel with
		// the authoritative head.
		this.setCrdtHead(path, CRDT_HEAD_CREATED);
		this.confirmNoteId(effectiveId);
		if (consumed !== null) {
			this.recordCrdtBaseline(normalized, consumed, { markCreated: true });
		}
		if (opts?.flushHeld !== false) {
			await this.flushHeldEditsOnCreateAck(effectiveId, path);
		}
	}

	/** A6 (issue #201): a fresh note's pre-push STEP1 is dropped server-side
	 *  (no row yet → note_not_found) and the once-per-session enrollment guard
	 *  never re-fires it, leaving the note deaf to live sync until a later
	 *  catch-up (~30s observed live). Called with the id the create-push
	 *  response confirmed, BEFORE confirmNoteId: if the id was not yet
	 *  confirmed this is the create — re-fire the handshake now that the row
	 *  exists. Md + size gated exactly like the pre-push enroll (an oversized
	 *  doc must never enroll — 8 MB WS frame limit). */
	private refireEnrollmentOnFirstConfirm(
		noteId: string | null | undefined,
		path: string,
		content: string,
	): void {
		if (!noteId || !this.crdtEnrollment) return;
		if (this.isNoteConfirmed(noteId)) return; // not a create — already live
		if (!this.isCrdtEligiblePath(path)) return;
		if (exceedsCrdtNoteLimit(content, MAX_CRDT_NOTE_BYTES)) return;
		// Vault-channel fan-out: a cold (not-open-in-editor) send stays room-free —
		// its edits ship over /updates and it RECEIVES future updates over the
		// note_yjs_update broadcast, no room needed. Enroll (STEP1) only for a
		// live-bound note, matching the pull/stream gates. The note's server row is
		// already created by the REST push above, so an idle note is not stranded.
		if (!this.isLiveBound(normalizePath(path))) return;
		this.crdtEnrollment.reset(noteId);
		this.crdtEnrollment.enroll(noteId);
	}

	/** Drop a note_id's confirmed status when its server row is deleted, so a
	 *  subsequent push of the same id (a rename's new-path push) takes the
	 *  REST-first path that recreates/moves the row rather than routing to a
	 *  CRDT room the server no longer has. */
	private unconfirmNoteId(noteId: string | null | undefined): void {
		if (noteId) this.confirmedNoteIds.delete(noteId);
	}

	/** Forget all confirmed-note-id status. Called on a WebSocket (re)connect:
	 *  a reconnect is a point where server-known state may have diverged from
	 *  this in-memory cache (another device deleted/renamed a note, or the
	 *  backing store was reset out from under us — the e2e harness resets the
	 *  DB between reruns while the plugin instance lives on). A STALE confirmed
	 *  entry is the dangerous direction: it routes a note's first write to CRDT,
	 *  which the server silently DROPS for a note it has no row for (no path on
	 *  the wire to bootstrap from), losing the write. Clearing biases every
	 *  note's next write back to the durable REST path, which re-creates the row
	 *  and re-confirms the id; the catch-up pull re-confirms whatever actually
	 *  changed. Cost is at most one extra REST push per note after a reconnect. */
	clearConfirmedNoteIds(): void {
		this.confirmedNoteIds.clear();
	}

	/** Optional CRDT enrollment tracker. When set, a pull that surfaces a
	 *  CRDT-managed markdown note we don't have locally enrolls it (sends a
	 *  sync-step-1) so the body is pulled over the y-protocols handshake — the
	 *  level-triggered discovery path that backstops the edge-triggered
	 *  crdt_doc_ready announce.
	 *
	 *  Both `enroll` and `reset` are exposed: `enroll` kicks off the STEP1
	 *  handshake; `reset` (Task 5) clears the once-per-session enroll guard so a
	 *  note recreated at the same path re-runs the full handshake rather than
	 *  silently reusing the stale enrolled state from before the delete/rename. */
	private crdtEnrollment: { enroll(path: string): void; reset(path: string): void } | null = null;

	setCrdtEnrollment(
		enrollment: { enroll(path: string): void; reset(path: string): void } | null,
	): void {
		this.setCrdtPorts({ enrollment });
	}

	/** Socket-native new-note genesis (Plan B1, Task 3). When wired, a brand-new
	 *  markdown note's FIRST push creates its server row over the CRDT channel
	 *  (`crdt_create`) instead of a REST `pushNote`. Resolves to the server's
	 *  AUTHORITATIVE doc_id: on ADOPT (the path is already owned by a live note
	 *  under a different id) the returned id differs from the one sent, and
	 *  pushFile remaps the local note to it so subsequent `crdt_msg` edits address
	 *  the row that exists — keeping the local mint would orphan the note (content
	 *  loss). Rejects on delete-wins / rate-limit / bad-path; the caller logs and
	 *  falls through to the REST create (still functional in this additive phase,
	 *  removed in Plan B2). Unset → genesis stays on the REST-first path. */
	private crdtCreate:
		| ((
				docId: string,
				path: string,
				b64?: string,
		  ) => Promise<{ docId: string; seeded: boolean; genesisOutcome: GenesisOutcome }>)
		| null = null;

	setCrdtCreate(
		fn:
			| ((
					docId: string,
					path: string,
					b64?: string,
			  ) => Promise<{ docId: string; seeded: boolean; genesisOutcome: GenesisOutcome }>)
			| null,
	): void {
		this.setCrdtPorts({ create: fn });
	}

	/** Direct AWAITED `crdt_delete` (resolves once the server has durably applied
	 *  the tombstone). Used by handleRename to ORDER the old-path tombstone before
	 *  the new-path `crdt_create` resurrect: the backend relocates a note only via
	 *  tombstone->resurrect (`genesis_crdt_note` id_conflicts a LIVE id at a new
	 *  path, crdt_channel.ex:201), and the durable CrdtOpQueue coalesces one op
	 *  per docId, so a queued delete + a retried create for the SAME id race and
	 *  cancel. Awaiting a direct delete removes both hazards. Offline / not-joined
	 *  falls back to the durable `crdtEnqueue` delete. */
	private crdtDelete: ((docId: string) => Promise<{ doc_id: string }>) | null = null;

	setCrdtDelete(fn: ((docId: string) => Promise<{ doc_id: string }>) | null): void {
		this.setCrdtPorts({ delete: fn });
	}

	/** Durable enqueue hook for socket-native create/delete (Plan B2). Wired to
	 *  the plugin's CrdtOpQueue: an op is HELD until the crdt: topic is joined,
	 *  delivered on join, retried on transient failure, acked, and dropped only on
	 *  TTL / terminal error. Enqueue never throws; it is a local durable hand-off,
	 *  so there is NO REST create/delete fallback (CRDT is the sole md path).
	 *  Unset (legacy/non-CRDT connection or a test double) → callers fall through
	 *  to the still-functional REST path. Never fires for a delete APPLIED locally
	 *  because it arrived FROM the server: handleDelete's remote-echo early-return
	 *  runs first. */
	private crdtEnqueue:
		| ((op: { kind: "create" | "delete"; docId: string; path: string }) => void)
		| null = null;

	/** See CrdtPorts.resetOutbox. */
	private crdtResetOutbox: (() => void) | null = null;

	/** Wired by main.ts to the durable CrdtOpQueue: true when an op for this
	 *  docId is still pending (unsent create/edit). Consulted by the evidence
	 *  rule so a create-then-delete supersedes instead of resurrecting. */
	private crdtHasPendingOp: ((docId: string) => boolean) | null = null;

	setCrdtHasPendingOp(fn: ((docId: string) => boolean) | null): void {
		this.crdtHasPendingOp = fn;
	}

	setCrdtEnqueue(
		fn: ((op: { kind: "create" | "delete"; docId: string; path: string }) => void) | null,
	): void {
		this.setCrdtPorts({ enqueue: fn });
	}

	/** A durable queued `crdt_create` acked by the server. On ADOPT (serverId
	 *  differs from the local mint, the path was already owned by a live note
	 *  under another id) remap the note_id so subsequent edits address the
	 *  server's row instead of orphaning under the stale mint, and retire the
	 *  orphaned mint doc + its enrollment (mirrors pushFile's live adopt at
	 *  sync.ts:2429-2430, which the queued path previously LEAKED). Then SEED the
	 *  body under the effective id and flip the head oracle so hasServerNote is
	 *  true (the row now exists).
	 *
	 *  Why the body seed here (not "on the next re-push"): the live genesis path
	 *  seeds inline right after crdt_create, but a QUEUED create is acked on
	 *  (re)join where the only follow-ups are catch-up/pull (onCrdtTopicJoined has
	 *  no pushModifiedFiles). A head-only flip therefore lands a 0-byte row on
	 *  peers until the user edits the note again (the deaf-note / 0-byte-
	 *  materialize class). routeModify → applyLocalEdit uses the DEFAULT (local)
	 *  origin, so the manager's onUpdate forwards the seed over the channel
	 *  (crdt_msg): no enrollment needed for an idle note, matching the live
	 *  idle-note path. This runs INSIDE the queue's send (channel joined), so the
	 *  forward has a live socket.
	 *
	 *  Cannot double-send with the live path: the queue only HOLDS a create when
	 *  the inline live seed did NOT run (genesis branch skipped pre-join, or the
	 *  live crdt_create rejected). It cannot re-enqueue a remote-applied update:
	 *  the seed is the note's own local disk content, not anything received from
	 *  the server, so REMOTE_ORIGIN suppression is untouched.
	 *
	 *  `seeded` + `genesis` (review H4, #1409): the durable queue's `send` now
	 *  builds a genesis body too (buildGenesisFrame, re-read from disk at SEND
	 *  time — a replayed create's original snapshot could be stale by the time
	 *  it actually fires, and isn't persisted into the queue at all). When the
	 *  server confirms it landed, this applies the SAME bytes locally instead
	 *  of falling through to the disk-seed routeModify call below — which
	 *  would open the very room #1409 exists to avoid. Mirrors pushFile's own
	 *  seeded-gated local apply exactly, guard-for-guard (H1: never on a doc
	 *  that already has history; M1: capture+merge any disk drift between the
	 *  frame's read and this ack). */
	async applyCrdtCreateAck(
		localId: string,
		serverId: string,
		path: string,
		seeded = false,
		genesis?: GenesisFrame,
		genesisOutcome?: GenesisOutcome,
	): Promise<void> {
		const normalized = normalizePath(path);
		let effectiveId = localId;
		// What the manager actually took, from whichever of the two seed routes
		// below ran (they are mutually exclusive). Handed to adoptCreateAck as the
		// echo baseline; stays null if neither transmitted anything.
		let consumed: string | null = null;
		// Set when we transferred the LIVE mint content into serverId below, so the
		// disk-seed further down is skipped (re-diffing lagged disk would clobber the
		// just-transferred in-flight keystrokes).
		let transferredLiveContent = false;
		if (serverId && serverId !== localId) {
			// Remapped up front, not left to adoptCreateAck's own set below: the
			// ViewPlugin re-resolves path -> id on its next update, which can land
			// during the awaited transfer/retire that follow.
			this.noteIdMap?.set(normalized, serverId);
			effectiveId = serverId;
			rlog().info(
				"crdt",
				`crdt_create (queued) ADOPT: remapped ${noteRef(path)} ${localId} -> ${serverId}`,
			);
			// Live-bound adopt: the mint doc holds the user's live keystrokes (the
			// editor forwards there), which lag disk. Transfer them into serverId
			// (mirrors the live pushFile adopt) instead of seeding from disk below.
			// The ViewPlugin re-resolves path -> serverId on its next update and
			// re-attaches itself.
			if (this.crdt && this.isLiveBound(normalized)) {
				try {
					const mintText = await this.crdt.projectedText(localId);
					consumed = await this.crdt.applyLocalEdit(serverId, mintText);
					transferredLiveContent = true;
				} catch (e) {
					rlog().warn(
						"crdt",
						`crdt_create (queued) adopt: live transfer failed for ${localId} -> ${serverId}: ${errMsg(e)}`,
					);
				}
			}
			// Retire the orphaned mint doc + its enrollment (mirrors the live adopt).
			try {
				await this.crdt?.removeDoc(localId);
			} catch (e) {
				rlog().warn(
					"crdt",
					`crdt_create (queued) adopt: mint removeDoc failed for ${localId}: ${errMsg(e)}`,
				);
			}
			this.crdtEnrollment?.reset(localId);
		}
		// Seed the body from disk under the effective id (mirrors the live genesis
		// non-live-bound seed at sync.ts:2444). Cap-gated inside routeModify. Skipped
		// when we already transferred the live mint content above.
		const file =
			this.crdt && !transferredLiveContent
				? this.app.vault.getAbstractFileByPath(normalized)
				: null;
		if (this.crdt && file instanceof TFile && this.isCrdtEligible(file)) {
			try {
				consumed = await this.seedBodyAfterCreate({
					effectiveId,
					normalized,
					file,
					seeded,
					sameId: serverId === localId,
					genesisUpdate: genesis?.update,
					genesisContent: genesis?.content,
					genesisOutcome,
				});
			} catch (e) {
				// The row exists (crdt_create already acked); a failed body seed
				// self-heals on the note's next edit. Never fall back to REST.
				rlog().warn(
					"crdt",
					`crdt_create (queued) body seed failed for ${noteRef(path)}: ${errMsg(e, path)}`,
				);
			}
		}
		// Task 1's canSendLive gate held effectiveId's live update(s) (including
		// the disk-content seed above) until this exact moment.
		await this.adoptCreateAck(effectiveId, path, consumed);
	}

	/** True when a note qualifies for the genesis-frame fast path (#1409):
	 *  markdown (not canvas — `encodeGenesisUpdate`'s note branch is the
	 *  markdown seeder), not live-bound (a live editor's frozen content can
	 *  lag unflushed keystrokes), within the CRDT transport cap, and CRDT is
	 *  wired at all. Shared by pushFile's inline genesis create and
	 *  `buildGenesisFrame` (the durable queue's replayed create) so the gate
	 *  cannot drift between the two call sites — a lesson from #1130
	 *  (duplicated gates silently diverging). */
	private eligibleForGenesisFrame(path: string, content: string): boolean {
		return (
			!!this.crdt &&
			!canvasPath(path) &&
			!this.isLiveBound(normalizePath(path)) &&
			!exceedsCrdtNoteLimit(content, MAX_CRDT_NOTE_BYTES)
		);
	}

	/** The update bytes to send with `crdt_create`, or undefined for a bodyless
	 *  create (#1409, + the doubling follow-up).
	 *
	 *  WHICH bytes is the whole correctness question. `encodeGenesisUpdate` builds
	 *  the body in a THROWAWAY Y.Doc, so it is a brand-new lineage with a fresh
	 *  clientID. That is correct only when this device holds no lineage of its
	 *  own: ship it alongside an existing one and the two carry the same text
	 *  with no shared identity, Yjs unions them on convergence, the body appears
	 *  twice, the union is flushed to disk, and the next sync doubles the doubled
	 *  body. Measured on a real vault: 263 KB -> 4.38 MB over five syncs, 2x
	 *  each, one note's opening line repeated 128 times.
	 *
	 *  So when the doc DOES have history, send the doc's OWN state instead. The
	 *  server then adopts this device's lineage rather than a rival — one lineage
	 *  exists, so there is nothing to union.
	 *
	 *  Declining outright (an earlier revision of this fix) is NOT a safe
	 *  fallback: a bodyless create leaves an empty server row, and the follow-up
	 *  `routeModify` diffs disk against a doc that already equals it, producing
	 *  ZERO ops — measured. The row stays empty. That trades doubled content for
	 *  no content, which is worse. Undefined is returned only where there is also
	 *  no state to send. */
	private async genesisUpdateFor(
		noteId: string | null | undefined,
		path: string,
		content: string,
	): Promise<{ update: Uint8Array; fromThrowaway: boolean } | undefined> {
		if (!this.crdt || !this.eligibleForGenesisFrame(path, content)) return undefined;

		// No resolvable id: cannot ask about history and cannot encode the doc's
		// state either, since both are keyed by id. Bodyless create. An id can go
		// missing for reasons that CO-OCCUR with having a doc (a map reconcile
		// mid-flight, a durable op replayed after the entry moved).
		if (!noteId) return undefined;

		// TRANSIENT, not the plain probe: this runs once per note in a first sync,
		// and `hasAnyHistory` materializes a Y.Doc + IndexedDB connection that the
		// registry (no LRU) then holds forever — a large vault OOM'd the Obsidian
		// renderer. The transient form frees anything it had to materialize.
		let hasHistory: boolean;
		try {
			hasHistory =
				typeof this.crdt.hasAnyHistoryTransient === "function"
					? await this.crdt.hasAnyHistoryTransient(noteId)
					: true; // unknown → assume the rival-lineage hazard exists
		} catch {
			// Doc destroyed mid-check (NoteDestroyedError) or an IndexedDB fault.
			hasHistory = true;
		}

		if (!hasHistory) {
			return { update: this.crdt.encodeGenesisUpdate(content), fromThrowaway: true };
		}

		// History present (or unknown): the throwaway-doc encoding is unsafe, so
		// send this device's own lineage. A port that cannot encode it degrades to
		// a bodyless create — which silently reverts #1409 (a room per imported
		// note) with no other symptom, so it is surfaced. `anomaly` ships even
		// with diagnostics off, for exactly this class. Counts only, never a path.
		if (typeof this.crdt.encodeStateAsUpdate !== "function") {
			rlog().anomaly("crdt", "genesis_gate_port_missing_state_encode");
			return undefined;
		}

		try {
			const state = await this.crdt.encodeStateAsUpdate(noteId);
			// A doc's full state carries its edit history (and tombstones), so it
			// can dwarf the content that passed the cap above. Bound it against the
			// same budget rather than putting an unbounded frame on an 8 MB socket.
			if (state.byteLength > MAX_CRDT_NOTE_BYTES) {
				rlog().anomaly("crdt", "genesis_state_over_cap");
				return undefined;
			}
			return { update: state, fromThrowaway: false };
		} catch {
			rlog().anomaly("crdt", "genesis_state_encode_failed");
			return undefined;
		}
	}

	/** Re-assert, AFTER `crdt_create` acked, that the local doc still had no
	 *  lineage when the frame was sent (#1409 follow-up, adversarial review 2).
	 *
	 *  `genesisUpdateFor` necessarily runs BEFORE the create round trip,
	 *  so a live edit, a remote apply, or a catch-up landing in that window can
	 *  give the doc history after the gate cleared it. The frame is already on
	 *  the wire by then: the server holds a lineage this device did not adopt,
	 *  which is the doubling shape, just narrower than the bug this fixes.
	 *
	 *  It cannot be repaired here — once both lineages exist with the same text,
	 *  any convergence unions them; only prevention works. So this makes the race
	 *  VISIBLE rather than pretending it is closed. Callers do not branch on it.
	 *  Counts and a reason only, never a path. */
	private reportGenesisRace(sentFrame: boolean, hadHistoryAfter: boolean): void {
		if (sentFrame && hadHistoryAfter) {
			rlog().anomaly("crdt", "genesis_frame_raced_lineage");
		}
	}

	/** Build the b64 genesis frame for a durable-queue REPLAYED create (review
	 *  H4, #1409). Without this, `crdt-op-dispatch.ts` sent every retried
	 *  create bodyless, so a note whose FIRST create attempt failed (rate-
	 *  limited, offline, pre-join) always fell back to the room-opening
	 *  disk-seed on delivery — inverting the whole point of #1409 on exactly
	 *  the vault shape (many large notes bumping the server's ~24 KB text /
	 *  32 KB base64 create-lane size gate) where the memory pressure this
	 *  fix targets is worst.
	 *
	 *  Re-reads disk FRESH here rather than trusting whatever content the op
	 *  was originally enqueued with: a retry can fire much later (rate-limit
	 *  backoff, a long reconnect), the queue is IndexedDB-persisted so
	 *  stashing the body there would bloat it with content that may be stale
	 *  by the time it's ever sent, and `eligibleForGenesisFrame`'s own gates
	 *  (live-bound, size) can only be evaluated against CURRENT state anyway.
	 *  Returns undefined (bodyless create, falls back to the existing
	 *  disk-seed path in `applyCrdtCreateAck`) when the note doesn't qualify,
	 *  is gone, or is unreadable — and also on ANY unexpected throw (round 2
	 *  review finding): the caller (`crdt-op-dispatch.ts`'s `makeCrdtOpSend`)
	 *  has no try/catch around this call, so letting anything escape would
	 *  abort the whole create dispatch and get treated as a FAILED
	 *  `crdt_create` (retried, eventually dropped as max-attempts) — when the
	 *  create itself would very likely still succeed fine without a body.
	 *  Fails CLOSED to the documented degradation, not open to a dropped op. */
	async buildGenesisFrame(path: string, noteId: string): Promise<GenesisFrame | undefined> {
		try {
			if (!this.crdt) return undefined;
			const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
			if (!(file instanceof TFile)) return undefined;
			const content = await this.app.vault.cachedRead(file);
			// `noteId` is the caller's op.docId — the id the create is actually made
			// under. Deliberately NOT `this.noteIdMap.get(path)`: a rename or map
			// reconcile between enqueue and replay makes those disagree, and the
			// gate would then clear a note whose real doc holds lineage.
			const chosen = await this.genesisUpdateFor(noteId, path, content);
			if (!chosen) return undefined;
			return { b64: encodeUpdateFrame(chosen.update), update: chosen.update, content };
		} catch {
			return undefined;
		}
	}

	/** Optional level-triggered check: is the `crdt:` topic JOINED right now?
	 *  The `crdt` manager latch above is edge-triggered (set on join via
	 *  onCrdtJoined, cleared on disconnect), so it can go STALE — set, but the
	 *  channel dead-but-set after an auth swap. pushFile consults this before
	 *  claiming a CRDT push succeeded, so a stale latch falls back to the durable
	 *  REST path instead of dropping the Y.Doc update into a channel the server no
	 *  longer routes by join_ref (#915). Unset → treated as live (backward
	 *  compatible with callers/tests that never wire it). */
	private crdtLive: (() => boolean) | null = null;

	setCrdtLiveCheck(fn: (() => boolean) | null): void {
		this.setCrdtPorts({ live: fn });
	}

	/** True when a path currently has a live editor binding (an open, bound
	 *  CodeMirror editor). While that holds, the editor binding is the sole CRDT
	 *  writer for the note (Relay's "editor owns the file while open"): the disk
	 *  path must NOT also feed disk content into the Y.Text, or Obsidian's ~2s
	 *  autosave re-diffs the whole file into the doc every cycle and fights the
	 *  binding. Set from the plugin layer; defaults to "never bound" so non-CRDT
	 *  and headless contexts behave exactly as before. */
	private isLiveBound: (path: string) => boolean = () => false;

	setLiveBoundCheck(fn: (path: string) => boolean): void {
		this.setCrdtPorts({ liveBound: fn });
	}

	/** How long enumerateServerState waits for the op-log socket to become
	 *  enumerable (catch-up wired + manager set + channel live) before failing
	 *  the preview. Covers the startup join race and the vault-switch rebuild.
	 *  A field so tests can shrink it. */
	private enumerateWaitMs = 8000;

	/** Adopt-first seed gate input (CrdtManager.isUnchangedSynced): true when
	 *  `content` hashes to exactly what this engine last synced for `path` —
	 *  i.e. the server already holds this content, so a history-less Y.Doc must
	 *  adopt the server lineage instead of re-encoding it (backend #846
	 *  lineage doubling). Unknown paths return false (authored notes seed). */
	isUnchangedSynced(path: string, content: string): boolean {
		const state = this.syncState.get(normalizePath(path));
		return state !== undefined && state.hash === fnv1a(content);
	}

	/** True only when this path has a recorded CRDT baseline that disagrees
	 *  with disk — a real external-edit-while-closed that must be captured into
	 *  CRDT. No baseline (fresh note → the bounded REST fullSync uploads it and
	 *  the backend bind/3 seeds CRDT from content) or in-sync => false, so
	 *  cold-start does NOT open a Y.Doc per note (the reconnect-storm amplifier).
	 *  Inverse of isUnchangedSynced except it also requires a baseline to exist. */
	needsColdReconcile(path: string, content: string): boolean {
		const state = this.syncState.get(normalizePath(path));
		return state !== undefined && state.hash !== fnv1a(content);
	}

	/** Should an inbound delete preserve `disk` as a keep-both conflict copy
	 *  before trashing the file and tearing the CRDT room down?
	 *
	 *  Only when the room actually holds work the server has not acknowledged.
	 *  `needsColdReconcile` alone is NOT sufficient: it is a baseline-vs-disk
	 *  hash proxy, and a note whose content reached the server through the LIVE
	 *  editor binding (rather than a push) trips it while being perfectly
	 *  converged — which made every delete of an opened note leave a spurious
	 *  "(conflict <stamp>)" copy. The undelivered-ops check is the positive
	 *  signal: it is true exactly when tearing the room down would destroy
	 *  something. Oversized notes are excluded (they never entered CRDT).
	 *
	 *  Registries without the probe (older fakes in tests) fall back to the
	 *  drift proxy alone — the pre-existing, copy-happy behavior. */
	private shouldKeepDriftCopy(normalized: string, disk: string, noteId: string | null): boolean {
		if (exceedsCrdtNoteLimit(disk, MAX_CRDT_NOTE_BYTES)) return false;
		if (!this.needsColdReconcile(normalized, disk)) return false;
		if (!noteId || typeof this.crdt?.hasUndeliveredOps !== "function") return true;
		return this.crdt.hasUndeliveredOps(noteId);
	}

	/** Write a remote-merged CRDT result to disk.
	 *  Marks the path recentlyFlushed first so the resulting vault.modify/create
	 *  event is suppressed by the recentlyFlushed guard in handleModify (the
	 *  'create' handler routes through handleModify too).
	 *  Safe to call from main.ts — does not expose the private markRecentlyFlushed.
	 *  Requires the sync gate to be open — returns early when blocked so inbound
	 *  CRDT frames cannot overwrite local files before the user picks a direction. */
	async flushFromCrdt(path: string, content: string): Promise<boolean> {
		if (this.syncBlocked) {
			// FALSE, not true. This wrote nothing, and claiming otherwise is what
			// made the 2026-08-13 prod failure invisible: the `true` propagated
			// into `changed`, counted the note as a downloaded file, drove the bar
			// to 100%, made the recap claim success, and suppressed the
			// no-files-produced anomaly — all while the vault stayed empty.
			// Folders bypass this gate entirely (direct vault.createFolder), which
			// is why the user saw every folder arrive and not one note.
			//
			// A no-op must never report as work. The caller decides what to do
			// about a closed gate; it cannot decide anything if we lie to it.
			devLog().log("sync-blocked", `flushFromCrdt short-circuited — gate closed: ${path}`);
			return false;
		}
		const normalized = normalizePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		// Idempotency: skip the write when the file already holds exactly this
		// content. An identical re-push re-flushes the same CRDT body; rewriting it
		// needlessly bumps mtime and emits a modify echo, which reads as a spurious
		// local change (e2e test_78 hash-only). No write → nothing to echo-suppress,
		// so we also skip markRecentlyFlushed.
		if (file instanceof TFile && (await this.app.vault.cachedRead(file)) === content) {
			// Disk already holds this content, but the baseline may still be
			// missing (an earlier flush created the file before this fix). Record
			// it so a later server tombstone isn't misread as a resurrection.
			this.recordCrdtBaseline(normalized, content);
			return true;
		}
		// Content-loss guard: a CRDT flush must never blank a non-empty file with a
		// STALE remote projection. The manager flushes projectNote(doc) on every
		// REMOTE_ORIGIN update (manager.ts), so a self-echo fan-out landing during a
		// genesis pre-seed window materializes the doc's transient EMPTY over the
		// content the author just wrote — the e2e test_09 content loss (the author's
		// own note is broadcast back to it). Mirrors Relay's rule that disk follows
		// the authoritative doc, not a stale remote projection. Only blank when the
		// doc has GENUINELY converged empty (a real remote clear, e2e test_27): if
		// the doc still projects content, this empty is transient — skip the write.
		if (file instanceof TFile && content.trim() === "") {
			let prev = "";
			try {
				prev = await this.app.vault.cachedRead(file);
			} catch {
				// unreadable — leave prev empty so the guard below simply won't fire
			}
			if (prev.trim() !== "") {
				const noteId = this.noteIdMap?.get(normalized) ?? null;
				let docText = "";
				if (noteId && this.crdt) {
					try {
						docText = await this.crdt.projectedText(noteId);
					} catch {
						// projection failed — leave docText empty; the write proceeds
					}
				}
				if (docText.trim() !== "") {
					rlog().warn(
						"crdt",
						`flushFromCrdt: refused empty over ${prev.length}B for ${noteRef(normalized)} — CRDT doc still holds content (stale remote projection)`,
					);
					return true;
				}
			}
		}
		this.markRecentlyFlushed(normalized);
		try {
			if (file instanceof TFile) {
				await this.app.vault.modify(file, content);
			} else {
				// Discovery: CRDT delivered the body for a note this device has never
				// had on disk (it lived only in the Yjs doc). Create it — without this
				// flushFromCrdt returned early and the note stayed permanently invisible
				// on this device even though its content was in the local CRDT doc.
				await this.createFileWithFolders(normalized, content);
			}
			// CRDT delivery IS a sync: record the last-synced baseline so the REST
			// reconcile path treats this note as server-known. Without it a
			// CRDT-delivered note has syncedHash=none, and a legitimate server
			// delete (folder-rename cleanup) trips the resurrection guard, which
			// re-pushes the old path and resurrects it forever (e2e test_34/78).
			this.recordCrdtBaseline(normalized, content);
			return true;
		} catch (e) {
			// Return false (do NOT swallow silently): the remote-apply path's
			// onFlushToDisk wrapper turns this into a rejection so applyRemoteUpdate
			// rejects and crdtHead stays unadvanced (#235). recordCrdtBaseline is
			// intentionally NOT reached here — a failed write must not mark the note
			// synced. Best-effort callers (pull/materialize) ignore the return and
			// keep today's log-and-continue behavior.
			rlog().error(
				"crdt",
				`flushFromCrdt: write failed for ${noteRef(path)}: ${errMsg(e, path)}`,
			);
			return false;
		}
	}

	// ── syncState mutators (#376 prerequisite) ──────────────────────────────
	// Every `syncState` write routes through one of these, so each site's merge
	// semantics are named and greppable instead of re-derived per callsite.
	// Two policies exist on purpose — replace vs merge — and the choice at each
	// site is deliberate; do not "unify" them without re-auditing the sites.

	/** REPLACE `path`'s row wholesale: this event (re)establishes the path's
	 *  server lineage, and prior bookkeeping (crdtHead, seq, version…) is
	 *  deliberately dropped with the old row. Callers pass the exact key they
	 *  track (already-normalized paths stay untouched here). */
	private stampSyncedRow(path: string, state: FileSyncState): void {
		this.syncState.set(path, state);
	}

	/** Can the server PROVE it still holds the bytes we last uploaded for
	 *  `np`? Only then may a forced attachment push skip the upload.
	 *
	 *  This cannot be decided locally. The server's `content_hash` is an HMAC
	 *  keyed off the user's DEK, which this client never holds — so we can
	 *  never compute the expected hash for a local file (see
	 *  `FileSyncState.serverHash`: "Never computed locally"). What we CAN do is
	 *  remember the hash the server reported when it accepted our upload, and
	 *  check that its current hash for that path is still the same one.
	 *
	 *  Every uncertain case answers false, so force keeps re-uploading:
	 *   - no listing supplied (single-file push)      → unproven
	 *   - we never recorded a serverHash              → unproven
	 *   - the path is absent from the listing         → the repair case force is FOR
	 *   - the server's hash moved since we recorded it → someone else wrote; ours should win
	 */
	private serverStillHasOurBytes(
		np: string,
		row: FileSyncState,
		serverAttachmentHashes?: Map<string, string>,
	): boolean {
		if (!serverAttachmentHashes || row.serverHash === undefined) return false;
		const current = serverAttachmentHashes.get(np);
		return current !== undefined && current === row.serverHash;
	}

	/** MERGE onto `path`'s row as read at stamp time: refresh the named fields,
	 *  preserve everything else already recorded. A missing row starts at
	 *  `hash: 0` (the historical `?? { hash: 0 }` default). */
	private patchSyncedRow(path: string, patch: Partial<FileSyncState>): void {
		this.syncState.set(path, { hash: 0, ...this.syncState.get(path), ...patch });
	}

	/** Drop `path`'s sync bookkeeping — and its CAS merge base unless
	 *  `dropBase: false` (attachments have no base; the rename/echo-skip sites
	 *  manage the base separately, e.g. baseStore.rename). */
	private dropPath(path: string, opts?: { dropBase?: boolean }): void {
		this.syncState.delete(path);
		if (opts?.dropBase !== false) this.baseStore?.delete(path);
	}

	/** Move `path`'s sync bookkeeping to `to`, for a rename. The merge base is
	 *  the caller's job (`baseStore.rename`) — this is the row beside it.
	 *
	 *  A rename moves a path and changes no content, so the recorded evidence is
	 *  the NOTE's, not the path's. Dropping it (what both rename legs used to do)
	 *  left the note with no evidence at its new path until the rename's push
	 *  landed, and a delete inside that window hit `handleDelete`'s evidence rule
	 *  (#416) and was REFUSED — so a note the user really deleted stayed live on
	 *  the server, and the next `crdt_create` at the freed old path was ADOPTED
	 *  onto that orphan row instead of creating a note (#489).
	 *
	 *  The OLD key still goes away, which is the half the drop got right: a stale
	 *  row there echo-suppresses a later create whose content happens to hash the
	 *  same (rename a note away, then make a new one at the old path). */
	private renamePath(from: string, to: string): void {
		const row = this.syncState.get(from);
		this.syncState.delete(from);
		if (!row) return;
		// Do not clobber a row already at the destination. A rename-over means
		// SOME note's bookkeeping at `to` is stale, but we cannot tell "the same
		// note materialized twice" from "an unrelated note we are about to
		// displace" — and overwriting the latter hands it a version that belongs
		// to a different note, so its next write CASes against the wrong one.
		// The old `dropPath` left the occupant alone; keep that.
		if (this.syncState.has(to)) return;
		// PRESENCE ONLY. `{ hash: 0 }`, not `{ ...row }` — every other field on
		// that row is a PATH-scoped claim about the server, and after a rename
		// none of them is true at `to` yet:
		//
		//   - `hash` — a rename changes no content, so a carried hash equals the
		//     file's own and `pushFile`'s echo filter (above the push slot)
		//     skips the relocation outright. `hash: 0` is the established
		//     "content unknown here" marker (`clearPushedBaselineForId`) and
		//     fnv1a never returns it.
		//   - `crdtHead` — this one is worse, and e2e test_93 is what caught it.
		//     `hasServerNote` is PATH-keyed (`getCrdtHead(pathForId(id))`), so a
		//     carried head makes the engine believe the server already holds the
		//     note AT THE NEW PATH. `pushFile` then takes the `crdt_msg` edit
		//     branch, which carries no path and cannot move the row, instead of
		//     the `crdt_create` genesis branch that IS the relocation
		//     (genesis_relocate_live). The rename never transmits, and the CRDT
		//     leg issues no old-leg delete to fall back on: "Note <new path> not
		//     on server after 120s".
		//   - `version` / `serverHash` — same family, CAS facts about a row the
		//     server holds at the OLD path.
		//
		// What the delete-push evidence rule (#416) reads is `syncState.has(path)`
		// — presence, nothing else. So presence is exactly what moves, and the
		// new-path push re-establishes the rest from the server's own answer.
		this.syncState.set(to, { hash: 0 });
	}

	/** Seed the last-synced baseline from content that just entered the local
	 *  Y.Doc (a CRDT-driven disk write, or a pushed/transferred seed). Merges
	 *  onto any existing entry so a prior sync's version/serverHash survive;
	 *  only the content hash is refreshed. `markCreated` additionally flips the
	 *  `hasServerNote` oracle via the CRDT_HEAD_CREATED sentinel (genesis /
	 *  create-ack adopt sites); the first convergence overwrites the sentinel
	 *  with the authoritative head.
	 *
	 *  Pulled-from-feed sites do NOT go through `markCreated` — they call
	 *  `markServerKnown` after the flush, which fills a missing head without
	 *  ever overwriting a real one. */
	private recordCrdtBaseline(
		normalized: string,
		content: string,
		opts?: { markCreated?: boolean },
	): void {
		this.patchSyncedRow(normalized, {
			hash: fnv1a(content),
			...(opts?.markCreated ? { crdtHead: CRDT_HEAD_CREATED } : {}),
		});
	}

	/** Un-bank the echo baseline for a frame the server DROPPED (note_not_found).
	 *
	 *  `recordCrdtBaseline` stamps the transmitted content the instant
	 *  `routeModify` consumes it into the local Y.Doc — before any server ack,
	 *  because the live channel normally carries it from there. When the backend
	 *  instead drops the frame, nothing walks that stamp back, so the hoisted
	 *  echo gate in `pushFile` hash-matches those exact bytes and skips every
	 *  retry: the content is stranded for the life of the vault, not merely
	 *  delayed. Seen in CI as `Echo skip: <note> | hash=1821472990` repeating
	 *  forever after a `note_not_found` drop (e2e test_27).
	 *
	 *  Resetting to the `hash: 0` no-baseline default is the honest state: we do
	 *  not know the server has this content, so the next push must re-send it.
	 *  Never touches crdtHead/version — only the claim about what was delivered. */
	clearPushedBaselineForId(docId: string): void {
		const path = this.noteIdMap?.pathForId(docId);
		if (!path) return;
		this.patchSyncedRow(normalizePath(path), { hash: 0 });
	}

	/** Refresh a LIVE-BOUND note's baseline from the autosave that just landed.
	 *  Fire-and-forget from handleModify's editor-owns-the-file gate (which is
	 *  synchronous): the read is the same `cachedRead` the push path would have
	 *  done on the not-bound route, so this adds no disk work the gate saved.
	 *  Best-effort — a read failure only leaves the baseline as stale as it is
	 *  today, so it must never surface as an error to the vault event. */
	private async recordLiveBoundBaseline(file: TFile): Promise<void> {
		try {
			this.recordCrdtBaseline(
				normalizePath(file.path),
				await this.app.vault.cachedRead(file),
			);
		} catch (e) {
			devLog().log(
				"crdt",
				`live-bound baseline refresh failed for ${file.path}: ${errMsg(e)}`,
			);
		}
	}

	/** Capture an un-pushed on-disk edit into the Y.Doc BEFORE a fanned-out or
	 *  cold-received remote update flushes to disk, so CRDT MERGES the local
	 *  drift instead of the remote projection overwriting it (BUG 2: a
	 *  NOT-live-bound note's external edit lives only on disk until its debounce
	 *  fires pushFile; a remote apply landing in that window would clobber it).
	 *  Only acts on a note whose disk content diverges from its recorded baseline
	 *  (needsColdReconcile) — an in-sync note, or one with no baseline, has
	 *  nothing local to preserve. Reuses applyLocalEdit (frontmatter split +
	 *  minimal diff), mirroring reconcileColdStart; oversized notes are left to
	 *  the legacy path (never seeded — 8 MB WS frame limit).
	 *
	 *  PRECONDITION (history-FULL docs only): the callers
	 *  (`applyPushedNoteUpdate`/`coldReceive`) invoke this ONLY when the note's
	 *  Y.Doc already carries the baseline lineage (`crdt.hasHistory` true). A
	 *  history-LESS doc is routed to `adoptHistoryLessNote` instead — seeding disk
	 *  into an empty doc here would mint a FRESH lineage that unions with the
	 *  server lineage and DOUBLES the baseline (#234). On a history-full doc the
	 *  seed is a clean minimal diff onto the existing baseline, so the subsequent
	 *  `applyRemoteUpdate` CRDT-merges both edits without doubling.
	 *
	 *  Best-effort: never throws into the apply path. The caller has already
	 *  established !isLiveBound. */
	private async captureDiskDriftBeforeRemote(path: string, noteId: string): Promise<void> {
		if (!this.crdt) return;
		const normalized = normalizePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!(file instanceof TFile)) return;
		let disk: string;
		try {
			disk = await this.app.vault.cachedRead(file);
		} catch {
			return; // unreadable — let the remote apply proceed rather than block sync
		}
		if (exceedsCrdtNoteLimit(disk, MAX_CRDT_NOTE_BYTES)) return;
		if (!this.needsColdReconcile(normalized, disk)) return; // in-sync / no baseline
		try {
			// Live reread: `disk` is a frozen snapshot and the manager's entry
			// await can span a concurrent remote merge — same stale-snapshot
			// revert class as pushFile/test_83 (review sync.ts:153 altitude).
			await this.crdt.applyLocalEdit(noteId, disk, undefined, () =>
				this.app.vault.cachedRead(file),
			);
			// The seeded drift ships live via manager.onUpdate -> sendCrdt ONLY
			// when the crdt topic is joined. In the reconnect window where the sync
			// topic delivered THIS fan-out but the crdt topic has not re-joined yet
			// (`!crdtLive()`), that update is dropped — and once the caller's
			// flushFromCrdt advances the baseline to the merged disk content, the
			// debounced pushFile echo-skips, stranding the drift until the note's
			// next edit. Durably queue it (noteId-keyed, dedup) so the next flush
			// ships the merged Y.Doc state regardless. Mirrors pushFile's own
			// channel-down handling; `file` is a TFile past the guard above.
			if (!(this.crdtLive?.() ?? true)) {
				await this.enqueueCrdtEdit(file, noteId);
				void this.flushQueue();
			}
		} catch (e) {
			rlog().warn(
				"crdt",
				`captureDiskDriftBeforeRemote: seed failed for ${noteRef(path)}: ${errMsg(e, path)}`,
			);
		}
	}

	/** Converge a not-live-bound CRDT note whose local Y.Doc has NO history yet
	 *  (#234). A feed-synced note (content delivered via the op-log rows, its
	 *  IndexedDB store never populated) has an empty Y.Doc. Two coupled failures
	 *  arise if we treat it like a history-full note:
	 *   - DOUBLING: `captureDiskDriftBeforeRemote` → `applyLocalEdit(disk)` seeds
	 *     the whole disk as a FRESH lineage; the subsequent server-lineage merge
	 *     unions two independent insertions of the baseline → baseline doubles.
	 *   - INCOMPLETENESS: an INCREMENTAL delta applied to an empty doc has no
	 *     causal base, so its ops pend and the note never reconstructs.
	 *  Phase E3 (storm-safe rework): NEVER seed, NEVER open a room. Apply the
	 *  fanned-out delta directly to the empty doc:
	 *   - A note created while this device is online arrives as its FIRST
	 *     delta = the entire lineage since genesis — it integrates gap-free
	 *     and the doc is history-full on the server's own lineage, room-free.
	 *   - An incremental delta for a note that predates this device PENDS —
	 *     return "deferred" with NO re-handshake: disk convergence is owned by
	 *     the op-log rows (the caller's seq is not stamped, so the row is not
	 *     fence-masked), and the doc hydrates at open/bind time via the room.
	 *     A per-note room refire here re-created the connect storm at
	 *     reconnect scale (hundreds of enrolls → server rate limit → the one
	 *     note that genuinely needed a handshake starved; CI run 29942250643).
	 *  Any un-pushed disk drift is preserved to a keep-both conflict copy
	 *  BEFORE the apply (a gap-free integrate flushes server content over
	 *  disk via the manager's remote-merge listener); copy failure aborts
	 *  without applying so the sole live copy of the edit survives.
	 *  Best-effort: isolates its own failure, never throws. */
	private async adoptHistoryLessNote(
		path: string,
		noteId: string,
		update: Uint8Array,
		head: string,
	): Promise<"applied" | "deferred"> {
		if (!this.crdt) return "deferred";
		const normalized = normalizePath(path);

		// 1. Capture disk + the drift flag BEFORE the apply-flush overwrites disk
		//    and its recorded baseline (needsColdReconcile compares to syncState).
		const file = this.app.vault.getAbstractFileByPath(normalized);
		let disk: string | null = null;
		if (file instanceof TFile) {
			try {
				disk = await this.app.vault.cachedRead(file);
			} catch {
				disk = null; // unreadable — proceed with a plain apply, no drift copy
			}
		}
		const hasDrift =
			disk !== null &&
			!exceedsCrdtNoteLimit(disk, MAX_CRDT_NOTE_BYTES) &&
			this.needsColdReconcile(normalized, disk);

		// 2. Keep-both: a gap-free integrate flushes server content over the
		//    original's disk, after which `disk` survives ONLY in memory.
		//    Preserve ANY drift (there is no server text to 3-way-merge against
		//    until the ops land) to its conflict copy FIRST; if that write
		//    fails for real, ABORT without applying so the original disk keeps
		//    the local edit and the caller retries next fan-out/poll. The
		//    original's baseline then advances to the drift content so the
		//    pending drift can never be seeded as a fresh lineage (the #234
		//    doubling door) nor re-pushed — it lives on in the copy.
		if (hasDrift && disk !== null) {
			try {
				const copy = await this.writeDriftConflictCopy(normalized, disk);
				rlog().info(
					"conflict",
					`history-less drift → keep-both | original=${noteRef(normalized)} copy=${noteRef(copy)}`,
				);
			} catch (e) {
				rlog().error(
					"conflict",
					`history-less keep-both copy failed for ${noteRef(normalized)}: ${errMsg(e, normalized)}. Aborting apply to retain the local edit for retry`,
				);
				return "deferred";
			}
			this.recordCrdtBaseline(normalized, disk);
		}

		// 3. Apply the delta to the empty doc. Gap-free (a full-lineage first
		//    delta) → history-full on the server lineage, record the head.
		//    Pended (incremental, predates this device) → deferred: no room,
		//    no head, no seq stamp — the op-log rows own disk convergence and
		//    the doc hydrates at open.
		await this.crdt.applyRemoteUpdate(noteId, update);
		const gapped =
			typeof this.crdt.hasPendingGap === "function" &&
			(await this.crdt.hasPendingGap(noteId));
		if (gapped) {
			// The op-log rows do NOT reliably own disk convergence here: the
			// edit's row seq is checkpoint-lagged (a live tail append never bumps
			// notes.seq — the checkpoint owns it), and a resumed device's cursor
			// is already past the note's old row, so the feed never re-serves it
			// (e2e test_82, local repro 2026-07-22). This fan-out was the only
			// in-window delivery and it could not reconstruct the note — fire the
			// cooldown-gated re-handshake so STEP2's full state converges the
			// empty doc. Storm-safe: only actively-edited notes fan out (not
			// catch-up-scale enumerations) and the 15s per-note cooldown coalesces
			// bursts (the CI 29942250643 class this branch once guarded against).
			rlog().info(
				"crdt",
				`history-less delta pends for ${noteRef(normalized)} — socket converge`,
			);
			this.socketConverge(normalized, noteId);
			return "deferred";
		}
		this.setCrdtHead(normalized, head);
		return "applied";
	}

	/** Write `localDisk` to a dated `<name> (conflict <date>).md` copy beside
	 *  `normalized` and record its baseline so it isn't re-pushed as drift.
	 *  Throws on a GENUINE write failure — `createFileWithFolders` degrades a
	 *  benign "already exists" race to a modify with the same content, so only
	 *  real errors (disk full, permission, illegal path) propagate. Returns the
	 *  conflict path written. */
	private async writeDriftConflictCopy(normalized: string, localDisk: string): Promise<string> {
		// Millisecond-precision stamp (not date-only): two double-divergence
		// resolutions on the SAME note within one day would otherwise produce an
		// identical path, and createFileWithFolders degrades that collision to an
		// in-place modify — silently clobbering the first preserved copy.
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		// Preserve the note's own extension (.md or .canvas) so a canvas drift copy
		// stays a canvas file, not a stray .md.
		const ext = canvasPath(normalized) ? "canvas" : "md";
		const base = normalized.replace(/\.(md|canvas)$/, "");
		const conflictPath = `${base} (conflict ${stamp}).${ext}`;
		await this.createFileWithFolders(conflictPath, localDisk);
		this.stampSyncedRow(normalizePath(conflictPath), { hash: fnv1a(localDisk) });
		return conflictPath;
	}

	/** Materialize an EMPTY note whose emptiness the server has just confirmed.
	 *
	 *  A non-empty note materializes through the normal update→`flushFromCrdt`
	 *  path: our discovery STEP1 elicits a STEP2 carrying the body, applying it
	 *  fires a doc-update event, and that writes the file. An EMPTY note has no
	 *  body — its STEP2 integrates zero ops, so no doc-update event fires and no
	 *  flush creates the file.
	 *
	 *  This is called from `CrdtChannel.onEmptyStep2`, i.e. only after an inbound
	 *  STEP2 has left the doc empty — the authoritative "genuinely empty" signal.
	 *  So there is no timer and no guessing: create the file from the doc's
	 *  current text (empty) if it is still absent. Keying off the STEP2 (not a
	 *  wall-clock window) is what closes the #547 race where a slow content STEP2
	 *  let a premature empty file land on disk under load. Gated to `.md`
	 *  (mirrors the CRDT-markdown-only rule).
	 *
	 *  `noteId` reads the CRDT doc (id-keyed); `path` is used only for disk
	 *  I/O and log messages — passing `path` to `crdt.projectedText` would open
	 *  a stray path-keyed doc/IndexedDB store instead of the real note. */
	async materializeEmptyDiscovered(path: string, noteId: string): Promise<void> {
		if (this.syncBlocked) {
			devLog().log(
				"sync-blocked",
				`materializeEmptyDiscovered short-circuited — gate closed: ${path}`,
			);
			return;
		}
		if (!this.isCrdtEligiblePath(path)) return;
		const normalized = normalizePath(path);
		// Already on disk — a content STEP2 created it, or the user already has it.
		if (this.app.vault.getAbstractFileByPath(normalized)) return;
		// A note THIS device is deleting must NOT be materialized: "not on disk"
		// is the expected state mid-delete, and an empty STEP2 racing the
		// tombstone would otherwise CREATE an empty file at the deleted path that
		// nothing ever removes (observed 2026-07-28). Same pair, keyed the same
		// way, as discoverAnnouncedNote: recentlyDeleted (by note_id, ~60s TTL)
		// covers a delete already sent; hasPendingDelete (by path) covers one
		// still sitting unsent in the offline queue.
		if (this.recentlyDeleted.has(noteId)) {
			rlog().info(
				"crdt",
				`empty-materialize skip (recent local delete): ${noteRef(normalized)}`,
			);
			return;
		}
		if (this.queue.hasPendingEvidencedDelete(normalized, this.settings.vaultId ?? undefined)) {
			rlog().info("crdt", `empty-materialize skip (delete queued): ${noteRef(normalized)}`);
			return;
		}

		// An empty STEP2 is the server's authoritative "genuinely empty" reply.
		// The transient-empty race (an author's REST-pushed body whose Y.Doc
		// update hadn't reached the server yet, so the room seeded empty and a
		// premature empty file stranded on this device — e2e test_38/test_43) is
		// now closed SERVER-SIDE by backend #1094: a room seeds from notes.content
		// whenever the doc projects an empty body, so a content-bearing note's
		// STEP2 already carries its body. The former client-side REST getNote
		// cross-check (this note's #310 race-closer) is therefore redundant.
		const text = this.crdt ? await this.crdt.projectedText(noteId) : "";

		await this.flushFromCrdt(path, text);
	}

	/** Materialize a relocated/first-delivery note at `path` from its CRDT doc
	 *  projection when this device's handshake for `noteId` has landed. Content-
	 *  ABSENT backstop only (a content-present op materializes via applyOp): a
	 *  rename carries no doc update so onFlushToDisk never fires, and an idle note
	 *  is not enrolled — without this the new path would appear only via the slow
	 *  pull (received=yes materialized=no). Gated on `crdt.isSynced(noteId)` (NOT
	 *  "already enrolled": enroll marks synchronously before STEP2 lands, so an
	 *  enrolled check could flush empty/partial content — the #547 class), so the
	 *  projected text is trustworthy; no-ops when the handshake hasn't landed
	 *  (the op-log seq-replay heals instead) or the file already exists.
	 *
	 *  Identity re-check at WRITE time (issue #210, e2e test_34): a concurrent
	 *  id-keyed move can land during the projectedText await (it suspends on IDB),
	 *  so re-read the canonical path immediately before the write — writing a
	 *  moved-away path would re-create a tombstoned file and resurrect it. Defends
	 *  the MOVE case only; a tombstone delete clears the byId entry (canonical
	 *  null), where the isSynced gate is the backstop. */
	private async materializeRelocated(path: string, noteId: string): Promise<void> {
		if (!this.crdt || !this.isCrdtEligiblePath(path)) return;
		// Defensive `typeof` (not `?.`) — CrdtManager always has isSynced, but many
		// existing unit tests wire a partial `{ applyLocalEdit } as any` stand-in
		// that doesn't, and a missing method must read as "not synced" rather than
		// throw.
		if (typeof this.crdt.isSynced !== "function" || !this.crdt.isSynced(noteId)) return;
		if (this.app.vault.getAbstractFileByPath(normalizePath(path))) return;
		const text = await this.crdt.projectedText(noteId);
		const canonical = this.noteIdMap?.pathForId(noteId) ?? null;
		if (canonical !== null && normalizePath(canonical) !== normalizePath(path)) {
			rlog().info(
				"ws",
				`Stale materialize skipped for ${noteId}: canonical=${noteRef(canonical)} captured=${noteRef(path)}`,
			);
			return;
		}
		await this.flushFromCrdt(path, text);
	}

	/** Persistent record of files that failed to sync, with reason. Surfaced
	 *  in the Sync Center "Issues" panel and used to short-circuit the offline
	 *  queue for terminal failures (e.g. 413 Payload Too Large). */
	readonly issues: IssueStore = new IssueStore();

	/** Public only so the unused-private-member lint stays honest: the field
	 *  exists to REGISTER at the declaration site, never to be read. `IssueStore`
	 *  already owns `clear(path)`, so it cannot satisfy the
	 *  sweepable shape directly — this adapter registers it without renaming a
	 *  public API. Vault-scoped because plan-limit parks are per-vault: a Free
	 *  vault's 402 attachments-disabled park must not suppress the same path on
	 *  a Pro or self-host vault, where `pushFile` short-circuits BEFORE any
	 *  request so nothing ever arrives to clear it (#1409 review). */
	readonly issuesSweeper = this.track(["vault", "destroy"], {
		clear: () => this.issues.clearAll(),
	});

	/** Per-file explicit ignores (the Sync Center "Ignore" button). Honored by
	 *  shouldIgnore so excluded files never enter push plans, isSyncable filters,
	 *  or the Issues list. Distinct from settings.ignorePatterns (regex textarea). */
	readonly ignoredFiles: IgnoredFiles = new IgnoredFiles();

	/** Count of attachments skipped this session because the backend returned
	 *  402 attachments_disabled (Free tier). Reset on each batch via
	 *  drainAttachmentLimitedCount() so a single batched toast can be fired
	 *  per push cycle (spec §4.6). */
	private attachmentLimitedThisBatch = 0;

	/** Plan-gated attachment skips drained by the most recent push flush, kept
	 *  so the terminal "complete" progress event can report a `skipped` count
	 *  even after `flushAttachmentLimitedToast()` has reset the live tally.
	 *  Disjoint from the `failed` counter (real failures) by construction —
	 *  informational outcomes increment `attachmentLimitedThisBatch`, genuine
	 *  failures increment `failuresThisBatch` / the local `failed`. */
	private lastBatchSkipped = 0;

	/** Count of generic (non-needs_pro) push failures this batch, plus the
	 *  first server message seen — drained by main.ts into a single aggregated
	 *  "N file(s) failed to sync — open Sync Center" Notice. */
	private failuresThisBatch = 0;
	private firstFailureMessageThisBatch: string | undefined;

	/** Suppresses re-toasting once we've already shown the "N attachments
	 *  skipped" notice in this plugin session. Re-armed only when the engine
	 *  is destroyed/reloaded so the user isn't nagged on every fullSync. */
	private attachmentLimitToastShown = false;

	constructor(
		private app: App,
		private api: EngramApi,
		private settings: EngramSyncSettings,
		private saveData: (data: {
			lastSync?: string;
			catchupSeq?: number;
			catchupId?: string | null;
			manifestSeq?: number;
			// Signals the engine mutated the shared noteIdMap and it should be
			// persisted. main.ts's savePluginData writes the map instance directly
			// (same object), so the callback need not read this — it just triggers
			// the wholesale save.
			noteIds?: Record<string, string>;
		}) => Promise<void>,
		/** Injectable clock + timers. Defaulted so every existing caller is
		 *  unchanged; tests pass a ManualTimeProvider to advance a TTL window
		 *  instead of sleeping through it. */
		private time: TimeProvider = new DefaultTimeProvider(),
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

	setSyncBlocked(blocked: boolean): void {
		this.syncBlocked = blocked;
		// Re-arm the announcement on every transition, so a LATER closure (a
		// vault switch, a re-link) speaks up again instead of staying silent
		// because some earlier closure already used up the one notice.
		this.blockedEditReported = false;
		devLog().log("lifecycle", `setSyncBlocked(${blocked})`);
	}

	isSyncBlocked(): boolean {
		return this.syncBlocked;
	}

	/** Fire `onSyncBlockedEdit` at most once per gate closure. */
	private reportBlockedEdit(): void {
		if (this.blockedEditReported) return;
		this.blockedEditReported = true;
		rlog().warn("lifecycle", "edit blocked — sync gate closed, user not notified until now");
		this.onSyncBlockedEdit?.();
	}

	setLastSync(timestamp: string): void {
		this.lastSync = timestamp;
	}

	getLastSync(): string {
		return this.lastSync;
	}

	/** Highest vault `seq` this device has replayed via the socket op-log catch-up
	 *  (`catchupViaSeqReplay`). Persisted under `catchupSeq`; a reconnect resumes
	 *  from here so only ops written while we were away are replayed. 0 = replay
	 *  from genesis (first-ever connect / after a state wipe). */
	private catchupSeq = 0;

	getCatchupSeq(): number {
		return this.catchupSeq;
	}

	setCatchupSeq(seq: number): void {
		this.catchupSeq = Number.isFinite(seq) && seq >= 0 ? seq : 0;
	}

	/** Composite-cursor id paired with `catchupSeq` (#312). An attachment move
	 *  writes two rows at one seq; the id lets a resumed replay continue at
	 *  `(seq, id) > (catchupSeq, catchupId)` instead of the seq-only `seq >`,
	 *  which would skip the second row. Only feeds the catch-up fetch — NOT the
	 *  gap-heal fence (that stays seq-only + hash-aware). Null = no id yet
	 *  (seq-only, e.g. a genesis replay or a pre-#312 backend). */
	private catchupId: string | null = null;

	getCatchupId(): string | null {
		return this.catchupId;
	}

	setCatchupId(id: string | null): void {
		this.catchupId = typeof id === "string" && id.length > 0 ? id : null;
	}

	/** The vault change_seq watermark of the last FULLY-processed manifest pass
	 *  (Phase E1 #1065). Sent as `?since_seq=` so an unchanged vault
	 *  short-circuits the manifest fetch + the manifest-driven catch-up steps.
	 *  Persisted under `manifestSeq`; wiped with the per-vault state. */
	private manifestSeq = 0;

	/** Cursor value of the last validator rewind — bounds the validator to ONE
	 *  re-serve per distinct discrepancy per session (see validateFromManifest).
	 *  null = no rewind yet (a numeric sentinel would collide with the
	 *  legitimate `minBehind - 1` target domain, which includes -1 and 0). */
	private lastValidatorRewind: number | null = null;

	/** A pending validator rewind, consumed atomically by the next
	 *  `runSeqReplayOnce` (`catchupViaSeqReplay` is the SOLE cursor writer —
	 *  a direct `setCatchupSeq` here would race an in-flight replay's per-page
	 *  cursor persist and be silently clobbered). */
	private seqRewindFloor: number | null = null;

	getManifestSeq(): number {
		return this.manifestSeq;
	}

	setManifestSeq(seq: number): void {
		this.manifestSeq = Number.isFinite(seq) && seq >= 0 ? seq : 0;
	}

	/** Gap-heal decision for a live op carrying the backend's vault `seq`.
	 *  `apply()` ALWAYS runs first, in every branch — Yjs updates are
	 *  commutative + idempotent, so seq never gates application; a stale seq
	 *  on a live delta is normal (the backend's seq goes stale between
	 *  checkpoints), not a duplicate.
	 *
	 *  This is a pure BEHIND-DETECTOR: a live op never advances or persists
	 *  the `catchupSeq` cursor, full stop. The prior "seq === cursor + 1 ->
	 *  advance" branch was removed (final review) because advancing off live
	 *  observation is unsound in three distinct ways: (1) a per-message
	 *  silent-skip apply (e.g. an illegal-filename op) consumes a feed entry
	 *  without the client ever seeing it, so a later "+1" looks in-order while
	 *  actually skipping the entry that would have carried a rename/delete;
	 *  (2) `seq` is shared/aliased across write kinds (note/attachment/folder),
	 *  so watching only note live-ops can walk straight past a missed rename
	 *  that consumed an intervening seq; (3) the live stream is unordered
	 *  across a multi-node, multi-note vault, so "+1" arithmetic over it fires
	 *  false gaps continuously rather than detecting real ones. `seq` here is
	 *  used ONLY to detect "we are behind"; `catchupViaSeqReplay` is the sole
	 *  writer of the cursor (it persists per page, see its call site), and it
	 *  is the only thing that can safely consume renames/deletes/creates in
	 *  order.
	 *  - `seq` fails `Number.isInteger` (undefined, null, string, NaN, a
	 *    float): not a valid signal, apply only, cursor unchanged.
	 *  - `seq <= catchupSeq`: stale (normal for a live delta between
	 *    checkpoints), apply only, cursor unchanged.
	 *  - `seq > catchupSeq`: we are behind — apply, schedule the (throttled,
	 *    single-flighted) seq-replay catch-up, and do NOT touch the cursor;
	 *    the replay reads the persisted cursor itself and advances/persists it.
	 *
	 *  THROTTLED, not per-op (CI run 29877041947): checkpoint/REST-origin
	 *  fan-outs carry a FRESH seq (the "stale between checkpoints" assumption
	 *  only holds for socket deltas), and the cursor only advances via replay,
	 *  so in steady-state editing every delivered op looks "from the future" —
	 *  firing a replay round-trip per op raced the live path suite-wide. The
	 *  trailing throttle keeps the heal guarantee (a true miss replays within
	 *  SEQ_HEAL_COOLDOWN_MS) while bounding replay rate to one per window. */
	async applyLiveOpWithSeq(
		noteId: string,
		seq: number | undefined | null,
		apply: () => Promise<"applied" | "deferred">,
	): Promise<"applied" | "healing" | "deferred"> {
		const landed = await apply();
		if (landed === "applied" && Number.isInteger(seq)) {
			// Advance the PER-PATH high-water mark (types.ts FileSyncState.seq):
			// a live op that ACTUALLY applied proves the path is current through
			// this seq, so a later replayed/enumerated ROW at or below it is
			// history and must not backfill (the checkpoint-lag revert, CI
			// 29877041947). ONLY on op-level proof (`"applied"`): a pended /
			// history-less-deferred op that stamped anyway fence-masked the very
			// replay row carrying the content this device is missing — B stayed
			// on stale content forever (e2e test_85, CI run 29942250643).
			// Per-path observation only — the global replay cursor is untouched
			// (see the behind-detector rationale above).
			const path = this.noteIdMap?.pathForId(noteId);
			const st = path ? this.syncState.get(path) : undefined;
			if (path && st && (st.seq === undefined || (seq as number) > st.seq)) {
				this.patchSyncedRow(path, { seq: seq as number });
			}
		}
		if (!Number.isInteger(seq) || (seq as number) <= this.catchupSeq) {
			return landed === "applied" ? "applied" : "deferred";
		}
		rlog().info("crdt", `gap-heal fired: note=${noteId} seq=${seq} cursor=${this.catchupSeq}`);
		this.scheduleSeqHeal();
		return "healing";
	}

	/** Trailing-edge throttle for heal-triggered seq replays: the first
	 *  trigger fires immediately; triggers inside the cooldown coalesce into
	 *  ONE trailing replay at window end (never dropped — a dropped trailing
	 *  run could strand a real miss until the next op). */
	private scheduleSeqHeal(): void {
		const now = Date.now();
		const since = now - this.seqHealLastAt;
		if (since >= SyncEngine.SEQ_HEAL_COOLDOWN_MS) {
			this.seqHealLastAt = now;
			void this.catchupViaSeqReplay();
			return;
		}
		if (this.seqHealTimer !== null) return;
		this.seqHealTimer = this.time.setTimeout(() => {
			this.seqHealTimer = null;
			this.seqHealLastAt = Date.now();
			rlog().info("crdt", "gap-heal replay (trailing, throttled)");
			void this.catchupViaSeqReplay();
		}, SyncEngine.SEQ_HEAL_COOLDOWN_MS - since);
	}

	/** Wipe ALL per-vault sync + identity state. Both vault-change paths
	 *  (explicit picker `resetForVaultChange`, backstop
	 *  `invalidateIfVaultChanged`) call this — keeping them in lockstep is the
	 *  point; a wipe that exists on only one path re-opens #200. */
	private async wipePerVaultState(): Promise<void> {
		// Every collection registered for "vault" at its declaration — syncState,
		// the note_id-keyed CRDT bookkeeping, the path-keyed markers — cleared in
		// one pass, with timer-holding maps disposed by their declaration hooks.
		// Before this, the list below was hand-written and eleven vault-scoped
		// maps were missing from it (#1409); adding a field no longer requires
		// remembering that this method exists.
		this.sweep("vault");
		this.lastSync = "";
		// The socket op-log replay cursor marks a position in the OLD vault's
		// seq feed — reset to 0 so the next catch-up replays the new vault from
		// genesis (else a stale high seq would suppress it entirely).
		this.catchupSeq = 0;
		this.catchupId = null;
		// Same cross-vault hazard for the manifest watermark (E1 #1065): a
		// stale since_seq could integer-collide with the NEW vault's change_seq
		// and wrongly short-circuit the first reconcile after a swap.
		this.manifestSeq = 0;
		this.lastValidatorRewind = null;
		// The note-id map is per-vault identity state but is NOT a tracked
		// collection: the instance is shared with main.ts + live views, so it is
		// cleared in place rather than swept. Carrying it across vaults keys CRDT
		// frames/rooms by another vault's note ids — the cross-vault flavor of the
		// 2026-07-07 cross-wire class (plugin #200). Ids re-learn via the manifest
		// reconcile + push adoption. (`confirmedNoteIds` rides the sweep above.)
		this.noteIdMap?.clear();
		// The durable op queue and the unsent-doc set are the two places a note_id
		// outlives the vault it was minted in. A CrdtOp carries a bare docId and NO
		// vault, so a create still pending when the user switches vaults is flushed
		// blind on the NEW vault's topic under an id the OLD vault owns -- the
		// server then cannot place it (engram #1318, the cross-vault collision the
		// server now re-mints around). reEnrollUnsent has the same shape: it would
		// STEP1 the previous vault's ids against the new topic. Dropping both is
		// safe because lastSync is cleared above, so a later switch BACK re-derives
		// and re-pushes anything they carried.
		this.crdtResetOutbox?.();
		// Folder markers are vault-scoped too: a stale set after a switch lets
		// handleFolderDelete push marker deletes against the NEW vault (post-
		// merge review finding 8 — data-safe but cross-vault noise).
		await this.explicitFolders?.replaceAll([]);
		await this.saveData({ lastSync: "" });
	}

	/** Reset all per-vault sync bookkeeping. Used when the user switches the
	 *  active server vault inside the SyncPreviewModal so the next sync starts
	 *  from a clean slate (lastSync empty, no stale per-file hashes). */
	async resetForVaultChange(): Promise<void> {
		this.syncStateVaultId = this.settings.vaultId ?? null;
		await this.wipePerVaultState();
		devLog().log(
			"lifecycle",
			"resetForVaultChange: lastSync + syncState + cursor + ids cleared",
		);
	}

	getSyncStateVaultId(): string | null {
		return this.syncStateVaultId;
	}

	setSyncStateVaultId(id: string | null): void {
		this.syncStateVaultId = id;
	}

	/** #283: mark that the api auth provider was (or is being) swapped. Called by
	 *  main.ts on OAuth token save/clear so a manifest fetch that straddles the
	 *  swap can be detected and its destructive reconcile refused. */
	bumpAuthGeneration(): void {
		this.authGeneration++;
	}

	/** Invalidate stale per-vault bookkeeping if the active server vault no
	 *  longer matches the one syncState was recorded under. This is the
	 *  self-healing backstop for vault switches that bypass the SyncPreviewModal
	 *  picker (e.g. OAuth re-login, ensureVault) and so never call
	 *  resetForVaultChange. A `null` recorded id (fresh install / pre-upgrade
	 *  data) is adopted WITHOUT wiping, so upgrading doesn't drop valid state. */
	private async invalidateIfVaultChanged(): Promise<void> {
		const current = this.settings.vaultId ?? null;
		if (!current) return; // no active vault to compare against
		if (this.syncStateVaultId === null) {
			this.syncStateVaultId = current; // adopt; migration-safe, no wipe
			return;
		}
		if (this.syncStateVaultId === current) return;

		rlog().warn(
			"lifecycle",
			`Vault changed (${this.syncStateVaultId} → ${current}) — invalidating stale syncState`,
		);
		devLog().log(
			"lifecycle",
			`vault changed ${this.syncStateVaultId} → ${current} — clearing syncState + lastSync`,
		);
		this.syncStateVaultId = current;
		await this.wipePerVaultState();
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
			this.stampSyncedRow(path, state);
		}
	}

	private getCrdtHead(path: string): string | undefined {
		return this.syncState.get(normalizePath(path))?.crdtHead;
	}

	private setCrdtHead(path: string, head: string): void {
		this.patchSyncedRow(normalizePath(path), { crdtHead: head });
	}

	/** Flip the `hasServerNote` oracle for a note the server demonstrably holds,
	 *  without ever DOWNGRADING an authoritative head to the placeholder.
	 *
	 *  `patchSyncedRow` merges, so writing CRDT_HEAD_CREATED over a real head
	 *  recorded by `applyPushedNoteUpdate` would invert the sentinel's contract
	 *  and permanently defeat the convergence cost gate (`getCrdtHead ===
	 *  serverHead` -> skip), re-firing STEP1 for that note forever. The sentinel
	 *  only ever fills a HOLE. */
	private markServerKnown(path: string): void {
		const normalized = normalizePath(path);
		if (this.getCrdtHead(normalized) == null) {
			this.setCrdtHead(normalized, CRDT_HEAD_CREATED);
		}
	}

	/** Public: consumed as `CrdtManagerOptions.canSendLive` by the wiring in
	 *  main.ts (`createCrdtWiring({ canSendLive: (id) => this.syncEngine.hasServerNote(id) })`)
	 *  so a note's live crdt_msg sends stay held until its create is acked —
	 *  see `isNoteConfirmed`'s doc comment for why `canSendLive` moved here
	 *  instead of the session-scoped `confirmedNoteIds`.
	 *
	 *  CRDT-native replacement for the REST-era confirmed-set oracle: true when
	 *  the server is known to already hold a row for this note. `crdtHead` is set
	 *  ONLY by server-delivered heads (convergence/apply) or by a successful
	 *  `crdt_create` (the sentinel below), so `!= null` genuinely means "the
	 *  server has this note." Keyed by note_id so a rename follows the note —
	 *  `crdtHead` lives in syncState under the note's current path, resolved via
	 *  the id map. The note's own CRDT state is the oracle, never a REST-era set. */
	hasServerNote(noteId: string | null): boolean {
		if (!noteId) return false;
		const path = this.noteIdMap?.pathForId(noteId);
		if (!path) return false;
		return this.getCrdtHead(path) != null;
	}

	/** Import legacy hash-only format (migration from old plugin versions). */
	importHashes(data: Record<string, number>): void {
		for (const [path, hash] of Object.entries(data)) {
			this.stampSyncedRow(path, { hash });
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
		const configDir = `${this.app.vault.configDir}/`;
		if (path.startsWith(configDir) || path.includes(`/${configDir}`)) {
			return true;
		}
		for (const pattern of ALWAYS_IGNORED) {
			if (path.startsWith(pattern) || path.includes(`/${pattern}`)) {
				return true;
			}
		}
		// User-explicit per-file ignores (from Sync Center)
		if (this.ignoredFiles.has(path)) return true;
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

	/** Seed a just-created note's body under `effectiveId` — THE one
	 *  implementation (#1409 consolidation).
	 *
	 *  This ran twice: once in `applyCrdtCreateAck` (durable-queue create) and
	 *  once inline in `pushFile` (live create). The two were identical down to
	 *  the drift-merge ordering, and `applyCrdtCreateAck`'s docstring promised
	 *  it "mirrors pushFile's seeded-gated local apply exactly, guard-for-guard"
	 *  — a contract nothing enforced. #1130 is already logged as "duplicated
	 *  gates silently diverging"; this is the same lesson, and every fix to this
	 *  logic had to be made in both copies or silently apply to half the creates.
	 *
	 *  Two routes, mutually exclusive:
	 *
	 *  FAST — the server confirmed our genesis frame landed against an EMPTY row
	 *  (`seeded`), it answered under the id we asked for (`sameId`), and this
	 *  device's doc has no lineage either. Applying the exact accepted bytes with
	 *  PROVIDER origin neither re-broadcasts nor opens a room, and leaves this
	 *  device on the server's lineage instead of minting a second one that Yjs
	 *  would later union into a doubled body (#846).
	 *
	 *  SLOW — anything else. `routeModify` diffs live disk onto whatever lineage
	 *  exists, which is correct when the doc already has history (H1):
	 *  `applyLocalEdit`'s `lca` makes it a minimal diff, not a rival lineage.
	 *
	 *  `hasAnyHistory`, never `hasHistory` (round-2 review): the latter is
	 *  body-only, so a frontmatter-only note with an empty body reported false,
	 *  passed the guard, and had its ORDER_KEY array doubled exactly the way H1
	 *  doubled bodies. A raw applyUpdate is a concurrent insert into EVERY shared
	 *  type the frame touches. Unknown (older test fakes) fails CLOSED.
	 *
	 *  M1 drift: `genesisContent` was frozen before the create round-trip.
	 *  Anything that wrote to disk in that window (an importer's second pass,
	 *  Obsidian Sync, git pull, Templater) is reverted by the flush the apply
	 *  triggers, so disk is captured BEFORE it and merged back after. No
	 *  `reread` callback on that merge — re-reading would read the just-reverted
	 *  disk and silently discard the drift, which is the bug this guards.
	 *
	 *  Returns what the manager CONSUMED (the echo baseline for
	 *  `adoptCreateAck`), or null if nothing transmitted. */
	/** Pull the server's own lineage for `noteId` and adopt it, room-free
	 *  (#1467). Applying is a monotonic merge, so this can only converge us
	 *  toward the server — it never discards local history. Returns the
	 *  projected text, or null when the read is unavailable (old backend, rate
	 *  limit, dropped socket) and the caller must decide how to defer.
	 *
	 *  ONE implementation on purpose: both callers below reach it from a state
	 *  where re-sending the body would mint a rival lineage, and a second copy
	 *  is how the first one drifted (#476). */
	private async adoptServerLineage(noteId: string, path: string): Promise<string | null> {
		// Capture the registry BEFORE the await. `setCrdtPorts` reassigns
		// `this.crdt` on a vault change, so re-reading it after the round trip
		// can apply the OLD vault's Yjs bytes into the NEW vault's registry under
		// the same note_id — and note_ids are unique only WITHIN a vault, which
		// is the very cross-vault identity bug this branch exists to close
		// (#1409 review). Comparing identity afterwards turns a silent
		// cross-vault write into a refusal.
		const crdt = this.crdt;
		if (!crdt) return null;

		const state = await this.readServerDocState(noteId, path);
		if (state === null) return null;

		if (this.crdt !== crdt) {
			rlog().warn(
				"crdt",
				`create: vault changed while reading server state for ${noteRef(path)} — ` +
					`discarding the reply rather than applying it to the new vault`,
			);
			return null;
		}

		// A refused apply (note deleted, doc destroyed mid-hydration) is NOT an
		// adopt. Reporting it as one is the doubling: the caller falls through and
		// diffs the body into a doc that never received the server's lineage, and
		// `applyLocalEdit` reads that as history-less and mints a rival.
		if (!(await crdt.applyRemoteUpdate(noteId, fromB64(state.b64)))) {
			rlog().warn(
				"crdt",
				`create: server state for ${noteRef(path)} was refused by the registry ` +
					`(note removed or doc destroyed) — not an adopt`,
			);
			return null;
		}
		rlog().info("crdt", `create: adopted server lineage for ${noteRef(path)}`);
		return await crdt.projectedText(noteId);
	}

	/** Give the note up to the server's lineage: transmit nothing now, and record
	 *  disk as the baseline so nothing transmits it LATER either.
	 *
	 *  The baseline is the load-bearing half. Both callers reach here holding a
	 *  history-less Y.Doc and a server that has content, and returning a bare
	 *  null leaves exactly that state on the floor: `adoptCreateAck` stamps no
	 *  baseline when nothing was consumed, so `isUnchangedSynced` reads false,
	 *  so the note's very next cold write takes `applyLocalEdit`'s `lca: false`
	 *  branch and seeds the whole body into the empty doc — minting the rival
	 *  lineage this defer exists to avoid. The defer bought one write's delay,
	 *  not safety (#1409 review).
	 *
	 *  Stamping disk arms the adopt-first gate the registry already has
	 *  (provider-registry `applyLocalEdit`: history-less + unchanged-synced =>
	 *  "consumed, nothing to push"), which holds the empty doc open until a
	 *  handshake or catch-up fills it from the server. It also makes
	 *  `needsColdReconcile` false, which is the same answer for the same
	 *  reason: reconciling from disk IS the rival mint.
	 *
	 *  The hash is a claim about what may be re-encoded locally, not a claim
	 *  that the server holds these exact bytes — under `occupied` it holds
	 *  different ones, and the catch-up pull is what settles that.
	 *
	 *  An unreadable disk leaves the baseline alone: a WRONG hash would suppress
	 *  a real push forever, which is worse than the re-arm it would prevent.
	 *  Always returns null — the "nothing transmitted" contract. */
	private async deferToServerLineage(
		normalized: string,
		file: TFile,
		why: string,
	): Promise<null> {
		try {
			this.recordCrdtBaseline(normalized, await this.app.vault.cachedRead(file));
		} catch (e) {
			rlog().warn(
				"crdt",
				`create: deferring ${noteRef(normalized)} but its disk content is unreadable ` +
					`(${errMsg(e, normalized)}) — the next cold write may re-encode it`,
			);
		}
		rlog().warn(
			"crdt",
			`create: ${why} for ${noteRef(normalized)} — deferring to catch-up rather than ` +
				`re-sending the body`,
		);
		return null;
	}

	/** How many consecutive unsupported-looking replies disable a room-free
	 *  frame. ONE is too few: a modern backend produces the identical signal
	 *  whenever the channel dies (phx_error does not reject pending replies, so
	 *  a crash surfaces as a timeout), and under the bulk-import load this
	 *  feature exists for, a single slow reply is entirely reachable. */
	private static readonly FRAME_UNSUPPORTED_LATCH = 2;

	/** Score one reply against `frame`'s capability latch; true when THIS reply
	 *  latched it off. Two signals count, and neither is proof on its own:
	 *
	 *  - a TIMEOUT means the server never answered at all, which is what an
	 *    older backend does with an unknown event — but a crashing channel looks
	 *    identical from here.
	 *  - `bad_frame` is the reply `CrdtChannel`'s catch-all `handle_in/3` gives
	 *    INSTANTLY, and it is the likelier shape: latching on timeouts alone
	 *    meant the latch never engaged against such a server, so every note paid
	 *    a wasted round trip and an extra `:handshake` rate token, on the very
	 *    lane whose starvation the 2026-07-07 incident was about. It is not
	 *    exclusive to an old backend either — the same catch-all answers a
	 *    malformed payload on a frame the server DOES implement.
	 *
	 *  Repeated strikes are what make the ambiguity tolerable. A STRUCTURED
	 *  reject (rate_limited, note_not_found, doc_update_failed) is a real answer
	 *  from a server that implements the frame and must never latch.
	 *
	 *  ONE predicate for both frames on purpose: it shipped on the write frame
	 *  alone and left the read — the higher-volume caller — matching timeouts
	 *  only, so against a backend predating both, the write latched off after
	 *  two strikes while the read probed every cold note forever. */
	private strikeFrame(frame: string, detail: string): boolean {
		if (!/timeout/i.test(detail) && !/bad_frame/i.test(detail)) return false;
		const strikes = (this.frameStrikes.get(frame) ?? 0) + 1;
		this.frameStrikes.set(frame, strikes);
		if (strikes < SyncEngine.FRAME_UNSUPPORTED_LATCH) return false;
		this.unsupportedFrames.add(frame);
		return true;
	}

	/** The ONE place `crdt_doc_state` is called.
	 *
	 *  Both callers route through here so the capability latch is checked AND
	 *  set in the same place. Previously only `adoptServerLineage` consulted it,
	 *  while `convergeColdNoteRoomFree` — the HIGHER-volume caller — neither
	 *  checked nor set it, so the very pathology the latch was written for
	 *  (~1.5s to ~2min per note against an older backend) ran undiminished on
	 *  the other path.
	 *
	 *  Returns null when the read is unavailable; the caller decides how to
	 *  degrade, because the two callers degrade differently. */
	private async readServerDocState(
		noteId: string,
		path: string,
	): Promise<{ b64: string } | null> {
		const fetchState = this.crdtDocState;
		if (!fetchState || this.unsupportedFrames.has(DOC_STATE_FRAME)) return null;

		try {
			const state = await fetchState(noteId);
			// A success proves the frame is supported — clear any partial strike
			// count so one slow reply mid-import cannot accumulate toward a latch
			// across an otherwise healthy session.
			this.frameStrikes.delete(DOC_STATE_FRAME);
			return state;
		} catch (e) {
			const detail = errMsg(e, path);

			// The log states the OBSERVATION, not a diagnosis: an old backend and
			// a crashing channel are indistinguishable from here.
			if (this.strikeFrame(DOC_STATE_FRAME, detail)) {
				rlog().warn(
					"crdt",
					`crdt_doc_state unsupported ${SyncEngine.FRAME_UNSUPPORTED_LATCH}x — disabling ` +
						`room-free doc reads for this session. Either the backend predates the frame ` +
						`or the channel is crashing; both look like this from the client.`,
				);
			}

			rlog().warn("crdt", `crdt_doc_state failed for ${noteRef(path)}: ${detail}`);
			return null;
		}
	}

	/** Deliver this device's pending ops for ONE queued note without allocating
	 *  a server room (#1493) — the send-side twin of `convergeColdNoteRoomFree`.
	 *
	 *  The path it replaces is `socketConverge` -> `fireCrdtReHandshake`: reset +
	 *  enroll fires a STEP1, the server answers `[STEP2, server-STEP1]`, and the
	 *  client's reply to that second step carries the pending ops. That works,
	 *  and every one of those STEP1s routes through the backend's `ensure_room`,
	 *  so a durable-queue drain over a large vault asks for a room per note. Prod
	 *  measured 314 resident against a cap of 64 on a 1.4k-note sync.
	 *
	 *  `crdt_doc_update` carries the same ops as a plain Yjs update and the
	 *  server merges it into a doc owned by a short-lived applier, so no room is
	 *  left behind. It sends the doc's FULL state rather than a delta: without a
	 *  handshake we do not know the server's state vector, and a Yjs merge of
	 *  full state is idempotent — larger on the wire, never wrong.
	 *
	 *  Unlike the READ twin this needs NO `hasUndeliveredOps` precondition. That
	 *  gate exists because `crdt_doc_state` cannot carry anything upward; this
	 *  frame is the upward direction, so holding local work is the reason to use
	 *  it, not a reason to refuse.
	 *
	 *  Returns true only when the server ACKED the write — that ack is what
	 *  licenses the dequeue, exactly as an inbound frame licenses it on the room
	 *  path. ANY failure returns false and the caller re-handshakes; the room is
	 *  always CORRECT, just more expensive. */
	private async deliverQueuedOpsRoomFree(entry: {
		path: string;
		noteId?: string;
	}): Promise<boolean> {
		const noteId = entry.noteId;
		const send = this.crdtDocUpdate;
		if (!noteId || !send || this.unsupportedFrames.has(DOC_UPDATE_FRAME)) return false;
		// Capture the registry BEFORE the encode and refuse if it was swapped
		// underneath — the same fence `adoptServerLineage` takes, and it matters
		// MORE here for the reason `setCrdtPorts` gives: this is a WRITE.
		//
		// Every reassignment routes through the single `setCrdtPorts` site, so
		// one identity comparison covers all of them. What they are:
		//
		// - A VAULT / IDENTITY CHANGE, the dangerous one. The port's own guard
		//   cannot catch it because both sides of its comparison (channel vault,
		//   settings vault) read LIVE at call time, so once the switch completes
		//   they agree again and vault A's Yjs bytes land in vault B's note of
		//   the same id. note_ids are unique only WITHIN a vault.
		// - A DOWNGRADE TO THE LEGACY PATH: a disconnect BEFORE the `crdt:` join,
		//   or a join the server refuses — including a REJOIN refused after an
		//   earlier successful one, which force-resets `crdtEverJoined`. Both
		//   null the manager, and sending into one that is gone is not a
		//   delivery — the room handshake this falls back to re-resolves the doc.
		//
		// NOT a plain post-join socket drop. That deliberately RETAINS the
		// manager so edits keep accumulating in the Y.Doc and IndexedDB, and the
		// reconnect handshake carries them up. The fence must not fire there,
		// and does not, because `this.crdt` is untouched.
		const crdt = this.crdt;
		if (typeof crdt?.encodeStateAsUpdate !== "function") return false;

		let frame: string;
		let receipt: Uint8Array | undefined;
		try {
			// BEFORE the state, not after — see `encodeDeliveryReceipt`. An edit
			// landing between the two then makes the receipt under-claim (one
			// wasted room) instead of covering an op that never went.
			receipt = await crdt.encodeDeliveryReceipt?.(noteId);
			const state = await crdt.encodeStateAsUpdate(noteId);
			if (this.crdt !== crdt) return false;
			// A doc's full state carries its history and tombstones, so it can
			// dwarf the note's text. Same budget the genesis frame is held to
			// rather than putting an unbounded frame on an 8 MB socket — an
			// oversized note still delivers, it just pays for a room to do it.
			if (state.byteLength > MAX_CRDT_NOTE_BYTES) {
				rlog().anomaly("crdt", "roomfree_state_over_cap");
				return false;
			}
			// AN EMPTY DOC IS NOT A DELIVERY. A no-op update is acked happily, and
			// the ack is what dequeues the entry, so the queued edit would be
			// dropped as "delivered" having moved nothing. The handshake this
			// replaces would additionally have PULLED the server's copy, so the
			// fallback is strictly better here, not merely equivalent.
			//
			// The reachable cause is a note whose doc was never persisted:
			// `ensureEntrySync` MINTS an empty `Y.Doc` on a cache miss, which is
			// what a queue entry restored from `data.json` finds when IndexedDB
			// does not have its doc (a second machine, a cleared cache, storage
			// eviction). Not the other candidates — a destroyed doc throws out of
			// `assertAlive` into the catch below, an evicted one rehydrates from
			// IndexedDB, and `entry()` awaits `whenSynced`, so a half-finished
			// replay is not observable from here.
			//
			// Counter, not a log line: the trigger is a whole restored queue at
			// once, and one remote warn per note would flood the drain this
			// feature exists to make cheap. Same call the sibling caps make.
			if (state.byteLength <= EMPTY_YJS_UPDATE_BYTES) {
				rlog().anomaly("crdt", "roomfree_state_empty");
				return false;
			}
			frame = encodeUpdateFrame(state);
		} catch (e) {
			// Doc destroyed mid-encode, or an IndexedDB fault. The room path
			// re-resolves the doc itself, so let it try.
			devLog().log(
				"crdt",
				`room-free delivery: encode failed for ${entry.path} — ${errMsg(e)}`,
			);
			return false;
		}

		try {
			await send(noteId, frame);
			this.frameStrikes.delete(DOC_UPDATE_FRAME);
			// THE receipt (#1493). The ack proves the server holds everything the
			// receipt described — a SNAPSHOT, not a state vector, because a vector
			// cannot see deletions and the first attempt at this stranded them.
			// That is the one fact `synced` could not express for this
			// path — so without it the note reads as undelivered forever, refuses
			// the room-free READ on the next catch-up, and asks for the room this
			// frame just avoided. A drain of 1.4k notes took 0 rooms going up and
			// 1.4k coming back.
			if (receipt) crdt.markDelivered?.(noteId, receipt);
			// NOT `markSynced` here, however tempting. It does not set the
			// provider's `synced` flag; it fires `onSynced` ->
			// `commitCrdtConvergence`, which COMMITS a staged catch-up episode —
			// recording the note converged at a serverHash whose content was
			// never applied, after which every later catch-up compares equal
			// hashes and skips it. That is the deaf-note class, and it turned two
			// fan-out e2e tests red when tried. `convergeColdNoteRoomFree` may
			// call it because it APPLIED the server's state first; this path only
			// sent its own.
			//
			// `markDelivered` above IS that primitive: it records the upward half
			// WITHOUT the convergence commit, which is what lets the next catch-up
			// skip the room. It is deliberately not the same flag — see
			// `hasCurrentDeliveryReceipt`, which only the room-free read consults.
			return true;
		} catch (e) {
			this.noteDocUpdateFailure(e, entry.path);
			return false;
		}
	}

	/** Log + strike accounting for a failed `crdt_doc_update`, mirroring the
	 *  same two steps in `readServerDocState`. Which replies count toward the
	 *  latch is `strikeFrame`'s call, not this function's — that is the point of
	 *  the shared predicate. Without a latch, a backend predating the frame
	 *  makes every queued note pay a round trip before falling back, a slower
	 *  drain than not having the feature at all. */
	private noteDocUpdateFailure(e: unknown, path: string): void {
		const detail = errMsg(e, path);

		if (this.strikeFrame(DOC_UPDATE_FRAME, detail)) {
			rlog().warn(
				"crdt",
				`crdt_doc_update unsupported ${SyncEngine.FRAME_UNSUPPORTED_LATCH}x — disabling ` +
					`room-free queue delivery for this session and falling back to the room handshake.`,
			);
		}

		rlog().warn("queue", `Room-free delivery failed for ${noteRef(path)}: ${detail}`);
	}

	private async seedBodyAfterCreate(opts: {
		effectiveId: string;
		normalized: string;
		file: TFile;
		seeded: boolean;
		/** What the server did with our genesis frame.
		 *
		 *  `null` = the backend predates the field (#476). It does NOT mean "no
		 *  frame was sent": a bodyless create still gets a real outcome, because
		 *  the server reconciles its `:absent` seed result against the ROW before
		 *  replying, so a bodyless create onto a non-empty row answers `occupied`.
		 *
		 *  `undefined` is reachable only from a caller that omits the field (test
		 *  fakes, an older port shape). Handled identically to `null` — both fail
		 *  the `!== "absent"` gate, so both take the confirm-before-pushing route,
		 *  which is the conservative one. */
		genesisOutcome?: GenesisOutcome;
		/** `serverId === the id we asked for`. False means the server answered
		 *  under an id of its own choosing, so the bytes it stored are filed
		 *  under a lineage we have never seen. */
		sameId: boolean;
		genesisUpdate: Uint8Array | undefined;
		genesisContent: string | undefined;
		onHistoryResolved?: (effectiveIdHasHistory: boolean) => void;
	}): Promise<string | null> {
		if (!this.crdt) return null;
		const { effectiveId, normalized, file, seeded, sameId } = opts;

		const effectiveIdHasHistory =
			typeof this.crdt.hasAnyHistory === "function"
				? await this.crdt.hasAnyHistory(effectiveId)
				: true;
		opts.onHistoryResolved?.(effectiveIdHasHistory);

		// THE INVARIANT (#476): a note's body reaches the server exactly ONCE per
		// create. Writing the body into an EMPTY doc mints a brand-new lineage
		// with a fresh clientID; if the server already stored our genesis bytes,
		// that lineage is a RIVAL carrying identical text with no shared
		// identity. Yjs unions rivals rather than deduplicating them, so the body
		// doubles, the merge flushes to disk, and the next import reads the
		// doubled file and doubles it again. Measured: a 34 KB note reached
		// 4.9 MB with its 225 distinct lines repeated 144 times.
		//
		// `seeded === true` is the server's statement that it holds our bytes. So
		// the three states below are exhaustive, and only ONE of them may push:
		//
		//   seeded + empty doc  -> ADOPT the server's lineage (pull, never push)
		//   not seeded          -> the server has nothing; pushing is correct
		//   doc has history     -> a real lineage exists; routeModify's `lca`
		//                          makes it a minimal diff onto that lineage,
		//                          not a second one
		//
		// Expressing it as "which state are we in" rather than a conjunction of
		// four booleans is deliberate: the conjunction form let ANY false
		// condition fall through to a silent second transmission, and nothing
		// detected it — not a test, not an assertion, not a log.
		if (seeded && !effectiveIdHasHistory) {
			// Cheapest legal route: the server took OUR bytes under OUR id, so we
			// already hold exactly what it stored. No round trip needed.
			if (sameId && opts.genesisUpdate && opts.genesisContent !== undefined) {
				let preApplyDisk: string | null = null;
				try {
					preApplyDisk = await this.app.vault.cachedRead(file);
				} catch {
					// unreadable — proceed without drift protection
				}
				await this.crdt.applyRemoteUpdate(effectiveId, opts.genesisUpdate);
				let consumed: string | null = opts.genesisContent;
				// M1: `genesisContent` was frozen before the create round-trip, and
				// the apply above flushes it over disk. Anything that landed in that
				// window survives only in `preApplyDisk`. Merged back as a minimal
				// diff (the doc has history now). NO reread — it would read the
				// just-reverted disk and discard the drift.
				if (preApplyDisk !== null && preApplyDisk !== opts.genesisContent) {
					const merged = await this.crdt.applyLocalEdit(effectiveId, preApplyDisk);
					if (merged !== null) {
						consumed = merged;
						await this.flushFromCrdt(normalized, merged);
					}
				}
				return consumed;
			}

			// The server re-id'd us (#1409): it stored our body under a lineage we
			// do not have. Pushing again is exactly how the doubling happens, so
			// ADOPT its lineage instead.
			const adopted = await this.adoptServerLineage(effectiveId, normalized);
			if (adopted !== null) return adopted;

			// No way to adopt (old backend, rate limit, dropped socket). Pushing
			// here would double the body, so we deliberately do NOTHING: the
			// server already holds the content, and this note is now an ordinary
			// diverged COLD note that the catch-up receive path converges. Slower
			// than seeding, and the ONLY option that cannot corrupt.
			return await this.deferToServerLineage(
				normalized,
				file,
				`server seeded it under a different id and its state is unavailable`,
			);
		}

		// Past here we are about to transmit a body into a doc with NO history,
		// which mints a fresh lineage. That is only safe if the server truly
		// holds nothing. A doc that already carries history is fine either way —
		// `applyLocalEdit`'s `lca` diffs against it rather than minting a rival —
		// so history short-circuits the whole check.
		//
		// `occupied` was the remaining half of #476: the server declined our
		// genesis because the row already carried a DIFFERENT body (a concurrent
		// write landed inside the seed's write window, or a room owns the doc),
		// and the old `seeded: false` reported that identically to "the server
		// has nothing". We pushed, minted a rival lineage carrying the same text,
		// and Yjs unioned the two into the note twice over.
		//
		// A null outcome is an older backend that sends only `seeded` and so
		// cannot distinguish those. Rather than guess, ASK: adopting is a
		// monotonic merge that is harmless when the server is empty, and a
		// non-empty projection afterwards is direct evidence that pushing would
		// be a SECOND transmission.
		// ADOPT FIRST, THEN DIFF — never "adopt instead of pushing".
		//
		// An earlier revision returned the adopted text here and stopped. That
		// looked safe and silently DISCARDED the local body: when the server
		// holds a DIFFERENT body under our id (which is what `occupied` means),
		// stopping after the adopt means our content never reaches the server and
		// the adopted text is stamped as the baseline over it. The same shape hit
		// the ADOPT path, where it overwrote a brand-new local note with another
		// note's content.
		//
		// Adopting is not an alternative to transmitting, it is the PRECONDITION
		// for transmitting safely. Once the server's lineage is applied the doc
		// has history, so `applyLocalEdit` takes its `lca` path and emits a
		// minimal diff onto the shared lineage — not the rival lineage whose YATA
		// union is #476. So: adopt to acquire identity, then push as a diff.
		//
		// The only outcome that skips the push is `stored`, handled above: the
		// server already holds exactly our bytes, so there is nothing to send.
		const known = opts.genesisOutcome;
		if (!effectiveIdHasHistory && known !== "absent") {
			const adopted = await this.adoptServerLineage(effectiveId, normalized);

			// Adopt failed. What to do depends on whether the server ASSERTED it
			// holds content, and the two answers are opposite:
			//
			//   occupied  the server said so. Pushing mints a rival, so defer.
			//   null      we could not verify (a backend predating both `genesis`
			//             and `crdt_doc_state` — they ship together, so a null
			//             outcome guarantees the read is unavailable too). Here
			//             deferring is NOT the safe pole: nothing else will ever
			//             fill this note, so it stays blank forever on every
			//             device. A possible doubling beats a certain blank.
			if (adopted === null) {
				if (known === "occupied") {
					return await this.deferToServerLineage(
						normalized,
						file,
						`server holds a body for it and its lineage is unavailable`,
					);
				}

				rlog().warn(
					"crdt",
					`create: cannot verify server state for ${noteRef(normalized)} (backend predates ` +
						`crdt_doc_state) — transmitting, which risks the pre-#476 doubling`,
				);
			}
			// Adopt succeeded. Fall through: the doc now has history, so the push
			// below is an `lca` diff. This is deliberate even when `adopted` is
			// empty — an empty projection means the server is genuinely blank and
			// our body is the only copy.
		}

		// Either the server holds nothing (`absent`), or we now share its lineage
		// and this is a minimal diff onto it.
		return await routeModify(
			{
				crdtEligible: true,
				noteId: effectiveId,
				readContent: () => this.app.vault.cachedRead(file),
			},
			this.crdt,
			MAX_CRDT_NOTE_BYTES,
		);
	}

	/** Stage the convergence episode a socket re-handshake must commit, then
	 *  fire the re-handshake. The {stage, converge} pair was written out
	 *  five times; a field added to one copy and not another silently forked
	 *  the commit contract. */
	private stageAndConverge(
		noteId: string,
		path: string,
		serverHash: string,
		content: string | null,
		version?: number,
		seq?: number,
	): void {
		this.stageConvergence(noteId, path, serverHash, content, version, seq);
		this.socketConverge(path, noteId);
	}

	/** The stage half of `stageAndConverge`, split out for the room-FREE
	 *  delivery path (#1409): `convergeColdNoteRoomFree` stages the SAME
	 *  episode and then delivers over `crdt_doc_state` instead of a room
	 *  handshake. Kept as one writer so a field added here can't be missed by
	 *  one of the two delivery paths — the exact fork this helper's own
	 *  history is about. */
	private stageConvergence(
		noteId: string,
		path: string,
		serverHash: string,
		content: string | null,
		version?: number,
		seq?: number,
	): void {
		this.pendingConvergence.set(noteId, { path, serverHash, content, version, seq });
	}

	/** Is `normalized` a 0-byte placeholder THIS device wrote and never
	 *  converged — the only state in which filling it from a feed snapshot is
	 *  legal (#477)?
	 *
	 *  An empty file is NOT on its own a license to write. Three ways it lies,
	 *  each of which this predicate has to exclude:
	 *
	 *  1. **The emptiness IS the converged state.** A remote clear applied
	 *     through `flushFromCrdt` calls `recordCrdtBaseline("")`, so
	 *     `stored.hash === fnv1a("")` and `localDiverged` reads FALSE — the
	 *     drift-copy escape hatch never fires. A later checkpoint-lagged row
	 *     carrying the PRE-clear body would then resurrect deleted content.
	 *     `crdtHead` separates the two: a converged note carries a REAL head
	 *     recorded by the apply, while a discovery placeholder carries only the
	 *     `CRDT_HEAD_CREATED` sentinel — "the server has this note, we have
	 *     never applied its ops."
	 *  2. **The doc holds local work.** `hasUndeliveredOps` is the same
	 *     precondition `convergeColdNoteRoomFree` uses, and for the same reason:
	 *     a snapshot write, like a `crdt_doc_state` read, cannot carry anything
	 *     upward. A note with undelivered ops must take the bidirectional room.
	 *     (Conservative by design — a never-handshaken doc reads as undelivered
	 *     on registries that track it, and an absent probe answers "yes".)
	 *  3. **The cache invented the emptiness.** `localNow` comes from
	 *     `cachedRead`, and a `cachedRead` right after a create is exactly where
	 *     Obsidian's cache lies. Proving the 0 bytes needed `adapter.read` during
	 *     the #477 investigation; a whole-file overwrite deserves the same proof.
	 *     Any read failure answers false — the converge is always CORRECT, just
	 *     more expensive.
	 *
	 *  What survives all three is a file this device created empty from a
	 *  content-less create row and has never merged a single server op into. */
	private async isUnconvergedEmptyPlaceholder(
		noteId: string,
		normalized: string,
		localNow: string | null,
	): Promise<boolean> {
		if (localNow !== "") return false;
		if (this.getCrdtHead(normalized) !== CRDT_HEAD_CREATED) return false;
		if (typeof this.crdt?.hasUndeliveredOps !== "function") return false;
		if (this.crdt.hasUndeliveredOps(noteId)) return false;
		try {
			return (await this.app.vault.adapter.read(normalized)) === "";
		} catch (e) {
			rlog().warn(
				"pull",
				`empty-placeholder check could not read ${noteRef(normalized)} — converging instead: ${errMsg(e, normalized)}`,
			);
			return false;
		}
	}

	/** Converge a diverged COLD note (nobody has it open) without allocating a
	 *  server room — #1409's open half.
	 *
	 *  The room-based path this replaces is `stageAndConverge`: stage the
	 *  episode, fire a STEP1, let STEP2 bring the ops back, and let
	 *  `commitCrdtConvergence` record the stage once an inbound frame proves
	 *  the round-trip. Every one of those STEP1s routed through the backend's
	 *  `ensure_room`, so a bulk first sync allocated a room per cold note that
	 *  fell through to catch-up.
	 *
	 *  `crdt_doc_state` returns the same Yjs state off the persisted snapshot +
	 *  update-log tail with no room. Applying it is the same monotonic merge
	 *  STEP2's ops would have been, so a checkpoint-lagged reply converges
	 *  without reverting a fresher local edit — the property that makes this a
	 *  legal substitute, and the one the feed's plaintext `content` lacks.
	 *
	 *  ONLY legal when this device holds no undelivered ops for the note — see
	 *  the gate below. The frame is a read; it cannot carry anything upward, so
	 *  a note with local work must take the room.
	 *
	 *  ANY failure falls back to the room handshake. An old backend rejects the
	 *  unknown frame, a rate limit rejects it, a dropped socket rejects it — in
	 *  all three the room is still the correct, more expensive answer.
	 *  Convergence is the invariant; the room saving is the optimization. */
	private async convergeColdNoteRoomFree(
		noteId: string,
		normalized: string,
		change: NoteChange,
		content: string | undefined,
		serverHash: string,
	): Promise<void> {
		// Stage BEFORE either delivery attempt: both the room-free apply and the
		// fallback handshake commit through this same staged episode, and a
		// fresh content_hash overwrites any prior stage (a new episode, never a
		// stale commit of superseded server content).
		this.stageConvergence(
			noteId,
			normalized,
			serverHash,
			content ?? null,
			change.version,
			change.seq,
		);

		// THE PRECONDITION (adversarial review): `crdt_doc_state` is a READ. The
		// room handshake it replaces is BIDIRECTIONAL — the server answers a
		// syncStep1 with [syncStep2, syncStep1] and the client's reply to that
		// second step1 IS the upload half. So this path can only converge a note
		// the client has nothing to say about.
		//
		// Taken when the client DOES hold undelivered ops, it downloads, marks
		// the note synced, and the local ops are never transmitted: complete on
		// this device, blank everywhere else, and stamped as in-sync so every
		// later catch-up compares equal hashes and skips it. Permanently.
		//
		// `hasUndeliveredOps` is the conservative question (a never-handshook doc
		// reads as undelivered), which is the right bias here: the room is always
		// CORRECT, just more expensive. Convergence is the invariant; saving the
		// room is the optimization.
		// ...or a room-free delivery already put those ops on the server (#1493).
		// Consulted ONLY here: `hasUndeliveredOps` also gates two DESTRUCTIVE
		// paths (the drift keep-both copy, the empty-placeholder overwrite) where
		// it means "would tearing this down destroy something", which a receipt
		// does not answer. Relaxing it here can cost a wasted room; relaxing it
		// there would cost a file.
		const delivered = this.crdt?.hasCurrentDeliveryReceipt?.(noteId) === true;
		if (this.crdt && (!this.crdt.hasUndeliveredOps(noteId) || delivered)) {
			// Routed through the shared reader so this caller both CHECKS and
			// FEEDS the capability latch. It used to do neither, so against an
			// older backend every diverged cold note paid a full request timeout
			// before falling back — the exact pathology the latch exists for,
			// running on the higher-volume path (#1409 review).
			const state = await this.readServerDocState(noteId, change.path);
			try {
				if (state === null) throw new Error("crdt_doc_state unavailable");
				// Flushes disk on the merge and AWAITS that write, so a failed
				// write rejects here rather than being reported as converged.
				// A REFUSED apply (note removed, doc destroyed mid-hydration)
				// resolves without merging anything, and `markSynced` below would
				// then record a note as converged that holds none of the server's
				// state — after which every catch-up compares equal hashes and
				// skips it, permanently. Fall back to the room.
				if (!(await this.crdt.applyRemoteUpdate(noteId, fromB64(state.b64)))) {
					throw new Error("registry refused the doc state (note removed or destroyed)");
				}
				// `onSynced` fires ONLY from NoteProvider.handleFrame on an
				// inbound syncStep2 — an applyRemoteUpdate does not fire it. So
				// the staged episode has to be driven to commit explicitly, or
				// serverHash is never recorded, the note stays diverged, and
				// every later catch-up re-fetches it forever. `markSynced` is
				// the registry's manual trigger for exactly this.
				//
				// Triggering it DOES record convergence — `commitCrdtConvergence`
				// has no text-verify gate (it was removed deliberately: a
				// cosmetic projection difference wedged the stage forever). What
				// justifies recording is the same thing that justified it after
				// syncStep2: this reply is the server's FULL state, snapshot
				// UNION update-log tail (`CrdtTransport.read_delta` with a nil
				// state vector), so the post-merge doc provably holds everything
				// the server held at read time. That is the same reconciliation
				// strength STEP2 carries, off the same two sources — not a
				// weaker proof standing in for it.
				this.crdt.markSynced(noteId);
				rlog().info(
					"pull",
					`CRDT catch-up: diverged cold note converged room-free ${noteRef(change.path)}`,
				);
				return;
			} catch (e) {
				rlog().warn(
					"pull",
					`CRDT catch-up: room-free converge failed for ${noteRef(change.path)}, ` +
						`falling back to socket re-handshake: ${errMsg(e, change.path)}`,
				);
			}
		}

		rlog().warn(
			"pull",
			`CRDT catch-up: diverged cold note, socket re-handshake ${noteRef(change.path)}`,
		);
		this.socketConverge(normalized, noteId);
	}

	/** The full local cleanup for a remotely-deleted file: trash it (marked so
	 *  this device's own vault-delete event is echo-suppressed), prune any
	 *  now-empty parent folders, and drop its sync/merge-base state. This
	 *  four-line block existed verbatim at three sites plus partial variants.
	 *  `dropBase` is false only for attachments, which have no merge base. */
	private async applyRemoteRemoval(
		file: TAbstractFile,
		opts?: { dropBase?: boolean },
	): Promise<void> {
		const normalized = normalizePath(file.path);
		await this.trashRemotelyDeleted(file);
		await this.removeEmptyFolders(normalized);
		this.dropPath(normalized, opts);
	}

	/** Injected-clock sleep: tests advance time instead of spending it. The
	 *  inline window.setTimeout promise this replaces bypassed the injected
	 *  TimeProvider at three sites. */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => this.time.setTimeout(resolve, ms));
	}

	/** The vault a queue entry belongs to: its own stamp, else the current
	 *  vault (pre-stamp entries), else undefined. Was inlined 5x in the flush
	 *  path. */
	private entryVaultId(entry: { vaultId?: string }): string | undefined {
		return entry.vaultId ?? this.settings.vaultId ?? undefined;
	}

	/** Close a note's CRDT room: destroy the doc (the registry clears its
	 *  enrollment at the destroy choke point) and reset the enrollment port,
	 *  which is a separate object only in test harnesses. This pair was
	 *  hand-written at 6 call sites; a missed pair left a tombstoned id
	 *  enrolled forever. */
	private async teardownCrdtDoc(noteId: string): Promise<void> {
		await this.crdt?.removeDoc(noteId);
		this.crdtEnrollment?.reset(noteId);
	}

	/** CRDT-eligible = markdown OR canvas: both sync over the Yjs transport
	 *  (the manager's docKind picks the per-type schema). Binary/attachment
	 *  types are NOT eligible and stay on the REST/attachment path. */
	isCrdtEligible(file: TAbstractFile): boolean {
		return file instanceof TFile && crdtEligiblePath(file.path);
	}

	/** Path-string variant of isCrdtEligible for the pull/apply path, which works
	 *  with normalized paths (from a NoteChange), not TFile handles. */
	isCrdtEligiblePath(path: string): boolean {
		return crdtEligiblePath(path);
	}

	/** True for a canvas note path. Canvas is CRDT but STRUCTURAL: its authoritative
	 *  content lives in the Yjs doc, never notes.content (which the backend keeps
	 *  vestigial for canvas), so the pull path must converge it over the Yjs
	 *  handshake, never by writing the seq-feed `content`. */
	private isCanvasPath(path: string): boolean {
		return canvasPath(path);
	}

	/** Check if a file should be synced (markdown, canvas, or binary attachment). */
	isSyncable(file: TAbstractFile): file is TFile {
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
		if (this.syncBlocked) {
			devLog().log("sync-blocked", "handleModify short-circuited — gate closed");
			// A closed gate is silent everywhere except a status-bar label, and a
			// user who does not happen to look there reads "my edits do nothing"
			// as a dead sync engine. It cost hours on 2026-08-29. Announce it on
			// the first EDIT — the moment the user's intent meets the gate — not
			// on the close, which happens during setup when they are not editing.
			this.reportBlockedEdit();
			return;
		}
		if (!this.ready) return;
		if (!this.isSyncable(file)) return;
		if (this.shouldIgnore(file.path)) return;
		// During pull, vault events are usually echoes from sync writes.
		// But real user edits can happen too — queue them for post-pull push.
		if (this.pulling) {
			this.pendingPostPullPushes.add(file.path);
			this.schedulePostPullDrain();
			return;
		}
		// Suppress echoes from flushFromCrdt (remote CRDT update → disk write).
		// Must NOT key off recentlyPushed: that set is also populated after every
		// legacy push, so checking it here would drop real user edits made within
		// the post-push cooldown (e.g. a conflicting local edit), defeating
		// conflict detection on the next pull.
		//
		// For CRDT-managed markdown this time-window guard is BOTH unnecessary and
		// harmful: the echo of a flush is naturally a no-op (routeModify →
		// applyLocalEdit re-applies identical content, diffIntoYText yields zero
		// ops, nothing is re-transmitted), while a REAL edit made within the window
		// — e.g. editing a note the moment after it was discovered/flushed — would
		// be wrongly dropped here and never reach the CRDT path. So only apply the
		// guard off the CRDT path (legacy writes, attachments).
		const crdtManaged = !!this.crdt && this.isCrdtEligible(file);
		if (!crdtManaged && this.files.has(file.path, "flushed")) {
			rlog().info(
				"sync",
				`Modify echo skip (recently flushed from CRDT): ${noteRef(file.path)}`,
			);
			return;
		}

		// Editor-owns-the-file gate (Relay's active-vs-idle model): if the note has
		// a live editor binding, that binding already streamed this edit into the
		// Y.Text per keystroke. Obsidian's autosave disk write is just local
		// persistence; re-feeding it through routeModify -> applyLocalEdit would
		// diff the whole file back into the doc every ~2s and churn it (the
		// delete/insert flicker). Skip the disk-driven CRDT route while bound. The
		// disk path still serves closed notes, reading-view-only notes, and
		// external edits (none of which are live-bound).
		if (crdtManaged && this.isLiveBound(file.path)) {
			// ...but the baseline must still track disk. Skipping the push path also
			// skips every syncState write, so the recorded hash would freeze at
			// whatever the last REMOTE flush wrote and drift further with every
			// autosave. Downstream that stale baseline is read as "un-synced local
			// drift" by needsColdReconcile, which makes a delete of an opened note
			// leave a spurious "(conflict <stamp>)" copy, and makes a later
			// cold-start adopt keep-both a copy of content that was never in
			// conflict. The editor's content IS in the Y.Doc, so recording it here
			// is the truthful baseline, not an optimistic one.
			if (file instanceof TFile) void this.recordLiveBoundBaseline(file);
			// ...and the FRONTMATTER still has to be ingested. The skip above is
			// right about the body (the binding forwards keystrokes into the
			// Y.Text) and wrong about frontmatter, which the binding explicitly
			// drops — `classifyEditSpan` returns "frontmatter" and the edit is not
			// forwarded. Between the two, frontmatter typed into an OPEN note
			// reached the doc by no route at all: #483 defect 1, confirmed by e2e
			// (obsidian -> web passes with the note closed, fails with it open).
			//
			// Narrow on purpose. `seedFrontmatterInto` never touches the body, so
			// this cannot reintroduce the whole-file re-diff churn the skip exists
			// to prevent, and it carries the same unparseable guard — which matters
			// here, because this runs on every autosave while the user is still
			// mid-keystroke.
			if (file instanceof TFile && this.crdt) {
				const fmId = this.noteIdMap?.get(file.path) ?? null;
				if (fmId) {
					void this.app.vault
						.cachedRead(file)
						.then((disk) => this.crdt?.ingestFrontmatter(fmId, disk))
						.catch((e) =>
							rlog().warn(
								"crdt",
								`live-bound frontmatter ingest failed for ${noteRef(file.path)}: ${errMsg(e, file.path)}`,
							),
						);
				}
			}
			return;
		}

		// Capture the path NOW. Obsidian mutates the SAME TFile in place on a
		// rename, so reading `file.path` inside the callback resolves to the NEW
		// path — deleting a key that was never set and stranding the original
		// forever. That leak surfaced as a status bar permanently reporting a
		// phantom "1 pending" (pending == debounceTimers.size).
		const armedPath = file.path;

		// Clear existing debounce timer for this file
		const existing = this.debounceTimers.get(armedPath);
		if (existing) this.time.clearTimeout(existing);

		const timer = this.time.setTimeout(() => {
			this.debounceTimers.delete(armedPath);
			// Repaint HERE, not via pushFile: it has early returns above its first
			// emitStatus(), and a persistently-skipped file (an attachment parked
			// under a plan issue) would leave the bar painting the stale count
			// forever — nothing polls it.
			this.emitStatus();
			// Re-check the gate AT FIRE TIME. `handleModify` checked it when the
			// timer was armed, but the gate can close during the debounce window —
			// a vault switch, a re-consent prompt, a dead-vault heal — and
			// `pushFile` has no gate of its own. The armed timer then wrote into
			// whatever vault is active when it fired, which after a switch is a
			// DIFFERENT vault the user has not consented to sync yet.
			//
			// Dropping the push does not drop the edit: the file's disk content no
			// longer matches its recorded baseline, so the full sync that runs when
			// the gate reopens picks it up. That is also why `debounceTimers` stays
			// destroy-only in the sweep registry — the pending edit is real, it just
			// must not be delivered by this timer.
			if (this.syncBlocked) {
				devLog().log(
					"sync-blocked",
					`debounced push dropped — gate closed during the window: ${armedPath}`,
				);
				return;
			}
			void this.pushFile(file);
		}, this.settings.debounceMs);

		this.debounceTimers.set(armedPath, timer);
		this.emitStatus();
	}

	/** When true, vault delete events are suppressed (used during local wipe). */
	suppressDeletes = false;

	/** Per-path count of trashes THIS ENGINE performed (wipe pass, orphan
	 *  sweep, remote-delete apply, recently_deleted convergence). Durable —
	 *  each trash increments, each vault delete event for the path consumes
	 *  one — never expired by a timer and never cleared on recreate. The 5s
	 *  `remotelyDeleted` TTL was the 2026-08-12 data-loss seam (#416): a mass
	 *  trash outlives the TTL and the late delete events push as user deletes.
	 *  Clear-on-recreate was the post-merge review's finding 1: it let the
	 *  late echo of a trash land AFTER a pull recreated the path and push a
	 *  delete against the FRESH note. Counters keep every trash matched 1:1
	 *  with its own event regardless of interleaving; the only leak is a
	 *  crash that eats the event, costing one echo-skipped (resurrectable)
	 *  delete at that path later — the cheap failure. */
	/** Vault-scoped: path-keyed, so a counter stranded in the OLD vault (event
	 *  eaten by a throw or a closed gate) must not consume a same-path delete in
	 *  the NEW one (#419 pre-merge review finding 4). */
	private readonly engineTrashedPaths = this.track(
		["vault", "destroy"],
		new Map<string, number>(),
	);

	private consumeEngineTrash(path: string): boolean {
		const n = this.engineTrashedPaths.get(path) ?? 0;
		if (n <= 0) return false;
		if (n === 1) this.engineTrashedPaths.delete(path);
		else this.engineTrashedPaths.set(path, n - 1);
		return true;
	}

	/** Handle a vault delete event. */
	async handleDelete(file: TAbstractFile): Promise<void> {
		if (this.syncBlocked) {
			devLog().log("sync-blocked", "handleDelete short-circuited — gate closed");
			// Same reasoning as handleModify: a delete the user believes synced
			// and which never left the device is worse than a silent edit, not
			// better. Shares the once-per-closure latch, so a modify+delete pair
			// still produces one notice.
			this.reportBlockedEdit();
			return;
		}
		if (!this.ready) return;
		// NOTE: no suppressDeletes early-return here (post-merge review finding
		// 4): every wipe-pass trash is in engineTrashedPaths, and consuming the
		// record DURING the suppression window keeps the counter matched 1:1
		// with its event. The early return stranded permanent entries that later
		// swallowed genuine deletes at the same path.
		if (!this.isSyncable(file)) return;
		if (this.shouldIgnore(file.path)) return;

		const isBinary = this.isBinaryFile(file);

		// Cancel any pending push for this path FIRST — even for echo events.
		// A timer armed for the trashed file must die with it; surviving the
		// early-return below, it would fire against whatever now occupies the
		// path and push partial mid-materialize content (round-3 finding 3).
		const existing = this.debounceTimers.get(file.path);
		if (existing) {
			this.time.clearTimeout(existing);
			this.debounceTimers.delete(file.path);
		}

		// STALE-ECHO GUARD (#419 reviews, rounds 2+3): a live file at this path
		// right now means this delete event is for a REPLACED file. Running the
		// bookkeeping below would unmap, evidence-drop, and tombstone the FRESH
		// note, so we stop here either way — but the two causes are logged
		// apart: consuming an engine-trash record (or live echo marker) is the
		// expected trash→recreate→late-echo shape; NO echo evidence means an
		// external flow (git checkout, another sync tool) deleted-and-replaced
		// the path, and skipping keeps the safe direction (the old server row
		// survives and resurrects/conflicts on pull, vs. path/id-ambiguous
		// bookkeeping that could delete the REPLACEMENT). The distinct warn is
		// the tripwire if that class turns real in the field.
		if (this.app.vault.getFileByPath(file.path)) {
			const wasEcho =
				this.consumeEngineTrash(file.path) || this.files.has(file.path, "remotelyDeleted");
			this.files.clearMarker(file.path, "remotelyDeleted");
			if (wasEcho) {
				rlog().info(
					"vault",
					`Delete echo for replaced path — skipped: ${noteRef(file.path)}`,
				);
			} else {
				rlog().warn(
					"vault",
					`Delete event for reoccupied path SKIPPED (no echo evidence): ${noteRef(file.path)}`,
				);
			}
			return;
		}

		// RENAME OLD LEG. The engine trashed this path to follow a remote rename;
		// the note is alive at its new path. Everything below is keyed by note_id
		// — releasing the claim, the delete-wins tombstone, the CRDT teardown —
		// and every one of them would be aimed at a LIVING note. Drop only the
		// path-scoped bookkeeping and stop.
		//
		// Placed above the id resolution deliberately: the map is mid-relocation
		// here, so whether `get(oldPath)` still answers the id is a race, and a
		// guard that depends on the answer is a guard that works some of the time.
		if (this.files.has(file.path, "renamedAway")) {
			this.files.clearMarker(file.path, "renamedAway");
			this.files.clearMarker(file.path, "remotelyDeleted");
			this.consumeEngineTrash(file.path);
			// `dropBase: false` -- the base was carried to the note's new path by
			// the old-leg branch above. Dropping it here would destroy it after the
			// carry, which is worse than never carrying it at all.
			this.dropPath(normalizePath(file.path), { dropBase: false });
			rlog().info(
				"vault",
				`Delete is rename old-leg — id-keyed state preserved: ${noteRef(file.path)}`,
			);
			return;
		}

		// Resolve the note_id BEFORE clearing the map (removeDoc/reset below need
		// it to tear down the right CRDT doc, keyed by id not path).
		const crdtNoteId = !isBinary ? (this.noteIdMap?.get(file.path) ?? null) : null;

		// Clear the file's note_id mapping — the vault file is genuinely gone,
		// so a note later recreated at this path must mint a fresh id rather
		// than resurrecting the deleted note's (Task 5). Attachments have no
		// entries in this map (path -> note_id only), so gated on !isBinary.
		// `release`, not `delete`: this is the one caller that genuinely means "the
		// note is gone", so the claim has to come out of the shared index too. A
		// local-only forget left the committed entry standing, so the id was erased
		// from data.json but survived in the doc — and after a restart (or on any
		// other device, immediately) a file recreated at this path adopted the
		// deleted note's id, resurrecting the lineage Task 5 exists to bury.
		if (!isBinary) {
			this.noteIdMap?.release(file.path);
		}

		// Drop the deleted path's sync-state entry (notes AND attachments): its
		// recorded content hash is now stale, and left behind it echo-suppresses
		// a later create at the same path whose content hashes the same, so the
		// recreated file's push is skipped and it never reaches the server.
		// The merge base goes WITH it. The base is the full text of the note, and
		// keeping it after a delete meant the body of a note the user deleted
		// (and emptied from trash) stayed in sync-bases.json inside .obsidian/ —
		// a directory people commit to git, sync through iCloud, and zip into
		// bug reports — until LRU eviction happened to reach it at 50MB. It also
		// never made sense on its own terms: the line above drops syncState here
		// precisely BECAUSE stale bookkeeping at a recreated path causes bugs,
		// and a stale base is the same hazard with a copy of the content
		// attached. A recreate at this path has no common ancestor to merge
		// against anyway.
		const hadSyncEvidence = this.syncState.has(normalizePath(file.path));
		this.dropPath(normalizePath(file.path));

		// This trash APPLIED a remote change (trashRemotelyDeleted marked it):
		// the server already knows. Never push the DELETE back — path-keyed and
		// CAS-less, it lands after the origin device recreates the path
		// (replace-remote wipe→re-push, delete→recreate) and tombstones the
		// FRESH note. Local bookkeeping above still ran; mirror the CRDT
		// teardown the push path would have done and stop.
		// Consume BEFORE the || — inside the 5s marker window the short-circuit
		// would strand the counter entry, and a stranded entry later swallows a
		// genuine delete at the path (the wipe-window leak, review finding 4).
		const wasEngineTrash = this.consumeEngineTrash(file.path);
		if (this.files.has(file.path, "remotelyDeleted") || wasEngineTrash) {
			this.files.clearMarker(file.path, "remotelyDeleted");
			// NO TOMBSTONE HERE. This branch fires for a delete the SERVER already
			// applied and we are mirroring to disk. The id-keyed tombstone exists
			// for the opposite case (below): a delete THIS device originated, whose
			// round trip a peer's in-flight frame could undo. Once the server owns
			// the decision, a later server frame for the same id is not a
			// resurrection to suppress — it is newer truth to honour, and the only
			// frame that carries it is the one this guard was silencing.
			//
			// A rename is broadcast as two frames (new path upsert + old path
			// delete). Tombstoning off the delete leg muted the note the rename
			// had just moved: 60s of `fan-out skip (recent local delete)` and
			// `op-replay skip`, with `teardownCrdtDoc` having destroyed the doc
			// underneath the open editor (`NoteDestroyedError`). The user-visible
			// bug is "the rename lands, then typing stops syncing" — self-healing
			// only on reload or when the window lapses. Reported 2026-08-18.
			//
			// Delete-wins (backend #970) is unaffected: it is about OUR delete
			// racing a peer, and that path still tombstones. A genuine remote
			// delete needs no local tombstone — nothing will re-announce a note
			// the server has removed, and if the server DOES re-announce it, the
			// note is alive and we want it back.
			//
			// The doc teardown stays: the file is gone from disk, so the room
			// should not stay resident. Re-enrolment rebuilds it from the server,
			// which is exactly what the tombstone used to prevent.
			rlog().info("vault", `Delete echo skip (remote-applied): ${noteRef(file.path)}`);
			if (this.isCrdtEligible(file) && crdtNoteId) {
				await this.teardownCrdtDoc(crdtNoteId);
			}
			return;
		}

		// EVIDENCE RULE (#416): a delete may be pushed ONLY for a path this
		// engine recorded sync evidence for. No syncState entry = we never
		// completed a sync of this path = nothing of the user's to delete
		// server-side; pushing anyway is how the 2026-08-12 incident turned a
		// client-side bookkeeping hole into 39 prod tombstones. Cost of a
		// false refusal is benign resurrection on the next pull; cost of a
		// false push is data loss. Local bookkeeping above already ran.
		if (!hadSyncEvidence) {
			// Exception: a crdt_create for this id still PENDING in the durable op
			// queue means the server may be about to learn the note — enqueue the
			// delete so the queue's docId coalescing supersedes the create (the
			// pre-fence test_10 semantics). Harmless even if the create already
			// fired: a delete for a never-evidenced id either supersedes in-queue
			// or terminally no-ops server-side. Without this, a create-then-delete
			// note resurrects when the queued create fires (review finding 5).
			if (crdtNoteId && this.crdtHasPendingOp?.(crdtNoteId)) {
				this.markRecentlyDeleted(crdtNoteId, file.path);
				this.crdtEnqueue?.({ kind: "delete", docId: crdtNoteId, path: file.path });
				if (this.isCrdtEligible(file)) await this.teardownCrdtDoc(crdtNoteId);
				rlog().info("push", `Delete superseded pending create: ${noteRef(file.path)}`);
				return;
			}
			// Pure refusal: deliberately NO markRecentlyDeleted — the documented
			// remedy for a wrong refusal is next-pull resurrection, and the
			// delete-wins tombstone would block exactly that for 60s (finding 7).
			rlog().warn("push", `Delete push REFUSED (no sync evidence): ${noteRef(file.path)}`);
			if (this.isCrdtEligible(file) && crdtNoteId) {
				await this.teardownCrdtDoc(crdtNoteId);
			}
			return;
		}

		// Tombstone the id BEFORE clearing the mapping and issuing the delete, so
		// a racing catch-up head map or late fan-out cannot resurrect it.
		if (crdtNoteId) this.markRecentlyDeleted(crdtNoteId, file.path);

		try {
			if (isBinary) {
				await this.api.deleteAttachment(file.path); // attachments stay REST
				this.goOnline();
			} else if (this.isCrdtEligible(file)) {
				// CRDT-sole delete path (markdown AND canvas since #306; REST removed).
				// With a resolvable note_id, enqueue a durable crdt_delete: the queue
				// holds it until the crdt: topic is joined and retries transient
				// failures. Enqueue never throws, so the CRDT teardown below always
				// runs, and there is no goOnline() here — a local durable hand-off, not
				// a network round-trip. With NO note_id the note was never synced
				// remotely, so there is nothing to delete on the server: do nothing
				// rather than fall back to REST.
				if (crdtNoteId) {
					this.crdtEnqueue?.({ kind: "delete", docId: crdtNoteId, path: file.path });
				}
			} else {
				// Defensive fallback: no non-binary syncable type is CRDT-ineligible
				// today (md + canvas both ride CRDT), so this is unreachable for
				// current syncable text — kept only so a future REST-only note type
				// still deletes cleanly.
				await this.api.deleteNote(file.path);
				this.goOnline();
			}
			// Tear down the CRDT doc so a note recreated at the same path starts
			// fresh — no ghost lineage that would resurrect stale content (P1-3).
			// Gate on CRDT-eligibility (md OR canvas since #306, not !isBinary) so
			// attachments never hit removeDoc. Also gate on a known id — nothing to
			// tear down if this note never had a CRDT room.
			if (this.isCrdtEligible(file) && crdtNoteId) {
				await this.teardownCrdtDoc(crdtNoteId);
			}
		} catch (e) {
			// 404 means already deleted — treat as success; still tear down CRDT.
			if (isHttpStatus(e, 404)) {
				this.goOnline();
				if (this.isCrdtEligible(file) && crdtNoteId) {
					await this.teardownCrdtDoc(crdtNoteId);
				}
				return;
			}
			// biome-ignore lint/suspicious/noConsole: error boundary
			console.error("Engram Sync: failed to delete %s", file.path, e);
			rlog().error(
				"push",
				`Delete failed (queued): ${noteRef(file.path)} | ${errMsg(e, file.path)}`,
			);
			await this.enqueueChange({
				path: file.path,
				action: "delete",
				kind: isBinary ? "attachment" : "note",
				timestamp: Date.now(),
				vaultId: this.settings.vaultId ?? undefined,
				// This branch is only reachable past the evidence rule — stamp it
				// so the queue drain can tell fenced deletes from legacy/pre-fence
				// entries it must drop (#416 review finding 0).
				evidenced: true,
			});
			this.maybeGoOffline(e);
		}
	}

	/** Handle a vault rename event. */
	async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (this.syncBlocked) {
			devLog().log("sync-blocked", "handleRename short-circuited — gate closed");
			return;
		}
		if (!this.ready) return;
		if (!this.isSyncable(file)) return;

		// ECHO GUARD: this rename is the engine's own, applied to follow a remote
		// peer's rename (`moveIfIdRelocated`). Obsidian cannot tell that move from
		// a user drag — it fires the same vault event — so without this the move
		// is pushed back as a fresh rename, and the two devices trade renames.
		// The id map, base and sync-state were all re-keyed by the mover before
		// the rename was applied, so there is nothing left to do here.
		if (this.files.has(normalizePath(oldPath), "remotelyRenamed")) {
			this.files.clearMarker(normalizePath(oldPath), "remotelyRenamed");
			this.files.clearMarker(normalizePath(file.path), "remotelyRenamed");
			rlog().info(
				"vault",
				`Rename echo suppressed (engine applied a remote rename): ${noteRef(oldPath)} -> ${noteRef(file.path)}`,
			);
			return;
		}

		const isBinary = this.isBinaryFile(file);

		// Cancel any push still armed under the OLD path. Capturing armedPath at
		// arm time stops it leaking the map entry, but a surviving timer is still
		// wrong: handleDelete cancels by CURRENT path so it can no longer reach
		// this one (rename-then-delete inside the window pushes a file the user
		// just deleted), and it fires without the shouldIgnore(file.path) guard
		// applied to the push below (renaming INTO an ignored folder still pushes).
		const armed = this.debounceTimers.get(oldPath);
		if (armed) {
			this.time.clearTimeout(armed);
			this.debounceTimers.delete(oldPath);
			this.emitStatus();
		}

		// Keep the note_id mapping stable across the rename (Task 5) — the id
		// itself never changes on a rename, only the path key it's filed under.
		// A no-op if oldPath has no entry (attachments, or a note never pushed).
		if (!isBinary) {
			this.noteIdMap?.rename(oldPath, file.path);
		}

		// Delete old path if it wasn't ignored.
		// EVIDENCE RULE (#416, review finding 3): the old-leg delete is a real
		// server deletion keyed by path — without recorded sync evidence for
		// oldPath this device has no standing to issue it (the incident's
		// lost-bookkeeping state re-enters through renames otherwise). A skipped
		// old-leg delete costs a stale server copy that the next pull surfaces;
		// a wrong one deletes another device's data. Known accepted cost (#419
		// pre-merge review): attachments synced before attachment stamping
		// existed have no row, so their first rename leaves the old server path
		// behind until a pull reconciles it — safe-direction, self-healing.
		const hadOldEvidence = this.syncState.has(normalizePath(oldPath));
		if (!this.shouldIgnore(oldPath)) {
			try {
				if (isBinary) {
					if (hadOldEvidence) {
						await this.api.deleteAttachment(oldPath);
						this.goOnline();
					} else {
						rlog().warn(
							"push",
							`Rename old-leg delete REFUSED (no sync evidence): ${noteRef(oldPath)}`,
						);
					}
				} else if (this.isCrdtEligible(file)) {
					// Phase E2 (rename-as-move): NO tombstone (markdown AND canvas since
					// #306 — a rename keeps the extension, so gating on the new file's
					// eligibility is equivalent to the old path's). The pushFile below
					// sends `crdt_create` for the SAME id at the new path and the
					// backend relocates the live row in place
					// (genesis_relocate_live -> move_note, :announce_moved fan-out);
					// receivers move their local file via the id-keyed relocation
					// (moveIfIdRelocated), same as a REST rename's :moved leg. The
					// old tombstone->resurrect dance is gone with two hazards it
					// carried: the #970 delete-wins window could eat a rename as a
					// recreate-after-delete, and the delete+create pair could
					// coalesce on the docId-keyed CrdtOpQueue (the test_10 class).
				} else if (hadOldEvidence) {
					// Defensive fallback (unreachable for current syncable text — md +
					// canvas both rename-as-move above; kept for a future REST-only type).
					await this.api.deleteNote(oldPath);
					this.goOnline();
				} else {
					rlog().warn(
						"push",
						`Rename old-leg delete REFUSED (no sync evidence): ${noteRef(oldPath)}`,
					);
				}
				// Task 6 (note_id-keyed CRDT): a rename must NOT tear down the CRDT
				// doc. Its key is now the note's stable note_id (unchanged by a
				// rename — only the path above it moves, via noteIdMap.rename), so
				// the same doc/IndexedDB entry keeps serving the note at its new
				// path with its live history intact. Closing it here (the old
				// path-keyed behavior) would destroy that history on every rename —
				// the exact bug this rework exists to fix.
			} catch (e) {
				// 404 means already deleted — treat as success.
				if (isHttpStatus(e, 404)) {
					this.goOnline();
				} else {
					// biome-ignore lint/suspicious/noConsole: error boundary
					console.error("Engram Sync: failed to delete old path %s", oldPath, e);
					rlog().error(
						"push",
						`Rename old-leg delete failed (queued): ${noteRef(oldPath)} | ${errMsg(e, oldPath)}`,
					);
					await this.enqueueChange({
						path: oldPath,
						action: "delete",
						kind: isBinary ? "attachment" : "note",
						timestamp: Date.now(),
						vaultId: this.settings.vaultId ?? undefined,
						// Provably equal to `true` today (refused legs never call out),
						// but kept code-derived so a future throwing edit inside the
						// refusal legs cannot silently stamp evidence (round-3 review).
						evidenced: hadOldEvidence,
					});
					this.maybeGoOffline(e);
				}
			}
		}

		// Move base content entry to new path before pushing
		if (!isBinary) {
			this.baseStore?.rename(normalizePath(oldPath), normalizePath(file.path));
			// Move the sync-state entry to the new path. The OLD key must go: its
			// recorded content hash is stale there, and left behind it
			// echo-suppresses a later create at the old path whose content happens
			// to hash the same (rename a note away, then make a new note with
			// identical content at the old path — the new note's push is skipped
			// and it never syncs). The row itself is the NOTE's evidence and moves
			// with it, so a delete before the new-path push lands is not refused.
			// (The base moved with the note via baseStore.rename above; deleting it
			// here would erase the just-renamed entry.)
			this.renamePath(normalizePath(oldPath), normalizePath(file.path));
			// Un-confirm the id so pushFile below takes the `crdt_create` genesis
			// branch (not the crdt_msg edit branch, which carries no path and
			// can't move the row): the create for a LIVE id at the new path IS
			// the relocation server-side (Phase E2, genesis_relocate_live).
			this.unconfirmNoteId(this.noteIdMap?.get(file.path) ?? null);
		}

		// Push new path if it isn't ignored
		if (!this.shouldIgnore(file.path)) {
			await this.pushFile(file);
		}
	}

	/** Push a folder-create from the vault to the server's explicit-folder
	 *  table. Idempotent client-side (skips folders already in the set) and
	 *  best-effort on the wire (server errors are warn-logged but don't fail
	 *  the user's vault op). */
	async handleFolderCreate(folder: TFolder): Promise<void> {
		if (this.syncBlocked) return;
		if (!this.ready) return;
		if (!this.explicitFolders) return;
		const path = folder.path;
		if (this.shouldIgnore(path)) return;
		if (this.explicitFolders.has(path)) return;

		try {
			await this.api.createFolder(path);
			await this.explicitFolders.add(path);
		} catch (e) {
			devLog().log("push", `createFolder("${path}") failed: ${errMsg(e)}`);
			rlog().warn("push", `createFolder("${noteRef(path)}") failed: ${errMsg(e, path)}`);
		}
	}

	/** Push a folder-delete to the server. Only fires for folders we believe
	 *  the server tracks (in the explicit set) — unknown folders are no-ops
	 *  since the server has nothing to clean. Even on server error we drop the
	 *  local marker; the next pull will reconcile. */
	async handleFolderDelete(folder: TFolder): Promise<void> {
		if (this.syncBlocked) return;
		if (!this.ready) return;
		if (this.suppressDeletes) return;
		if (!this.explicitFolders) return;
		const path = folder.path;
		if (!this.explicitFolders.has(path)) return;

		try {
			await this.api.deleteFolder(path);
		} catch (e) {
			devLog().log("push", `deleteFolder("${path}") failed: ${errMsg(e)}`);
			rlog().warn("push", `deleteFolder("${noteRef(path)}") failed: ${errMsg(e, path)}`);
		} finally {
			await this.explicitFolders.delete(path);
		}
	}

	/** First-sync seeding: POST an explicit marker for every local folder whose
	 *  entire subtree holds NO syncable file. The server derives a folder only
	 *  from notes pushed into it, so a truly-empty folder — or one containing
	 *  only non-syncable types (.txt, .excalidraw, …) — would otherwise never
	 *  appear in the web UI after a first sync. Folders with a syncable note
	 *  anywhere beneath them are skipped: they surface via that note, and the
	 *  web app synthesizes their ancestors. Best-effort — a per-folder server
	 *  error is warn-logged and seeding continues (matches handleFolderCreate). */
	async seedEmptyFolders(): Promise<void> {
		if (!this.explicitFolders) return;

		const loaded = this.app.vault.getAllLoadedFiles?.() ?? [];
		for (const f of loaded) {
			if (!(f instanceof TFolder)) continue;
			const path = normalizePath(f.path);
			if (!path || path === "/") continue; // vault root
			if (this.shouldIgnore(path)) continue;
			if (this.explicitFolders.has(path)) continue; // already tracked
			if (this.subtreeHasSyncableFile(f)) continue; // appears via its notes

			try {
				await this.api.createFolder(path);
				await this.explicitFolders.add(path);
			} catch (e) {
				devLog().log("push", `seedEmptyFolders("${path}") failed: ${errMsg(e)}`);
				rlog().warn(
					"push",
					`seedEmptyFolders("${noteRef(path)}") failed: ${errMsg(e, path)}`,
				);
			}
		}
	}

	/** True if any descendant file (at any depth) is syncable and not ignored. */
	private subtreeHasSyncableFile(folder: TFolder): boolean {
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				if (this.subtreeHasSyncableFile(child)) return true;
			} else if (
				child instanceof TFile &&
				this.isSyncable(child) &&
				!this.shouldIgnore(child.path)
			) {
				return true;
			}
		}
		return false;
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

	/** Paths modified during a pull that need pushing once pull completes. */
	private pendingPostPullPushes = this.track(["vault", "destroy"], new Set<string>());

	/** Push a single file to Engram. Returns true on success.
	 *  When force is true, skip echo suppression (used by pushAll).
	 *  When bypassPlanSkip is true, also skip the needs_pro short-circuit so a
	 *  parked attachment is actually re-uploaded — used ONLY by
	 *  resyncSkippedAttachments on a plan upgrade. The bulk paths (pushAll /
	 *  pushModifiedFiles) pass force without this, so they stay quiet on
	 *  plan-gated attachments.
	 *
	 *  `serverAttachmentHashes` maps normalized path -> the server's CURRENT
	 *  content hash, supplied once per bulk sweep. It is what lets a FORCED
	 *  attachment push prove convergence instead of re-sending megabytes; see
	 *  `serverStillHasOurBytes`. Absent (single-file pushes) means unproven,
	 *  and force re-uploads exactly as it always did. */
	private async pushFile(
		file: TFile,
		force = false,
		bypassPlanSkip = false,
		serverAttachmentHashes?: Map<string, string>,
	): Promise<boolean> {
		if (this.pushing.has(file.path)) return false;

		// Persistence shortcut: if this attachment was already parked under an
		// informational plan-skip (Free-tier 402 attachments-disabled, or a
		// storage-quota 402, on a previous push), skip it without re-hitting the
		// backend. The issue stays in the Sync Center until the user upgrades or
		// dismisses it. This is what makes the batched toast quiet on the next
		// sync — there's nothing left to fail, so the count is 0.
		if (!bypassPlanSkip && this.isBinaryFile(file) && this.hasInformationalIssue(file.path)) {
			devLog().log("push", `skip (plan-informational): ${file.path}`);
			return false;
		}

		// Plan-limit pre-gate: with known limits, don't even attempt an upload the
		// backend WILL reject. Records the same informational/actionable issue a
		// 402/413 would have, but with no network round-trip — this is what removes
		// the noise at the source. Only for binary attachments; notes are never
		// pre-gated. bypassPlanSkip (resyncSkippedAttachments after an upgrade)
		// skips this so a parked attachment is actually re-uploaded.
		if (!bypassPlanSkip && this.isBinaryFile(file)) {
			const gate = this.preGateAttachment(file);
			if (gate) {
				const now = Date.now();
				this.issues.record({
					path: file.path,
					kind: "attachment",
					category: gate.category,
					message: gate.message,
					sizeBytes: gate.category === "too_large" ? file.stat.size : undefined,
					upgradeUrl: gate.upgradeUrl,
					firstFailedAt: now,
					lastFailedAt: now,
					attempts: 1,
				});
				if (issueDisposition(gate.category) === "informational") {
					this.attachmentLimitedThisBatch += 1;
				} else {
					this.failuresThisBatch += 1;
					this.firstFailureMessageThisBatch ??= gate.message;
				}
				devLog().log("push", `skip (pre-gate ${gate.category}): ${file.path}`);
				return false;
			}
		}

		// Echo FILTER for notes, ABOVE the push slot (#426). Materialising a pulled
		// note fires a vault modify event, so a first sync of N notes queues N
		// pushes that all turn out to be echoes — and each one used to burn a
		// bounded push slot, a status repaint and a "Push start" log line before
		// bailing (~800 of the ~1,200 client log lines on the 315-note first sync
		// of 2026-08-13). Same predicate the note branch used to apply inside the
		// slot, so nothing that would have been pushed is dropped.
		//
		// A filter, and ONLY a filter: nothing read here is transmitted. The body
		// that gets pushed is re-read below, after the slot, because the wait can
		// be long and a pre-wait snapshot diffed into the Y.Doc's CURRENT state is
		// the stale delta that DELETES just-arrived remote content (e2e test_37).
		// Deciding "is this an echo" on a slightly older body is safe — the answer
		// only gets more conservative. Deciding WHAT TO SEND on one is not.
		//
		// Attachments keep their check inside the slot: theirs needs the base64
		// body, which is the expensive part — hoisting it would not avoid it.
		const isBinary = this.isBinaryFile(file);
		if (!isBinary) {
			const echoHash = fnv1a(await this.app.vault.cachedRead(file));
			const existing = this.syncState.get(normalizePath(file.path));
			if (!force && existing !== undefined && echoHash === existing.hash) {
				devLog().log("push", `skip (echo): ${file.path}`);
				rlog().info("push", `Echo skip: ${noteRef(file.path)} | hash=${echoHash}`);
				return false;
			}
		}

		await this.acquirePushSlot();
		// Snapshot the path for the lifetime of this push. TFile.path is LIVE —
		// a user rename landing while the request is in flight mutates it, and
		// every identity decision below (pushing-set hygiene, the wire path, the
		// server-sanitized-rename check) must be made against the path we
		// actually pushed, not wherever the file lives by reply time (#245).
		const pushedPath = file.path;
		// Re-check the guard HERE, not just at entry (line ~3494): two awaits sit
		// between that check and this claim (the echo-hash read, acquirePushSlot),
		// so two overlapping pushFile calls for the same path — e.g. two
		// overlapping fullSync() sweeps, which nothing serializes — can both pass
		// the stale check before either claims the slot, and both push. For a
		// brand-new CRDT note that means two independent genesis lineages landing
		// on the same server row. Nothing async happens between this check and the
		// claim below, so this pairing IS atomic (single-threaded JS).
		if (this.pushing.has(pushedPath)) {
			this.releasePushSlot();
			devLog().log("push", `skip (already pushing, lost the race): ${pushedPath}`);
			return false;
		}
		this.pushing.add(pushedPath);
		this.lastError = "";
		this.emitStatus();

		let success = false;
		// Set in the note branch below so recordParseStatus can run AFTER the
		// shared issues.clear(file.path) — resp (and thus parse_status) is only
		// in scope inside that branch, but the clear is shared with attachments.
		let pushedNoteParse:
			| { path: string; parseStatus?: "ok" | "degraded"; parseReason?: ParseReason | null }
			| undefined;
		devLog().log(
			"push",
			`start ${isBinary ? "attachment" : "note"}: ${file.path} (active=${this.activePushCount})`,
		);
		rlog().info(
			"push",
			`Push start: ${noteRef(file.path)} | type=${isBinary ? "attachment" : "note"} | active=${this.activePushCount}`,
		);

		try {
			const mtime = file.stat.mtime / 1000; // Obsidian uses ms, Engram uses seconds
			if (isBinary) {
				const buffer = await this.app.vault.readBinary(file);
				const base64 = arrayBufferToBase64(buffer);
				// Track attachments in syncState the same way notes are. Without
				// this, pushModifiedFiles sees every attachment as untracked and
				// re-pushes it on every fullSync (the "pushed N every Merge" loop).
				const hash = fnv1a(base64);
				const np = normalizePath(file.path);
				const existing = this.syncState.get(np);
				const unchangedLocally = existing !== undefined && hash === existing.hash;
				// A forced push distrusts the LOCAL stamp — rightly, since the
				// server may have lost our copy. But it can still be satisfied by
				// SERVER evidence: if the server's current hash for this path is
				// the one we recorded when we last uploaded it, our bytes are
				// demonstrably there and re-sending them is pure waste. Without
				// this, every pushAll re-uploaded the whole vault's attachments
				// (2026-08-21: 667 files, 90 minutes, ~30% of prod CPU).
				if (
					unchangedLocally &&
					(!force || this.serverStillHasOurBytes(np, existing, serverAttachmentHashes))
				) {
					devLog().log("push", `skip (echo): ${file.path}`);
					// Stays at info DELIBERATELY. A converged pushAll skips every
					// attachment in the vault, so promoting this to warn would emit
					// one per file — 667 of them in the incident vault. The
					// server-visible signal is the per-sweep summary in
					// pushPartitioned, which carries the same information in one
					// line and is what a loop actually looks like.
					rlog().info(
						"push",
						`Echo skip (attachment): ${noteRef(file.path)} | hash=${hash} | forced=${force}`,
					);
					return false;
				}
				const mimeType = this.getMimeType(file);
				const attResp = await this.api.pushAttachment(file.path, base64, mimeType, mtime);
				// MERGE: a bare `set` here dropped the serverHash this path needs
				// on the NEXT forced push, which is what kept force permanently
				// unable to prove convergence.
				this.patchSyncedRow(np, {
					hash,
					...(attResp?.attachment?.content_hash
						? { serverHash: attResp.attachment.content_hash }
						: {}),
				});
			} else {
				// RE-READ after the slot. The pre-slot read (#426) exists only to
				// bail on echoes cheaply; it must not be the body we transmit.
				// acquirePushSlot can block for as long as the queue ahead of us
				// takes, and `content` is diffed into the Y.Doc's CURRENT state
				// below — a snapshot taken before that wait is exactly the "stale
				// delta that DELETES the just-arrived remote content" failure the
				// echo guard above is written to prevent (e2e test_37). Observing a
				// newer body here is the correct outcome, not a hazard: the newest
				// content is what should be pushed.
				//
				// Costs one extra cachedRead, and only on the non-echo path — every
				// echo already returned above without taking a slot.
				const content = await this.app.vault.cachedRead(file);
				const hash = fnv1a(content);

				// note_id-keyed CRDT rework (Task 5): resolve (or mint) this note's
				// stable id BEFORE routing, so both the CRDT path (Task 6) and the
				// REST fallback below can key/send by it. A brand-new note has no
				// entry yet — mint a UUIDv7 and remember it immediately so a retry
				// or a concurrent push for the same path reuses the same id rather
				// than minting a second one.
				let noteId = this.noteIdMap?.get(file.path) ?? null;
				// An id minted by THIS push cannot be one the server has ever issued,
				// whatever the path-keyed oracle says. See the `mintedNow` gate on the
				// CRDT-ops branch below.
				let mintedNow = false;
				if (!noteId && this.noteIdMap) {
					// MINT REFUSAL (issue #972, e2e test_34) — see shouldDeferMint.
					// Skip the push: the relocation/pull owns this path's fate.
					if (this.shouldDeferMint(file.path)) {
						// ...but "don't mint" is NOT "throw the edit away" (#1503). The
						// guard fires on `unmapped + engine-flushed`, and a path can be
						// transiently unmapped for reasons that have nothing to do with a
						// relocation — a full sync rebuilding the map is the proven one
						// (#1489). A real local edit landing in that window used to return
						// here with no queue entry and no retry, so it survived only if an
						// unrelated PushModified sweep happened to re-pick the file later.
						// In CI that was 107s; with no sweep it is silent data loss.
						//
						// The two cases are separable by CONTENT. #972 is our own
						// flushFromCrdt write echoing back: disk still holds exactly what
						// the engine wrote, and the relocation evicted the baseline, so
						// there is nothing to compare and nothing worth saving — the old
						// path is dead and re-queueing it would resurrect the note the
						// guard exists to suppress. A genuine edit is the opposite: the
						// baseline SURVIVES and disk has moved off it. `hash` is already
						// computed above, so this costs no extra read.
						const stored = this.syncState.get(normalizePath(file.path));
						const movedOffBaseline = stored?.hash !== undefined && stored.hash !== hash;
						if (movedOffBaseline) {
							rlog().warn(
								"push",
								`Mint refused but edit PRESERVED (unmapped path, local edit): ${noteRef(file.path)}`,
							);
							// Content-free, exactly like the retry-after-failure enqueue
							// below: the body is re-read at flush time, by which point the
							// map has settled and runFlushQueue re-resolves the id. Its own
							// shouldDeferMint check keeps the entry queued if it has not.
							await this.enqueueChange({
								path: file.path,
								action: "upsert",
								kind: "note",
								mtime: file.stat.mtime / 1000,
								timestamp: Date.now(),
								vaultId: this.settings.vaultId ?? undefined,
							});
							return false;
						}
						rlog().info(
							"push",
							`Mint refused (engine-flushed file, id relocated away): ${noteRef(file.path)}`,
						);
						return false;
					}
					noteId = uuid7();
					this.noteIdMap.set(file.path, noteId);
					mintedNow = true;
				}

				// Routing observability: which inputs decide CRDT-vs-REST for this
				// markdown save. Routing is gated on hasServerNote (server=): a note
				// the server already holds (crdtHead != null) routes over CRDT ops; a
				// never-server-known note takes the genesis crdt_create path below.
				// `confirmed` no longer drives routing (still read by refire/convergence).
				if (this.isCrdtEligible(file)) {
					rlog().info(
						"push",
						`route: ${noteRef(file.path)} crdt=${!!this.crdt} server=${this.hasServerNote(noteId)} confirmed=${noteId ? this.isNoteConfirmed(noteId) : false} live=${this.crdtLive?.() ?? true} id=${noteId ?? "none"}`,
					);
				}

				// CRDT path: route markdown saves through CrdtManager when wired,
				// a note_id is known (#915-style gate: no id, no CRDT room to key
				// the frame by, REST fallback owns it), and the note is
				// server-known (hasServerNote: crdtHead != null) because the backend's
				// CRDT channel requires the note row to already exist (note_in_vault?)
				// and silently DROPS a crdt_msg for an unknown note_id — it can no
				// longer bootstrap a note from a bare wire doc_id (no path on the
				// frame). A brand-new / never-synced note must therefore take the
				// genesis crdt_create path first (which creates the row and adopts the
				// client-minted id); only then do its
				// edits route through CRDT. diffIntoYText produces minimal ops.
				//
				// Transport (Task 5, single authority): once the edit is consumed
				// into the Y.Doc, a LIVE crdt: channel already carries it (the Y.Doc
				// update listener forwards the diff via CrdtChannel, keyed by
				// noteId) — no full-document POST, no version field, no base_hash.
				// When the channel is NOT joined (crdtLive() false — a stale manager
				// latch, e.g. dead-but-set after an auth swap, or a genuine
				// disconnect), the edit is still durable in the local Y.Doc —
				// persist a durable crdt-tagged queue entry (delivered by
				// runFlushQueue's socket-converge branch) instead of falling
				// through to the whole-doc base_hash push (#203, e2e test_83/test_85).
				// Live-vs-durable-queue is decided by the post-await `crdtLiveNow`
				// re-check below (Task 5) — the channel can drop during the awaited
				// `routeModify` seed.
				// `!mintedNow`: hasServerNote is PATH-keyed — it resolves the id to a
				// path and asks whether that PATH has a crdtHead (recorded under the
				// vault path; see setCrdtHead). The wire is ID-keyed. So an id minted
				// moments ago for a path whose server row already exists inherits that
				// path's "the server knows this" verdict and sends an op under an id
				// the backend never issued, which it drops as note_not_found — the
				// bytes are gone, and the echo baseline banked below means no retry
				// ever re-sends them. Traced in CI (e2e test_27, release-v0.17.0):
				//   route: … server=false id=…cd61   (create, row keyed cd61)
				//   route: … server=true  id=…d1a9   (id-map entry lost, fresh mint)
				//   crdt_msg dropped by server (note_not_found): …d1a9
				// A fresh mint therefore falls through to the genesis crdt_create
				// branch, which ADOPTS the server's authoritative id for a path it
				// already owns and re-keys the map — the recovery that already exists.
				if (this.crdt && noteId && !mintedNow && this.hasServerNote(noteId)) {
					const consumed = await routeModify(
						{
							crdtEligible: this.isCrdtEligible(file),
							noteId,
							// A LIVE read, not the frozen `content` above: routeModify
							// forwards this as the manager's stale-snapshot reread, and a
							// frozen closure would defeat that guard (e2e test_83).
							readContent: () => this.app.vault.cachedRead(file),
						},
						this.crdt,
						MAX_CRDT_NOTE_BYTES,
					);
					if (consumed !== null) {
						// Record the transmitted content's hash as the echo-hash baseline
						// (final review IMPORTANT-4). Without this, the hoisted echo-hash
						// gate above keeps comparing against the last-FLUSHED baseline
						// (discovery/pull) instead of the last-TRANSMITTED content: an
						// edit followed by an undo back to that stale baseline hash-
						// matches and is echo-skipped, so the revert never reaches the
						// Y.Doc. Merges onto the entry as read at stamp time so
						// version/serverHash survive — including ones a concurrent
						// converged stamp wrote during the awaited routeModify (the old
						// pre-await `existing` spread silently dropped those). Hash what
						// the manager actually CONSUMED, not this function's pre-guard
						// disk read — with a live reread those differ whenever a remote
						// merge landed mid-guard, and stamping the stale hash would
						// echo-skip a later revert back to that exact content (review
						// sync.ts:2113).
						this.recordCrdtBaseline(normalizePath(file.path), consumed);
						// Register the doc with the server even when applyLocalEdit produced
						// NO Yjs update — a brand-new EMPTY note seeds "" into Y.Text, which
						// is a no-op, so nothing is transmitted and the note would never reach
						// the server. enroll() fires startSync's STEP1 handshake so the client
						// re-syncs any Yjs history it's missing. Idempotent per session, so a
						// note already enrolled via active-leaf-change is unaffected.
						// Vault-channel fan-out: enroll (STEP1) only for a live-bound note.
						// An idle note's send already shipped over the channel/updates above,
						// and it RECEIVES future updates over the note_yjs_update broadcast —
						// no room needed. A brand-new empty note's row is created by the REST
						// push path, so skipping STEP1 here does not strand it.
						if (this.isLiveBound(normalizePath(file.path))) {
							this.crdtEnrollment?.enroll(noteId);
						}
						success = true;
						// Task 5 (TOCTOU fix): re-check liveness AFTER the awaited seed
						// above. The channel can drop DURING routeModify — a stale
						// pre-await `crdtLive` snapshot would leave the edit on a dead
						// socket believing the live channel already carried it, when it
						// never did.
						const crdtLiveNow = this.crdtLive?.() ?? true;
						if (!crdtLiveNow) {
							// Channel down (or dropped mid-seed), ops available: the edit
							// is already durable in the local Y.Doc (IndexedDB-persisted).
							// Persist a content-free crdt-tagged queue entry — durable
							// across plugin unload and retried by runFlushQueue until
							// delivered — instead of the retired in-memory-only debounce
							// timer, which lost the edit on unload and never retried a
							// failed flush.
							await this.enqueueCrdtEdit(file, noteId);
							// Deliver now if REST is reachable; durable + retried
							// otherwise (queue survives unload, next flush picks it up).
							void this.flushQueue();
							devLog().log(
								"push",
								`crdt edit queued durably (channel down): ${file.path}`,
							);
							rlog().info(
								"push",
								`CRDT edit queued durably (channel down): ${noteRef(file.path)}`,
							);
							return true;
						}
						devLog().log("push", `crdt ok: ${file.path}`);
						rlog().info("push", `CRDT push ok: ${noteRef(file.path)}`);
						return true;
					}
					// DECLINED (handshake gate): applyLocalEdit did not consume because
					// the doc is empty and STEP2 has not yet arrived this session. This is
					// effectively unreachable now that Branch A is gated on hasServerNote
					// (a server-known note's doc has already been seeded/converged, so it
					// has history and won't decline) — but stay defensive rather than
					// silently drop. Enroll the markdown note so the STEP1 handshake kicks
					// off; the edit remains on disk and re-routes on the next edit /
					// reconnect re-push once STEP2 lands. Md + cap + live-bound gated (an
					// oversized doc must never enroll — 8 MB WS frame limit).
					// ponytail: no immediate delivery on decline (the old REST fallback is
					// gone); acceptable because the gate makes this path unreachable.
					if (
						this.isCrdtEligible(file) &&
						!exceedsCrdtNoteLimit(content, MAX_CRDT_NOTE_BYTES) &&
						this.isLiveBound(normalizePath(file.path))
					) {
						this.crdtEnrollment?.enroll(noteId);
					}
					return true;
				}

				// Socket-native genesis (Plan B1, Task 3): a brand-new / never-synced
				// markdown note's FIRST write creates its server row over the CRDT
				// channel instead of a REST pushNote. Gated to the genesis case only —
				// a CONFIRMED note's edits already took the CRDT-op branch above (or its
				// declined/oversized fall-through), and this branch must not intercept
				// them. Requires the channel joined (crdt_create is a socket request)
				// and the body within the CRDT transport cap (an oversized note stays
				// on REST — routeModify would decline the seed anyway). crdt_create
				// returns the server's AUTHORITATIVE id; on ADOPT (path already owned by
				// a live note under a different id) it differs from our mint, so we
				// remap before seeding/enrolling — addressing the row that exists rather
				// than orphaning the note's content. On rejection (delete-wins,
				// rate-limit, bad path) we log and return false; there is no REST
				// create fallback (CRDT is the sole md path); retries on reconnect.
				if (
					this.crdtCreate &&
					this.crdt &&
					noteId &&
					this.isCrdtEligible(file) &&
					// `mintedNow ||`: same path-vs-id keying trap as the ops branch
					// above. A fresh mint on a path the server already owns must reach
					// crdt_create precisely SO THAT the ADOPT branch can hand back the
					// authoritative id; gating it out on the path's stale head is what
					// left the note with no route at all.
					(mintedNow || !this.hasServerNote(noteId)) &&
					(this.crdtLive?.() ?? true) &&
					!exceedsCrdtNoteLimit(content, MAX_CRDT_NOTE_BYTES)
				) {
					try {
						// Only the crdtCreate call itself is covered by this catch — once
						// it RESOLVES, the server row exists (possibly under a remapped
						// serverId) and a throw from anything below must NOT fall through
						// to the REST cascade: that would create a duplicate/misrouted row
						// under the stale mint against a path the server already owns. The
						// inner try/catch handles that post-create case locally.
						//
						// #1409: hand the body to crdt_create so the server can write it
						// with a detached Y.Doc instead of opening a room per file — a
						// full-vault import otherwise spins up one OTP room process per
						// note. Gated by genesisUpdateFor (shared with the durable
						// queue's replayed create, buildGenesisFrame, below) — markdown
						// only, not live-bound, in-cap. `genesisUpdate` is kept as the raw
						// Yjs bytes (not just the wire frame) so a `seeded: true` reply can
						// apply the SAME update to this device's own doc below — see that
						// comment for why.
						const chosenGenesis = await this.genesisUpdateFor(
							noteId,
							pushedPath,
							content,
						);
						const genesisUpdate = chosenGenesis?.update;
						const {
							docId: serverId,
							seeded,
							genesisOutcome,
						} = genesisUpdate === undefined
							? await this.crdtCreate(noteId, pushedPath)
							: await this.crdtCreate(
									noteId,
									pushedPath,
									encodeUpdateFrame(genesisUpdate),
								);
						let effectiveId = noteId;
						try {
							// On ADOPT (serverId !== noteId) the path is already owned by a
							// live note under another id; remap so our body/edits address
							// that existing row. No Y.Doc was seeded under our local mint by
							// this genesis path (routeModify runs only AFTER, below, keyed
							// by effectiveId), so there is nothing to re-key — we simply
							// seed under the server id from the start.
							let consumed: string | null;
							if (
								serverId &&
								serverId !== noteId &&
								this.isLiveBound(normalizePath(pushedPath))
							) {
								// ADOPT under a LIVE editor. The editor is bound to the MINT
								// doc, so the user's live keystrokes (including any typed during
								// the crdt_create round-trip, and any not yet flushed to disk)
								// are in the mint Y.Text — disk (cachedRead) can lag them. Seed
								// the serverId doc from the mint's projected content via
								// applyLocalEdit (DEFAULT origin, so the update FORWARDS to the
								// server — applyRemoteUpdate's REMOTE_ORIGIN would keep the edits
								// client-only and they'd still be lost server-side). The live
								// ViewPlugin then re-resolves path -> serverId on its next update
								// and re-attaches itself (no external rebind needed); because
								// serverId already holds the content, its reconcile is a no-op.
								// THEN retire the mint doc. Skips the disk-seed routeModify
								// below: re-diffing the (staler) disk snapshot into serverId
								// would clobber the just-transferred in-flight chars.
								// NOTE: this transfer is the load-bearing step; it used to be
								// gated on the (now-removed) crdtEditorRebind wiring, which
								// silently disabled it and made adopt seed from lagged disk.
								// ponytail: two-lineage doubling is possible in a TRUE
								// content collision (local new-note text vs the server row's
								// pre-existing independent Y history) — accepted as
								// visible/recoverable over silent loss; the warn below makes
								// it diagnosable. TODO: full adopt-collision conflict
								// semantics is a focused follow-up.
								this.noteIdMap?.set(normalizePath(pushedPath), serverId);
								effectiveId = serverId;
								const mintText = await this.crdt.projectedText(noteId);
								const serverHadContent =
									typeof this.crdt.hasHistory === "function" &&
									(await this.crdt.hasHistory(serverId));
								consumed = await this.crdt.applyLocalEdit(serverId, mintText);
								if (mintText.length > 0 && serverHadContent) {
									rlog().warn(
										"crdt",
										`crdt_create ADOPT: transferred non-empty buffer into a non-empty server doc (possible two-lineage merge): ${noteRef(pushedPath)} ${noteId} -> ${serverId}`,
									);
								}
								rlog().info(
									"crdt",
									`crdt_create ADOPT: remapped live editor ${noteRef(pushedPath)} ${noteId} -> ${serverId}`,
								);
								// The ViewPlugin re-resolves path -> serverId on its next update
								// and re-attaches itself; the reattach-triggering keystroke is
								// forwarded (not reverted). No external rebind call here — the
								// `crdtEditorRebind` port it used to make was never wired in
								// prod (main.ts:570) and is deleted (#484).
								// Keystroke-leak window: keystrokes landing in the mint doc
								// between the projectedText read above and this removeDoc are
								// dropped. Microtask-scale; accepted.
								await this.teardownCrdtDoc(noteId);
							} else {
								if (serverId && serverId !== noteId) {
									this.noteIdMap?.set(normalizePath(pushedPath), serverId);
									rlog().info(
										"crdt",
										`crdt_create ADOPT: remapped ${noteRef(pushedPath)} ${noteId} -> ${serverId}`,
									);
									effectiveId = serverId;
								}
								consumed = await this.seedBodyAfterCreate({
									effectiveId,
									normalized: normalizePath(pushedPath),
									file,
									seeded,
									sameId: serverId === noteId,
									genesisUpdate,
									genesisContent: content,
									genesisOutcome,
									// The gate cleared this note (no lineage) BEFORE the create
									// round trip; lineage now means something wrote during that
									// window and the server holds a lineage we never adopted.
									// Not repairable here — surfaced so it stops being invisible.
									onHistoryResolved: (hasHistory) =>
										this.reportGenesisRace(
											chosenGenesis?.fromThrowaway === true &&
												serverId === noteId,
											hasHistory,
										),
								});
							}
							// Task 1's canSendLive gate held effectiveId's live update(s)
							// (including the seed above) until this exact moment, so nothing
							// typed during the crdtCreate await stays stranded.
							await this.adoptCreateAck(effectiveId, pushedPath, consumed);
							if (consumed !== null) {
								// The seed transmitted content, so the create's own broadcast
								// comes back at us: open the echo-cooldown window exactly like
								// the CRDT-op branch. (The seed-declined exit transmitted
								// nothing; the post-create-throw exit may have transmitted but
								// conservatively leaves the window closed — an unsuppressed
								// self-echo there is absorbed by the hash-skip dedupe.)
								success = true;
							} else {
								// ponytail: near-unreachable — a fresh in-cap note seedOnce's
								// its body (non-null). If a live remote storm made the seed
								// decline, the row exists + id is confirmed but no baseline is
								// recorded, so the next edit re-pushes over the CRDT-op branch
								// and delivers the body. Upgrade path: retry the seed here.
								rlog().warn(
									"crdt",
									`crdt_create ok but body seed declined (will deliver on next edit): ${noteRef(pushedPath)}`,
								);
							}
							// Vault-channel fan-out: enroll (STEP1) only for a live-bound note,
							// matching the CRDT-op branch. An idle note's seed already shipped
							// over the channel and it receives future updates over broadcast.
							if (this.isLiveBound(normalizePath(pushedPath))) {
								this.crdtEnrollment?.enroll(effectiveId);
							}
							devLog().log(
								"push",
								`crdt_create ok: ${pushedPath} (id=${effectiveId})`,
							);
							rlog().info(
								"push",
								`CRDT create ok: ${noteRef(pushedPath)} | id=${effectiveId}`,
							);
							return true;
						} catch (seedErr) {
							// crdtCreate already RESOLVED — the row exists server-side
							// (possibly under the remapped effectiveId). Unlike the
							// crdtCreate-rejection case below, we must NOT fall through to
							// the REST cascade: that would create a second row under the
							// stale mint id against a path the server already owns. Treat
							// this like the seed-declined (null) branch above: the row
							// exists, confirm it and return true — the body self-heals on
							// the next edit's CRDT-op push.
							rlog().warn(
								"crdt",
								`crdt_create ok but post-create step threw (row exists, self-heals on next edit): ${noteRef(pushedPath)} | ${String(seedErr)}`,
							);
							// Baseline deliberately null: this exit may have transmitted, but
							// leaves the echo-cooldown window closed conservatively (an
							// unsuppressed self-echo is absorbed by the hash-skip dedupe).
							await this.adoptCreateAck(effectiveId, pushedPath, null);
							return true;
						}
					} catch (err) {
						// crdtCreate itself REJECTED — the row was never created. Two cases.
						//
						// recently_deleted (delete-wins window, backend #970): the path was
						// just deleted on another device. Converge by TRASHING our local
						// copy, exactly what the retired batch path did — retrying past the
						// window resurrects the note on every device (review finding 1).
						const createReason = crdtOpFailureReason(err);
						if (createReason === "recently_deleted") {
							rlog().info(
								"push",
								`recently_deleted — trashing local ${noteRef(pushedPath)} to honor remote delete`,
							);
							await this.trashRemotelyDeleted(file);
							this.logEntry("push", pushedPath, "skipped", "recently_deleted");
							return false;
						}
						// Anything else (rate-limit, transport): enqueue a durable
						// crdt_create so the genesis is HELD and retried (transient) or
						// surfaced (terminal) by the CrdtOpQueue. Return FALSE — a queued
						// create is not a synced note; counting it as pushed let the recap
						// claim success for notes the queue could still drop (finding 3).
						rlog().warn(
							"crdt",
							`crdt_create failed, enqueued for durable retry: ${noteRef(pushedPath)} | ${String(err)}`,
						);
						this.crdtEnqueue?.({ kind: "create", docId: noteId, path: pushedPath });
						return false;
					}
				}

				// CRDT-sole: in-cap markdown notes converge over CRDT (handled
				// above). The only REST note path kept is for notes OUTSIDE the CRDT
				// domain — non-markdown text notes (.canvas is JSON) and oversized
				// markdown (> the 8 MB WS-frame CRDT cap) — analogous to attachments.
				// An in-cap md note reaching here (channel down, crdt_create unwired,
				// or a genesis reject) is NOT REST-pushed: it stays on disk and
				// re-pushes over CRDT on reconnect. LWW (no version/base_hash → no
				// 409/conflict surface); the server may still sanitize the path.
				if (
					this.isCrdtEligible(file) &&
					!exceedsCrdtNoteLimit(content, MAX_CRDT_NOTE_BYTES)
				) {
					// The CRDT create branch above was skipped (crdt: topic not joined
					// yet, crdtCreate unwired, or already server-known). If the server has
					// no row for this note, enqueue a durable crdt_create so a note created
					// before join is HELD and delivered on join (test_27) rather than
					// deferred to a best-effort reconnect re-push that can drop it.
					// Coalesced by docId; the head is set only on the queue's ack.
					if (this.crdtEnqueue && this.crdt && noteId && !this.hasServerNote(noteId)) {
						this.crdtEnqueue({ kind: "create", docId: noteId, path: pushedPath });
					}
					return false;
				}
				const resp = await this.api.pushNote(pushedPath, content, mtime);
				if ("conflict" in resp) {
					// Unconditional push (no version) never conflicts server-side; guard
					// for the type union only.
					return false;
				}
				const serverPath = resp.note.path;
				if (file.path !== pushedPath) {
					// Renamed locally while in flight; handleRename owns the new path.
					devLog().log(
						"push",
						`sanitize-rename skipped: file moved during push (${pushedPath} → ${file.path})`,
					);
				} else if (serverPath && serverPath !== pushedPath) {
					const localFile = this.app.vault.getFileByPath(pushedPath);
					if (localFile) {
						await this.app.vault.rename(localFile, serverPath);
						new Notice(
							`Engram Sync: renamed "${pushedPath.split("/").pop()}" (unsupported characters)`,
						);
					}
					// Move the merge base with the file. It was previously left
					// behind entirely: dropBase:false with no baseStore.rename, so a
					// server-side path sanitization stranded the note's FULL TEXT
					// under a path that no longer exists, with nothing to ever evict
					// it but the 50MB LRU. Renaming keeps the base useful as an LCA
					// AND removes the old key, so the dropBase:false below is now
					// just "already handled" rather than "deliberately skipped".
					this.baseStore?.rename(normalizePath(pushedPath), normalizePath(serverPath));
					this.dropPath(normalizePath(pushedPath), { dropBase: false });
					this.stampSyncedRow(normalizePath(serverPath), { hash });
					// The server MOVED the note (path sanitization), so the old path's
					// claim is genuinely dead and must be released, not just
					// forgotten: a forget hides the old key from `pathForId`, which
					// is exactly what the `set` below consults to remove a stale
					// claim — so both keys survived in the doc, naming one note at
					// two paths.
					this.noteIdMap?.release(normalizePath(pushedPath));
					this.noteIdMap?.set(normalizePath(serverPath), resp.note.id);
				} else {
					this.stampSyncedRow(normalizePath(file.path), { hash });
					this.noteIdMap?.set(normalizePath(file.path), resp.note.id);
				}
				if (file.path === pushedPath) {
					pushedNoteParse = {
						path: resp.note.path ?? pushedPath,
						parseStatus: resp.note.parse_status,
						parseReason: resp.note.parse_reason,
					};
				}
			}
			success = true;
			this.issues.clear(file.path);
			if (pushedNoteParse) {
				this.recordParseStatus(
					pushedNoteParse.path,
					"note",
					pushedNoteParse.parseStatus,
					pushedNoteParse.parseReason,
				);
			}
			devLog().log("push", `ok: ${file.path}`);
			rlog().info(
				"push",
				`Push ok: ${noteRef(file.path)} | type=${isBinary ? "attachment" : "note"}`,
			);
			this.goOnline();
		} catch (e) {
			const msg = errMsg(e);
			const classified = categorizeError(e);
			// Plan-limit 402s (needs_pro, quota) are expected Free-tier outcomes,
			// not programming errors — don't pollute the dev console. Gate by
			// disposition so both informational reasons stay quiet; other
			// categories keep the error log for triage.
			if (issueDisposition(classified.category) !== "informational") {
				// biome-ignore lint/suspicious/noConsole: error boundary
				console.error("Engram Sync: failed to push %s", file.path, e);
			}
			const now = Date.now();
			this.issues.record({
				path: file.path,
				kind: isBinary ? "attachment" : "note",
				category: classified.category,
				status: classified.status,
				// Surface the backend's own message (e.g. "failed to upload to
				// storage backend") rather than the bare "Request failed, status N".
				message: classified.message,
				sizeBytes: classified.category === "too_large" ? file.stat.size : undefined,
				upgradeUrl: classified.upgradeUrl,
				firstFailedAt: now,
				lastFailedAt: now,
				attempts: 1,
			});
			const attempts = this.issues.get(file.path)?.attempts ?? 1;
			if (issueDisposition(classified.category) === "informational") {
				// Plan-limit skip (needs_pro, quota): tally as "skipped", not failed.
				// Drives the batched session toast (drained by pushAll /
				// pushModifiedFiles) and the progress "skipped" count.
				this.attachmentLimitedThisBatch += 1;
			} else {
				// Tally for the batched "N files failed to sync" Notice.
				this.failuresThisBatch += 1;
				this.firstFailureMessageThisBatch ??= classified.message;
			}
			devLog().log("error", `push failed: ${file.path} — ${msg} (${classified.category})`);
			rlog().error(
				"push",
				`Push failed: ${noteRef(file.path)} — ${msg} | category=${classified.category}`,
				e instanceof Error ? e.stack : undefined,
			);
			this.logEntry("push", file.path, "error", msg, classified.category);
			// Re-queue for retry only while it's worth it. Terminal failures (413,
			// 402) never retry; non-terminal failures retry until RETRY_CAP, then
			// park in the Sync Center — retrying a broken storage backend forever
			// just hammers it. Content-free entry; content re-read on flush.
			if (shouldRetryAfterFailure(classified, attempts)) {
				await this.enqueueChange({
					path: file.path,
					action: "upsert",
					kind: isBinary ? "attachment" : "note",
					mtime: file.stat.mtime / 1000,
					timestamp: Date.now(),
					vaultId: this.settings.vaultId ?? undefined,
				});
			}
			// Only true connection loss (no HTTP response) takes the plugin
			// offline — a per-file 5xx leaves the backend reachable.
			this.maybeGoOffline(e);
		} finally {
			// Delete the SNAPSHOT, not the live path — if the file moved during
			// the push, deleting file.path would leave the old path stuck in the
			// pushing set forever (blocking future pushes + WS echo handling).
			this.pushing.delete(pushedPath);
			this.releasePushSlot();
			// Keep path suppressed for a cooldown period after push completes.
			// WebSocket events often arrive after the push finishes, and without this
			// the echo suppression in handleStreamEvent would miss them.
			//
			// Gated on `success`: only a push that actually transmitted content (a
			// real POST or a CRDT emit) may open this window. The various no-op
			// exits (echo hash-skip for notes/attachments, failed pushes caught
			// above) leave `success` false — nothing reached the server, so there is
			// no self-echo to suppress. Opening the window on those no-ops used to
			// let it swallow a legitimately-arriving second remote update within the
			// cooldown (Engram#944).
			// Snapshot path, not file.path: the self-echo arrives under the path we
			// SENT. After a mid-flight rename, marking the live path would leave the
			// old path's echo unsuppressed (recreating the renamed-away file) and
			// wrongly swallow a genuine remote update to the new path (Engram#944
			// class). Mirrors the batch path, which marks e.pushedPath.
			if (success) this.markRecentlyPushed(pushedPath);
			this.emitStatus();
		}
		return success;
	}

	/** True iff the issue store already has a parked *informational* entry for this
	 *  path (e.g. backend returned 402 attachments_disabled or 402 storage-quota on a
	 *  prior push). Used to short-circuit re-push attempts without hitting the
	 *  network — survives plugin reloads because the issue store is persisted. */
	private hasInformationalIssue(path: string): boolean {
		for (const issue of this.issues.all()) {
			if (issue.path === path && issueDisposition(issue.category) === "informational")
				return true;
		}
		return false;
	}

	/** Plan-limit pre-check for an attachment, using last-known PlanState. Returns
	 *  a category to skip under (mirroring the backend's 413/402 outcomes), or null
	 *  to proceed with the upload. The backend remains the authoritative fallback
	 *  when local plan state is stale (null → we defer to the server). */
	private preGateAttachment(
		file: TFile,
	): { category: SyncIssueCategory; message: string; upgradeUrl?: string } | null {
		const plan = this.planState;
		if (!plan) return null; // unknown limits → let the backend decide
		if (plan.maxFileBytes > 0 && file.stat.size > plan.maxFileBytes) {
			return {
				category: "too_large",
				message: `File exceeds the ${plan.maxFileBytes}-byte limit`,
			};
		}
		if (plan.attachmentsTextOnly && !isTextAttachment(file.extension)) {
			return {
				category: "needs_pro",
				message: "Free syncs notes only — images & PDFs need a paid plan.",
			};
		}
		return null;
	}

	/** Drain the batch failure tally for an aggregated, deduped Notice. Returns
	 *  the count of generic failures since the last drain plus the first server
	 *  message seen, and resets the tally. Consumed by the in-class batch
	 *  toast (flushFailureSummaryToast); public for tests. */
	drainFailureSummary(): { count: number; firstMessage?: string } {
		const count = this.failuresThisBatch;
		const firstMessage = this.firstFailureMessageThisBatch;
		this.failuresThisBatch = 0;
		this.firstFailureMessageThisBatch = undefined;
		return { count, firstMessage };
	}

	/** Emit a single aggregated, deduped Notice covering all generic push
	 *  failures this batch — "N file(s) failed to sync — open Sync Center" with
	 *  the first server message. Replaces silent per-file console errors with one
	 *  actionable signal. Called once at the end of pushModifiedFiles / pushAll. */
	private flushFailureSummaryToast(): void {
		const { count, firstMessage } = this.drainFailureSummary();
		if (count <= 0) return;
		const noun = count === 1 ? "file" : "files";
		const detail = firstMessage ? ` (${firstMessage})` : "";
		new Notice(`Engram: ${count} ${noun} failed to sync${detail} — open Sync Center`, 10_000);
		rlog().warn("push", `${count} ${noun} failed to sync${detail}`);
	}

	/** Emit a single batched toast covering all attachments skipped this batch
	 *  with `needs_pro`. Called once at the end of pushModifiedFiles / pushAll.
	 *  The toast fires at most once per session (subsequent batches stay
	 *  silent) so the user isn't repeatedly nagged on every sync interval.
	 *  Spec §4.6 — Free tier batched skip handling. */
	private flushAttachmentLimitedToast(): void {
		const count = this.attachmentLimitedThisBatch;
		this.attachmentLimitedThisBatch = 0;
		// Stash for the terminal progress event's `skipped` tally — survives the
		// reset above (which the once-per-session toast guard below relies on).
		this.lastBatchSkipped = count;
		if (count <= 0) return;
		if (this.attachmentLimitToastShown) return;
		this.attachmentLimitToastShown = true;
		const noun = count === 1 ? "attachment" : "attachments";
		new Notice(`Engram: ${count} ${noun} skipped — upgrade to sync images & PDFs.`, 10_000);
		rlog().info(
			"push",
			`Skipped ${count} ${noun} (attachments_disabled) — batched toast emitted`,
		);
	}

	/** Test hook: how many attachments were marked needs_pro since the last
	 *  flush. Drained when the toast fires. */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: read by tests/sync.test.ts via (engine as any)
	private getAttachmentLimitedCount(): number {
		return this.attachmentLimitedThisBatch;
	}

	/** Test hook: whether the session has already shown the batched toast. */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: read by tests/sync.test.ts via (engine as any)
	private hasShownAttachmentLimitToast(): boolean {
		return this.attachmentLimitToastShown;
	}

	// --- Plan state ---

	/** Store new plan state; on a capability gain (upgrade unlocks non-text
	 *  attachments), re-attempt the attachments parked as informational
	 *  plan-skips. Persists via onPlanStatePersist so a reload keeps the state. */
	applyPlanState(next: PlanState): void {
		const gained = attachmentCapabilityGained(this.planState, next);
		this.planState = next;
		this.onPlanStatePersist?.(next);
		if (gained) {
			devLog().log("push", "plan capability gained — re-syncing skipped attachments");
			rlog().info("push", "Plan capability gained — re-syncing skipped attachments");
			void this.resyncSkippedAttachments();
		}
	}

	/** Seed plan state from persisted settings on load WITHOUT triggering a
	 *  re-sync. A normal reload must not be read as an upgrade: applyPlanState
	 *  would see prev=null and treat any non-text-only plan as a fresh capability
	 *  gain, spuriously re-pushing every parked attachment on every launch. */
	hydratePlanState(p: PlanState): void {
		this.planState = p;
	}

	/** The current plan state (test/UI hook). */
	getPlanState(): PlanState | null {
		return this.planState;
	}

	/** Re-push every file currently parked as an informational plan-skip
	 *  (needs_pro / quota). Force-pushes AND bypasses the needs_pro short-circuit
	 *  so the upload is actually re-attempted; the normal push success path
	 *  clears the issue. Wired to the channel's upgrade event and the Sync Center
	 *  "Sync these now" button. */
	async resyncSkippedAttachments(): Promise<void> {
		const skipped = this.issues
			.all()
			.filter((i) => issueDisposition(i.category) === "informational");
		if (skipped.length === 0) return;
		for (const issue of skipped) {
			const file = this.app.vault.getAbstractFileByPath(normalizePath(issue.path));
			if (file instanceof TFile) {
				await this.pushFile(file, /* force */ true, /* bypassPlanSkip */ true);
			}
		}
		new Notice(`Engram: plan upgraded — syncing ${skipped.length} attachment(s)…`, 6_000);
	}

	/** Trash a file whose deletion was decided REMOTELY (WS delete event, pull
	 *  tombstone, relocation/orphan/bootstrap cleanup). Marks the path first so
	 *  the vault 'delete' event this trash fires skips the server push in
	 *  handleDelete — every sync-applied deletion must route through here, or
	 *  its echo-push can tombstone a note recreated at the path since. */
	private async trashRemotelyDeleted(file: TAbstractFile): Promise<void> {
		this.files.mark(file.path, "remotelyDeleted", ECHO_COOLDOWN_MS);
		// Increment BEFORE the trash (Obsidian can dispatch the delete event
		// during the await), but roll back on a throw: a trash that failed left
		// the file in place, and stranded echo state (counter OR the 5s marker)
		// would swallow the user's NEXT genuine delete of it (#419 reviews,
		// rounds 2+3). The rollback is conditional on our own increment still
		// being unconsumed — if the partial trash's delete event already fired
		// during the await, decrementing again would steal a sibling counter.
		const before = this.engineTrashedPaths.get(file.path) ?? 0;
		this.engineTrashedPaths.set(file.path, before + 1);
		try {
			await this.app.fileManager.trashFile(file);
		} catch (e) {
			if ((this.engineTrashedPaths.get(file.path) ?? 0) > before) {
				this.consumeEngineTrash(file.path);
			}
			this.files.clearMarker(file.path, "remotelyDeleted");
			throw e;
		}
	}

	/** Suppress WebSocket echoes for a path for ECHO_COOLDOWN_MS after push. */
	private markRecentlyPushed(path: string): void {
		this.files.mark(path, "pushed", ECHO_COOLDOWN_MS);
	}

	/** Check if a path was recently pushed (for echo suppression). */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: read by tests/sync.test.ts via (engine as any)
	private isRecentlyPushed(path: string): boolean {
		return this.files.has(path, "pushed");
	}

	/** Suppress the handleModify echo of a flushFromCrdt disk write for
	 *  ECHO_COOLDOWN_MS. Separate from recentlyPushed so a post-push cooldown
	 *  never swallows a genuine local edit. */
	private markRecentlyFlushed(path: string): void {
		this.files.mark(path, "flushed", ECHO_COOLDOWN_MS);
	}

	/** Record a note_id THIS device just deleted so neither CRDT convergence
	 *  path resurrects it during the delete-wins window (backend #970).
	 *
	 *  `path` is stored with it because the tombstone alone cannot tell the two
	 *  things it must distinguish apart: a stale echo of THIS delete (same path
	 *  — block it, that is the whole point of #970) from the other leg of a
	 *  RENAME (different path — the note is alive and must not be blocked). See
	 *  `clearTombstoneOnRelocation`. Inlines the former `markWithTtl`, whose
	 *  only caller this was. */
	private markRecentlyDeleted(noteId: string, path: string): void {
		const existing = this.recentlyDeleted.get(noteId);
		if (existing) this.time.clearTimeout(existing.timer);
		this.recentlyDeleted.set(noteId, {
			path: normalizePath(path),
			timer: this.time.setTimeout(() => {
				this.recentlyDeleted.delete(noteId);
			}, RECENT_DELETE_COOLDOWN_MS),
		});
	}

	/** An inbound upsert is the server asserting an id is ALIVE at a path. If
	 *  that path differs from the one this device tombstoned the id at, the two
	 *  frames are the two legs of ONE rename, and the "delete" was never a user
	 *  delete — so the tombstone has to come off.
	 *
	 *  The rename guard one level up (`relocated`, in the delete branch) only
	 *  catches this when the upsert for the NEW path is processed FIRST, which
	 *  is the order its comment assumes. Prod delivers the other order too: with
	 *  the delete first, `pathForId` still answers the OLD path, the delete reads
	 *  as genuine, and the id is tombstoned for 60s and its Y.Doc destroyed. Both
	 *  convergence paths then skip the note (`fan-out skip`, `op-replay skip`)
	 *  and the editor's doc is gone — the user-visible bug is "the rename lands,
	 *  then typing stops syncing", self-healing only on reload or after the TTL.
	 *  Checking the RECORDED path instead of arrival order is order-independent,
	 *  so neither delivery order can produce it.
	 *
	 *  A same-path upsert is exactly the stale echo #970 exists to block: leave
	 *  that tombstone standing. */
	private clearTombstoneOnRelocation(noteId: string, path: string): void {
		const tomb = this.recentlyDeleted.get(noteId);
		if (!tomb || tomb.path === normalizePath(path)) return;
		this.time.clearTimeout(tomb.timer);
		this.recentlyDeleted.delete(noteId);
		rlog().info(
			"ws",
			`Delete tombstone cleared — ${noteId} is alive at ${noteRef(path)}, so the delete of ` +
				`${noteRef(tomb.path)} was a rename's old leg`,
		);
	}

	/** MINT REFUSAL (backend #972, PRs #216/#217) — the single decision both
	 *  every mint seam routes through
	 *  (docs/context/crdt-batch-push-duplication.md). A mint means "brand-new,
	 *  never-synced local note". A file this engine itself recently flushed to
	 *  disk (flushFromCrdt → recentlyFlushed) can never be that — the engine
	 *  only writes server-known content. If its id binding is gone, a
	 *  concurrent relocation/tombstone evicted it (moveIfIdRelocated re-keys
	 *  the map + drops the syncState baseline BEFORE trashing the old file,
	 *  and the push runs inside that window). Minting here REST-creates the
	 *  renamed-away old path server-side under a fresh id — a live row no
	 *  tombstone will ever remove; every device then re-materializes it
	 *  forever. Defer instead: skip the push (not fail) — the relocation/pull
	 *  owns the path's fate, and the next reconcile/fullSync retries once it
	 *  lands.
	 *  ponytail: recentlyFlushed's 5s cooldown is the guard's window — a push
	 *  delayed past it escapes; debounce is 500ms, fine. */
	private shouldDeferMint(path: string): boolean {
		return (
			!!this.noteIdMap &&
			!this.noteIdMap.get(path) &&
			this.files.has(normalizePath(path), "flushed")
		);
	}

	// --- Pull: Engram → local vault ---

	/** Free `noteId`'s Y.Doc after a remote update has been applied and its head
	 *  durably recorded (P3, plugin #232-series). Idle notes are not
	 *  channel-enrolled under the fan-out model (P2 removed lazyEnrollment) —
	 *  a doc opened just to apply a cold/pushed convergence delta is transient,
	 *  so leaving it resident forever is unbounded memory growth. `closeDoc`
	 *  does not `clearData()`, so the IndexedDB store persists; the next apply
	 *  re-opens via `CrdtManager.entry()`, which awaits `whenSynced` and
	 *  rehydrates the full prior state before merging the next delta — no data
	 *  loss. Re-checks `isLiveBound` AFTER the caller's awaits: the user may
	 *  have opened the note in the editor while the apply was in flight, in
	 *  which case that room now owns the doc's lifecycle and it must stay
	 *  resident. */
	private hibernateIfIdle(path: string, noteId: string): void {
		if (!this.crdt) return;
		if (this.isLiveBound(normalizePath(path))) return;
		// Best-effort memory reclamation: a failure to free the doc must not throw
		// into the never-throw convergence loop nor downgrade an already-recorded
		// head. The doc simply stays resident (bounded; retried next hibernate).
		try {
			this.crdt.closeDoc(noteId);
		} catch (e) {
			devLog().log("crdt", `hibernateIfIdle: closeDoc ${noteId} failed — ${errMsg(e)}`);
		}
	}

	private crdtCatchupSince: CrdtCatchupSinceFn | null = null;

	private crdtDocState: CrdtDocStateFn | null = null;

	/** Socket frames this SERVER has proven it does not implement (it never
	 *  answers, so each attempt costs a full request timeout). Vault-scoped
	 *  because a vault switch can move us to a different backend entirely —
	 *  self-host and SaaS are different servers at different versions. */
	private unsupportedFrames = this.track(["vault", "destroy"], new Set<string>());

	/** Consecutive unsupported-looking replies, keyed BY FRAME. Per-frame on
	 *  purpose: the two room-free frames shipped in different releases, so a
	 *  backend can serve one and not the other, and a shared count would let the
	 *  read's strikes latch off the write (or the reverse).
	 *
	 *  A Map rather than two scalars so it sweeps with `unsupportedFrames` on
	 *  the SAME events. As scalars they survived the vault change that clears
	 *  the latch Set, leaving a carried strike to latch a perfectly good backend
	 *  off after one timeout on the new vault — and the fix for that was a
	 *  hand-written `if (event === "vault")` list in `sweep()`, i.e. exactly the
	 *  drift `track()` exists to abolish. */
	private frameStrikes = this.track(["vault", "destroy"], new Map<string, number>());

	private crdtDocUpdate: CrdtDocUpdateFn | null = null;

	setCrdtCatchupSince(fn: CrdtCatchupSinceFn): void {
		this.setCrdtPorts({ catchupSince: fn });
	}

	/** Single-path convergence on (re)connect: replay the seq-ordered op-log over
	 *  the socket from our persisted cursor. Each op carries FULL content and is
	 *  applied through the SAME `applySyncChange` the REST pull used — so a
	 *  reconnecting device gets every op it missed, IN ORDER, causally complete.
	 *
	 *  This is the sole catch-up mechanism; it replaced the retired
	 *  `crdt_catchup_delta` state-vector delta, which could hand Yjs a
	 *  causally-incomplete update that pends while the device advances its head
	 *  anyway (faked convergence → deaf note, e2e test_85). A full-content op
	 *  cannot pend. Discovery rides the same
	 *  feed: a note another device created while we were away arrives as an op and
	 *  materializes via applySyncChange. Never throws into the caller; a socket
	 *  drop mid-replay is logged and resumed from the persisted cursor next join.
	 *
	 *  Single-flighted: concurrent callers (reconnect + the per-relocation trigger
	 *  a folder rename fires N times) coalesce into one in-flight replay, and a
	 *  trigger that arrives mid-replay schedules exactly one more pass so an op
	 *  committed during the replay is never missed. */
	private seqReplayRunning = false;
	private seqReplayAgain = false;
	/** Resolves with the running replay session's counts — what a coalescing
	 *  caller awaits so it can report real work instead of zeros. */
	private seqReplayResult: Promise<{
		applied: number;
		files: number;
		failed: number;
		deletes: number;
	}> | null = null;
	/** Per-file tick subscribers for the RUNNING replay session. The counts a
	 *  coalescing caller awaits are only half the contract — its progress UI
	 *  also needs the STREAM, and the early return can't reach the exclusive
	 *  call site's `onFileApplied` hand-off. On a first sync the join handler
	 *  always owns the replay (it is one of many bare `catchupViaSeqReplay()`
	 *  callers), so the user's modal ALWAYS coalesces: without this it renders
	 *  a dead 0% bar with no filenames for the whole pull, then one final
	 *  number. Registration is scoped to each caller's own await. */
	/** Destroy-only: this holds in-flight replay CALLBACKS, not vault data, and
	 *  each registration already removes itself in a `finally`. Sweeping it on a
	 *  vault switch would drop a listener out from under a replay that is still
	 *  unwinding; the replay itself is what a switch has to stop, not its
	 *  subscribers. */
	private seqReplayFileListeners = this.track(["destroy"], new Set<(path: string) => void>());
	private seqHealLastAt = 0;
	private seqHealTimer: number | null = null;
	private static readonly SEQ_HEAL_COOLDOWN_MS = 4_000;

	/** Returns the number of ops applied across this replay (incl. any coalesced
	 *  re-run) plus the sets of server note-ids and attachment paths seen
	 *  (non-deleted only) — used by the pull-all-delete / push-all-delete
	 *  choices. A coalesced call that folds into an in-flight replay returns
	 *  applied:0/empty sets — the running call reports the total. `fromZero`
	 *  forces the replay to start at cursor 0 regardless of the persisted
	 *  `catchupSeq` (idempotent re-replay). `enumerateOnly` (implies `fromZero`)
	 *  is a push/replace enumeration pass: it walks the same feed to collect
	 *  `serverIds`/`serverAttachmentPaths` but never applies an op locally
	 *  (`applySyncChange`) and never advances/persists the real `catchupSeq`
	 *  cursor — a "replace remote with local" must download nothing (that would
	 *  materialize remote extras as local orphans, which then resurrect on the
	 *  next sync), and mustn't steal seq progress from a later genuine catch-up. */
	/** Enumerate the FULL current server state from the seq-ordered op-log
	 *  (`crdt_catchup_since` from seq 0). Nothing is applied and the real
	 *  catch-up cursor is untouched — this is a pure read. Ops fold per note_id
	 *  with last-seq-wins, so a rename collapses to its FINAL path (no ghost
	 *  old-path row — better than the retired REST delta, which listed both)
	 *  and a tombstone folds to `deleted: true`. Attachments ride the same feed
	 *  and fold by path. Replaced GET /notes/changes + GET /attachments/changes
	 *  as `computeSyncPlan`'s inventory (#304, REST-purge Bucket C — the
	 *  preview was their last caller). Throws when the channel is not live: the
	 *  preview must error visibly, never render a wrong empty plan. */
	/** Strict forward comparison of the composite `(seq, id)` catch-up cursor.
	 *  Returns true iff `(nextSeq, nextId)` is strictly greater than
	 *  `(curSeq, curId)` — the same keyset ordering the backend queries with. The
	 *  equal-seq case (`nextSeq === curSeq`, `nextId > curId`) is what pages
	 *  correctly across an attachment-move pair (#312). Ids compare as strings:
	 *  canonical UUIDs sort identically byte-wise (Postgres uuid) and lexically. */
	private cursorAdvances(
		nextSeq: number | null,
		nextId: string | null,
		curSeq: number,
		curId: string | null,
	): boolean {
		if (typeof nextSeq !== "number") return false;
		if (nextSeq > curSeq) return true;
		if (nextSeq < curSeq) return false;
		return (nextId ?? "") > (curId ?? "");
	}

	/** Rows per op-log page. The backend clamps `limit` to its own feed cap, so
	 *  this must not exceed it (`merged_changes_page`). */
	private static readonly OP_LOG_PAGE_SIZE = 500;
	/** Loop ceiling for an op-log walk — corruption protection, not a real
	 *  backlog limit (500 rows x 100k pages). */
	private static readonly OP_LOG_MAX_PAGES = 100_000;

	/** Page the seq-ordered op-log (`crdt_catchup_since`) from a start cursor,
	 *  handing every row to `onRow` and each page's end cursor to `onPage`.
	 *
	 *  The single pager for BOTH walkers of this feed — `runSeqReplayOnce` (which
	 *  applies ops and persists the cursor) and `enumerateServerState` (a pure
	 *  read for the sync preview). It owns the mechanics they used to duplicate:
	 *  page size, loop ceiling, the composite {seq,id} advance, and the
	 *  stuck-cursor guard (#378).
	 *
	 *  Fetch errors PROPAGATE — the two callers want opposite things and that is
	 *  the one behaviour that must stay per-caller: the replay swallows them to
	 *  keep the pages it already applied, the preview lets them surface rather
	 *  than render a plan off a short walk. */
	private async walkOpLog(opts: {
		seq: number;
		id: string | null;
		onRow: (c: SyncChange) => void | Promise<void>;
		onPage?: (seq: number, id: string | null) => void | Promise<void>;
	}): Promise<void> {
		const fetchPage = this.crdtCatchupSince;
		if (!fetchPage) return;
		let cursor = opts.seq;
		let cursorId = opts.id;
		for (let page = 0; page < SyncEngine.OP_LOG_MAX_PAGES; page++) {
			const pageStartSeq = cursor;
			const pageStartId = cursorId;
			let resp: Awaited<ReturnType<CrdtCatchupSinceFn>>;
			try {
				resp = await fetchPage(cursor, SyncEngine.OP_LOG_PAGE_SIZE, cursorId);
			} catch (e) {
				// Tagged so a caller can tell a transport failure apart from a failure
				// in its own onRow/onPage work. Both used to look identical.
				throw new OpLogFetchError(cursor, e);
			}
			for (const c of resp.changes) {
				await opts.onRow(c);
				// Advance past every row SEEN (handled or skipped) so the cursor is
				// monotonic and a permanently-unappliable op can't stall the feed.
				// Composite (seq, id): the feed is {seq,id}-sorted and the backend
				// derives its own `next` from the page's LAST row
				// (`merged_changes_page`), so the row-derived max here equals the
				// server's {next_seq, next_id} — one advance rule serves both walkers.
				if (
					this.cursorAdvances(
						typeof c.seq === "number" ? c.seq : null,
						c.id ?? null,
						cursor,
						cursorId,
					)
				) {
					cursor = c.seq;
					cursorId = c.id ?? null;
				}
			}
			await opts.onPage?.(cursor, cursorId);
			if (!resp.has_more) break;
			// Stuck-cursor guard: if a page returned rows but the composite cursor
			// did NOT advance from the page start (a backend quirk / an empty page
			// with has_more), stop rather than refetch the same window forever.
			if (!this.cursorAdvances(cursor, cursorId, pageStartSeq, pageStartId)) break;
		}
	}

	private async enumerateServerState(): Promise<{
		notes: Map<string, { deleted: boolean; content?: string; contentHash?: string }>;
		attachments: Map<string, { deleted: boolean }>;
	}> {
		// The preview reads server state off the live op-log socket. On startup
		// the plan is computed the moment the user channel joins — often before
		// the crdt: topic join lands (onCrdtJoined) — and on a vault switch the
		// stream is torn down and rebuilt underneath us. Both leave the socket
		// briefly non-enumerable; wait for it rather than failing the preview
		// outright (a vault-switch/startup false-negative is worse than a short
		// spinner). Falls through to the offline error only after the budget.
		const deadline = Date.now() + this.enumerateWaitMs;
		while (
			(!this.crdtCatchupSince || !this.crdt || !(this.crdtLive?.() ?? false)) &&
			Date.now() < deadline
		) {
			await this.sleep(100);
		}
		if (!this.crdtCatchupSince || !this.crdt || !(this.crdtLive?.() ?? false)) {
			throw new Error("Sync preview needs the live socket (op-log enumeration)");
		}
		const byId = new Map<string, Extract<SyncChange, { type: "note" }>>();
		const attachments = new Map<string, { deleted: boolean }>();
		// A pure read: no `onPage`, so the real catch-up cursor is never touched.
		// Fetch errors propagate — the preview must fail visibly, never render a
		// wrong (short) plan.
		await this.walkOpLog({
			seq: 0,
			id: null,
			onRow: (c) => {
				if (c.type === "attachment") {
					if (c.path) attachments.set(c.path, { deleted: c.deleted });
				} else if (c.id && c.path) {
					// Both guards: an id-less or path-less row (a folder-marker op
					// leaking into the note feed, mirrored from applyOp) would key
					// the fold on null and surface as a bogus toPull in the plan.
					byId.set(c.id, c);
				}
			},
		});
		const notes = new Map<
			string,
			{ deleted: boolean; content?: string; contentHash?: string }
		>();
		for (const c of byId.values()) {
			notes.set(c.path, {
				deleted: c.deleted,
				content: c.content,
				contentHash: c.content_hash,
			});
		}
		return { notes, attachments };
	}

	async catchupViaSeqReplay(
		opts: {
			fromZero?: boolean;
			enumerateOnly?: boolean;
			/** Fired once per non-deleted note/attachment row successfully applied —
			 *  FILE units (the plan's denominator), not op-log rows. Drives the
			 *  per-file "pulling" progress the UI seeds from the plan. */
			onFileApplied?: (path: string) => void;
			/** When this call COALESCES behind an in-flight replay: true = wait
			 *  for the running session and return its real counts (the sync
			 *  modal's honest-recap path); false/absent = return zeros instantly
			 *  (poll, join handler, exclusive retry loop — callers that must not
			 *  block for a whole replay or claim another caller's work). */
			awaitCoalesced?: boolean;
		} = {},
	): Promise<{
		applied: number;
		/** Non-deleted rows applied without throwing — the "files downloaded"
		 *  count in the same units the sync plan counts. Tombstones and folder
		 *  markers are excluded, so this is the honest "N synced" numerator. */
		files: number;
		/** Rows whose apply threw (logged + skipped so the feed never wedges). */
		failed: number;
		/** Tombstone rows that actually trashed a local file. */
		deletes: number;
		serverIds: Set<string>;
		serverAttachmentPaths: Set<string>;
		/** `true` when THIS call executed the replay loop exclusively (so
		 *  `serverIds`/`serverAttachmentPaths` are real + complete); `false` when it
		 *  COALESCED behind an in-flight replay and returned EMPTY sets. Destructive
		 *  delete decisions MUST trust the sets only when `ran === true` — an empty
		 *  set from a coalesced call would mean "server has nothing" and trash the
		 *  whole vault (the data-loss bug). Non-destructive callers ignore it. */
		ran: boolean;
		/** `false` when a replay pass did not reach the end of the feed (a mid-walk
		 *  fetch failure, or no socket at all), so the server sets are PARTIAL.
		 *  Orthogonal to `ran`: a call can run exclusively and still come back
		 *  incomplete. Destructive delete decisions require BOTH. */
		complete: boolean;
	}> {
		const serverIds = new Set<string>();
		const serverAttachmentPaths = new Set<string>();

		// Gate closed: walk NOTHING. The block used to live per-file inside
		// flushFromCrdt, so a blocked replay still fetched every page, and the
		// server still decrypted and serialised every row, for a pass whose
		// every write was discarded — then the real pass did it all again. That
		// doubling is the prod pull CPU spike.
		//
		// The correctness half is worse. `onPage` persists the catch-up cursor
		// after each page and exempts only `enumerateOnly`, whose comment
		// reasons it exactly right — "a later genuine catch-up needs to still
		// see every op this enumeration walked past, since none of them were
		// applied" — and then misses this case, where equally none of them were
		// applied. So a blocked walk advanced the cursor PAST notes it never
		// wrote, and the next replay resumed after them. They came back only if
		// the manifest validator happened to rewind; that repair machinery is
		// largely compensating for this.
		//
		// `complete: false` is load-bearing: we walked nothing, so the empty
		// server sets are not evidence, and no destructive delete decision may
		// trust them (they require ran && complete).
		if (this.syncBlocked) {
			devLog().log("sync-blocked", "catchupViaSeqReplay skipped — gate closed");
			// Ships even with diagnostics off. Skipping the walk is correct, but a
			// pull that returns nothing because a gate is shut must still be
			// visible — silently doing nothing and reporting success is the bug
			// this whole series came from. One line per blocked attempt, not one
			// per note. Counts only, no paths.
			rlog().anomaly("sync", "catch_up_skipped_sync_gate_closed", { blocked: true });
			return {
				applied: 0,
				files: 0,
				failed: 0,
				deletes: 0,
				serverIds,
				serverAttachmentPaths,
				ran: false,
				complete: false,
			};
		}

		if (this.seqReplayRunning) {
			this.seqReplayAgain = true;
			if (!opts.awaitCoalesced) {
				// Fast-return zeros: the poll, the topic-join handler, and the
				// exclusive destructive loop all depend on a coalesced call being
				// near-instant (blocking the join handler defers the op-queue
				// drain for the whole replay; real counts here fire spurious
				// "pulled N changes" toasts for another caller's work).
				return {
					applied: 0,
					files: 0,
					failed: 0,
					deletes: 0,
					serverIds,
					serverAttachmentPaths,
					ran: false,
					complete: false,
				};
			}
			// Progress-reporting caller (the sync modal): WAIT for the running
			// session and report its real counts. Returning zeros here made a
			// coalesced fullSync tell the progress modal "Already up to date"
			// while the join-triggered replay was still downloading the vault.
			// Safe: seqReplayRunning=true means the running task is suspended at
			// an await INSIDE its loop (the exit path from condition-check to
			// finally has no await), so it always sees the flag we just set.
			//
			// Subscribe to the running session's per-file ticks for the duration
			// of this await, so a progress-reporting coalescer renders the live
			// "Downloading <name>" stream instead of a frozen bar. Ticks already
			// applied before we registered are lost by construction — the counts
			// below still report the session's true totals.
			if (opts.onFileApplied) this.seqReplayFileListeners.add(opts.onFileApplied);
			let running: { applied: number; files: number; failed: number; deletes: number } | null;
			try {
				running = (await this.seqReplayResult?.catch(() => null)) ?? null;
			} finally {
				if (opts.onFileApplied) this.seqReplayFileListeners.delete(opts.onFileApplied);
			}
			return {
				applied: running?.applied ?? 0,
				files: running?.files ?? 0,
				failed: running?.failed ?? 0,
				deletes: running?.deletes ?? 0,
				// Still EMPTY sets + ran:false — the counts are honest but the
				// sets belong to the other caller's walk; destructive decisions
				// keep requiring ran && complete.
				serverIds,
				serverAttachmentPaths,
				ran: false,
				complete: false,
			};
		}
		this.seqReplayRunning = true;
		const session = (async () => {
			let applied = 0;
			let files = 0;
			let failed = 0;
			let deletes = 0;
			let complete = true;
			// FILE-unit dedupe across every pass of this session: the op-log has
			// one row per op, the plan counts folded files — a note with N ops
			// must tick the progress feed once, or `current` outruns the plan's
			// denominator and the bar pins at 100% while files keep arriving.
			const tickedKeys = new Set<string>();
			// This session owns the tick fan-out: its own caller's callback and
			// every coalescer that registers while it runs see the same stream.
			if (opts.onFileApplied) this.seqReplayFileListeners.add(opts.onFileApplied);
			// One bad subscriber must not take down the stream. This runs INSIDE
			// the per-row try that increments `failed`, so an unguarded throw
			// would both mis-count a successfully applied row as failed AND
			// starve every later subscriber — including the exclusive owner's own
			// progress. Pre-fan-out that blast radius was one caller; now it is
			// all of them, so the guard is load-bearing, not defensive noise.
			const emitFileApplied = (path: string): void => {
				for (const listener of [...this.seqReplayFileListeners]) {
					try {
						listener(path);
					} catch (e) {
						devLog().log("sync", `progress subscriber threw for ${path}: ${errMsg(e)}`);
					}
				}
			};
			try {
				do {
					this.seqReplayAgain = false;
					const pass = await this.runSeqReplayOnce(
						(opts.fromZero ?? false) || (opts.enumerateOnly ?? false),
						serverIds,
						serverAttachmentPaths,
						tickedKeys,
						opts.enumerateOnly ?? false,
						emitFileApplied,
					);
					applied += pass.applied;
					files += pass.files;
					failed += pass.failed;
					deletes += pass.deletes;
					// The sets accumulate across coalesced passes, so ONE short pass taints
					// the whole result — never OR this back to true.
					if (!pass.complete) complete = false;
				} while (this.seqReplayAgain);
				// Outcome check. `applied` counts every row the feed handed us;
				// `files` and `deletes` count what actually reached disk. All three
				// passes done and applied > 0 with NOTHING materialised or trashed
				// means the feed did work and the vault got none of it — the shape
				// of the 2026-08-13 prod failure, where 316 note rows arrived, 73
				// folders landed, and not one note did.
				//
				// Shipped via rlog().anomaly so it survives `diagnosticsEnabled:
				// false` (the default). That failure produced ZERO client log lines
				// precisely because a fresh install has telemetry off, which is the
				// same install most likely to hit a first-sync bug. Counts only —
				// no paths — so the setting still protects what it is meant to.
				if (applied > 0 && files === 0 && deletes === 0) {
					// `blocked` is the first thing to look at: a closed first-sync
					// gate silently no-ops every note write while folders (which
					// bypass it) still land. That combination — folders arrive,
					// notes do not — is the 2026-08-13 signature.
					rlog().anomaly("sync", "replay_produced_no_files", {
						applied,
						files: 0,
						deletes: 0,
						failed,
						complete,
						blocked: this.syncBlocked,
					});
				}
			} finally {
				if (opts.onFileApplied) this.seqReplayFileListeners.delete(opts.onFileApplied);
				this.seqReplayRunning = false;
			}
			return {
				applied,
				files,
				failed,
				deletes,
				serverIds,
				serverAttachmentPaths,
				ran: true,
				complete,
			};
		})();
		this.seqReplayResult = session;
		try {
			return await session;
		} finally {
			// Guarded: a new owner can start in the microtask window between the
			// IIFE clearing seqReplayRunning and this continuation running —
			// nulling unconditionally would drop the NEW session's promise.
			if (this.seqReplayResult === session) this.seqReplayResult = null;
		}
	}

	/** Run `catchupViaSeqReplay` for a DESTRUCTIVE delete decision (pull-all wipe,
	 *  push-all replace-remote). Retries until THIS call executes the replay
	 *  exclusively (`ran === true`), so the returned server sets are real and
	 *  complete. A coalesced call (a background catch-up holds the single-flight
	 *  lock) returns EMPTY sets — trusting those would treat every local file as a
	 *  server-absent extra and trash the whole vault. Between attempts we yield a
	 *  short tick so the in-flight replay finishes and releases the lock. Returns
	 *  `null` if contention never clears; the caller MUST abort the delete pass on
	 *  `null` (never delete on untrustworthy sets — "empty set never means server
	 *  empty"). */
	private async catchupViaSeqReplayExclusive(opts: {
		fromZero?: boolean;
		enumerateOnly?: boolean;
		onFileApplied?: (path: string) => void;
	}): Promise<{
		applied: number;
		files: number;
		failed: number;
		serverIds: Set<string>;
		serverAttachmentPaths: Set<string>;
	} | null> {
		for (let attempt = 0; attempt < 10; attempt++) {
			const res = await this.catchupViaSeqReplay(opts);
			if (res.ran) {
				// Ran exclusively but the walk stopped short (socket dropped mid-feed,
				// or no socket at all): the sets are a PARTIAL view of the server. That
				// is just as unsafe as the coalesced empty-set case — every file the
				// walk never reached looks server-absent — so refuse it the same way.
				if (!res.complete) {
					rlog().error(
						"crdt",
						"seq-replay: exclusive replay ended INCOMPLETE (walk stopped short) — refusing to hand back partial server sets",
					);
					return null;
				}
				return res;
			}
			await this.sleep(50);
		}
		return null;
	}

	/** The single catch-up path (socket-only, no REST fallback — a wedged socket
	 *  recovers on reconnect, Todd's call). Five responsibilities a bare op-log
	 *  replay can't cover, run around it — the four below plus
	 *  `validateFromManifest` (E1 #1065), the whole-vault seq integer-diff that
	 *  re-serves consumed-but-unrecorded rows between steps 1 and 2:
	 *   1. `reconcileFromManifest` — trash server-deletes even after op-log GC, and
	 *      seed LOCAL empty-folder markers to the server.
	 *   2. `catchupViaSeqReplay` — replay the seq-ordered op-log for note/attachment
	 *      content (the authoritative delivery path).
	 *   3. `healDivergedLiveBoundNotes` — re-converge any live-bound note the
	 *      op-log replay could not deliver (its seq cursor already advanced past
	 *      the edit on a prior/background catch-up that failed to converge). The
	 *      manifest re-detects the divergence independent of the cursor. Before
	 *      the REST purge, fullSync had its OWN cursor separate from the socket
	 *      replay's, giving a live-bound note a second delivery chance; unifying
	 *      onto one `catchupSeq` removed it, so this restores that guarantee.
	 *   4. `syncExplicitFolders` — pull the server's empty-folder markers to disk
	 *      and propagate remote folder deletes.
	 *  Returns the downloaded FILE count (non-deleted rows applied — the unit the
	 *  sync plan and recap use) plus the count of rows whose apply threw. Never
	 *  throws — mirrors the old pull() error boundary so a caller (fullSync/poll)
	 *  never has to guard it. The manifest is fetched once and shared by the
	 *  validator plus steps 1
	 *  and 3. */
	async catchUp(
		opts: { reportProgress?: boolean } = {},
	): Promise<{ files: number; failed: number; deletes: number }> {
		// FILE-unit progress for the sync UI (fullSync's pull leg). Opt-in: the
		// background poll/reconnect callers emit nothing, exactly as before —
		// they have no progress surface and never emit a terminal "complete".
		let pulledFiles = 0;
		const onFileApplied = opts.reportProgress
			? (path: string): void => {
					this.onSyncProgress?.({
						phase: "pulling",
						current: ++pulledFiles,
						total: 0,
						failed: 0,
						currentPath: path,
					});
				}
			: undefined;
		try {
			// #283: capture before the fetch so reconcileFromManifest can refuse its
			// destructive pass if an OAuth swap lands while the manifest is in flight.
			const authGenAtFetch = this.authGeneration;
			const manifest = await this.api.getManifest(
				this.manifestSeq > 0 ? this.manifestSeq : undefined,
			);
			if (manifest?.unchanged) {
				// E1 (#1065): the vault's change_seq still equals our last fully
				// processed watermark — no server write happened, so the
				// SERVER→LOCAL manifest-driven steps (delete-reconcile, validator,
				// live-bound heal, explicit-folder pull — every server mutation
				// bumps change_seq) have nothing to see. The replay still runs:
				// its cursor is an independent watermark and stays authoritative.
				// seedEmptyFolders is LOCAL→SERVER (retry backstop for a failed
				// handleFolderCreate push) and is NOT gated by the server
				// watermark — an idle vault must not strand a local empty folder
				// forever. Cheap: no-ops when nothing local is untracked.
				await this.seedEmptyFolders();
				const { files, failed, deletes } = await this.catchupViaSeqReplay({
					onFileApplied,
					awaitCoalesced: opts.reportProgress,
				});
				return { files, failed, deletes };
			}
			await this.reconcileFromManifest(manifest, authGenAtFetch);
			const behind = this.validateFromManifest(manifest);
			const { files, failed, deletes } = await this.catchupViaSeqReplay({
				onFileApplied,
				awaitCoalesced: opts.reportProgress,
			});
			const poked = await this.healDivergedLiveBoundNotes(manifest);
			try {
				await this.syncExplicitFolders();
			} catch (e) {
				rlog().error(
					"pull",
					`Explicit-folder sync failed (non-fatal): ${errMsg(e)}`,
					e instanceof Error ? e.stack : undefined,
				);
			}
			// Record the watermark ONLY on a fully-CLEAN pass: a validator rewind
			// or a fired live-bound heal is fire-and-forget work whose convergence
			// hasn't landed yet — recording would let every later poll take the
			// unchanged fast path and never re-check an idle vault (the retry net
			// the heal step exists to be). A thrown step skips this too.
			if (typeof manifest?.change_seq === "number" && behind === 0 && poked === 0) {
				this.setManifestSeq(manifest.change_seq);
				await this.saveData({ manifestSeq: this.manifestSeq });
			}
			return { files, failed, deletes };
		} catch (e) {
			rlog().error(
				"pull",
				`Catch-up failed: ${errMsg(e)}`,
				e instanceof Error ? e.stack : undefined,
			);
			this.onVaultScopedError?.(e);
			// failed:1 so a progress-reporting caller (the sync modal) renders a
			// failure instead of "All synced" — a dead-auth or dead-manifest
			// catch-up must never read as success. Background pollers ignore it.
			return { files: 0, failed: 1, deletes: 0 };
		}
	}

	private async runSeqReplayOnce(
		fromZero: boolean,
		serverIds: Set<string>,
		serverAttachmentPaths: Set<string>,
		/** Session-scoped: keys already counted as downloaded files. Multiple
		 *  op-log rows for the same note/attachment tick the file counter once. */
		tickedKeys: Set<string>,
		enumerateOnly = false,
		onFileApplied?: (path: string) => void,
		/** `complete` is false when the walk did NOT reach the end of the feed, so
		 *  `serverIds`/`serverAttachmentPaths` are a PARTIAL view of the server. Any
		 *  caller making a delete decision must refuse them: a partial set is
		 *  indistinguishable from "the server doesn't have these" and would trash
		 *  every local file the walk never reached. */
	): Promise<{
		applied: number;
		files: number;
		failed: number;
		deletes: number;
		complete: boolean;
	}> {
		// Never walked at all — sets are empty, which must NOT read as "server is
		// empty" to a destructive caller.
		if (!this.crdtCatchupSince || !this.crdt)
			return { applied: 0, files: 0, failed: 0, deletes: 0, complete: false };
		// The seq cursor is per-vault: `seq` is allocated per vault, so a cursor
		// from one vault is meaningless in another. If our recorded per-vault
		// state belongs to a DIFFERENT vault than the active one — an OAuth /
		// account swap whose vault-change reset hasn't reconciled yet — a stale
		// high cursor would suppress the new vault's catch-up entirely (e2e
		// test_48). Replay that vault from genesis instead; applySyncChange is
		// idempotent, so a redundant-from-0 replay is safe.
		const activeVault = this.settings.vaultId ?? null;
		const resumable = !fromZero && this.syncStateVaultId === activeVault;
		let cursor = resumable ? this.getCatchupSeq() : 0;
		// Composite-cursor id (#312), paired with `cursor`. Only resumes from the
		// persisted id when we resume from the persisted seq — a genesis / cross-
		// vault replay starts seq-only (null).
		let cursorId: string | null = resumable ? this.getCatchupId() : null;
		// E1 (#1065): consume a validator rewind atomically at run start. The
		// validator must NOT write the cursor directly — an in-flight replay
		// persists its own monotonically-advanced cursor per page and would
		// silently clobber a direct rewind (catchupViaSeqReplay stays the sole
		// cursor writer). The single-flight loop re-enters here, so a floor set
		// mid-run is picked up by the coalesced re-run.
		if (this.seqRewindFloor !== null && !fromZero) {
			const floored = Math.min(cursor, this.seqRewindFloor);
			// A rewind to a lower seq invalidates the paired id (it belonged to the
			// higher cursor) — resume seq-only from the floor.
			if (floored !== cursor) cursorId = null;
			cursor = floored;
		}
		this.seqRewindFloor = null;
		let applied = 0;
		let files = 0;
		let failed = 0;
		let deletes = 0;
		try {
			await this.walkOpLog({
				seq: cursor,
				id: cursorId,
				onRow: async (c) => {
					if (!enumerateOnly) {
						try {
							const changed = await this.applySyncChange(c);
							applied += 1;
							// FILE units for the progress UI: tombstones, folder-marker rows,
							// and no-op re-applies (rows the vault already matched — applyOp
							// returned false) are op-log bookkeeping, not downloaded files.
							// Counting them made the recap disagree with the plan AND showed
							// a Downloading bar on a sync with nothing to download.
							if (!c.deleted && changed) {
								// One row per op, but the plan (the progress denominator)
								// counts folded FILES — dedupe so a note with N ops ticks once.
								// Keyed by IDENTITY for both kinds: a rename mid-log changes
								// the path but is still one planned file.
								const key = `${c.type === "attachment" ? "a" : "n"}:${c.id ?? c.path}`;
								if (!tickedKeys.has(key)) {
									tickedKeys.add(key);
									files += 1;
									onFileApplied?.(c.path);
								}
							} else if (c.deleted && changed) {
								// A tombstone that actually trashed a local file — surfaced
								// separately so a delete-only poll is still user-visible
								// (review finding: the "pulled N changes" notice vanished
								// when the count moved to non-deleted files only).
								deletes += 1;
							}
						} catch (e) {
							// One bad op (e.g. illegal filename) must not wedge the feed — log
							// and skip, same isolation as pullViaCursor.
							failed += 1;
							rlog().error(
								"crdt",
								`seq-replay: skipped ${noteRef(c.path)} — ${errMsg(e, c.path)}`,
							);
						}
					}
					// Every non-deleted id/path SEEN (applied or skipped) — the
					// pull-all-delete / push-all-delete choices (Tasks 5/5b/6) need the
					// full server id-set and attachment-path-set, not just the
					// successfully-applied subset.
					if (c.type === "attachment") {
						if (!c.deleted) serverAttachmentPaths.add(c.path);
					} else if (c.id && !c.deleted) {
						serverIds.add(c.id);
					}
				},
				onPage: async (seq, id) => {
					// Tracked even when we don't persist, so a fetch failure below logs
					// the cursor the walk actually reached.
					cursor = seq;
					cursorId = id;
					// enumerateOnly must not move the real catch-up cursor — a later
					// genuine catch-up needs to still see every op this enumeration
					// walked past, since none of them were applied.
					if (enumerateOnly) return;
					// Persist the COMPOSITE resume point: an interrupted replay that
					// stopped mid equal-seq pair must resume at (seq, id), not seq-only,
					// or the sibling row is skipped (#312). The gap-heal fence still
					// reads catchupSeq (seq) only — it is untouched. Applies are
					// idempotent, so persisting per page is at-least-once safe.
					this.setCatchupSeq(seq);
					this.setCatchupId(id);
					await this.saveData({
						catchupSeq: this.getCatchupSeq(),
						catchupId: this.getCatchupId(),
					});
				},
			});
		} catch (e) {
			// ONLY a fetch failure is swallowed: it keeps whatever pages already
			// applied (and their persisted cursor), and the next pass resumes from
			// there. Anything else — above all a failed cursor persist — stays loud.
			if (!(e instanceof OpLogFetchError)) throw e;
			rlog().warn("crdt", `seq-replay: ${e.message}`);
			// The walk stopped short, so the server sets are partial. Applied ops are
			// still real (and the cursor is persisted), so the pull itself succeeded —
			// but a delete decision built on these sets would trash every file the
			// walk never reached.
			return { applied, files, failed, deletes, complete: false };
		}
		return { applied, files, failed, deletes, complete: true };
	}

	/** Per-note discovery from a room-open announce that carries a path
	 *  (`crdt_doc_ready`, backend adds `path`). An EMPTY note's genesis integrates
	 *  ZERO Y.Doc ops, so no `note_yjs_update` ever fans out — without this the
	 *  note is only found ~30s later via the level-triggered pull (e2e test_27,
	 *  which materialized it at +31s, 1s past the deadline).
	 *
	 *  The announce is a latency SIGNAL, not a data channel: run the ONE catch-up
	 *  path (`catchupViaSeqReplay`, crdt_catchup_since) NOW rather than waiting for
	 *  the next poll. The announced note's op sits after this device's cursor and
	 *  carries FULL content (empty notes included), so the seq replay materializes
	 *  it via applySyncChange — no per-note socket delta, no history-less adopt
	 *  race. This replaced the retired `crdt_catchup_delta` frame, whose bad_frame
	 *  reply against the single-path backend caused a 0-byte materialize (the
	 *  test_86/test_82 e2e regression). Single-flight coalesced, so an announce
	 *  burst collapses to one replay. Learn the id->path mapping first (discovery
	 *  source + so a downstream delete-wins guard can key off it). Gate-safe and
	 *  failure-isolated: never throws into the caller. */
	async discoverAnnouncedNote(noteId: string, path: string): Promise<void> {
		if (!this.crdt || !this.crdtCatchupSince) return;
		if (this.isSyncBlocked()) return;
		const normalized = normalizePath(path);
		if (this.shouldIgnore(normalized)) return;
		if (this.isLiveBound(normalized)) return; // the live room owns it
		// Already on disk — a content STEP2, a prior converge, or the user made it.
		if (this.app.vault.getAbstractFileByPath(normalized) instanceof TFile) return;
		// A note THIS device deleted must not be resurrected: recentlyDeleted covers
		// the delete-wins window (#970), hasPendingDelete covers one still in the
		// offline queue. The seq replay's applyOp re-checks these per op, but the
		// early return also avoids a pointless replay for a note we're deleting.
		if (this.recentlyDeleted.has(noteId)) return;
		if (this.queue.hasPendingEvidencedDelete(normalized, this.settings.vaultId ?? undefined))
			return;
		try {
			// Learn + persist the id->path mapping (discovery source, like catchup).
			if (this.noteIdMap && this.noteIdMap.pathForId(noteId) !== normalized) {
				this.noteIdMap.set(normalized, noteId);
				await this.saveData({ noteIds: this.noteIdMap.toJSON() });
			}
			this.confirmNoteId(noteId);
			// Converge via the single seq-ordered op-log path — the op carries full
			// content and can never pend (unlike the retired crdt_catchup_delta).
			await this.catchupViaSeqReplay();
		} catch (e) {
			rlog().warn(
				"crdt",
				`discoverAnnouncedNote failed for ${noteRef(path)}: ${errMsg(e, path)}`,
			);
		}
	}

	/** Apply a Yjs update fanned out over the vault channel (`note_yjs_update`)
	 *  to an IDLE note — one with no dedicated CRDT room open right now. Mirrors
	 *  coldReceive's per-note apply, minus the REST getUpdates fetch (the update
	 *  bytes arrive directly in the event, not fetched separately). Skips a note
	 *  the live editor's own room owns (isLiveBound) — that room already applies
	 *  its own crdt_msg frames, so this would be a harmless-but-wasteful double
	 *  apply; skipping it matches Relay's `if (isActive) return`. Skips a note
	 *  not yet confirmed (no server row known) or one this device hasn't mapped
	 *  to a path (first-discovery is pull()'s job, same as coldReceive). Frees
	 *  the doc after a successful apply (hibernateIfIdle) — same reasoning as
	 *  coldReceive. Best-effort: isolates its own failure, never throws. */
	async applyPushedNoteUpdate(
		noteId: string,
		update: Uint8Array,
		head: string,
	): Promise<"applied" | "deferred"> {
		if (!this.crdt) return "deferred";
		// A fan-out for a note THIS device just deleted must not resurrect it —
		// the tombstone (backend #970 delete-wins window) wins regardless of
		// whether a racing catch-up has re-learned the id's mapping. Checked
		// first, before confirmNoteId, so a late fan-out can't re-confirm a
		// deleted id either.
		if (this.recentlyDeleted.has(noteId)) {
			rlog().info("crdt", `fan-out skip (recent local delete): ${noteId}`);
			return "deferred";
		}
		let path = this.noteIdMap?.pathForId(noteId) ?? null;
		if (!path) {
			// NOT just "first-discovery is pull()'s job": a resumed device with a
			// wiped/stale map whose replay cursor is already past this note's row
			// seq (live tail appends don't bump seq — checkpoint owns it) will
			// never see this note in the feed again, and an unchanged change_seq
			// short-circuits the manifest steps too — this fan-out is the ONLY
			// delivery. Heal the map (single-flight manifest reconcile, the same
			// primitive the crdt_doc_ready announce path uses) and retry the
			// lookup once (e2e test_82, local repro 2026-07-22).
			this.ensureNoteIdMapped(noteId);
			await this.idMapReconcileInflight;
			path = this.noteIdMap?.pathForId(noteId) ?? null;
			if (!path) {
				rlog().info("crdt", `fan-out drop: id unmapped after reconcile note=${noteId}`);
				return "deferred"; // genuinely unknown — first-discovery is pull()'s job
			}
			rlog().info("crdt", `fan-out for unmapped id healed via manifest: ${noteRef(path)}`);
		}
		// A fan-out for a mapped note is the server pushing that note's bytes —
		// authoritative proof it has a row. So confirm it here rather than dropping
		// it. Without this, a reconnect (clearConfirmedNoteIds un-confirms every
		// note for write-routing safety) opens a window where fanned-out appends are
		// silently skipped until a slow re-confirmation — the >30s missed-open case
		// (test_web_edit_reaches_obsidian_that_missed_room_open).
		this.confirmNoteId(noteId);
		if (this.isLiveBound(normalizePath(path))) {
			// DELIVER, don't defer (#256/#224). This used to skip, handing open notes
			// to the per-note room — which made the room the SOLE delivery path for
			// exactly the notes the user is watching. A lost or slow room broadcast
			// left the note deaf (#242 added the log line here after the 2026-07-14
			// incident, then healed the symptom via catch-up). Yjs updates are
			// idempotent and commutative, so applying here is a no-op when the room
			// already delivered and the ONLY delivery when it did not. ySync's
			// observer paints the editor, and Obsidian autosaves the painted buffer;
			// nothing in THIS path writes disk (onFlushToDisk early-returns for a
			// bound path — the editor owns the file).
			//
			// Deliberately NOT the cold path: no captureDiskDriftBeforeRemote (by the
			// time isLiveBound is true, bindTo has already reconciled the buffer INTO
			// the Y.Text and nothing here writes disk), and no hibernateIfIdle (the
			// editor owns an open note's lifecycle; onLastViewerRelease frees it).
			//
			// Two edge concerns are tracked in #275, NOT guarded here: (a) applying
			// while the sync gate is closed (first-sync direction choice) could
			// autosave a paint before the user chooses — but an unconditional
			// `syncBlocked` gate here silently drops normal live delivery (the gate is
			// closed during fresh-device setup), so it needs a narrower fix; (b) a
			// bare delta on a history-LESS doc can partially integrate. Both need
			// their own e2e coverage; a broad guard regressed the proven delivery.
			try {
				await this.crdt.applyRemoteUpdate(noteId, update);
				// A fan-out is authoritative proof the server holds this note's row, so
				// record a non-null crdtHead for hasServerNote's write-routing. Its
				// VALUE gates no convergence path (the only reader tests != null), so a
				// still-gapped doc is not stranded: catch-up re-converges it, keyed on
				// serverHash, which this path never advances.
				this.setCrdtHead(path, head);
				return "applied";
			} catch (e) {
				rlog().error(
					"crdt",
					`Live-bound fan-out apply failed for ${noteRef(path)}: ${errMsg(e, path)}`,
					e instanceof Error ? e.stack : undefined,
				);
				return "deferred";
			}
		}
		try {
			// A history-LESS doc (feed-synced, never in IDB) must NOT seed disk drift
			// (doubles the baseline) nor apply the bare delta (incomplete). Adopt full
			// server state + reconcile drift instead (#234). Default to history-full
			// when the manager lacks hasHistory (partial test doubles) so the existing
			// mock-based tests keep the pre-#234 behavior.
			const historyFull =
				typeof this.crdt.hasHistory === "function"
					? await this.crdt.hasHistory(noteId)
					: true;
			if (historyFull) {
				// Merge any un-pushed disk drift into the Y.Doc first, so this remote
				// apply merges with it instead of overwriting it (BUG 2).
				await this.captureDiskDriftBeforeRemote(path, noteId);
				await this.crdt.applyRemoteUpdate(noteId, update);
				// Gap heal: if the applied delta references state this device missed
				// while offline (another device edited the note while this one was off
				// the channel), Yjs PENDS it — the doc has NOT reached `head`.
				// Advancing crdtHead to `head` anyway would make coldReceive's cost
				// gate (getCrdtHead === serverHead → skip) skip the note, so the gap
				// would never heal. Phase E3: the REST full-delta pull is deleted —
				// fire the room re-handshake (cooldown-gated); STEP2's sv-exchange
				// delivers the missing ops over the socket. crdtHead stays
				// unadvanced so the cost gate keeps retrying until a head is
				// actually reached. Deferred: the op did NOT land, so the caller
				// must not stamp its seq (the fence would mask the replay row that
				// carries the content this device is missing — the test_85 class).
				const hadGap =
					typeof this.crdt.hasPendingGap === "function" &&
					(await this.crdt.hasPendingGap(noteId));
				if (hadGap) {
					rlog().warn("crdt", `gap heal: socket re-handshake for ${noteRef(path)}`);
					this.socketConverge(path, noteId);
					return "deferred";
				}
				this.setCrdtHead(path, head); // crdtHead persists under the vault path
			} else {
				const adopted = await this.adoptHistoryLessNote(path, noteId, update, head);
				if (adopted !== "applied") return "deferred";
			}
			this.hibernateIfIdle(path, noteId);
			return "applied";
		} catch (e) {
			// Isolated: log, leave crdtHead unadvanced — the next coldReceive poll
			// (or a subsequent push) will retry convergence. Not freed: a failed
			// apply is left for retry, not hibernated.
			devLog().log("crdt", `applyPushedNoteUpdate: ${path} failed — ${errMsg(e)}`);
			rlog().warn(
				"crdt",
				`Vault-channel update apply failed for ${noteRef(path)}: ${errMsg(e, path)}`,
			);
			return "deferred";
		}
	}

	/** Socket-native re-handshake for a diverged LIVE-BOUND note (single-path
	 *  D3, fix wave 1). Supersedes the original verify-by-text design: text
	 *  equality between the doc's projection and a row snapshot does NOT prove
	 *  the doc holds the server's actual Yjs ops — two independently-typed
	 *  identical bodies are a disjoint lineage, and recording convergence on
	 *  that basis let the doubling class through. Also, that design recorded
	 *  on a match WITHOUT re-registering the room subscription, so a doc that
	 *  happened to already match a DEAD room's row stayed silently deaf.
	 *
	 *  Always fires STEP1 (`reset`+`enroll`) on a diverged row — restores
	 *  main's re-registration semantics unconditionally, no text compare.
	 *  Convergence is recorded separately and ONLY on op-level proof: see
	 *  `commitCrdtConvergence`, fired from CrdtManager's `onSynced` when this
	 *  handshake's syncStep2 lands. Cooldown-gated per
	 *  note_id (`crdtHealCooldown`/`healCooldownMs`) so open+catch-up+heal all
	 *  independently detecting the same divergence collapses to one handshake
	 *  instead of draining the handshake budget (#193 starvation class).
	 *
	 *  Fix wave 2: a poke suppressed by the cooldown COALESCES into one
	 *  trailing fire at window end (`crdtHealTrailingTimers`) instead of being
	 *  dropped — mirrors `scheduleSeqHeal`'s trailing-edge throttle. Dropping
	 *  it silently stranded a deaf note whose single recovery poke landed
	 *  inside the window (CI: `test_deaf_note_survives_handshake_rate_limit_
	 *  and_heals_on_restore`). Never throws. */
	private socketConverge(path: string, noteId: string): void {
		if (!this.crdtEnrollment) return;
		const last = this.crdtHealCooldown.get(noteId);
		const now = Date.now();
		if (last === undefined || now - last >= this.healCooldownMs) {
			this.fireCrdtReHandshake(path, noteId);
			return;
		}
		if (this.crdtHealTrailingTimers.has(noteId)) {
			devLog().log("crdt", `socket converge: cooldown skip for ${path} (already coalesced)`);
			return;
		}
		devLog().log("crdt", `socket converge: cooldown skip for ${path} — arming trailing fire`);
		const remaining = this.healCooldownMs - (now - last);
		const timer = this.time.setTimeout(() => {
			this.crdtHealTrailingTimers.delete(noteId);
			this.fireCrdtReHandshake(path, noteId);
		}, remaining);
		this.crdtHealTrailingTimers.set(noteId, timer);
	}

	/** The actual STEP1 fire, shared by the immediate and trailing-coalesced
	 *  paths in `socketConverge`. Records the cooldown timestamp —
	 *  ONLY called on a real fire, never on a suppressed attempt.
	 *
	 *  DELIBERATELY NOT gated on `isLiveBound`, unlike the enroll sites in
	 *  `pushFile`/`applyCrdtCreateAck`/`flushHeldEditsOnCreateAck`. This one is a
	 *  DELIVERY path, not a pull: `runFlushQueue`'s crdt branch hands a durably
	 *  queued edit to `socketConverge`, and the round-trip is what ships it —
	 *  the server answers a client STEP1 with BOTH a STEP2 and its own STEP1
	 *  (`y_ex` `encode_sync_step1_response_v1`), so the client's reply to that
	 *  carries the pending ops. Gating this on live-bound would silently strand
	 *  every IDLE note's queued edit, which is data loss, not a room saving.
	 *
	 *  It IS a real #1409 contributor — attribution measured it as the top
	 *  client enroll caller — so if these rooms need to go, the fix is to give
	 *  the queue a room-free delivery path, NOT to gate this call. */
	private fireCrdtReHandshake(path: string, noteId: string): void {
		this.crdtHealCooldown.set(noteId, Date.now());
		this.crdtEnrollment?.reset(noteId);
		this.crdtEnrollment?.enroll(noteId);
		rlog().info(
			"crdt",
			`socket converge: re-handshake fired for ${noteRef(path)} note_id=${noteId}`,
		);
	}

	/** Commit a staged convergence (see `pendingConvergence` — staged by BOTH
	 *  the live-bound and the cold catch-up legs since Phase E3) — the ONLY
	 *  place those legs' `serverHash`/`version`/`seq` get written. Wired
	 *  from CrdtManager's `onSynced` (crdt/wiring.ts). Two fire paths, and
	 *  attributing a commit to the wrong one is how a log read goes wrong:
	 *
	 *    1. The ROOM handshake — `NoteProvider.receive` on an inbound syncStep2,
	 *       ONCE per handshake cycle, since the provider latches `synced` and
	 *       only `ProviderRegistry.reset`/`clearSynced` re-arm it. An EMPTY
	 *       syncStep2 still fires it: the provider classifies the frame before
	 *       any size check, and the `length > 1` gate there suppresses only the
	 *       outbound reply. A handshake that carries nothing back still commits,
	 *       which is correct — nothing to send means the doc already holds the
	 *       server's state.
	 *    2. ROOM-FREE delivery — `convergeColdNoteRoomFree` calls
	 *       `ProviderRegistry.markSynced` directly after a `crdt_doc_state` read
	 *       merges (#1409), which invokes the same callback with no handshake
	 *       and no frame. A cold note's commit normally comes from here, not
	 *       from a re-handshake.
	 *
	 *  A consequence worth knowing when reading logs (#484): re-handshakes
	 *  FIRED can legitimately exceed commits. Under continuous remote editing
	 *  the catch-up tick stages a new episode (a fresh `content_hash`
	 *  overwrites the prior stage) and fires again before the previous
	 *  syncStep2 returns; that syncStep2 commits the NEWEST stage and latches
	 *  `synced`, so the second one finds nothing staged and fires nothing. Two
	 *  fires, one commit, no loss. `crdtRehandshakeAttempts` reading 1 every
	 *  time confirms this rather than contradicting it — the counter only
	 *  advances on a REPEATED hash, so all-1s means every fire was a genuinely
	 *  new server revision.
	 *
	 *  There is NO text-verify gate: `staged.content` is the catch-up row's
	 *  checkpoint-lagged plaintext and the doc can rightly converge newer than
	 *  it, so comparing against it wedged the commit permanently (and, in the
	 *  deleted #191 phantom-binding check, produced a false positive on
	 *  roughly a third of commits). Converged means converged — commit.
	 *
	 *  Idempotent and cheap when nothing is staged. Re-resolves the CURRENT path via
	 *  `noteIdMap` rather than trusting the path captured at stage time, so a
	 *  rename (path moved) or delete (id unmapped) between staging and commit
	 *  can't write syncState at a stale/dead path — no separate teardown hook
	 *  needed. Never throws into the CRDT manager's synchronous callback. */
	async commitCrdtConvergence(noteId: string): Promise<void> {
		// Settle a fired durable-queue delivery FIRST (independent of any
		// staged convergence): an inbound frame for this note proves the room
		// round-tripped, so the queued local ops went out on that same live
		// socket — the nudge's job is done and the entry can leave the queue.
		const queued = this.pendingQueueDeliveries.get(noteId);
		if (queued) {
			this.pendingQueueDeliveries.delete(noteId);
			try {
				await this.queue.dequeue(queued.path, queued.vaultId);
				this.issues.clear(queued.path);
				rlog().info(
					"queue",
					`CRDT delivery settled via socket round-trip: ${noteRef(queued.path)}`,
				);
			} catch (e) {
				rlog().warn(
					"queue",
					`CRDT delivery settle failed for ${noteRef(queued.path)}: ${errMsg(e, queued.path)}`,
				);
			}
		}
		const staged = this.pendingConvergence.get(noteId);
		if (!staged) {
			// A settled queue nudge with no staged convergence: the nudge's
			// transient room is done — release it. A frame with NOTHING pending
			// stays a pure no-op (commit fires on every inbound frame).
			if (queued) this.releaseHealRoom(noteId, queued.path);
			return;
		}
		// Relay model: the provider fired onSynced from readSyncMessage — the doc is
		// ALREADY converged with the server (syncStep2 reconciled the full state
		// vector), so there is NO text-verify defer here. The old
		// `projectedText === staged.content` gate wedged permanently whenever the
		// projection differed by a cosmetic byte (frontmatter key order, a trailing
		// newline): the stage never committed, syncState never advanced, and the note
		// re-handshaked forever. Converged means converged — commit.
		//
		// The #191 phantom-binding repair used to sit here, comparing the bound
		// editor's buffer against `staged.content` and forcing a rebind on a
		// mismatch. Deleted (#484): `staged.content` is the catch-up row's
		// checkpoint-lagged plaintext, so on a note being edited remotely the doc
		// rightly converges NEWER than the row and the buffer differs as a matter of
		// course — the same reason the `projectedText` gate above was removed. It was
		// firing on ~a third of commits in a normal editing session. It also could
		// not act on what it found: main.ts stopped wiring `editorRebind` when the
		// CM6 ViewPlugin took over rebinding (main.ts:570), so the repair was a
		// no-op in prod and only the unit tests, which wired the port themselves,
		// ever saw it work. If a real phantom binding needs detecting, it needs a
		// signal that is not "buffer != a stale row snapshot".
		this.pendingConvergence.delete(noteId);
		this.crdtRehandshakeAttempts.delete(noteId);
		const path = this.noteIdMap?.pathForId(noteId);
		if (!path) {
			// Id unmapped since staging (deleted) — nothing to record, and a
			// deleted note must not keep holding a room.
			this.releaseHealRoom(noteId, null);
			return;
		}
		try {
			const boundFile = this.app.vault.getFileByPath(path);
			const stored = this.syncState.get(path);
			const localHash =
				stored?.hash ?? (boundFile ? fnv1a(await this.app.vault.cachedRead(boundFile)) : 0);
			this.patchSyncedRow(path, {
				hash: localHash,
				serverHash: staged.serverHash,
				version: staged.version,
				seq: staged.seq,
			});

			// #339: a STEP2 that delivered CONTENT is proof the server holds a row
			// for this note — we just merged the server's own ops for it. An EMPTY
			// converged doc is NOT proof; genesis stays the correct route there.
			//
			// Via markServerKnown so the placeholder can only fill a hole, never
			// overwrite an authoritative head this note already has.
			if (staged.content) this.markServerKnown(path);
			rlog().info(
				"crdt",
				`socket converge: STEP2 committed ${noteRef(path)} note_id=${noteId}`,
			);
		} catch (e) {
			rlog().warn(
				"crdt",
				`socket converge: commit failed for ${noteRef(path)} note_id=${noteId}: ${errMsg(e, path)}`,
			);
		}
		this.releaseHealRoom(noteId, path);
	}

	/** Release the TRANSIENT heal room once its job is done (fan-out idle
	 *  invariant: an idle note holds NO CRDT room). The diverged-cold-note heal
	 *  and the queued-delivery nudge open a room via reset+enroll; without this
	 *  release the once-per-session `enrolled` mark keeps that room (client doc
	 *  + server SharedDoc) alive for the rest of the session — on mass
	 *  divergence that recreates the connect-storm resource shape the fan-out
	 *  model exists to prevent (e2e canary:
	 *  test_cold_send_over_fanout_opens_no_room). `reset` also clears the
	 *  channel's once-per-doc STEP1 gate so a FUTURE heal can re-handshake.
	 *  A live-bound note keeps its room — the editor owns its lifecycle. */
	/** #1409: the SERVER's half of a release. `releaseHealRoom` reset enrollment
	 *  and closed the local doc and said nothing on the wire, so the server kept
	 *  observing the room and it lived until the 5-minute idle drain. */
	private crdtRelease: ((docId: string) => void) | null = null;

	private releaseHealRoom(noteId: string, path: string | null): void {
		// Re-resolve the CURRENT path — `path` may be the enqueue/staging-time
		// path, and a rename in between would otherwise check liveness (and
		// hibernate) against the stale path and closeDoc a doc the editor still
		// owns at its NEW path (silent data loss, the bind-race class).
		const current = this.noteIdMap?.pathForId(noteId) ?? path;
		if (current && this.isLiveBound(normalizePath(current))) return;
		// Tell the SERVER too, or its observation keeps the room alive for the
		// full idle window no matter what this device does locally. Same gate,
		// both halves — an open editor keeps its warm room.
		this.crdtRelease?.(noteId);
		this.crdtEnrollment?.reset(noteId);
		if (current) {
			this.hibernateIfIdle(current, noteId);
		} else if (this.crdt) {
			// Id unmapped (deleted since staging) — cannot be live-bound; free the
			// doc directly. Best-effort, mirrors hibernateIfIdle.
			try {
				this.crdt.closeDoc(noteId);
			} catch (e) {
				devLog().log("crdt", `releaseHealRoom: closeDoc ${noteId} failed — ${errMsg(e)}`);
			}
		}
	}

	/** Cheap mid-session divergence heal for the just-opened note (rework #6 —
	 *  restores the coverage the removed `verifyConvergenceOnOpen` had, a note
	 *  that missed a live announce/STEP2 during a fan-out storm, WITHOUT its
	 *  per-open synchronous manifest-hash check + forced re-handshake, the
	 *  #203 false-fire that caused the open-path lag). Fire-and-forget from
	 *  file-open: a single note, one STEP1 re-handshake via
	 *  `socketConverge` — cheap even when already converged, since
	 *  the per-note cooldown collapses a redundant fire into a no-op.
	 *  Live-bound-only first cut (design decision iii): a
	 *  just-opened note is live-bound after CrdtLiveViews.refresh(), so this
	 *  covers the real case without a vault-wide heads fetch on every open; an
	 *  idle note is still covered by reconnect catch-up (#5). Never throws. */
	async healNoteOnOpen(path: string): Promise<void> {
		if (!this.crdt) return;
		const normalized = normalizePath(path);
		const noteId = this.noteIdMap?.get(normalized) ?? null;
		if (!noteId) return; // truly unknown — reconnect catch-up discovers it (#5)
		try {
			// Opened but never handshaked (discovered via catch-up/fan-out): the
			// socket re-handshake needs a confirmed server row, so converge it
			// over the seq-ordered op-log instead — a cold note must not stay
			// unmaterialized until the next reconnect. Single-flight coalesced and
			// cursor-based, so an already-converged vault is a near-no-op; the note's
			// op carries full content (the one catch-up path, crdt_catchup_since).
			if (!this.isNoteConfirmed(noteId)) {
				await this.catchupViaSeqReplay();
				return;
			}
			if (!this.isLiveBound(normalized)) return; // idle confirmed notes heal on reconnect (#5)
			this.socketConverge(normalized, noteId);
		} catch (e) {
			rlog().warn("crdt", `healNoteOnOpen ${noteRef(path)}: ${errMsg(e, path)}`);
		}
	}

	/** Ceiling on how long an edit may sit in pendingPostPullPushes while a
	 *  pull runs (issue #244): a long post-swap pull chain — or a pull wedged
	 *  on a half-open connection — kept `pulling` true for 60s+, and deferred
	 *  edits never pushed, so sync looked dead. Instance field so tests can
	 *  shrink it. */
	postPullMaxDeferMs = 5_000;
	private postPullDrainTimer: number | null = null;

	/** Arm a one-shot bounded drain for the deferral above. Draining early is
	 *  safe: pushFile's echo-hash gate filters sync-write echoes either way —
	 *  the deferral only saves redundant echo traffic, it is not a correctness
	 *  gate. The normal end-of-pull drain clears this timer. */
	private schedulePostPullDrain(): void {
		if (this.postPullDrainTimer !== null) return;
		this.postPullDrainTimer = this.time.setTimeout(() => {
			this.postPullDrainTimer = null;
			void this.flushPostPullPushes();
		}, this.postPullMaxDeferMs);
	}

	/** Push any files that were modified during pull. Echo suppression will
	 *  naturally skip sync-engine writes; only real user edits get pushed. */
	private async flushPostPullPushes(): Promise<void> {
		if (this.postPullDrainTimer !== null) {
			this.time.clearTimeout(this.postPullDrainTimer);
			this.postPullDrainTimer = null;
		}
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

	/** Force-pull every note + attachment from the server.
	 *
	 *  @param opts.deleteLocalExtras — if true, wipe local files that have no
	 *    remote counterpart before pulling.
	 */
	async pullAll(opts: { deleteLocalExtras?: boolean } = {}): Promise<number> {
		if (this.syncBlocked) {
			devLog().log("sync-blocked", "pullAll short-circuited — gate closed");
			return 0;
		}
		return this._pullAll(opts.deleteLocalExtras ?? false);
	}

	/** REST-purge Bucket B (Task 5 + 5b): replay the merged notes+attachments
	 *  op-log from cursor 0 instead of a REST `GET /notes/changes`/`GET
	 *  /attachments/changes` fetch. `deleteLocalExtras` no longer blind-wipes
	 *  every local file up front — it compares each locally-mapped note id
	 *  against the replay's authoritative `serverIds` set (notes) and each
	 *  local attachment's path against `serverAttachmentPaths` (attachments),
	 *  trashing only the ones absent from the server (data-loss guard: a
	 *  blind pre-wipe followed by a failed/partial refetch used to strand the
	 *  vault empty). */
	private async _pullAll(wipe: boolean): Promise<number> {
		if (this.pulling) return 0;

		this.syncLog?.clear();
		this.pulling = true;
		this.lastError = "";
		this.emitStatus();

		const label = wipe ? "pullAll(deleteLocalExtras)" : "pullAll";
		devLog().log("pull", `${label}: replaying note op-log from 0`);
		rlog().info("pull", `${label} started — replay from 0`);

		try {
			this.onSyncProgress?.({ phase: "pulling", current: 0, total: 0, failed: 0 });

			// Per-file progress in FILE units (the plan's denominator) — the raw
			// op-count would balloon past the plan on vaults with delete history.
			let pulledFiles = 0;
			const onFileApplied = (path: string): void => {
				this.onSyncProgress?.({
					phase: "pulling",
					current: ++pulledFiles,
					total: 0,
					failed: 0,
					currentPath: path,
				});
			};

			// Destructive wipe MUST decide the trash set from an EXCLUSIVE replay
			// (real, complete server sets). A coalesced replay returns EMPTY sets —
			// treating those as "server has nothing" trashes the whole vault. Abort
			// the wipe rather than trash on untrustworthy sets. Pull-all-keep is
			// non-destructive, so it may coalesce harmlessly.
			let applied: number;
			let pulledFileCount: number;
			let replayFailed: number;
			let serverIds: Set<string>;
			let serverAttachmentPaths: Set<string>;
			if (wipe) {
				const replay = await this.catchupViaSeqReplayExclusive({
					fromZero: true,
					onFileApplied,
				});
				if (!replay) {
					this.lastError =
						"Pull all (delete extras) aborted: could not obtain an exclusive server snapshot (replay contention). Nothing was trashed.";
					devLog().log(
						"error",
						`${label} ABORTED — replay coalesced under contention; refusing to trash`,
					);
					rlog().error(
						"pull",
						`${label} ABORTED — replay never ran exclusively (persistent contention); refusing to trash on an untrustworthy (possibly empty) server set`,
					);
					return 0;
				}
				({
					applied,
					files: pulledFileCount,
					failed: replayFailed,
					serverIds,
					serverAttachmentPaths,
				} = replay);
			} else {
				// Keep-branch needs the from-zero replay to ACTUALLY run too: a
				// coalesced call rides an incremental session (fromZero silently
				// dropped), so files behind the persisted cursor never re-download
				// while the recap claims a completed restore. Bounded retry until
				// this call runs the replay itself — but unlike the wipe, an
				// INCOMPLETE walk is fine: pulled files are real and nothing is
				// trashed off the partial sets.
				let replay: {
					applied: number;
					files: number;
					failed: number;
					serverIds: Set<string>;
					serverAttachmentPaths: Set<string>;
				} | null = null;
				for (let attempt = 0; attempt < 10; attempt++) {
					const res = await this.catchupViaSeqReplay({ fromZero: true, onFileApplied });
					if (res.ran) {
						replay = res;
						break;
					}
					await this.sleep(50);
				}
				if (!replay) {
					this.lastError =
						"Pull all aborted: another sync is running (replay contention). Try again when it finishes.";
					rlog().warn("pull", `${label} ABORTED: replay never ran exclusively`);
					return 0;
				}
				({
					applied,
					files: pulledFileCount,
					failed: replayFailed,
					serverIds,
					serverAttachmentPaths,
				} = replay);
			}

			devLog().log(
				"pull",
				`${label}: replay applied=${applied}, serverIds=${serverIds.size}, serverAttachmentPaths=${serverAttachmentPaths.size}`,
			);
			rlog().info("pull", `${label} replay done — applied=${applied}`);

			let deleteFailed = 0;
			if (wipe) {
				// Suppress delete sync — these are locally-decided extras, not a
				// server-originated delete; stays true until the local trash pass
				// below finishes (Obsidian's delete events fire asynchronously).
				this.suppressDeletes = true;
				const files = this.app.vault.getFiles();
				const extras = files.filter((f) => {
					if (!this.isSyncable(f) || this.shouldIgnore(f.path)) return false;
					return this.isBinaryFile(f)
						? !serverAttachmentPaths.has(f.path)
						: !serverIds.has(this.noteIdMap?.get(f.path) ?? "");
				});
				const total = extras.length;
				this.onSyncProgress?.({ phase: "deleting", current: 0, total, failed: 0 });
				for (let i = 0; i < extras.length; i++) {
					const file = extras[i]!;
					try {
						await this.trashRemotelyDeleted(file);
						this.logEntry("delete", file.path, "ok", undefined, "wipe");
					} catch (e) {
						deleteFailed++;
						const msg = errMsg(e);
						this.logEntry("delete", file.path, "error", msg);
					}
					this.onSyncProgress?.({
						phase: "deleting",
						current: i + 1,
						total,
						failed: deleteFailed,
						currentPath: file.path,
					});
					// Yield to UI thread periodically so progress modal can repaint
					if ((i + 1) % 20 === 0) {
						await this.sleep(0);
					}
				}
				devLog().log(
					"pull",
					`${label}: trashed ${extras.length - deleteFailed} local extras (failed=${deleteFailed})`,
				);
				rlog().info(
					"pull",
					`${label} trashed ${extras.length - deleteFailed} local extras`,
				);
			}

			// The recap counts FILES (the plan's unit), not op-log rows — `applied`
			// includes tombstones and superseded rows and overshoots the plan's
			// promise on any vault with delete history. Failures are real: replay
			// rows that threw plus local-extra trashes that failed.
			this.onSyncProgress?.({
				phase: "complete",
				current: pulledFileCount,
				total: pulledFileCount,
				failed: replayFailed + deleteFailed,
			});

			devLog().log(
				"pull",
				`${label}: done — files=${pulledFileCount} (ops applied=${applied})`,
			);
			rlog().info("pull", `${label} done — files=${pulledFileCount} (ops=${applied})`);
			return pulledFileCount;
		} catch (e) {
			// biome-ignore lint/suspicious/noConsole: error boundary
			console.error("Engram Sync: pullAll failed", e);
			devLog().log("error", `pullAll failed: ${errMsg(e)}`);
			rlog().error(
				"pull",
				`PullAll failed: ${errMsg(e)}`,
				e instanceof Error ? e.stack : undefined,
			);
			this.lastError =
				e instanceof Error ? `Pull all failed: ${e.message}` : "Pull all failed";
			return 0;
		} finally {
			this.pulling = false;
			this.suppressDeletes = false;
			this.emitStatus();
			await this.flushPostPullPushes();
		}
	}

	/** Reshape a live stream event + resolved body into the single `SyncOp` shape
	 *  so the CRDT-managed first-delivery / rename new-leg both converge through
	 *  `applyOp`. */
	private eventToOp(event: NoteStreamEvent, content: string | undefined, id: string): SyncOp {
		return {
			kind: "upsert",
			id,
			path: event.path,
			content,
			content_hash: event.content_hash,
			folder: event.folder ?? "",
			title: event.title ?? "",
			tags: event.tags ?? [],
			// Absence stays absence — see the SyncOp field doc and the guard
			// comment in handleStreamEvent (client-receipt time must become
			// undefined, not a value).
			mtime: event.mtime,
			updated_at: event.updated_at,
			version: event.version,
		};
	}

	/** Tail of the serialized stream-event chain. See `handleStreamEvent`. */
	private streamTail: Promise<void> = Promise.resolve();

	/** Handle a WebSocket stream event (upsert or delete), STRICTLY IN ARRIVAL
	 *  ORDER — one event's application completes before the next begins.
	 *
	 *  The server orders the two legs of a rename deliberately: the new path's
	 *  upsert is broadcast BEFORE the old path's delete, at every rename seam
	 *  (`Notes.rename_note`, `do_rewrite_note`, the folder-rename fan-out), so
	 *  that a receiver relocates the note's id first and the delete then reads
	 *  as a relocation leg rather than a genuine death. The delete branch's
	 *  guards are written on exactly that premise.
	 *
	 *  The client used to throw that ordering away: `onEvent` fired
	 *  `void handleStreamEvent(event)` per frame, so the two legs ran as
	 *  concurrent async tasks and either could reach its decision point first.
	 *  When the delete won, `pathForId` still answered the OLD path, so the
	 *  rename read as a genuine delete: the note's id was tombstoned for the
	 *  60s delete-wins window and its Y.Doc destroyed. Both convergence paths
	 *  then skipped the note (`fan-out skip (recent local delete)`,
	 *  `op-replay skip`) and the editor's doc was gone
	 *  (`NoteDestroyedError`) — a rename that lands and then silently stops
	 *  syncing until a reload or the TTL. Reported live after a web-app rename,
	 *  2026-08-18.
	 *
	 *  Serializing here rather than at the call site keeps the guarantee with
	 *  the invariant that depends on it, and gives it to every caller and test.
	 *  Errors are isolated per event so one rejection cannot poison the tail.
	 *
	 *  ponytail: head-of-line blocking is the accepted cost — a slow event now
	 *  delays later ones. These handlers already await disk and network, and
	 *  unordered application is the bug. Per-note lanes if it ever matters. */
	handleStreamEvent(event: NoteStreamEvent): Promise<void> {
		const applied = this.streamTail.then(() => this.applyStreamEvent(event));
		// The TAIL is bounded, the event is not. Serializing means a single event
		// that never settles stops every later one for the life of the session --
		// a total sync stall, not merely added latency. The stalled event keeps
		// running (it cannot be cancelled); the queue simply stops waiting on it.
		this.streamTail = new Promise<void>((resolve) => {
			let settled = false;
			const release = () => {
				if (settled) return;
				settled = true;
				this.time.clearTimeout(timer);
				resolve();
			};
			const timer = this.time.setTimeout(() => {
				if (settled) return;
				settled = true;
				rlog().warn(
					"ws",
					`Stream event still running after ${STREAM_EVENT_STALL_MS}ms — releasing the queue so later events are not blocked`,
				);
				resolve();
			}, STREAM_EVENT_STALL_MS);
			applied.then(release, release);
		});
		return applied;
	}

	private async applyStreamEvent(event: NoteStreamEvent): Promise<void> {
		if (this.syncBlocked) {
			devLog().log("sync-blocked", "handleStreamEvent short-circuited — gate closed");
			return;
		}
		if (this.shouldIgnore(event.path)) return;
		devLog().log("ws", `${event.event_type} ${event.kind ?? "note"}: ${event.path}`);
		rlog().info(
			"ws",
			`Event: ${event.event_type} ${event.kind ?? "note"}: ${noteRef(event.path)}`,
		);

		const isAttachment = event.kind === "attachment";

		// Never trust inline-EMPTY content when a content_hash is present (e2e
		// test_34 "received=yes materialized=no"): the folder-rename cascade
		// broadcasts meta-projected rows whose nil content the backend fabricates
		// as "" while content_hash carries the REAL body hash. Taking "" as
		// authoritative materializes a 0-byte file whose CAS seed (hash("") +
		// real serverHash) then reads "converged" to every backstop, so the empty
		// file sticks forever. Strip the inline body here: the CRDT consumer
		// below then routes to the op-log seq-replay (rows carry the real,
		// verified bytes — Phase E3 deleted its fetch), and the legacy consumer
		// heals via that same seq-replay (getNote-for-sync deleted, #310). A
		// genuinely empty note converges
		// via its replay row, which also TEACHES the empty hash (see
		// emptyContentHash / applyChange): later inline "" beside that exact
		// hash is trustworthy without a round-trip. A stale learned value (DEK
		// rotation, account swap) simply stops matching — the failure direction
		// is an extra replay/fetch, never a 0-byte write.
		//
		// ...EXCEPT that the learn is vault-wide and cannot be, because
		// content_hash is a per-user HMAC: hmac("") is ONE constant for the whole
		// vault, so `hash === emptyContentHash` proves "this hash means empty",
		// NOT "this note is empty" (#1377). A note whose last checkpoint was empty
		// but which now has uncheckpointed ops carries that same H_empty as its
		// STORED hash — #1375 deliberately keeps the facade's — while the feed
		// serves its REAL body under it. The cascade broadcast that follows then
		// matches the learned value and zeroes the body the feed just delivered.
		//
		// Note-scoping the learn would not fix it and would delete the
		// optimization: trusting "" only for a note already known empty buys
		// nothing, since writing "" over an empty note is a no-op. The real
		// discriminator is not WHICH note but whether the write DESTROYS bytes —
		// trusting inline "" is only ever harmful against a local file that has
		// some. `stat.size` answers that without reading the file, and the
		// distrust path is the same one that already heals via the op-log rows.
		//
		// WHICH write this protects: the legacy `applyChange` fallback below.
		// The CRDT branch's two inline-apply sites are already gated on
		// `!getAbstractFileByPath(np)`, so they cannot overwrite an existing
		// file no matter what this decides — a guard keyed on "a file with
		// bytes exists" is inert there by construction. `applyChange` has no
		// such gate and will happily write "" over a populated file.
		//
		// Probe by ID, not by `event.path`. A folder-rename cascade — the shape
		// that produces these meta-projected broadcasts in the first place —
		// names the NEW path while the bytes are still at the OLD one, and
		// `moveIfIdRelocated` only relocates them further down. Reading
		// `event.path` there sees no file, scores 0 bytes, and trusts the ""
		// that is about to land on the file the relocation just moved.
		const emptyTrustPath =
			(event.id ? this.noteIdMap?.pathForId(event.id) : null) ?? event.path;
		if (
			event.event_type === "upsert" &&
			event.content === "" &&
			event.content_hash &&
			(event.content_hash !== this.emptyContentHash ||
				(this.app.vault.getFileByPath(normalizePath(emptyTrustPath))?.stat?.size ?? 0) > 0)
		) {
			rlog().info(
				"ws",
				`Inline-empty body distrusted, routing to catch-up: ${noteRef(event.path)}`,
			);
			event.content = undefined;
		}

		// Id-keyed relocation must run BEFORE echo suppression: an echo-skipped
		// upsert at the NEW path would otherwise leave this device's CRDT room
		// bound to the OLD path, which then perpetually resurrects it (e2e
		// test_10). moveIfIdRelocated is idempotent — it no-ops unless the id
		// already maps to a different local path. Gated on a known id
		// (attachments aren't keyed).
		if (event.event_type === "upsert" && !isAttachment) {
			// RENAME TRACE (1/3). The guard below requires `event.id`; without it
			// the relocation check never runs at all and the note falls through to
			// discovery, which materializes a NEW file while the delete leg trashes
			// the old one. That is indistinguishable in the logs from a relocation
			// that ran and declined, so record which one happened.
			// Hoisted, not inlined: the gate's sanctioned-wrapper pattern allows one
			// level of nesting inside `noteRef(...)`, so a lookup call inside the
			// argument falls through to the namey check and trips it.
			const idHome = event.id ? (this.noteIdMap?.pathForId(event.id) ?? null) : null;
			const holder = event.id
				? (this.noteIdMap?.get(normalizePath(event.path)) ?? "none")
				: "n/a";
			// `diag`, not `info`: one line per inbound upsert is one line per note on
			// a first sync. Kept rather than deleted because these three lines are
			// what finally made this diagnosable -- but behind the diagnostics
			// switch, where per-note volume is the point.
			rlog().diag(
				"pull",
				`rename-trace 1/3 upsert id=${event.id ?? "MISSING"} -> ${noteRef(event.path)} ` +
					`mapSaysIdLivesAt=${noteRef(idHome)} mapSaysTargetHolds=${holder}`,
			);
		}
		if (event.event_type === "upsert" && !isAttachment && event.id) {
			// eventTs must be on the SAME clock base as the pull path's relocationTs
			// (Date.parse(c.updated_at), server clock) — NOT event.timestamp, which
			// is Date.now() at client receipt (channel.ts). Cross-base comparison
			// fails open: client-receipt time is almost always newer than a past
			// server updated_at, so a stale backward WS relocation would win over
			// (and then block the corrective re-pull from) a just-applied forward
			// one. NaN (missing/malformed updated_at) becomes undefined, same as
			// the pull path, which disables the staleness guard rather than
			// comparing garbage.
			const wsRelocationTs = Date.parse(event.updated_at ?? "");
			await this.moveIfIdRelocated(
				event.id,
				event.path,
				Number.isNaN(wsRelocationTs) ? undefined : wsRelocationTs,
			);
		}

		// Echo suppression — skip UPSERT events for notes we're currently pushing
		// or have recently finished pushing (the server broadcasts our own push
		// back to us). DELETE is exempt: a delete is never an echo of a content
		// push, and suppressing it lets a renamed-away old path linger forever
		// when the receiver resurrected it into the push set (id-keyed rename —
		// its CRDT room is still bound to the old path, so channel traffic
		// re-pushes it). A redundant delete just no-ops in the delete branch below.
		if (event.event_type !== "delete") {
			if (this.pushing.has(event.path)) {
				rlog().info("ws", `Echo skip (pushing): ${noteRef(event.path)}`);
				return;
			}
			if (this.files.has(event.path, "pushed")) {
				rlog().info("ws", `Echo skip (recently pushed): ${noteRef(event.path)}`);
				return;
			}
		}

		// Protocol rev — hash-compare dedupe: if the event's content_hash
		// matches the server hash we already hold for this path, the local
		// copy is current; skip without touching the vault or the network.
		// Attachments included since 2026-08-23 (Engram#961): the broadcast now
		// carries content_hash, and `applyAttachmentChange` records the
		// server's hash on receive — so this can finally match for a blob and
		// save a full multi-MB GET whose only outcome was "unchanged". Before
		// both halves existed the check could never fire for an attachment,
		// which is why it was excluded.
		if (event.event_type === "upsert" && event.content_hash !== undefined) {
			const stored = this.syncState.get(normalizePath(event.path));
			if (stored?.serverHash === event.content_hash) {
				if (event.version != null && event.version !== stored.version) {
					this.patchSyncedRow(normalizePath(event.path), { version: event.version });
				}
				rlog().info("ws", `Hash skip: ${noteRef(event.path)}`);
				return;
			}
		}

		if (event.event_type === "delete") {
			const normalized = normalizePath(event.path);
			// Origin-attributed self-echo (#970): the server stamps the REST
			// caller's X-Device-Id into delete broadcasts. A delete WE caused
			// must never be re-applied to our own vault. Upserts keep their
			// existing suppression (pushing/recentlyPushed/hash-skip) — their
			// echoes also drive id-relocation, so they are not dropped here.
			if (this.deviceId && event.device_id === this.deviceId) {
				rlog().info("ws", `Echo skip (own device): ${noteRef(event.path)}`);
				return;
			}
			// A delete is an AUTHORITATIVE CRDT operation applied directly here — no
			// REST pull, no resurrection. It is id-keyed: `targetId` is the note the
			// delete addresses (the broadcast carries `event.id`), `currentId` is the
			// note currently live at the path. If they differ, a delete→recreate at
			// this path minted a fresh id — the delete is for a DEAD id, so leave the
			// recreated note (and its live room) alone. Otherwise apply it: the
			// CRDT-native resolution the old REST-pull defer could not do (the pull
			// never trashed a note merely absent from the server, so a real remote
			// delete of a live confirmed note was silently dropped — e2e test_47).
			const currentId = this.noteIdMap?.get(normalized) ?? null;
			const targetId = event.id ?? currentId;
			// Rename old-leg guard: the backend now emits the upsert for the NEW
			// path BEFORE this delete for the OLD path, so moveIfIdRelocated already
			// relocated the id to its new path. If the id now lives at a DIFFERENT
			// live path, this delete is the stale old leg — tearing down its room by
			// id (below) would destroy the very doc the new-path upsert must
			// materialize from (e2e test_34 "received=yes materialized=no"; test_10).
			// A genuine delete does NOT relocate the id (no upsert-new elsewhere), so
			// pathForId resolves to this path or null → not relocated → normal delete.
			const roomId = targetId ?? currentId;
			const relocatedPath = roomId ? (this.noteIdMap?.pathForId(roomId) ?? null) : null;
			const relocated = relocatedPath !== null && normalizePath(relocatedPath) !== normalized;
			if (relocated) {
				// The id's room now belongs to the NEW path (moveIfIdRelocated
				// relocated it), so its doc must survive — the new-path upsert
				// materializes from it. NEVER tear the room down (removeDoc/reset).
				// But the stale file at the OLD path must still be trashed, or it
				// lingers forever (e2e test_34 "Cleanup.md still exists after 30s").
				// Trash it like a normal delete: trashRemotelyDeleted marks
				// remotelyDeleted so this device's own vault-delete event is
				// echo-suppressed and never re-pushed. A rename changes no content,
				// so the bytes are preserved at the new path — no drift keep-both copy.
				const existing = this.app.vault.getFileByPath(normalized);
				// The id has moved to `relocatedPath`. If nothing is there yet, this
				// file IS the note -- move it rather than destroying it and leaving
				// the upsert to build a replacement. Trashing here is only correct
				// once the note exists at its new home.
				//
				// Reachable whenever the delete leg is applied before the upsert.
				// The server orders them the other way and the engine now preserves
				// that order, so this is the belt to that braces: if the delete ever
				// does arrive first, the difference is a moved file versus a
				// destroyed-and-rebuilt one.
				if (
					existing &&
					!this.app.vault.getAbstractFileByPath(normalizePath(relocatedPath))
				) {
					await this.renameFollowingIdentity(normalized, normalizePath(relocatedPath));
					if (this.app.vault.getFileByPath(normalizePath(relocatedPath))) {
						rlog().info(
							"ws",
							`Delete is rename old-leg — file moved to its new home: ${noteRef(normalized)}`,
						);
						return;
					}
				}
				if (existing) {
					// Carry the merge base to the note's new home BEFORE trashing the
					// old file. This is the only point that knows both paths: the
					// vault delete event this trash fires reaches `handleDelete`
					// knowing only the old one, so a base left behind there is
					// destroyed outright. The note then has no common ancestor at its
					// new path and the next divergence resolves by writing a conflict
					// copy -- the same failure the mover's own base carry exists to
					// prevent, one branch over.
					this.baseStore?.rename(normalized, normalizePath(relocatedPath));
					// Carry "this is a rename's old leg" across the trash boundary.
					// applyRemoteRemoval fires a vault delete event, and handleDelete
					// cannot otherwise tell it apart from a note genuinely dying — so
					// it tore down the id's CRDT doc, destroying the very room this
					// branch exists to preserve. The doc stayed destroyed
					// (`NoteDestroyedError` on every later read, re-enrolment does not
					// revive a destroyed Y.Doc), which is the live half of the
					// 2026-08-18 "rename lands, then typing stops syncing" report.
					this.files.mark(normalized, "renamedAway", ECHO_COOLDOWN_MS);
					await this.applyRemoteRemoval(existing);
				}
				// Only clear a stale old-path→id mapping if one still points at the
				// relocated room; leave the id's room mapping (new path) intact.
				if (this.noteIdMap?.get(normalized) === roomId) this.noteIdMap.delete(normalized);
				rlog().info(
					"ws",
					`Delete is rename old-leg (id relocated to ${noteRef(relocatedPath)}); old path trashed, room preserved: ${noteRef(normalized)}`,
				);
				return;
			}
			const existing = this.app.vault.getFileByPath(normalized);
			if (existing && targetId && currentId && targetId !== currentId) {
				rlog().info(
					"ws",
					`Delete for dead id ${targetId} ignored — ${noteRef(normalized)} recreated as ${currentId}`,
				);
				return;
			}
			if (existing) {
				// Applying the delete trashes + tears down the note's CRDT room, which
				// would discard local UNPUSHED drift. A rename emits a delete for the
				// old path (delete-first is the common order), so a note renamed on
				// another device while THIS device has un-synced edits would lose that
				// drift. Preserve it FIRST as a keep-both conflict copy (mirrors
				// adoptHistoryLessNote's no-LCA keep-both), then trash. The copy is
				// gated on the room actually holding undelivered work — see
				// shouldKeepDriftCopy for why the drift proxy alone is not enough.
				// Best-effort: a copy failure must not block the delete.
				try {
					const disk = await this.app.vault.cachedRead(existing);
					if (this.shouldKeepDriftCopy(normalized, disk, targetId ?? currentId)) {
						const copy = await this.writeDriftConflictCopy(normalized, disk);
						rlog().info(
							"conflict",
							`received-delete drift → keep-both | original=${noteRef(normalized)} copy=${noteRef(copy)}`,
						);
					}
				} catch (e) {
					rlog().warn(
						"conflict",
						`received-delete drift check failed for ${noteRef(normalized)}: ${errMsg(e, normalized)}`,
					);
				}
				// trashRemotelyDeleted marks remotelyDeleted, so this device's own
				// vault-delete event is echo-suppressed and never re-pushed (the
				// 2026-07-08 wipe-echo invariant, test_86).
				await this.applyRemoteRemoval(existing);
			}
			// Tear down the CRDT doc for md paths regardless of whether the file
			// existed locally. The ghost lineage in IDB/memory must be cleared so a
			// note recreated at the same path starts fresh (P1-3). Non-md paths are
			// never CRDT-managed — skip them to avoid spurious removeDoc overhead.
			// Keyed by the DELETE's target id (the recreate case returned above, so
			// here targetId == currentId or one is null): clear the path mapping and
			// tear down the room for that id.
			if (this.isCrdtEligiblePath(normalized)) {
				this.noteIdMap?.delete(normalized);
				const roomId = targetId ?? currentId;
				if (roomId) {
					await this.teardownCrdtDoc(roomId);
				}
			}
			return;
		}

		if (event.event_type === "upsert") {
			// Id-keyed relocation already ran above (hoisted before echo
			// suppression so an echo-skipped rename still relocates the room).
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
				} else if (
					this.crdt &&
					this.isCrdtEligiblePath(event.path) &&
					(event.id ?? this.noteIdMap?.get(event.path))
				) {
					// C1: CRDT owns markdown content for this session — the crdt: topic
					// delivers updates via CrdtChannel/flushFromCrdt. The legacy
					// note_changed/upsert path must not double-write the body, which
					// would create a feedback loop (disk write re-enters handleModify →
					// applyLocalEdit).
					// Vault-channel fan-out: an IDLE note received here converges
					// room-free over the note_yjs_update broadcast
					// (applyPushedNoteUpdate) or the pull backstop — enrolling a room
					// for it would defeat the fan-out isolation and re-open the connect
					// storm (a room per note that ever received a live edit). Enroll
					// ONLY when the note is live-bound (open in the editor), matching the
					// pull-path discovery gate (isLiveBound) at applyChange below.
					// Rooms are keyed by note_id, so resolve it: prefer the id the
					// server's broadcast now carries (a device that has NEVER seen this
					// note learns it here), else the locally-known sidecar mapping. Learn
					// + confirm it so subsequent local edits route through CRDT. If
					// NEITHER source yields an id we don't reach this branch — control
					// falls through to the legacy apply below, which materializes the
					// note directly (pre-id-keying behavior; without this fallback a
					// never-seen note is received but silently never written to disk).
					const noteId = (event.id ?? this.noteIdMap?.get(event.path)) as string;
					// STALE-PATH GUARD (round 2, e2e test_34 mechanism): moveIfIdRelocated
					// above already decided whether `event.path` is this id's current
					// canonical path (it declines a stale/out-of-order relocation — see
					// its own staleness gate). If the map now disagrees with this event's
					// path, learning it here would silently undo that decision: it would
					// re-key the map BACKWARD to the stale path (a bijection `set()`
					// evicts the correct, just-established mapping) and materialize a
					// stale-path file the relocation guard just decided not to touch.
					// Skip path-learning/materialize entirely for a stale event; the
					// canonical mapping (and file) already in place stands.
					const canonicalPath = this.noteIdMap?.pathForId(noteId) ?? null;
					if (
						canonicalPath !== null &&
						normalizePath(canonicalPath) !== normalizePath(event.path)
					) {
						rlog().info(
							"ws",
							`Stale-path upsert ignored for ${noteId}: canonical=${noteRef(canonicalPath)} event=${noteRef(event.path)}`,
						);
					} else {
						this.noteIdMap?.set(event.path, noteId);
						this.confirmNoteId(noteId);
						// Canvas enrolls even when idle — it converges over the Yjs
						// handshake ONLY (no seq-feed content fallback), so a room is the
						// sole way to pull its state; markdown stays idle-room-free (fan-out).
						if (
							this.isCanvasPath(normalizePath(event.path)) ||
							this.isLiveBound(normalizePath(event.path))
						) {
							this.crdtEnrollment?.enroll(noteId);
						}
						// SEED the CAS base from the event when none exists — the CRDT
						// delivery that writes the body never advances serverHash (issue
						// #203), so a device whose only knowledge of this note came
						// through here had NO base for its later REST-fallback push
						// (channel down = the missed-delivery scenario) and silently
						// overwrote server content it never saw (e2e test_83).
						// Seed-only, never advance: serverHash means "server content this
						// device actually CONVERGED to" everywhere it is read (hash-skip,
						// computeSyncPlan's inventory). Stamping the
						// announced hash over a real converged base would mark the note
						// converged before the body lands — a missed room delivery then
						// sticks silently, with every recovery path defeated. A stale
						// seeded base errs toward a false 409/conflict copy, the safe
						// direction. Gate on "no base yet", not file existence: the room
						// delivery can race the file onto disk before this event runs.
						const np = normalizePath(event.path);
						// Captured BEFORE the CAS-seed below (which creates an entry):
						// undefined means this device has NO prior record of the note
						// (a genuine first delivery, not a converged/raced one).
						const priorState = this.syncState.get(np);
						if (event.content_hash !== undefined) {
							if (priorState?.serverHash === undefined) {
								this.stampSyncedRow(np, {
									hash: priorState?.hash ?? fnv1a(""),
									version: event.version ?? priorState?.version,
									serverHash: event.content_hash,
								});
							}
						}
						rlog().info(
							"ws",
							`CRDT-managed: skipping legacy body apply for ${noteRef(event.path)}`,
						);
						// First-delivery materialization (Phase C step 2). A never-seen note
						// (no prior baseline, no local file) materializes here; one with a
						// prior baseline converges via its CRDT/pull path, a live-bound one
						// via its editor room — both left alone. When the op carries
						// AUTHORITATIVE inline content, converge through the SINGLE apply
						// path (applyOp) — this folds in the old hand-rolled
						// first-delivery + rename new-leg (#189/#210/test_34) writes
						// uniformly by id. When it does NOT (hash-only / meta-projected
						// #863, or a live-bound / synced first delivery), NEVER fetch
						// (Phase E3 — getNote-for-sync is deleted): fall back to the doc
						// projection (materializeRelocated, isSynced-gated) then the
						// op-log seq-replay, whose rows carry the real content.
						const synced =
							typeof this.crdt.isSynced === "function" && this.crdt.isSynced(noteId);
						// Idle first-delivery: a never-seen, not-live-bound, unsynced note
						// materializes from its inline body through the single apply path.
						if (
							priorState === undefined &&
							!synced &&
							!this.isLiveBound(np) &&
							!this.app.vault.getAbstractFileByPath(np)
						) {
							if (event.content !== undefined)
								await this.applyOp(this.eventToOp(event, event.content, noteId));
						}
						// Rename new-leg carrying inline content → single apply path (from the
						// op's own content, by id). Otherwise fall back to the doc projection
						// (materializeRelocated, isSynced-gated) then the op-log seq-replay —
						// this else covers a content-absent / meta-projected-nil relocation
						// (#863) AND a note whose baseline moveIfIdRelocated already carried
						// to the new path (priorState defined), which the first-discovery
						// materialize (gated on priorState === undefined) skips.
						if (
							priorState === undefined &&
							event.content !== undefined &&
							this.noteIdMap?.pathForId(noteId) === np &&
							!this.app.vault.getAbstractFileByPath(np)
						) {
							await this.applyOp(this.eventToOp(event, event.content, noteId));
						} else {
							// Awaited: the exists-check below otherwise races the
							// materialize it's checking for and fires a whole seq-replay
							// for a file about to appear (idempotent, but a wasted
							// round-trip on every relocation).
							await this.materializeRelocated(event.path, noteId);
							if (!this.app.vault.getAbstractFileByPath(np)) {
								void this.catchupViaSeqReplay();
							}
						}
					}
				} else if (event.content !== undefined) {
					// Legacy fallback (no note_id, or non-CRDT): inline content from the
					// broadcast — no extra HTTP roundtrip.
					await this.applyChange({
						path: event.path,
						title: event.title ?? "",
						content: event.content,
						content_hash: event.content_hash,
						folder: event.folder ?? "",
						tags: event.tags ?? [],
						// applyChange reads neither field; sentinels, not clock lies.
						mtime: event.mtime ?? 0,
						updated_at: event.updated_at ?? "",
						deleted: false,
						version: event.version,
					});
				} else {
					// Hash-only broadcast with no note_id and no inline body. getNote-for-
					// sync is deleted (#310): the seq-ordered op-log carries the real
					// content and is the authoritative backstop (Phase E3). Heal via
					// replay instead of a REST fetch — a no-op when we are already current.
					void this.catchupViaSeqReplay();
				}
			} catch (e) {
				// biome-ignore lint/suspicious/noConsole: error boundary
				console.error("Engram Sync: failed to apply WebSocket event %s", event.path, e);
				// Sync-critical failure — must reach Loki, not just the local console.
				rlog().error(
					"ws",
					`Apply failed: ${event.event_type} ${noteRef(event.path)} | ${errMsg(e, event.path)}`,
					e instanceof Error ? e.stack : undefined,
				);
			}
		}
	}

	/** Id-keyed move: if `id` is already mapped to a DIFFERENT local path than
	 *  `newPath`, the server moved one row (a rename resurrects the same note_id
	 *  at a new path). Neither delivery channel is guaranteed to carry a delete
	 *  for the old path — the seq-ordered pull feed collapses the move into a
	 *  single upsert, and a realtime delete broadcast can be missed/reordered —
	 *  so relocate the old file ourselves or it lingers as a duplicate.
	 *
	 *  Re-keys the map (id stable, path moves) BEFORE trashing the old file, so
	 *  the vault delete event handleDelete fires resolves get(priorPath) to null:
	 *  it tears down NOTHING (crdtNoteId null), leaving the CRDT room for `id`
	 *  intact — only the path moved, not the id/room (mirrors handleRename's
	 *  "a rename must not tear down the CRDT doc"). No-ops when the id is unknown
	 *  or already at newPath, so callers can invoke it unconditionally.
	 *
	 *  Materializes the new path directly from the OLD file's on-disk content
	 *  (round 2, e2e test_10 mechanism a): a rename carries no content change,
	 *  so relying solely on the CRDT handshake (`materializeRelocated`'s
	 *  `isSynced` gate) to backfill the new path races a fresh-boot receiver
	 *  whose STEP2 hasn't landed yet this session — the gate declines and
	 *  nothing ever retries (received=yes, materialized=no). The old file's
	 *  bytes are already real, trustworthy content (this device had it on disk
	 *  before the rename); read + flush them to the new path here, independent
	 *  of CRDT session state. No-ops (falls through to the isSynced-gated
	 *  backstop) when there is no old file locally to read from.
	 *
	 *  STALE-EVENT GUARD (round 2, e2e test_34 mechanism, live-repro'd
	 *  2026-07-08): the WS channel is explicitly unordered (see class doc), so
	 *  a duplicate/reordered upsert can carry an id's PRIOR path after this
	 *  device already applied a more current relocation for that id this
	 *  session. Without a staleness check, the precondition above ("mapped to
	 *  a DIFFERENT path than event.path") is satisfied in EITHER direction —
	 *  the stale event reads as a second, backward relocation: re-keys the map
	 *  back, trashes the just-materialized new-path file, and (via the
	 *  disk-content fix above) recreates the old path from it. Observed live:
	 *  the old path was perpetually resurrected every few seconds. `eventTs`
	 *  (the WS broadcast's `updated_at`, or the pull feed's `updated_at` —
	 *  both server clock, normalized to epoch ms via Date.parse) is tracked
	 *  per note_id; an event no NEWER than the last one already applied for
	 *  this id is ignored outright — `<=`, not strict `<`:
	 *  the pull feed's `updated_at` is only seconds-precision on the wire, so
	 *  two genuinely different relocations for the same id within one second
	 *  can tie exactly. A tie can't be proven newer, so it must not win. */
	/** Vault-scoped: note_ids are unique only WITHIN a vault (review MINOR-6), so
	 *  a relocation timestamp from the OLD vault must not stale-gate an unrelated
	 *  note that reuses the same id in the new one. */
	private lastRelocationTs = this.track(["vault", "destroy"], new Map<string, number>());

	private async moveIfIdRelocated(id: string, newPath: string, eventTs?: number): Promise<void> {
		// Both authoritative upsert paths (the WS broadcast and the pull feed)
		// funnel through here, and this runs BEFORE the early return below on
		// purpose: when the delete leg was processed first it already released the
		// id's mapping, so `priorPath` is null and there is no "move" left to make
		// — but the tombstone that leg left behind is still muting the live note.
		this.clearTombstoneOnRelocation(id, newPath);
		const priorPath = this.noteIdMap?.pathForId(id) ?? null;
		if (!priorPath || normalizePath(priorPath) === normalizePath(newPath)) {
			// RENAME TRACE (2/3). This return decides move-vs-recreate for every
			// inbound relocation and was silent, so a vault where it fires EVERY
			// time looked identical to one where renames work.
			//
			// Two causes, different fixes:
			//   "map already at target" -- the map believes the note is already
			//     there. Harmless only if the FILE moved too; the map and the disk
			//     are different things and only `sourceOnDisk` distinguishes them.
			//   "no prior path"        -- no record of where the note lived, so
			//     there is nothing to move from.
			// Locals avoid the word "path": the redaction gate rejects any rlog
			// interpolation naming one, since `event.msg` is not scrubbed.
			const why = priorPath ? "map already at target" : "no prior";
			const targetOnDisk = !!this.app.vault.getAbstractFileByPath?.(normalizePath(newPath));
			const sourceOnDisk = priorPath
				? !!this.app.vault.getAbstractFileByPath?.(normalizePath(priorPath))
				: false;
			rlog().diag(
				"pull",
				`rename-trace 2/3 SKIPPED (${why}) id=${id} from=${noteRef(priorPath)} ` +
					`to=${noteRef(newPath)} sourceOnDisk=${sourceOnDisk} targetOnDisk=${targetOnDisk}`,
			);
			return;
		}
		rlog().info(
			"pull",
			`rename-trace 2/3 PROCEEDING id=${id} from=${noteRef(priorPath)} to=${noteRef(newPath)}`,
		);
		if (eventTs !== undefined) {
			const lastTs = this.lastRelocationTs.get(id);
			// STRICT `<` (e2e test_34): the backend gives a whole folder-rename op ONE
			// shared seq/ts, so sibling events (old-leg delete relocation + the id-keyed
			// move + the new-path upsert) collide on ts. A `<=` guard dropped the move
			// that advances canonical to the new path when a same-ts sibling had already
			// stamped lastRelocationTs, so canonical stayed OLD and the new-path upsert
			// was then rejected (received=yes materialized=no). `<` lets an equal-ts move
			// that has NOT yet applied proceed; a genuine duplicate is still a no-op via
			// the `priorPath === newPath` early-return above, so idempotency holds.
			if (lastTs !== undefined && eventTs < lastTs) {
				rlog().info(
					"pull",
					`Id-keyed move IGNORED (stale event ts=${eventTs} < last-applied ts=${lastTs}): ` +
						`${id} -> ${noteRef(newPath)}`,
				);
				return;
			}
			this.lastRelocationTs.set(id, eventTs);
		}
		// DESTRUCTIVE-OP GUARD (2026-07-07 cross-file data-loss incident): the
		// local map can be CROSS-WIRED — `id` pointing at a path that really
		// belongs to a DIFFERENT live note. Trusting it here trashed an unrelated
		// file. Verify against the server manifest before anything irreversible:
		//  - priorPath owned by ANOTHER id  -> cross-wire. Rebind `id` to its real
		//    path and leave the stranger's file/caches alone.
		//  - ownership unknowable (no manifest / fetch failed) -> rebind the map
		//    but SKIP the trash: a lingering duplicate is recoverable, a wrong
		//    trash is not. The next reconcile/pull converges it.
		//  - priorPath absent, or owned by this same id (stale snapshot mid-
		//    rename) -> genuine relocation, proceed as before.
		const owner = await this.manifestOwnerOf(normalizePath(priorPath));
		if (owner !== null && owner !== id) {
			rlog().warn(
				"pull",
				`Id-keyed move REFUSED (${owner === undefined ? "ownership unknown" : "cross-wire"}): ` +
					`${noteRef(priorPath)} not confirmed as ${id}'s old path — rebinding to ${noteRef(newPath)}, no trash`,
			);
			// set() keeps the map a bijection: it evicts priorPath->id without
			// touching priorPath's file, syncState, or baseStore (they belong to
			// whatever note actually lives there).
			this.noteIdMap?.set(newPath, id);
			// If this refusal was wrong (it WAS a genuine rename), the old file
			// is now a duplicate no id references — queue it for the orphan
			// sweep, which re-judges against a fresh manifest on reconcile.
			this.pendingOrphanSweep.add(normalizePath(priorPath));
			return;
		}
		this.noteIdMap?.rename(priorPath, newPath);
		// Carry the merge base WITH the note, exactly as the local rename leg does
		// (`handleRename` → `baseStore.rename` + `dropPath(dropBase: false)`).
		//
		// This used to drop the base outright, on the reasoning that "no diverged
		// base survives the move". But a relocation moves a path and changes no
		// content, so the base is not diverged — it is the note's common ancestor
		// under a stale key. Deleting it leaves the note with NO ancestor, and a
		// 3-way merge with nothing to merge against reads every later edit as a
		// divergence and writes a keep-both conflict copy. Repeatedly, because
		// nothing re-establishes the base until a reload does a full pull.
		//
		// Found in real use: a rename performed in the WEB app reached Obsidian,
		// then "typing stopped syncing" and conflict files kept appearing.
		// Reloading Obsidian fixed it — which is what proves the lost state was
		// local and the server was fine all along.
		this.baseStore?.rename(normalizePath(priorPath), normalizePath(newPath));
		// The sync-state row moves WITH the note for the same reason the base
		// does (see renamePath): the old key still goes away, so a later create
		// there isn't echo-suppressed, but the evidence is not destroyed.
		this.renamePath(normalizePath(priorPath), normalizePath(newPath));
		// normalizePath for the vault lookup (map keys arrive normalized from the
		// server feed, but a non-normalized key would silently miss the trash and
		// leave the duplicate this fix exists to remove). rename() above keeps the
		// RAW priorPath — it must match the byPath key exactly to re-key the id.
		const oldFile = this.app.vault.getFileByPath(normalizePath(priorPath));

		// A remote rename is a RENAME. Ask Obsidian to move the file, so the file
		// keeps its identity: open editors follow it, undo history survives, the
		// graph re-points, and no delete/create pair is fabricated. Everything
		// below this is the fallback for when a true rename cannot apply.
		//
		// This path used to be read-old + trash-old + create-new unconditionally,
		// which Obsidian cannot distinguish from "the user deleted a note and made
		// a different one". That produced two user-visible bugs — a trashed open
		// file yanked the editor to an unrelated note, and the merge base was
		// destroyed so every later edit became a conflict copy.
		//
		// `vault.rename`, NOT `fileManager.renameFile`: the latter also rewrites
		// `[[links]]` in other notes, and for a remote-origin rename the SERVER
		// already did that (`genesis_relocate_live` enqueues the rewrite for
		// non-obsidian origins). Rewriting again here would break the
		// exactly-one-rewriter invariant and double-apply.
		if (oldFile && !this.app.vault.getAbstractFileByPath(normalizePath(newPath))) {
			try {
				const parent = normalizePath(newPath).includes("/")
					? normalizePath(newPath).substring(0, normalizePath(newPath).lastIndexOf("/"))
					: "";
				if (parent) await this.ensureFolder(parent);
				// Both paths: Obsidian's rename event carries old and new, and the
				// guard in `handleRename` keys off the OLD one. Marked before the
				// call because the event can dispatch synchronously inside it.
				this.files.mark(normalizePath(priorPath), "remotelyRenamed", ECHO_COOLDOWN_MS);
				this.files.mark(normalizePath(newPath), "remotelyRenamed", ECHO_COOLDOWN_MS);
				await this.app.vault.rename(oldFile, normalizePath(newPath));
				rlog().info(
					"pull",
					`Id-keyed move (true rename): ${noteRef(priorPath)} -> ${noteRef(newPath)} (id=${id})`,
				);
				return;
			} catch (e) {
				// Destination appeared underneath us, a permission error, whatever —
				// clear the echo markers so a LATER genuine user rename of either
				// path is not swallowed, then fall through to the copy/trash path.
				this.files.clearMarker(normalizePath(priorPath), "remotelyRenamed");
				this.files.clearMarker(normalizePath(newPath), "remotelyRenamed");
				rlog().warn(
					"pull",
					`True rename failed, falling back to copy+trash: ${noteRef(priorPath)} -> ${noteRef(newPath)} — ${errMsg(e, [priorPath, newPath])}`,
				);
			}
		}

		// FALLBACK. Reached when the destination is already occupied (a concurrent
		// flush won the race) or the rename above threw. Obsidian never learns the
		// two files are one note here, so the leaf redirect below is still needed.
		// Captured BEFORE the trash — afterwards Obsidian's own delete-fallback has
		// usually already moved the leaf off oldFile.
		const leavesToRedirect: WorkspaceLeaf[] = oldFile
			? this.app.workspace
					.getLeavesOfType("markdown")
					.filter(
						(leaf) => leaf.view instanceof MarkdownView && leaf.view.file === oldFile,
					)
			: [];
		if (oldFile) {
			// MID-FLIGHT VANISH GUARD (round 4, e2e test_10 CI run 28915097812):
			// the old file can be trashed CONCURRENTLY while this function is
			// suspended on the manifest await above — the rename's own delete
			// tombstone, deferred to a pull, races these file ops. A rejection
			// here must not escape: handleStreamEvent's hoisted call is outside
			// its try/catch, so an escape kills the ENTIRE upsert — no relocation,
			// no CRDT-branch materialize, no file, silently (received=yes
			// materialized=no). Degrade instead: a failed trash means the
			// tombstone already removed the file (the outcome the trash wanted) —
			// still flush the content we read; a failed read means no local
			// content — fall through to the caller's isSynced-gated
			// materializeRelocated backstop.
			try {
				// Read before trashing — the content must be captured while the
				// file still exists at its old location.
				const content = await this.app.vault.cachedRead(oldFile);
				try {
					await this.trashRemotelyDeleted(oldFile);
				} catch {
					// Already gone — the concurrent tombstone won the race.
				}
				// CREATE-ONLY GUARD (final review CRITICAL-1): the cachedRead/
				// trashFile awaits above are a suspend window. flushFromCrdt's
				// modify-if-exists semantics would overwrite content a CONCURRENT
				// doc-triggered flush already wrote to newPath during that window
				// with these old-file bytes, which are never newer. Re-check right
				// before flushing — mirrors materializeRelocated's own exists check.
				//
				// NARROWED to "already holds CONTENT" (e2e test_34, 0-byte clobber).
				// The guard's premise is that an existing newPath means a concurrent
				// flush already wrote a BETTER body. That is false when the concurrent
				// flush wrote an EMPTY one: CRDT discovery calls
				// flushFromCrdt(newPath, content) for a note this device has never had
				// on disk, and flushFromCrdt's own content-loss guard is gated on
				// `file instanceof TFile` — so on its CREATE branch an empty body is
				// written with no guard at all. A bare exists() check then made THIS
				// path discard the only copy of the real body, leaving B with a 0-byte
				// note forever (wait_for_delivery's non-empty guard never satisfies →
				// 120s timeout, 5 of 7 red nights).
				//
				// "Exists" is not "has content". Yielding to a non-empty target keeps
				// the original protection intact.
				const existingAtNew = this.app.vault.getAbstractFileByPath(normalizePath(newPath));
				let existingBody: string | null = null;
				if (existingAtNew instanceof TFile) {
					try {
						existingBody = await this.app.vault.cachedRead(existingAtNew);
					} catch {
						// Unreadable — treat as "holds nothing worth keeping" so the
						// flush proceeds. Losing the body is the worse failure.
					}
				}
				if (existingAtNew && !(existingAtNew instanceof TFile)) {
					// A folder squatting the note path: not ours to overwrite, and
					// flushFromCrdt would fail on it. Same skip as before.
					rlog().info(
						"pull",
						`Id-keyed move: skipping disk flush for ${noteRef(newPath)} — a non-file already occupies the path`,
					);
				} else if (existingBody !== null && existingBody.trim() !== "") {
					rlog().info(
						"pull",
						`Id-keyed move: skipping stale disk flush for ${noteRef(newPath)} — already holds content (a concurrent flush won the race)`,
					);
				} else {
					await this.flushFromCrdt(newPath, content);
				}
				rlog().info(
					"pull",
					`Id-keyed move: ${noteRef(priorPath)} -> ${noteRef(newPath)} (id=${id})`,
				);
				// Point any leaf the trash just orphaned at the note's new home. The
				// leaf reference was captured before the trash on purpose (see
				// above) — re-deriving "which leaf was on oldFile" here would find
				// nothing, because Obsidian has typically already reassigned it.
				if (leavesToRedirect.length > 0) {
					const newFile = this.app.vault.getAbstractFileByPath(normalizePath(newPath));
					if (newFile instanceof TFile) {
						for (const leaf of leavesToRedirect) void leaf.openFile(newFile);
					}
				}
			} catch (e) {
				rlog().warn(
					"pull",
					`Id-keyed move file ops failed (old file vanished mid-flight?): ${noteRef(priorPath)} -> ${noteRef(newPath)} — ${errMsg(e, [priorPath, newPath])}`,
				);
				// No disk content to flush here, and the caller's isSynced-gated
				// materializeRelocated backstop may ALSO decline (fresh-boot
				// receiver, STEP2 not landed yet) — leaving the note invisible on
				// this device until the next scheduled poll, up to 5 minutes
				// (final review MINOR-7). Kick an immediate op-log catch-up so
				// that window is one replay instead — the missed op carries the
				// relocated note's content.
				void this.catchupViaSeqReplay();
			}
		}
	}

	/** Apply one merged cursor-feed entry. Attachments route to their own
	 *  primitive; note entries are reshaped into a `SyncOp` and applied through
	 *  the single `applyOp` path (Phase C). The feed's `type` is stripped. */
	async applySyncChange(c: SyncChange): Promise<boolean> {
		if (c.type === "attachment") {
			const ac: AttachmentChange = {
				path: c.path,
				mime_type: c.mime_type,
				size_bytes: c.size_bytes,
				mtime: c.mtime,
				updated_at: c.updated_at,
				deleted: c.deleted,
			};
			return this.applyAttachmentChange(ac);
		}
		return this.applyOp({
			kind: c.deleted ? "delete" : "upsert",
			id: c.id,
			path: c.path,
			seq: c.seq,
			title: c.title,
			content: c.content,
			content_hash: c.content_hash,
			folder: c.folder,
			tags: c.tags,
			mtime: c.mtime,
			updated_at: c.updated_at,
			version: c.version,
			parse_status: c.parse_status,
			parse_reason: c.parse_reason,
		});
	}

	/** THE single deterministic apply for markdown sync (Phase C). Every op —
	 *  live fan-out or catch-up replay — converges through here, dispatched by
	 *  `kind`. Owns id learning/retirement and id-keyed relocation; delegates the
	 *  materialize/merge/tombstone/resurrection logic to the shared `applyChange`
	 *  core. Attachments are NOT ops (they stay on the binary channel). */
	async applyOp(op: SyncOp): Promise<boolean> {
		// Folder-marker rows leak into the op feed with a null path (markers carry
		// no path_ciphertext server-side). They are unappliable client-side and
		// previously THREW inside applyChange's shouldIgnore (`null.startsWith`),
		// landing an rlog error ("Skipped note null"). Skip them quietly.
		if (!op.path) return false;
		// A note THIS device just deleted must not be resurrected by a stale
		// UPSERT replayed before the server's tombstone lands in the feed
		// (delete-wins window, backend #970). Two guards, keyed differently — the
		// same pair the retired catchupViaSocket loop held: recentlyDeleted (by
		// note_id, ~60s TTL) covers a delete already SENT/dequeued; hasPendingDelete
		// (by path) covers one still sitting in the offline queue (a fromZero replay
		// can deliver the stale upsert while the delete is unsent and the id's TTL
		// has lapsed). A tombstone op for the same id still falls through and applies
		// (idempotent delete), so convergence isn't blocked.
		if (
			op.kind === "upsert" &&
			(this.recentlyDeleted.has(op.id) ||
				this.queue.hasPendingEvidencedDelete(
					normalizePath(op.path),
					this.settings.vaultId ?? undefined,
				))
		) {
			rlog().info("crdt", `op-replay skip (recent/pending local delete): ${op.id}`);
			return false;
		}
		// note_id-keyed CRDT rework: learn this note's stable id from the op. A
		// tombstone clears the mapping instead of recording it: a note later
		// recreated at the same path is a NEW note server-side and must mint a
		// fresh id, not resurrect the deleted one's — mirrors the CRDT doc
		// teardown-on-delete rationale elsewhere in this file (no ghost lineage
		// across a delete). The clear is DEFERRED to after applyChange (below):
		// its delete branch needs the path→id mapping to classify the note as
		// CRDT-managed and tear its room down, so retiring the id here would blind it.
		if (op.kind === "upsert") {
			// Id-keyed move: the server sends a note's stable id at a NEW path, but
			// this device still holds that id at a DIFFERENT local path. A rename
			// moves one row server-side (delete old + resurrect at new, same id), so
			// the seq-ordered op feed carries only the upsert at the new path — never
			// a separate delete for the old one. Relocate the old file so it isn't
			// orphaned as a duplicate (e2e test_10). See moveIfIdRelocated.
			// eventTs (final review IMPORTANT-2): without this, a pull-applied
			// relocation never recorded lastRelocationTs for the id, so a LATER
			// stale/reordered WS broadcast carrying the pre-rename path found no
			// timestamp to compare against and relocated backward (cross-channel
			// ping-pong). op.updated_at is an ISO-8601 string (seconds precision on
			// the wire); normalize to the same epoch-ms basis moveIfIdRelocated's
			// WS callers already use (event.timestamp, epoch ms) via Date.parse.
			// An unparseable value degrades to "no timestamp" (undefined) rather
			// than NaN, which would poison every future comparison for this id
			// (NaN is never < anything, so the guard would silently stop
			// protecting it for the rest of the session).
			const relocationTs = Date.parse(op.updated_at ?? "");
			await this.moveIfIdRelocated(
				op.id,
				op.path,
				Number.isNaN(relocationTs) ? undefined : relocationTs,
			);
			this.noteIdMap?.set(op.path, op.id);
			// Learned from the server's own feed — it unquestionably has a note
			// row for this id, so future edits may route through CRDT (see
			// confirmedNoteIds doc comment). A tombstone deliberately does NOT
			// un-confirm: the id itself is retired (a recreate mints a fresh one),
			// so there's nothing to revoke.
			this.confirmNoteId(op.id);
			// A note degraded on ANOTHER device surfaces here too: read parse status
			// off the op before the NoteChange mapping erases it (that shape is also
			// fed by the legacy GET /notes/changes, which never had these fields).
			// Deleted entries skip this (a tombstone has no parse status). Ignored
			// paths skip it too: applyChange below drops them, so a Sync Center card
			// for an ignored note would be misleading (review minor #5).
			if (!this.shouldIgnore(op.path)) {
				this.recordParseStatus(op.path, "note", op.parse_status, op.parse_reason);
			}
		}
		const nc: NoteChange = {
			path: op.path,
			title: op.title,
			content: op.content,
			content_hash: op.content_hash,
			folder: op.folder,
			tags: op.tags,
			// applyChange reads neither field; sentinels only satisfy the shape.
			mtime: op.mtime ?? 0,
			updated_at: op.updated_at ?? "",
			deleted: op.kind === "delete",
			version: op.version,
			seq: op.seq,
		};
		const applied = await this.applyChange(nc);
		// Retire the id now that applyChange has consumed the mapping (see the
		// deferral note above). Idempotent with applyChange's own md teardown.
		if (op.kind === "delete") this.noteIdMap?.delete(op.path);
		return applied;
	}

	/** Manifest-diff reconcile: trash files the server deleted while we were
	 *  away (in baseline, absent from the manifest) and drop their baseline, then
	 *  seed markers for folders the server can't derive (empty / non-syncable
	 *  only). Does NOT pull content and does NOT push — content arrives via the
	 *  seq-replay catch-up, and offline-created (never-synced) files push via
	 *  pushModifiedFiles.
	 *
	 *  A manifest snapshot is the ONLY way to catch a server-delete once the
	 *  op-log has GC'd the tombstone — a replay-from-0 cannot see it — so this is
	 *  a standalone step in every catch-up path (fullSync, poll). Idempotent; a
	 *  per-file trash failure is logged, never thrown, and leaves the baseline
	 *  entry intact (clearing it would reclassify the file as offline-created and
	 *  resurrect it on the next push). A null manifest (pre-B1 backend / 404) is
	 *  a no-op. `manifest` may be passed pre-fetched (catchUp shares one across
	 *  its reconcile + live-bound-heal steps); omit it and it fetches its own. */
	private async reconcileFromManifest(
		manifest?: ManifestResponse | null,
		authGenAtFetch?: number,
	): Promise<void> {
		// #283: capture the identity-swap counter BEFORE the manifest is read so a
		// swap racing the fetch is detectable. When catchUp supplies a pre-fetched
		// manifest it passes the gen it captured before ITS OWN fetch; the
		// self-fetch path below captures it here.
		const authGen = authGenAtFetch ?? this.authGeneration;
		const m = manifest === undefined ? await this.api.getManifest() : manifest;
		if (!m) return;

		// A manifest that resolved across an OAuth/identity swap can be a STALE
		// snapshot missing notes the server still holds (a same-vault token
		// refresh, so the vaultId guard can't see it — #283). Trashing those as
		// "server-deleted" is local data loss. Skip only the DESTRUCTIVE pass;
		// seedEmptyFolders below is non-destructive LOCAL→SERVER and stays. A real
		// server-delete still arrives as an op-log tombstone (the primary delete
		// path, unaffected by this skip); only the GC'd-tombstone backstop is
		// deferred, re-running on a later clean catch-up. The skip errs toward
		// KEEPING a note (the opposite of #283) and self-corrects on next server
		// activity, so nothing is lost.
		if (this.authGeneration === authGen) {
			const serverPaths = new Set<string>([
				...m.notes.map((n) => normalizePath(n.path)),
				...m.attachments.map((a) => normalizePath(a.path)),
			]);

			// §F structural pass over local syncable files.
			for (const file of this.app.vault.getFiles()) {
				if (!this.isSyncable(file) || this.shouldIgnore(file.path)) continue;
				const np = normalizePath(file.path);
				if (serverPaths.has(np)) continue; // in manifest → content handled by catch-up
				if (!this.syncState.has(np)) continue; // never synced → pushModifiedFiles handles it

				// In baseline but gone from the server → server-deleted while away.
				try {
					await this.trashRemotelyDeleted(file);
					this.dropPath(np);
					rlog().info(
						"pull",
						`Reconcile: server-deleted → trashed ${noteRef(file.path)}`,
					);
				} catch (e) {
					rlog().error(
						"pull",
						`Reconcile trash failed (retried next run): ${noteRef(file.path)} — ${errMsg(e, file.path)}`,
						e instanceof Error ? e.stack : undefined,
					);
				}
			}
		} else {
			rlog().info(
				"pull",
				"Reconcile: skipped delete pass — identity swap raced the manifest fetch (retried next catch-up)",
			);
		}

		// Markers for folders the server can't derive. getFiles() never sees
		// folders, so without this a pre-existing vault's empty folders never
		// reach the server. Best-effort.
		await this.seedEmptyFolders();
	}

	/** Re-converge any LIVE-BOUND note whose server content (per the manifest)
	 *  diverges from our recorded baseline — independent of the seq cursor.
	 *
	 *  The socket seq-replay advances `catchupSeq` past every op it sees
	 *  (monotonic, so a permanently-unappliable op can't stall the feed). A
	 *  live-bound note whose convergence FAILED on a prior catch-up (e.g. a
	 *  background reconnect replay that consumed the edit op before the live
	 *  Y.Doc could take it) is therefore never re-delivered by cursor alone.
	 *  Before the REST purge, fullSync's pull had a SEPARATE cursor from the
	 *  socket replay, so it re-delivered the diverged note and converged it; the
	 *  cursor unification removed that. This restores it: a manifest snapshot
	 *  re-detects the divergence every catch-up and re-fires the STEP1
	 *  re-handshake (cooldown-gated, so a repeat detection is cheap). Only
	 *  live-bound notes (the editor owns the body, so disk writes are unsafe)
	 *  need it — idle divergences heal through the normal op-log apply.
	 *
	 *  Recording: this leg STAGES the manifest's `content_hash` into
	 *  `pendingConvergence` (fix wave 1) rather than recording it directly —
	 *  the manifest carries hashes only (keyed HMAC, uncomputable
	 *  client-side), so this leg can never itself prove the doc holds the
	 *  server's ops. `commitCrdtConvergence` commits the stage once a real
	 *  STEP2/update frame actually applies. Best-effort; never throws into
	 *  catchUp. */
	/** Phase E1 (#1065): whole-vault seq integer diff. Flags a manifest note row
	 *  whose seq the replay has ALREADY consumed (row.seq <= catchupSeq) but
	 *  that this path never recorded — a silent apply-loss (the test_10
	 *  "received=yes materialized=no" class) — and rewinds the cursor so the
	 *  next replay re-serves it. Rows beyond the cursor need nothing: the
	 *  imminent replay fetches them anyway. A syncState entry without `seq` is
	 *  NOT flagged (the entry's existence proves a materialize happened;
	 *  replay writes and seq-carrying live ops both record seq — an entry
	 *  without one predates the field). Returns the behind-row count.
	 *  ponytail: one rewind per distinct discrepancy per session
	 *  (lastValidatorRewind) — a re-served row whose apply still refuses to
	 *  record stays behind forever and must not rewind-loop every poll. */
	private validateFromManifest(manifest: ManifestResponse | null): number {
		if (!manifest?.notes?.length) return 0;
		const cursor = this.getCatchupSeq();
		let minBehind = Number.POSITIVE_INFINITY;
		let behind = 0;
		for (const entry of manifest.notes) {
			const seq = entry.seq;
			if (typeof seq !== "number" || !Number.isFinite(seq) || seq > cursor) continue;
			const path = normalizePath(entry.path);
			const stored = this.syncState.get(path);
			const recorded = stored ? (stored.seq ?? Number.POSITIVE_INFINITY) : -1;
			if (seq > recorded) {
				// Content-hash-aware (mirrors the #296 equal-seq fence): a row can
				// carry a NEWER server seq with the SAME content_hash we already
				// recorded (a meta/seq-only advance). The content is converged; only
				// the seq bookkeeping lagged. Stamp it rather than re-serve — catch-up
				// would otherwise fall through (not stale because the seq is newer, not
				// diverged because the hash matches) and never record it, so the
				// validator re-served the same rows every poll forever (the prod
				// no-progress stall on device a75644e9). A shared-seq FRESHER update
				// carries a DIFFERENT content_hash, so this can never fence out unseen
				// content — only a genuine hash mismatch is re-served.
				if (stored?.serverHash !== undefined && stored.serverHash === entry.content_hash) {
					this.patchSyncedRow(path, { seq });
					continue;
				}
				behind++;
				if (seq < minBehind) minBehind = seq;
			}
		}
		if (behind === 0) return 0;
		const target = minBehind - 1;
		if (target === this.lastValidatorRewind) {
			rlog().warn(
				"pull",
				`manifest validator: ${behind} row(s) still behind after a re-serve — not rewinding again (cursor=${cursor})`,
			);
			return behind;
		}
		this.lastValidatorRewind = target;
		rlog().warn(
			"pull",
			`manifest validator: ${behind} consumed-but-unrecorded row(s) — rewinding cursor ${cursor} → ${target} to re-serve`,
		);
		// Handed to runSeqReplayOnce (the sole cursor writer) rather than
		// written directly — a direct setCatchupSeq would race an in-flight
		// replay's per-page cursor persist and be silently clobbered. Clamped:
		// a seq-0 row yields target -1, which means replay-from-genesis.
		this.seqRewindFloor = Math.max(0, target);
		return behind;
	}

	private async healDivergedLiveBoundNotes(manifest: ManifestResponse | null): Promise<number> {
		if (!manifest || !this.crdt) return 0;
		let poked = 0;
		for (const entry of manifest.notes) {
			const path = normalizePath(entry.path);
			if (!this.isLiveBound(path)) continue;
			const stored = this.syncState.get(path);
			// E1 (#1065): head equality is op-level proof the doc already holds
			// the server state — terminates the STEP1-refire ceiling for open
			// notes whose serverHash never recorded (unverified heals).
			if (entry.crdt_head && stored?.crdtHead === entry.crdt_head) continue;
			// Already converged (serverHash matches the server's current hash) → skip.
			if (entry.content_hash && stored?.serverHash === entry.content_hash) continue;

			const noteId = this.noteIdMap?.get(path) ?? entry.id ?? null;
			if (!noteId) continue;

			try {
				if (entry.content_hash) {
					// content: null — the manifest carries a hash only (keyed HMAC,
					// uncomputable client-side), so this stage cannot be
					// content-verified; commitCrdtConvergence keeps the pre-wave-5
					// best-effort behavior for it (commit on the next non-empty frame).
					this.stageAndConverge(noteId, path, entry.content_hash, null);
				} else {
					// No hash to stage: still fire the re-handshake (pre-extraction
					// behavior — the stage was conditional, the converge was not).
					this.socketConverge(path, noteId);
				}
				poked++;
			} catch (e) {
				rlog().warn(
					"crdt",
					`live-bound heal failed for ${noteRef(path)}: ${errMsg(e, path)}`,
				);
			}
		}
		return poked;
	}

	/** Apply a single remote change to the vault (last-write-wins for the
	 *  legacy/oversized REST-note path; CRDT notes converge earlier and return).
	 *  Returns true when a file was actually created, modified, or trashed.
	 *  When forceOverwrite is true, bypass the anti-stale version guard. */
	async applyChange(change: NoteChange, forceOverwrite = false): Promise<boolean> {
		if (this.shouldIgnore(change.path)) {
			devLog().log("pull", `applyChange SKIP (ignored): ${change.path}`);
			return false;
		}

		// An op-log row is authoritative (unlike a broadcast, whose inline ""
		// can be a fabricated meta projection — see handleStreamEvent's ingress
		// guard): a row proving a hash maps to "" teaches it, so later
		// inline-"" broadcasts carrying that exact hash are trusted without a
		// round-trip. Replaces the learn-by-fetch the E3 purge deleted.
		if (!change.deleted && change.content === "" && change.content_hash) {
			this.emptyContentHash = change.content_hash;
		}

		const normalized = normalizePath(change.path);

		if (change.deleted) {
			devLog().log("pull", `applyChange DELETE: ${change.path}`);

			// A CRDT-managed note carries a note_id we learned from the server's
			// own feed (single-authority: every synced .md is CRDT-owned). null
			// for the legacy GET /notes/changes path, which never learns an id,
			// or for a purely-local file no device ever synced. applySyncChange
			// defers its tombstone map-clear until AFTER this call so the id is
			// still resolvable here.
			const crdtNoteId = this.noteIdMap?.get(normalized) ?? null;
			const crdtManaged = !!this.crdt && crdtNoteId !== null;

			// Delete local file if it exists
			const existing = this.app.vault.getFileByPath(normalized);
			if (existing) {
				// Resurrection guard: if the local file has unsynced edits, the
				// user has modified it since we last wrote a syncState entry —
				// either they recreated the path after another device deleted it,
				// or they edited a still-live file that another device has now
				// tombstoned. Either way, honouring the tombstone here would
				// destroy user work. Skip the delete and push the local file so
				// the server records the resurrection over its own tombstone.
				//
				// Hash-based check (not mtime): mtime tolerance is unreliable on
				// retest-fast paths where the local mtime is only ms ahead of the
				// tombstone's recorded mtime. Comparing localHash to syncedHash
				// captures user intent directly — "does what's on disk differ from
				// what we last synced?"
				const localContent = await this.app.vault.cachedRead(existing);
				const localHash = fnv1a(localContent);
				const lastSynced = this.syncState.get(normalized);
				const hasUnsyncedEdits = !lastSynced || lastSynced.hash !== localHash;
				if (hasUnsyncedEdits) {
					// The hash proxy misfires for CRDT-managed notes: a
					// CRDT-DELIVERED body frequently has no syncState baseline
					// (syncedHash=none, #203), so `hasUnsyncedEdits` misreads
					// authoritative server content as local drift and resurrects a
					// note the server legitimately deleted (e2e test_47, and the
					// folder-rename cleanup class test_34/78). For a CRDT note the
					// tombstone IS authoritative — never re-push it. Distinguish
					// genuine local drift (disk diverged from the recorded CRDT
					// baseline) via needsColdReconcile: no drift → honour the
					// tombstone directly; genuine drift → preserve it as a keep-both
					// conflict copy FIRST (data-integrity: the server owns the
					// delete, but we must not silently destroy un-synced edits),
					// then honour it. Only the legacy (non-CRDT) note keeps the
					// original skip-and-resurrect behaviour.
					if (!crdtManaged) {
						rlog().info(
							"pull",
							`Tombstone skipped (resurrection): ${noteRef(change.path)}` +
								` | localHash=${localHash}` +
								` | syncedHash=${lastSynced?.hash ?? "none"}` +
								` | localLen=${localContent.length}`,
						);
						devLog().log(
							"pull",
							`applyChange DELETE skipped (resurrection): ${change.path}` +
								` (localHash=${localHash} !== syncedHash=${lastSynced?.hash ?? "none"})`,
						);
						try {
							await this.pushFile(existing, true);
						} catch (e) {
							rlog().error(
								"pull",
								`Resurrection push failed: ${noteRef(change.path)} | err=${errMsg(e, change.path)}`,
							);
						}
						return false;
					}
					if (this.shouldKeepDriftCopy(normalized, localContent, crdtNoteId)) {
						// Best-effort: a copy failure must not block the delete
						// (mirrors the WS foreign-delete drift-capture on this branch).
						try {
							const copy = await this.writeDriftConflictCopy(
								normalized,
								localContent,
							);
							rlog().info(
								"conflict",
								`CRDT tombstone drift → keep-both | original=${noteRef(normalized)} copy=${noteRef(copy)}`,
							);
						} catch (e) {
							rlog().warn(
								"conflict",
								`CRDT tombstone drift capture failed for ${noteRef(normalized)}: ${errMsg(e, normalized)}`,
							);
						}
					} else {
						rlog().info(
							"pull",
							`CRDT tombstone honoured (no drift): ${noteRef(change.path)}` +
								` | syncedHash=${lastSynced?.hash ?? "none"}`,
						);
					}
					// fall through to trash below
				}
				await this.applyRemoteRemoval(existing);
				rlog().info("pull", `Deleted: ${noteRef(change.path)}`);
				// Tear the CRDT room down so a note recreated at this path starts
				// fresh (no ghost lineage). Gated on note_id + .md — a legacy note
				// (crdtNoteId null) or attachment is a no-op, so the non-CRDT trash
				// path is unchanged. Clears the map too (idempotent with
				// applySyncChange's deferred clear).
				if (crdtNoteId && this.isCrdtEligiblePath(normalized)) {
					this.noteIdMap?.delete(normalized);
					await this.teardownCrdtDoc(crdtNoteId);
				}
				return true;
			}
			return false;
		}

		// Meta-only changes must be resolved to a body before apply — reaching
		// here without content is a caller bug, not a recoverable state.
		const content = change.content;
		if (content === undefined) {
			throw new Error(`applyChange: missing content for ${change.path}`);
		}

		// C1's own predicates, hoisted above the anti-stale guard so both share
		// ONE computation (fix wave 4 — never resolve noteId twice, a drift
		// hazard). See C1 below for why noteId can be null (legacy
		// /notes/changes path, or a note discovered without ever learning an
		// id — src/sync.ts's discovery branch a few lines down never calls
		// noteIdMap.set).
		const crdtOwnsBody = !!(this.crdt && this.isCrdtEligiblePath(normalized));
		const noteId = this.noteIdMap?.get(normalized) ?? null;

		// Anti-stale guard (review 2026-07-15, data-loss race): a push landing
		// DURING a pull — the bounded post-pull drain, or a debounced edit —
		// bumps syncState past entries this pull fetched BEFORE that push.
		// Applying such an entry would blind-overwrite the just-pushed edit
		// (local == baseline, so no conflict fires). Server versions are
		// monotonic per note: an entry at or below the version we already
		// synced carries nothing new. Gated on the file existing locally so a
		// stale syncState row (crash, manual delete) can never mask a real
		// re-materialization; forceOverwrite (explicit keep-remote) bypasses.
		//
		// LEGACY / no-id-only (fix wave 4, D3 gate forensics CI run
		// 29917773065): this guard's `known >= change.version` has no seq
		// awareness, so it could mask a checkpoint-lagged-but-genuinely-newer
		// CRDT row (`applyChange skip (stale v1 <= synced v1)` — the row the
		// CRDT block's own seq-first staleRow fence, wave 3, would correctly
		// have judged NOT stale). Skipped here ONLY when CRDT owns the body
		// AND we have a resolved noteId — those rows are judged by that
		// seq-first fence instead. A CRDT row with NO resolvable noteId still
		// falls through to the no-noteId sub-branch below (~5262), which does
		// a raw content-snapshot write with no Yjs convergence — that sub-case
		// keeps this version guard as its only stale protection.
		if (!forceOverwrite && !(crdtOwnsBody && noteId) && change.version !== undefined) {
			const known = this.syncState.get(normalized)?.version;
			if (
				known !== undefined &&
				known >= change.version &&
				this.app.vault.getFileByPath(normalized)
			) {
				rlog().info(
					"pull",
					`applyChange skip (stale v${change.version} <= synced v${known}): ${noteRef(change.path)}`,
				);
				return false;
			}
		}

		// C1: CRDT-managed markdown — the crdt: topic owns the body. Skip the
		// legacy disk-write for markdown notes when CRDT is active. This prevents
		// the dual-write hazard where a note_changed broadcast and the crdt: update
		// both try to write the same file. Deletes (handled above) and attachments
		// (routed via applyAttachmentChange) are unaffected. One exception: when
		// LOCAL and REMOTE both diverged from the last-synced state (a real
		// conflict), the drift-copy below preserves the local edit instead of
		// silently backfilling over it.
		if (crdtOwnsBody) {
			// Canvas converges via the Yjs handshake ONLY. Its authoritative content
			// lives in the Yjs doc; the seq-feed `content` is vestigial for canvas
			// (the backend keeps notes.content stale, Phase B, and its deliver-out +
			// fan-out are .md-gated), so we must NEVER write `content` to disk here —
			// that would stamp an empty/stale canvas over the real one. Enroll to pull
			// the state over STEP1/STEP2 (the manager projects it via projectCanvas);
			// a migrated REST-era canvas with no server Yjs state is seeded by the
			// first client that opens it (the push path). Unlike markdown, canvas
			// enrolls even when idle — it has no content-fallback delivery — but the
			// room is released after convergence, and later live deltas ride the
			// note_yjs_update fan-out room-free, so this is not an enrollment storm.
			if (this.isCanvasPath(normalized)) {
				if (noteId) this.crdtEnrollment?.enroll(noteId);
				rlog().info(
					"pull",
					`CRDT canvas: enroll for Yjs convergence ${noteRef(change.path)}`,
				);
				return false;
			}
			// noteId resolved above (shared with the anti-stale guard). This is
			// populated for the merged-feed caller (applySyncChange learns `id`
			// right before calling applyChange) but may be unknown for the
			// legacy /notes/changes path (no `id` field on NoteChange) — skip
			// enrolling gracefully in that case; the body is still materialized
			// below directly from the pulled content.
			// Discovery: a CRDT-managed note we don't have on disk yet. Enroll it
			// (sync-step-1) so the body arrives over the CRDT handshake — the server
			// seeds the room from notes.content when it has no CRDT state. We never
			// legacy-write here (CRDT owns the body), so without enrolling a brand-new
			// note would be invisible on this device (the announce is edge-triggered
			// and can be missed if we weren't subscribed when the other device opened
			// the room). An already-local note is left to its existing CRDT routing.
			if (!this.app.vault.getFileByPath(normalized)) {
				// Enroll (STEP1) ONLY when the note is live-bound (open in the
				// editor). An idle discovered note gets its body room-free via the
				// flushFromCrdt below (the /changes payload already carries it), so
				// skipping STEP1 keeps a large vault from opening a room per note on
				// connect (the enrollment storm). Send stays intact — an idle CRDT
				// note ships local edits without enrollment.
				if (noteId && this.isLiveBound(normalized)) this.crdtEnrollment?.enroll(noteId);
				// RENAME TRACE (3/3). This branch CREATES a file because nothing is
				// at the target. For a rename that is the wrong verb -- the note
				// exists, elsewhere -- and this is the line users see as "it deleted
				// and remade my note". Record where the map thinks this id lives, so
				// a create that should have been a move is identifiable.
				const idHome = noteId ? (this.noteIdMap?.pathForId(noteId) ?? null) : null;
				rlog().diag(
					"pull",
					`rename-trace 3/3 CREATING ${noteRef(change.path)} id=${noteId ?? "none"} ` +
						`mapSaysIdLivesAt=${noteRef(idHome)}`,
				);
				rlog().info("pull", `CRDT discovery: enrolling new note ${noteRef(change.path)}`);
				// (return true below: this leg CREATES the file — the branch-wide
				// `return false` violated the "true when a file was actually
				// created" contract and made every pulled md note count as a
				// no-op in the download progress/recap.)
				// The /changes payload already carries the authoritative body, so
				// materialize it now — awaited within this pull, so a caller that
				// pulls-then-checks (e.g. triggerFullSync) sees the file immediately.
				//
				// Previously only EMPTY notes were written here and non-empty ones were
				// deferred to the CRDT seed-from-REST handshake. But that handshake can
				// silently never complete under load (a lost STEP1/STEP2, or a room the
				// server never seeded), stranding the note invisible forever — the
				// renamed-note-at-a-new-path case (e2e test_10/test_34) is exactly a
				// discovery, and deferring left the new path missing on B. We already
				// hold the body here, so write it. CRDT stays the single writer for LIVE
				// edits; its later STEP2 (identical content) is a harmless idempotent
				// re-flush suppressed by markRecentlyFlushed.
				// Propagate the write result instead of hardcoding `return true`.
				// The old unconditional true meant a gate-blocked no-op still
				// counted as a materialised file (2026-08-13).
				const wrote = await this.flushFromCrdt(normalized, content);
				if (!wrote) return false;
				// This row came off the server's own op-log feed, so the server
				// demonstrably holds it (#339). Without a head `hasServerNote` says
				// otherwise, and pushFile's write routing takes the genesis branch
				// (the `!hasServerNote` arm) instead of the live-CRDT arm — on a
				// first sync that re-uploads the WHOLE freshly-pulled vault (prod
				// 2026-08-13: "122 files to upload" from an empty local vault).
				// This is the branch a fresh vault actually takes;
				// commitCrdtConvergence never runs here.
				this.markServerKnown(normalized);
				return true;
			} else {
				// The note exists locally and CRDT owns its body for LIVE edits — but
				// this pull entry is the authoritative safety net. The old behavior
				// (enroll and return, never comparing) meant a missed crdt_doc_ready
				// announce was missed FOREVER: enrollment is once-per-session, so
				// nothing ever backfilled the content (2026-07-07: "Obsidian never
				// got any updates"). When the hashes prove we are behind, write the
				// body we are already holding; markRecentlyFlushed suppresses the
				// echo and the converged serverHash keeps dedupe quiet. The later
				// idempotent STEP2 re-flush is suppressed by the same window.
				// A cold (not live-bound) note stays room-free — we do not eagerly
				// STEP1 every CRDT note in the vault on connect (the enrollment
				// storm). Divergence is still handled below: a clean local file
				// backfills via REST (flushFromCrdt), a live-bound one re-handshakes.
				if (noteId && this.isLiveBound(normalized)) this.crdtEnrollment?.enroll(noteId);
				const stored = this.syncState.get(normalized);
				// Directional fence (CI 29877041947): hash INEQUALITY is
				// direction-blind — a replayed/enumerated row older than what this
				// device already applied (live op recorded in FileSyncState.seq, or
				// a row converged earlier) also mismatches, and treating that as
				// "we are behind" backfills a checkpoint-lagged projection over
				// newer live content (the ModifyTest 40B/23B revert ping-pong; 1805
				// backfills in one suite run). A row at or below the path's
				// high-water seq is history: skip the whole diverged block —
				// nothing is recorded, so a genuinely newer row still converges on
				// a later pass.
				//
				// seq is AUTHORITATIVE whenever the ROW carries it (2026-07-22 D3
				// gate forensics, CI run 29917773065 then 29920053637; issue #282's
				// family): seq is the vault op-log position and strictly increases
				// per materialized change, so a seq-bearing row is judged by seq
				// ALONE — never falls back to version, even when this path has no
				// recorded stored.seq yet. With no stored.seq there is nothing to be
				// behind of, so the row is NOT stale (fixes CI run 29920053637: a
				// seq-bearing row was skipped as `stale row (seq 33/- v1/1)` because
				// stored.seq was undefined and the OLD condition — "both sides carry
				// seq" — fell back to version equality). version is the fallback
				// ONLY for a seq-LESS row (legacy /notes/changes shape) — version is
				// checkpoint-lagged for CRDT notes (advances on checkpoint/
				// materialization, not every live delta — see the socket converge's
				// docstring), so an EQUAL-version row can legitimately carry content
				// this device never saw.
				//
				// The equal-SEQ case is now HASH-AWARE (2026-07-22, supersedes the
				// fence half of PR #280). The backend does NOT advance seq per live
				// update — MULTIPLE live CRDT updates SHARE ONE seq (backend
				// crdt_persistence.ex:180 "GUARANTEE BOUNDARY: this seq does not
				// advance per live update … the plugin's behind-detector cannot see
				// a loss WITHIN a shared seq"). So an equal-seq row can legitimately
				// carry NEW content this device never saw (B's own push echoed at
				// seq N, then a server merge of A's concurrent edit lands at the
				// SAME seq N with different content). A blunt `<=` drops it and loses
				// A's edit forever. A row is "stale/history" only if we ALREADY hold
				// its exact content: a strictly-LOWER seq is genuinely behind (stale
				// regardless of content), but an EQUAL-seq row is stale ONLY when its
				// content_hash is absent OR matches stored.serverHash. A differing
				// equal-seq hash falls through to the divergence/re-handshake leg
				// below.
				//
				// The version-fallback branch (seq-LESS legacy /notes/changes rows)
				// has the SAME `<=`-drops-unseen-content shape and is a candidate for
				// the same hash-aware fix — deliberately OUT OF SCOPE here (this
				// targets the proven shared-seq CRDT bug, not the legacy seq-less
				// path). Left as `<=`.
				const contentMatches =
					!change.content_hash || stored?.serverHash === change.content_hash;
				const staleRow =
					change.seq !== undefined
						? stored?.seq !== undefined &&
							(change.seq < stored.seq ||
								(change.seq === stored.seq && contentMatches))
						: stored?.version !== undefined &&
							change.version !== undefined &&
							change.version <= stored.version;
				if (staleRow) {
					rlog().info(
						"pull",
						`CRDT catch-up: stale row (seq ${change.seq ?? "-"}/${stored?.seq ?? "-"} v${change.version ?? "-"}/${stored?.version ?? "-"}) — history, skip ${noteRef(change.path)}`,
					);
				} else if (change.content_hash && stored?.serverHash !== change.content_hash) {
					if (this.isLiveBound(normalized)) {
						// An open, bound editor is the sole CRDT writer for the note —
						// writing disk under it would fight the binding. Socket-native
						// re-handshake (single-path D3, fix wave 1): ALWAYS fire STEP1 on
						// a diverged row (no text-verify skip — text equality doesn't
						// prove the doc holds the server's ops; see socketConverge
						// docstring). Recording moves entirely out of this leg: it STAGES
						// what it would record into `pendingConvergence`, and
						// `commitCrdtConvergence` commits it only once a real inbound
						// frame proves the ops landed (op-level proof, not a guess).
						// `crdtRehandshakeAttempts` stays purely diagnostic (the logged
						// attempt count) — this leg never writes serverHash itself.
						const key = noteId ?? normalized;
						const prevAttempt = this.crdtRehandshakeAttempts.get(key);
						const attempts =
							prevAttempt?.hash === change.content_hash
								? prevAttempt.attempts + 1
								: 1;
						rlog().warn(
							"pull",
							`CRDT catch-up: diverged + live-bound, socket re-handshake (attempt ${attempts}) ${noteRef(change.path)}`,
						);
						this.crdtRehandshakeAttempts.set(key, {
							hash: change.content_hash,
							attempts,
						});
						if (noteId) {
							// A fresh content_hash overwrites any prior stage — a new
							// episode, never a stale commit of superseded server content.
							// content: the row's own plaintext. It does NOT gate the
							// commit — the fix-wave-5 content-verify is gone (the row is
							// checkpoint-lagged, so a doc that converged newer than it
							// wedged the stage forever). Its only remaining reader is
							// `markServerKnown`: a non-empty staged content is proof the
							// server holds a row for this note (#339).
							this.stageAndConverge(
								noteId,
								normalized,
								change.content_hash,
								content,
								change.version,
								change.seq,
							);
						}
					} else {
						// Backfill is ONLY a catch-up for a CLEAN local file. If the
						// LOCAL content also moved off the last-synced hash, both
						// sides diverged — that is a conflict, and overwriting here
						// silently destroys the local edit with the conflict flow
						// never consulted (e2e test_14 skip regression, 2026-07-08).
						// Route it to the drift-copy below (#306 Phase A): capture
						// the local drift as a "(conflict)" copy, then converge the
						// main file to the server via the room.
						const localFile = this.app.vault.getFileByPath(normalized);
						const localNow = localFile
							? await this.app.vault.cachedRead(localFile)
							: null;
						// Row content == the last-synced BASELINE while its hash
						// diverges: the content is NOT evidence of a remote change.
						// Two indistinguishable cases share this shape — (a) our OWN
						// create/edit row echoing back while the next local edit is
						// in flight, and (b) a checkpoint-LAGGED row whose content
						// projection trails fresh tail ops the hash already reflects
						// (the test_34 meta-projection class; e2e test_82 round 4:
						// B's resumed replay consumed exactly such a row and went
						// deaf on the stale bytes). NEVER conflict on it (round 2's
						// spurious self-conflict + 20s auto-resolve stalled the real
						// push), NEVER record it (round 4's silent consume) —
						// converge via the room: Yjs deltas are correct in both
						// cases (a no-op round-trip for the pure echo). content:
						// null — the doc may rightly converge NEWER than this row,
						// so the commit is the best-effort next-frame kind.
						if (
							noteId &&
							stored !== undefined &&
							stored.hash !== undefined &&
							content !== undefined &&
							fnv1a(content) === stored.hash &&
							// The wipe-class quiet-record below takes precedence: no
							// CAS base ever recorded AND disk already equals the row
							// bytes — a re-handshake per such row is the storm.
							!(stored.serverHash === undefined && localNow === content)
						) {
							rlog().info(
								"pull",
								`CRDT catch-up: baseline-content row (echo/lagged), socket re-handshake ${noteRef(change.path)}`,
							);
							this.stageAndConverge(
								noteId,
								normalized,
								change.content_hash,
								null,
								change.version,
								change.seq,
							);
							// Diverged: a converge was FIRED that will rewrite this file —
							// report it as a pulled file, or the recap says "Already up to
							// date" while bodies are actively rewritten (review finding 5).
							return true;
						}
						const localDiverged =
							localNow !== null &&
							stored?.hash !== undefined &&
							fnv1a(localNow) !== stored.hash &&
							localNow !== content;
						if (localDiverged && localNow !== null) {
							// Both the on-disk file AND the authoritative doc moved off
							// the last-synced baseline. Preserve the local drift as a
							// "(conflict)" copy (existing convention, shared with the
							// tombstone/foreign-delete sites) and converge the main file
							// to the server via the room — no three-way merge, no modal
							// (#306 Phase A: the drift-copy replaces the legacy tail for
							// the CRDT double-divergence case).
							rlog().warn(
								"pull",
								`CRDT catch-up: local+remote both diverged, drift-copy + converge ${noteRef(change.path)}`,
							);
							let copy: string | null = null;
							try {
								copy = await this.writeDriftConflictCopy(normalized, localNow);
							} catch (e) {
								rlog().warn(
									"conflict",
									`drift-copy capture failed for ${noteRef(normalized)}: ${errMsg(e, normalized)}`,
								);
							}
							if (copy === null) {
								// The local edit could NOT be backed up. Do NOT converge:
								// socketConverge would overwrite the main file with the
								// server version, destroying the only remaining copy of
								// the local edit. Leave disk untouched; the next catch-up
								// re-attempts the copy for this still-diverged row.
								rlog().warn(
									"conflict",
									`drift-copy failed — leaving ${noteRef(normalized)} intact, deferring convergence to next catch-up`,
								);
								return false;
							}
							new Notice(
								`Engram: sync conflict on ${normalized} — your local edit was saved as ${copy}`,
							);
							if (noteId) {
								this.stageAndConverge(
									noteId,
									normalized,
									change.content_hash,
									content,
									change.version,
									change.seq,
								);
							}
							// Diverged: a converge was FIRED that will rewrite this file —
							// report it as a pulled file, or the recap says "Already up to
							// date" while bodies are actively rewritten (review finding 5).
							return true;
						}

						if (
							noteId &&
							stored?.serverHash === undefined &&
							localNow !== null &&
							localNow === content
						) {
							// No CAS base was EVER recorded for this path (post-wipe
							// re-adoption / a first-fan-out vs C1-seed race) and disk
							// already holds the row's exact bytes: record the
							// bookkeeping quietly, no round-trip. NOT the reviewed-out
							// text-equality fast path: with no recorded convergence
							// history there is no seq fence to mask and no doc lineage
							// this recording could contradict — while firing a
							// re-handshake per such row re-created the connect storm on
							// mass divergence (an account swap re-keys every row's
							// per-user HMAC hash → hundreds of enrolls → server rate
							// limit → real heals starved; CI run 29942250643).
							// Deliberately NO seq stamp: if this row was itself a
							// checkpoint-lagged projection (fresh hash, stale bytes
							// that happen to match disk), the E1 validator's
							// consumed-but-unrecorded net re-serves it next pass —
							// by then the projection caught up and the identical/
							// diverged branches consume it properly.
							rlog().info(
								"pull",
								`CRDT catch-up: no-CAS-base quiet record (disk==row) ${noteRef(change.path)}`,
							);
							this.patchSyncedRow(normalized, {
								hash: fnv1a(content),
								version: change.version,
								serverHash: change.content_hash,
							});
						} else if (
							noteId &&
							content !== "" &&
							(await this.isUnconvergedEmptyPlaceholder(noteId, normalized, localNow))
						) {
							// #477: this note is a 0-BYTE PLACEHOLDER this device wrote
							// itself, and the row carries the body it was waiting for.
							// Do exactly what the discovery leg does one pass earlier —
							// write the body, flip the server-known oracle, record
							// nothing else — instead of paying a `crdt_doc_state`
							// round-trip (plus a room whenever that read falls back) to
							// fetch a body this very row already carries.
							//
							// The bookkeeping is deliberately IDENTICAL to discovery's,
							// which is what makes it safe: no `serverHash`, no `seq`. A
							// row can lag its own `content_hash` (fresh hash, stale
							// bytes — the test_82 deaf class), and recording that hash
							// would mark the note in sync at bytes we cannot verify,
							// after which every later row carrying that hash compares
							// equal and is skipped. Permanently. Recording nothing keeps
							// the note eligible for a real, proof-carrying converge.
							//
							// `isUnconvergedEmptyPlaceholder` is where the safety lives —
							// see its contract for why an empty file is NOT on its own
							// sufficient license to write.
							rlog().info(
								"pull",
								`CRDT catch-up: filling empty placeholder from row ${noteRef(change.path)}`,
							);
							// A staged episode from an earlier pass is now superseded: its
							// STEP2 would commit an OLDER serverHash/version/seq over what
							// this row just materialized, walking `seq` backward and
							// re-serving rows already consumed. `commitCrdtConvergence` is
							// a no-op with nothing staged.
							this.pendingConvergence.delete(noteId);
							this.crdtRehandshakeAttempts.delete(noteId);
							if (!(await this.flushFromCrdt(normalized, content))) return false;
							// Same feed, same proof (#339): a row off the server's own
							// op-log is the server telling us it holds this note. Merges
							// (never replaces), so the placeholder's head survives.
							this.markServerKnown(normalized);
							// This leg WROTE the body to disk — report it (contract:
							// "true when a file was actually created, modified…").
							return true;
						} else if (noteId) {
							// CRDT-enrolled COLD note — nobody has this open in an
							// editor. It still needs the server's Yjs ops (never the
							// feed's plaintext `content`: that snapshot is
							// checkpoint-lagged and can revert a fresher live merge,
							// the D2 stomp class — Yjs merge is monotonic, a
							// content write is not).
							//
							// #1409: getting those ops used to mean a room. The
							// stage-then-fire pattern below fired a STEP1, the backend
							// routed it through `ensure_room`, and a bulk first sync
							// allocated one room per cold note that fell through to
							// catch-up — measured as 100% of the rooms a 250-note
							// import opened, and 81-583 per 1,000 notes under CI load.
							// `crdt_doc_state` returns the same state off the persisted
							// snapshot + tail with no room; the apply is the same
							// monotonic merge STEP2's would have been.
							//
							// Falls back to the room handshake on ANY failure — an old
							// backend that doesn't know the frame, a rate limit, a
							// dropped socket. Convergence is the invariant; the room is
							// only the expensive way to reach it.
							await this.convergeColdNoteRoomFree(
								noteId,
								normalized,
								change,
								content,
								change.content_hash,
							);
						} else {
							// No note_id (legacy GET /notes/changes path — no id to pull
							// a CRDT delta for): fall back to the content-snapshot
							// backfill, unchanged from before.
							rlog().warn(
								"pull",
								`CRDT catch-up: pull backfilling diverged note (no note_id) ${noteRef(change.path)}`,
							);
							// Gate the bookkeeping on the write, same as the discovery
							// branch. Stamping a hash for content that never reached disk
							// tells the engine disk matches the server, so the resulting
							// divergence is invisible and never repaired — a quieter
							// version of the 2026-08-13 failure. Unreachable today (the
							// replay bails before this when the gate is shut), which is
							// precisely why it must not depend on that staying true.
							// `false` is the honest answer under this function's contract
							// ("true when a file was actually created/modified") — the
							// same reason flushFromCrdt itself stopped returning true
							// for a gate-blocked no-op.
							if (!(await this.flushFromCrdt(normalized, content))) return false;
							this.stampSyncedRow(normalized, {
								hash: fnv1a(content),
								version: change.version,
								serverHash: change.content_hash,
								seq: change.seq,
							});
							// Same feed, same proof (#339): a backfilled row is still the
							// server telling us it holds this note.
							//
							// AFTER the stamp, not before: `stampSyncedRow` REPLACES the
							// row by contract, so a head set first is dropped by the very
							// next line. Inert on this leg — it is reached only with no
							// note_id, and `crdtHead` is only ever written by paths that
							// have one — but the ordering is the correct one to copy, and
							// the wrong one is silent.
							this.markServerKnown(normalized);
							// This leg WROTE the body to disk — report it (contract:
							// "true when a file was actually created, modified…").
							return true;
						}
					}
				} else {
					rlog().info(
						"pull",
						`CRDT-managed: re-enroll for catch-up ${noteRef(change.path)}`,
					);
				}
			}
			// A CRDT-managed note (markdown OR canvas since #306) is fully handled
			// above: markdown double-divergence by the drift-copy (#306 Phase A),
			// canvas by the Yjs handshake. The LWW write below serves only the
			// legacy/oversized REST notes that remain outside the CRDT domain.
			return false;
		}

		// Create or update the file
		const existing = this.app.vault.getFileByPath(normalized);
		if (existing) {
			// Legacy/oversized REST notes only (CRDT notes returned above): last
			// write wins — skip if the disk already matches, otherwise overwrite.
			const localContent = await this.app.vault.cachedRead(existing);
			const localHash = fnv1a(localContent);
			if (localContent === content) {
				// Content identical — nothing to do
				devLog().log("pull", `applyChange SKIP (identical): ${change.path}`);
				this.stampSyncedRow(normalized, {
					hash: localHash,
					version: change.version,
					serverHash: change.content_hash,
					// E1 (#1065): record the row's seq so the manifest validator can
					// integer-diff this path (a legacy change without one keeps the
					// prior value rather than erasing it).
					seq:
						typeof change.seq === "number"
							? change.seq
							: this.syncState.get(normalized)?.seq,
				});
				if (change.version != null) {
					this.baseStore?.set(normalized, content, change.version);
				}
				rlog().info("pull", `Unchanged: ${noteRef(change.path)}`);
				return false;
			}

			// Apply remote change (no conflict, or keep-remote chosen)
			devLog().log("pull", `applyChange OVERWRITE: ${change.path} (len=${content.length})`);
			await this.modifyFile(existing, content);
			this.stampSyncedRow(normalized, {
				hash: fnv1a(content),
				version: change.version,
				serverHash: change.content_hash,
				// E1 (#1065): seq recorded for the manifest validator's integer diff.
				seq:
					typeof change.seq === "number"
						? change.seq
						: this.syncState.get(normalized)?.seq,
			});
			if (change.version != null) {
				this.baseStore?.set(normalized, content, change.version);
			}
			rlog().info(
				"pull",
				`Applied: ${noteRef(change.path)} | localLen=${localContent.length} | remoteLen=${content.length}`,
			);
			return true;
		}
		// New file — create it
		devLog().log("pull", `applyChange CREATE: ${normalized} (len=${content.length})`);
		try {
			await this.createFileWithFolders(normalized, content);
		} catch (createErr) {
			rlog().error(
				"pull",
				`applyChange CREATE FAILED: ${noteRef(normalized)}`,
				createErr instanceof Error ? createErr.stack : undefined,
			);
			throw createErr;
		}
		this.stampSyncedRow(normalized, {
			hash: fnv1a(content),
			version: change.version,
			serverHash: change.content_hash,
			// E1 (#1065): seq recorded for the manifest validator's integer diff.
			seq: typeof change.seq === "number" ? change.seq : undefined,
		});
		if (change.version != null) {
			this.baseStore?.set(normalized, content, change.version);
		}
		rlog().info("pull", `Created: ${noteRef(change.path)} | len=${content.length}`);
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
				await this.applyRemoteRemoval(existing, { dropBase: false });
				rlog().info("pull", `Attachment deleted: ${noteRef(change.path)}`);
				return true;
			}
			return false;
		}

		// Fetch content if not provided
		let serverHash = change.content_hash;
		let resolvedBase64 = contentBase64;
		if (resolvedBase64 === undefined) {
			const fetched = await this.api.getAttachment(change.path);
			resolvedBase64 = fetched.content_base64;
			// Prefer the value that came WITH the bytes we are about to write:
			// it describes exactly this payload, whereas `change.content_hash`
			// describes whatever the event announced.
			serverHash = fetched.content_hash ?? serverHash;
		}
		const buffer = base64ToArrayBuffer(resolvedBase64);
		const existing = this.app.vault.getFileByPath(normalized);
		// Track the synced bytes so a later push echo-suppresses instead of
		// re-uploading this attachment (keyed identically to the push side).
		const hash = fnv1a(resolvedBase64);
		// Recording the SERVER's hash is what lets the next broadcast for this
		// path be answered without re-downloading the blob (Engram#961). Merge,
		// never replace: a bare `set` would drop it again on the following
		// write, which is the same bug that kept force-push unprovable.
		const rowPatch = serverHash ? { hash, serverHash } : { hash };

		if (existing) {
			// Skip if content is identical — prevents modify event and push-back loop
			if (existing.stat.size === buffer.byteLength) {
				const localBuffer = await this.app.vault.readBinary(existing);
				if (this.arrayBuffersEqual(localBuffer, buffer)) {
					this.patchSyncedRow(normalized, rowPatch);
					rlog().info(
						"pull",
						`Attachment unchanged: ${noteRef(change.path)} | bytes=${buffer.byteLength}`,
					);
					return false;
				}
			}
			await this.app.vault.modifyBinary(existing, buffer);
			this.patchSyncedRow(normalized, rowPatch);
			rlog().info(
				"pull",
				`Attachment applied: ${noteRef(change.path)} | bytes=${buffer.byteLength}`,
			);
			return true;
		}
		await this.createBinaryFileWithFolders(normalized, buffer);
		this.patchSyncedRow(normalized, rowPatch);
		rlog().info(
			"pull",
			`Attachment created: ${noteRef(change.path)} | bytes=${buffer.byteLength}`,
		);
		return true;
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

	/** Create a note's file at `normalized` -- or MOVE it there, if the note this
	 *  path now claims already has a file somewhere else.
	 *
	 *  Every path that materializes a note funnels through here, which is why the
	 *  check belongs here and not in any one of them. A remote rename arrives as
	 *  identity first, and several paths race to put bytes at the new location:
	 *  the id-keyed mover, the discovery create, the CRDT flush. Whichever wins,
	 *  the others see an occupied target and fall back to create-here +
	 *  trash-there. The bytes end up right and the FILE does not: Obsidian sees a
	 *  brand-new note, so open tabs close, backlinks re-resolve and the creation
	 *  date resets. That is the "it makes a new file and deletes the other one"
	 *  report, and it is the same report whichever path happened to win.
	 *
	 *  Obsidian does have the function this wants -- `vault.rename` -- but no
	 *  caller could reach it, because by the time anyone knew the new path they
	 *  had already lost the old one. Resolving the note's id back to its current
	 *  file is what makes the move expressible at all.
	 *
	 *  `vault.rename`, not `fileManager.renameFile`: the server rewrote links for
	 *  a rename it originated, and renameFile would rewrite them again (the
	 *  exactly-one-rewriter invariant). Relay uses renameFile because its server
	 *  does not rewrite at all. */
	private async createFileWithFolders(normalized: string, content: string): Promise<void> {
		const folder = normalized.includes("/")
			? normalized.substring(0, normalized.lastIndexOf("/"))
			: "";
		if (folder) {
			await this.ensureFolder(folder);
		}
		// Where did the note claiming this path come from? NOT asked of the map:
		// the map has already been moved, so it answers `normalized` for this id
		// and the old name is gone from it. `relocatedFrom` is the only remaining
		// record, captured at the instant identity moved.
		const cameFrom =
			this.relocatedFrom.get(normalized)?.from ?? this.staleOriginFor(normalized);
		if (cameFrom && cameFrom !== normalized) {
			const existing = this.app.vault.getFileByPath?.(cameFrom);
			if (existing && !this.app.vault.getAbstractFileByPath?.(normalized)) {
				await this.renameFollowingIdentity(cameFrom, normalized);
				// Re-check rather than assume: a failed move falls through to the
				// create below, which is the old behaviour and still converges.
				const moved = this.app.vault.getFileByPath?.(normalized);
				if (moved) {
					await this.modifyFile(moved, content);
					this.rememberFileFor(normalized);
					return;
				}
			}
		}
		try {
			await this.app.vault.create(normalized, content);
			// The load-bearing call. A note received this session is created here
			// and nowhere else, so without this the registry only ever knows notes
			// that were on disk at startup -- which is exactly the hole e2e
			// test_93 fell through while a manual test on an older note passed.
			this.rememberFileFor(normalized);
		} catch (e) {
			// A concurrent materialization path (pull vs WS delivery) can create
			// this file between the caller's existence check and our create —
			// vault.create then rejects "File already exists." (e2e round 5,
			// run 28919928915 catch-up bursts). The body landing on disk is the
			// goal, so degrade to modify with the same content; rethrow the rest.
			const raced = this.app.vault.getAbstractFileByPath(normalized);
			if (raced instanceof TFile) {
				await this.modifyFile(raced, content);
				this.rememberFileFor(normalized);
				return;
			}
			throw e;
		}
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

		try {
			await this.app.vault.createFolder(path);
		} catch (e) {
			// Check-then-create races a concurrent materialization of a sibling
			// note into the same new folder: N notes delivered in a burst each
			// ensureFolder the same path and the losers reject "Folder already
			// exists." (e2e test_34, run 28919928915 — the dropped note then
			// missed the 30s delivery window). Losing the race means the folder
			// IS there — the outcome we wanted — so swallow ONLY that case.
			if (this.app.vault.getAbstractFileByPath(path)) return;
			if (/already exists/i.test(errMsg(e))) return;
			throw e;
		}
	}

	/** Live-sync entry for a server-side folder-marker change (folders.batch
	 *  channel event). Re-polls /folders/explicit and materializes new empty
	 *  folders immediately instead of waiting for the next pull. */
	async resyncFolders(): Promise<void> {
		if (this.syncBlocked) return;
		await this.syncExplicitFolders();
	}

	/** Pull the server's explicit empty-folder markers, persist them, and
	 *  materialize each on disk. Skips ignored paths (so we never recreate
	 *  .obsidian/, .trash/, .git/, or user-ignored folders). Failures are
	 *  warn-logged and swallowed — folder sync is best-effort, doesn't fail
	 *  the broader pull. */
	private async syncExplicitFolders(): Promise<void> {
		if (!this.explicitFolders) return;
		let names: string[];
		try {
			names = await this.api.listExplicitFolders();
		} catch (e) {
			devLog().log("pull", `listExplicitFolders failed: ${errMsg(e)}`);
			rlog().warn("pull", `listExplicitFolders failed: ${errMsg(e)}`);
			return;
		}

		// A folder we previously tracked that the server no longer lists was
		// deleted on another device (web). Trash it locally so the delete
		// propagates. Guarded — only an EMPTY folder still on disk (a note may
		// have since landed inside it) and never an ignored path
		// (.obsidian/, .trash/, …).
		const kept = new Set(names);
		const removed = this.explicitFolders
			.all()
			.filter((prev) => !kept.has(prev) && !this.shouldIgnore(prev));

		// Drop the tracked set to the server's list BEFORE trashing any folder.
		// trashFile dispatches Obsidian's vault "delete" event, which routes to
		// handleFolderDelete; if the folder were still tracked there it would echo
		// a real DELETE /folders back to the server (the folder-level twin of the
		// #970 own-device delete-echo guard). Removing it from the set first makes
		// handleFolderDelete's membership guard suppress the echo — and covers the
		// "user deleted all folders → []" case without a special guard.
		await this.explicitFolders.replaceAll(names);

		for (const prev of removed) {
			const existing = this.app.vault.getAbstractFileByPath(prev);
			if (!(existing instanceof TFolder)) continue;
			if (existing.children.length > 0) continue;
			try {
				await this.app.fileManager.trashFile(existing);
			} catch (e) {
				devLog().log("pull", `trash removed folder(${prev}) failed: ${errMsg(e)}`);
			}
		}

		for (const name of names) {
			if (this.shouldIgnore(name)) continue;
			try {
				await this.ensureFolder(name);
			} catch (e) {
				devLog().log("pull", `ensureFolder(${name}) failed: ${errMsg(e)}`);
			}
		}
	}

	/** Remove empty parent folders after a file deletion, walking up the tree.
	 *  Stops on any folder marked explicit (kind='folder' on the server) — the
	 *  user-intended empty stays. */
	private async removeEmptyFolders(filePath: string): Promise<void> {
		let folder = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "";

		while (folder) {
			const existing = this.app.vault.getAbstractFileByPath(folder);
			if (!(existing instanceof TFolder)) break;
			if (existing.children.length > 0) break;

			// User has marked this folder as intentionally empty (created in the
			// web app or via Obsidian's New folder). Don't strip it; the marker
			// would just come back on the next pull.
			if (this.explicitFolders?.has(folder)) break;

			await this.app.fileManager.trashFile(existing);

			// Walk up to parent
			folder = folder.includes("/") ? folder.substring(0, folder.lastIndexOf("/")) : "";
		}
	}

	// --- Full sync (startup) ---

	/** Full bidirectional sync: pull remote changes, then push local changes. */
	async fullSync(): Promise<{ pulled: number; pushed: number }> {
		// Thin wrapper so the sweep is marked without reindenting the whole body.
		return this.inBulkSweep(() => this.fullSyncInner());
	}

	private async fullSyncInner(): Promise<{ pulled: number; pushed: number }> {
		if (this.syncBlocked) {
			devLog().log("sync-blocked", "fullSync short-circuited — gate closed");
			return { pulled: 0, pushed: 0 };
		}
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

		// Drop stale per-vault bookkeeping if the active vault changed since
		// syncState was recorded (must run before prePullSync is snapshotted).
		await this.invalidateIfVaultChanged();

		// Snapshot lastSync before pull — pull updates it to server_time,
		// which would cause pushModifiedFiles to miss files modified between
		// the old and new lastSync values.
		const prePullSync = this.lastSync;

		const pull = await this.catchUp({ reportProgress: true });
		const pulled = pull.files;
		const push = await this.pushModifiedFiles(prePullSync);
		const pushed = push.pushed;

		// Close out the progress UI (mirrors pushAll's terminal "complete").
		// The recap's "N synced" reads `current`, so it must count BOTH legs —
		// a download-only sync (pushed=0) still synced `pulled` notes and must
		// not report "Nothing needed syncing". Both legs are FILE counts (the
		// plan's unit). `failed` carries both legs too — the recap used to
		// hardcode 0 and claim "All synced" over real genesis-batch failures.
		// pushModifiedFiles already flushed the plan-skip tally into
		// lastBatchSkipped, so surface it here as `skipped` (disjoint from
		// failed — informational skips never increment the failure counter).
		const synced = pulled + pushed;
		this.onSyncProgress?.({
			phase: "complete",
			current: synced,
			total: synced,
			failed: pull.failed + push.failed,
			skipped: this.lastBatchSkipped,
		});

		// Persist syncState updated during push (pull already saved its own)
		if (pushed > 0) {
			await this.saveData({ lastSync: this.lastSync });
		}

		devLog().log("lifecycle", `fullSync done — pulled=${pulled} pushed=${pushed}`);
		rlog().info("lifecycle", `FullSync done — pulled=${pulled} pushed=${pushed}`);
		return { pulled, pushed };
	}

	/** Push all files that have been modified since last sync, plus any
	 *  syncable file that the engine has never seen (no syncState entry).
	 *  The untracked branch covers the first-sync case and the post
	 *  vault-change case where we cleared sync state — neither would
	 *  otherwise touch the push path because lastSync is empty and the
	 *  mtime comparison short-circuits. */
	/** Persist a content-free, crdt-tagged upsert to the durable queue. Both of
	 *  pushFile's channel-down seams must produce an IDENTICAL entry so
	 *  runFlushQueue's socket-converge branch delivers them the same way —
	 *  keep the producers in lockstep here rather than duplicating the object
	 *  literal, so a new field can't be added to one seam and forgotten on the
	 *  other. */
	private async enqueueCrdtEdit(file: TFile, noteId: string): Promise<void> {
		await this.enqueueChange({
			path: file.path,
			action: "upsert",
			noteId,
			crdt: true,
			mtime: file.stat.mtime / 1000,
			timestamp: Date.now(),
			kind: "note",
			vaultId: this.settings.vaultId ?? undefined,
		});
	}

	/** Record or clear a note's frontmatter parse issue from a backend
	 *  parse_status/parse_reason. Called on every push success + feed apply. When
	 *  the note parses cleanly we clear ONLY a prior frontmatter issue for the path
	 *  (a real error issue recorded elsewhere must survive). Fires a debounced
	 *  Notice ONLY on the ok->degraded transition into the "frontmatter"
	 *  category (a note that newly degrades with a user-fixable frontmatter
	 *  problem), so a steady-state degraded vault stays quiet, a re-recorded
	 *  already-degraded note does not re-notify, and a generic "other"
	 *  category failure (e.g. note_processing_failed) never enters the
	 *  Notice path at all. */
	recordParseStatus(
		path: string,
		kind: "note" | "attachment",
		parseStatus: "ok" | "degraded" | undefined,
		parseReason: ParseReason | null | undefined,
	): void {
		const mapped = parseStatusToIssue(parseStatus, parseReason);
		if (!mapped) {
			const existing = this.issues.get(path);
			if (existing && (existing.category === "frontmatter" || existing.parseReason)) {
				this.issues.clear(path);
			}
			return;
		}
		const wasDegraded = this.issues.get(path)?.category === "frontmatter";
		const now = Date.now();
		this.issues.record({
			path,
			kind,
			category: mapped.category,
			message: mapped.message,
			parseReason: mapped.parseReason,
			firstFailedAt: now,
			lastFailedAt: now,
			attempts: 1,
		});
		if (!wasDegraded && mapped.category === "frontmatter") {
			this.pendingDegraded.add(path);
			if (this.degradedNoticeTimer) this.time.clearTimeout(this.degradedNoticeTimer);
			this.degradedNoticeTimer = this.time.setTimeout(
				() => this.flushDegradedNotice(),
				DEGRADED_NOTICE_DEBOUNCE_MS,
			);
		}
	}

	/** Flush the pending degraded-transition burst into a single Notice.
	 *  Single note: names the file with an "Open note" link. Multiple: a
	 *  count pointing at Sync Center. Mirrors the clickable-Notice pattern in
	 *  limit-toast.ts. */
	private flushDegradedNotice(): void {
		this.degradedNoticeTimer = null;
		const paths = [...this.pendingDegraded];
		this.pendingDegraded.clear();
		if (paths.length === 0) return;
		if (paths.length === 1) {
			const [path] = paths as [string];
			const notice = new Notice(
				`Engram: frontmatter problem in "${path.split("/").pop()}"`,
				DEGRADED_NOTICE_DURATION_MS,
			);
			const noticeEl = (notice as unknown as { noticeEl?: HTMLElement }).noticeEl;
			const link = noticeEl?.createEl("a", { text: "Open note" });
			link?.addEventListener("click", () => void this.app.workspace.openLinkText(path, ""));
		} else {
			new Notice(
				`Engram: ${paths.length} notes have frontmatter problems. Open Sync Center to fix.`,
				DEGRADED_NOTICE_DURATION_MS,
			);
		}
	}

	/** Single source of truth for the "pushing" progress event. Both push paths
	 *  (pushModifiedFiles and pushAll) emit the identical shape; routing them
	 *  through one helper stops the two from drifting when the reporting changes. */
	private emitPushing(
		current: number,
		total: number,
		failed: number,
		currentPath?: string,
	): void {
		this.onSyncProgress?.({ phase: "pushing", current, total, failed, currentPath });
	}

	/** Shared push pipeline: every file — genesis notes, server-known notes,
	 *  attachments — rides ONE bounded per-file loop (Promise.all over
	 *  PUSH_BATCH_SIZE slices). pushFile's socket-native genesis (crdt_create)
	 *  owns brand-new notes; the retired crdt_create_batch RPC was a second,
	 *  lesser copy of that path (Relay-pattern rewrite: per-file work units,
	 *  per-file progress, per-file failure isolation — a failure strands one
	 *  file, not a 25-note chunk).
	 *
	 *  mode "force" (pushAll) writes per-file sync-log entries; "incremental"
	 *  (pushModifiedFiles) doesn't. In BOTH modes a per-file throw is counted
	 *  and recorded as an issue, never propagated — one bad file (or one
	 *  crdt_create timeout) must not abort the rest of a first sync. Progress
	 *  is emitted per completed file. */
	private async pushPartitioned(
		toSync: TFile[],
		mode: "incremental" | "force",
		base: { pushed: number; failed: number } = { pushed: 0, failed: 0 },
		serverAttachmentHashes?: Map<string, string>,
	): Promise<{ pushed: number; failed: number }> {
		const total = toSync.length;
		let pushed = 0;
		let failed = 0;
		for (let i = 0; i < toSync.length; i += PUSH_BATCH_SIZE) {
			const batch = toSync.slice(i, i + PUSH_BATCH_SIZE);
			await Promise.all(
				batch.map(async (f: TFile) => {
					try {
						const ok = await this.pushFile(
							f,
							mode === "force",
							false,
							serverAttachmentHashes,
						);
						if (ok) {
							pushed++;
							if (mode === "force") this.logEntry("push", f.path, "ok");
						} else if (mode === "force") {
							this.logEntry("skip", f.path, "skipped", undefined, "unchanged");
						}
					} catch (e) {
						failed++;
						this.onVaultScopedError?.(e);
						const msg = errMsg(e);
						this.logEntry("push", f.path, "error", msg);
						this.issues.record({
							path: f.path,
							kind: this.isBinaryFile(f) ? "attachment" : "note",
							category: "other",
							message: msg,
							firstFailedAt: Date.now(),
							lastFailedAt: Date.now(),
							attempts: 1,
						});
					}
					this.emitPushing(
						base.pushed + pushed,
						base.pushed + total,
						base.failed + failed,
						f.path,
					);
				}),
			);
		}
		// ONE line per sweep, at warn so it reaches Loki (client info does not).
		// This is the loop's actual signature: the same sweep firing over and
		// over with pushed=0 and everything skipped. Per-file logs cannot show
		// that shape without emitting one entry per file.
		rlog().warn(
			"push",
			`Sweep done (${mode}) — pushed=${pushed} skipped=${total - pushed - failed} failed=${failed} of ${total}`,
		);
		return { pushed, failed };
	}

	/** Push files modified since `sinceTimestamp` (default: `lastSync`) — both
	 *  genuinely-modified tracked files and never-before-synced local-only
	 *  notes (always included regardless of mtime). A brand-new note's first
	 *  push routes through pushFile's socket-native genesis (crdt_create) when
	 *  wired. Public: also called directly by the connect path (onLayoutReady,
	 *  Plan B1 Task 6), which no longer runs fullSync's REST pull leg but still
	 *  needs this push leg to create/upload local-only notes on (re)connect. */
	/** The one in-flight pushModifiedFiles run. The connect-path startup sync
	 *  and a user-driven sync (fullSync via the progress modal) can both call
	 *  this concurrently; two loops interleaving independent counters was the
	 *  progress bar "jumping 40→100→30" bug — and double-pushed every file.
	 *
	 *  Coalesce-with-rerun (same shape as catchupViaSeqReplay's single-flight):
	 *  a concurrent caller JOINS the running push AND schedules exactly one
	 *  follow-up run after it settles. Join-only (no rerun) swallowed a file
	 *  created after the running push snapshotted its file list — e2e test_39's
	 *  concurrent-push note sat unpushed until the next poll cycle. */
	private pushModifiedInFlight: Promise<{ pushed: number; failed: number }> | null = null;
	private pushModifiedAgain = false;

	async pushModifiedFiles(
		sinceTimestamp?: string,
	): Promise<{ pushed: number; failed: number; joined?: boolean }> {
		if (this.pushModifiedInFlight) {
			this.pushModifiedAgain = true;
			// `joined`: this caller's result is the SAME physical work as the run
			// it joined — callers that report counts (the startup Notice) use it
			// to avoid double-reporting what another surface already reported
			// (review finding 8).
			return this.pushModifiedInFlight.then((r) => ({ ...r, joined: true }));
		}
		this.pushModifiedInFlight = (async () => {
			try {
				let out = await this.pushModifiedFilesInner(sinceTimestamp);
				// Untracked (never-synced) files are always included regardless of
				// `since`, so the rerun's default window is enough for the joiner's
				// trigger; N joiners coalesce into ONE rerun. The rerun continues
				// the progress counters from `out` (base offsets) so the Uploading
				// row never snaps back to 0 mid-sync (review finding 7).
				while (this.pushModifiedAgain) {
					this.pushModifiedAgain = false;
					const more = await this.pushModifiedFilesInner(undefined, out);
					out = { pushed: out.pushed + more.pushed, failed: out.failed + more.failed };
				}
				return out;
			} finally {
				// Inside the async body — cleared synchronously after the LAST
				// pushModifiedAgain check with no await in between, so a joiner can
				// never set the flag into a window where it gets wiped unseen (the
				// .finally-on-the-promise variant had exactly that microtask race:
				// review finding 6).
				this.pushModifiedInFlight = null;
				this.pushModifiedAgain = false;
			}
		})();
		return this.pushModifiedInFlight;
	}

	private async pushModifiedFilesInner(
		sinceTimestamp?: string,
		base: { pushed: number; failed: number } = { pushed: 0, failed: 0 },
	): Promise<{ pushed: number; failed: number }> {
		// Use ?? not || so an empty-string prePullSync (first connect, never
		// synced) is preserved and maps to epoch below — || would discard "" and
		// fall back to this.lastSync, which pull() just advanced to server_time,
		// gating every tracked file behind `mtime > now` and skipping them all.
		const since = sinceTimestamp ?? this.lastSync;
		const sinceMs = since ? new Date(since).getTime() : 0;
		const files = this.app.vault.getFiles();
		let pushed = 0;

		const toSync = files.filter((f: TFile) => {
			if (!this.isSyncable(f) || this.shouldIgnore(f.path)) return false;
			if (!this.syncState.has(f.path)) return true;
			return f.stat.mtime > sinceMs;
		});
		devLog().log("push", `pushModifiedFiles: ${toSync.length} files modified since ${since}`);
		// warn, not info: client `info` never reaches Loki. A bulk sweep firing
		// repeatedly is the signature of a re-upload loop, and in 2026-08 that
		// signature was invisible server-side for 90 minutes.
		rlog().warn("push", `PushModified: ${toSync.length} files modified since ${since}`);

		// Drive the progress UI the same way pushAll does, so the Merge path
		// shows progress too (the engine emits nothing otherwise).
		const total = toSync.length;
		if (total > 0) {
			this.emitPushing(base.pushed, base.pushed + total, base.failed);
		}

		const outcome = await this.pushPartitioned(toSync, "incremental", base);
		pushed += outcome.pushed;

		this.flushAttachmentLimitedToast();
		this.flushFailureSummaryToast();
		// `failed` counts per-file failures (throws are caught + counted in
		// pushPartitioned). It used to be silently dropped here, letting
		// fullSync's recap claim "All synced" over real failures.
		return { pushed, failed: outcome.failed };
	}

	/** Compute what a sync would do without executing it (dry-run preview).
	 *
	 *  mode:
	 *  - "full"     — bidirectional: compute toPush, toPull, conflicts, deletions
	 *  - "push-all" — push only: compute toPush, skip toPull
	 *  - "pull-all" — pull only: compute toPull, skip toPush
	 *
	 *  Server state comes from ONE from-genesis op-log enumeration
	 *  (`enumerateServerState`) — delta and inventory in a single walk. The
	 *  REST-era split (manifest for inventory, GET /notes/changes for the
	 *  delta, epoch-widening when the manifest was missing) died with those
	 *  endpoints (#304). Per-path classification:
	 *  - identical bytes (row carries content)            → clean, skip
	 *  - server unchanged (row hash == recorded serverHash):
	 *      local unchanged → clean · local changed → toPush
	 *  - server changed: local unchanged → toPull · both changed → conflict
	 */
	async computeSyncPlan(mode: "push-all" | "pull-all" | "full"): Promise<SyncPlan> {
		const server = await this.enumerateServerState();
		const serverNotes = server.notes;
		const serverAttachments = server.attachments;

		// Enumerate local files
		const allFiles = this.app.vault.getFiles();
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

		// Categorise server note rows — each path classified exactly once.
		const toPullNotes: string[] = [];
		const conflictNotes: string[] = [];
		const toDeleteLocal: string[] = [];
		const toPushNotes: string[] = [];

		for (const [path, row] of serverNotes) {
			if (row.deleted) {
				// Server tombstone — mark for local deletion if present.
				if (localNoteSet.has(path)) toDeleteLocal.push(path);
				continue;
			}
			if (!localNoteSet.has(path)) {
				toPullNotes.push(path);
				continue;
			}
			const file = this.app.vault.getFileByPath(path);
			if (!file) {
				toPullNotes.push(path);
				continue;
			}
			const content = await this.app.vault.cachedRead(file);
			const localHash = fnv1a(content);
			// Identical bytes — nothing to do, regardless of bookkeeping.
			if (row.content !== undefined && localHash === fnv1a(row.content)) continue;
			const synced = this.syncState.get(path);
			const localChanged = synced?.hash !== undefined && localHash !== synced.hash;
			// The row's content_hash is the server-side HMAC — uncomputable
			// locally, but recorded as serverHash on every commit, so equality
			// proves the server hasn't moved since our last converge.
			const serverUnchanged =
				row.contentHash !== undefined &&
				synced?.serverHash !== undefined &&
				row.contentHash === synced.serverHash;
			if (serverUnchanged) {
				if (localChanged) toPushNotes.push(path);
				// else: neither side moved (row content just wasn't compared) — clean.
			} else if (localChanged) {
				conflictNotes.push(path);
			} else {
				toPullNotes.push(path);
			}
		}

		// Local-only notes → push. A path with ANY server row (even a tombstone)
		// is not "new" — the tombstone branch owns it (delete-wins; pushing would
		// fight the <60s recreate refusal).
		for (const path of localNotes) {
			if (serverNotes.has(path)) continue;
			// ...nor is a path the server DEMONSTRABLY holds, however stale the
			// enumeration above is. `crdtHead` is written only by a server-delivered
			// head or a confirmed create (see `markServerKnown`), so a non-null head
			// means the row exists server-side and this snapshot is merely older than
			// the pull that just landed the file.
			//
			// Without this, any re-plan DURING a sync — and a reconnect fires one —
			// offers the freshly downloaded vault straight back as an upload. That is
			// the "N files to upload" symptom (prod 2026-08-13; seen again 2026-08-19
			// as the preview flipping mid-run to upload what it had just downloaded).
			//
			// #424 fixed the WRITE-ROUTING half of this (pushFile consults
			// `hasServerNote`) and left the planner classifying on the snapshot alone:
			// one question asked of two predicates, only one of them wired up. That
			// split is why `test_90` stayed green — it asserts `pushed == 0`,
			// downstream of the miscount — while the number the modal renders stayed
			// wrong. Keep these two reading the same oracle.
			if (this.getCrdtHead(path) != null) continue;
			toPushNotes.push(path);
		}

		// Categorise server attachment rows
		const toPullAttachments: string[] = [];
		const toDeleteLocalAttach: string[] = [];
		for (const [path, { deleted }] of serverAttachments) {
			if (deleted) {
				if (localAttachSet.has(path)) toDeleteLocalAttach.push(path);
				continue;
			}
			if (!localAttachSet.has(path)) toPullAttachments.push(path);
		}

		const toPushAttachments: string[] = [];
		for (const path of localAttachments) {
			if (!serverAttachments.has(path)) toPushAttachments.push(path);
		}

		const liveNotePaths = [...serverNotes.entries()]
			.filter(([, v]) => !v.deleted)
			.map(([k]) => k);
		const liveAttachPaths = [...serverAttachments.entries()]
			.filter(([, v]) => !v.deleted)
			.map(([k]) => k);
		const serverPaths = [...liveNotePaths, ...liveAttachPaths];
		const localFolderCount = countFolders([...localNotes, ...localAttachments]);
		const serverFolderCount = countFolders(serverPaths);

		return {
			vaultName: this.app.vault.getName(),
			serverNoteCount: liveNotePaths.length,
			serverAttachmentCount: liveAttachPaths.length,
			serverFolderCount,
			localNoteCount: localNotes.length,
			localAttachmentCount: localAttachments.length,
			localFolderCount,
			localPaths: [...localNotes, ...localAttachments],
			serverPaths,
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

	/** Push every local syncable file to the server.
	 *
	 *  @param opts.replaceRemote — if true, delete EVERY remote note and
	 *    attachment first, then upload all local files, so the server ends up an
	 *    exact mirror of the local vault. Used by the "Delete all on remote, then
	 *    upload local files" sync direction. This literally wipes the server
	 *    before re-uploading (shared files are deleted then recreated); the user
	 *    confirms via the type-delete gate. Defaults to false (plain push that
	 *    leaves remote-only files untouched).
	 */
	/** Snapshot the syncable local paths right now. Callers capture this BEFORE
	 *  markSyncGateAccepted opens the gate, then pass it to pushAll({replaceRemote})
	 *  so the wipe uses local-truth-at-sync-start and a gate-open live delivery
	 *  can't shield a remote extra from the wipe (test_86). */
	snapshotLocalPaths(): Set<string> {
		return new Set(
			this.app.vault
				.getFiles()
				.filter((f: TFile) => this.isSyncable(f) && !this.shouldIgnore(f.path))
				.map((f: TFile) => normalizePath(f.path)),
		);
	}

	/** The server's current content hash per attachment path, fetched ONCE per
	 *  bulk sweep so a forced push can prove convergence instead of re-sending
	 *  every attachment in the vault. One request for the whole vault.
	 *
	 *  Returns undefined on any failure — including a `since_seq`-elided
	 *  manifest body. Undefined means "unproven", so force falls back to
	 *  re-uploading: the fail-safe direction is wasted bandwidth, never a
	 *  skipped upload the server actually needed.
	 *
	 *  COST: this is a SECOND manifest fetch per pushAll — `reconcile()` makes
	 *  its own afterwards. They are not interchangeable (this one asks what the
	 *  server had BEFORE the push; reconcile asks what it has after), so they
	 *  cannot be collapsed. Deliberate trade: ~240KB of manifest on the
	 *  incident vault against ~478MB of re-uploaded attachments. Only manual
	 *  full pushes pay it — the incremental path never calls this. */
	private async fetchServerAttachmentHashes(): Promise<Map<string, string> | undefined> {
		try {
			const manifest = await this.api.getManifest();
			if (!manifest?.attachments) return undefined;
			const map = new Map<string, string>();
			for (const entry of manifest.attachments) {
				if (entry.content_hash) map.set(normalizePath(entry.path), entry.content_hash);
			}
			return map;
		} catch (e) {
			// Never fail a push because the optimization's input was unavailable.
			rlog().warn(
				"push",
				`Attachment convergence check unavailable, forcing full re-upload: ${errMsg(e)}`,
			);
			return undefined;
		}
	}

	async pushAll(
		opts: { replaceRemote?: boolean; localSnapshot?: Set<string> } = {},
	): Promise<number> {
		// Thin wrapper so the sweep is marked without reindenting the whole body.
		return this.inBulkSweep(() => this.pushAllInner(opts));
	}

	private async pushAllInner(
		opts: { replaceRemote?: boolean; localSnapshot?: Set<string> } = {},
	): Promise<number> {
		if (this.syncBlocked) {
			devLog().log("sync-blocked", "pushAll short-circuited — gate closed");
			return 0;
		}
		this.syncLog?.clear();

		// Verify auth before pushing to give a clear error on bad API key
		const { ok, error } = await this.api.ping();
		if (!ok) {
			this.lastError = error ?? "Connection failed";
			this.emitStatus();
			throw new Error(this.lastError);
		}

		// Drop stale per-vault bookkeeping if the active vault changed.
		await this.invalidateIfVaultChanged();

		// Replace mode: enumerate the server's live note-ids + attachment-paths
		// (a from-0 op-log replay — the same authoritative server-set the
		// pull-all-delete path uses) so we can delete the server-ONLY extras
		// AFTER the push below. Captured here, BEFORE the push, so a note we are
		// about to (re)upload is never in the "server-only" set, and the local-id
		// set is snapshot-truth-at-sync-start (a genesis adoption re-minting an id
		// during the push cannot retroactively orphan a locally-present note).
		// The actual deletes run push-FIRST (below) — push-then-delete avoids the
		// 2026-07-08 wipe-before-enumerate vault-wipe incident.
		let replaceExtras: { ids: string[]; attachments: string[] } | null = null;
		if (opts.replaceRemote) {
			// The server-extra DELETE decision MUST come from an EXCLUSIVE replay: a
			// coalesced replay returns EMPTY sets, which here would silently under-
			// delete (no data loss, but the replace is incomplete). On persistent
			// contention, abort the delete pass entirely (replaceExtras stays null) —
			// the push below still runs (re-uploading local files is non-destructive).
			const replay = await this.catchupViaSeqReplayExclusive({
				fromZero: true,
				enumerateOnly: true,
			});
			if (!replay) {
				rlog().error(
					"push",
					"replace-remote extras enumeration never ran exclusively (persistent replay contention); skipping server-extra deletes — the push still ran",
				);
			} else {
				const { serverIds, serverAttachmentPaths } = replay;
				const snap = opts.localSnapshot ?? this.snapshotLocalPaths();
				const localIds = new Set<string>();
				for (const path of snap) {
					const id = this.noteIdMap?.get(path);
					if (id) localIds.add(id);
				}
				replaceExtras = {
					ids: [...serverIds].filter((id) => !localIds.has(id)),
					attachments: [...serverAttachmentPaths].filter(
						(p) => !snap.has(normalizePath(p)),
					),
				};
			}
		}

		const files = this.app.vault.getFiles();
		let toSync = files.filter((f: TFile) => this.isSyncable(f) && !this.shouldIgnore(f.path));
		// When a pre-gate snapshot is supplied (replace-remote), upload ONLY files
		// that existed before the sync gate opened. A note the gate-open race
		// delivered into the vault is a REMOTE extra (the delete step below removes
		// it server-side) — re-pushing it here would resurrect it (test_86) or 404
		// via the delete-wins guard. Scoping both push and the extras enumeration
		// to the snapshot makes the op exactly "remote := local-at-sync-start".
		if (opts.localSnapshot) {
			const snap = opts.localSnapshot;
			toSync = toSync.filter((f: TFile) => snap.has(normalizePath(f.path)));
		}

		let pushed = 0;
		let failed = 0;
		const total = toSync.length;

		devLog().log("push", `pushAll: ${total} files`);
		// warn, not info — see PushModified above (sweep entry is the loop tell).
		rlog().warn("push", `PushAll started — ${total} files`);

		this.emitPushing(0, total, 0);

		// Only worth a round trip if this sweep actually carries attachments —
		// a notes-only vault should not pay a whole-vault manifest fetch for a
		// map nothing will read.
		const outcome = await this.pushPartitioned(
			toSync,
			"force",
			undefined,
			toSync.some((f: TFile) => this.isBinaryFile(f))
				? await this.fetchServerAttachmentHashes()
				: undefined,
		);
		pushed += outcome.pushed;
		failed += outcome.failed;

		// Replace mode: every local file is now (re)pushed, so delete the
		// server-ONLY extras enumerated above. Note-ids go over the durable CRDT
		// op-log (`crdtDelete`); attachments are legitimately off the CRDT path (a
		// spec non-goal), so they use the REST attachment-delete `wipeRemote` used.
		// A locally-present note/attachment was just (re)pushed and is excluded
		// from these sets, so nothing local is deleted. Failures are logged, not
		// thrown, so a partial delete never aborts the sync.
		if (replaceExtras) {
			const delTotal = replaceExtras.ids.length + replaceExtras.attachments.length;
			let delDone = 0;
			this.onSyncProgress?.({ phase: "deleting", current: 0, total: delTotal, failed: 0 });
			for (const id of replaceExtras.ids) {
				try {
					await this.crdtDelete?.(id);
					this.logEntry("delete", id, "ok", undefined, "replace-remote");
				} catch (e) {
					this.logEntry("delete", id, "error", errMsg(e));
				}
				this.onSyncProgress?.({
					phase: "deleting",
					current: ++delDone,
					total: delTotal,
					failed: 0,
				});
			}
			for (const path of replaceExtras.attachments) {
				try {
					await this.api.deleteAttachment(path);
					this.logEntry("delete", path, "ok", undefined, "replace-remote");
				} catch (e) {
					this.logEntry("delete", path, "error", errMsg(e));
				}
				this.onSyncProgress?.({
					phase: "deleting",
					current: ++delDone,
					total: delTotal,
					failed: 0,
					currentPath: path,
				});
			}
		}

		// Flush first so the terminal "complete" can report the plan-skipped
		// tally (flush stashes it into lastBatchSkipped before resetting the
		// live counter). skipped and failed are disjoint — plan-skips never hit
		// the `failed` counter (pushFile returns false for them, no failed++).
		this.flushAttachmentLimitedToast();
		this.flushFailureSummaryToast();

		this.onSyncProgress?.({
			phase: "complete",
			current: pushed,
			total,
			failed,
			skipped: this.lastBatchSkipped,
		});

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
				// Same snapshot fence as the main push loop: when replace-remote
				// supplied a pre-gate snapshot, reconcile must not re-push a path
				// outside it. reconcile re-enumerates getFiles(), so a gate-open
				// race note (a server extra the delete step removed) would otherwise
				// be classified "missing" and resurrected here (delete-wins masks it).
				const snap = opts.localSnapshot;
				for (const path of toFix) {
					if (snap && !snap.has(normalizePath(path))) {
						continue;
					}
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

	/** Reconcile local vault against server manifest.
	 *  Returns null if server doesn't support the manifest endpoint.
	 *
	 *  The manifest's content_hash is an opaque server-side HMAC — it can
	 *  NEVER be computed locally (the old implementation compared an MD5 of
	 *  local content against it, which could not match). Divergence is
	 *  instead detected from two locally-knowable facts:
	 *    - local edits: fnv1a(local) differs from the stored synced hash
	 *    - server drift: the manifest hash differs from the stored serverHash
	 *      (only meaningful when a serverHash was recorded — pre-rev sync
	 *      state stays quiet rather than re-pushing the whole vault). */
	async reconcile(): Promise<ReconcileResult | null> {
		devLog().log("reconcile", "start");
		rlog().info("reconcile", "Reconcile started");
		// Reconcile is a post-push REPAIR pass — by the time it runs, every
		// file has already been uploaded. Letting a manifest failure escape
		// turned a sync that fully succeeded into a reported failure, and the
		// user's natural response to a failed sync is to run it again: that is
		// how a false failure becomes a re-upload loop. Scope the failure to
		// the step that owns it and answer `null`, which is the already-
		// established "could not reconcile" result every caller handles.
		let manifest: Awaited<ReturnType<typeof this.api.getManifest>>;
		try {
			manifest = await this.api.getManifest();
		} catch (e) {
			// Loud, not swallowed: the repair pass did not run, and a caller
			// reading only the push result would never know.
			rlog().warn("reconcile", `Reconcile skipped — manifest unavailable: ${errMsg(e)}`);
			return null;
		}
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
				serverNotes.delete(file.path);
				const stored = this.syncState.get(normalizePath(file.path));
				const content = await this.app.vault.cachedRead(file);
				const locallyModified = stored === undefined || stored.hash !== fnv1a(content);
				const serverDrifted =
					stored?.serverHash !== undefined && stored.serverHash !== serverHash;
				if (locallyModified || serverDrifted) {
					diverged.push(file.path);
				}
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

	/** Flush priority for a path.
	 *
	 *  A live-bound path is one the user has open in an editor — the single case
	 *  where queue latency is directly visible — so it outranks everything even
	 *  during a bulk sweep. Otherwise, work generated inside a bulk sweep sinks
	 *  to Background so an interactive edit made mid-import is not stuck behind
	 *  thousands of retries. */
	private priorityForPath(path: string): number {
		if (this.isLiveBound?.(path)) return QueuePriority.OpenNote;
		return this.bulkDepth > 0 ? QueuePriority.Background : QueuePriority.Normal;
	}

	/** Run `fn` with queue entries it produces marked as bulk work. A counter
	 *  rather than a boolean so a nested sweep cannot clear the mark while the
	 *  outer one is still running.
	 *
	 *  The two sweeps (fullSync, pushAll) do NOT nest today — fullSyncInner
	 *  pushes via `pushModifiedFiles`, not `pushAll`. This used to be justified
	 *  as "fullSync calls pushAll", which stopped being true and misled a
	 *  reader into believing the force path ran on every full sync. The counter
	 *  stays because it is correct for free; the claim does not. */
	private async inBulkSweep<T>(fn: () => Promise<T>): Promise<T> {
		this.bulkDepth += 1;
		try {
			return await fn();
		} finally {
			this.bulkDepth -= 1;
		}
	}

	/** Why the queue is not draining, or null when nothing is queued. Surfaced
	 *  in the Sync Center so a held queue reads as a reason instead of a
	 *  spinner. */
	queuedReason(): QueuedReason | null {
		return computeQueuedReason({
			queued: this.queue.size,
			inFlight: this.pushing.size,
			offline: this.offline,
			syncBlocked: this.syncBlocked,
		});
	}

	/** Queue a change for retry and go offline.
	 *
	 *  Assigns a flush priority when the caller did not: the note the user has
	 *  open jumps ahead of everything else, so a bulk import cannot make the file
	 *  being edited wait behind thousands of background entries. */
	private async enqueueChange(entry: QueueEntry): Promise<void> {
		await this.queue.enqueue({
			...entry,
			priority: entry.priority ?? this.priorityForPath(entry.path),
		});
		// Enqueuing a retry does NOT by itself mean we're disconnected — a single
		// file's server-side error (e.g. a storage 502) leaves the backend
		// perfectly reachable. The offline transition is decided separately via
		// maybeGoOffline(), only on true connection loss.
		this.emitStatus();
	}

	/** Record a terminal (non-retryable) flush failure in the Sync Center and
	 *  dequeue the entry so it doesn't retry forever. Reached only from the legacy
	 *  note/attachment catch since Phase E3 — the crdt drain branch makes no
	 *  fallible HTTP call anymore (it settles via the socket round-trip). */
	private async recordTerminalIssue(
		entry: QueueEntry,
		classified: ReturnType<typeof categorizeError>,
	): Promise<void> {
		const now = Date.now();
		this.issues.record({
			path: entry.path,
			kind: entry.kind ?? "note",
			category: classified.category,
			status: classified.status,
			message: classified.message,
			upgradeUrl: classified.upgradeUrl,
			firstFailedAt: now,
			lastFailedAt: now,
			attempts: 1,
		});
		if (issueDisposition(classified.category) === "informational") {
			this.attachmentLimitedThisBatch += 1;
		} else {
			this.failuresThisBatch += 1;
			this.firstFailureMessageThisBatch ??= classified.message;
		}
		await this.queue.dequeue(entry.path, this.entryVaultId(entry));
	}

	/** Decide the fate of a queue entry whose flush just failed, and act on it.
	 *  runFlushQueue's legacy note/attachment catch routes here (the crdt drain
	 *  branch stopped making HTTP calls in Phase E3). Terminal
	 *  errors (413, auth, plan-limit) park immediately; transient errors (network,
	 *  5xx) bump a PERSISTED attempt count and park only once they exhaust
	 *  RETRY_CAP — previously both paths hardcoded attempts=1, so a persistently-
	 *  failing entry retried forever and never surfaced as parked. Returns "retry"
	 *  (re-queued with the bumped count; caller stops this flush pass) or "parked"
	 *  (issue recorded + dequeued; caller keeps flushing the rest). */
	private async handleFlushFailure(entry: QueueEntry, e: unknown): Promise<"parked" | "retry"> {
		const classified = categorizeError(e);
		const attempts = (entry.attempts ?? 0) + 1;
		if (shouldRetryAfterFailure(classified, attempts)) {
			// Transient and under the cap: persist the bumped count (survives
			// reload) and stop this pass. Deliberately records NO issue — a
			// transient blip stays silent until it exhausts its retries.
			await this.queue.enqueue({ ...entry, attempts });
			this.maybeGoOffline(e);
			return "retry";
		}
		// Terminal, or transient past RETRY_CAP. A crdt entry's content lives in
		// the durable Y.Doc (keyed by noteId, not in this content-free entry), so
		// re-enroll it to re-drive delivery over the CRDT channel — the edit is
		// never lost even though REST couldn't carry it (e.g. a 413 too-large
		// /updates that the channel handshake can still merge). Then record a Sync
		// Center issue + dequeue so it stops looping.
		if (entry.crdt && entry.noteId) this.crdtEnrollment?.enroll(entry.noteId);
		await this.recordTerminalIssue(entry, classified);
		return "parked";
	}

	/** Flip to offline ONLY when the failure indicates true connection loss
	 *  (no HTTP response). A per-file HTTP status error is that file's problem,
	 *  surfaced in the Sync Center — it must not report the whole plugin as
	 *  disconnected. */
	private maybeGoOffline(cause: unknown): void {
		if (shouldGoOffline(cause)) this.goOffline();
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
			rlog().error("queue", `Flush failed after reconnect: ${errMsg(e)}`);
		});
	}

	/** Start health checks while offline, with exponential backoff (5s → 10s →
	 *  … capped at 60s) so a long outage doesn't hammer the server every 30s.
	 *  The backoff resets when we reconnect (stopHealthCheck). */
	private startHealthCheck(): void {
		if (this.healthCheckTimer) return;
		const tick = () => {
			this.healthCheckTimer = this.time.setTimeout(() => {
				void (async () => {
					try {
						if (await this.api.health()) {
							this.goOnline();
							return;
						}
					} catch {
						// Still offline
					}
					this.healthCheckFailures++;
					tick();
				})();
			}, healthCheckDelay(this.healthCheckFailures));
		};
		tick();
	}

	/** Stop health checks and reset the backoff. */
	private stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			this.time.clearTimeout(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
		this.healthCheckFailures = 0;
	}

	/** Flush queued changes oldest-first. Stops on first failure. */
	/** Retry every transient (auto-retryable) failure now — including ones
	 *  already parked past RETRY_CAP — by re-enqueuing a content-free entry and
	 *  flushing. Non-transient failures — actionable (too_large, auth, conflict)
	 *  and informational (needs_pro, quota) — are left alone; retrying can't fix
	 *  them. Wired to "Retry all now". */
	async retryFailedNow(): Promise<number> {
		for (const issue of this.issues.all()) {
			if (issueDisposition(issue.category, issue.parseReason) !== "transient") continue;
			const file = this.app.vault.getFileByPath(normalizePath(issue.path));
			if (!file) {
				// File no longer exists locally — the failure is moot.
				this.issues.clear(issue.path);
				continue;
			}
			await this.queue.enqueue({
				path: issue.path,
				action: "upsert",
				kind: issue.kind,
				mtime: file.stat.mtime / 1000,
				timestamp: Date.now(),
				vaultId: this.settings.vaultId ?? undefined,
			});
		}
		return this.flushQueue();
	}

	/** Single-flight wrapper around the queue drain. `goOnline()` fires a flush
	 *  fire-and-forget while other callers (post-pull catch-up, retryFailedNow,
	 *  and the e2e `restore_online` helper) may also await one. Two passes over
	 *  the same queue snapshot race: they double-push the same entries (each
	 *  duplicate collides on the server's note-path index) and, when a push
	 *  errors, one pass trips `maybeGoOffline()` + `break` mid-drain — so the
	 *  queue oscillates and never empties (root cause of the test_24
	 *  offline-replay flake). Coalesce to a single in-flight drain; concurrent
	 *  callers join it instead of competing. Mirrors the "coalesce concurrent
	 *  pulls" fix (#119). */
	flushQueue(): Promise<number> {
		if (this.flushInFlight) return this.flushInFlight;
		const pending = this.drainUntilStable().finally(() => {
			this.flushInFlight = null;
		});
		this.flushInFlight = pending;
		return pending;
	}

	/** Drain in re-snapshotting passes until the queue is empty or a pass makes
	 *  no progress / goes offline. Because callers coalesce onto one in-flight
	 *  flush, an entry enqueued WHILE a flush runs (e.g. retryFailedNow queues
	 *  then calls flushQueue, or a file edit lands mid-drain) would otherwise sit
	 *  stranded until the next unrelated trigger — its snapshot predates the
	 *  entry. Re-looping lets the active drain pick it up. */
	private async drainUntilStable(): Promise<number> {
		let total = 0;
		while (this.queue.size > 0) {
			const flushed = await this.runFlushQueue();
			total += flushed;
			// Stop on no progress (queue empty or all remaining entries failing)
			// or once a push tripped maybeGoOffline — don't hammer the server.
			if (flushed === 0 || this.offline) break;
		}
		return total;
	}

	private async runFlushQueue(): Promise<number> {
		const entries = this.queue.all();
		if (entries.length === 0) return 0;
		devLog().log("queue", `flush start — ${entries.length} entries`);
		rlog().info("queue", `Queue flush start — ${entries.length} entries`);

		let flushed = 0;
		for (const entry of entries) {
			// Sync gate closed (signed out / onboarding not accepted): stop pushing.
			// Checked per-entry so a drain already in flight when the gate closes
			// (e.g. sign-out mid-drain) halts instead of finishing the snapshot with
			// a now-empty bearer — the exact 401 spam this gate prevents. Remaining
			// entries stay queued and drain when the gate reopens (re-auth →
			// applySyncGate → fullSync → pushModifiedFiles → flushQueue).
			if (this.syncBlocked) break;

			// The entry was created under a DIFFERENT vault. `this.api` points at
			// whichever vault is active now, so delivering it executes against the
			// wrong one — and for a delete that is destructive: an offline delete
			// of `Notes/x.md` queued in vault A fires `deleteNote("Notes/x.md")`
			// against vault B once the consent gate reopens, destroying an
			// unrelated note at the same path. The entries have always carried a
			// `vaultId`, but it was used only as a DEDUP key, never to gate
			// delivery. `CrdtOpQueue.dropIfForeignVault` already does exactly this
			// for the CRDT outbox; the REST queue was the one that did not (#1409
			// review).
			const owner = this.entryVaultId(entry);
			const active = this.settings.vaultId;
			if (owner && active && owner !== active) {
				rlog().warn(
					"queue",
					`Dropping queued op for ${noteRef(entry.path)} — queued under a different ` +
						`vault (${owner.slice(0, 8)}), active is ${active.slice(0, 8)}`,
				);
				await this.queue.dequeue(entry.path, owner);
				continue;
			}

			try {
				if (entry.action === "delete") {
					// FENCE (#416 review finding 0): the drain is a delete-push path
					// too. Entries persisted before the fence shipped (or by a
					// pre-fence plugin — the incident's poisoned queues) carry no
					// evidence stamp; replaying them blind re-runs the incident
					// around the handleDelete fence. Drop them loudly: the server
					// copy survives and the next pull reconciles.
					//
					// DELIBERATE migration cost (#419 pre-merge review): a LEGIT
					// delete queued by the one release that had the evidence rule
					// but not this stamp is indistinguishable from a poisoned entry
					// and gets dropped too — the deleted file resurrects once and
					// the user deletes it again. Poisoned entries and legit ones
					// cannot be told apart retroactively (both dropped their
					// syncState at delete time); dropping is the side whose failure
					// is recoverable.
					if (!entry.evidenced) {
						rlog().warn(
							"queue",
							`Queued delete DROPPED (no evidence stamp): ${noteRef(entry.path)}`,
						);
					} else {
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
					}
				} else if (entry.kind === "attachment") {
					// Legacy entries may have content inline; new entries are content-free
					let base64 = entry.contentBase64;
					let mimeType = entry.mimeType;
					let mtime = entry.mtime;
					if (!base64) {
						const file = this.app.vault.getFileByPath(entry.path);
						if (!file) {
							await this.queue.dequeue(entry.path, this.entryVaultId(entry));
							this.issues.clear(entry.path);
							flushed++;
							continue;
						}
						const buffer = await this.app.vault.readBinary(file);
						base64 = arrayBufferToBase64(buffer);
						mimeType = this.getMimeType(file);
						mtime = file.stat.mtime / 1000;
					}
					// This drain had NO content guard at all, so a queue entry that
					// failed to settle re-uploaded the same bytes on every flush —
					// one of the two paths behind the 2026-08-21 loop that held
					// prod at ~30% CPU. Mirror the live path's echo skip.
					const queuedNp = normalizePath(entry.path);
					const queuedHash = fnv1a(base64);
					const queuedRow = this.syncState.get(queuedNp);
					if (queuedRow !== undefined && queuedHash === queuedRow.hash) {
						// warn, not info: client `info` never reaches Loki, which is
						// why this loop was undiagnosable from the server side.
						rlog().warn(
							"queue",
							`Echo skip (attachment): ${noteRef(entry.path)} | hash=${queuedHash}`,
						);
					} else {
						const attResp = await this.api.pushAttachment(
							entry.path,
							base64,
							mimeType!,
							mtime!,
						);
						// MERGE, don't replace (review finding 6 wanted the evidence
						// stamp; a bare `set` also wiped any serverHash already
						// recorded for the path, which is the one fact a later force
						// push needs).
						this.patchSyncedRow(queuedNp, {
							hash: queuedHash,
							...(attResp?.attachment?.content_hash
								? { serverHash: attResp.attachment.content_hash }
								: {}),
						});
					}
				} else {
					// Durable CRDT delivery (Phase E3 — REST /updates deleted): the
					// edit lives durably in the Y.Doc (IndexedDB, keyed by noteId);
					// the queue entry is only the delivery nudge. With the channel
					// LIVE, one re-handshake ships it — the server answers the
					// client STEP1 with [STEP2, server-STEP1], and the client's
					// reply to the server's STEP1 carries the pending local ops.
					// The entry is NOT dequeued here: firing is not proof (the
					// STEP1 can be lost to a socket drop and enroll() surfaces no
					// failure). It settles in `commitCrdtConvergence` when an
					// inbound frame for the note proves the room round-tripped —
					// see `pendingQueueDeliveries`. With the channel DOWN there is
					// no delivery path at all: leave the entry queued (not a
					// failure, no retry-count bump) until a later flush finds the
					// channel up.
					if (entry.crdt && entry.noteId) {
						// The socket is the ONLY delivery path for a crdt entry — the
						// edit lives durably in the Y.Doc, so a whole-doc REST replay
						// could only stomp newer server state. Channel live → converge
						// now; down → leave the entry queued until a later flush finds
						// it up. (A noteId-less crdt entry — ancient plugin versions —
						// still falls through to the one-shot content replay below.)
						if (this.crdt && (this.crdtLive?.() ?? false)) {
							// Room-FREE first (#1493). This drain is what put 314 rooms
							// resident against a cap of 64: one re-handshake per queued
							// note, each allocating a server room for a note nobody has
							// open. A LIVE-BOUND note keeps the handshake — it already
							// has the room, so the round trip costs no extra residency,
							// and its ops ride the live socket either way.
							//
							// The server's ack IS the delivery proof, so this leg
							// dequeues inline rather than parking in
							// `pendingQueueDeliveries` to wait for an inbound frame that
							// a room-free write never produces.
							if (
								!this.isLiveBound(normalizePath(entry.path)) &&
								(await this.deliverQueuedOpsRoomFree(entry))
							) {
								await this.queue.dequeue(entry.path, this.entryVaultId(entry));
								this.issues.clear(entry.path);
								flushed++;
								continue;
							}

							this.pendingQueueDeliveries.set(entry.noteId, {
								path: entry.path,
								vaultId: this.entryVaultId(entry),
							});
							this.socketConverge(normalizePath(entry.path), entry.noteId);
						}
						continue;
					}

					// Note upsert — legacy entries have content; new entries are content-free
					let content = entry.content;
					let mtime = entry.mtime;
					if (content === undefined) {
						const file = this.app.vault.getFileByPath(entry.path);
						if (!file) {
							// The file is gone (deleted, or renamed away during the offline
							// window). A crdt entry's edit still lives in the durable Y.Doc
							// (keyed by noteId, not this stale path), so re-enroll to deliver
							// it over the CRDT channel instead of silently dropping it; a
							// non-crdt entry has nothing left to send.
							if (entry.crdt && entry.noteId)
								this.crdtEnrollment?.enroll(entry.noteId);
							await this.queue.dequeue(entry.path, this.entryVaultId(entry));
							this.issues.clear(entry.path);
							flushed++;
							continue;
						}
						content = await this.app.vault.cachedRead(file);
						mtime = file.stat.mtime / 1000;
					}
					// Mint-and-send the client id like a live push — and adopt the id
					// the server echoes back. The replay path never adopted, so a
					// create-race during the offline window left the CRDT receive
					// path keyed to a dead local id (2026-07-07 incident class).
					const replayNp = normalizePath(entry.path);
					let replayId = this.noteIdMap?.get(replayNp) ?? null;
					if (!replayId && this.noteIdMap) {
						// MINT REFUSAL (#972/#217 parity) — see shouldDeferMint. Live
						// pushes and batch genesis refuse to mint for an engine-flushed
						// path whose id relocated away; the replay path must too, or a
						// stale queued entry mints a FRESH id and duplicates the note
						// server-side. Leave it queued — the next flush (after the echo
						// window) re-resolves against the settled map.
						if (this.shouldDeferMint(replayNp)) {
							rlog().info(
								"queue",
								`Replay mint refused (engine-flushed, id relocated away): ${noteRef(entry.path)}`,
							);
							continue;
						}
						replayId = uuid7();
						this.noteIdMap.set(replayNp, replayId);
					}
					// CAS base, mirroring pushFile: a queued edit may be STALE (the
					// server moved on during the offline window) — without base_hash
					// it sails past the v0.5.642 gate and overwrites content this
					// client never saw. Same 3-shape cascade as pushFile (several
					// tests pin pushNote's exact arguments.length).
					const replayState = this.syncState.get(replayNp);
					const replayBase = replayState?.serverHash;
					const resp =
						replayBase !== undefined
							? await this.api.pushNote(
									entry.path,
									content,
									mtime!,
									replayState?.version,
									replayId ?? undefined,
									replayBase,
								)
							: replayId
								? await this.api.pushNote(
										entry.path,
										content,
										mtime!,
										undefined,
										replayId,
									)
								: await this.api.pushNote(entry.path, content, mtime!);
					if ("conflict" in resp) {
						// Hand the conflict to the single-note flow, which owns 3-way
						// merge + resolution — previously a conflicting replay was
						// silently dequeued and the local edit vanished from the
						// pipeline with no conflict handling at all. pushFile re-reads
						// current disk content (fresher than the queued snapshot).
						const conflicted = this.app.vault.getFileByPath(entry.path);
						if (conflicted) await this.pushFile(conflicted, true);
					}
					// Record fresh sync state — without this the replayed push
					// leaves a stale version (next push 409s avoidably) and no
					// serverHash (hash-skip dedupe misses the echo).
					if (!("conflict" in resp) && content !== undefined) {
						const np = normalizePath(entry.path);
						this.stampSyncedRow(np, {
							hash: fnv1a(content),
							version: resp.note.version,
							serverHash: resp.note.content_hash,
						});
						if (resp.note.version != null) {
							this.baseStore?.set(np, content, resp.note.version);
						}
						if (resp.note.id) {
							this.noteIdMap?.set(np, resp.note.id);
							this.refireEnrollmentOnFirstConfirm(resp.note.id, entry.path, content);
							this.confirmNoteId(resp.note.id);
						}
					}
				}
				await this.queue.dequeue(entry.path, this.entryVaultId(entry));
				this.issues.clear(entry.path);
				flushed++;
			} catch (e) {
				// Terminal or retries-exhausted parks (issue + dequeue) and keeps
				// flushing; a transient under RETRY_CAP re-queues and stops this pass.
				if ((await this.handleFlushFailure(entry, e)) === "retry") break;
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
		// Every tracked collection registered for "destroy", timers cancelled by
		// the dispose hooks at their declarations. `syncState` is registered for
		// "vault" only and so is deliberately spared here: it is the persisted
		// sync baseline, not transient state.
		this.sweep("destroy");
		this.files.destroy();
		// Standalone timer handles — not collections, so they stay explicit.
		if (this.seqHealTimer !== null) {
			this.time.clearTimeout(this.seqHealTimer);
			this.seqHealTimer = null;
		}
		if (this.postPullDrainTimer !== null) {
			this.time.clearTimeout(this.postPullDrainTimer);
			this.postPullDrainTimer = null;
		}
		if (this.degradedNoticeTimer) this.time.clearTimeout(this.degradedNoticeTimer);
		this.degradedNoticeTimer = null;
		this.stopHealthCheck();
		this.queue.destroy();
	}
}
