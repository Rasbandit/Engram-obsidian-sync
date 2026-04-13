import type { SyncLogEntry } from "./types";

export class SyncLog {
	private buffer: SyncLogEntry[] = [];
	private capacity: number;

	constructor(capacity = 500) {
		this.capacity = capacity;
	}

	append(entry: SyncLogEntry): void {
		this.buffer.push(entry);
		if (this.buffer.length > this.capacity) {
			this.buffer.splice(0, this.buffer.length - this.capacity);
		}
	}

	entries(): SyncLogEntry[] {
		return [...this.buffer];
	}

	errorCount(): number {
		return this.buffer.filter((e) => e.result === "error").length;
	}

	clear(): void {
		this.buffer.length = 0;
	}
}
