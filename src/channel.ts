import type { AuthProvider } from "./auth";
import { rlog } from "./remote-log";
/**
 * Phoenix Channel client for Engram real-time sync.
 *
 * Uses the Phoenix v2 WebSocket wire protocol natively — no phoenix npm
 * package needed.
 *
 * Protocol: messages are JSON arrays [join_ref, ref, topic, event, payload]
 */
import type { NoteStreamEvent } from "./types";

export class NoteChannel {
	private ws: WebSocket | null = null;
	private ref = 0;
	private readonly joinRef = "1";
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectMs = 1000;
	private readonly maxReconnectMs = 60_000;
	private connected = false;
	private baseUrl: string;
	private apiKey: string;
	private userId: string;
	private vaultId: string | null;
	private authProvider: AuthProvider | null = null;

	onEvent: ((event: NoteStreamEvent) => void) | null = null;
	onStatusChange: ((connected: boolean) => void) | null = null;
	onVaultDeleted: (() => void) | null = null;

	constructor(baseUrl: string, apiKey: string, userId: string, vaultId: string | null = null) {
		this.baseUrl = baseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
		this.apiKey = apiKey;
		this.userId = userId;
		this.vaultId = vaultId;
	}

	setAuthProvider(provider: AuthProvider): void {
		this.authProvider = provider;
	}

	private async getAuthToken(): Promise<string> {
		if (this.authProvider) {
			return this.authProvider.getToken();
		}
		return this.apiKey;
	}

	updateConfig(
		baseUrl: string,
		apiKey: string,
		userId: string,
		vaultId: string | null = null,
	): void {
		this.baseUrl = baseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
		this.apiKey = apiKey;
		this.userId = userId;
		this.vaultId = vaultId;
	}

	private get topic(): string {
		return this.vaultId ? `sync:${this.userId}:${this.vaultId}` : `sync:${this.userId}`;
	}

	async connect(): Promise<void> {
		if (this.ws) return;
		this.reconnectMs = 1000;
		await this.openSocket();
	}

	disconnect(): void {
		this.clearTimers();
		if (this.ws) {
			this.ws.onclose = null; // prevent reconnect on intentional close
			this.ws.close();
			this.ws = null;
		}
		this.setConnected(false);
		rlog().info("channel", "Channel disconnected");
	}

	isConnected(): boolean {
		return this.connected;
	}

	// ---------------------------------------------------------------------------
	// Private
	// ---------------------------------------------------------------------------

	private async openSocket(): Promise<void> {
		const token = await this.getAuthToken();
		const wsBase = this.baseUrl.replace(/^http/, "ws").replace(/^https/, "wss");
		const url = `${wsBase}/socket/websocket?token=${encodeURIComponent(token)}&vsn=2.0.0`;

		try {
			this.ws = new WebSocket(url);
		} catch (e) {
			rlog().error("channel", `WebSocket open error: ${e}`);
			this.scheduleReconnect();
			return;
		}

		this.ws.onopen = () => {
			this.reconnectMs = 1000;
			this.joinChannel();
			this.startHeartbeat();
			rlog().info("channel", "WebSocket opened, joining channel");
		};

		this.ws.onmessage = (evt: MessageEvent) => {
			this.handleMessage(evt.data as string);
		};

		this.ws.onerror = (e) => {
			rlog().error("channel", `WebSocket error: ${JSON.stringify(e)}`);
		};

		this.ws.onclose = () => {
			this.clearTimers();
			this.ws = null;
			this.setConnected(false);
			rlog().info("channel", `Channel closed, reconnecting in ${this.reconnectMs}ms`);
			this.scheduleReconnect();
		};
	}

	private joinChannel(): void {
		this.send([this.joinRef, String(++this.ref), this.topic, "phx_join", {}]);
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.send([null, String(++this.ref), "phoenix", "heartbeat", {}]);
			}
		}, 30_000);
	}

	private handleMessage(raw: string): void {
		let msg: unknown[];
		try {
			msg = JSON.parse(raw) as unknown[];
		} catch {
			rlog().error("channel", `Failed to parse message: ${raw}`);
			return;
		}

		const [_joinRef, _ref, _topic, event, payload] = msg as [
			string | null,
			string | null,
			string,
			string,
			Record<string, unknown>,
		];

		if (event === "phx_reply") {
			const status = (payload as { status?: string }).status;
			if (status === "ok" && !this.connected) {
				this.setConnected(true);
				rlog().info("channel", `Joined ${this.topic}`);
			} else if (status === "error") {
				rlog().error("channel", `Channel join error: ${JSON.stringify(payload)}`);
			}
			return;
		}

		if (event === "vault_deleted") {
			rlog().info("channel", "Received vault_deleted event");
			this.onVaultDeleted?.();
			return;
		}

		if (event === "note_changed" && payload) {
			const p = payload as { event_type: string; path: string; kind?: string };
			const streamEvent: NoteStreamEvent = {
				event_type: p.event_type as "upsert" | "delete",
				path: p.path,
				timestamp: Date.now(),
				kind: (p.kind as "note" | "attachment") ?? "note",
			};
			rlog().info("channel", `Event: ${streamEvent.event_type} ${streamEvent.path}`);
			this.onEvent?.(streamEvent);
		}
	}

	private send(msg: unknown[]): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private setConnected(value: boolean): void {
		if (this.connected !== value) {
			this.connected = value;
			this.onStatusChange?.(value);
		}
	}

	private clearTimers(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private scheduleReconnect(): void {
		const jitter = Math.random() * this.reconnectMs * 0.5;
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs);
			await this.openSocket();
		}, this.reconnectMs + jitter);
	}
}
