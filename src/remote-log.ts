/**
 * Remote logger — ships plugin errors and lifecycle events to the backend.
 *
 * Independent from dev-log.ts (which is tree-shaken in production).
 * Accepts a pushFn callback to avoid circular dependency with api.ts.
 */

export interface RemoteLogEntry {
	ts: string;
	level: "error" | "warn" | "info";
	category: string;
	message: string;
	stack?: string;
	plugin_version: string;
	platform: string;
	conn_id?: string;
	device_id?: string;
	vault_id?: string;
	seq?: number;
	diagnostic?: boolean;
	/** This entry bypassed the diagnostics gate (see `anomaly()`).
	 *
	 *  Provenance, not severity. Without it a forced anomaly is byte-identical
	 *  to an ordinary warn once stored, so nothing downstream can tell a signal
	 *  that covers the WHOLE fleet from one that only covers users who opted in
	 *  — and a test asserting "disabling stops the flush" cannot exempt the one
	 *  class contractually allowed through. */
	forced?: boolean;
}

type PushFn = (entries: RemoteLogEntry[]) => Promise<void>;

/** Shipping threshold for log entries. A call ships only if its own level's
 *  severity is at or above the configured threshold. "debug" has no emitting
 *  call sites yet (reserved for future verbose logging behind the dial). */
export type RemoteLogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_SEVERITY: Record<RemoteLogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const MAX_BUFFER = 200;
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 20;

/** The shape an anomaly line may take.
 *
 *  Values are numbers and booleans ONLY. A string cannot be passed, so there is
 *  no free text to sanitize and nothing to evade — which is the point.
 */
export type AnomalyCounts = Record<string, number | boolean>;

/** A fixed, developer-written slug: lowercase, digits, underscores. */
const ANOMALY_CODE = /^[a-z0-9_]+$/;

/** Return `value` only if it is a slug string, else `fallback`.
 *
 *  Returns the FALLBACK for a non-string rather than the input: `RegExp.test`
 *  stringifies its argument, so a bare ternary handed `12345` back the number
 *  and made the `: string` return type a lie. Only reachable through an
 *  untyped call, but this is the function that decides what ships. */
function safeSlug(value: unknown, fallback: string): string {
	return typeof value === "string" && ANOMALY_CODE.test(value) ? value : fallback;
}

/** Render an anomaly line from a code and counts.
 *
 *  Replaces a free-text message plus a redactor. The redactor could not work:
 *  it split on whitespace, so `Divorce settlement draft.md` lost only its last
 *  token, and `TFile.basename` — which Obsidian returns WITHOUT the extension —
 *  survived whole. A note title IS prose; no text filter can separate it from a
 *  reason string, because there is no difference to find.
 *
 *  So the free text is gone. `code` is a literal slug and anything else becomes
 *  `invalid_code`; values are coerced to a number or a boolean and anything
 *  else is dropped. A path cannot be expressed in this type. */
export function formatAnomaly(code: string, counts: AnomalyCounts | null = {}): string {
	const safeCode = safeSlug(code, "invalid_code");
	const pairs = Object.entries(counts ?? {}).flatMap(([key, value]) => {
		if (!ANOMALY_CODE.test(key)) return [];
		if (typeof value === "boolean") return [`${key}=${value}`];
		return Number.isFinite(value) ? [`${key}=${value}`] : [];
	});
	return pairs.length > 0 ? `${safeCode} ${pairs.join(" ")}` : safeCode;
}

export class RemoteLogger {
	private buffer: RemoteLogEntry[] = [];
	private flushTimer: number | null = null;
	private pushFn: PushFn | null = null;
	private enabled = false;
	private pluginVersion = "";
	private platform = "";
	private flushing = false;
	private connId: string | null = null;
	private deviceId: string | null = null;
	private vaultId: string | null = null;
	private seq = 0;
	private levelThreshold: RemoteLogLevel = "info";

	configure(pushFn: PushFn, pluginVersion: string, platform: string): void {
		this.pushFn = pushFn;
		this.pluginVersion = pluginVersion;
		this.platform = platform;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (enabled) {
			this.startTimer();
		} else {
			this.stopTimer();
			void this.flush();
		}
	}

	error(category: string, message: string, stack?: string): void {
		this.addEntry("error", category, message, stack);
	}

	warn(category: string, message: string): void {
		this.addEntry("warn", category, message);
	}

	info(category: string, message: string): void {
		this.addEntry("info", category, message);
	}

	setConnId(id: string | null): void {
		this.connId = id;
	}

	/** Set the minimum severity that ships. Entries below this level are
	 *  dropped before buffering (they never count toward the ring buffer or
	 *  flush threshold). Default "info" preserves today's behavior. */
	setLevelThreshold(level: RemoteLogLevel): void {
		this.levelThreshold = level;
	}

	setClientContext(deviceId: string | null, vaultId: string | null): void {
		this.deviceId = deviceId;
		this.vaultId = vaultId;
	}

	/** Diagnostic-flagged info entry (verbose firehose). The backend ships
	 *  diagnostic entries to Loki even at info level. */
	diag(category: string, message: string): void {
		this.addEntry("info", category, message, undefined, true);
	}

	async flush(): Promise<void> {
		if (this.flushing || this.buffer.length === 0 || !this.pushFn) return;

		const batch = this.buffer.splice(0, this.buffer.length);
		this.flushing = true;

		try {
			await this.pushFn(batch);
		} catch {
			// Put entries back (up to MAX_BUFFER)
			const space = MAX_BUFFER - this.buffer.length;
			if (space > 0) {
				this.buffer.unshift(...batch.slice(0, space));
			}
		} finally {
			this.flushing = false;
		}
	}

