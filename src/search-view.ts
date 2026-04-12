/**
 * Sidebar search view — persistent search panel in the right sidebar.
 */
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { EngramApi } from "./api";
import type { SearchResult } from "./types";

export const SEARCH_VIEW_TYPE = "engram-search-view";

export class SearchView extends ItemView {
	private api: EngramApi;
	private inputEl!: HTMLInputElement;
	private folderEl!: HTMLInputElement;
	private resultsEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private results: SearchResult[] = [];
	private selectedIndex = -1;

	constructor(leaf: WorkspaceLeaf, api: EngramApi) {
		super(leaf);
		this.api = api;
	}

	getViewType(): string {
		return SEARCH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Engram Search";
	}

	getIcon(): string {
		return "search";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("engram-search-view-container");

		this.inputEl = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "Search your vault semantically...",
			cls: "engram-search-input",
		});

		this.folderEl = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "Filter by folder...",
			cls: "engram-search-input engram-search-folder-input",
		});

		this.resultsEl = this.contentEl.createDiv({ cls: "engram-search-results" });
		this.previewEl = this.contentEl.createDiv({ cls: "engram-search-preview" });

		this.renderEmpty();

		const scheduleSearch = () => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => this.doSearch(), 300);
		};

		this.registerDomEvent(this.inputEl, "input", scheduleSearch);
		this.registerDomEvent(this.folderEl, "input", scheduleSearch);

		this.registerDomEvent(this.inputEl, "keydown", (e) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.moveSelection(1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.moveSelection(-1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				this.openSelected();
			}
		});
	}

	async onClose(): Promise<void> {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
	}

	private renderEmpty(): void {
		this.resultsEl.empty();
		this.previewEl.empty();
		this.resultsEl.createEl("p", {
			text: "Type to search your vault semantically",
			cls: "engram-search-empty",
		});
	}

	private renderResults(): void {
		this.resultsEl.empty();

		if (this.results.length === 0) {
			this.resultsEl.createEl("p", {
				text: "No results found",
				cls: "engram-search-empty",
			});
			this.previewEl.empty();
			return;
		}

		this.results.forEach((result, i) => {
			const item = this.resultsEl.createDiv({
				cls: `engram-search-result-item${i === this.selectedIndex ? " is-selected" : ""}`,
			});

			const header = item.createDiv({ cls: "engram-search-result-header" });
			const title = result.title || result.source_path || "Untitled";
			header.createEl("span", { text: title, cls: "engram-search-result-title" });

			const scoreBadge = `${(result.score * 100).toFixed(0)}%`;
			header.createEl("span", { text: scoreBadge, cls: "engram-search-result-score" });

			if (result.source_path) {
				const folder = result.source_path.replace(/\/[^/]+$/, "");
				if (folder) {
					item.createEl("span", { text: folder, cls: "engram-search-result-path" });
				}
			}

			const snippet = result.text.slice(0, 150) + (result.text.length > 150 ? "..." : "");
			item.createEl("p", { text: snippet, cls: "engram-search-result-snippet" });

			item.addEventListener("click", () => {
				this.selectedIndex = i;
				this.renderResults();
				this.renderPreview(result);
			});

			item.addEventListener("dblclick", () => this.openResult(result));
		});

		if (this.selectedIndex >= 0 && this.selectedIndex < this.results.length) {
			this.renderPreview(this.results[this.selectedIndex]);
		}
	}

	private renderPreview(result: SearchResult): void {
		this.previewEl.empty();

		if (result.heading_path) {
			this.previewEl.createEl("h4", {
				text: result.heading_path,
				cls: "engram-search-preview-heading",
			});
		}

		this.previewEl.createEl("p", {
			text: result.text,
			cls: "engram-search-preview-text",
		});

		if (result.source_path) {
			const openBtn = this.previewEl.createEl("button", {
				text: "Open note",
				cls: "engram-search-preview-open",
			});
			openBtn.addEventListener("click", () => this.openResult(result));
		}
	}

	private moveSelection(delta: number): void {
		if (this.results.length === 0) return;
		this.selectedIndex = Math.max(
			0,
			Math.min(this.results.length - 1, this.selectedIndex + delta),
		);
		this.renderResults();
	}

	private openSelected(): void {
		if (this.selectedIndex >= 0 && this.selectedIndex < this.results.length) {
			this.openResult(this.results[this.selectedIndex]);
		}
	}

	private openResult(result: SearchResult): void {
		if (!result.source_path) {
			new Notice("No source path for this result");
			return;
		}
		const file = this.app.vault.getFileByPath(result.source_path);
		if (!file) {
			new Notice("Note not synced locally");
			return;
		}
		this.app.workspace.openLinkText(result.source_path, "");
	}

	private async doSearch(): Promise<void> {
		const query = this.inputEl.value.trim();
		if (!query) {
			this.results = [];
			this.selectedIndex = -1;
			this.renderEmpty();
			return;
		}

		try {
			const folder = this.folderEl.value.trim() || undefined;
			const resp = await this.api.search(query, 10, undefined, folder);
			this.results = resp.results;
			this.selectedIndex = this.results.length > 0 ? 0 : -1;
			this.renderResults();
		} catch (e) {
			// biome-ignore lint/suspicious/noConsole: error boundary
			console.error("Engram search failed", e);
			this.resultsEl.empty();
			this.previewEl.empty();
			this.resultsEl.createEl("p", {
				text: "Search failed — check connection",
				cls: "engram-search-empty",
			});
		}
	}
}
