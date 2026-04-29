import { Setting } from "obsidian";
import type { TabContext } from "./types";

export function renderSelfHostedTab(ctx: TabContext): void {
	const { containerEl, plugin } = ctx;

	new Setting(containerEl).setName("Self-hosted").setHeading();
	containerEl.createEl("p", {
		text: "This tab is for users running their own Engram server. Server URL and credentials are configured on the Account tab. Hosted Engram (coming soon) will have its own tab.",
	});

	new Setting(containerEl).setName("About").setHeading();

	const aboutList = containerEl.createEl("ul", { cls: "engram-about-list" });

	const versionItem = aboutList.createEl("li");
	versionItem.createSpan({ text: "Version: " });
	versionItem.createSpan({ text: plugin.manifest.version });

	const repoItem = aboutList.createEl("li");
	repoItem.createSpan({ text: "Source: " });
	repoItem.createEl("a", {
		text: "github.com/Rasbandit/Engram-obsidian-sync",
		href: "https://github.com/Rasbandit/Engram-obsidian-sync",
	});

	const licenseItem = aboutList.createEl("li");
	licenseItem.createSpan({ text: "License: MIT" });

	new Setting(containerEl)
		.setName("Support development")
		.setDesc(
			"If this plugin saves you time, consider supporting development. Optional and appreciated.",
		)
		.addButton((btn) => {
			btn.setButtonText("Ko-fi")
				.setCta()
				.onClick(() => {
					window.open("https://ko-fi.com/rasbandit", "_blank");
				});
		});
}
