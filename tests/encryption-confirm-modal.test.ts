import { describe, expect, test } from "bun:test";
import { describeAction, isConfirmInputValid } from "../src/encryption-confirm-modal";

describe("isConfirmInputValid", () => {
	test("rejects empty input", () => {
		expect(isConfirmInputValid("", "Personal")).toBe(false);
	});

	test("rejects whitespace-only input", () => {
		expect(isConfirmInputValid("   ", "Personal")).toBe(false);
	});

	test("rejects mismatched input", () => {
		expect(isConfirmInputValid("personal", "Personal")).toBe(false);
		expect(isConfirmInputValid("Personals", "Personal")).toBe(false);
	});

	test("accepts exact match", () => {
		expect(isConfirmInputValid("Personal", "Personal")).toBe(true);
	});

	test("accepts match with surrounding whitespace", () => {
		expect(isConfirmInputValid("  Personal  ", "Personal")).toBe(true);
	});

	test("is case-sensitive", () => {
		expect(isConfirmInputValid("PERSONAL", "Personal")).toBe(false);
	});
});

describe("describeAction", () => {
	test("encrypt copy mentions encryption + vault name", () => {
		const copy = describeAction("encrypt", "Notes");
		expect(copy.title).toContain("encryption");
		expect(copy.body.join(" ")).toContain("Notes");
		expect(copy.confirmLabel).toBe("Encrypt vault");
		expect(copy.confirmClass).toBe("mod-cta");
	});

	test("decrypt copy mentions 24h delay + cooldown warning", () => {
		const copy = describeAction("decrypt", "Notes");
		expect(copy.body.join(" ")).toContain("24 hours");
		expect(copy.body.join(" ").toLowerCase()).toContain("cooldown");
		expect(copy.confirmClass).toBe("engram-btn-danger-solid");
	});

	test("cancel-decrypt copy is short and non-destructive", () => {
		const copy = describeAction("cancel-decrypt", "Notes");
		expect(copy.title.toLowerCase()).toContain("cancel");
		expect(copy.confirmClass).toBe("mod-cta");
	});
});
