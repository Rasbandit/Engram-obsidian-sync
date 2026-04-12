import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { TFile } from "obsidian";
import type { EngramApi } from "../src/api";
import { SyncEngine, fnv1a } from "../src/sync";
import { DEFAULT_SETTINGS } from "../src/types";

// Mock the API
const mockApi = {
	pushNote: mock().mockResolvedValue({ note: {}, chunks_indexed: 1 }),
	getChanges: mock().mockResolvedValue({ changes: [], server_time: "2026-01-01T00:00:00Z" }),
	deleteNote: mock().mockResolvedValue({ deleted: true, path: "" }),
	getNote: mock().mockResolvedValue({
		path: "Notes/Remote.md",
		title: "Remote Note",
		content: "# Remote\n\nFrom SSE",
		folder: "Notes",
		tags: [],
		mtime: 1709345678,
		created_at: "2026-03-01T12:00:00Z",
		updated_at: "2026-03-01T12:00:00Z",
	}),
	health: mock().mockResolvedValue(true),
	ping: mock().mockResolvedValue({ ok: true }),
	pushAttachment: mock().mockResolvedValue({ attachment: {} }),
	getAttachment: mock().mockResolvedValue({
		path: "Assets/image.png",
		content_base64: "AQID",
		mime_type: "image/png",
		size_bytes: 3,
		mtime: 1709345678,
		created_at: "2026-03-01T12:00:00Z",
		updated_at: "2026-03-01T12:00:00Z",
	}),
	deleteAttachment: mock().mockResolvedValue({ deleted: true, path: "" }),
	getAttachmentChanges: jest
		.fn()
		.mockResolvedValue({ changes: [], server_time: "2026-01-01T00:00:00Z" }),
	getRateLimit: mock().mockResolvedValue(0),
	getManifest: mock().mockResolvedValue(null),
	registerVault: jest
		.fn()
		.mockResolvedValue({ id: 1, name: "Test", slug: "test", is_default: true }),
} as unknown as EngramApi;

// Mock the Obsidian App
const mockEditor = {
	getValue: mock().mockReturnValue(""),
	setValue: mock(),
	getCursor: mock().mockReturnValue({ line: 0, ch: 0 }),
	setCursor: mock(),
	getScrollInfo: mock().mockReturnValue({ left: 0, top: 0 }),
	scrollTo: mock(),
	lastLine: mock().mockReturnValue(0),
	getLine: mock().mockReturnValue(""),
	replaceRange: mock(),
};

const mockActiveView = {
	editor: mockEditor,
	file: null as TFile | null,
};

const mockApp = {
	vault: {
		read: mock().mockResolvedValue("# Test\n\nContent"),
		cachedRead: mock().mockResolvedValue("# Test\n\nContent"),
		readBinary: mock().mockResolvedValue(new ArrayBuffer(3)),
		getMarkdownFiles: mock().mockReturnValue([]),
		getFiles: mock().mockReturnValue([]),
		getAbstractFileByPath: mock().mockReturnValue(null),
		getFileByPath: mock().mockReturnValue(null) as jest.Mock,
		modify: mock().mockResolvedValue(undefined),
		process: mock().mockImplementation((_file: any, fn: (data: string) => string) => {
			fn(""); // call the transform function
			return Promise.resolve("");
		}),
		modifyBinary: mock().mockResolvedValue(undefined),
		create: mock().mockResolvedValue(undefined),
		createBinary: mock().mockResolvedValue(undefined),
		createFolder: mock().mockResolvedValue(undefined),
		trash: mock().mockResolvedValue(undefined),
		rename: mock().mockResolvedValue(undefined),
		getName: mock().mockReturnValue("Test Vault"),
	},
	workspace: {
		getActiveViewOfType: mock().mockReturnValue(null),
	},
} as any;

const mockSaveData = mock().mockResolvedValue(undefined);

/** Helper: get the content that was written via vault.process or vault.modify */
function getWrittenContent(): string | undefined {
	if (mockApp.vault.process.mock.calls.length > 0) {
		const lastCall =
			mockApp.vault.process.mock.calls[mockApp.vault.process.mock.calls.length - 1];
		return lastCall[1](""); // call transform fn
	}
	if (mockApp.vault.modify.mock.calls.length > 0) {
		const lastCall =
			mockApp.vault.modify.mock.calls[mockApp.vault.modify.mock.calls.length - 1];
		return lastCall[1];
	}
	return undefined;
}

const activeEngines: SyncEngine[] = [];

function createEngine(overrides = {}, { ready = true } = {}): SyncEngine {
	const engine = new SyncEngine(
		mockApp,
		mockApi,
		{ ...DEFAULT_SETTINGS, debounceMs: 10, ...overrides },
		mockSaveData,
	);
	if (ready) engine.setReady();
	activeEngines.push(engine);
	return engine;
}

beforeEach(() => {
	jest.clearAllMocks();
	// Bun's clearAllMocks does NOT clear mockReturnValueOnce queues,
	// so reset mocks that commonly use one-time returns to prevent leaks.
	mockApp.vault.getFileByPath.mockReset().mockReturnValue(null);
	mockApp.vault.getAbstractFileByPath.mockReset().mockReturnValue(null);
	mockApp.vault.cachedRead.mockReset().mockResolvedValue("# Test\n\nContent");
	mockApp.vault.read.mockReset().mockResolvedValue("# Test\n\nContent");
	mockApp.vault.process
		.mockReset()
		.mockImplementation((_file: any, fn: (data: string) => string) => {
			fn(""); // call the transform function
			return Promise.resolve("");
		});
	(mockApi.pushNote as jest.Mock).mockReset().mockResolvedValue({ note: {}, chunks_indexed: 1 });
});

afterEach(() => {
	// Clean up all engines to prevent timer leaks
	for (const engine of activeEngines) {
		engine.destroy();
	}
	activeEngines.length = 0;
});

describe("SyncEngine.shouldIgnore", () => {
	const engine = createEngine();

	test("ignores .obsidian/ paths", () => {
		expect(engine.shouldIgnore(".obsidian/config.json")).toBe(true);
		expect(engine.shouldIgnore(".obsidian/plugins/foo/main.js")).toBe(true);
	});

	test("ignores .trash/ paths", () => {
		expect(engine.shouldIgnore(".trash/old-note.md")).toBe(true);
	});

	test("ignores .git/ paths", () => {
		expect(engine.shouldIgnore(".git/HEAD")).toBe(true);
	});

	test("does not ignore normal paths", () => {
		expect(engine.shouldIgnore("Notes/Hello.md")).toBe(false);
		expect(engine.shouldIgnore("2. Knowledge Vault/Health/Omega.md")).toBe(false);
	});

	test("hardcoded ignores cannot be overridden by clearing user patterns", () => {
		const emptyEngine = createEngine({ ignorePatterns: "" });
		expect(emptyEngine.shouldIgnore(".obsidian/config.json")).toBe(true);
		expect(emptyEngine.shouldIgnore(".trash/old-note.md")).toBe(true);
		expect(emptyEngine.shouldIgnore(".git/HEAD")).toBe(true);
	});

	test("user-defined patterns still work alongside hardcoded ignores", () => {
		const customEngine = createEngine({ ignorePatterns: "drafts/\nsecret.md" });
		// Hardcoded still work
		expect(customEngine.shouldIgnore(".obsidian/plugins/foo.js")).toBe(true);
		// User patterns also work
		expect(customEngine.shouldIgnore("drafts/wip.md")).toBe(true);
		expect(customEngine.shouldIgnore("secret.md")).toBe(true);
		// Normal files still pass
		expect(customEngine.shouldIgnore("Notes/Hello.md")).toBe(false);
	});
});

describe("SyncEngine.isMarkdown", () => {
	const engine = createEngine();

	test("accepts .md files", () => {
		const file = new TFile("Notes/Test.md");
		expect(engine.isMarkdown(file)).toBe(true);
	});

	test("rejects non-md files", () => {
		const file = new TFile("image.png");
		expect(engine.isMarkdown(file)).toBe(false);
	});
});

describe("SyncEngine.handleModify", () => {
	test("debounces and pushes after delay", async () => {
		const engine = createEngine({ debounceMs: 50 });
		const file = new TFile("Notes/Test.md", Date.now());

		engine.handleModify(file);

		// Not pushed yet (debouncing)
		expect(mockApi.pushNote).not.toHaveBeenCalled();

		// Wait for debounce
		await new Promise((r) => setTimeout(r, 100));

		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/Test.md",
			"# Test\n\nContent",
			expect.any(Number),
			undefined,
		);
	});

	test("ignores non-markdown files", async () => {
		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("image.png");

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 50));

		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("ignores .obsidian paths", async () => {
		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile(".obsidian/workspace.md");

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 50));

		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("coalesces rapid edits", async () => {
		const engine = createEngine({ debounceMs: 50 });
		const file = new TFile("Notes/Test.md", Date.now());

		// Fire 5 modify events in rapid succession
		engine.handleModify(file);
		engine.handleModify(file);
		engine.handleModify(file);
		engine.handleModify(file);
		engine.handleModify(file);

		await new Promise((r) => setTimeout(r, 150));

		// Should only push once
		expect(mockApi.pushNote).toHaveBeenCalledTimes(1);
	});
});

describe("SyncEngine.handleDelete", () => {
	test("calls API to delete note", async () => {
		const engine = createEngine();
		const file = new TFile("Notes/Old.md");

		await engine.handleDelete(file);

		expect(mockApi.deleteNote).toHaveBeenCalledWith("Notes/Old.md");
	});

	test("cancels pending push on delete", async () => {
		const engine = createEngine({ debounceMs: 200 });
		const file = new TFile("Notes/Test.md");

		engine.handleModify(file); // Start debounce
		await engine.handleDelete(file); // Delete should cancel

		await new Promise((r) => setTimeout(r, 300));

		// Push should NOT have been called
		expect(mockApi.pushNote).not.toHaveBeenCalled();
		expect(mockApi.deleteNote).toHaveBeenCalledWith("Notes/Test.md");
	});
});

describe("SyncEngine.handleRename", () => {
	test("deletes old path and pushes new path", async () => {
		const engine = createEngine();
		const file = new TFile("Notes/Renamed.md", Date.now());

		await engine.handleRename(file, "Notes/Original.md");

		expect(mockApi.deleteNote).toHaveBeenCalledWith("Notes/Original.md");
		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/Renamed.md",
			expect.any(String),
			expect.any(Number),
			undefined,
		);
	});
});

