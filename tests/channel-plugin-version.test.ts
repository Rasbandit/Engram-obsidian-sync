import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { NoteChannel } from "../src/channel";
import { setPluginVersion } from "../src/plugin-version";

// Capture the URL passed to WebSocket without opening a real socket.
class FakeWS {
	static lastUrl = "";
	static OPEN = 1;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: (() => void) | null = null;
	readyState = 0;
	constructor(url: string) {
		FakeWS.lastUrl = url;
	}
	close() {}
	send() {}
}

beforeAll(() => {
	// @ts-expect-error test shim
	global.WebSocket = FakeWS;
});

afterEach(() => setPluginVersion(""));

// `lastUrl` is static and survives between tests, so the "omits" case would
// otherwise read whatever the previous socket left behind and pass on stale
// state.
beforeEach(() => {
	FakeWS.lastUrl = "";
});

// The socket param is the load-bearing half of the compatibility floor: sync
// runs over channels, so a floor enforced only on REST would leave a blocked
// client syncing. It is also the version signal with the best COVERAGE — the
// client-log column carries the same value but only when the user has enabled
// diagnostics.
test("puts plugin_version on the socket URL", async () => {
	setPluginVersion("1.28.0");
	const ch = new NoteChannel("http://x", "key-123", "user-1", "vault-9", "dev-1");

	await ch.connect();

	expect(FakeWS.lastUrl).toContain("plugin_version=1.28.0");
});

test("omits plugin_version when unset", async () => {
	const ch = new NoteChannel("http://x", "key-123", "user-1", "vault-9", "dev-1");

	await ch.connect();

	expect(FakeWS.lastUrl).not.toContain("plugin_version");
});
