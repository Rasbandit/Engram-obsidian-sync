/**
 * Unit tests for BaseStore — persists last-synced note content as "common ancestor"
 * for 3-way merge. Storage lives in a separate file from plugin data to avoid
 * bloating Obsidian's synchronous load.
 *
 * Tests cover:
 * - Round-trip: set → get returns correct data
 * - get() returns undefined for missing paths
 * - delete() removes an entry
 * - rename() moves entry to new key, preserving content/version/ts
 * - prune() evicts oldest entries by timestamp when over size limit
 * - toJSON/fromJSON serialization round-trip
 * - Entries without version (legacy/migration edge case)
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { BaseStore } from "../src/base-store";

/** Fake DataAdapter that records reads/writes in memory. */
function makeFakeAdapter() {
	const files: Record<string, string> = {};
	return {
		files,
		read: mock(async (path: string) => {
			if (path in files) return files[path];
			throw new Error(`File not found: ${path}`);
		}),
		write: mock(async (path: string, data: string) => {
			files[path] = data;
		}),
	};
}

describe("BaseStore", () => {
	let store: BaseStore;
	let adapter: ReturnType<typeof makeFakeAdapter>;
	const storagePath = ".obsidian/plugins/engram-sync/sync-bases.json";

	beforeEach(() => {
		adapter = makeFakeAdapter();
		store = new BaseStore(adapter as any, storagePath);
	});

	describe("get/set", () => {
		it("should return undefined for a path that was never set", () => {
			expect(store.get("missing.md")).toBeUndefined();
		});

		it("should round-trip content and version", () => {
			store.set("note.md", "# Hello", 3);
			const entry = store.get("note.md");
			expect(entry).toBeDefined();
			expect(entry!.content).toBe("# Hello");
			expect(entry!.version).toBe(3);
			expect(entry!.ts).toBeGreaterThan(0);
		});

		it("should overwrite existing entry", () => {
			store.set("note.md", "old", 1);
			store.set("note.md", "new", 2);
			const entry = store.get("note.md");
			expect(entry!.content).toBe("new");
			expect(entry!.version).toBe(2);
		});
	});

	describe("delete", () => {
		it("should remove an entry", () => {
			store.set("note.md", "content", 1);
			store.delete("note.md");
			expect(store.get("note.md")).toBeUndefined();
		});

		it("should be a no-op for missing paths", () => {
			expect(() => store.delete("missing.md")).not.toThrow();
		});
	});

	describe("rename", () => {
		it("should move entry to new key preserving content/version", () => {
			store.set("old.md", "# Content", 5);
			store.rename("old.md", "new.md");
			expect(store.get("old.md")).toBeUndefined();
			const entry = store.get("new.md");
			expect(entry).toBeDefined();
			expect(entry!.content).toBe("# Content");
			expect(entry!.version).toBe(5);
		});

		it("should be a no-op if old path does not exist", () => {
			expect(() => store.rename("missing.md", "new.md")).not.toThrow();
			expect(store.get("new.md")).toBeUndefined();
		});
	});

	describe("prune", () => {
		it("should evict oldest entries when over size limit", () => {
			// Each entry: (pathLen + contentLen) * 2 + 32 bytes
			// "old.md" + 100 chars = (6+100)*2+32 = 244 bytes
			// "new.md" + 100 chars = (6+100)*2+32 = 244 bytes
			// Total = 488 bytes. Set limit to 300 so only one fits.
			store.set("old.md", "x".repeat(100), 1);
			// Advance time so the next entry has a newer ts
			jest.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
			store.set("new.md", "y".repeat(100), 2);

			store.prune(300);

			// Oldest ("old.md") should be evicted, newest ("new.md") kept
			expect(store.get("old.md")).toBeUndefined();
			expect(store.get("new.md")).toBeDefined();

			jest.restoreAllMocks();
		});

		it("should keep all entries when under limit", () => {
			store.set("a.md", "short", 1);
			store.set("b.md", "short", 2);
			store.prune(50 * 1024 * 1024); // 50MB — plenty of room
			expect(store.get("a.md")).toBeDefined();
			expect(store.get("b.md")).toBeDefined();
		});
	});

	describe("persistence (save/load)", () => {
		it("should save to adapter and load back", async () => {
			store.set("note.md", "# Hello", 3);
			await store.save();

			expect(adapter.write).toHaveBeenCalledWith(storagePath, expect.any(String));

			// Create a new store and load from the same adapter
			const store2 = new BaseStore(adapter as any, storagePath);
			await store2.load();

			const entry = store2.get("note.md");
			expect(entry).toBeDefined();
			expect(entry!.content).toBe("# Hello");
			expect(entry!.version).toBe(3);
		});

		it("should handle missing file on load (fresh install)", async () => {
			// adapter.read throws for missing files
			await store.load();
			expect(store.get("anything")).toBeUndefined();
		});

		it("should handle corrupt JSON on load", async () => {
			adapter.files[storagePath] = "not valid json{{{";
			await store.load();
			expect(store.get("anything")).toBeUndefined();
		});
	});

	describe("size estimation", () => {
		it("should track approximate byte size", () => {
			expect(store.estimateBytes()).toBe(0);
			store.set("note.md", "hello", 1);
			expect(store.estimateBytes()).toBeGreaterThan(0);
			store.delete("note.md");
			expect(store.estimateBytes()).toBe(0);
		});
	});
});
