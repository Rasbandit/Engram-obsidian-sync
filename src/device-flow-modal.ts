import { App, Modal, Notice } from "obsidian";
import type EngramSyncPlugin from "./main";

export interface DeviceFlowResult {
  access_token: string;
  refresh_token: string;
  vault_id: number;
  user_email: string;
  expires_in: number;
}

export class DeviceFlowModal extends Modal {
  private plugin: EngramSyncPlugin;
  private resolve: (result: DeviceFlowResult | null) => void = () => {};
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private aborted = false;

  constructor(app: App, plugin: EngramSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Link Obsidian to Engram" });
    const statusEl = contentEl.createEl("p", { text: "Starting..." });

    try {
      const resp = await this.startDeviceFlow();
      this.renderCodeScreen(contentEl, resp);
      this.startPolling(resp.device_code);
    } catch {
      statusEl.setText("Failed to start device flow. Check your Engram URL and try again.");
    }
  }

  onClose(): void {
    this.aborted = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.contentEl.empty();
    this.resolve(null);
  }

  waitForResult(): Promise<DeviceFlowResult | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private async startDeviceFlow(): Promise<{
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
  }> {
    const baseUrl = this.plugin.settings.apiUrl.replace(/\/+$/, "");
    const apiUrl = baseUrl.endsWith("/api") ? baseUrl : `${baseUrl}/api`;
    const resp = await fetch(`${apiUrl}/auth/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.plugin.settings.clientId }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  private renderCodeScreen(
    contentEl: HTMLElement,
    resp: { user_code: string; verification_url: string },
  ): void {
    contentEl.empty();
    contentEl.createEl("h2", { text: "Link Obsidian to Engram" });
    contentEl.createEl("p", { text: "Your code:" });

    const codeEl = contentEl.createEl("code", { text: resp.user_code });
    codeEl.style.display = "block";
    codeEl.style.fontSize = "2rem";
    codeEl.style.fontFamily = "monospace";
    codeEl.style.textAlign = "center";
    codeEl.style.padding = "1rem";
    codeEl.style.margin = "1rem 0";
    codeEl.style.letterSpacing = "0.15em";
    codeEl.style.cursor = "pointer";
    codeEl.title = "Click to copy";
    codeEl.addEventListener("click", () => {
      navigator.clipboard.writeText(resp.user_code);
      new Notice("Code copied!");
    });

    contentEl.createEl("p", {
      text: "A browser window has opened. Sign in and enter this code to link your vault.",
    });

    const waitEl = contentEl.createEl("p", { text: "Waiting for authorization..." });
    waitEl.style.fontStyle = "italic";

    const btnContainer = contentEl.createDiv();
    btnContainer.style.marginTop = "1rem";
    const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    window.open(resp.verification_url);
  }

  private startPolling(deviceCode: string): void {
    const base = this.plugin.settings.apiUrl.replace(/\/+$/, "");
    const apiUrl = base.endsWith("/api") ? base : `${base}/api`;
    let elapsed = 0;
    const maxSeconds = 300;

    this.pollInterval = setInterval(async () => {
      if (this.aborted) return;
      elapsed += 5;

      if (elapsed >= maxSeconds) {
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.renderExpired();
        return;
      }

      try {
        const resp = await fetch(`${apiUrl}/auth/device/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: deviceCode }),
        });

        if (resp.status === 428) return;

        if (resp.ok) {
          if (this.pollInterval) clearInterval(this.pollInterval);
          const result: DeviceFlowResult = await resp.json();
          this.resolve(result);
          this.resolve = () => {};
          this.close();
          return;
        }

        if (resp.status === 410) {
          if (this.pollInterval) clearInterval(this.pollInterval);
          this.renderExpired();
          return;
        }
      } catch {
        // Network error — keep polling
      }
    }, 5000);
  }

  private renderExpired(): void {
    const contentEl = this.contentEl;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Link Obsidian to Engram" });
    contentEl.createEl("p", { text: "Code expired. Please try again." });

    const btnContainer = contentEl.createDiv();
    btnContainer.style.marginTop = "1rem";

    const retryBtn = btnContainer.createEl("button", { text: "Try Again", cls: "mod-cta" });
    retryBtn.addEventListener("click", () => {
      this.aborted = false;
      this.onOpen();
    });

    const closeBtn = btnContainer.createEl("button", { text: "Close" });
    closeBtn.style.marginLeft = "8px";
    closeBtn.addEventListener("click", () => this.close());
  }
}
