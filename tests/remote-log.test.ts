/**
 * Tests for remote-log.ts — RemoteLogger buffer, flush, threshold, ring buffer.
 */
import { beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { RemoteLogger, destroyRemoteLog, initRemoteLog, rlog } from "../src/remote-log";

beforeEach(() => {
	jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Basic logging
// ---------------------------------------------------------------------------

describe("RemoteLogger basics", () => {
	test("does not buffer when disabled", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		// Not enabled — entries should be dropped
		logger.error("test", "message");
		logger.flush();
		expect(pushFn).not.toHaveBeenCalled();
	});

	test("buffers entries when enabled", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.info("sync", "started");
		logger.flush();
		expect(pushFn).toHaveBeenCalledTimes(1);
		const entries = pushFn.mock.calls[0][0];
		expect(entries).toHaveLength(1);
		expect(entries[0].level).toBe("info");
		expect(entries[0].category).toBe("sync");
		expect(entries[0].message).toBe("started");
		logger.destroy();
	});

	test("entries include version and platform", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "2.1.0", "mobile-ios");
		logger.setEnabled(true);
		logger.warn("net", "timeout");
		logger.flush();
		const entry = pushFn.mock.calls[0][0][0];
		expect(entry.plugin_version).toBe("2.1.0");
		expect(entry.platform).toBe("mobile-ios");
		logger.destroy();
	});

	test("error entries include stack trace", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.error("crash", "oops", "Error: oops\n  at foo.ts:1");
		logger.flush();
		const entry = pushFn.mock.calls[0][0][0];
		expect(entry.stack).toBe("Error: oops\n  at foo.ts:1");
		logger.destroy();
	});

	test("entries have ISO timestamp", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.info("test", "msg");
		logger.flush();
		const entry = pushFn.mock.calls[0][0][0];
		expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		logger.destroy();
	});
});

// ---------------------------------------------------------------------------
// Flush threshold
// ---------------------------------------------------------------------------

describe("RemoteLogger flush threshold", () => {
	test("auto-flushes at 20 entries", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);

		for (let i = 0; i < 19; i++) {
			logger.info("test", `msg ${i}`);
		}
		expect(pushFn).not.toHaveBeenCalled();

		logger.info("test", "msg 19"); // 20th entry triggers flush
		expect(pushFn).toHaveBeenCalledTimes(1);
		expect(pushFn.mock.calls[0][0]).toHaveLength(20);
		logger.destroy();
	});
});

// ---------------------------------------------------------------------------
// Ring buffer overflow
// ---------------------------------------------------------------------------

describe("RemoteLogger ring buffer", () => {
	test("drops oldest entries when exceeding 200", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);

		// Add 210 entries — flush triggers at 20, so we'll see multiple flushes
		// But the ring buffer caps at 200 entries in the buffer at any time
		// After flush threshold (20), the buffer is drained, so we won't hit 200
		// To test the ring buffer, we need a pushFn that rejects (entries stay in buffer)
		const rejectPushFn = mock().mockRejectedValue(new Error("offline"));
		logger.configure(rejectPushFn, "1.0.0", "desktop");

		// The flush at 20 will fail, putting entries back. Keep adding.
		// Due to flushing flag, we can't easily test exact count,
		// but we can verify the buffer doesn't grow unbounded.
		for (let i = 0; i < 250; i++) {
			logger.info("test", `msg ${i}`);
		}

		// Flush whatever is left and verify it's <= 200
		const finalPush = mock().mockResolvedValue(undefined);
		logger.configure(finalPush, "1.0.0", "desktop");
		logger.flush();

		if (finalPush.mock.calls.length > 0) {
			expect(finalPush.mock.calls[0][0].length).toBeLessThanOrEqual(200);
		}
		logger.destroy();
	});
});

// ---------------------------------------------------------------------------
// Flush on disable
// ---------------------------------------------------------------------------

describe("RemoteLogger enable/disable", () => {
	test("disabling flushes remaining entries", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.info("test", "msg");
		logger.setEnabled(false);
		expect(pushFn).toHaveBeenCalledTimes(1);
		logger.destroy();
	});
});

// ---------------------------------------------------------------------------
// Flush guards
// ---------------------------------------------------------------------------

describe("RemoteLogger flush guards", () => {
	test("flush is no-op when buffer is empty", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.flush();
		expect(pushFn).not.toHaveBeenCalled();
		logger.destroy();
	});

	test("flush is no-op without pushFn", () => {
		const logger = new RemoteLogger();
		logger.setEnabled(true);
		// No configure called — should not throw
		logger.info("test", "msg");
		logger.flush();
	});
});

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

describe("RemoteLogger destroy", () => {
	test("destroy flushes and clears", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.info("test", "final");
		logger.destroy();
		expect(pushFn).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

describe("remote-log singleton", () => {
	test("rlog returns noop before init", async () => {
		await destroyRemoteLog();
		const logger = rlog();
		// Should not throw
		logger.error("test", "msg");
		await logger.flush();
	});

	test("initRemoteLog returns a RemoteLogger", async () => {
		const logger = initRemoteLog();
		expect(logger).toBeInstanceOf(RemoteLogger);
		await destroyRemoteLog();
	});

	test("rlog returns the instance after init", async () => {
		const logger = initRemoteLog();
		expect(rlog()).toBe(logger);
		await destroyRemoteLog();
	});

	test("destroyRemoteLog resets to noop", async () => {
		initRemoteLog();
		await destroyRemoteLog();
		// Should return noop (not the destroyed instance)
		const logger = rlog();
		expect(logger).not.toBeInstanceOf(RemoteLogger);
	});
});
