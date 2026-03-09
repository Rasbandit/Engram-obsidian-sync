/**
 * Conflict resolution modal — git-like diff view with hunk-level picking,
 * unified/side-by-side toggle, and an editable merge result pane.
 */
import { App, Modal } from "obsidian";
import { ConflictInfo, ConflictResolution, EngramSyncSettings } from "./types";
import { computeDiff, groupIntoHunks, buildMergedContent, DiffHunk, DiffLine } from "./diff";

export class ConflictModal extends Modal {
	private resolvePromise: (result: ConflictResolution) => void = () => {};
	private info: ConflictInfo;
	private settings: EngramSyncSettings;
	private onViewModeChange: (mode: "unified" | "side-by-side") => void;

	private diffLines: DiffLine[] = [];
	private hunks: DiffHunk[] = [];
	private mergeEditor: HTMLTextAreaElement | null = null;
	private diffContainer: HTMLElement | null = null;
	private viewMode: "unified" | "side-by-side";

	constructor(
		app: App,
		info: ConflictInfo,
		settings: EngramSyncSettings,
		onViewModeChange: (mode: "unified" | "side-by-side") => void,
	) {
		super(app);
		this.info = info;
		this.settings = settings;
		this.viewMode = settings.conflictViewMode;
		this.onViewModeChange = onViewModeChange;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass("engram-conflict");
		modalEl.addClass("engram-conflict-modal");

		// Compute diff
		this.diffLines = computeDiff(this.info.localContent, this.info.remoteContent);
		this.hunks = groupIntoHunks(this.diffLines);

		this.renderHeader(contentEl);
		this.renderToolbar(contentEl);

		this.diffContainer = contentEl.createEl("section", { cls: "engram-conflict-diff" });
		this.renderDiff();

		this.renderMergeEditor(contentEl);
		this.renderActions(contentEl);
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolvePromise({ choice: "skip" });
	}

	waitForChoice(): Promise<ConflictResolution> {
		return new Promise((resolve) => {
			this.resolvePromise = (result) => {
				this.resolvePromise = () => {};
				resolve(result);
			};
			this.open();
		});
	}

	// ── Header ──────────────────────────────────────────────────────

	private renderHeader(root: HTMLElement): void {
		const header = root.createEl("header", { cls: "engram-conflict-header" });
		header.createEl("h2", { text: "Sync Conflict" });
		header.createEl("code", { text: this.info.path, cls: "engram-conflict-path" });

		const meta = header.createEl("aside", { cls: "engram-conflict-meta" });
		meta.createEl("span", {
			text: `Local: ${this.fmtDate(this.info.localMtime)} · ${this.info.localContent.length} chars`,
		});
		meta.createEl("span", {
			text: `Remote: ${this.fmtDate(this.info.remoteMtime)} · ${this.info.remoteContent.length} chars`,
		});
	}

	// ── Toolbar (view toggle) ───────────────────────────────────────

	private renderToolbar(root: HTMLElement): void {
		const bar = root.createEl("nav", { cls: "engram-conflict-toolbar" });

		const toggle = bar.createEl("fieldset", { cls: "engram-conflict-view-toggle" });
		toggle.createEl("legend", { text: "View" });

		const unifiedBtn = toggle.createEl("button", {
			text: "Unified",
			cls: this.viewMode === "unified" ? "is-active" : "",
		});
		const sideBySideBtn = toggle.createEl("button", {
			text: "Side-by-side",
			cls: this.viewMode === "side-by-side" ? "is-active" : "",
		});

		unifiedBtn.addEventListener("click", () => {
			this.viewMode = "unified";
			unifiedBtn.addClass("is-active");
			sideBySideBtn.removeClass("is-active");
			this.onViewModeChange("unified");
			this.renderDiff();
		});

		sideBySideBtn.addEventListener("click", () => {
			this.viewMode = "side-by-side";
			sideBySideBtn.addClass("is-active");
			unifiedBtn.removeClass("is-active");
			this.onViewModeChange("side-by-side");
			this.renderDiff();
		});

		if (this.hunks.length > 0) {
			const bulkGroup = bar.createEl("span", { cls: "engram-conflict-bulk" });
			const allLocalBtn = bulkGroup.createEl("button", { text: "All Local", cls: "mod-warning" });
			const allRemoteBtn = bulkGroup.createEl("button", { text: "All Remote" });

			allLocalBtn.addEventListener("click", () => {
				this.hunks.forEach((h) => (h.choice = "local"));
				this.renderDiff();
				this.updateMergeEditor();
			});
			allRemoteBtn.addEventListener("click", () => {
				this.hunks.forEach((h) => (h.choice = "remote"));
				this.renderDiff();
				this.updateMergeEditor();
			});
		}
	}

