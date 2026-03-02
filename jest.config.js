module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
	roots: ["<rootDir>/src", "<rootDir>/tests"],
	testMatch: ["**/*.test.ts"],
	moduleNameMapper: {
		"^obsidian$": "<rootDir>/tests/__mocks__/obsidian.ts",
	},
};
