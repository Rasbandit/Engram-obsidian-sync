import { formatVaultEvent, hashPath } from "../src/diagnostics";

test("hashes the path — cleartext title never appears in the line", () => {
	const line = formatVaultEvent("modify", "Notes/Secret Title.md", { bytes: 42 });
	expect(line).toBe(`modify path=${hashPath("Notes/Secret Title.md")} bytes=42`);
	expect(line).not.toContain("Secret Title");
	expect(line).not.toContain("Notes/");
	expect(line).toContain("bytes=42");
});

test("same path hashes stably — repeat activity on one note correlates", () => {
	const a = formatVaultEvent("modify", "a/b.md", { bytes: 1 });
	const b = formatVaultEvent("modify", "a/b.md", { bytes: 2 });
	expect(a.split(" ")[1]).toBe(b.split(" ")[1]);
});

test("rename hashes both new and old path — neither leaks cleartext", () => {
	const line = formatVaultEvent("rename", "new/name.md", { from: "old/name.md" });
	expect(line).toContain(`path=${hashPath("new/name.md")}`);
	expect(line).toContain(`from=${hashPath("old/name.md")}`);
	expect(line).not.toContain("new/name");
	expect(line).not.toContain("old/name");
});

test("distinct paths hash distinctly", () => {
	expect(hashPath("a.md")).not.toBe(hashPath("b.md"));
});
