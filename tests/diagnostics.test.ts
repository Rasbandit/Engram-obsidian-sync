import { formatVaultEvent } from "../src/diagnostics";
import { __resetNoteRefs, noteRef } from "../src/note-ref";

beforeEach(() => __resetNoteRefs());

test("formats a metadata-only line, interpolating the opaque ref verbatim", () => {
	const ref = noteRef("Notes/a.md");
	const line = formatVaultEvent("modify", ref, { bytes: 42 });
	expect(line).toBe(`modify path=${ref} bytes=42`);
	expect(line).toContain("bytes=42");
});

test("the ref emitted for a path never contains the cleartext title", () => {
	const line = formatVaultEvent("modify", noteRef("Medical/Secret Title.md"), { bytes: 1 });
	expect(line).not.toContain("Secret Title");
	expect(line).not.toContain("Medical/");
});

test("same path yields the same ref within a session — activity correlates", () => {
	expect(noteRef("a/b.md")).toBe(noteRef("a/b.md"));
});

test("distinct paths yield distinct refs", () => {
	expect(noteRef("a.md")).not.toBe(noteRef("b.md"));
});

test("rename carries both refs, neither leaking cleartext", () => {
	const line = formatVaultEvent("rename", noteRef("new/name.md"), {
		from: noteRef("old/name.md"),
	});
	expect(line).toContain("path=");
	expect(line).toContain("from=");
	expect(line).not.toContain("new/name");
	expect(line).not.toContain("old/name");
});
