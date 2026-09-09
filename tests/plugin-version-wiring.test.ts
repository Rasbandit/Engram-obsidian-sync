/**
 * Compliance test: the version floor's `onload` wiring.
 *
 * Everything else about this feature is unit-tested by calling
 * `setPluginVersion` / `setUpgradeAction` directly. That leaves the one line
 * production actually depends on covered by nothing: delete
 * `setPluginVersion(this.manifest.version)` from `onload` and every other test
 * stays green while the feature goes 100% inert — no header, no socket param,
 * so no floor and no notice, on every install.
 *
 * Booting `onload` in a test would need most of Obsidian. Scanning the source
 * is the cheap guard that still fails for the thing that actually breaks, and
 * matches the existing compliance tests in this directory
 * (`command-ids.test.ts`, `manifest-compliance.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");

/** The body of `async onload()`, up to the next top-level method. */
function onloadBody(source: string): string {
	const start = source.indexOf("async onload(): Promise<void> {");
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("\n\tonunload(): void {", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("onload wiring", () => {
	test("reports the manifest version, not a hardcoded string", () => {
		expect(onloadBody(main)).toContain("setPluginVersion(this.manifest.version)");
	});

	test("wires the upgrade action so the notice has a working button", () => {
		expect(onloadBody(main)).toContain("setUpgradeAction(");
	});

	// Both transports read the version lazily, so a late set means the first
	// requests of a launch go out unversioned and are silently exempt from the
	// floor. It must precede anything that can reach the network.
	test("sets the version before the api client is constructed", () => {
		const body = onloadBody(main);
		const set = body.indexOf("setPluginVersion(");
		const api = body.indexOf("new EngramApi(");

		expect(set).toBeGreaterThan(-1);
		expect(api).toBeGreaterThan(-1);
		expect(set).toBeLessThan(api);
	});

	// Module-level closure over the instance being unloaded — the same rule
	// uninstallDebugApi states for the debug global.
	test("releases the upgrade action on unload", () => {
		expect(main).toContain("setUpgradeAction(null)");
	});
});