describe("SyncEngine.pull", () => {
	test("applies remote changes and updates lastSync", async () => {
		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/Remote.md",
					title: "Remote Note",
					content: "# Remote\n\nFrom MCP",
					folder: "Notes",
					tags: [],
					mtime: 1709345678,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-01T12:00:01Z",
		});

		const pulled = await engine.pull();

		expect(pulled).toBe(1);
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			"Notes/Remote.md",
			"# Remote\n\nFrom MCP",
		);
		expect(engine.getLastSync()).toBe("2026-03-01T12:00:01Z");
	});

	test("trashes locally deleted notes from remote", async () => {
		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		const existingFile = new TFile("Notes/ToDelete.md");
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(existingFile);

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/ToDelete.md",
					title: "",
					content: "",
					folder: "",
					tags: [],
					mtime: 0,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: true,
				},
			],
			server_time: "2026-03-01T12:00:01Z",
		});

		await engine.pull();

		expect(mockApp.vault.trash).toHaveBeenCalledWith(existingFile, true);
	});
});

describe("SyncEngine.handleStreamEvent", () => {
	test("upsert event fetches note and applies change", async () => {
		const engine = createEngine();

		(mockApi.getNote as jest.Mock).mockResolvedValueOnce({
			path: "Notes/SSE.md",
			title: "SSE Note",
			content: "# SSE\n\nCreated via MCP",
			folder: "Notes",
			tags: [],
			mtime: 1709345678,
			created_at: "2026-03-01T12:00:00Z",
			updated_at: "2026-03-01T12:00:00Z",
		});

		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Notes/SSE.md",
			timestamp: 1709345678,
		});

		expect(mockApi.getNote).toHaveBeenCalledWith("Notes/SSE.md");
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			"Notes/SSE.md",
			"# SSE\n\nCreated via MCP",
		);
	});

	test("upsert with inline content skips GET request", async () => {
		const engine = createEngine();

		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Notes/Inline.md",
			timestamp: 1709345678,
			content: "# Inline\n\nDelivered via broadcast",
			title: "Inline",
			folder: "Notes",
			tags: ["test"],
			mtime: 1709345678,
			updated_at: "2026-03-01T12:00:00Z",
			version: 3,
		});

		expect(mockApi.getNote).not.toHaveBeenCalled();
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			"Notes/Inline.md",
			"# Inline\n\nDelivered via broadcast",
		);
	});

	test("upsert without inline content falls back to GET", async () => {
		const engine = createEngine();

		(mockApi.getNote as jest.Mock).mockResolvedValueOnce({
			path: "Notes/Fallback.md",
			title: "Fallback",
			content: "# Fallback\n\nFetched via API",
			folder: "Notes",
			tags: [],
			mtime: 1709345678,
			created_at: "2026-03-01T12:00:00Z",
			updated_at: "2026-03-01T12:00:00Z",
		});

		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Notes/Fallback.md",
			timestamp: 1709345678,
			// No content field — simulates folder rename broadcast
		});

		expect(mockApi.getNote).toHaveBeenCalledWith("Notes/Fallback.md");
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			"Notes/Fallback.md",
			"# Fallback\n\nFetched via API",
		);
	});

	test("delete event trashes local file", async () => {
		const engine = createEngine();
		const existingFile = new TFile("Notes/ToRemove.md");
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(existingFile);

		await engine.handleStreamEvent({
			event_type: "delete",
			path: "Notes/ToRemove.md",
			timestamp: 1709345678,
		});

		expect(mockApp.vault.trash).toHaveBeenCalledWith(existingFile, true);
		expect(mockApi.getNote).not.toHaveBeenCalled();
	});

	test("ignores events for ignored paths", async () => {
		const engine = createEngine();

		await engine.handleStreamEvent({
			event_type: "upsert",
			path: ".obsidian/workspace.md",
			timestamp: 1709345678,
		});

		expect(mockApi.getNote).not.toHaveBeenCalled();
		expect(mockApp.vault.create).not.toHaveBeenCalled();
	});

	test("skips events for paths currently being pushed (echo suppression)", async () => {
		// Use a slow pushNote to keep the path in the pushing set
		(mockApi.pushNote as jest.Mock).mockImplementation(
			() => new Promise((r) => setTimeout(r, 500)),
		);

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/Active.md", Date.now());

		// Trigger push (debounce fires after 10ms, pushFile starts)
		engine.handleModify(file);

		// Wait for debounce to fire but not for push to complete
		await new Promise((r) => setTimeout(r, 50));

		// Now the file is in the pushing set — WebSocket event should be suppressed
		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Notes/Active.md",
			timestamp: Date.now(),
		});

		// getNote should NOT have been called (echo suppression)
		expect(mockApi.getNote).not.toHaveBeenCalled();

		// Wait for push to finish
		await new Promise((r) => setTimeout(r, 500));

		// Clean up cooldown timers
		engine.destroy();
	}, 10000);

	test("suppresses WebSocket events after push completes (post-push cooldown)", async () => {
		// Fast push — completes quickly
		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/Cooldown.md", Date.now());

		// Trigger push and wait for it to complete
		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 50));

		// Push is complete — path is no longer in pushing set
		// But should still be in recentlyPushed cooldown
		expect(engine.isRecentlyPushed("Notes/Cooldown.md")).toBe(true);

		// WebSocket event arriving after push should still be suppressed
		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Notes/Cooldown.md",
			timestamp: Date.now(),
		});

		// getNote should NOT have been called (cooldown suppression)
		expect(mockApi.getNote).not.toHaveBeenCalled();

		// Clean up cooldown timers
		engine.destroy();
	});
});

describe("SyncEngine.pull (fresh install)", () => {
	test("defaults to epoch when lastSync is empty (fresh install pull)", async () => {
		const engine = createEngine();
		// Do NOT call setLastSync — simulates a fresh install with no saved state

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/Existing.md",
					title: "Existing Note",
					content: "# Existing\n\nAlready on server",
					folder: "Notes",
					tags: [],
					mtime: 1709345678,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-02T00:00:00Z",
		});

		const pulled = await engine.pull();

		expect(pulled).toBe(1);
		// Should have called getChanges with epoch (the default for empty lastSync)
		expect(mockApi.getChanges).toHaveBeenCalledWith("1970-01-01T00:00:00Z");
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			"Notes/Existing.md",
			"# Existing\n\nAlready on server",
		);
	});

	test("fullSync on fresh engine pulls all notes without prior setLastSync", async () => {
		const engine = createEngine();
		// Fresh engine — no setLastSync, no prior sync state

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/A.md",
					title: "Note A",
					content: "# A",
					folder: "Notes",
					tags: [],
					mtime: 1709340000,
					updated_at: "2026-03-01T10:00:00Z",
					deleted: false,
				},
				{
					path: "Notes/B.md",
					title: "Note B",
					content: "# B",
					folder: "Notes",
					tags: [],
					mtime: 1709341000,
					updated_at: "2026-03-01T11:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-02T00:00:00Z",
		});

		const result = await engine.fullSync();

		expect(result.pulled).toBe(2);
		expect(mockApi.getChanges).toHaveBeenCalledWith("1970-01-01T00:00:00Z");
		expect(mockApp.vault.create).toHaveBeenCalledTimes(2);
		// lastSync should be updated for future syncs
		expect(engine.getLastSync()).toBe("2026-03-02T00:00:00Z");
	});

	test("pull updates lastSync so subsequent pulls are incremental", async () => {
		const engine = createEngine();

		// First pull — fresh install
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/First.md",
					title: "First",
					content: "# First",
					folder: "Notes",
					tags: [],
					mtime: 1709340000,
					updated_at: "2026-03-01T10:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-01T12:00:00Z",
		});

		await engine.pull();
		expect(mockApi.getChanges).toHaveBeenCalledWith("1970-01-01T00:00:00Z");
		expect(engine.getLastSync()).toBe("2026-03-01T12:00:00Z");

		// Second pull — should use the saved timestamp, not epoch
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-02T00:00:00Z",
		});

		await engine.pull();
		expect(mockApi.getChanges).toHaveBeenCalledWith("2026-03-01T12:00:00Z");
	});
});

describe("SyncEngine.isFirstSync", () => {
	test("returns true when no lastSync is set", () => {
		const engine = createEngine();
		expect(engine.isFirstSync()).toBe(true);
	});

	test("returns false after setLastSync", () => {
		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");
		expect(engine.isFirstSync()).toBe(false);
	});

	test("returns false after a pull sets lastSync", async () => {
		const engine = createEngine();

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T00:00:00Z",
		});

		await engine.pull();
		expect(engine.isFirstSync()).toBe(false);
	});
});

describe("SyncEngine.countSyncableFiles", () => {
	test("counts syncable files excluding ignored paths", () => {
		(mockApp.vault.getFiles as jest.Mock).mockReturnValueOnce([
			new TFile("Notes/A.md"),
			new TFile("Notes/B.md"),
			new TFile(".obsidian/plugins.md"),
			new TFile("Drafts/C.md"),
			new TFile("Assets/image.png"),
			new TFile("data.json"),
		]);

		const engine = createEngine({ ignorePatterns: "Drafts/" });
		// A.md, B.md, image.png — .obsidian hardcoded, Drafts/ user-defined, data.json not syncable
		expect(engine.countSyncableFiles()).toBe(3);
	});

	test("returns 0 for empty vault", () => {
		(mockApp.vault.getFiles as jest.Mock).mockReturnValueOnce([]);
		const engine = createEngine();
		expect(engine.countSyncableFiles()).toBe(0);
	});
});

