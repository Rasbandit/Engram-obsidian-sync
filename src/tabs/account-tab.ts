import { Setting } from "obsidian";
import type { TabContext } from "./types";

export function renderAccountTab(ctx: TabContext): void {
	const { containerEl } = ctx;
	new Setting(containerEl).setName("Account").setHeading();
	containerEl.createEl("p", { text: "Account tab placeholder" });
}
