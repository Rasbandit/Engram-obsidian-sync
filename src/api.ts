/**
 * Engram HTTP client.
 *
 * Uses Obsidian's requestUrl() which bypasses CORS and works on mobile.
 */
import { type RequestUrlResponse, requestUrl } from "obsidian";
import type { AuthProvider } from "./auth";
import { interpretHealthProbe, type PreflightResult } from "./auth-state";
import { isHttpStatus, statusOf } from "./error-util";
import { LimitExceededError } from "./limit-error";
import { BeaconBuffer } from "./observability/beacon";
import { newTraceContext } from "./observability/traceGen";
import type { BillingUsage } from "./plan-usage";
import { pluginVersion } from "./plugin-version";
import { type RemoteLogEntry, rlog } from "./remote-log";
import type {
	AttachmentDetail,
	AttachmentResponse,
	DeleteResponse,
	ManifestResponse,
	NoteResponse,
	SearchResponse,
	VaultInfo,
	VaultRegistrationResponse,
	VersionConflictResponse,
} from "./types";
import { notifyUpgradeRequired } from "./upgrade-required";

/** A request exceeded its deadline. requestUrl() cannot be aborted, so the
 *  underlying request is ABANDONED, not cancelled — a late server-side apply
 *  is possible and handled by the normal echo/conflict machinery. Carries no
 *  `status`, so existing callers classify it like connection loss (issue #244:
 *  a wedged half-open request hung forever, pinning `pulling` and stalling
 *  sync in both directions until plugin reload). */
export class RequestTimeoutError extends Error {
	constructor(ms: number) {
		super(`Request timed out after ${ms}ms`);
		this.name = "RequestTimeoutError";
	}
}

/** Deadline-bound a promise. Exported for the direct `requestUrl` call sites
 *  outside EngramApi (token refresh, device flow, update check,
 *  probeHealth) — anything unbounded there can wedge its caller forever;
 *  the token-refresh case stalls EVERY request behind getToken(). */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: number | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new RequestTimeoutError(ms)), ms);
	});
	try {
		// race (not re-wrap) so a requestUrl rejection propagates UNCHANGED —
		// callers classify on its `.status` (402 limit parse, 401 token retry).
		// A loser's late rejection can never surface as unhandled: race itself
		// attaches a reaction to every contender.
		return await Promise.race([p, deadline]);
	} finally {
		window.clearTimeout(timer);
	}
}

export class EngramApi {
	/** Deadline for note/metadata requests. Instance fields (not consts) so
	 *  tests can shrink them; attachments get a longer one — a large upload on
	 *  a slow link legitimately outlives the note deadline. */
	requestTimeoutMs = 15_000;
	attachmentTimeoutMs = 120_000;

	/** In-flight sendRequest calls, so a channel-disconnect signal can probe
	 *  for wedged connections and fail them early (see failWedgedRequests). */
	private readonly inflight = new Set<{
		startedAt: number;
		abandon: (e: Error) => void;
		shielded: boolean;
	}>();

	/** Single-flight latch for failWedgedRequests (see there). */
	private wedgeProbeInFlight = false;

	private vaultId: string | null = null;
	private deviceId: string | null = null;
	private authProvider: AuthProvider | null = null;
	// Dark-launch gate for distributed tracing. Disabled cost must stay a
	// single boolean check, see sendRequest.
	private tracingEnabled = false;
	// Cached from the most recent sendRequest call so the beacon transport
	// thunk (invoked later, on the buffer's own flush timer) can post with a
	// still-valid token without re-awaiting the auth provider.
	private lastToken = "";
	/** Coalescing beacon buffer for `obsidian.push` spans. Transport thunk
	 *  returns null (drop, no network) whenever tracing is disabled. */
	readonly beacon: BeaconBuffer;

