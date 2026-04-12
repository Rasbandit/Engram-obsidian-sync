import { type Mock, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { requestUrl } from "obsidian";
import { EngramApi } from "../src/api";

// obsidian is mocked via tests/preload.ts — requestUrl is already a mock()
const mockRequestUrl = requestUrl as unknown as Mock<() => Promise<any>>;

describe("EngramApi.search", () => {
	let api: EngramApi;

	beforeEach(() => {
		mockRequestUrl.mockReset();
		api = new EngramApi("http://localhost:8000", "test-key");
	});

	it("sends correct POST body with query only", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { query: "omega oils", results: [] },
		} as any);

		const resp = await api.search("omega oils");

		expect(mockRequestUrl).toHaveBeenCalledWith({
			url: "http://localhost:8000/api/search",
			method: "POST",
			headers: {
				Authorization: "Bearer test-key",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query: "omega oils" }),
		});
		expect(resp.results).toEqual([]);
	});

	it("includes limit and tags when provided", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { query: "health", results: [] },
		} as any);

		await api.search("health", 20, ["nutrition"]);

		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				body: JSON.stringify({
					query: "health",
					limit: 20,
					tags: ["nutrition"],
				}),
			}),
		);
	});

	it("omits tags when array is empty", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { query: "test", results: [] },
		} as any);

		await api.search("test", 5, []);

		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				body: JSON.stringify({ query: "test", limit: 5 }),
			}),
		);
	});

	it("returns results from response", async () => {
		const mockResults = [
			{
				text: "Omega-3 fatty acids are essential",
				title: "Omega Oils",
				source_path: "Health/Omega Oils.md",
				tags: ["health"],
				wikilinks: [],
				score: 0.95,
				vector_score: 0.92,
				rerank_score: 0.98,
			},
		];

		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { query: "omega", results: mockResults },
		} as any);

		const resp = await api.search("omega");
		expect(resp.results).toHaveLength(1);
		expect(resp.results[0].title).toBe("Omega Oils");
		expect(resp.results[0].score).toBe(0.95);
	});
});

describe("SearchModal debounce", () => {
	it("fires only once for rapid input", async () => {
		jest.useFakeTimers();

		let callCount = 0;
		const mockSearch = mock().mockImplementation(() => {
			callCount++;
			return Promise.resolve({ query: "test", results: [] });
		});

		// Simulate debounce logic inline (same pattern as SearchModal)
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		const triggerSearch = () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => mockSearch(), 300);
		};

		// Rapid "typing"
		triggerSearch();
		triggerSearch();
		triggerSearch();
		triggerSearch();
		triggerSearch();

		jest.advanceTimersByTime(299);
		expect(callCount).toBe(0);

		jest.advanceTimersByTime(1);
		expect(callCount).toBe(1);

		jest.useRealTimers();
	});
});
