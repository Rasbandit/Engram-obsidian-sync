/**
 * Offline queue — persists failed sync operations for retry when connectivity returns.
 *
 * Deduplicates by path: newer entries for the same path replace older ones.
 * Entries are flushed oldest-first.
 * Persistence is debounced to avoid O(n²) serialization during rapid enqueues.
 */
import { QueueEntry } from "./types";

export class OfflineQueue {
	private entries: Map<string, QueueEntry> = new Map();
	private persistFn: ((entries: QueueEntry[]) => Promise<void>) | null = null;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private persistDelayMs: number;

	constructor(persistDelayMs: number = 1000) {
		this.persistDelayMs = persistDelayMs;
	}

	/** Register a callback to persist queue state. */
	onPersist(fn: (entries: QueueEntry[]) => Promise<void>): void {
		this.persistFn = fn;
	}

	/** Load previously persisted entries (call once on startup). */
	load(entries: QueueEntry[]): void {
		this.entries.clear();
		for (const entry of entries) {
			this.entries.set(entry.path, entry);
		}
	}

	/** Add or replace a queued change for a path. Persistence is debounced. */
	async enqueue(entry: QueueEntry): Promise<void> {
		this.entries.set(entry.path, entry);
		this.schedulePersist();
	}

	/** Remove a path from the queue (after successful sync). Persists immediately. */
	async dequeue(path: string): Promise<void> {
		this.entries.delete(path);
		await this.persistNow();
	}

	/** Get all entries sorted by timestamp (oldest first). */
	all(): QueueEntry[] {
		return Array.from(this.entries.values()).sort(
			(a, b) => a.timestamp - b.timestamp,
		);
	}

	/** Number of queued entries. */
	get size(): number {
		return this.entries.size;
	}

	/** Clear all entries. Persists immediately. */
	async clear(): Promise<void> {
		this.entries.clear();
		await this.persistNow();
	}

	/** Cancel any pending persist timer. Call on plugin unload. */
	destroy(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
	}

	/** Schedule a debounced persist — coalesces rapid enqueues into one write. */
	private schedulePersist(): void {
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(async () => {
			this.persistTimer = null;
			await this.persistFn?.(this.all());
		}, this.persistDelayMs);
	}

	/** Persist immediately (cancels any pending debounced persist). */
	private async persistNow(): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		await this.persistFn?.(this.all());
	}
}
