/**
 * The running plugin's version, reported to the backend on every REST call
 * (`X-Plugin-Version`) and every socket connect (`plugin_version`).
 *
 * The backend refuses clients below a floor it ships as a constant — see
 * `Engram.PluginVersion`. Reporting is what makes that floor enforceable AND
 * what makes the installed-base distribution visible in the `ws connect` log,
 * which is the only signal that says whether raising the floor is safe.
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
