module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
	globals: {
		"ts-jest": {
			tsconfig: "tsconfig.test.json",
		},
	},
	roots: ["<rootDir>/src", "<rootDir>/tests"],
	testMatch: ["**/*.test.ts"],
	moduleNameMapper: {
		"^obsidian$": "<rootDir>/tests/__mocks__/obsidian.ts",
	},
	collectCoverageFrom: [
		"src/**/*.ts",
		"!src/**/*.d.ts",
	],
	coverageThreshold: {
		global: {
			branches: 40,
			functions: 40,
			lines: 40,
			statements: 40,
		},
	},
};