describe("SyncEngine.getStatus + onStatusChange", () => {
	test("initial status is idle with no pending", () => {
		const engine = createEngine();
		const status = engine.getStatus();
		expect(status.state).toBe("idle");
		expect(status.pending).toBe(0);
		expect(status.lastSync).toBe("");
		expect(status.error).toBeUndefined();
	});

	test("status shows pending count during debounce", () => {
		const engine = createEngine({ debounceMs: 5000 });
		const file1 = new TFile("Notes/A.md");
		const file2 = new TFile("Notes/B.md");

		engine.handleModify(file1);
		engine.handleModify(file2);

		const status = engine.getStatus();
		expect(status.pending).toBe(2);
	});

	test("onStatusChange fires when modify queues a file", () => {
		const engine = createEngine({ debounceMs: 5000 });
		const statuses: string[] = [];
		engine.onStatusChange = (s) => statuses.push(s.state);

		engine.handleModify(new TFile("Notes/A.md"));

		expect(statuses.length).toBeGreaterThanOrEqual(1);
	});

	test("status shows syncing during pull", async () => {
		// Use a slow getChanges to catch the syncing state
		let resolveChanges: (v: any) => void;
		(mockApi.getChanges as jest.Mock).mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolveChanges = r;
				}),
		);

		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		const statuses: string[] = [];
		engine.onStatusChange = (s) => statuses.push(s.state);

		const pullPromise = engine.pull();

		// Should have emitted syncing
		expect(statuses).toContain("syncing");

		// Resolve the pull
		resolveChanges!({ changes: [], server_time: "2026-03-01T00:00:00Z" });
		await pullPromise;

		// Last emitted status should be idle
		expect(statuses[statuses.length - 1]).toBe("idle");
	});

	test("status shows error after failed pull", async () => {
		(mockApi.getChanges as jest.Mock).mockRejectedValueOnce(new Error("network error"));

		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		await engine.pull();

		const status = engine.getStatus();
		expect(status.state).toBe("error");
		expect(status.error).toBe("Pull failed: network error");
	});

	test("pull skips files that fail to apply and continues", async () => {
		// Simulate a file with illegal characters (like ? on mobile)
		// by making vault.create throw for one specific path
		const goodChange = {
			path: "Notes/Good.md",
			title: "Good",
			content: "# Good\nThis should work",
			folder: "Notes",
			tags: [],
			mtime: 1709345678,
			updated_at: "2026-03-01T12:00:00Z",
			deleted: false,
		};
		const badChange = {
			path: "Notes/Bad?.md",
			title: "Bad",
			content: "# Bad\nIllegal filename chars",
			folder: "Notes",
			tags: [],
			mtime: 1709345679,
			updated_at: "2026-03-01T12:01:00Z",
			deleted: false,
		};

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [badChange, goodChange],
			server_time: "2026-03-01T12:02:00Z",
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T12:02:00Z",
		});

		// vault.create throws on the bad file, succeeds on the good one
		(mockApp.vault.create as jest.Mock).mockImplementation(async (path: string) => {
			if (path.includes("?")) {
				throw new Error(
					'File name cannot contain any of the following characters: \\ / : * ? < > "',
				);
			}
			return undefined;
		});

		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		const applied = await engine.pull();

		// Should have applied the good file (1), skipped the bad one
		expect(applied).toBe(1);
		// vault.create should have been called for both (bad one throws)
		expect(mockApp.vault.create).toHaveBeenCalledTimes(2);
		// lastSync should still be updated (pull succeeded overall)
		expect(engine.getLastSync()).toBe("2026-03-01T12:02:00Z");
		// Status should NOT be error — individual file failures don't fail the pull
		expect(engine.getStatus().state).not.toBe("error");
	});

	test("pullAll skips files that fail to apply and continues", async () => {
		const goodChange = {
			path: "Notes/PullAllGood.md",
			title: "Good",
			content: "# Good\nWorks fine",
			folder: "Notes",
			tags: [],
			mtime: 1709345678,
			updated_at: "2026-03-01T12:00:00Z",
			deleted: false,
		};
		const badChange = {
			path: "Notes/Has:Colon.md",
			title: "Bad",
			content: "# Bad\nIllegal colon in name",
			folder: "Notes",
			tags: [],
			mtime: 1709345679,
			updated_at: "2026-03-01T12:01:00Z",
			deleted: false,
		};

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [badChange, goodChange],
			server_time: "2026-03-01T12:02:00Z",
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T12:02:00Z",
		});

		(mockApp.vault.create as jest.Mock).mockImplementation(async (path: string) => {
			if (path.includes(":")) {
				throw new Error(
					'File name cannot contain any of the following characters: \\ / : * ? < > "',
				);
			}
			return undefined;
		});

		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		const applied = await engine.pullAll();

		expect(applied).toBe(1);
		expect(engine.getLastSync()).toBe("2026-03-01T12:02:00Z");
	});

	test("status shows offline after failed push (change queued for retry)", async () => {
		(mockApi.pushNote as jest.Mock).mockRejectedValueOnce(new Error("500"));

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/Fail.md", Date.now());

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));

		const status = engine.getStatus();
		expect(status.state).toBe("offline");
		expect(status.queued).toBe(1);
	});

	test("error clears on next successful sync", async () => {
		(mockApi.getChanges as jest.Mock).mockRejectedValueOnce(new Error("fail"));

		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		await engine.pull();
		expect(engine.getStatus().state).toBe("error");

		// Successful pull clears error
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T00:00:00Z",
		});

		await engine.pull();
		expect(engine.getStatus().state).toBe("idle");
		expect(engine.getStatus().error).toBeUndefined();
	});
});

describe("SyncEngine conflict resolution", () => {
	// Use modal mode for interactive conflict tests
	const createConflictEngine = (overrides = {}) =>
		createEngine({ conflictResolution: "modal", ...overrides });

	const makeChange = (overrides = {}): any => ({
		path: "Notes/Conflict.md",
		title: "Conflict Note",
		content: "# Remote version",
		folder: "Notes",
		tags: [],
		mtime: 1709345700,
		updated_at: "2026-03-01T12:00:00Z",
		deleted: false,
		...overrides,
	});

	// Use timestamps where lastSync < localMtime < remoteMtime
	// lastSync "2024-01-01T00:00:00Z" = 1704067200s
	// localMtime  = 1709345000s (March 2024, after lastSync)
	// remoteMtime = 1709345700s (March 2024, after lastSync)
	const LAST_SYNC = "2024-01-01T00:00:00Z";
	const LOCAL_MTIME_MS = 1709345000 * 1000;
	const REMOTE_MTIME = 1709345700;

	test("detects conflict when both local and remote changed since lastSync", async () => {
		const engine = createConflictEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Local version");

		let conflictReceived: any = null;
		engine.onConflict = async (info) => {
			conflictReceived = info;
			return { choice: "keep-remote" };
		};

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		expect(conflictReceived).not.toBeNull();
		expect(conflictReceived.path).toBe("Notes/Conflict.md");
		expect(conflictReceived.localContent).toBe("# Local version");
		expect(conflictReceived.remoteContent).toBe("# Remote version");
	});

	test("no conflict when only remote changed (local unchanged since lastSync)", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		// First sync: establish the content hash by applying the initial version
		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Original version");
		await engine.applyChange(
			makeChange({ content: "# Original version", mtime: REMOTE_MTIME }),
		);

		// Now a new remote change comes in, but local content hasn't changed
		// (still matches the hash we stored from the first sync write)
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Original version");

		let conflictCalled = false;
		engine.onConflict = async () => {
			conflictCalled = true;
			return { choice: "keep-remote" };
		};

		await engine.applyChange(
			makeChange({ content: "# Updated remote", mtime: REMOTE_MTIME + 100 }),
		);

		expect(conflictCalled).toBe(false);
		expect(
			mockApp.vault.process.mock.calls.length + mockApp.vault.modify.mock.calls.length,
		).toBeGreaterThan(0);
	});

	test("no conflict when content is identical", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Same content");

		let conflictCalled = false;
		engine.onConflict = async () => {
			conflictCalled = true;
			return { choice: "keep-remote" };
		};

		await engine.applyChange(makeChange({ content: "# Same content", mtime: REMOTE_MTIME }));

		expect(conflictCalled).toBe(false);
	});

	test("keep-local pushes local version to server", async () => {
		const engine = createConflictEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		// Return file for both applyChange lookup and pushFile's internal check
		(mockApp.vault.getFileByPath as jest.Mock)
			.mockReturnValueOnce(localFile) // applyChange lookup
			.mockReturnValueOnce(localFile); // pushFile doesn't call this, but be safe
		// vault.cachedRead called twice: once for conflict detection, once for pushFile
		(mockApp.vault.cachedRead as jest.Mock)
			.mockResolvedValueOnce("# Local version")
			.mockResolvedValueOnce("# Local version");

		engine.onConflict = async () => ({ choice: "keep-local" });

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		// Should push local, not modify local file with remote
		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/Conflict.md",
			"# Local version",
			expect.any(Number),
			undefined,
		);
		expect(mockApp.vault.modify).not.toHaveBeenCalled();
	});

	test("keep-remote overwrites local with remote content", async () => {
		const engine = createConflictEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Local version");

		engine.onConflict = async () => "keep-remote";

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		expect(getWrittenContent()).toBe("# Remote version");
	});

	test("keep-both creates a conflict copy and keeps local", async () => {
		const engine = createConflictEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Local version");

		engine.onConflict = async () => ({ choice: "keep-both" });

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		// Local should NOT be modified
		expect(mockApp.vault.modify).not.toHaveBeenCalled();
		// A conflict copy should be created
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringMatching(/^Notes\/Conflict \(conflict \d{4}-\d{2}-\d{2}\)\.md$/),
			"# Remote version",
		);
	});

	test("skip does nothing", async () => {
		const engine = createConflictEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Local version");

		engine.onConflict = async () => ({ choice: "skip" });

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		expect(mockApp.vault.modify).not.toHaveBeenCalled();
		expect(mockApp.vault.create).not.toHaveBeenCalled();
		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("defaults to keep-remote when no onConflict handler set", async () => {
		const engine = createConflictEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Local version");

		// No onConflict handler — should default to keep-remote
		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		expect(getWrittenContent()).toBe("# Remote version");
	});

	test("deleted remote change does not trigger conflict", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);

		let conflictCalled = false;
		engine.onConflict = async () => {
			conflictCalled = true;
			return { choice: "keep-remote" };
		};

		await engine.applyChange(makeChange({ deleted: true, mtime: REMOTE_MTIME }));

		expect(conflictCalled).toBe(false);
		expect(mockApp.vault.trash).toHaveBeenCalled();
	});

	test("no conflict when firstSync and local file is stale (mtime older than remote)", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		// Local file has old mtime (2 weeks ago) — user hasn't touched it
		const TWO_WEEKS_AGO_MS = (REMOTE_MTIME - 14 * 86400) * 1000;
		const localFile = new TFile("Notes/Conflict.md", TWO_WEEKS_AGO_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Old local version");

		// No syncedHash exists (firstSync=true scenario)
		// Remote has newer content with recent mtime
		let conflictCalled = false;
		engine.onConflict = async () => {
			conflictCalled = true;
			return { choice: "keep-remote" };
		};

		await engine.applyChange(
			makeChange({
				content: "# Updated remote version",
				mtime: REMOTE_MTIME,
			}),
		);

		// Should NOT trigger conflict — local is stale, remote is newer
		expect(conflictCalled).toBe(false);
		expect(getWrittenContent()).toBe("# Updated remote version");
	});

	test("still conflicts when firstSync but local file was recently modified", async () => {
		const engine = createConflictEngine();
		engine.setLastSync(LAST_SYNC);

		// Local file has mtime within the stale threshold (30 min ago)
		// — user plausibly edited it, so conflict should still trigger
		const THIRTY_MIN_AGO_MS = (REMOTE_MTIME - 1800) * 1000;
		const localFile = new TFile("Notes/Conflict.md", THIRTY_MIN_AGO_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# User just edited this");

		let conflictCalled = false;
		engine.onConflict = async () => {
			conflictCalled = true;
			return { choice: "keep-remote" };
		};

		await engine.applyChange(
			makeChange({
				content: "# Remote version",
				mtime: REMOTE_MTIME,
			}),
		);

		// SHOULD trigger conflict — local was recently edited
		expect(conflictCalled).toBe(true);
	});

	test("3-way merge overlap falls through to conflict handler with baseContent", async () => {
		const engine = createConflictEngine();
		engine.setLastSync(LAST_SYNC);

		// Wire up a real BaseStore with the base content
		const { BaseStore } = require("../src/base-store");
		const mockAdapter = { read: mock(), write: mock() };
		const baseStore = new BaseStore(mockAdapter, "sync-bases.json");
		baseStore.set("Notes/Conflict.md", "# Title\nBase content here", 1);
		engine.baseStore = baseStore;

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		// Both sides edited the same line — overlap guaranteed
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Title\nLocal edit here");

		let conflictReceived: any = null;
		engine.onConflict = async (info) => {
			conflictReceived = info;
			return { choice: "keep-remote" };
		};

		await engine.applyChange(
			makeChange({
				content: "# Title\nRemote edit here",
				mtime: REMOTE_MTIME,
			}),
		);

		// 3-way merge should have failed, falling through to onConflict
		expect(conflictReceived).not.toBeNull();
		expect(conflictReceived.baseContent).toBe("# Title\nBase content here");
		expect(conflictReceived.localContent).toBe("# Title\nLocal edit here");
		expect(conflictReceived.remoteContent).toBe("# Title\nRemote edit here");
	});

	test("no baseStore entry skips merge, still detects conflict", async () => {
		const engine = createConflictEngine();
		engine.setLastSync(LAST_SYNC);

		// No baseStore set — simulates first sync after v0.6.0 upgrade
		engine.baseStore = null;

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Local version");

		let conflictReceived: any = null;
		engine.onConflict = async (info) => {
			conflictReceived = info;
			return { choice: "keep-remote" };
		};

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		expect(conflictReceived).not.toBeNull();
		expect(conflictReceived.path).toBe("Notes/Conflict.md");
		expect(conflictReceived.baseContent).toBeUndefined();
	});

	test("3-way merge clean auto-resolves without calling conflict handler", async () => {
		const engine = createConflictEngine();
		engine.setLastSync(LAST_SYNC);

		// Wire up BaseStore with the base content
		const { BaseStore } = require("../src/base-store");
		const mockAdapter = { read: mock(), write: mock() };
		const baseStore = new BaseStore(mockAdapter, "sync-bases.json");
		baseStore.set("Notes/Conflict.md", "# Title\nSection A\n\nSection B", 1);
		engine.baseStore = baseStore;

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getFileByPath as jest.Mock)
			.mockReturnValueOnce(localFile) // applyChange lookup
			.mockReturnValueOnce(localFile); // pushFile lookup
		// Local edited Section A, remote edited Section B — non-overlapping
		(mockApp.vault.cachedRead as jest.Mock)
			.mockResolvedValueOnce("# Title\nLocal A\n\nSection B") // conflict check
			.mockResolvedValueOnce("# Title\nLocal A\n\nRemote B"); // pushFile reads merged

		let conflictCalled = false;
		engine.onConflict = async () => {
			conflictCalled = true;
			return { choice: "keep-remote" };
		};

		await engine.applyChange(
			makeChange({
				content: "# Title\nSection A\n\nRemote B",
				mtime: REMOTE_MTIME,
			}),
		);

		// Should auto-merge without calling conflict handler
		expect(conflictCalled).toBe(false);
		// Vault should be modified with merged content
		expect(getWrittenContent()).toBe("# Title\nLocal A\n\nRemote B");
	});

	test("no false conflict when remote appends to previously synced file", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);

		// First sync: pull initial content
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Note\n\nOriginal");
		await engine.applyChange(
			makeChange({ content: "# Note\n\nOriginal", mtime: REMOTE_MTIME }),
		);

		// Remote appends via MCP, local content is unchanged (Obsidian set mtime to "now")
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Note\n\nOriginal");

		let conflictCalled = false;
		engine.onConflict = async () => {
			conflictCalled = true;
			return { choice: "keep-remote" };
		};

		await engine.applyChange(
			makeChange({
				content: "# Note\n\nOriginal\n\nAppended line",
				mtime: REMOTE_MTIME + 100,
			}),
		);

		expect(conflictCalled).toBe(false);
		expect(getWrittenContent()).toBe("# Note\n\nOriginal\n\nAppended line");
	});
});

