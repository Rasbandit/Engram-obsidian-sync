/**
 * The backend refuses clients below a compatibility floor (426
 * `plugin_upgrade_required` on REST, the same reason on a channel join) and
 * reads the installed-base version distribution off these two fields.
 *
 * If either stops being sent the floor silently stops applying to us and the
 * distribution goes blank. Both failures are invisible in normal use, which
 * is the whole reason they are pinned here.
 */
import { afterEach, beforeEach, describe, expect, type Mock, test } from "bun:test";
import { requestUrl } from "obsidian";
import { EngramApi } from "../src/api";
import { pluginVersion, setPluginVersion } from "../src/plugin-version";

const mockRequestUrl = requestUrl as unknown as Mock<() => Promise<any>>;

const okResponse = { status: 200, json: { notes: [], attachments: [] } } as any;

describe("X-Plugin-Version", () => {
	let api: EngramApi;

	beforeEach(() => {
		mockRequestUrl.mockReset();
		api = new EngramApi("https://api.example.com", "test-key");
	});

	// Module singleton: leaking a version into the next file's tests would make
	// the "omits when unset" case pass or fail on ordering.
	afterEach(() => setPluginVersion(""));

	test("stamps the version set at onload", async () => {
		setPluginVersion("1.28.0");
		mockRequestUrl.mockResolvedValueOnce(okResponse);

		await api.getManifest();

		expect(mockRequestUrl.mock.calls[0][0].headers["X-Plugin-Version"]).toBe("1.28.0");
	});

	// Omitted, not sent empty. The backend allows both, but "never reported"
	// and "reported junk" want different operator responses.
	test("omits the header when the version was never set", async () => {
		mockRequestUrl.mockResolvedValueOnce(okResponse);

		await api.getManifest();

		expect(mockRequestUrl.mock.calls[0][0].headers["X-Plugin-Version"]).toBeUndefined();
	});

	test("is read per request, so a late set still reaches the wire", async () => {
		mockRequestUrl.mockResolvedValueOnce(okResponse);
		await api.getManifest();
		expect(mockRequestUrl.mock.calls[0][0].headers["X-Plugin-Version"]).toBeUndefined();

		setPluginVersion("1.29.0");
		mockRequestUrl.mockResolvedValueOnce(okResponse);
		await api.getManifest();

		expect(mockRequestUrl.mock.calls[1][0].headers["X-Plugin-Version"]).toBe("1.29.0");
	});
});

describe("setPluginVersion", () => {
	afterEach(() => setPluginVersion(""));

	test("round-trips", () => {
		expect(pluginVersion()).toBe("");
		setPluginVersion("9.9.9");
		expect(pluginVersion()).toBe("9.9.9");
	});
});
