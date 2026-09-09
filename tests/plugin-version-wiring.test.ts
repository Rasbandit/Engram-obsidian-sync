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

/** The body of `async onload()`, up to the NEXT top-level member.
 *
 *  Not `onunload` — that is 858 lines and three methods further on
 *  (`handleSyncError`, `healingVault`, `healDeadVault` all sit between), so
 *  slicing to it made "appears in onload" mean "appears anywhere in a
 *  three-method window". Moving the call into `healDeadVault` — reached only
 *  on a dead-vault error — kept the naive version green.
 *
 *  The boundary is therefore the first top-level member AFTER the opening: a
 *  line at exactly one tab of indent that declares something. If that regex
 *  stops matching, the slice runs long and the tests get WEAKER silently, so
 *  the length is asserted too. */
function onloadBody(source: string): string {
	const start = source.indexOf("async onload(): Promise<void> {");
	expect(start).toBeGreaterThan(-1);
	const rest = source.slice(start + 1);
	const next = rest.search(/\n\t(?:private |readonly |async |@)?\w+[<(:]/);
	expect(next).toBeGreaterThan(-1);
	const body = rest.slice(0, next);
	// onload really is ~772 lines and ends at `private handleSyncError`. The
	// naive boundary (`onunload`) ran ~858 lines further, swallowing
	// handleSyncError, healingVault and healDeadVault — so a call relocated
	// into healDeadVault, reached only on a dead-vault error, still "appeared
	// in onload". Naming the two methods that must NOT be in scope fails
	// loudly if the boundary drifts, which a line count alone would not.
	// Their DECLARATIONS, not their names — `onload` legitimately calls both.
	expect(body).not.toContain("private handleSyncError(");
	expect(body).not.toContain("private async healDeadVault(");
	return body;
}

/** A call must be LIVE: at method-body indent, not commented out, not nested
 *  inside a conditional. `toContain` matched `// setPluginVersion(...)` and
 *  `if (DEV_MODE) setPluginVersion(...)` — both of which leave the feature
 *  completely inert on a production install while all four tests pass. */
function callsAtTopLevel(body: string, call: string): boolean {
	return body.split("\n").some((l) => l === `\t\t${call}`);
}

describe("onload wiring", () => {
	test("reports the manifest version, not a hardcoded string", () => {
		expect(callsAtTopLevel(onloadBody(main), "setPluginVersion(this.manifest.version);")).toBe(
			true,
		);
	});

	test("wires the upgrade action so the notice has a working button", () => {
		expect(
			callsAtTopLevel(
				onloadBody(main),
				"setUpgradeAction(() => this.openCommunityPluginsUpdate());",
			),
		).toBe(true);
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
