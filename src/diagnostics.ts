/**
 * Verbose diagnostic firehose. Emits metadata-only log lines for vault and
 * workspace activity so a WS "blip" can be reconstructed from the client side.
 * NEVER logs note content OR cleartext paths: every path is routed through
 * `noteRef()` (the opaque per-session counter used by the other ~94 log sites)
 * before it leaves the device, so a folder/title never reaches client_logs /
 * CloudWatch / Loki. The ref is stable within a session, so "same note modified
 * N times" still correlates and a rename shows two distinct refs. Only the ref,
 * event kind, byte counts, and timing are emitted. Gated by the single
 * diagnosticsEnabled setting.
 */
import { type App, TFile, TFolder } from "obsidian";
import { noteRef } from "./note-ref";
import { rlog } from "./remote-log";

type EventKind = "modify" | "create" | "delete" | "rename" | "file-open" | "leaf-change";

// `ref` and any path-valued `extra` (e.g. rename's `from`) are already opaque
// noteRef tokens by the time they reach here — see the emit sites below. This
// only formats; it never sees a cleartext path, so there is no path-key
// denylist to keep in sync.
export function formatVaultEvent(
	kind: EventKind,
	ref: string,
	extra?: Record<string, string | number>,
): string {
	const parts = [`${kind}`, `path=${ref}`];
	if (extra) {
		for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${v}`);
	}
	return parts.join(" ");
}

interface DiagnosticsHost {
	app: App;
	registerEvent(ref: unknown): void;
	settings: { diagnosticsEnabled: boolean };
}

export function registerDiagnostics(plugin: DiagnosticsHost): void {
	const on = () => plugin.settings.diagnosticsEnabled;
	// `path` is noteRef'd here — the single choke point for the main path — so no
	// call site can forget. Path-valued `extra` values are noteRef'd by their
	// own handler before being passed in.
	const emit = (kind: EventKind, path: string, extra?: Record<string, string | number>) => {
		if (!on()) return;
		rlog().diag("vault", formatVaultEvent(kind, noteRef(path), extra));
	};

	plugin.registerEvent(
		plugin.app.vault.on("modify", (file) => {
			if (file instanceof TFile) emit("modify", file.path, { bytes: file.stat.size });
		}),
	);
	plugin.registerEvent(
		plugin.app.vault.on("create", (file) => {
			if (file instanceof TFile) emit("create", file.path, { bytes: file.stat.size });
		}),
	);
	plugin.registerEvent(
		plugin.app.vault.on("delete", (file) => {
			emit("delete", file.path, { kind: file instanceof TFolder ? "folder" : "file" });
		}),
	);
	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) => {
			emit("rename", file.path, { from: noteRef(oldPath) });
		}),
	);
	plugin.registerEvent(
		plugin.app.workspace.on("file-open", (file) => {
			if (file instanceof TFile) emit("file-open", file.path);
		}),
	);
	plugin.registerEvent(
		plugin.app.workspace.on("active-leaf-change", () => {
			const file = plugin.app.workspace.getActiveFile();
			if (file instanceof TFile) emit("leaf-change", file.path);
		}),
	);
}
