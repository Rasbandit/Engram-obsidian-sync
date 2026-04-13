import { Setting } from "obsidian";
import type { TabContext } from "./types";

export function renderAdvancedTab(ctx: TabContext): void {
	const { containerEl } = ctx;
	new Setting(containerEl).setName("Advanced").setHeading();
	containerEl.createEl("p", { text: "Advanced tab placeholder" });
}
