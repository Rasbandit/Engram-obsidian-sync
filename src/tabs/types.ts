import type { App } from "obsidian";
import type EngramSyncPlugin from "../main";
import type { SyncProgressModal } from "../sync-progress-modal";

export interface TabContext {
	containerEl: HTMLElement;
	app: App;
	plugin: EngramSyncPlugin;
	redisplay: () => void;
	startDeviceFlow: () => Promise<void>;
	openProgressModal: () => Promise<SyncProgressModal>;
}

export type TabRenderer = (ctx: TabContext) => void;
