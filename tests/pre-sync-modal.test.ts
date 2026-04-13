import { describe, expect, test } from "bun:test";
import { formatPlanSummary } from "../src/pre-sync-modal";
import type { SyncPlan } from "../src/types";

function makePlan(overrides: Partial<SyncPlan> = {}): SyncPlan {
	return {
		vaultName: "Personal Notes",
		serverNoteCount: 312,
		localNoteCount: 472,
		localAttachmentCount: 67,
		toPush: { notes: [], attachments: [] },
		toPull: { notes: [], attachments: [] },
		conflicts: [],
		toDeleteLocal: [],
		toDeleteRemote: [],
		...overrides,
	};
}

describe("formatPlanSummary", () => {
	test("shows vault name and counts", () => {
		const lines = formatPlanSummary(makePlan());
		expect(lines).toContain("Vault: Personal Notes");
		expect(lines).toContain("Server: 312 notes · Local: 472 notes");
	});

	test("shows push counts", () => {
		const plan = makePlan({
			toPush: { notes: ["a.md", "b.md"], attachments: ["img.png"] },
		});
		const lines = formatPlanSummary(plan);
		expect(lines).toContain("↑  2 notes to push");
		expect(lines).toContain("↑  1 attachment to push");
	});

	test("shows pull counts", () => {
		const plan = makePlan({
			toPull: { notes: ["c.md"], attachments: [] },
		});
		const lines = formatPlanSummary(plan);
		expect(lines).toContain("↓  1 note to pull");
	});

	test("shows conflict and deletion counts", () => {
		const plan = makePlan({
			conflicts: ["x.md", "y.md"],
			toDeleteLocal: ["z.md"],
		});
		const lines = formatPlanSummary(plan);
		expect(lines).toContain("⚡  2 conflicts");
		expect(lines).toContain("✕  1 deletion");
	});

	test("pluralizes correctly", () => {
		const single = makePlan({ toPush: { notes: ["a.md"], attachments: [] } });
		expect(formatPlanSummary(single)).toContain("1 note to push");

		const multi = makePlan({ toPush: { notes: ["a.md", "b.md"], attachments: [] } });
		expect(formatPlanSummary(multi)).toContain("2 notes to push");
	});

	test("shows zero counts with 0", () => {
		const lines = formatPlanSummary(makePlan());
		expect(lines).toContain("↑  0 notes to push");
		expect(lines).toContain("↓  0 notes to pull");
		expect(lines).toContain("⚡  0 conflicts");
		expect(lines).toContain("✕  0 deletions");
	});
});