	// ── Diff view ───────────────────────────────────────────────────

	private renderDiff(): void {
		const container = this.diffContainer!;
		container.empty();

		if (this.hunks.length === 0) {
			container.createEl("p", {
				text: "No differences found.",
				cls: "engram-conflict-no-diff",
			});
			return;
		}

		if (this.viewMode === "unified") {
			this.renderUnified(container);
		} else {
			this.renderSideBySide(container);
		}
	}

	private renderUnified(container: HTMLElement): void {
		for (const hunk of this.hunks) {
			const hunkEl = container.createEl("article", { cls: "engram-conflict-hunk" });
			this.renderHunkControls(hunkEl, hunk);

			const table = hunkEl.createEl("table", { cls: "engram-diff-table engram-diff-unified" });
			const tbody = table.createEl("tbody");

			for (const line of hunk.lines) {
				const tr = tbody.createEl("tr", { cls: `engram-diff-line engram-diff-${line.type}` });
				tr.createEl("td", {
					text: line.oldLineNo?.toString() ?? "",
					cls: "engram-diff-linenum",
				});
				tr.createEl("td", {
					text: line.newLineNo?.toString() ?? "",
					cls: "engram-diff-linenum",
				});
				tr.createEl("td", {
					text: line.type === "add" ? "+" : line.type === "remove" ? "-" : " ",
					cls: "engram-diff-marker",
				});
				const contentTd = tr.createEl("td", { cls: "engram-diff-content" });
				contentTd.createEl("code", { text: line.content });
			}
		}
	}

	private renderSideBySide(container: HTMLElement): void {
		for (const hunk of this.hunks) {
			const hunkEl = container.createEl("article", { cls: "engram-conflict-hunk" });
			this.renderHunkControls(hunkEl, hunk);

			const wrapper = hunkEl.createEl("section", { cls: "engram-diff-sbs-wrapper" });
			const leftTable = wrapper.createEl("table", { cls: "engram-diff-table engram-diff-sbs" });
			const rightTable = wrapper.createEl("table", { cls: "engram-diff-table engram-diff-sbs" });
			const leftBody = leftTable.createEl("tbody");
			const rightBody = rightTable.createEl("tbody");

			// Pair up lines: equal lines go in both; removes go left, adds go right
			const leftLines: (DiffLine | null)[] = [];
			const rightLines: (DiffLine | null)[] = [];
			let i = 0;
			const lines = hunk.lines;

			while (i < lines.length) {
				if (lines[i].type === "equal") {
					leftLines.push(lines[i]);
					rightLines.push(lines[i]);
					i++;
				} else {
					// Collect consecutive remove+add block
					const removes: DiffLine[] = [];
					const adds: DiffLine[] = [];
					while (i < lines.length && lines[i].type === "remove") {
						removes.push(lines[i]);
						i++;
					}
					while (i < lines.length && lines[i].type === "add") {
						adds.push(lines[i]);
						i++;
					}
					const maxLen = Math.max(removes.length, adds.length);
					for (let j = 0; j < maxLen; j++) {
						leftLines.push(j < removes.length ? removes[j] : null);
						rightLines.push(j < adds.length ? adds[j] : null);
					}
				}
			}

			for (let r = 0; r < leftLines.length; r++) {
				const left = leftLines[r];
				const right = rightLines[r];

				const trLeft = leftBody.createEl("tr", {
					cls: `engram-diff-line ${left ? `engram-diff-${left.type}` : "engram-diff-empty"}`,
				});
				trLeft.createEl("td", {
					text: left?.oldLineNo?.toString() ?? "",
					cls: "engram-diff-linenum",
				});
				const leftContent = trLeft.createEl("td", { cls: "engram-diff-content" });
				leftContent.createEl("code", { text: left?.content ?? "" });

				const trRight = rightBody.createEl("tr", {
					cls: `engram-diff-line ${right ? `engram-diff-${right.type}` : "engram-diff-empty"}`,
				});
				trRight.createEl("td", {
					text: right?.newLineNo?.toString() ?? "",
					cls: "engram-diff-linenum",
				});
				const rightContent = trRight.createEl("td", { cls: "engram-diff-content" });
				rightContent.createEl("code", { text: right?.content ?? "" });
			}
		}
	}