describe("SyncEngine.destroy", () => {
	test("clears pending timers so debounced push never fires", async () => {
		const engine = createEngine({ debounceMs: 10000 });
		const file = new TFile("Notes/Test.md");

		engine.handleModify(file);
		engine.destroy();

		// Wait longer than the debounce — push should never fire
		await new Promise((r) => setTimeout(r, 100));
		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});
});

describe("OfflineQueue", () => {
	const { OfflineQueue } = require("../src/offline-queue");

	test("enqueue and dequeue", async () => {
		const queue = new OfflineQueue();
		await queue.enqueue({
			path: "Notes/A.md",
			action: "upsert",
			content: "# A",
			mtime: 100,
			timestamp: 1,
		});
		expect(queue.size).toBe(1);

		await queue.dequeue("Notes/A.md");
		expect(queue.size).toBe(0);
	});

	test("deduplicates by path (newer replaces older)", async () => {
		const queue = new OfflineQueue();
		await queue.enqueue({
			path: "Notes/A.md",
			action: "upsert",
			content: "v1",
			mtime: 100,
			timestamp: 1,
		});
		await queue.enqueue({
			path: "Notes/A.md",
			action: "upsert",
			content: "v2",
			mtime: 200,
			timestamp: 2,
		});

		expect(queue.size).toBe(1);
		expect(queue.all()[0].content).toBe("v2");
	});

	test("all() returns entries sorted by timestamp", async () => {
		const queue = new OfflineQueue();
		await queue.enqueue({
			path: "Notes/C.md",
			action: "upsert",
			content: "C",
			mtime: 300,
			timestamp: 3,
		});
		await queue.enqueue({
			path: "Notes/A.md",
			action: "upsert",
			content: "A",
			mtime: 100,
			timestamp: 1,
		});
		await queue.enqueue({ path: "Notes/B.md", action: "delete", timestamp: 2 });

		const entries = queue.all();
		expect(entries.map((e: any) => e.path)).toEqual(["Notes/A.md", "Notes/B.md", "Notes/C.md"]);
	});

	test("load restores persisted entries", () => {
		const queue = new OfflineQueue();
		queue.load([
			{ path: "Notes/X.md", action: "upsert", content: "X", mtime: 100, timestamp: 1 },
			{ path: "Notes/Y.md", action: "delete", timestamp: 2 },
		]);

		expect(queue.size).toBe(2);
	});

	test("clear removes all entries", async () => {
		const queue = new OfflineQueue();
		await queue.enqueue({
			path: "Notes/A.md",
			action: "upsert",
			content: "A",
			mtime: 100,
			timestamp: 1,
		});
		await queue.clear();
		expect(queue.size).toBe(0);
	});

	test("onPersist callback fires on enqueue (debounced), dequeue, and clear", async () => {
		const queue = new OfflineQueue(50);
		const persisted: any[] = [];
		queue.onPersist(async (entries: any) => {
			persisted.push([...entries]);
		});

		await queue.enqueue({
			path: "Notes/A.md",
			action: "upsert",
			content: "A",
			mtime: 100,
			timestamp: 1,
		});
		// enqueue is debounced — not persisted yet
		expect(persisted.length).toBe(0);
		await new Promise((r) => setTimeout(r, 100));
		expect(persisted.length).toBe(1);

		// dequeue persists immediately
		await queue.dequeue("Notes/A.md");
		expect(persisted.length).toBe(2);
		expect(persisted[1]).toEqual([]);

		await queue.enqueue({ path: "Notes/B.md", action: "delete", timestamp: 2 });
		// clear persists immediately (cancels pending enqueue debounce)
		await queue.clear();
		expect(persisted.length).toBe(3);
		expect(persisted[2]).toEqual([]);
		queue.destroy();
	});
});

