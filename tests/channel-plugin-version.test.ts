import { afterEach, beforeAll, expect, test } from "bun:test";
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

// The socket param is the load-bearing half of the compatibility floor: sync
// runs over channels, so a floor enforced only on REST would leave a blocked
// client syncing. It is also the ONLY place the backend records which plugin
// versions are actually in use.
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
