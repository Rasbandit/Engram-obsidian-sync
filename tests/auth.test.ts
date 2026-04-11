import { ApiKeyAuth, OAuthAuth } from "../src/auth";

describe("ApiKeyAuth", () => {
	it("returns the API key as token", async () => {
		const auth = new ApiKeyAuth("engram_test123", "vault-1");
		expect(await auth.getToken()).toBe("engram_test123");
	});

	it("reports authenticated when key is set", () => {
		const auth = new ApiKeyAuth("engram_test123", "vault-1");
		expect(auth.isAuthenticated()).toBe(true);
	});

	it("reports not authenticated when key is empty", () => {
		const auth = new ApiKeyAuth("", null);
		expect(auth.isAuthenticated()).toBe(false);
	});

	it("returns vault ID", () => {
		const auth = new ApiKeyAuth("engram_test123", "vault-1");
		expect(auth.getVaultId()).toBe("vault-1");
	});

	it("clears state on sign out", () => {
		const auth = new ApiKeyAuth("engram_test123", "vault-1");
		auth.signOut();
		expect(auth.isAuthenticated()).toBe(false);
	});
});

describe("OAuthAuth", () => {
	const mockRefreshFn = jest.fn();

	beforeEach(() => {
		mockRefreshFn.mockReset();
	});

	it("refreshes on first getToken call", async () => {
		mockRefreshFn.mockResolvedValue({
			access_token: "jwt_123",
			refresh_token: "engram_rt_new",
			expires_in: 3600,
		});

		const auth = new OAuthAuth("engram_rt_old", "vault-1", "user@test.com", mockRefreshFn);
		const token = await auth.getToken();

		expect(token).toBe("jwt_123");
		expect(mockRefreshFn).toHaveBeenCalledWith("engram_rt_old");
	});

	it("returns cached token when not expired", async () => {
		mockRefreshFn.mockResolvedValue({
			access_token: "jwt_123",
			refresh_token: "engram_rt_new",
			expires_in: 3600,
		});

		const auth = new OAuthAuth("engram_rt_old", "vault-1", "user@test.com", mockRefreshFn);
		await auth.getToken();
		mockRefreshFn.mockClear();

		const token = await auth.getToken();
		expect(token).toBe("jwt_123");
		expect(mockRefreshFn).not.toHaveBeenCalled();
	});

	it("refreshes when token is about to expire", async () => {
		mockRefreshFn
			.mockResolvedValueOnce({
				access_token: "jwt_first",
				refresh_token: "engram_rt_second",
				expires_in: 30, // expires in 30s, below 60s buffer
			})
			.mockResolvedValueOnce({
				access_token: "jwt_second",
				refresh_token: "engram_rt_third",
				expires_in: 3600,
			});

		const auth = new OAuthAuth("engram_rt_old", "vault-1", "user@test.com", mockRefreshFn);
		await auth.getToken(); // first call, gets jwt_first but it's expiring soon

		const token = await auth.getToken(); // should refresh
		expect(token).toBe("jwt_second");
		expect(mockRefreshFn).toHaveBeenCalledTimes(2);
	});

	it("sets isAuthenticated to false on refresh failure", async () => {
		mockRefreshFn.mockRejectedValue(new Error("401"));

		const auth = new OAuthAuth("engram_rt_old", "vault-1", "user@test.com", mockRefreshFn);

		await expect(auth.getToken()).rejects.toThrow("401");
		expect(auth.isAuthenticated()).toBe(false);
	});

	it("clears state on sign out", async () => {
		mockRefreshFn.mockResolvedValue({
			access_token: "jwt_123",
			refresh_token: "engram_rt_new",
			expires_in: 3600,
		});

		const auth = new OAuthAuth("engram_rt_old", "vault-1", "user@test.com", mockRefreshFn);
		await auth.getToken();
		auth.signOut();

		expect(auth.isAuthenticated()).toBe(false);
		expect(auth.getVaultId()).toBeNull();
	});

	it("updates refresh token after rotation", async () => {
		mockRefreshFn.mockResolvedValue({
			access_token: "jwt_123",
			refresh_token: "engram_rt_rotated",
			expires_in: 3600,
		});

		const auth = new OAuthAuth("engram_rt_old", "vault-1", "user@test.com", mockRefreshFn);
		await auth.getToken();

		expect(auth.getRefreshToken()).toBe("engram_rt_rotated");
	});

	it("deduplicates concurrent refresh calls (race condition)", async () => {
		let callCount = 0;
		const slowRefresh = jest.fn(async (_token: string) => {
			callCount++;
			// Simulate network delay so concurrent calls overlap
			await new Promise((r) => setTimeout(r, 50));
			return {
				access_token: `jwt_${callCount}`,
				refresh_token: `engram_rt_${callCount}`,
				expires_in: 3600,
			};
		});

		const auth = new OAuthAuth("engram_rt_old", "vault-1", "user@test.com", slowRefresh);

		// Fire 5 concurrent getToken() calls — simulates plugin startup
		const results = await Promise.all([
			auth.getToken(),
			auth.getToken(),
			auth.getToken(),
			auth.getToken(),
			auth.getToken(),
		]);

		// Only ONE refresh call should have been made
		expect(slowRefresh).toHaveBeenCalledTimes(1);
		// All callers get the same token
		expect(new Set(results).size).toBe(1);
	});

	it("calls onTokenRotated callback after successful refresh", async () => {
		mockRefreshFn.mockResolvedValue({
			access_token: "jwt_123",
			refresh_token: "engram_rt_new",
			expires_in: 3600,
		});

		const onRotated = jest.fn();
		const auth = new OAuthAuth(
			"engram_rt_old",
			"vault-1",
			"user@test.com",
			mockRefreshFn,
			onRotated,
		);
		await auth.getToken();

		expect(onRotated).toHaveBeenCalledWith("engram_rt_new");
	});

	it("does not call onTokenRotated on refresh failure", async () => {
		mockRefreshFn.mockRejectedValue(new Error("401"));

		const onRotated = jest.fn();
		const auth = new OAuthAuth(
			"engram_rt_old",
			"vault-1",
			"user@test.com",
			mockRefreshFn,
			onRotated,
		);

		await expect(auth.getToken()).rejects.toThrow("401");
		expect(onRotated).not.toHaveBeenCalled();
	});

	it("retries refresh after a failed attempt (not permanently stuck)", async () => {
		mockRefreshFn.mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce({
			access_token: "jwt_recovered",
			refresh_token: "engram_rt_recovered",
			expires_in: 3600,
		});

		const auth = new OAuthAuth("engram_rt_old", "vault-1", "user@test.com", mockRefreshFn);

		await expect(auth.getToken()).rejects.toThrow("network error");
		expect(auth.isAuthenticated()).toBe(false);

		// Second attempt should try again, not stay stuck
		const token = await auth.getToken();
		expect(token).toBe("jwt_recovered");
		expect(auth.isAuthenticated()).toBe(true);
	});
});
