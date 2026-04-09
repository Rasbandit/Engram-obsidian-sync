/**
 * Tests for api.ts — utility functions and EngramApi method behavior.
 */
import { type Mock } from "bun:test";
import { requestUrl } from "obsidian";
import { EngramApi, arrayBufferToBase64, base64ToArrayBuffer } from "../src/api";

// requestUrl is mocked via tests/preload.ts — it is already a mock() instance
const mockRequestUrl = requestUrl as unknown as Mock<() => Promise<any>>;

beforeEach(() => {
	mockRequestUrl.mockReset();
});

// ---------------------------------------------------------------------------
// arrayBufferToBase64 / base64ToArrayBuffer
// ---------------------------------------------------------------------------

describe("arrayBufferToBase64", () => {
    test("encodes empty buffer", () => {
        const buf = new ArrayBuffer(0);
        expect(arrayBufferToBase64(buf)).toBe("");
    });

    test("encodes simple ASCII", () => {
        const encoder = new TextEncoder();
        const buf = encoder.encode("hello").buffer;
        expect(arrayBufferToBase64(buf)).toBe(btoa("hello"));
    });

    test("encodes binary data", () => {
        const bytes = new Uint8Array([0, 128, 255]);
        const result = arrayBufferToBase64(bytes.buffer);
        // Decode and verify round-trip
        const decoded = base64ToArrayBuffer(result);
        expect(new Uint8Array(decoded)).toEqual(bytes);
    });
});

describe("base64ToArrayBuffer", () => {
    test("decodes empty string", () => {
        const buf = base64ToArrayBuffer("");
        expect(buf.byteLength).toBe(0);
    });

    test("decodes simple ASCII", () => {
        const buf = base64ToArrayBuffer(btoa("hello"));
        const text = new TextDecoder().decode(buf);
        expect(text).toBe("hello");
    });

    test("round-trips with arrayBufferToBase64", () => {
        const original = new Uint8Array([1, 2, 3, 100, 200, 255]);
        const encoded = arrayBufferToBase64(original.buffer);
        const decoded = new Uint8Array(base64ToArrayBuffer(encoded));
        expect(decoded).toEqual(original);
    });
});

// ---------------------------------------------------------------------------
// EngramApi
// ---------------------------------------------------------------------------

const TEST_SERVER = "http://localhost:8000";
const TEST_API_BASE = `${TEST_SERVER}/api`;
const TEST_KEY = "engram_testkey";

