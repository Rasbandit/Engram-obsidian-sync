/**
 * Tests for stream.ts — NoteStream connection state, disconnect, config update.
 */
import { NoteStream } from "../src/stream";

// Mock global fetch
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Construction and config
// ---------------------------------------------------------------------------

describe("NoteStream construction", () => {
    test("starts disconnected", () => {
        const stream = new NoteStream("http://localhost:8000", "key");
        expect(stream.isConnected()).toBe(false);
    });

    test("updateConfig strips trailing slashes", () => {
        const stream = new NoteStream("http://a.com", "key");
        stream.updateConfig("http://b.com///", "key2");
        // Verify by attempting connect and checking fetch URL
        const abortError = new DOMException("aborted", "AbortError");
        mockFetch.mockRejectedValueOnce(abortError);
        stream.connect();
        if (mockFetch.mock.calls.length > 0) {
            expect(mockFetch.mock.calls[0][0]).toBe("http://b.com/notes/stream");
        }
        stream.disconnect();
    });
});

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

describe("NoteStream disconnect", () => {
    test("disconnect sets connected to false", () => {
        const stream = new NoteStream("http://localhost:8000", "key");
        stream.disconnect();
        expect(stream.isConnected()).toBe(false);
    });

    test("disconnect fires status change callback", () => {
        const stream = new NoteStream("http://localhost:8000", "key");
        const statusFn = jest.fn();
        stream.onStatusChange = statusFn;
        // Force internal state to connected
        (stream as any).connected = true;
        stream.disconnect();
        expect(statusFn).toHaveBeenCalledWith(false);
    });

    test("multiple disconnects are safe", () => {
        const stream = new NoteStream("http://localhost:8000", "key");
        stream.disconnect();
        stream.disconnect();
        expect(stream.isConnected()).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

describe("NoteStream connect", () => {
    test("connect sends fetch with auth header", async () => {
        // Mock a stream that immediately ends
        const mockReader = {
            read: jest.fn().mockResolvedValue({ done: true, value: undefined }),
        };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            body: { getReader: () => mockReader },
        });

        const stream = new NoteStream("http://localhost:8000", "engram_key");
        await stream.connect();

        expect(mockFetch).toHaveBeenCalledWith(
            "http://localhost:8000/notes/stream",
            expect.objectContaining({
                headers: { Authorization: "Bearer engram_key" },
            }),
        );
        stream.disconnect();
    });

    test("connect is idempotent while stream is active", async () => {
        // Keep the stream alive by never resolving the read
        const mockReader = {
            read: jest.fn().mockReturnValue(new Promise(() => {})), // never resolves
        };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            body: { getReader: () => mockReader },
        });

        const stream = new NoteStream("http://localhost:8000", "key");
        // Don't await — connect starts the stream but read() hangs
        stream.connect();
        await new Promise((r) => setTimeout(r, 50)); // let connect() reach the read loop

        await stream.connect(); // second call should be no-op (controller exists)
        expect(mockFetch).toHaveBeenCalledTimes(1);
        stream.disconnect();
    });
});

// ---------------------------------------------------------------------------
// SSE event parsing
// ---------------------------------------------------------------------------

describe("NoteStream event parsing", () => {
    test("parses note_change events", async () => {
        const eventData = { path: "Notes/Test.md", action: "upsert", mtime: "2024-01-01T00:00:00Z" };
        const ssePayload = `event: note_change\ndata: ${JSON.stringify(eventData)}\n\n`;
        const encoder = new TextEncoder();

        let readCount = 0;
        const mockReader = {
            read: jest.fn().mockImplementation(() => {
                if (readCount === 0) {
                    readCount++;
                    return Promise.resolve({ done: false, value: encoder.encode(ssePayload) });
                }
                return Promise.resolve({ done: true, value: undefined });
            }),
        };

        mockFetch.mockResolvedValueOnce({
            ok: true,
            body: { getReader: () => mockReader },
        });

        const onEvent = jest.fn();
        const stream = new NoteStream("http://localhost:8000", "key");
        stream.onEvent = onEvent;
        await stream.connect();

        // Wait a tick for async processing
        await new Promise((r) => setTimeout(r, 10));

        expect(onEvent).toHaveBeenCalledWith(eventData);
        stream.disconnect();
    });

    test("ignores non-note_change events", async () => {
        const ssePayload = `event: heartbeat\ndata: {}\n\n`;
        const encoder = new TextEncoder();

        let readCount = 0;
        const mockReader = {
            read: jest.fn().mockImplementation(() => {
                if (readCount === 0) {
                    readCount++;
                    return Promise.resolve({ done: false, value: encoder.encode(ssePayload) });
                }
                return Promise.resolve({ done: true, value: undefined });
            }),
        };

        mockFetch.mockResolvedValueOnce({
            ok: true,
            body: { getReader: () => mockReader },
        });

        const onEvent = jest.fn();
        const stream = new NoteStream("http://localhost:8000", "key");
        stream.onEvent = onEvent;
        await stream.connect();

        await new Promise((r) => setTimeout(r, 10));

        expect(onEvent).not.toHaveBeenCalled();
        stream.disconnect();
    });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("NoteStream errors", () => {
    test("non-ok response does not set connected", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            body: null,
        });

        const stream = new NoteStream("http://localhost:8000", "key");
        const statusFn = jest.fn();
        stream.onStatusChange = statusFn;

        await stream.connect();
        await new Promise((r) => setTimeout(r, 10));

        // Should not be connected after auth failure
        expect(stream.isConnected()).toBe(false);
        stream.disconnect();
    });
});
