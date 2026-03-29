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
}

type PushFn = (entries: RemoteLogEntry[]) => Promise<void>;

const MAX_BUFFER = 200;
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 20;

export class RemoteLogger {
	private buffer: RemoteLogEntry[] = [];
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private pushFn: PushFn | null = null;
	private enabled = false;
	private pluginVersion = "";
	private platform = "";
	private flushing = false;

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
			this.flush();
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

	flush(): void {
		if (this.flushing || this.buffer.length === 0 || !this.pushFn) return;

		const batch = this.buffer.splice(0, this.buffer.length);
		this.flushing = true;

		this.pushFn(batch)
			.catch(() => {
				// Put entries back (up to MAX_BUFFER)
				const space = MAX_BUFFER - this.buffer.length;
				if (space > 0) {
					this.buffer.unshift(...batch.slice(0, space));
				}
			})
			.finally(() => {
				this.flushing = false;
			});
	}

	destroy(): void {
		this.stopTimer();
		this.flush();
		this.buffer = [];
		this.pushFn = null;
	}

	private addEntry(level: "error" | "warn" | "info", category: string, message: string, stack?: string): void {
		if (!this.enabled || !this.pushFn) return;

		const entry: RemoteLogEntry = {
			ts: new Date().toISOString(),
			level,
			category,
			message,
			plugin_version: this.pluginVersion,
			platform: this.platform,
		};
		if (stack) entry.stack = stack;

		this.buffer.push(entry);

		// Ring buffer: drop oldest if over limit
		if (this.buffer.length > MAX_BUFFER) {
			this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
		}

		// Flush immediately if threshold reached
		if (this.buffer.length >= FLUSH_THRESHOLD) {
			this.flush();
		}
	}

	private startTimer(): void {
		this.stopTimer();
		this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
	}

	private stopTimer(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}
}

interface NoopLogger {
	error(category: string, message: string, stack?: string): void;
	warn(category: string, message: string): void;
	info(category: string, message: string): void;
	flush(): void;
	destroy(): void;
	setEnabled(enabled: boolean): void;
	configure(pushFn: PushFn, pluginVersion: string, platform: string): void;
}

const _noop: NoopLogger = {
	error() {},
	warn() {},
	info() {},
	flush() {},
	destroy() {},
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

export function destroyRemoteLog(): void {
	_instance?.destroy();
	_instance = null;
}
