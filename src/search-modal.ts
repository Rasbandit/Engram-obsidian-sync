/**
 * Quick search modal — Mod+Shift+S opens this for semantic vault search.
 */
import { type App, Modal, Notice } from "obsidian";
import type { EngramApi } from "./api";
import type { SearchResult } from "./types";

export class SearchModal extends Modal {
	private api: EngramApi;
	private inputEl!: HTMLInputElement;
	private folderEl!: HTMLInputElement;
	private resultsEl!: HTMLElement;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private results: SearchResult[] = [];
	private selectedIndex = -1;

	constructor(app: App, api: EngramApi) {
		super(app);
		this.api = api;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("engram-search-modal");

		this.inputEl = contentEl.createEl("input", {
			type: "text",
			placeholder: "Search your vault semantically...",
			cls: "engram-search-input",
		});

		this.folderEl = contentEl.createEl("input", {
			type: "text",
			placeholder: "Filter by folder...",
			cls: "engram-search-input engram-search-folder-input",
		});

		this.resultsEl = contentEl.createDiv({ cls: "engram-search-results" });
		this.renderEmpty();

		const scheduleSearch = () => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => this.doSearch(), 300);
		};

		this.inputEl.addEventListener("input", scheduleSearch);
		this.folderEl.addEventListener("input", scheduleSearch);

		this.inputEl.addEventListener("keydown", (e) => {
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

		this.inputEl.focus();
	}

	onClose(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.contentEl.empty();
	}

	private renderEmpty(): void {
		this.resultsEl.empty();
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
			return;
		}

		this.results.forEach((result, i) => {
			const item = this.resultsEl.createDiv({
				cls: `engram-search-result-item${i === this.selectedIndex ? " is-selected" : ""}`,
			});

			const title = result.title || result.source_path || "Untitled";
			item.createEl("span", { text: title, cls: "engram-search-result-title" });

			if (result.source_path) {
				const folder = result.source_path.replace(/\/[^/]+$/, "");
				if (folder) {
					item.createEl("span", { text: folder, cls: "engram-search-result-path" });
				}
			}

			const snippet = result.text.slice(0, 150) + (result.text.length > 150 ? "..." : "");
			item.createEl("p", { text: snippet, cls: "engram-search-result-snippet" });

			item.addEventListener("click", () => this.openResult(result));
		});
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
		this.close();
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
			this.resultsEl.createEl("p", {
				text: "Search failed — check connection",
				cls: "engram-search-empty",
			});
		}
	}
}
