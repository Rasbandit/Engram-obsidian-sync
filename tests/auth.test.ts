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
});
