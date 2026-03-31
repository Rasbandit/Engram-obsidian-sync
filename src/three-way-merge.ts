/**
 * Three-way merge using diff-match-patch with explicit overlap detection.
 *
 * Instead of using dmp's patch_apply (which uses fuzzy matching and can
 * silently produce incorrect merges), we:
 * 1. Compute diff(base, local) and diff(base, remote) to get edit ranges
 * 2. Check if any edit ranges overlap between the two sides
 * 3. If no overlaps → apply both edit sets to produce merged output
 * 4. If overlaps → report conflict regions
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DiffMatchPatch = require("diff-match-patch");

const dmp = new DiffMatchPatch() as InstanceType<typeof import("diff-match-patch")>;

export interface ConflictRegion {
	/** Character offset in base where the conflict starts. */
	baseStart: number;
	/** Character offset in base where the conflict ends. */
	baseEnd: number;
	localText: string;
	remoteText: string;
}

export interface MergeResult {
	merged: string;
	/** true = no overlapping edits, merge is safe. */
	clean: boolean;
	conflicts: ConflictRegion[];
}

/** An edit range relative to the base text. */
interface EditRange {
	/** Start offset in base (inclusive). */
	start: number;
	/** End offset in base (exclusive). */
	end: number;
	/** Replacement text (what this side changed the range to). */
	replacement: string;
}

/** Extract edit ranges from a diff (relative to base). */
function diffToRanges(diffs: [number, string][]): EditRange[] {
	const ranges: EditRange[] = [];
	let baseOffset = 0;

	for (const [op, text] of diffs) {
		if (op === 0 /* DIFF_EQUAL */) {
			baseOffset += text.length;
		} else if (op === -1 /* DIFF_DELETE */) {
			// Look ahead for an adjacent insert (replace = delete + insert)
			ranges.push({
				start: baseOffset,
				end: baseOffset + text.length,
				replacement: "",
			});
			baseOffset += text.length;
		} else if (op === 1 /* DIFF_INSERT */) {
			// Pure insertion at current base offset
			ranges.push({
				start: baseOffset,
				end: baseOffset,
				replacement: text,
			});
		}
	}

	// Merge adjacent delete+insert into a single replace range
	const merged: EditRange[] = [];
	for (const range of ranges) {
		const prev = merged[merged.length - 1];
		if (prev && prev.end === range.start && range.start === range.end) {
			// Insert immediately after a delete at the same position → merge
			prev.replacement += range.replacement;
		} else if (prev && prev.start === prev.end && prev.start === range.start) {
			// Previous was insert at same position, current is delete → merge
			prev.end = range.end;
			prev.replacement += range.replacement;
		} else {
			merged.push({ ...range });
		}
	}

	return merged;
}

/** Check if two ranges overlap (exclusive boundaries). */
function rangesOverlap(a: EditRange, b: EditRange): boolean {
	// Two ranges overlap if neither is entirely before the other.
	// Pure insertions at the same point are considered overlapping
	// (both sides inserting at the same position).
	if (a.start === a.end && b.start === b.end && a.start === b.start) {
		return true; // Both inserting at same position
	}
	if (a.start === a.end) {
		// a is a pure insertion — overlaps with b if insertion point is inside b
		return a.start > b.start && a.start < b.end;
	}
	if (b.start === b.end) {
		// b is a pure insertion — overlaps with a if insertion point is inside a
		return b.start > a.start && b.start < a.end;
	}
	// Both are ranges with length — standard interval overlap
	return a.start < b.end && b.start < a.end;
}

export function threeWayMerge(base: string, local: string, remote: string): MergeResult {
	// Short-circuits
	if (base === local) return { merged: remote, clean: true, conflicts: [] };
	if (base === remote) return { merged: local, clean: true, conflicts: [] };
	if (local === remote) return { merged: local, clean: true, conflicts: [] };

	const localDiffs = dmp.diff_main(base, local);
	const remoteDiffs = dmp.diff_main(base, remote);
	dmp.diff_cleanupSemantic(localDiffs);
	dmp.diff_cleanupSemantic(remoteDiffs);

	const localRanges = diffToRanges(localDiffs);
	const remoteRanges = diffToRanges(remoteDiffs);

	// Check for overlapping edit ranges
	const conflicts: ConflictRegion[] = [];
	for (const lr of localRanges) {
		for (const rr of remoteRanges) {
			if (rangesOverlap(lr, rr)) {
				conflicts.push({
					baseStart: Math.min(lr.start, rr.start),
					baseEnd: Math.max(lr.end, rr.end),
					localText: lr.replacement,
					remoteText: rr.replacement,
				});
			}
		}
	}

	if (conflicts.length > 0) {
		// Return remote as the "merged" fallback (caller decides what to do)
		return { merged: remote, clean: false, conflicts };
	}

	// No overlaps — apply both edit sets to base.
	// Combine all ranges, sort by base offset descending, apply from end to start
	// so earlier offsets aren't shifted by later edits.
	const allRanges = [
		...localRanges.map((r) => ({ ...r, source: "local" as const })),
		...remoteRanges.map((r) => ({ ...r, source: "remote" as const })),
	];
	allRanges.sort((a, b) => {
		if (a.start !== b.start) return b.start - a.start; // descending by start
		return b.end - a.end; // if same start, longer range first
	});

	let result = base;
	for (const range of allRanges) {
		result = result.slice(0, range.start) + range.replacement + result.slice(range.end);
	}

	return { merged: result, clean: true, conflicts: [] };
}