	constructor(
		private baseUrl: string,
		private apiKey: string,
	) {
		this.baseUrl = EngramApi.normalizeBaseUrl(baseUrl);
		this.beacon = new BeaconBuffer(() => {
			// No credential = drop the batch. The beacon posts with window.fetch,
			// so it bypasses the getAuthToken guard and would 401 on its own.
			if (!this.tracingEnabled || !this.lastToken) return null;
			return {
				baseUrl: this.baseUrl,
				token: this.lastToken,
				vaultId: this.getActiveVaultId() ?? "",
				deviceId: this.deviceId ?? "",
			};
		});
	}

	/** Enable/disable trace header injection + the obsidian.push beacon. When
	 *  false, sendRequest does no id generation, no timing capture, no header,
	 *  and enqueues nothing: cost is exactly one boolean check. */
	setTracingEnabled(enabled: boolean): void {
		this.tracingEnabled = enabled;
	}

	setVaultId(id: string | null): void {
		this.vaultId = id;
	}

	/** Set the per-install device id sent as X-Device-Id on every REST call
	 *  (used for delete-broadcast echo suppression, #970). */
	setDeviceId(id: string | null): void {
		this.deviceId = id && id.length > 0 ? id : null;
	}

	setAuthProvider(provider: AuthProvider | null): void {
		this.authProvider = provider;
		// The cached beacon token belongs to the old credential source; keeping
		// it would let a pending beacon batch post it under the new identity.
		this.lastToken = "";
	}

	getActiveVaultId(): string | null {
		if (this.authProvider) {
			return this.authProvider.getVaultId();
		}
		return this.vaultId;
	}

	/** The credential for the next request, or a throw when there isn't one.
	 *
	 *  An empty token would go out as `Authorization: Bearer ` — the HTTP layer
	 *  strips trailing whitespace from field values, so the server receives a
	 *  bare `Bearer`, fails the `"Bearer " <> token` match in the Auth plug and
	 *  logs `reason=no_auth`. An unlinked install (authProvider nulled by
	 *  clearAuthAndPromptRelink / a backend switch, empty apiKey) otherwise
	 *  loops those 401s forever across folder pushes, log pushes and beacons —
	 *  including the log push carrying the complaint about the 401s. Failing
	 *  here instead keeps every one of those off the wire; a single guard in the
	 *  shared path covers all callers. */
	private async getAuthToken(): Promise<string> {
		const token = this.authProvider ? await this.authProvider.getToken() : this.apiKey;
		if (!token) {
			throw new Error("Not authenticated: no API key or access token");
		}
		return token;
	}

	/** Strip trailing slashes and append /api if not already present. Public:
	 *  the single normalizer for every surface that builds an API base
	 *  (device flow, OAuth token refresh) — copies of this logic once lived
	 *  inline at those sites. The channel's WS origin is the inverse shape
	 *  (strips /api); see wsOrigin in channel.ts. */
	static normalizeBaseUrl(url: string): string {
		const base = url.replace(/\/+$/, "");
		return base.endsWith("/api") ? base : `${base}/api`;
	}

	/** Probe an arbitrary candidate URL's `/api/health` WITHOUT committing it as
	 *  the active backend. Used by the self-hosted settings preflight so the user
	 *  gets background confirmation a URL points at a real Engram server before
	 *  they commit to it. No auth — `/health` is public. */
	static async probeHealth(rawUrl: string): Promise<PreflightResult> {
		const base = EngramApi.normalizeBaseUrl(rawUrl);
		try {
			const resp = await withTimeout(
				requestUrl({ url: `${base}/health`, method: "GET", throw: false }),
				10_000,
			);
			let body: unknown = null;
			try {
				body = resp.json;
			} catch {
				body = null;
			}
			return interpretHealthProbe(resp.status, body);
		} catch {
			return { kind: "unreachable" };
		}
	}

	updateConfig(baseUrl: string, apiKey: string): void {
		this.baseUrl = EngramApi.normalizeBaseUrl(baseUrl);
		this.apiKey = apiKey;
		// A backend switch wipes every persisted token (withClearedAuth) for
		// exactly this reason: a pending beacon batch must never ship the old
		// backend's JWT to the new origin.
		this.lastToken = "";
	}