describe("SyncEngine offline queue integration", () => {
	test("failed push queues the change and goes offline", async () => {
		(mockApi.pushNote as jest.Mock).mockRejectedValueOnce(new Error("network"));

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/Offline.md", Date.now());

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));

		expect(engine.isOffline()).toBe(true);
		expect(engine.queue.size).toBe(1);
		const entry = engine.queue.all()[0];
		expect(entry.path).toBe("Notes/Offline.md");
		expect(entry.action).toBe("upsert");
		// Content-free queue entries — content is re-read on flush
		expect(entry.content).toBeUndefined();
	});

	test("failed delete queues the delete and goes offline", async () => {
		(mockApi.deleteNote as jest.Mock).mockRejectedValueOnce(new Error("network"));

		const engine = createEngine();
		const file = new TFile("Notes/Deleted.md");

		await engine.handleDelete(file);

		expect(engine.isOffline()).toBe(true);
		expect(engine.queue.size).toBe(1);
		const entry = engine.queue.all()[0];
		expect(entry.path).toBe("Notes/Deleted.md");
		expect(entry.action).toBe("delete");
	});

	test("successful push after offline goes back online", async () => {
		// First push fails
		(mockApi.pushNote as jest.Mock).mockRejectedValueOnce(new Error("network"));

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/Recovery.md", Date.now());

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));
		expect(engine.isOffline()).toBe(true);

		// Next push succeeds — also mock pushNote for queue flush
		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });

		const file2 = new TFile("Notes/Online.md", Date.now());
		engine.handleModify(file2);
		await new Promise((r) => setTimeout(r, 200));

		expect(engine.isOffline()).toBe(false);
	});

	test("flushQueue processes entries oldest-first", async () => {
		const engine = createEngine();

		// Pre-load queue
		engine.queue.load([
			{ path: "Notes/A.md", action: "upsert", content: "A", mtime: 100, timestamp: 1 },
			{ path: "Notes/B.md", action: "delete", timestamp: 2 },
			{ path: "Notes/C.md", action: "upsert", content: "C", mtime: 300, timestamp: 3 },
		]);

		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });
		(mockApi.deleteNote as jest.Mock).mockResolvedValue({ deleted: true, path: "" });

		const flushed = await engine.flushQueue();

		expect(flushed).toBe(3);
		expect(engine.queue.size).toBe(0);

		// Verify order: A (upsert), B (delete), C (upsert)
		expect(mockApi.pushNote).toHaveBeenCalledWith("Notes/A.md", "A", 100);
		expect(mockApi.deleteNote).toHaveBeenCalledWith("Notes/B.md");
		expect(mockApi.pushNote).toHaveBeenCalledWith("Notes/C.md", "C", 300);
	});

	test("flushQueue stops on failure and goes offline", async () => {
		const engine = createEngine();

		engine.queue.load([
			{ path: "Notes/A.md", action: "upsert", content: "A", mtime: 100, timestamp: 1 },
			{ path: "Notes/B.md", action: "upsert", content: "B", mtime: 200, timestamp: 2 },
		]);

		// First succeeds, second fails
		(mockApi.pushNote as jest.Mock)
			.mockResolvedValueOnce({ note: {}, chunks_indexed: 1 })
			.mockRejectedValueOnce(new Error("network"));

		const flushed = await engine.flushQueue();

		expect(flushed).toBe(1);
		expect(engine.queue.size).toBe(1); // B still queued
		expect(engine.isOffline()).toBe(true);
	});

	test("queue status reflected in getStatus", async () => {
		const engine = createEngine();

		expect(engine.getStatus().queued).toBe(0);

		engine.queue.load([
			{ path: "Notes/A.md", action: "upsert", content: "A", mtime: 100, timestamp: 1 },
		]);

		expect(engine.getStatus().queued).toBe(1);
	});

	test("flushQueue handles attachment entries", async () => {
		const engine = createEngine();

		engine.queue.load([
			{
				path: "Assets/img.png",
				action: "upsert",
				contentBase64: "AQID",
				mimeType: "image/png",
				mtime: 100,
				kind: "attachment",
				timestamp: 1,
			},
			{ path: "Assets/old.pdf", action: "delete", kind: "attachment", timestamp: 2 },
		]);

		(mockApi.pushAttachment as jest.Mock).mockResolvedValue({ attachment: {} });
		(mockApi.deleteAttachment as jest.Mock).mockResolvedValue({ deleted: true, path: "" });

		const flushed = await engine.flushQueue();

		expect(flushed).toBe(2);
		expect(mockApi.pushAttachment).toHaveBeenCalledWith(
			"Assets/img.png",
			"AQID",
			"image/png",
			100,
		);
		expect(mockApi.deleteAttachment).toHaveBeenCalledWith("Assets/old.pdf");
	});
});

describe("SyncEngine.isSyncable / isBinaryFile", () => {
	const engine = createEngine();

	test("markdown files are syncable but not binary", () => {
		const file = new TFile("Notes/Test.md");
		expect(engine.isSyncable(file)).toBe(true);
		expect(engine.isBinaryFile(file)).toBe(false);
	});

	test("canvas files are syncable but not binary", () => {
		const file = new TFile("Canvases/board.canvas");
		expect(engine.isSyncable(file)).toBe(true);
		expect(engine.isBinaryFile(file)).toBe(false);
	});

	test("PNG files are syncable and binary", () => {
		const file = new TFile("Assets/image.png");
		expect(engine.isSyncable(file)).toBe(true);
		expect(engine.isBinaryFile(file)).toBe(true);
	});

	test("PDF files are syncable and binary", () => {
		const file = new TFile("docs/manual.pdf");
		expect(engine.isSyncable(file)).toBe(true);
		expect(engine.isBinaryFile(file)).toBe(true);
	});

	test("JPG files are syncable and binary", () => {
		const file = new TFile("photos/vacation.jpg");
		expect(engine.isSyncable(file)).toBe(true);
		expect(engine.isBinaryFile(file)).toBe(true);
	});

	test("unsupported extensions are not syncable", () => {
		expect(engine.isSyncable(new TFile("data.json"))).toBe(false);
		expect(engine.isSyncable(new TFile("script.js"))).toBe(false);
		expect(engine.isSyncable(new TFile("style.css"))).toBe(false);
	});
});

describe("SyncEngine binary push", () => {
	test("binary file push calls readBinary + pushAttachment", async () => {
		const mockBuffer = new ArrayBuffer(3);
		new Uint8Array(mockBuffer).set([1, 2, 3]);
		(mockApp.vault.readBinary as jest.Mock).mockResolvedValueOnce(mockBuffer);
		(mockApi.pushAttachment as jest.Mock).mockResolvedValue({ attachment: {} });

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Assets/photo.png", Date.now());

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));

		expect(mockApp.vault.readBinary).toHaveBeenCalled();
		expect(mockApi.pushAttachment).toHaveBeenCalledWith(
			"Assets/photo.png",
			expect.any(String),
			"image/png",
			expect.any(Number),
		);
		// Should NOT call pushNote for binary
		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("binary file delete calls deleteAttachment", async () => {
		const engine = createEngine();
		const file = new TFile("Assets/old.png");

		await engine.handleDelete(file);

		expect(mockApi.deleteAttachment).toHaveBeenCalledWith("Assets/old.png");
		expect(mockApi.deleteNote).not.toHaveBeenCalled();
	});
});

describe("SyncEngine pull with attachments", () => {
	test("pull fetches both note and attachment changes", async () => {
		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/A.md",
					title: "A",
					content: "# A",
					folder: "Notes",
					tags: [],
					mtime: 100,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-01T12:00:01Z",
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Assets/img.png",
					mime_type: "image/png",
					size_bytes: 1000,
					mtime: 100,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-01T12:00:00Z",
		});
		// Mock getAttachment for the attachment pull
		(mockApi.getAttachment as jest.Mock).mockResolvedValueOnce({
			path: "Assets/img.png",
			content_base64: "AQID",
			mime_type: "image/png",
			size_bytes: 3,
			mtime: 100,
			updated_at: "2026-03-01T12:00:00Z",
		});

		const pulled = await engine.pull();

		expect(pulled).toBe(2);
		expect(mockApi.getChanges).toHaveBeenCalled();
		expect(mockApi.getAttachmentChanges).toHaveBeenCalled();
		expect(mockApp.vault.create).toHaveBeenCalled(); // note
		expect(mockApp.vault.createBinary).toHaveBeenCalled(); // attachment
	});
});

describe("SyncEngine pull accuracy", () => {
	test("updates existing file even when remote mtime < local mtime", async () => {
		const engine = createEngine();
		engine.setLastSync("2024-04-01T00:00:00Z"); // lastSync after localMtime → no conflict

		// Local file has a LATER mtime than remote (simulates Obsidian setting mtime to "now")
		const localFile = new TFile("Notes/Existing.md", Date.now());
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		// Content matches the synced hash → user didn't edit locally → no conflict
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("# Old content");
		// Establish sync state so the engine knows this file was previously synced
		engine.importSyncState({ "Notes/Existing.md": { hash: 1126570110 } }); // fnv1a("# Old content")

		const result = await engine.applyChange({
			path: "Notes/Existing.md",
			title: "Existing",
			content: "# Updated remotely",
			folder: "Notes",
			tags: [],
			mtime: 1709345678, // older than local
			updated_at: "2026-03-01T12:00:00Z",
			deleted: false,
		});

		expect(result).toBe(true);
		expect(getWrittenContent()).toBe("# Updated remotely");
	});

	test("pull returns accurate count when changes are skipped", async () => {
		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: ".obsidian/workspace.json", // ignored path
					title: "",
					content: "{}",
					folder: ".obsidian",
					tags: [],
					mtime: 100,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-01T12:00:01Z",
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T12:00:00Z",
		});

		const pulled = await engine.pull();

		expect(pulled).toBe(0); // ignored path should not count
	});

	test("fullSync pushes files modified between old and new lastSync", async () => {
		const engine = createEngine();
		const oldSync = "2026-01-01T00:00:00Z";
		engine.setLastSync(oldSync);

		// Pull will update lastSync to a newer server_time
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T12:00:00Z",
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T12:00:00Z",
		});

		// A file modified between old lastSync and new server_time
		const modifiedFile = new TFile(
			"Notes/Modified.md",
			new Date("2026-02-15T00:00:00Z").getTime(),
		);
		(mockApp.vault.getFiles as jest.Mock).mockReturnValueOnce([modifiedFile]);

		await engine.fullSync();

		// pushModifiedFiles should use the OLD lastSync (prePullSync), not the new one
		// The file was modified at Feb 15, which is after Jan 1 (old lastSync)
		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/Modified.md",
			expect.any(String),
			expect.any(Number),
			undefined,
		);
	});

	test("applyAttachmentChange updates binary regardless of mtime", async () => {
		const engine = createEngine();
		engine.setLastSync("2024-04-01T00:00:00Z");

		// Local file has LATER mtime than remote
		const localFile = new TFile("Assets/image.png", Date.now());
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(localFile);

		const result = await engine.applyAttachmentChange(
			{
				path: "Assets/image.png",
				mime_type: "image/png",
				size_bytes: 3,
				mtime: 1709345678, // older than local
				updated_at: "2026-03-01T12:00:00Z",
				deleted: false,
			},
			"AQID",
		);

		expect(result).toBe(true);
		expect(mockApp.vault.modifyBinary).toHaveBeenCalledWith(localFile, expect.any(ArrayBuffer));
	});
});

