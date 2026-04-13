import { Setting } from "obsidian";
import type { TabContext } from "./types";

export function renderSelfHostedTab(ctx: TabContext): void {
	const { containerEl } = ctx;
	new Setting(containerEl).setName("Self-Hosted").setHeading();
	containerEl.createEl("p", {
		text: "Self-hosted configuration will be available here once Engram Cloud launches. For now, set your server URL and credentials on the Account tab.",
	});
}
