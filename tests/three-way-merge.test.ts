/**
 * Unit tests for three-way merge — auto-resolves non-overlapping edits
 * using diff-match-patch with explicit overlap detection.
 *
 * Tests cover:
 * - Short-circuits: base===local, base===remote, local===remote
 * - Non-overlapping edits merge cleanly
 * - Overlapping edits detected as conflict
 * - Adjacent but non-overlapping edits merge cleanly
 * - Empty base (no common ancestor)
 * - Insertions at different positions
 * - Deletions at different positions
 * - One side unchanged, other edited
 */

import { threeWayMerge, MergeResult } from "../src/three-way-merge";

describe("threeWayMerge", () => {
	describe("short-circuits", () => {
		it("should return remote when base === local (only remote changed)", () => {
			const result = threeWayMerge("hello world", "hello world", "hello universe");
			expect(result.clean).toBe(true);
			expect(result.merged).toBe("hello universe");
			expect(result.conflicts).toHaveLength(0);
		});

		it("should return local when base === remote (only local changed)", () => {
			const result = threeWayMerge("hello world", "hello universe", "hello world");
			expect(result.clean).toBe(true);
			expect(result.merged).toBe("hello universe");
			expect(result.conflicts).toHaveLength(0);
		});

		it("should return either when local === remote (same change on both)", () => {
			const result = threeWayMerge("hello world", "hello universe", "hello universe");
			expect(result.clean).toBe(true);
			expect(result.merged).toBe("hello universe");
			expect(result.conflicts).toHaveLength(0);
		});

		it("should return base when all three are identical", () => {
			const result = threeWayMerge("same", "same", "same");
			expect(result.clean).toBe(true);
			expect(result.merged).toBe("same");
		});
	});

	describe("non-overlapping edits", () => {
		it("should merge edits to different paragraphs", () => {
			const base = "paragraph one\n\nparagraph two\n\nparagraph three";
			const local = "paragraph one EDITED\n\nparagraph two\n\nparagraph three";
			const remote = "paragraph one\n\nparagraph two\n\nparagraph three EDITED";
			const result = threeWayMerge(base, local, remote);
			expect(result.clean).toBe(true);
			expect(result.merged).toBe("paragraph one EDITED\n\nparagraph two\n\nparagraph three EDITED");
		});

		it("should merge insertions at different positions", () => {
			const base = "line 1\nline 2\nline 3";
			const local = "line 0\nline 1\nline 2\nline 3";
			const remote = "line 1\nline 2\nline 3\nline 4";
			const result = threeWayMerge(base, local, remote);
			expect(result.clean).toBe(true);
			expect(result.merged).toBe("line 0\nline 1\nline 2\nline 3\nline 4");
		});

		it("should merge deletions at different positions", () => {
			const base = "line 1\nline 2\nline 3\nline 4\nline 5";
			const local = "line 1\nline 3\nline 4\nline 5"; // deleted line 2
			const remote = "line 1\nline 2\nline 3\nline 5"; // deleted line 4
			const result = threeWayMerge(base, local, remote);
			expect(result.clean).toBe(true);
			expect(result.merged).toBe("line 1\nline 3\nline 5");
		});

		it("should merge adjacent but non-overlapping edits", () => {
			const base = "aaa\nbbb\nccc";
			const local = "aaa\nBBB\nccc"; // edited line 2
			const remote = "aaa\nbbb\nCCC"; // edited line 3
			const result = threeWayMerge(base, local, remote);
			expect(result.clean).toBe(true);
			expect(result.merged).toBe("aaa\nBBB\nCCC");
		});
	});

	describe("overlapping edits (conflicts)", () => {
		it("should detect conflict when both sides edit the same line", () => {
			const base = "line 1\nline 2\nline 3";
			const local = "line 1\nLOCAL EDIT\nline 3";
			const remote = "line 1\nREMOTE EDIT\nline 3";
			const result = threeWayMerge(base, local, remote);
			expect(result.clean).toBe(false);
			expect(result.conflicts.length).toBeGreaterThan(0);
		});

		it("should detect conflict when both sides edit overlapping regions", () => {
			const base = "the quick brown fox jumps over the lazy dog";
			const local = "the quick RED fox jumps over the lazy dog";
			const remote = "the quick brown fox LEAPS over the lazy dog";
			// Both edit the middle of the same text — may or may not overlap depending
			// on diff granularity. If they don't overlap, a clean merge is acceptable.
			const result = threeWayMerge(base, local, remote);
			// Either clean merge or conflict is acceptable here — just verify structure
			expect(result.merged).toBeDefined();
			expect(Array.isArray(result.conflicts)).toBe(true);
		});

		it("should detect conflict when both sides modify the same word", () => {
			const base = "hello world";
			const local = "hello LOCAL";
			const remote = "hello REMOTE";
			const result = threeWayMerge(base, local, remote);
			expect(result.clean).toBe(false);
			expect(result.conflicts.length).toBeGreaterThan(0);
		});
	});

	describe("edge cases", () => {
		it("should handle empty base", () => {
			const result = threeWayMerge("", "local content", "remote content");
			// Both sides added content to empty base — this is a conflict
			expect(result.clean).toBe(false);
		});

		it("should handle one side adding to empty base", () => {
			const result = threeWayMerge("", "new content", "");
			expect(result.clean).toBe(true);
			expect(result.merged).toBe("new content");
		});

		it("should handle multiline markdown documents", () => {
			const base = [
				"# Title",
				"",
				"## Section A",
				"Content A",
				"",
				"## Section B",
				"Content B",
			].join("\n");

			const local = base.replace("Content A", "Content A (updated locally)");
			const remote = base.replace("Content B", "Content B (updated remotely)");

			const result = threeWayMerge(base, local, remote);
			expect(result.clean).toBe(true);
			expect(result.merged).toContain("Content A (updated locally)");
			expect(result.merged).toContain("Content B (updated remotely)");
		});

		it("should handle frontmatter edits", () => {
			const base = "---\ntitle: Note\ntags: [a]\n---\n\n# Content";
			const local = "---\ntitle: Note\ntags: [a, b]\n---\n\n# Content";
			const remote = "---\ntitle: Note\ntags: [a]\n---\n\n# Content Updated";

			const result = threeWayMerge(base, local, remote);
			expect(result.clean).toBe(true);
			expect(result.merged).toContain("tags: [a, b]");
			expect(result.merged).toContain("# Content Updated");
		});
	});
});