	async destroy(): Promise<void> {
		this.stopTimer();
		await this.flush();
		this.buffer = [];
		this.pushFn = null;
	}

	/** A silent failure the user cannot see and we cannot debug. Ships at warn
	 *  EVEN WHEN DIAGNOSTICS ARE OFF, and bypasses the level threshold.
	 *
	 *  Why the bypass exists: `diagnosticsEnabled` defaults false, so every
	 *  rlog() call is a no-op on a fresh install — and a user's FIRST sync is
	 *  simultaneously the most likely thing to break and the least likely to
	 *  have telemetry enabled. Prod 2026-08-13: a first sync dropped 316 of 316
	 *  notes and produced exactly zero client log lines to look at.
	 *
	 *  CONTRACT — ENFORCED, not asserted in a comment. BOTH string parameters
	 *  are slug-validated and `counts` holds numbers and booleans, so a path, a
	 *  title or note content cannot be expressed in any argument.
	 *
	 *  `category` is validated too, and that is not cosmetic. It was left free
	 *  while `code` was locked down, and it reads like a label slot — so
	 *  `anomaly(file.path, "note_skipped", { seq })` is a natural thing to
	 *  write. It rides the same force:true path, lands in `client_logs.category`
	 *  unvalidated, and the backend interpolates it into a Logger MESSAGE BODY
	 *  (`logs.ex`, "[client:#{category}]"), which RedactFilter refuses to touch
	 *  and which ships to Loki at warn. Same leak the free-text removal was for,
	 *  one argument to the left.
	 *
	 *  The previous shape took free text and ran a redactor over it. That could
	 *  not hold: the redactor split on whitespace, so a filename with spaces
	 *  (`Divorce settlement draft.md`) lost only its final token, and
	 *  `TFile.basename` — no extension — survived intact. A note title is
	 *  prose; no text filter separates it from a reason string, because there
	 *  is nothing to separate. Removing the free text removes the problem. */
	anomaly(category: string, code: string, counts: AnomalyCounts = {}): void {
		this.addEntry(
			"warn",
			safeSlug(category, "invalid_category"),
			formatAnomaly(code, counts),
			undefined,
			false,
			true,
		);
	}

	private addEntry(
		level: "error" | "warn" | "info",
		category: string,
		message: string,
		stack?: string,
		diagnostic?: boolean,
		force?: boolean,
	): void {
		if (!this.pushFn) return;
		if (!force) {
			if (!this.enabled) return;
			if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[this.levelThreshold]) return;
		}

		const entry: RemoteLogEntry = {
			ts: new Date().toISOString(),
			level,
			category,
			message,
			plugin_version: this.pluginVersion,
			platform: this.platform,
			seq: this.seq++,
		};
		// Verbose mode opts sub-warn entries into Loki. The backend keeps client
		// logs out of Loki below warn (Category: :client is absent from
		// @info_to_loki, so a whole plugin fleet can't flood it) and offers
		// exactly one escape hatch: `diagnostic: true`. Without this, setting
		// remoteLogLevel to "debug" made the plugin SEND info lines that the
		// backend then dropped — verbose logging that produced nothing to read.
		// Gated on "debug", never the "info" default, so the flood guard still
		// holds for everyone who hasn't explicitly asked for the firehose.
		// warn/error already ship, so flagging them would just pad the payload.
		if (this.levelThreshold === "debug" && LEVEL_SEVERITY[level] < LEVEL_SEVERITY.warn) {
			entry.diagnostic = true;
		}
		if (stack) entry.stack = stack;
		if (this.connId) entry.conn_id = this.connId;
		if (this.deviceId) entry.device_id = this.deviceId;
		if (this.vaultId) entry.vault_id = this.vaultId;
		if (diagnostic) entry.diagnostic = true;
		if (force) entry.forced = true;

		this.buffer.push(entry);

		// Ring buffer: drop oldest if over limit
		if (this.buffer.length > MAX_BUFFER) {
			this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
		}

		// Flush immediately if threshold reached
		if (this.buffer.length >= FLUSH_THRESHOLD) {
			void this.flush();
		}
	}

	private startTimer(): void {
		this.stopTimer();
		this.flushTimer = window.setInterval(() => {
			void this.flush();
		}, FLUSH_INTERVAL_MS);
	}

	private stopTimer(): void {
		if (this.flushTimer) {
			window.clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}
}

interface NoopLogger {
	error(category: string, message: string, stack?: string): void;
	warn(category: string, message: string): void;
	info(category: string, message: string): void;
	diag(category: string, message: string): void;
	anomaly(category: string, code: string, counts?: AnomalyCounts): void;
	setConnId(id: string | null): void;
	setClientContext(deviceId: string | null, vaultId: string | null): void;
	setLevelThreshold(level: RemoteLogLevel): void;
	flush(): Promise<void>;
	destroy(): Promise<void>;
	setEnabled(enabled: boolean): void;
	configure(pushFn: PushFn, pluginVersion: string, platform: string): void;
}

const _noop: NoopLogger = {
	error() {},
	warn() {},
	info() {},
	diag() {},
	anomaly() {},
	setConnId() {},
	setClientContext() {},
	setLevelThreshold() {},
	async flush() {},
	async destroy() {},
	setEnabled() {},
	configure() {},
};

let _instance: RemoteLogger | null = null;

export function initRemoteLog(): RemoteLogger {
	_instance = new RemoteLogger();
	return _instance;
}

export function rlog(): RemoteLogger | NoopLogger {
	return _instance ?? _noop;
}

export async function destroyRemoteLog(): Promise<void> {
	await _instance?.destroy();
	_instance = null;
}
