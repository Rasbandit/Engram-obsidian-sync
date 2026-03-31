/**
 * BaseStore — persists the last-synced content of each note as the "common ancestor"
 * for 3-way merge conflict resolution.
 *
 * Stored in a separate file from plugin data (sync-bases.json) because base content
 * is full note text, potentially megabytes, while syncState is ~50 bytes per entry.
 * Lazy-loaded after plugin ready to avoid blocking Obsidian startup.
 */

/** Minimal subset of Obsidian's DataAdapter used by BaseStore. */
export interface BaseStoreAdapter {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

export interface BaseEntry {
	content: string;
	version: number;
	/** Epoch ms — used for LRU eviction. */
	ts: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB

export class BaseStore {
	private entries: Map<string, BaseEntry> = new Map();
	private bytes = 0;

	constructor(
		private adapter: BaseStoreAdapter,
		private storagePath: string,
		private maxBytes: number = DEFAULT_MAX_BYTES,
	) {}

	get(path: string): BaseEntry | undefined {
		return this.entries.get(path);
	}

	set(path: string, content: string, version: number): void {
		const existing = this.entries.get(path);
		if (existing) {
			this.bytes -= this.entryBytes(path, existing);
		}
		const entry: BaseEntry = { content, version, ts: Date.now() };
		this.entries.set(path, entry);
		this.bytes += this.entryBytes(path, entry);
	}

	delete(path: string): void {
		const existing = this.entries.get(path);
		if (existing) {
			this.bytes -= this.entryBytes(path, existing);
			this.entries.delete(path);
		}
	}

	rename(oldPath: string, newPath: string): void {
		const entry = this.entries.get(oldPath);
		if (!entry) return;
		this.bytes -= this.entryBytes(oldPath, entry);
		this.entries.delete(oldPath);
		this.entries.set(newPath, entry);
		this.bytes += this.entryBytes(newPath, entry);
	}

	/** Evict oldest entries until total size is under the given limit. */
	prune(maxBytes: number = this.maxBytes): void {
		if (this.bytes <= maxBytes) return;

		// Sort by ts ascending (oldest first)
		const sorted = [...this.entries.entries()].sort((a, b) => a[1].ts - b[1].ts);
		for (const [path, entry] of sorted) {
			if (this.bytes <= maxBytes) break;
			this.bytes -= this.entryBytes(path, entry);
			this.entries.delete(path);
		}
	}

	/** Approximate total byte size of all entries. */
	estimateBytes(): number {
		return this.bytes;
	}

	async save(): Promise<void> {
		const obj: Record<string, BaseEntry> = Object.fromEntries(this.entries);
		await this.adapter.write(this.storagePath, JSON.stringify(obj));
	}

	async load(): Promise<void> {
		try {
			const raw = await this.adapter.read(this.storagePath);
			const obj = JSON.parse(raw) as Record<string, BaseEntry>;
			this.entries.clear();
			this.bytes = 0;
			for (const [path, entry] of Object.entries(obj)) {
				this.entries.set(path, entry);
				this.bytes += this.entryBytes(path, entry);
			}
		} catch {
			// Missing file or corrupt JSON — start fresh
			this.entries.clear();
			this.bytes = 0;
		}
	}

	/** Rough byte estimate for a single entry (path key + content + overhead). */
	private entryBytes(path: string, entry: BaseEntry): number {
		// 2 bytes per char (JS string encoding) + 32 bytes overhead for version/ts/object
		return (path.length + entry.content.length) * 2 + 32;
	}
}