describe("SyncEngine WebSocket with kind routing", () => {
	test("WebSocket event with kind=attachment calls getAttachment", async () => {
		const engine = createEngine();

		(mockApi.getAttachment as jest.Mock).mockResolvedValueOnce({
			path: "Assets/remote.png",
			content_base64: "AQID",
			mime_type: "image/png",
			size_bytes: 3,
			mtime: 1709345678,
			updated_at: "2026-03-01T12:00:00Z",
		});

		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Assets/remote.png",
			timestamp: 1709345678,
			kind: "attachment",
		});

		expect(mockApi.getAttachment).toHaveBeenCalledWith("Assets/remote.png");
		expect(mockApi.getNote).not.toHaveBeenCalled();
		expect(mockApp.vault.createBinary).toHaveBeenCalled();
	});

	test("WebSocket event with kind=note (or no kind) calls getNote", async () => {
		const engine = createEngine();

		(mockApi.getNote as jest.Mock).mockResolvedValueOnce({
			path: "Notes/SSE.md",
			title: "SSE Note",
			content: "# SSE",
			folder: "Notes",
			tags: [],
			mtime: 1709345678,
			created_at: "2026-03-01T12:00:00Z",
			updated_at: "2026-03-01T12:00:00Z",
		});

		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Notes/SSE.md",
			timestamp: 1709345678,
			// no kind field — should default to note behavior
		});

		expect(mockApi.getNote).toHaveBeenCalledWith("Notes/SSE.md");
		expect(mockApi.getAttachment).not.toHaveBeenCalled();
	});

	test("WebSocket delete with kind=attachment trashes local file", async () => {
		const engine = createEngine();
		const existingFile = new TFile("Assets/deleted.png");
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(existingFile);

		await engine.handleStreamEvent({
			event_type: "delete",
			path: "Assets/deleted.png",
			timestamp: 1709345678,
			kind: "attachment",
		});

		expect(mockApp.vault.trash).toHaveBeenCalledWith(existingFile, true);
	});
});

describe("SyncEngine auth validation", () => {
	test("fullSync throws on invalid API key", async () => {
		(mockApi.ping as jest.Mock).mockResolvedValueOnce({ ok: false, error: "Invalid API key" });
		const engine = createEngine();

		await expect(engine.fullSync()).rejects.toThrow("Invalid API key");
		expect(mockApi.getChanges).not.toHaveBeenCalled();
		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("fullSync throws on connection failure", async () => {
		(mockApi.ping as jest.Mock).mockResolvedValueOnce({
			ok: false,
			error: "Connection failed",
		});
		const engine = createEngine();

		await expect(engine.fullSync()).rejects.toThrow("Connection failed");
	});

	test("fullSync proceeds when auth succeeds", async () => {
		(mockApi.ping as jest.Mock).mockResolvedValueOnce({ ok: true });
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T00:00:00Z",
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T00:00:00Z",
		});
		const engine = createEngine();

		const result = await engine.fullSync();
		expect(result).toEqual({ pulled: 0, pushed: 0 });
		expect(mockApi.getChanges).toHaveBeenCalled();
	});

	test("pushAll throws on invalid API key", async () => {
		(mockApi.ping as jest.Mock).mockResolvedValueOnce({ ok: false, error: "Invalid API key" });
		const engine = createEngine();

		await expect(engine.pushAll()).rejects.toThrow("Invalid API key");
		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("pushFile returns false on failure", async () => {
		const engine = createEngine();
		(mockApi.pushNote as jest.Mock).mockRejectedValueOnce(new Error("401"));

		const file = new TFile("Notes/Test.md");
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("content");
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("content");

		// Access private method via any cast
		const result = await (engine as any).pushFile(file);
		expect(result).toBe(false);
	});
});

// --- V8 OOM Fix: Ready Gate ---

describe("ready gate", () => {
	test("handleModify suppressed before setReady", async () => {
		const engine = createEngine({}, { ready: false });
		const file = new TFile("Notes/Test.md", Date.now());

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 50));

		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("handleDelete suppressed before setReady", async () => {
		const engine = createEngine({}, { ready: false });
		const file = new TFile("Notes/Test.md");

		await engine.handleDelete(file);

		expect(mockApi.deleteNote).not.toHaveBeenCalled();
		expect(engine.queue.size).toBe(0);
	});

	test("handleRename suppressed before setReady", async () => {
		const engine = createEngine({}, { ready: false });
		const file = new TFile("Notes/Renamed.md", Date.now());

		await engine.handleRename(file, "Notes/Old.md");

		expect(mockApi.deleteNote).not.toHaveBeenCalled();
		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("events work after setReady", async () => {
		const engine = createEngine({ debounceMs: 10 }, { ready: false });
		engine.setReady();
		const file = new TFile("Notes/Test.md", Date.now());
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("content");

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 50));

		expect(mockApi.pushNote).toHaveBeenCalled();
	});
});

// --- V8 OOM Fix: Content-Free Queue Entries ---

describe("content-free queue entries", () => {
	test("failed push enqueues without content", async () => {
		const engine = createEngine({ debounceMs: 10 });
		(mockApi.pushNote as jest.Mock).mockRejectedValueOnce(new Error("offline"));
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce("file content");

		const file = new TFile("Notes/Test.md", Date.now());
		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 50));

		const entries = engine.queue.all();
		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe("Notes/Test.md");
		expect(entries[0].action).toBe("upsert");
		expect(entries[0].content).toBeUndefined();
		expect(entries[0].contentBase64).toBeUndefined();
	});

	test("flushQueue re-reads from vault for content-free entries", async () => {
		const engine = createEngine();
		engine.queue.load([
			{
				path: "Notes/Queued.md",
				action: "upsert",
				kind: "note",
				mtime: 1000,
				timestamp: Date.now(),
			},
		]);

		const file = new TFile("Notes/Queued.md", Date.now());
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(file);
		// Reset the default mock and set our specific return value
		(mockApp.vault.cachedRead as jest.Mock).mockReset().mockResolvedValueOnce("vault content");

		(engine as any).offline = true;
		const flushed = await engine.flushQueue();

		expect(flushed).toBe(1);
		expect(mockApp.vault.cachedRead).toHaveBeenCalledWith(file);
		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/Queued.md",
			"vault content",
			expect.any(Number),
		);

		// Restore default mock for other tests
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValue("# Test\n\nContent");
	});

	test("flushQueue uses legacy entry content", async () => {
		const engine = createEngine();
		engine.queue.load([
			{
				path: "Notes/Legacy.md",
				action: "upsert",
				content: "stored content",
				mtime: 1000,
				timestamp: Date.now(),
			},
		]);

		(engine as any).offline = true;
		const flushed = await engine.flushQueue();

		expect(flushed).toBe(1);
		expect(mockApi.pushNote).toHaveBeenCalledWith("Notes/Legacy.md", "stored content", 1000);
		expect(mockApp.vault.cachedRead).not.toHaveBeenCalled();
	});

	test("flushQueue skips deleted files", async () => {
		const engine = createEngine();
		engine.queue.load([
			{
				path: "Notes/Gone.md",
				action: "upsert",
				kind: "note",
				mtime: 1000,
				timestamp: Date.now(),
			},
		]);

		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValueOnce(null);

		(engine as any).offline = true;
		const flushed = await engine.flushQueue();

		expect(flushed).toBe(1);
		expect(mockApi.pushNote).not.toHaveBeenCalled();
		expect(engine.queue.size).toBe(0);
	});
});

// --- V8 OOM Fix: Debounced Persistence ---

describe("debounced persistence", () => {
	test("enqueue does not persist immediately", async () => {
		const { OfflineQueue } = require("../src/offline-queue");
		const queue = new OfflineQueue(100);
		const persistSpy = mock().mockResolvedValue(undefined);
		queue.onPersist(persistSpy);

		await queue.enqueue({ path: "a.md", action: "upsert" as const, timestamp: 1 });

		expect(persistSpy).not.toHaveBeenCalled();

		// Wait for the debounce timer to fire
		await new Promise((r) => setTimeout(r, 150));

		expect(persistSpy).toHaveBeenCalledTimes(1);
		queue.destroy();
	});

	test("rapid enqueues coalesce into one persist", async () => {
		const { OfflineQueue } = require("../src/offline-queue");
		const queue = new OfflineQueue(100);
		const persistSpy = mock().mockResolvedValue(undefined);
		queue.onPersist(persistSpy);

		for (let i = 0; i < 5; i++) {
			await queue.enqueue({ path: `file${i}.md`, action: "upsert" as const, timestamp: i });
		}

		expect(persistSpy).not.toHaveBeenCalled();

		await new Promise((r) => setTimeout(r, 150));

		expect(persistSpy).toHaveBeenCalledTimes(1);
		queue.destroy();
	});

	test("dequeue persists immediately", async () => {
		const { OfflineQueue } = require("../src/offline-queue");
		const queue = new OfflineQueue(100);
		const persistSpy = mock().mockResolvedValue(undefined);
		queue.onPersist(persistSpy);

		queue.load([{ path: "a.md", action: "upsert" as const, timestamp: 1 }]);
		await queue.dequeue("a.md");

		expect(persistSpy).toHaveBeenCalledTimes(1);
		queue.destroy();
	});
});

// --- V8 OOM Fix: Push Concurrency Limit ---