describe("EngramApi", () => {
    let api: EngramApi;

    beforeEach(() => {
        api = new EngramApi(TEST_SERVER, TEST_KEY);
    });

    describe("updateConfig", () => {
        test("strips trailing slashes and appends /api", () => {
            api.updateConfig("http://example.com///", "key2");
            mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { status: "ok" } } as any);
            api.health();
            expect(mockRequestUrl).toHaveBeenCalledWith(
                expect.objectContaining({ url: "http://example.com/api/health" }),
            );
        });

        test("does not double-append /api if already present", () => {
            api.updateConfig("http://example.com/api", "key2");
            mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { status: "ok" } } as any);
            api.health();
            expect(mockRequestUrl).toHaveBeenCalledWith(
                expect.objectContaining({ url: "http://example.com/api/health" }),
            );
        });
    });

    describe("health", () => {
        test("returns true on 200", async () => {
            mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} } as any);
            expect(await api.health()).toBe(true);
        });

        test("returns false on error", async () => {
            mockRequestUrl.mockRejectedValueOnce(new Error("network"));
            expect(await api.health()).toBe(false);
        });

        test("does not send auth header", async () => {
            mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} } as any);
            await api.health();
            const opts = mockRequestUrl.mock.calls[0][0] as any;
            expect(opts.headers?.Authorization).toBeUndefined();
        });
    });

    describe("ping", () => {
        test("returns ok on success", async () => {
            mockRequestUrl.mockResolvedValueOnce({ status: 200, json: [] } as any);
            const result = await api.ping();
            expect(result).toEqual({ ok: true });
        });

        test("returns invalid API key on 401", async () => {
            mockRequestUrl.mockRejectedValueOnce({ status: 401 });
            const result = await api.ping();
            expect(result).toEqual({ ok: false, error: "Invalid API key" });
        });

        test("returns connection failed on other errors", async () => {
            mockRequestUrl.mockRejectedValueOnce(new Error("timeout"));
            const result = await api.ping();
            expect(result).toEqual({ ok: false, error: "Connection failed" });
        });
    });

    describe("pushNote", () => {
        test("sends POST with path, content, mtime", async () => {
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { path: "Notes/Test.md", status: "created" },
            } as any);
            const result = await api.pushNote("Notes/Test.md", "# Hello", 1234567890);
            expect(mockRequestUrl).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: "POST",
                    url: `${TEST_API_BASE}/notes`,
                    body: JSON.stringify({ path: "Notes/Test.md", content: "# Hello", mtime: 1234567890 }),
                }),
            );
            expect(result).toEqual({ path: "Notes/Test.md", status: "created" });
        });
    });

    describe("getChanges", () => {
        test("URL-encodes the since parameter", async () => {
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { changes: [], deleted: [] },
            } as any);
            await api.getChanges("2024-01-01T00:00:00+00:00");
            const opts = mockRequestUrl.mock.calls[0][0] as any;
            expect(opts.url).toContain(encodeURIComponent("2024-01-01T00:00:00+00:00"));
        });
    });

    describe("deleteNote", () => {
        test("sends DELETE with encoded path", async () => {
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { status: "deleted" },
            } as any);
            await api.deleteNote("Notes/My File.md");
            const opts = mockRequestUrl.mock.calls[0][0] as any;
            expect(opts.method).toBe("DELETE");
            expect(opts.url).toContain(encodeURIComponent("Notes/My File.md"));
        });
    });

    describe("getRateLimit", () => {
        test("returns requests_per_minute value", async () => {
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { requests_per_minute: 120 },
            } as any);
            expect(await api.getRateLimit()).toBe(120);
        });

        test("returns 0 on error (assume unlimited)", async () => {
            mockRequestUrl.mockRejectedValueOnce(new Error("404"));
            expect(await api.getRateLimit()).toBe(0);
        });
    });

    describe("getManifest", () => {
        test("returns manifest on success", async () => {
            const manifest = { notes: {}, attachments: {} };
            mockRequestUrl.mockResolvedValueOnce({ status: 200, json: manifest } as any);
            expect(await api.getManifest()).toEqual(manifest);
        });

        test("returns null on 404", async () => {
            mockRequestUrl.mockRejectedValueOnce({ status: 404 });
            expect(await api.getManifest()).toBeNull();
        });

        test("rethrows non-404 errors", async () => {
            mockRequestUrl.mockRejectedValueOnce({ status: 500 });
            await expect(api.getManifest()).rejects.toEqual({ status: 500 });
        });
    });

    describe("search", () => {
        test("sends query only when no optional params", async () => {
            mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { results: [] } } as any);
            await api.search("test query");
            const opts = mockRequestUrl.mock.calls[0][0] as any;
            expect(JSON.parse(opts.body)).toEqual({ query: "test query" });
        });

        test("includes limit and tags when provided", async () => {
            mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { results: [] } } as any);
            await api.search("q", 5, ["health", "fitness"]);
            const opts = mockRequestUrl.mock.calls[0][0] as any;
            const body = JSON.parse(opts.body);
            expect(body.limit).toBe(5);
            expect(body.tags).toEqual(["health", "fitness"]);
        });

        test("omits tags when empty array", async () => {
            mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { results: [] } } as any);
            await api.search("q", undefined, []);
            const opts = mockRequestUrl.mock.calls[0][0] as any;
            const body = JSON.parse(opts.body);
            expect(body.tags).toBeUndefined();
        });
    });

    describe("authorization header", () => {
        test("all authenticated requests include Bearer token", async () => {
            mockRequestUrl.mockResolvedValue({ status: 200, json: {} } as any);
            await api.pushNote("test.md", "content", 123);
            const opts = mockRequestUrl.mock.calls[0][0] as any;
            expect(opts.headers.Authorization).toBe("Bearer engram_testkey");
        });
    });

    describe("X-Vault-ID header", () => {
        test("includes X-Vault-ID when vaultId is set", async () => {
            api.setVaultId("42");
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { changes: [], server_time: "2026-01-01T00:00:00Z" },
            } as any);
            await api.getChanges("2026-01-01T00:00:00Z");
            expect(mockRequestUrl).toHaveBeenCalledWith(
                expect.objectContaining({
                    headers: expect.objectContaining({
                        "X-Vault-ID": "42",
                    }),
                }),
            );
        });

        test("omits X-Vault-ID when vaultId is null", async () => {
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { changes: [], server_time: "2026-01-01T00:00:00Z" },
            } as any);
            await api.getChanges("2026-01-01T00:00:00Z");
            const headers = mockRequestUrl.mock.calls[0][0].headers;
            expect(headers["X-Vault-ID"]).toBeUndefined();
        });

        test("setVaultId updates the header for subsequent requests", async () => {
            api.setVaultId("10");
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { changes: [], server_time: "2026-01-01T00:00:00Z" },
            } as any);
            await api.getChanges("2026-01-01T00:00:00Z");
            expect(mockRequestUrl.mock.calls[0][0].headers["X-Vault-ID"]).toBe("10");

            api.setVaultId("20");
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { changes: [], server_time: "2026-01-01T00:00:00Z" },
            } as any);
            await api.getChanges("2026-01-01T00:00:00Z");
            expect(mockRequestUrl.mock.calls[1][0].headers["X-Vault-ID"]).toBe("20");
        });
    });

    describe("registerVault", () => {
        test("sends POST to /vaults/register with name and client_id", async () => {
            mockRequestUrl.mockResolvedValueOnce({
                status: 201,
                json: { id: 7, name: "My Vault", slug: "my-vault", is_default: true },
            } as any);
            const result = await api.registerVault("My Vault", "abc123hash");
            expect(mockRequestUrl).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: `${TEST_API_BASE}/vaults/register`,
                    method: "POST",
                    body: JSON.stringify({ name: "My Vault", client_id: "abc123hash" }),
                }),
            );
            expect(result).toEqual({ id: 7, name: "My Vault", slug: "my-vault", is_default: true });
        });

        test("returns existing vault on 200", async () => {
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { id: 5, name: "Existing", slug: "existing", is_default: false },
            } as any);
            const result = await api.registerVault("Existing", "def456hash");
            expect(result).toEqual({ id: 5, name: "Existing", slug: "existing", is_default: false });
        });

        test("throws vault_limit_reached on 402", async () => {
            const error = { status: 402, json: { error: "vault_limit_reached", limit: 1 } };
            mockRequestUrl.mockRejectedValueOnce(error);
            await expect(api.registerVault("Third Vault", "ghi789hash")).rejects.toMatchObject({
                status: 402,
                json: { error: "vault_limit_reached", limit: 1 },
            });
        });
    });
});
