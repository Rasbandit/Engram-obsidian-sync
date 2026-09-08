/**
 * Verbose diagnostic firehose. Emits metadata-only log lines for vault and
 * workspace activity so a WS "blip" can be reconstructed from the client side.
 * NEVER logs note content OR cleartext paths: paths are FNV-1a hashed before
 * they leave the device, so a note title never reaches the backend log. The
 * hash is stable per path, so "same file modified N times" is still visible;
 * a rename shows two distinct hashes. Only the hashed path, event kind, byte
 * counts, and timing are emitted. Gated by the single diagnosticsEnabled
 * setting.
 */
import { type App, TFile, TFolder } from "obsidian";
import { fnv1a } from "./content-hash";
import { rlog } from "./remote-log";

type EventKind = "modify" | "create" | "delete" | "rename" | "file-open" | "leaf-change";

// Stable, non-reversible tag for a vault path. Same path → same tag (so repeat
// activity on one note correlates); a different path → a different tag. FNV-1a
// is not a cryptographic hash, but the goal here is redaction of the cleartext
// title/folder from remote logs, not resistance to a brute-force preimage — a
// path space that small is not protected by any client-side hash, so we buy the
// cheap one and keep the correlation.
export function hashPath(path: string): string {
	return fnv1a(path).toString(16);
}

// Keys in `extra` whose VALUE is itself a cleartext path and must be hashed
// like `path` (e.g. rename's `from` = old path). Everything else (bytes, kind)
// is non-identifying and passes through.
const PATH_VALUED_KEYS = new Set(["from"]);

export function formatVaultEvent(
	kind: EventKind,
	path: string,
	extra?: Record<string, string | number>,
): string {
	const parts = [`${kind}`, `path=${hashPath(path)}`];
	if (extra) {
		for (const [k, v] of Object.entries(extra)) {
			const val = PATH_VALUED_KEYS.has(k) ? hashPath(String(v)) : v;
			parts.push(`${k}=${val}`);
		}
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
	const emit = (kind: EventKind, path: string, extra?: Record<string, string | number>) => {
		if (!on()) return;
		rlog().diag("vault", formatVaultEvent(kind, path, extra));
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
			emit("rename", file.path, { from: oldPath });
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
