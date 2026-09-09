/**
 * upgrade-required.ts — the client half of the backend's minimum-plugin-version
 * floor.
 *
 * The server refuses a plugin older than its floor: HTTP `426` on REST, and a
 * `plugin_upgrade_required` reason on a channel join. Both are terminal —
 * retrying cannot clear them and every transport is refused at once — so the
 * user has to be told, or they watch sync fail forever with no explanation.
 *
 * ## Why the server's `update_url` is ignored
 *
 * The 426 body carries one, and this module deliberately does not read it.
 * `api.ts`'s `sanitizeUpgradeUrl` already refuses any non-http(s) URL from a
 * 402 body precisely because a malicious self-host backend must not be able to
 * launch arbitrary protocol handlers — and the natural update target here IS a
 * non-http scheme (`obsidian://`). Rather than carve an exception into that
 * rule, the action is supplied locally by `main.ts` via `setUpgradeAction`.
 * The server field stays useful to other clients; this one never trusts it.
 *
 * ## Once per session
 *
 * Every refused request and every reconnect would otherwise toast. The latch
 * clears only on plugin reload, which is also when a freshly-installed version
 * would take effect.
 *
 * ponytail: does NOT stop sync. The server already refuses everything, so a
 * local kill switch would only duplicate that at the cost of a second piece of
 * state to get wrong. Add one if the reconnect traffic ever shows up as load.
 *
 * What that actually looks like on the wire, since "does not stop sync" sounds
 * busier than it is: Phoenix does not close a socket on a join error, so a
 * refused client keeps ONE open socket. `sync:` and `crdt:` are refused,
 * `user:` still joins (no version gate on `check_not_deleted/1`), and the 30s
 * heartbeat keeps the connection alive — so `onclose` never fires and the
 * `crdtJoinFailedReason` backoff in `channel.ts` is never reached. The client
 * idles with `connected === false` rather than retry-storming. Nothing watches
 * that flag today.
 */
import { Notice } from "obsidian";
import { rlog } from "./remote-log";

const NOTICE_MS = 15_000;

let notified = false;
let openUpdateUi: (() => void) | null = null;

/**
 * Supply the "take me there" action. `main.ts` passes its
 * `openCommunityPluginsUpdate`, which opens Obsidian's Community plugins tab
 * and refreshes its update check — the same path the soft update nudge uses,
 * already feature-detected against Obsidian internals.
 *
 * Unset (tests, or a load order that never got here) degrades to a Notice with
 * no link, never a throw.
 */
export function setUpgradeAction(fn: (() => void) | null): void {
	openUpdateUi = fn;
}

/** Tell the user their plugin is too old. First call wins; the rest are no-ops. */
export function notifyUpgradeRequired(minVersion: string | null): void {
	if (notified) return;
	notified = true;

	rlog().warn(
		"lifecycle",
		`server requires plugin >= ${minVersion ?? "unknown"} — sync refused until updated`,
	);

	const needs = minVersion ? ` (needs ${minVersion} or newer)` : "";
	const notice = new Notice(
		`Engram: this plugin is too old to sync${needs}. Update it to continue.`,
		NOTICE_MS,
	);

	// No action wired = no button. A button that does nothing is worse than
	// prose telling the user to go update.
	const action = openUpdateUi;
	if (!action) return;
	const noticeEl = (notice as unknown as { noticeEl?: HTMLElement }).noticeEl;
	if (!noticeEl) return;
	// "Update", never "Upgrade" — the 402 toast next door uses "Upgrade" for
	// paying more money, and these two must not read as the same action.
	const btn = noticeEl.createEl("button", {
		text: "Update",
		cls: "engram-limit-upgrade-btn",
	});
	btn.addEventListener("click", () => action());
}

/** True once the server has refused us for being too old. */
export function isUpgradeRequired(): boolean {
	return notified;
}

/** Test seam. The latch is otherwise per-process by design. */
export function resetUpgradeRequired(): void {
	notified = false;
	openUpdateUi = null;
}
