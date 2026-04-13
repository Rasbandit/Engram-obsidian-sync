import { beforeEach, describe, expect, test } from "bun:test";
import { SyncLog } from "../src/sync-log";
import type { SyncLogEntry } from "../src/types";

function makeEntry(overrides: Partial<SyncLogEntry> = {}): SyncLogEntry {
	return {
		timestamp: new Date(),
		action: "push",
		path: "notes/test.md",
		result: "ok",
		...overrides,
	};
}

describe("SyncLog", () => {
	let log: SyncLog;

	beforeEach(() => {
		log = new SyncLog(5); // small capacity for testing
	});

	test("starts empty", () => {
		expect(log.entries()).toEqual([]);
		expect(log.errorCount()).toBe(0);
	});

	test("appends entries", () => {
		log.append(makeEntry({ path: "a.md" }));
		log.append(makeEntry({ path: "b.md" }));
		expect(log.entries()).toHaveLength(2);
		expect(log.entries()[0].path).toBe("a.md");
	});

	test("evicts oldest when capacity exceeded", () => {
		for (let i = 0; i < 7; i++) {
			log.append(makeEntry({ path: `note-${i}.md` }));
		}
		const entries = log.entries();
		expect(entries).toHaveLength(5);
		expect(entries[0].path).toBe("note-2.md");
		expect(entries[4].path).toBe("note-6.md");
	});

	test("counts errors", () => {
		log.append(makeEntry({ result: "ok" }));
		log.append(makeEntry({ result: "error", error: "500" }));
		log.append(makeEntry({ result: "error", error: "timeout" }));
		log.append(makeEntry({ result: "skipped" }));
		expect(log.errorCount()).toBe(2);
	});

	test("clear removes all entries", () => {
		log.append(makeEntry());
		log.append(makeEntry());
		log.clear();
		expect(log.entries()).toEqual([]);
		expect(log.errorCount()).toBe(0);
	});

	test("entries returns a copy, not the internal array", () => {
		log.append(makeEntry());
		const a = log.entries();
		const b = log.entries();
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});
});
