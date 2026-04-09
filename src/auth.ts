/**
 * Auth providers for Engram plugin — abstracts API key vs OAuth token management.
 * The rest of the plugin calls getToken() and doesn't know which method is active.
 */

export interface AuthProvider {
	getToken(): Promise<string>;
	getVaultId(): string | null;
	isAuthenticated(): boolean;
	signOut(): void;
}

export type RefreshFn = (refreshToken: string) => Promise<{
	access_token: string;
	refresh_token: string;
	expires_in: number;
}>;

/** Simple wrapper around a static API key. No refresh logic. */
export class ApiKeyAuth implements AuthProvider {
	private apiKey: string;
	private vaultId: string | null;

	constructor(apiKey: string, vaultId: string | null) {
		this.apiKey = apiKey;
		this.vaultId = vaultId;
	}

	async getToken(): Promise<string> {
		return this.apiKey;
	}

	getVaultId(): string | null {
		return this.vaultId;
	}

	isAuthenticated(): boolean {
		return this.apiKey.length > 0;
	}

	signOut(): void {
		this.apiKey = "";
		this.vaultId = null;
	}
}

/** OAuth token manager with automatic refresh and rotation. */
export class OAuthAuth implements AuthProvider {
	private refreshToken: string;
	private vaultId: string | null;
	private userEmail: string | null;
	private accessToken: string | null = null;
	private expiresAt = 0;
	private refreshFn: RefreshFn;
	private authenticated = true;

	/** Buffer in ms — refresh if token expires within this window. */
	private static EXPIRY_BUFFER_MS = 60_000;

	constructor(
		refreshToken: string,
		vaultId: string | null,
		userEmail: string | null,
		refreshFn: RefreshFn,
	) {
		this.refreshToken = refreshToken;
		this.vaultId = vaultId;
		this.userEmail = userEmail;
		this.refreshFn = refreshFn;
	}

	async getToken(): Promise<string> {
		if (this.accessToken && this.expiresAt > Date.now() + OAuthAuth.EXPIRY_BUFFER_MS) {
			return this.accessToken;
		}

		try {
			const result = await this.refreshFn(this.refreshToken);
			this.accessToken = result.access_token;
			this.refreshToken = result.refresh_token;
			this.expiresAt = Date.now() + result.expires_in * 1000;
			this.authenticated = true;
			return this.accessToken;
		} catch (err) {
			this.authenticated = false;
			this.accessToken = null;
			this.expiresAt = 0;
			throw err;
		}
	}

	getVaultId(): string | null {
		return this.vaultId;
	}

	getUserEmail(): string | null {
		return this.userEmail;
	}

	getRefreshToken(): string {
		return this.refreshToken;
	}

	isAuthenticated(): boolean {
		return this.authenticated;
	}

	signOut(): void {
		this.accessToken = null;
		this.refreshToken = "";
		this.expiresAt = 0;
		this.authenticated = false;
		this.vaultId = null;
		this.userEmail = null;
	}
}
