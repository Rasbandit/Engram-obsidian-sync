/**
 * Tests for channel.ts — Phoenix channel with vault-scoped topics.
 */
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
		const onVaultDeleted = jest.fn();
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
		const onEvent = jest.fn();
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
