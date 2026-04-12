/**
 * Tests for dev-log.ts — ring buffer diagnostic logger.
 *
 * DEV_MODE is a bare global replaced by esbuild at build time.
 * We set it to true on globalThis before importing so initDevLog()
 * creates a real DevLogBuffer instead of returning noop.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Set DEV_MODE before importing dev-log so initDevLog() creates a live buffer
(globalThis as any).DEV_MODE = true;

import { destroyDevLog, devLog, initDevLog } from "../src/dev-log";

describe("DevLogBuffer (DEV_MODE=true)", () => {
	beforeEach(() => {
		initDevLog();
	});

	afterEach(() => {
		destroyDevLog();
	});

	test("initDevLog creates a live buffer and assigns globalThis.__engramLog", () => {
		const log = devLog();
		expect(log).toBeDefined();
		expect((globalThis as any).__engramLog).toBe(log);
	});

	test("devLog returns the current instance", () => {
		const a = devLog();
		const b = devLog();
		expect(a).toBe(b);
	});

	test("destroyDevLog resets to noop and deletes globalThis.__engramLog", () => {
		const live = devLog();
		destroyDevLog();
		const noop = devLog();
		expect(noop).not.toBe(live);
		expect((globalThis as any).__engramLog).toBeUndefined();
	});

	test("log stores entry with ISO timestamp, epoch ms, category, and message", () => {
		const log = devLog();
		log.log("push", "pushed test.md");
		const entries = log.dump();
		expect(entries).toHaveLength(1);
		expect(entries[0].cat).toBe("push");
		expect(entries[0].msg).toBe("pushed test.md");
		expect(entries[0].t).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
		expect(typeof entries[0].ms).toBe("number");
	});

	test("dump returns all entries as a shallow copy", () => {
		const log = devLog();
		log.log("a", "one");
		log.log("b", "two");
		const entries = log.dump();
		expect(entries).toHaveLength(2);
		// Verify it's a copy, not the internal array
		entries.pop();
		expect(log.dump()).toHaveLength(2);
	});

	test("dump(n) returns last n entries", () => {
		const log = devLog();
		log.log("a", "first");
		log.log("b", "second");
		log.log("c", "third");
		const last2 = log.dump(2);
		expect(last2).toHaveLength(2);
		expect(last2[0].cat).toBe("b");
		expect(last2[1].cat).toBe("c");
	});

	test("filter matches on category (case-sensitive match against lowered query)", () => {
		const log = devLog();
		log.log("push", "file one");
		log.log("pull", "file two");
		log.log("push", "file three");
		const results = log.filter("push");
		expect(results).toHaveLength(2);
	});

	test("filter matches case-insensitively on message", () => {
		const log = devLog();
		log.log("sync", "pushed Notes/Hello.md");
		log.log("sync", "pulled Notes/World.md");
		const results = log.filter("hello");
		expect(results).toHaveLength(1);
		expect(results[0].msg).toContain("Hello");
	});

	test("filter returns empty array when no matches", () => {
		const log = devLog();
		log.log("push", "test");
		expect(log.filter("nonexistent")).toHaveLength(0);
	});

	test("stats returns entry count and lastEntry", () => {
		const log = devLog();
		log.log("push", "first");
		log.log("pull", "second");
		const stats = log.stats();
		expect(stats.entries).toBe(2);
		expect((stats.lastEntry as any).cat).toBe("pull");
	});

	test("stats returns heapMB as N/A when performance.memory unavailable", () => {
		const log = devLog();
		const stats = log.stats();
		// Bun/Node don't have performance.memory (Chrome-only)
		// So this should be "N/A" in test environment
		expect(stats.heapMB).toBe("N/A");
		expect(stats.heapLimitMB).toBe("N/A");
	});

	test("stats returns null lastEntry when buffer is empty", () => {
		const log = devLog();
		const stats = log.stats();
		expect(stats.entries).toBe(0);
		expect(stats.lastEntry).toBeNull();
	});

	test("clear empties the buffer", () => {
		const log = devLog();
		log.log("a", "one");
		log.log("b", "two");
		expect(log.dump()).toHaveLength(2);
		log.clear();
		expect(log.dump()).toHaveLength(0);
	});

	test("ring buffer caps at 500 entries, drops oldest", () => {
		const log = devLog();
		for (let i = 0; i < 505; i++) {
			log.log("test", `entry-${i}`);
		}
		const entries = log.dump();
		expect(entries).toHaveLength(500);
		// First 5 entries (0-4) should be gone
		expect(entries[0].msg).toBe("entry-5");
		expect(entries[499].msg).toBe("entry-504");
	});
});

describe("noop logger", () => {
	beforeEach(() => {
		// Ensure we start with noop by destroying any live instance
		destroyDevLog();
	});

	test("devLog returns noop after destroyDevLog", () => {
		const log = devLog();
		// noop.dump returns empty array
		expect(log.dump()).toEqual([]);
	});

	test("noop.log does not throw", () => {
		const log = devLog();
		expect(() => log.log("test", "message")).not.toThrow();
	});

	test("noop.dump returns empty array", () => {
		expect(devLog().dump()).toEqual([]);
		expect(devLog().dump(5)).toEqual([]);
	});

	test("noop.filter returns empty array", () => {
		expect(devLog().filter("anything")).toEqual([]);
	});

	test("noop.stats returns empty object", () => {
		expect(devLog().stats()).toEqual({});
	});

	test("noop.clear does not throw", () => {
		expect(() => devLog().clear()).not.toThrow();
	});
});