	/** Surface a `426` — this plugin is below the backend's minimum version —
	 *  and report whether that is what happened, so the caller rethrows the
	 *  original error unchanged. Nothing branches on a 426 programmatically;
	 *  the user-visible half is the notice, which latches to once per session.
	 *
	 *  Returning true short-circuits the generic warn below. That is not tidiness:
	 *  `/api/logs` is itself on the vault-scoped pipeline, so a below-floor client
	 *  gets 426 on its own log push too. Logging every refusal would refill the
	 *  200-entry remote-log ring with nothing but its own refusals and evict the
	 *  diagnostics you actually wanted off a blocked install. The latched warn
	 *  inside `notifyUpgradeRequired` is the one record we keep. */
	private noteIfUpgradeRequired(e: unknown, status: number | undefined): boolean {
		if (status !== 426) return false;
		const body = errorBody(e);
		notifyUpgradeRequired(typeof body.min_version === "string" ? body.min_version : null);
		return true;
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
	): Promise<RequestUrlResponse> {
		try {
			return await this.sendRequest(method, path, body, extraHeaders);
		} catch (e) {
			const status = statusOf(e);
			// 402 = tier limit exceeded. Convert to a typed error carrying the
			// structured body (reason / limit_key / limit / current / upgrade_url)
			// so callers can route on reason (toast handler, Sync Center) without
			// re-parsing JSON. Placed BEFORE the 401 retry and generic-throw paths
			// so 402 always gets the rich error — see spec §4.6.
			if (status === 402) {
				throw parseLimitExceededError(e);
			}
			if (this.noteIfUpgradeRequired(e, status)) {
				throw e;
			}
			// On 401, the cached access token may be stale (e.g. server-side TTL
			// shorter than the expires_in we trusted). Invalidate and retry once
			// with a freshly-refreshed token. Static-key providers have no
			// recovery path, so retry only when invalidateAccessToken is supported.
			if (status === 401 && this.authProvider?.invalidateAccessToken) {
				this.authProvider.invalidateAccessToken();
				// Single-shot retry (recursing into request() could 401-loop), but it
				// must keep the 402 mapping and failure logging of the primary path —
				// a 401-then-402 (token refresh revealing a lapsed plan) otherwise
				// escapes as a raw rejection and is retried forever instead of parked.
				try {
					return await this.sendRequest(method, path, body, extraHeaders);
				} catch (e2) {
					const retryStatus = statusOf(e2);
					if (retryStatus === 402) {
						throw parseLimitExceededError(e2);
					}
					// 426 must be handled here too, for the same reason 402 is.
					// `Auth` runs BEFORE `RequirePluginVersion` server-side, so a
					// stale cached token yields 401-then-426 — i.e. every launch
					// that refreshes a token puts the version refusal on THIS
					// path, not the primary one. Missing it here made the notice
					// unreachable in the single most likely real-world shape.
					if (this.noteIfUpgradeRequired(e2, retryStatus)) {
						throw e2;
					}
					rlog().warn(
						"api",
						`${method} ${beaconRoute(path)} failed after 401 retry — status=${retryStatus ?? "none"} vault=${this.vaultId ?? "none"}`,
					);
					throw e2;
				}
			}
			// Log every non-2xx with method/status/vault so failures are legible
			// (a 404 here meaning "token's user doesn't own this vault" is easy
			// to misread as a missing note otherwise). Token itself is never logged.
			rlog().warn(
				"api",
				`${method} ${beaconRoute(path)} failed — status=${status ?? "none"} vault=${this.vaultId ?? "none"}`,
			);
			throw e;
		}
	}

