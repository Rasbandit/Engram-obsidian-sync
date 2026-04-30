import { beforeEach, describe, expect, jest, mock, test } from "bun:test";
import type { EngramApi } from "../src/api";
import type { VaultInfo } from "../src/types";

const mockVaults: VaultInfo[] = [
	{
		id: 1,
		name: "Personal",
		slug: "personal",
		is_default: true,
		created_at: "2026-01-01T00:00:00Z",
	},
	{ id: 2, name: "Work", slug: "work", is_default: false, created_at: "2026-02-01T00:00:00Z" },
];

const mockRequest = mock().mockResolvedValue({
	json: { vaults: mockVaults },
});

describe("EngramApi.listVaults", () => {
	test("returns vault list from GET /vaults", async () => {
		const { EngramApi } = await import("../src/api");
		const api = new EngramApi("http://localhost:4000/api");
		(api as any).request = mockRequest;

		const vaults = await api.listVaults();

		expect(mockRequest).toHaveBeenCalledWith("GET", "/vaults");
		expect(vaults).toHaveLength(2);
		expect(vaults[0].name).toBe("Personal");
		expect(vaults[1].is_default).toBe(false);
	});

	test("rethrows underlying error so callers can distinguish auth/network/5xx", async () => {
		const { EngramApi } = await import("../src/api");
		const api = new EngramApi("http://localhost:4000/api");
		const err = Object.assign(new Error("Unauthorized"), { status: 401 });
		(api as any).request = mock().mockRejectedValue(err);

		await expect(api.listVaults()).rejects.toMatchObject({ status: 401 });
	});
});
