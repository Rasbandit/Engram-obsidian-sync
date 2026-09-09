/**
 * The running plugin's version, reported to the backend on every REST call
 * that goes through `EngramApi` (`X-Plugin-Version`) and every socket connect
 * (`plugin_version`).
 *
 * Several network paths do NOT carry it, all correctly:
 *
 *   - token refresh (`main.ts`) and the two device-flow calls
 *     (`device-flow-modal.ts`) — these MUST stay exempt, or a client refused
 *     for being too old cannot link or refresh a token and the only way out of
 *     the block is a reinstall;
 *   - `device-flow-socket.ts`, which opens `/socket/device/websocket` with no
 *     `plugin_version` param, for the same reason;
 *   - `EngramApi.probeHealth` (static, no instance) and `EngramApi.health()`
 *     (an instance method that calls `requestUrl` directly rather than through
 *     `sendRequest`) — `/health` is public and ungated;
 *   - the beacon's raw `window.fetch` (`observability/beacon.ts`);
 *   - `update-check.ts`, which fetches the published manifest from GitHub.
 *
 * The list is worth keeping accurate: an earlier version said "every REST
 * call" and then "five paths", and both were wrong. Grep `requestUrl(`,
 * `fetch(` and `new WebSocket` before trusting it.
 *
 * The backend refuses clients below a floor it ships as a constant — see
 * `Engram.PluginVersion`. Reporting is what makes that floor enforceable AND
 * what makes the installed-base distribution visible in the `ws connect` log.
 * That log is the version signal with the best COVERAGE, not the only one:
 * `remote-log.ts` sends the same value on every client log entry and the
 * backend stores it as an indexed column, but only when the user has enabled
 * diagnostics — so it under-counts exactly the disengaged installs a floor
 * decision most needs to see.
 *
 * A module singleton rather than a constructor parameter because the version
 * is fixed for the process and needed in two unrelated transports; threading
 * it would mean a sixth positional argument on `NoteChannel`'s constructor
 * AND on `updateConfig`. Set once from `manifest.version` in `onload`.
 *
 * Unset reads as "" and is OMITTED from the wire, not sent as an empty value.
 * The backend allows anything it cannot parse, so an empty string would work
 * too — but omission keeps "never reported" and "reported garbage" distinct in
 * the logs, and those need different responses.
 */
let version = "";

export function setPluginVersion(v: string): void {
	version = v;
}

/** "" until `setPluginVersion` runs. Callers must omit the field when empty. */
export function pluginVersion(): string {
	return version;
}