	private async sendRequest(
		method: string,
		path: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
	): Promise<RequestUrlResponse> {
		const token = await this.getAuthToken();
		this.lastToken = token;
		// Scope tracing to mutations only: GET requests are zero-cost (no tracing).
		// Gate BEFORE any tracing work: disabled or GET = one boolean check, nothing else.
		// No id generation, no header, no timing capture, no network.
		const traced = this.tracingEnabled && method.toUpperCase() !== "GET";
		const trace = traced ? newTraceContext() : null;
		const startUs = trace ? Date.now() * 1000 : 0;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			...(trace ? { traceparent: trace.traceparent } : {}),
			...extraHeaders,
		};
		// Use the *active* vault (OAuth provider's bound vault, or the raw field
		// for API-key auth) — NOT the raw this.vaultId. For OAuth installs the
		// field can be empty while the provider holds the real vault, which made
		// vault-scoped REST calls (notably /search) fall back to the user's
		// default vault server-side (VaultPlug defaults when X-Vault-ID is absent).
		const activeVaultId = this.getActiveVaultId();
		if (activeVaultId) {
			headers["X-Vault-ID"] = activeVaultId;
		}
		if (this.deviceId) {
			headers["X-Device-Id"] = this.deviceId;
		}
		// Reported so the backend can refuse clients below its compatibility
		// floor (426 plugin_upgrade_required). Omitted, never sent empty — see
		// plugin-version.ts.
		const version = pluginVersion();
		if (version) {
			headers["X-Plugin-Version"] = version;
		}
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		// Deadline classes. Only actual attachment byte transfers earn 120s:
		// upload (POST /attachments) and download (GET /attachments/<path>).
		// Everything else is note/metadata traffic on the short deadline —
		// the REST bulk-page class (batch push, change feeds) died with the
		// socket-only migration (#304).
		const attachmentTransfer =
			path.startsWith("/attachments") && (method === "POST" || method === "GET");
		const timeoutMs = attachmentTransfer ? this.attachmentTimeoutMs : this.requestTimeoutMs;
		const raw = requestUrl({
			url: `${this.baseUrl}${path}`,
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		let abandonReject: (e: Error) => void = () => {};
		const abandoned = new Promise<never>((_, rej) => {
			abandonReject = rej;
		});
		// `shielded`: a slow-but-healthy attachment transfer legitimately hangs
		// past the probe age, so the wedge probe must never abort it — its own
		// 120s deadline is the only ceiling. (Bulk pages are NOT shielded:
		// ponytail — a WS flap can abort a slow healthy bulk page, which just
		// retries; shielding them would regress the wedged-pull fast recovery.)
		const entry = {
			startedAt: Date.now(),
			abandon: abandonReject,
			shielded: attachmentTransfer,
		};
		this.inflight.add(entry);
		try {
			return await withTimeout(Promise.race([raw, abandoned]), timeoutMs);
		} finally {
			this.inflight.delete(entry);
			// Fire-and-forget: enqueue is O(1), touches no network on this path
			// (the buffer batches/flushes on its own timer), and never blocks or
			// fails the request above, including on the error path, so a failed
			// push still yields a trace.
			if (trace) {
				const noteId = beaconNoteId(path);
				this.beacon.enqueue({
					trace_id: trace.traceId,
					parent_span_id: trace.spanId,
					name: "obsidian.push",
					start_us: startUs,
					end_us: Date.now() * 1000,
					attributes: {
						"engram.surface": "obsidian",
						"engram.event_type": method.toLowerCase(),
						// Which note and which route — the 2026-07-14 deaf-note hunt
						// stalled on beacons that carried neither. note_id is a
						// non-sensitive UUID; route has UUIDs collapsed to :id so its
						// cardinality stays bounded.
						...(noteId ? { "engram.note_id": noteId } : {}),
						"engram.route": beaconRoute(path),
					},
				});
			}
		}
	}

	/** Fail in-flight requests older than maxAgeMs IF a fresh /health probe
	 *  answers while they still hang — proof the connection they rode is wedged
	 *  (half-open after a deploy drain), not that the server is down. Called on
	 *  channel disconnect (the earliest wedge signal the plugin gets), so
	 *  recovery runs in ~probe time instead of the full request deadline. If
	 *  the probe fails, the server may be genuinely unreachable: leave the
	 *  requests to their normal deadline. Returns how many were failed. */
	async failWedgedRequests(maxAgeMs = 4_000): Promise<number> {
		// Single-flight: reconnect flaps fire this repeatedly; concurrent probes
		// would double-count the same stale entries.
		if (this.wedgeProbeInFlight) {
			return 0;
		}
		this.wedgeProbeInFlight = true;
		try {
			const now = Date.now();
			const stale = [...this.inflight].filter(
				(e) => !e.shielded && now - e.startedAt >= maxAgeMs,
			);
			if (stale.length === 0) {
				return 0;
			}
			if (!(await this.health())) {
				return 0;
			}
			let failed = 0;
			for (const e of stale) {
				// Delete BEFORE abandoning: sendRequest's finally-cleanup runs a
				// microtask later, so without this a racing settle could be
				// double-counted.
				if (this.inflight.delete(e)) {
					e.abandon(new RequestTimeoutError(maxAgeMs));
					failed++;
				}
			}
			if (failed > 0) {
				rlog().warn("api", `Failed ${failed} wedged request(s) after healthy probe`);
			}
			return failed;
		} finally {
			this.wedgeProbeInFlight = false;
		}
	}

	/** Health check — no auth required. Bounded like every other request: the
	 *  offline health-check loop awaits this, so a wedged probe would freeze
	 *  offline recovery. */
	async health(): Promise<boolean> {
		try {
			const resp = await withTimeout(
				requestUrl({
					url: `${this.baseUrl}/health`,
					method: "GET",
				}),
				this.requestTimeoutMs,
			);
			return resp.status === 200;
		} catch {
			return false;
		}
	}

	/** Get the current authenticated user (id + email). Used to determine channel topic. */
	/** Plan caps AND current usage, for the Sync Center plan panel.
	 *
	 *  Advisory only, per the endpoint's own docstring: `Billing.check_limit/3`
	 *  and the plugs stay the authority, and a stale read here can never grant
	 *  anything. Do NOT gate any client behaviour on it.
	 *
	 *  Separate from the plan state on the channel join, which carries the caps
	 *  but no usage, and only refreshes on rejoin. Usage moves every time the
	 *  user writes a note, so it is fetched when the panel renders. */
	async getBillingUsage(): Promise<BillingUsage> {
		const resp = await this.request("GET", "/billing/usage");
		const body = resp.json as Partial<BillingUsage> | undefined;
		if (!body || typeof body.usage !== "object" || body.usage === null) {
			throw new Error("Malformed /billing/usage response: missing usage");
		}
		return { tier: String(body.tier ?? "free"), usage: body.usage };
	}

	async getMe(): Promise<{ id: string; email: string }> {
		const resp = await this.request("GET", "/me");
		const user = (resp.json as { user?: { id: string; email: string } }).user;
		// A shape mismatch (proxy error page, wrong server) must be a legible
		// error, not an opaque TypeError on a nested dereference.
		if (!user) throw new Error("Malformed /me response: missing user");
		return user;
	}

	/** Register this vault with the backend. Returns existing vault if client_id matches.
	 *  Throws with status 402 if user has reached their vault limit (free tier). */
	async registerVault(name: string, clientId: string): Promise<VaultRegistrationResponse> {
		const resp = await this.request("POST", "/vaults/register", {
			name,
			client_id: clientId,
		});
		return resp.json as VaultRegistrationResponse;
	}

	/** Fetch all vaults accessible by the current user. Throws the underlying
	 *  request error (with `.status` for HTTP responses) so callers can render
	 *  401/timeout/5xx distinctly from "successful empty list". */
	async listVaults(): Promise<VaultInfo[]> {
		const resp = await this.request("GET", "/vaults");
		const vaults = (resp.json as { vaults?: VaultInfo[] }).vaults;
		// NOT `?? []`: a malformed 200 must stay distinct from a genuine empty
		// list (see the doc comment above).
		if (!Array.isArray(vaults)) throw new Error("Malformed /vaults response: missing vaults");
		return vaults;
	}

	/** Authenticated ping — verifies both connectivity and API key. */
	async ping(): Promise<{ ok: boolean; error?: string }> {
		try {
			await this.request("GET", "/folders");
			return { ok: true };
		} catch (e: unknown) {
			const status = statusOf(e);
			if (status === 401 || status === 403) {
				return { ok: false, error: "Invalid API key" };
			}
			// Surface the real HTTP status (e.g. a 404 from a stale token at the
			// wrong vault) instead of a blanket "Connection failed" — the status
			// is the difference between "server down" and "auth/vault mismatch".
			if (typeof status === "number") {
				return { ok: false, error: `HTTP ${status} from /folders` };
			}
			return { ok: false, error: "Connection failed" };
		}
	}

	/** Push a note to Engram.
	 *  When version is provided, the server uses optimistic concurrency control:
	 *  returns 409 with the current server state if the version doesn't match.
	 *  `clientId` carries a plugin-minted note_id (UUIDv7) for a note whose id
	 *  isn't yet known server-side — sent as the body `id` field, which the
	 *  server adopts as the note's primary key on first create (note_id-keyed
	 *  CRDT rework, Task 5). Harmless to send for an existing note: the server
	 *  already has an id and ignores it. */
	async pushNote(
		path: string,
		content: string,
		mtime: number,
		version?: number,
		clientId?: string,
		baseHash?: string,
	): Promise<NoteResponse | VersionConflictResponse> {
		const body: Record<string, unknown> = { path, content, mtime };
		if (version !== undefined) body.version = version;
		if (clientId !== undefined) body.id = clientId;
		// CAS guard (backend v0.5.642): the server content_hash this client last
		// synced. A stale base 409s instead of merging — a client that missed a
		// delivery must not "convergently" delete content it never saw.
		if (baseHash !== undefined) body.base_hash = baseHash;
		try {
			const resp = await this.request("POST", "/notes", body);
			return resp.json as NoteResponse;
		} catch (e) {
			if (isHttpStatus(e, 409)) {
				const err = e as { json?: VersionConflictResponse; text?: string };
				if (err.json) return err.json;
				if (err.text) {
					// A mangled 409 body (proxy error page, truncation) must stay a
					// classifiable conflict, not become a bare SyntaxError with no
					// .status that callers misread as connection loss.
					try {
						return JSON.parse(err.text) as VersionConflictResponse;
					} catch {
						throw e;
					}
				}
			}
			throw e;
		}
	}

	/** Delete a note. */
	async deleteNote(path: string): Promise<DeleteResponse> {
		const encoded = encodePath(path);
		const resp = await this.request("DELETE", `/notes/${encoded}`);
		return resp.json as DeleteResponse;
	}

	// --- CRDT ops transport: fully socket-native — REST /updates deleted in
	// Phase E3, the /vault/heads capability probe deleted with the pre-CRDT
	// backend floor. The crdt: channel is the only Yjs path. ---

	// --- Attachment methods ---

	/** Push a binary attachment as base64. */
	async pushAttachment(
		path: string,
		contentBase64: string,
		mimeType: string,
		mtime: number,
	): Promise<AttachmentResponse> {
		const resp = await this.request("POST", "/attachments", {
			path,
			content_base64: contentBase64,
			mime_type: mimeType,
			mtime,
		});
		return resp.json as AttachmentResponse;
	}

	/** Get attachment content (base64). */
	async getAttachment(path: string): Promise<AttachmentDetail> {
		const encoded = encodePath(path);
		const resp = await this.request("GET", `/attachments/${encoded}`);
		return resp.json as AttachmentDetail;
	}

	/** Delete an attachment. */
	async deleteAttachment(path: string): Promise<DeleteResponse> {
		const encoded = encodePath(path);
		const resp = await this.request("DELETE", `/attachments/${encoded}`);
		return resp.json as DeleteResponse;
	}

	/** Search indexed notes.
	 *
	 *  `mode` is the server's wire vocabulary, NOT the plugin's: the backend
	 *  reads "keyword" | "vector" | "hybrid" and silently falls back to hybrid
	 *  for anything else (`parse_mode/1`). The plugin's own mode is called
	 *  "semantic"; sending that word verbatim would quietly get hybrid instead,
	 *  so the translation happens at the one call site in search-engine.ts. */
	async search(
		query: string,
		limit?: number,
		tags?: string[],
		folder?: string,
		mode?: "keyword" | "vector" | "hybrid",
	): Promise<SearchResponse> {
		const body: {
			query: string;
			limit?: number;
			tags?: string[];
			folder?: string;
			mode?: string;
		} = { query };
		if (limit !== undefined) body.limit = limit;
		if (tags?.length) body.tags = tags;
		if (folder) body.folder = folder;
		if (mode) body.mode = mode;
		const resp = await this.request("POST", "/search", body);
		return resp.json as SearchResponse;
	}

	/** Fetch sync manifest for reconciliation.
	 *  Returns null if the server doesn't support this endpoint (404). */
	async getManifest(sinceSeq?: number): Promise<ManifestResponse | null> {
		const qs =
			typeof sinceSeq === "number" && Number.isFinite(sinceSeq) && sinceSeq >= 0
				? `?since_seq=${sinceSeq}`
				: "";
		try {
			const resp = await this.request("GET", `/sync/manifest${qs}`);
			return resp.json as ManifestResponse;
		} catch (e) {
			if (isHttpStatus(e, 404)) {
				return null;
			}
			throw e;
		}
	}

	/** Push batched log entries to the server for remote debugging. Typed as
	 *  the real wire shape — an inline copy of it here had already drifted
	 *  (missing conn_id/device_id/vault_id/seq that ARE sent). */
	async pushLogs(entries: RemoteLogEntry[]): Promise<void> {
		await this.request("POST", "/logs", { logs: entries });
	}

	// --- Explicit folder markers (kind='folder' rows) ---

	/** Create an explicit empty folder marker. Server is idempotent — repeated
	 *  calls return 200 instead of 201 but the same shape. */
	async createFolder(folder: string): Promise<{ folder: { name: string; count: number } }> {
		const resp = await this.request("POST", "/folders", { folder });
		return resp.json as { folder: { name: string; count: number } };
	}

	/** Delete an explicit empty folder marker. Server always 204 — idempotent.
	 *  Slashes are preserved as path separators; each segment is URL-encoded so
	 *  spaces and other reserved characters survive routing. */
	async deleteFolder(path: string): Promise<void> {
		const segments = path.split("/").map(encodeURIComponent).join("/");
		await this.request("DELETE", `/folders/${segments}`);
	}

	/** Fetch the list of explicit folder marker names. Plugin-only endpoint
	 *  (the frontend lists folders through a different surface). */
	async listExplicitFolders(): Promise<string[]> {
		const resp = await this.request("GET", "/folders/explicit");
		const body = resp.json as { folders?: { name: string }[] };
		return (body.folders ?? []).map((f) => f.name);
	}
}

/** Build a LimitExceededError from an Obsidian requestUrl rejection at status
 *  402. The body may arrive as `.json` (parsed) or `.text` (raw) depending on
 *  platform; we try both, defaulting safe values when either is missing so the
 *  caller always gets a typed error rather than a confusing decode crash. */
const UUID_SEGMENT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** First UUID in a request path — the note/attachment the call is about, or
 *  null. UUIDs are non-sensitive; beaconRoute reduces everything else in the
 *  path to `:seg`, so no vault segment leaves this function. */
export function beaconNoteId(path: string): string | null {
	UUID_SEGMENT.lastIndex = 0;
	return UUID_SEGMENT.exec(path)?.[0]?.toLowerCase() ?? null;
}

/** Route segments that are OURS. Everything else in a request path is the
 *  user's — `/notes/Medical/biopsy.md` is three segments of vault structure. */
const STATIC_ROUTE_SEGMENTS = new Set([
	"api",
	"attachments",
	"changes",
	"explicit",
	"folders",
	"health",
	"heads",
	"logs",
	"manifest",
	"me",
	"notes",
	"register",
	"search",
	"sync",
	"updates",
	"vault",
	"vaults",
]);

/** Request path reduced to its ROUTE SHAPE — a bounded-cardinality label safe
 *  for span attributes.
 *
 *  Collapsing UUIDs alone was not enough, and the old comment ("paths are never
 *  sent raw") was wrong: `deleteNote`/`deleteAttachment` build the path from the
 *  vault-relative note path, so `/notes/Medical/Divorce settlement draft.md`
 *  went out whole, truncated at 64 bytes. The server's BeaconSanitizer rejects
 *  a path smuggled into `engram.note_id` but admits `engram.route` on length
 *  alone, so it landed as an OTel attribute in Tempo.
 *
 *  Allowlist, not denylist: an unrecognised segment is assumed to be the user's.
 *  A new route that forgets to register here reads `:seg`, which costs one
 *  unhelpful label — the other direction costs a folder name. */
export function beaconRoute(path: string): string {
	const bare = (path.split("?")[0] ?? path).replace(UUID_SEGMENT, ":id");
	return bare
		.split("/")
		.map((seg) => {
			if (!seg || seg === ":id") return seg;
			// Case-SENSITIVE. Our own route segments are lowercase, so folding case
			// buys nothing and costs the whole point: a vault folder named `Notes`,
			// `Search` or `Health` matched the allowlist and was emitted verbatim.
			return STATIC_ROUTE_SEGMENTS.has(seg) ? seg : ":seg";
		})
		.join("/")
		.slice(0, 64);
}

/** The JSON body of an Obsidian `requestUrl` rejection. Arrives as `.json`
 *  (parsed) or `.text` (raw) depending on platform, so try both; a malformed
 *  or missing body yields `{}` rather than a decode crash, because every
 *  caller here is already on an error path and must not fail twice. */
function errorBody(e: unknown): Record<string, unknown> {
	const err = e as { json?: unknown; text?: string };
	if (err.json && typeof err.json === "object") {
		return err.json as Record<string, unknown>;
	}
	if (typeof err.text === "string") {
		try {
			const parsed: unknown = JSON.parse(err.text);
			if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
		} catch {
			// Malformed text — fall through to {}. For a 402 that still routes
			// to the generic toast via the "unknown" reason.
		}
	}
	return {};
}

function parseLimitExceededError(e: unknown): LimitExceededError {
	const body = errorBody(e);
	const pick = <T>(key: string): T | null => (body[key] !== undefined ? (body[key] as T) : null);
	// Fall back to `error` when `reason` is absent. Not every 402 uses the
	// LimitResponse shape: RequireApiWriteEnabled and EnforcePatCreation emit
	// {"error": "..."} with no reason, so keying on `reason` alone sent both to
	// the generic "Limit reached" toast and made their copy unreachable.
	return new LimitExceededError(
		typeof body.reason === "string"
			? body.reason
			: typeof body.error === "string" && body.error !== "limit_exceeded"
				? body.error
				: "unknown",
		sanitizeUpgradeUrl(body.upgrade_url),
		pick<string>("limit_key"),
		pick<number | boolean>("limit"),
		pick<number>("current"),
	);
}

/** The 402 body's upgrade_url is handed to window.open (Electron external-open
 *  on desktop), so a malicious self-host backend must not be able to launch
 *  arbitrary protocol handlers. Only absolute http(s) URLs survive. */
function sanitizeUpgradeUrl(v: unknown): string | null {
	if (typeof v !== "string") return null;
	try {
		const u = new URL(v);
		return u.protocol === "http:" || u.protocol === "https:" ? v : null;
	} catch {
		return null;
	}
}

/** Encode a vault path for use in a URL path segment list. Encodes each
 *  segment but preserves the "/" separators — Phoenix's Plug.Static rejects
 *  %2F-encoded slashes with a 400 (InvalidPathError) before routing/auth, so
 *  encodeURIComponent over the whole path breaks any file in a subfolder. */
function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

/** Convert an ArrayBuffer to a base64 string. Chunked fromCharCode instead of
 *  per-byte string concatenation: attachments run to multi-MB on the main
 *  thread (mobile included), where the O(n) rope-churn loop was measurable.
 *  32k chunks stay safely under engine argument-count limits. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += 0x8000) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
	}
	return btoa(parts.join(""));
}

/** Convert a base64 string to an ArrayBuffer. */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}
