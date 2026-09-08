/**
 * The client half of the backend's minimum-plugin-version floor.
 *
 * Every case here guards a SILENT failure: if the 426 branch or the join-reason
 * branch stops firing, the user gets sync that fails forever with no
 * explanation, and nothing in the logs looks different from an outage.
 */
import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { requestUrl } from "obsidian";
import { EngramApi } from "../src/api";
import { NoteChannel } from "../src/channel";
import {
	isUpgradeRequired,
	notifyUpgradeRequired,
	resetUpgradeRequired,
	setUpgradeAction,
} from "../src/upgrade-required";
import { __noticeCapture } from "./__mocks__/obsidian";

const mockRequestUrl = requestUrl as unknown as Mock<() => Promise<any>>;

beforeEach(() => {
	__noticeCapture.notices.length = 0;
	mockRequestUrl.mockReset();
	resetUpgradeRequired();
});

afterEach(() => resetUpgradeRequired());

describe("notifyUpgradeRequired", () => {
	test("names the minimum version so the user can tell if they already updated", () => {
		notifyUpgradeRequired("1.29.0");

		expect(__noticeCapture.notices).toHaveLength(1);
		const n = __noticeCapture.notices[0];
		expect(n.message).toMatch(/too old/i);
		expect(n.message).toContain("1.29.0");
		expect(n.duration).toBeGreaterThanOrEqual(10_000);
	});

	test("still says something useful when the body carried no version", () => {
		notifyUpgradeRequired(null);

		expect(__noticeCapture.notices[0].message).toMatch(/too old/i);
	});

	// Every refused request and every reconnect would otherwise toast.
	test("latches to one notice per session", () => {
		notifyUpgradeRequired("1.29.0");
		notifyUpgradeRequired("1.29.0");
		notifyUpgradeRequired("1.30.0");

		expect(__noticeCapture.notices).toHaveLength(1);
		expect(isUpgradeRequired()).toBe(true);
	});

	test("the button is labelled Update, not Upgrade", () => {
		// The 402 toast next door says "Upgrade" and means "pay more". A user
		// who reads this one as a sales prompt will dismiss it and stay broken.
		setUpgradeAction(() => {});
		notifyUpgradeRequired("1.29.0");

		expect(__noticeCapture.notices[0].buttons).toHaveLength(1);
		expect(__noticeCapture.notices[0].buttons[0].text).toBe("Update");
	});

	test("the button runs the injected action", () => {
		const action = mock(() => {});
		setUpgradeAction(action);
		notifyUpgradeRequired("1.29.0");

		__noticeCapture.notices[0].buttons[0].click();

		expect(action).toHaveBeenCalledTimes(1);
	});

	test("renders no button when no action was wired", () => {
		notifyUpgradeRequired("1.29.0");

		expect(__noticeCapture.notices[0].buttons).toHaveLength(0);
	});
});

describe("REST 426", () => {
	test("a refused request notifies and still rejects", async () => {
		mockRequestUrl.mockRejectedValueOnce({
			status: 426,
			json: {
				error: "plugin_upgrade_required",
				min_version: "1.29.0",
				your_version: "1.10.0",
			},
		});

		const api = new EngramApi("https://api.example.com", "key");

		await expect(api.getManifest()).rejects.toBeDefined();
		expect(__noticeCapture.notices).toHaveLength(1);
		expect(__noticeCapture.notices[0].message).toContain("1.29.0");
	});

	test("reads a body that arrived as raw text", async () => {
		mockRequestUrl.mockRejectedValueOnce({
			status: 426,
			text: JSON.stringify({ min_version: "1.31.0" }),
		});

		const api = new EngramApi("https://api.example.com", "key");

		await expect(api.getManifest()).rejects.toBeDefined();
		expect(__noticeCapture.notices[0].message).toContain("1.31.0");
	});

	test("a malformed body still notifies rather than crashing the error path", async () => {
		mockRequestUrl.mockRejectedValueOnce({ status: 426, text: "<html>nope" });

		const api = new EngramApi("https://api.example.com", "key");

		await expect(api.getManifest()).rejects.toBeDefined();
		expect(__noticeCapture.notices).toHaveLength(1);
	});

	test("other statuses do not trip it", async () => {
		mockRequestUrl.mockRejectedValueOnce({ status: 500, text: "boom" });

		const api = new EngramApi("https://api.example.com", "key");

		await expect(api.getManifest()).rejects.toBeDefined();
		expect(__noticeCapture.notices).toHaveLength(0);
		expect(isUpgradeRequired()).toBe(false);
	});
});

describe("channel join refusal", () => {
	class FakeWS {
		static last: FakeWS | null = null;
		static OPEN = 1;
		onopen: (() => void) | null = null;
		onclose: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onmessage: ((e: { data: string }) => void) | null = null;
		readyState = 0;
		constructor(_url: string) {
			FakeWS.last = this;
		}
		close() {}
		send() {}
	}

	const joinError = (topic: string, reason: string, minVersion?: string) =>
		JSON.stringify([
			null,
			"1",
			topic,
			"phx_reply",
			{
				status: "error",
				response: { reason, ...(minVersion ? { min_version: minVersion } : {}) },
			},
		]);

	beforeEach(() => {
		// @ts-expect-error test shim
		global.WebSocket = FakeWS;
		FakeWS.last = null;
	});

	// Checked for EVERY topic. The floor refuses sync: and crdt: alike, and the
	// crdt-only path would miss a sync: refusal entirely.
	test("a sync: topic refusal notifies", async () => {
		const ch = new NoteChannel("http://x", "key", "user-1", "vault-9", "dev-1");
		await ch.connect();

		FakeWS.last?.onmessage?.({
			data: joinError("sync:user-1:vault-9", "plugin_upgrade_required", "1.29.0"),
		});

		expect(__noticeCapture.notices).toHaveLength(1);
		expect(__noticeCapture.notices[0].message).toContain("1.29.0");
	});

	test("an unrelated join reason does not trip it", async () => {
		const ch = new NoteChannel("http://x", "key", "user-1", "vault-9", "dev-1");
		await ch.connect();

		FakeWS.last?.onmessage?.({
			data: joinError("sync:user-1:vault-9", "onboarding_required"),
		});

		expect(__noticeCapture.notices).toHaveLength(0);
		expect(isUpgradeRequired()).toBe(false);
	});
});
