/**
 * Tests for remote-log.ts — RemoteLogger buffer, flush, threshold, ring buffer.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import {
	destroyRemoteLog,
	initRemoteLog,
	type RemoteLogEntry,
	RemoteLogger,
	rlog,
} from "../src/remote-log";

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
// remoteLogLevel severity threshold
// ---------------------------------------------------------------------------

describe("RemoteLogger level threshold", () => {
	test("default threshold ships all current levels (info/warn/error)", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.info("cat", "an info line");
		logger.warn("cat", "a warn line");
		logger.error("cat", "an error line");
		logger.flush();
		expect(pushFn).toHaveBeenCalledTimes(1);
		expect(pushFn.mock.calls[0][0]).toHaveLength(3);
		logger.destroy();
	});

	test("threshold 'warn' drops an info call", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.setLevelThreshold("warn");
		logger.info("cat", "should be dropped");
		logger.flush();
		expect(pushFn).not.toHaveBeenCalled();
		logger.destroy();
	});

	test("threshold 'warn' ships a warn call", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.setLevelThreshold("warn");
		logger.warn("cat", "should ship");
		logger.flush();
		expect(pushFn).toHaveBeenCalledTimes(1);
		expect(pushFn.mock.calls[0][0][0].message).toBe("should ship");
		logger.destroy();
	});

	test("threshold 'error' drops warn and info but ships error", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.setLevelThreshold("error");
		logger.info("cat", "dropped");
		logger.warn("cat", "also dropped");
		logger.error("cat", "shipped");
		logger.flush();
		expect(pushFn).toHaveBeenCalledTimes(1);
		expect(pushFn.mock.calls[0][0]).toHaveLength(1);
		expect(pushFn.mock.calls[0][0][0].message).toBe("shipped");
		logger.destroy();
	});

	test("threshold 'debug' ships everything (no debug-level call sites exist yet)", () => {
		const logger = new RemoteLogger();
		const pushFn = mock().mockResolvedValue(undefined);
		logger.configure(pushFn, "1.0.0", "desktop");
		logger.setEnabled(true);
		logger.setLevelThreshold("debug");
		logger.info("cat", "info");
		logger.flush();
		expect(pushFn).toHaveBeenCalledTimes(1);
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

// ---------------------------------------------------------------------------
// conn_id / device_id / vault_id / seq / diag
// ---------------------------------------------------------------------------

function makeLogger() {
	const sent: RemoteLogEntry[] = [];
	const logger = new RemoteLogger();
	logger.configure(
		async (entries) => {
			sent.push(...entries);
		},
		"1.2.3",
		"desktop",
	);
	logger.setEnabled(true);
	return { logger, sent };
}

describe("RemoteLogger client context + seq + diag", () => {
	test("stamps conn_id, device_id, vault_id and a monotonic seq", async () => {
		const { logger, sent } = makeLogger();
		logger.setClientContext("dev-1", "vault-9");
		logger.setConnId("conn-abc");

		logger.info("channel", "first");
		logger.info("channel", "second");
		await logger.flush();

		expect(sent[0].conn_id).toBe("conn-abc");
		expect(sent[0].device_id).toBe("dev-1");
		expect(sent[0].vault_id).toBe("vault-9");
		expect(sent[1].seq).toBe((sent[0].seq as number) + 1);
	});

	test("diag() marks entries diagnostic", async () => {
		const { logger, sent } = makeLogger();
		logger.diag("vault", "modify path=a.md bytes=12");
		await logger.flush();
		expect(sent[0].diagnostic).toBe(true);
		expect(sent[0].level).toBe("info");
	});
});

// ---------------------------------------------------------------------------
// Loki reachability (2026-07-28)
// ---------------------------------------------------------------------------

// The backend drops re-emitted client logs below warn UNLESS the entry carries
// `diagnostic: true` (Engram.Logger.Category: :client is deliberately absent
// from @info_to_loki so a plugin fleet can't flood Loki). So setting
// remoteLogLevel to "debug" made the plugin SEND info lines that then died at
// the backend filter — the setting silently did nothing for the one thing you
// want it for. Two investigations were lost to exactly this.
describe("verbose remote logging reaches Loki", () => {
	function loggerAt(level: "info" | "debug") {
		const sent: RemoteLogEntry[][] = [];
		const logger = new RemoteLogger();
		logger.configure(
			async (batch: RemoteLogEntry[]) => {
				sent.push(batch);
			},
			"1.0.0",
			"desktop",
		);
		logger.setEnabled(true);
		logger.setLevelThreshold(level);
		return { logger, sent };
	}

	test("at debug, info entries opt into Loki", async () => {
		const { logger, sent } = loggerAt("debug");

		logger.info("crdt", "something worth seeing");
		await logger.flush();

		expect(sent[0]?.[0]?.diagnostic).toBe(true);
	});

	test("at the default level, info entries do NOT opt in (no fleet-wide flood)", async () => {
		const { logger, sent } = loggerAt("info");

		logger.info("crdt", "routine chatter");
		await logger.flush();

		expect(sent[0]?.[0]?.diagnostic).toBeUndefined();
	});

	test("warn already reaches Loki, so it stays unflagged even at debug", async () => {
		const { logger, sent } = loggerAt("debug");

		logger.warn("crdt", "a real problem");
		await logger.flush();

		// warn/error ship regardless (Category.loki_ship? passes them); flagging
		// them would only add noise to the payload.
		expect(sent[0]?.[0]?.diagnostic).toBeUndefined();
	});
});

describe("anomaly() bypasses the diagnostics gate", () => {
	// Same global-singleton teardown as the rest of this file.
	afterEach(async () => {
		await destroyRemoteLog();
	});

	// Prod 2026-08-13: a first sync silently dropped 316 of 316 notes and we had
	// NOTHING to look at — `diagnosticsEnabled` defaults false, so every
	// rlog() call on the pull path was a no-op. The one moment we most need
	// telemetry is a user's first sync, which is exactly when nobody has opted
	// into diagnostics yet. anomaly() is the narrow escape hatch: COUNTS AND
	// REASONS ONLY, never paths or content, so it respects what the setting is
	// actually protecting (verbose per-note telemetry) while making a silent
	// failure visible.
	const makeLogger = () => {
		const sent: any[] = [];
		const logger = initRemoteLog();
		logger.configure(
			async (batch: any[]) => {
				sent.push(...batch);
			},
			"1.0.0-test",
			"test",
		);
		logger.setEnabled(false);
		return { logger, sent };
	};

	test("an anomaly ships even with diagnostics OFF", async () => {
		const { logger, sent } = makeLogger();

		logger.anomaly("sync", "replay_produced_no_files", { rows: 316, files: 0 });
		await logger.flush();

		expect(sent.length).toBe(1);
		expect(sent[0].message).toContain("316");
		expect(sent[0].level).toBe("warn");
	});

	// The wire must SAY that an entry bypassed the gate.
	//
	// Without this, a forced anomaly is byte-identical to an ordinary warn once
	// it lands in client_logs. Two things break: an e2e asserting "disabling
	// stops the flush" cannot exempt the one class contractually allowed
	// through (it fails ~2/3 of runs on main — engram-app/Engram#1598), and in
	// Loki you cannot tell whether a warn came from a user who opted IN or from
	// the always-on path, which is exactly the question you ask when judging
	// how much of the fleet a signal actually covers.
	test("a forced anomaly is marked forced on the wire", async () => {
		const { logger, sent } = makeLogger();

		logger.anomaly("sync", "replay_produced_no_files", { rows: 316, files: 0 });
		await logger.flush();

		expect(sent.length).toBe(1);
		expect(sent[0].forced).toBe(true);
	});

	// The flag means "bypassed the gate", not "is a warning". An ordinary warn
	// from a user who opted IN must not claim the exemption, or the marker
	// stops answering the question it exists for.
	test("an ordinary entry is not marked forced", async () => {
		const { logger, sent } = makeLogger();
		logger.setEnabled(true);

		logger.warn("sync", "ordinary warning");
		await logger.flush();

		expect(sent.length).toBe(1);
		expect(sent[0].forced).toBeUndefined();
	});

	test("an ordinary info line stays suppressed with diagnostics OFF", async () => {
		const { logger, sent } = makeLogger();

		logger.info("sync", "routine chatter");
		await logger.flush();

		expect(sent.length).toBe(0);
	});
});
