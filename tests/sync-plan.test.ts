import { beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { TFile } from "obsidian";
import type { EngramApi } from "../src/api";
import { SyncEngine, fnv1a } from "../src/sync";
import { DEFAULT_SETTINGS } from "../src/types";
import type { SyncProgress } from "../src/types";

// Mock the API — mirrors the pattern from sync.test.ts
const mockApi = {
	pushNote: mock().mockResolvedValue({ note: {}, chunks_indexed: 1 }),
	getChanges: mock().mockResolvedValue({ changes: [], server_time: "2026-01-01T00:00:00Z" }),
	getAttachmentChanges: mock().mockResolvedValue({
		changes: [],
		server_time: "2026-01-01T00:00:00Z",
	}),
	deleteNote: mock().mockResolvedValue({ deleted: true, path: "" }),
	getNote: mock().mockResolvedValue(null),
	health: mock().mockResolvedValue(true),
	ping: mock().mockResolvedValue({ ok: true }),
	pushAttachment: mock().mockResolvedValue({ attachment: {} }),
	getAttachment: mock().mockResolvedValue(null),
	deleteAttachment: mock().mockResolvedValue({ deleted: true, path: "" }),
	getRateLimit: mock().mockResolvedValue(0),
	getManifest: mock().mockResolvedValue(null),
	registerVault: jest
		.fn()
		.mockResolvedValue({ id: 1, name: "Test", slug: "test", is_default: true }),
} as unknown as EngramApi;

// Mock the Obsidian App
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
			fn("");
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

function makeTFile(path: string): TFile {
	return new TFile(path) as unknown as TFile;
}

function createEngine(overrides = {}): SyncEngine {
	const engine = new SyncEngine(
		mockApp,
		mockApi,
		{ ...DEFAULT_SETTINGS, debounceMs: 10, ...overrides },
		mockSaveData,
	);
	engine.setReady();
	return engine;
}

beforeEach(() => {
	jest.clearAllMocks();
	(mockApi.getChanges as jest.Mock)
		.mockReset()
		.mockResolvedValue({ changes: [], server_time: "2026-01-01T00:00:00Z" });
	(mockApi.getAttachmentChanges as jest.Mock)
		.mockReset()
		.mockResolvedValue({ changes: [], server_time: "2026-01-01T00:00:00Z" });
	mockApp.vault.getFiles.mockReset().mockReturnValue([]);
});

describe("SyncEngine.computeSyncPlan", () => {
	test("empty vault and empty server returns zeroed plan", async () => {
		const engine = createEngine();
		mockApp.vault.getFiles.mockReturnValue([]);

		const plan = await engine.computeSyncPlan("full");

		expect(plan.vaultName).toBe("Test Vault");
		expect(plan.serverNoteCount).toBe(0);
		expect(plan.localNoteCount).toBe(0);
		expect(plan.localAttachmentCount).toBe(0);
		expect(plan.toPush.notes).toEqual([]);
		expect(plan.toPush.attachments).toEqual([]);
		expect(plan.toPull.notes).toEqual([]);
		expect(plan.toPull.attachments).toEqual([]);
		expect(plan.conflicts).toEqual([]);
		expect(plan.toDeleteLocal).toEqual([]);
		expect(plan.toDeleteRemote).toEqual([]);
	});

	test("local files not on server are counted as toPush", async () => {
		const engine = createEngine();
		const files = [makeTFile("Notes/local-only.md"), makeTFile("Notes/another.md")];
		mockApp.vault.getFiles.mockReturnValue(files);
		// Server has no changes — files don't exist on server
		(mockApi.getChanges as jest.Mock).mockResolvedValue({
			changes: [],
			server_time: "2026-01-01T00:00:00Z",
		});

		const plan = await engine.computeSyncPlan("full");

		expect(plan.toPush.notes).toContain("Notes/local-only.md");
		expect(plan.toPush.notes).toContain("Notes/another.md");
		expect(plan.toPull.notes).toEqual([]);
		expect(plan.localNoteCount).toBe(2);
	});

	test("server changes not present locally are counted as toPull", async () => {
		const engine = createEngine();
		mockApp.vault.getFiles.mockReturnValue([]);
		(mockApi.getChanges as jest.Mock).mockResolvedValue({
			changes: [
				{
					path: "Notes/remote-only.md",
					title: "Remote",
					content: "# Remote",
					folder: "Notes",
					tags: [],
					mtime: Date.now() / 1000,
					updated_at: new Date().toISOString(),
					deleted: false,
				},
			],
			server_time: "2026-01-01T00:00:00Z",
		});

		const plan = await engine.computeSyncPlan("full");

		expect(plan.toPull.notes).toContain("Notes/remote-only.md");
		expect(plan.toPush.notes).toEqual([]);
		expect(plan.serverNoteCount).toBe(1);
	});

	test("server deletions are counted in toDeleteLocal", async () => {
		const engine = createEngine();
		// Local file exists
		const localFile = makeTFile("Notes/to-delete.md");
		mockApp.vault.getFiles.mockReturnValue([localFile]);
		mockApp.vault.getFileByPath.mockReturnValue(localFile);
		// Server signals deletion
		(mockApi.getChanges as jest.Mock).mockResolvedValue({
			changes: [
				{
					path: "Notes/to-delete.md",
					title: "Gone",
					content: "",
					folder: "Notes",
					tags: [],
					mtime: Date.now() / 1000,
					updated_at: new Date().toISOString(),
					deleted: true,
				},
			],
			server_time: "2026-01-01T00:00:00Z",
		});

		const plan = await engine.computeSyncPlan("full");

		expect(plan.toDeleteLocal).toContain("Notes/to-delete.md");
		expect(plan.toPull.notes).not.toContain("Notes/to-delete.md");
	});

	test("push-all mode does not include toPull entries", async () => {
		const engine = createEngine();
		// Local has one file, server has a different file not locally present
		mockApp.vault.getFiles.mockReturnValue([makeTFile("Notes/local.md")]);
		(mockApi.getChanges as jest.Mock).mockResolvedValue({
			changes: [
				{
					path: "Notes/remote-only.md",
					title: "Remote",
					content: "# Remote",
					folder: "Notes",
					tags: [],
					mtime: Date.now() / 1000,
					updated_at: new Date().toISOString(),
					deleted: false,
				},
			],
			server_time: "2026-01-01T00:00:00Z",
		});

		const plan = await engine.computeSyncPlan("push-all");

		expect(plan.toPull.notes).toEqual([]);
		expect(plan.toPull.attachments).toEqual([]);
		expect(plan.toPush.notes).toContain("Notes/local.md");
	});

	test("file changed both locally and on server is a conflict", async () => {
		const engine = createEngine();
		const originalContent = "# Original";
		const localContent = "# Modified locally";
		const file = makeTFile("Notes/both-changed.md");
		mockApp.vault.getFiles.mockReturnValue([file]);
		mockApp.vault.getFileByPath.mockReturnValue(file);
		mockApp.vault.cachedRead.mockResolvedValue(localContent);

		// Simulate prior sync with original content hash
		engine.importHashes({ "Notes/both-changed.md": fnv1a(originalContent) });

		(mockApi.getChanges as jest.Mock).mockResolvedValue({
			changes: [
				{
					path: "Notes/both-changed.md",
					title: "Both",
					content: "# Modified on server",
					folder: "Notes",
					tags: [],
					mtime: Date.now() / 1000,
					updated_at: new Date().toISOString(),
					deleted: false,
				},
			],
			server_time: "2026-01-01T00:00:00Z",
		});

		const plan = await engine.computeSyncPlan("full");

		expect(plan.conflicts).toContain("Notes/both-changed.md");
		expect(plan.toPull.notes).not.toContain("Notes/both-changed.md");
	});

	test("file changed only on server (local unchanged) is a pull, not conflict", async () => {
		const engine = createEngine();
		const content = "# Original";
		const file = makeTFile("Notes/server-updated.md");
		mockApp.vault.getFiles.mockReturnValue([file]);
		mockApp.vault.getFileByPath.mockReturnValue(file);
		mockApp.vault.cachedRead.mockResolvedValue(content);

		// Simulate prior sync with same content hash
		engine.importHashes({ "Notes/server-updated.md": fnv1a(content) });

		(mockApi.getChanges as jest.Mock).mockResolvedValue({
			changes: [
				{
					path: "Notes/server-updated.md",
					title: "Updated",
					content: "# New server content",
					folder: "Notes",
					tags: [],
					mtime: Date.now() / 1000,
					updated_at: new Date().toISOString(),
					deleted: false,
				},
			],
			server_time: "2026-01-01T00:00:00Z",
		});

		const plan = await engine.computeSyncPlan("full");

		expect(plan.toPull.notes).toContain("Notes/server-updated.md");
		expect(plan.conflicts).not.toContain("Notes/server-updated.md");
	});

	test("ignored files (.obsidian/) are excluded from plan", async () => {
		const engine = createEngine();
		const files = [
			makeTFile(".obsidian/config.json"),
			makeTFile(".obsidian/plugins/some-plugin/main.js"),
			makeTFile("Notes/legit.md"),
		];
		mockApp.vault.getFiles.mockReturnValue(files);

		const plan = await engine.computeSyncPlan("full");

		const allPaths = [
			...plan.toPush.notes,
			...plan.toPush.attachments,
			...plan.toPull.notes,
			...plan.toPull.attachments,
		];
		expect(allPaths).not.toContain(".obsidian/config.json");
		expect(allPaths).not.toContain(".obsidian/plugins/some-plugin/main.js");
		expect(plan.toPush.notes).toContain("Notes/legit.md");
	});
});

describe("SyncEngine.pushAll with progress", () => {
	test("emits progress events during pushAll", async () => {
		// Set up mock files
		const file1 = makeTFile("notes/a.md");
		const file2 = makeTFile("notes/b.md");
		mockApp.vault.getFiles.mockReturnValue([file1, file2]);
		mockApp.vault.cachedRead.mockResolvedValue("# Content");
		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });

		const engine = createEngine();
		const progressEvents: SyncProgress[] = [];
		engine.onSyncProgress = (p) => progressEvents.push({ ...p });

		const { SyncLog } = await import("../src/sync-log");
		engine.syncLog = new SyncLog();

		await engine.pushAll();

		// Should have at least a start and complete event
		expect(progressEvents.length).toBeGreaterThanOrEqual(2);
		expect(progressEvents[0].phase).toBe("pushing");
		expect(progressEvents[0].current).toBe(0);
		expect(progressEvents[progressEvents.length - 1].phase).toBe("complete");

		// SyncLog should have entries
		expect(engine.syncLog.entries().length).toBeGreaterThan(0);
	});

	test("wipePullAll deletes local files and resets sync state before pulling", async () => {
		const file1 = makeTFile("notes/a.md");
		const file2 = makeTFile("notes/b.md");
		mockApp.vault.getFiles.mockReturnValue([file1, file2]);
		mockApp.vault.cachedRead.mockResolvedValue("# Content");

		// Server has one note to pull after wipe
		(mockApi.getChanges as jest.Mock).mockResolvedValue({
			changes: [
				{
					path: "notes/server.md",
					title: "Server",
					content: "# From Server",
					folder: "notes",
					tags: [],
					mtime: Date.now() / 1000,
					updated_at: new Date().toISOString(),
					deleted: false,
				},
			],
			server_time: "2026-01-01T00:00:00Z",
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValue({
			changes: [],
			server_time: "2026-01-01T00:00:00Z",
		});
		// After wipe, getFileByPath returns null (files deleted)
		mockApp.vault.getFileByPath.mockReturnValue(null);

		const engine = createEngine();
		const { SyncLog } = await import("../src/sync-log");
		engine.syncLog = new SyncLog();

		// Seed some sync state that should be cleared
		engine.importHashes({ "notes/a.md": 12345 });

		await engine.wipePullAll();

		// Both local files should have been trashed
		expect(mockApp.vault.trash).toHaveBeenCalledTimes(2);

		// Sync log should have delete entries for the wipe
		const deleteEntries = engine.syncLog.entries().filter((e) => e.action === "delete");
		expect(deleteEntries).toHaveLength(2);

		// Server note should have been created (pulled)
		expect(mockApp.vault.create).toHaveBeenCalled();
	});

	test("logs errors to syncLog when push fails", async () => {
		const file = makeTFile("notes/fail.md");
		mockApp.vault.getFiles.mockReturnValue([file]);
		mockApp.vault.cachedRead.mockResolvedValue("# Content");
		(mockApi.pushNote as jest.Mock).mockRejectedValue(new Error("500 Internal Server Error"));

		const engine = createEngine();
		const { SyncLog } = await import("../src/sync-log");
		engine.syncLog = new SyncLog();

		await engine.pushAll();

		const errors = engine.syncLog.entries().filter((e) => e.result === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].path).toBe("notes/fail.md");
		expect(errors[0].error).toContain("500");
	});
});