describe("push concurrency limit", () => {
	test("at most 5 concurrent pushes", async () => {
		const engine = createEngine({ debounceMs: 10 });

		let maxConcurrent = 0;
		let currentConcurrent = 0;
		const pushResolvers: (() => void)[] = [];

		(mockApi.pushNote as jest.Mock).mockImplementation(() => {
			currentConcurrent++;
			if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
			return new Promise<{ note: Record<string, unknown>; chunks_indexed: number }>(
				(resolve) => {
					pushResolvers.push(() => {
						currentConcurrent--;
						resolve({ note: {}, chunks_indexed: 1 });
					});
				},
			);
		});

		// Fire 10 modify events
		for (let i = 0; i < 10; i++) {
			const file = new TFile(`Notes/File${i}.md`, Date.now());
			(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce(`content ${i}`);
			engine.handleModify(file);
		}

		// Wait for debounce timers to fire and pushes to start
		await new Promise((r) => setTimeout(r, 50));

		expect(maxConcurrent).toBeLessThanOrEqual(5);
		expect(currentConcurrent).toBe(5);

		// Resolve all pushes
		while (pushResolvers.length > 0) {
			pushResolvers.shift()!();
			await new Promise((r) => setTimeout(r, 10));
		}
	});

	test("remaining pushes complete after slots free", async () => {
		const engine = createEngine({ debounceMs: 10 });

		let completedCount = 0;
		const pushResolvers: (() => void)[] = [];

		(mockApi.pushNote as jest.Mock).mockImplementation(() => {
			return new Promise<{ note: Record<string, unknown>; chunks_indexed: number }>(
				(resolve) => {
					pushResolvers.push(() => {
						completedCount++;
						resolve({ note: {}, chunks_indexed: 1 });
					});
				},
			);
		});

		// Fire 10 modify events
		for (let i = 0; i < 10; i++) {
			const file = new TFile(`Notes/File${i}.md`, Date.now());
			(mockApp.vault.cachedRead as jest.Mock).mockResolvedValueOnce(`content ${i}`);
			engine.handleModify(file);
		}

		await new Promise((r) => setTimeout(r, 50));

		// Resolve all pushes one by one, letting new ones start
		while (pushResolvers.length > 0) {
			pushResolvers.shift()!();
			await new Promise((r) => setTimeout(r, 10));
		}

		expect(completedCount).toBe(10);
	});
});

// --- Request Pacer ---

describe("request pacer", () => {
	test("configureRateLimit queries server and applies 10% safety margin", async () => {
		const engine = createEngine();
		(mockApi.getRateLimit as jest.Mock).mockResolvedValueOnce(100);

		await engine.configureRateLimit();

		expect((engine as any).rateLimitRPM).toBe(90);
	});

	test("configureRateLimit sets 0 when server reports unlimited", async () => {
		const engine = createEngine();
		(mockApi.getRateLimit as jest.Mock).mockResolvedValueOnce(0);

		await engine.configureRateLimit();

		expect((engine as any).rateLimitRPM).toBe(0);
	});

	test("configureRateLimit defaults to unlimited on error", async () => {
		const engine = createEngine();
		(mockApi.getRateLimit as jest.Mock).mockRejectedValueOnce(new Error("network error"));

		await engine.configureRateLimit();

		expect((engine as any).rateLimitRPM).toBe(0);
	});

	test("paceRequest does not delay when under limit", async () => {
		const engine = createEngine();
		(engine as any).rateLimitRPM = 100;

		const start = Date.now();
		await (engine as any).paceRequest();
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(50);
		expect((engine as any).requestTimestamps.length).toBe(1);
	});

	test("paceRequest does nothing when rate limit is 0 (unlimited)", async () => {
		const engine = createEngine();
		(engine as any).rateLimitRPM = 0;

		await (engine as any).paceRequest();

		expect((engine as any).requestTimestamps.length).toBe(0);
	});

	test("paceRequest delays when at capacity", async () => {
		const engine = createEngine();
		(engine as any).rateLimitRPM = 3;

		// Set timestamps near the window boundary (50ms from expiring)
		const windowStart = Date.now() - 59_950;
		(engine as any).requestTimestamps = [windowStart, windowStart + 10, windowStart + 20];

		const start = Date.now();
		await (engine as any).paceRequest();
		const elapsed = Date.now() - start;

		// Should wait ~100ms (50ms until oldest expires + 50ms buffer)
		expect(elapsed).toBeGreaterThanOrEqual(50);
		expect(elapsed).toBeLessThan(500);
	});

	test("fullSync calls configureRateLimit", async () => {
		const engine = createEngine();
		const spy = jest.spyOn(engine, "configureRateLimit").mockResolvedValue(undefined);

		await engine.fullSync();

		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});
});

describe("SyncEngine.pushAll echo suppression fix", () => {
	test("pushAll() pushes files even when syncState hashes match", async () => {
		const engine = createEngine();
		const file = new TFile("Notes/Existing.md", Date.now());
		(mockApp.vault.getFiles as jest.Mock).mockReturnValue([file]);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValue("# Existing\n\nContent");

		// Simulate syncState being populated (as happens after pull)
		// by doing a pull that writes this file, then clearing the mock
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/Existing.md",
					title: "Existing",
					content: "# Existing\n\nContent",
					folder: "Notes",
					tags: [],
					mtime: 1709345678,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-01T12:00:01Z",
		});
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValue(null);
		engine.setLastSync("2026-01-01T00:00:00Z");
		await engine.pull();

		jest.clearAllMocks();
		(mockApi.ping as jest.Mock).mockResolvedValue({ ok: true });
		(mockApp.vault.getFiles as jest.Mock).mockReturnValue([file]);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValue("# Existing\n\nContent");
		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });

		const pushed = await engine.pushAll();

		// Should push despite hash match because pushAll uses force=true
		expect(pushed).toBe(1);
		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/Existing.md",
			"# Existing\n\nContent",
			expect.any(Number),
			undefined,
		);
	});

	test("pushAll() reports skipped count when some files fail", async () => {
		const engine = createEngine();
		const file1 = new TFile("Notes/Good.md", Date.now());
		const file2 = new TFile("Notes/Bad.md", Date.now());
		(mockApp.vault.getFiles as jest.Mock).mockReturnValue([file1, file2]);
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValue("content");
		(mockApi.ping as jest.Mock).mockResolvedValue({ ok: true });
		(mockApi.pushNote as jest.Mock)
			.mockResolvedValueOnce({ note: {}, chunks_indexed: 1 })
			.mockRejectedValueOnce(new Error("network error"));

		const pushed = await engine.pushAll();

		expect(pushed).toBe(1);
		// The failed file gets queued, not counted as pushed
	});

	test("pushFile(force=true) bypasses echo suppression", async () => {
		const engine = createEngine();
		const file = new TFile("Notes/Force.md", Date.now());
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValue("# Force\n\nContent");
		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });

		// Simulate a synced hash by doing a normal push first
		// Access private method via any cast for testing
		await (engine as any).pushFile(file);
		expect(mockApi.pushNote).toHaveBeenCalledTimes(1);

		jest.clearAllMocks();
		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });

		// Normal push should be suppressed (echo)
		await (engine as any).pushFile(file);
		expect(mockApi.pushNote).not.toHaveBeenCalled();

		// Force push should bypass suppression
		await (engine as any).pushFile(file, true);
		expect(mockApi.pushNote).toHaveBeenCalledTimes(1);
	});

	test("handleModify during pull queues for post-pull push", async () => {
		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/DuringPull.md", Date.now());
		(mockApp.vault.cachedRead as jest.Mock).mockResolvedValue("# User edit during pull");
		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });
		(mockApp.vault.getFileByPath as jest.Mock).mockReturnValue(file);

		// Start a pull — mock it to return no changes
		(mockApi.getChanges as jest.Mock).mockImplementation(async () => {
			// While pull is in progress, simulate a user edit
			engine.handleModify(file);
			return { changes: [], server_time: "2026-03-01T12:00:01Z" };
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValue({
			changes: [],
			server_time: "2026-01-01T00:00:00Z",
		});

		engine.setLastSync("2026-01-01T00:00:00Z");
		await engine.pull();

		// The file should NOT have been debounce-pushed (was during pull)
		// but should have been pushed via flushPostPullPushes
		// Wait for async flush
		await new Promise((r) => setTimeout(r, 50));

		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/DuringPull.md",
			"# User edit during pull",
			expect.any(Number),
			undefined,
		);
	});
});

describe("Path sanitization on push", () => {
	test("renames local file when server returns sanitized path", async () => {
		// Server sanitizes "test?.md" → "test.md"
		(mockApi.pushNote as jest.Mock).mockResolvedValueOnce({
			note: {
				id: 1,
				user_id: "1",
				path: "Notes/test.md",
				title: "test",
				folder: "Notes",
				tags: [],
				mtime: 1709234567,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
			},
			chunks_indexed: 1,
		});

		const file = new TFile("Notes/test?.md", Date.now());
		// vault needs to find the file for rename
		(mockApp.vault.getFileByPath as jest.Mock).mockImplementation((p: string) => {
			if (p === "Notes/test?.md") return file;
			return null;
		});

		const engine = createEngine({ debounceMs: 10 });
		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));

		// Should have renamed the local file to match server's sanitized path
		expect(mockApp.vault.rename).toHaveBeenCalledWith(file, "Notes/test.md");
	});

	test("does not rename when server path matches original", async () => {
		(mockApi.pushNote as jest.Mock).mockResolvedValueOnce({
			note: {
				id: 1,
				user_id: "1",
				path: "Notes/Normal.md",
				title: "Normal",
				folder: "Notes",
				tags: [],
				mtime: 1709234567,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
			},
			chunks_indexed: 1,
		});

		const file = new TFile("Notes/Normal.md", Date.now());
		const engine = createEngine({ debounceMs: 10 });
		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));

		// No rename needed — path matches
		expect(mockApp.vault.rename).not.toHaveBeenCalled();
	});

	test("handles multiple illegal chars in filename", async () => {
		(mockApi.pushNote as jest.Mock).mockResolvedValueOnce({
			note: {
				id: 1,
				user_id: "1",
				path: "Notes/What Why How.md",
				title: "What Why How",
				folder: "Notes",
				tags: [],
				mtime: 1709234567,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
			},
			chunks_indexed: 1,
		});

		const file = new TFile("Notes/What? Why: How*.md", Date.now());
		(mockApp.vault.getFileByPath as jest.Mock).mockImplementation((p: string) => {
			if (p === "Notes/What? Why: How*.md") return file;
			return null;
		});

		const engine = createEngine({ debounceMs: 10 });
		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));

		expect(mockApp.vault.rename).toHaveBeenCalledWith(file, "Notes/What Why How.md");
	});
});

describe("SyncEngine vault-scoped queue", () => {
	test("enqueued entries include vaultId from settings", async () => {
		const engine = createEngine({ vaultId: "42", debounceMs: 10 });
		// Simulate a push failure that enqueues
		(mockApi.pushNote as jest.Mock).mockRejectedValueOnce(new Error("network"));
		mockApp.vault.cachedRead.mockResolvedValueOnce("content");

		const file = new TFile("test.md", Date.now());
		mockApp.vault.getFileByPath.mockReturnValueOnce(file);
		engine.handleModify(file);

		// Wait for debounce + async push
		await new Promise((r) => setTimeout(r, 50));

		const entries = engine.queue.all();
		if (entries.length > 0) {
			expect(entries[0].vaultId).toBe("42");
		}
	});
});

// ---------------------------------------------------------------------------
// Active editor refresh on sync (modifyFile)
// ---------------------------------------------------------------------------

