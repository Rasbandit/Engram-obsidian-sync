/**
 * Tests for channel.ts — Phoenix channel with vault-scoped topics.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AuthProvider } from "../src/auth";
import { NoteChannel } from "../src/channel";

// Capture WebSocket constructor calls
let lastWsUrl: string | null = null;
let lastWsInstance: any = null;

class MockWebSocket {
	static OPEN = 1;
	readyState = MockWebSocket.OPEN;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((evt: { data: string }) => void) | null = null;
	onerror: ((e: any) => void) | null = null;
	sent: string[] = [];

	constructor(url: string) {
		lastWsUrl = url;
		lastWsInstance = this;
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.onclose = null;
	}
}

// Install mock
(globalThis as any).WebSocket = MockWebSocket;

function simulateOpen(ws: any): void {
	ws.onopen?.();
}

function getLastSentMessage(ws: any): unknown[] {
	const raw = ws.sent[ws.sent.length - 1];
	return JSON.parse(raw) as unknown[];
}

function simulateMessage(ws: any, msg: unknown[]): void {
	ws.onmessage?.({ data: JSON.stringify(msg) });
}

beforeEach(() => {
	lastWsUrl = null;
	lastWsInstance = null;
});

describe("NoteChannel topic format", () => {
	test("joins sync:{userId}:{vaultId} when vaultId is provided", async () => {
		const channel = new NoteChannel("http://localhost:4000", "key", "42", "7");
		await channel.connect();
		simulateOpen(lastWsInstance);

		const joinMsg = getLastSentMessage(lastWsInstance);
		// [joinRef, ref, topic, event, payload]
		expect(joinMsg[2]).toBe("sync:42:7");
		expect(joinMsg[3]).toBe("phx_join");

		channel.disconnect();
	});

	test("joins sync:{userId} when vaultId is null (backwards compat)", async () => {
		const channel = new NoteChannel("http://localhost:4000", "key", "42", null);
		await channel.connect();
		simulateOpen(lastWsInstance);

		const joinMsg = getLastSentMessage(lastWsInstance);
		expect(joinMsg[2]).toBe("sync:42");
		expect(joinMsg[3]).toBe("phx_join");

		channel.disconnect();
	});
});

describe("NoteChannel vault_deleted event", () => {
	test("fires onVaultDeleted callback when vault_deleted event received", async () => {
		const onVaultDeleted = mock();
		const channel = new NoteChannel("http://localhost:4000", "key", "42", "7");
		channel.onVaultDeleted = onVaultDeleted;
		await channel.connect();
		simulateOpen(lastWsInstance);

		// Simulate server sending vault_deleted
		simulateMessage(lastWsInstance, [null, null, "sync:42:7", "vault_deleted", {}]);

		expect(onVaultDeleted).toHaveBeenCalledTimes(1);
		channel.disconnect();
	});

	test("does not fire onEvent for vault_deleted (separate callback)", async () => {
		const onEvent = mock();
		const channel = new NoteChannel("http://localhost:4000", "key", "42", "7");
		channel.onEvent = onEvent;
		await channel.connect();
		simulateOpen(lastWsInstance);

		simulateMessage(lastWsInstance, [null, null, "sync:42:7", "vault_deleted", {}]);

		expect(onEvent).not.toHaveBeenCalled();
		channel.disconnect();
	});
});

describe("NoteChannel updateConfig with vaultId", () => {
	test("updateConfig accepts vaultId parameter", async () => {
		const channel = new NoteChannel("http://localhost:4000", "key", "42", "7");
		channel.updateConfig("http://localhost:4001", "key2", "42", "99");
		await channel.connect();
		simulateOpen(lastWsInstance);

		const joinMsg = getLastSentMessage(lastWsInstance);
		expect(joinMsg[2]).toBe("sync:42:99");

		channel.disconnect();
	});
});

describe("NoteChannel.isConnected", () => {
	test("returns false before connect", () => {
		const channel = new NoteChannel("http://localhost:4000", "key", "42", "7");
		expect(channel.isConnected()).toBe(false);
	});

	test("returns true after successful join reply", async () => {
		const channel = new NoteChannel("http://localhost:4000", "key", "42", "7");
		await channel.connect();
		simulateOpen(lastWsInstance);

		// The join message was sent; simulate a successful phx_reply
		const joinMsg = JSON.parse(lastWsInstance.sent[0]);
		const joinRef = joinMsg[0]; // join ref
		const ref = joinMsg[1]; // message ref
		simulateMessage(lastWsInstance, [
			joinRef,
			ref,
			"sync:42:7",
			"phx_reply",
			{ status: "ok", response: {} },
		]);

		expect(channel.isConnected()).toBe(true);
		channel.disconnect();
	});

	test("returns false after disconnect", async () => {
		const channel = new NoteChannel("http://localhost:4000", "key", "42", "7");
		await channel.connect();
		simulateOpen(lastWsInstance);

		const joinMsg = JSON.parse(lastWsInstance.sent[0]);
		simulateMessage(lastWsInstance, [
			joinMsg[0],
			joinMsg[1],
			"sync:42:7",
			"phx_reply",
			{ status: "ok", response: {} },
		]);
		expect(channel.isConnected()).toBe(true);

		channel.disconnect();
		expect(channel.isConnected()).toBe(false);
	});
});

describe("NoteChannel.setAuthProvider", () => {
	test("stores the provider and uses its token for WebSocket URL", async () => {
		const provider: AuthProvider = {
			getToken: mock(() => Promise.resolve("oauth-ws-token-abc")),
			getVaultId: mock(() => "99"),
			isAuthenticated: mock(() => true),
			signOut: mock(() => {}),
		};
		const channel = new NoteChannel("http://localhost:4000", "fallback-key", "42", "7");
		channel.setAuthProvider(provider);
		await channel.connect();

		// The WebSocket URL should contain the oauth token, not the fallback key
		expect(lastWsUrl).toContain("oauth-ws-token-abc");
		expect(lastWsUrl).not.toContain("fallback-key");

		channel.disconnect();
	});

	test("uses apiKey when no auth provider set", async () => {
		const channel = new NoteChannel("http://localhost:4000", "my-api-key", "42", "7");
		await channel.connect();

		expect(lastWsUrl).toContain("my-api-key");

		channel.disconnect();
	});
});
