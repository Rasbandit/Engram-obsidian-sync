import { Setting } from "obsidian";
import type { TabContext } from "./types";

export function renderAccountTab(ctx: TabContext): void {
	const { containerEl, switchToTab } = ctx;

	new Setting(containerEl).setName("Engram Cloud").setHeading();
	containerEl.createEl("p", {
		text: "Engram Cloud is coming. Sign in here once it launches — no server setup needed.",
	});

	new Setting(containerEl).setName("How to connect today").setHeading();
	containerEl.createEl("p", {
		text: "For now, run your own Engram server. Configure your server URL and authenticate on the Self-hosted tab.",
	});

	new Setting(containerEl)
		.setName("Switch to Self-hosted setup")
		.setDesc("Configure your self-hosted Engram server.")
		.addButton((btn) =>
			btn
				.setButtonText("Open Self-hosted")
				.setCta()
				.onClick(() => switchToTab("self-hosted")),
		);
}