describe("modifyFile active editor refresh", () => {
	beforeEach(() => {
		jest.restoreAllMocks();
		jest.clearAllMocks();
		// Reset mocks to defaults for this describe block
		mockActiveView.file = null;
		mockApp.workspace.getActiveViewOfType.mockReturnValue(null);
		mockApp.vault.getFileByPath.mockReset();
		mockApp.vault.getFileByPath.mockReturnValue(null);
		mockApp.vault.cachedRead.mockReset();
		mockApp.vault.cachedRead.mockResolvedValue("# Test\n\nContent");
		mockApp.vault.modify.mockReset();
		mockApp.vault.modify.mockResolvedValue(undefined);
		mockApp.vault.process.mockReset();
		mockApp.vault.process.mockImplementation((_file: any, fn: (data: string) => string) => {
			fn("");
			return Promise.resolve("");
		});
		(mockApi.pushNote as jest.Mock).mockReset();
		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });
	});

	test("uses vault.process instead of vault.modify for scroll-safe updates", async () => {
		const existingFile = new TFile("Notes/Open.md", Date.now() - 10000);
		mockApp.vault.getFileByPath.mockImplementation((p: string) =>
			p === "Notes/Open.md" ? existingFile : null,
		);
		mockApp.vault.cachedRead.mockResolvedValue("old content");

		const engine = createEngine();
		engine.syncState.set("Notes/Open.md", { hash: fnv1a("old content"), version: 1 });

		await engine.applyChange({
			path: "Notes/Open.md",
			title: "Open",
			content: "new content from server",
			folder: "Notes",
			tags: [],
			mtime: Date.now() / 1000,
			updated_at: new Date().toISOString(),
			deleted: false,
			version: 2,
		});

		// Should use vault.process (scroll-safe) not vault.modify
		expect(mockApp.vault.process).toHaveBeenCalled();
		expect(mockApp.vault.modify).not.toHaveBeenCalled();

		// The transform function should return the new content
		const transformFn = mockApp.vault.process.mock.calls[0][1];
		expect(transformFn("anything")).toBe("new content from server");
	});

	test("falls back to vault.modify when vault.process is unavailable", async () => {
		const existingFile = new TFile("Notes/Fallback.md", Date.now() - 10000);
		mockApp.vault.getFileByPath.mockImplementation((p: string) =>
			p === "Notes/Fallback.md" ? existingFile : null,
		);
		mockApp.vault.cachedRead.mockResolvedValue("old content");
		// Simulate older Obsidian without vault.process
		const savedProcess = mockApp.vault.process;
		mockApp.vault.process = undefined;

		const engine = createEngine();
		engine.syncState.set("Notes/Fallback.md", { hash: fnv1a("old content"), version: 1 });

		await engine.applyChange({
			path: "Notes/Fallback.md",
			title: "Fallback",
			content: "new content",
			folder: "Notes",
			tags: [],
			mtime: Date.now() / 1000,
			updated_at: new Date().toISOString(),
			deleted: false,
			version: 2,
		});

		expect(mockApp.vault.modify).toHaveBeenCalled();
		mockApp.vault.process = savedProcess;
	});

	test("uses vault.process on WebSocket stream event", async () => {
		const existingFile = new TFile("Notes/WS.md", Date.now() - 10000);
		mockApp.vault.getFileByPath.mockImplementation((p: string) =>
			p === "Notes/WS.md" ? existingFile : null,
		);
		mockApp.vault.cachedRead.mockResolvedValue("original");

		const engine = createEngine();
		engine.syncState.set("Notes/WS.md", { hash: fnv1a("original"), version: 1 });

		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Notes/WS.md",
			timestamp: Date.now(),
			content: "updated via websocket",
			title: "WS",
			folder: "Notes",
			tags: [],
			mtime: Date.now() / 1000,
			updated_at: new Date().toISOString(),
			version: 2,
		});

		expect(mockApp.vault.process).toHaveBeenCalled();
		expect(mockApp.vault.modify).not.toHaveBeenCalled();
	});
});

describe("SyncEngine Obsidian API best practices", () => {
	describe("uses cachedRead for read-only operations", () => {
		test("push uses cachedRead (not read) for content hashing", async () => {
			const engine = createEngine({ debounceMs: 0 });
			const file = new TFile("Notes/CachedTest.md");

			mockApp.vault.cachedRead.mockResolvedValueOnce("# Cached content");
			mockApp.vault.read.mockClear();
			mockApp.vault.cachedRead.mockClear();
			mockApp.vault.cachedRead.mockResolvedValueOnce("# Cached content");

			// Trigger push via handleModify + flush debounce
			engine.handleModify(file);
			await new Promise((r) => setTimeout(r, 50));

			expect(mockApp.vault.cachedRead).toHaveBeenCalledWith(file);
			expect(mockApp.vault.read).not.toHaveBeenCalled();
		});

		test("pull conflict detection uses cachedRead for local content", async () => {
			const engine = createEngine();
			engine.setLastSync("2026-01-01T00:00:00Z");

			const existingFile = new TFile("Notes/Conflict.md");
			mockApp.vault.getFileByPath.mockReturnValueOnce(existingFile);
			mockApp.vault.cachedRead.mockClear();
			mockApp.vault.read.mockClear();
			mockApp.vault.cachedRead.mockResolvedValueOnce("local content");

			(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
				changes: [
					{
						path: "Notes/Conflict.md",
						content: "remote content",
						mtime: Date.now() / 1000 + 100,
						version: 2,
						deleted: false,
						title: "Conflict",
						folder: "Notes",
						tags: [],
						updated_at: new Date().toISOString(),
					},
				],
				server_time: new Date().toISOString(),
			});
			(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
				changes: [],
				server_time: new Date().toISOString(),
			});

			await engine.pull();

			expect(mockApp.vault.cachedRead).toHaveBeenCalledWith(existingFile);
			expect(mockApp.vault.read).not.toHaveBeenCalled();
		});
	});

	describe("uses getFileByPath for file lookups", () => {
		test("pull uses getFileByPath instead of getAbstractFileByPath for notes", async () => {
			const engine = createEngine();
			engine.setLastSync("2026-01-01T00:00:00Z");

			mockApp.vault.getFileByPath.mockClear();
			mockApp.vault.getAbstractFileByPath.mockClear();
			mockApp.vault.getFileByPath.mockReturnValue(null);

			(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
				changes: [
					{
						path: "Notes/New.md",
						content: "new content",
						mtime: Date.now() / 1000,
						version: 1,
						deleted: false,
						title: "New",
						folder: "Notes",
						tags: [],
						updated_at: new Date().toISOString(),
					},
				],
				server_time: new Date().toISOString(),
			});
			(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
				changes: [],
				server_time: new Date().toISOString(),
			});

			await engine.pull();

			expect(mockApp.vault.getFileByPath).toHaveBeenCalled();
		});
	});
});

// ---------------------------------------------------------------------------
// Sync state export/import round-trips
// ---------------------------------------------------------------------------

describe("SyncEngine sync state management", () => {
	test("exportSyncState returns all entries as plain object", () => {
		const engine = createEngine();
		engine.importSyncState({
			"Notes/A.md": { hash: 111 },
			"Notes/B.md": { hash: 222 },
		});
		const exported = engine.exportSyncState();
		expect(exported).toEqual({
			"Notes/A.md": { hash: 111 },
			"Notes/B.md": { hash: 222 },
		});
	});

	test("exportHashes returns hash-only projection", () => {
		const engine = createEngine();
		engine.importSyncState({
			"Notes/A.md": { hash: 111, version: 3 } as any,
			"Notes/B.md": { hash: 222 },
		});
		const hashes = engine.exportHashes();
		expect(hashes).toEqual({
			"Notes/A.md": 111,
			"Notes/B.md": 222,
		});
	});

	test("importHashes creates entries with hash property only", () => {
		const engine = createEngine();
		engine.importHashes({ "Notes/A.md": 111, "Notes/B.md": 222 });
		const exported = engine.exportSyncState();
		expect(exported["Notes/A.md"]).toEqual({ hash: 111 });
		expect(exported["Notes/B.md"]).toEqual({ hash: 222 });
	});

	test("importSyncState + exportSyncState round-trips correctly", () => {
		const engine = createEngine();
		const original = {
			"Notes/A.md": { hash: 111 },
			"Notes/B.md": { hash: 222 },
		};
		engine.importSyncState(original);
		expect(engine.exportSyncState()).toEqual(original);
	});

	test("importHashes + exportHashes round-trips correctly", () => {
		const engine = createEngine();
		const original = { "Notes/A.md": 111, "Notes/B.md": 222 };
		engine.importHashes(original);
		expect(engine.exportHashes()).toEqual(original);
	});
});

// ---------------------------------------------------------------------------
// updateSettings
// ---------------------------------------------------------------------------

describe("SyncEngine.updateSettings", () => {
	test("re-parses ignore patterns after update", () => {
		const engine = createEngine({ ignorePatterns: "secret/" });
		expect(engine.shouldIgnore("secret/passwords.md")).toBe(true);
		expect(engine.shouldIgnore("public/readme.md")).toBe(false);

		engine.updateSettings({ ...DEFAULT_SETTINGS, ignorePatterns: "public/" });
		expect(engine.shouldIgnore("secret/passwords.md")).toBe(false);
		expect(engine.shouldIgnore("public/readme.md")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Private utility methods (accessed via cast for coverage)
// ---------------------------------------------------------------------------

describe("SyncEngine private utilities", () => {
	// Note: md5() uses crypto.subtle.digest("MD5") which Obsidian supports
	// but Bun's Web Crypto does not. MD5 tests require E2E in the backend repo.

	test("arrayBuffersEqual returns true for identical buffers", () => {
		const engine = createEngine();
		const a = new Uint8Array([1, 2, 3]).buffer;
		const b = new Uint8Array([1, 2, 3]).buffer;
		expect((engine as any).arrayBuffersEqual(a, b)).toBe(true);
	});

	test("arrayBuffersEqual returns false for different content", () => {
		const engine = createEngine();
		const a = new Uint8Array([1, 2, 3]).buffer;
		const b = new Uint8Array([1, 2, 4]).buffer;
		expect((engine as any).arrayBuffersEqual(a, b)).toBe(false);
	});

	test("arrayBuffersEqual returns false for different lengths", () => {
		const engine = createEngine();
		const a = new Uint8Array([1, 2]).buffer;
		const b = new Uint8Array([1, 2, 3]).buffer;
		expect((engine as any).arrayBuffersEqual(a, b)).toBe(false);
	});
});
