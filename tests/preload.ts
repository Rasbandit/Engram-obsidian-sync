import { mock } from "bun:test";
import * as obsidianMock from "./__mocks__/obsidian";

mock.module("obsidian", () => ({
	...obsidianMock,
	requestUrl: mock(obsidianMock.requestUrl),
}));