	private renderHunkControls(parent: HTMLElement, hunk: DiffHunk): void {
		const controls = parent.createEl("nav", { cls: "engram-conflict-hunk-controls" });
		const label = controls.createEl("span", {
			text: `Hunk ${hunk.id + 1}`,
			cls: "engram-conflict-hunk-label",
		});

		const localBtn = controls.createEl("button", {
			text: "Use Local",
			cls: hunk.choice === "local" ? "is-active mod-warning" : "",
		});
		const remoteBtn = controls.createEl("button", {
			text: "Use Remote",
			cls: hunk.choice === "remote" ? "is-active" : "",
		});

		const updateButtons = () => {
			localBtn.className = hunk.choice === "local" ? "is-active mod-warning" : "";
			remoteBtn.className = hunk.choice === "remote" ? "is-active" : "";
		};

		localBtn.addEventListener("click", () => {
			hunk.choice = "local";
			updateButtons();
			this.updateMergeEditor();
		});
		remoteBtn.addEventListener("click", () => {
			hunk.choice = "remote";
			updateButtons();
			this.updateMergeEditor();
		});
	}

	// ── Merge editor ────────────────────────────────────────────────

	private renderMergeEditor(root: HTMLElement): void {
		const section = root.createEl("section", { cls: "engram-conflict-merge" });
		const header = section.createEl("header", { cls: "engram-conflict-merge-header" });
		header.createEl("h3", { text: "Merge Result" });
		header.createEl("span", {
			text: "Edit the merged content below, or use hunk controls above",
			cls: "engram-conflict-merge-hint",
		});

		this.mergeEditor = section.createEl("textarea", {
			cls: "engram-conflict-merge-editor",
		});
		this.updateMergeEditor();
	}

	private updateMergeEditor(): void {
		if (!this.mergeEditor) return;
		this.mergeEditor.value = buildMergedContent(this.diffLines, this.hunks);
	}

	// ── Action buttons ──────────────────────────────────────────────

	private renderActions(root: HTMLElement): void {
		const bar = root.createEl("footer", { cls: "engram-conflict-actions" });

		const applyMerge = bar.createEl("button", { text: "Apply Merge", cls: "mod-cta" });
		applyMerge.addEventListener("click", () => {
			this.resolvePromise({
				choice: "merge",
				mergedContent: this.mergeEditor?.value ?? "",
			});
			this.close();
		});

		const keepLocal = bar.createEl("button", { text: "Keep Local", cls: "mod-warning" });
		keepLocal.addEventListener("click", () => {
			this.resolvePromise({ choice: "keep-local" });
			this.close();
		});

		const keepRemote = bar.createEl("button", { text: "Keep Remote" });
		keepRemote.addEventListener("click", () => {
			this.resolvePromise({ choice: "keep-remote" });
			this.close();
		});

		const keepBoth = bar.createEl("button", { text: "Keep Both" });
		keepBoth.addEventListener("click", () => {
			this.resolvePromise({ choice: "keep-both" });
			this.close();
		});

		const skip = bar.createEl("button", { text: "Skip" });
		skip.addEventListener("click", () => {
			this.resolvePromise({ choice: "skip" });
			this.close();
		});
	}

	// ── Helpers ──────────────────────────────────────────────────────

	private fmtDate(epoch: number): string {
		return new Date(epoch * 1000).toLocaleString();
	}
}
