# Tooling Modernization Design

**Date:** 2026-04-08  
**Status:** Approved  
**Scope:** Replace Jest+ts-jest with Bun test runner, add Biome for lint/format, add Husky for git hooks

---

## Goal

Mature the dev toolchain: faster tests, consistent code style enforced at commit time, and a leaner dependency tree — all without touching any production source or test logic.

---

## Changes Overview

### Remove
- `jest.config.js`
- `tsconfig.test.json` (only existed to relax `noImplicitAny` for ts-jest)
- devDeps: `jest`, `ts-jest`, `@types/jest`

### Add
- `biome.json` — lint + format config
- `bunfig.toml` — Bun test config (preload, coverage flag)
- `tests/preload.ts` — registers obsidian mock module for Bun
- `.husky/pre-commit` — runs lint-staged
- `.husky/pre-push` — runs full test suite
- devDeps: `@biomejs/biome`, `husky`, `lint-staged`

### Modify
- `package.json` — scripts, devDeps, lint-staged config, prepare script

---

## Bun Test Runner

Bun's test runner is Jest-compatible at the API level (`describe`, `it`, `expect`, `beforeEach`, `mock`, etc.). All matchers used across the 223 existing tests are fully supported. The `testEnvironment: "node"` setup means the jsdom gap (Bun's main incompatibility) is irrelevant here.

### Obsidian Mock

Jest's `moduleNameMapper` wired `obsidian` → `tests/__mocks__/obsidian.ts`. Bun uses a preload file instead:

```toml
# bunfig.toml
[test]
preload = ["./tests/preload.ts"]
```

```ts
// tests/preload.ts
import { mock } from "bun:test";
import * as obsidianMock from "./__mocks__/obsidian";
mock.module("obsidian", () => obsidianMock);
```

### Coverage Threshold

The 40% threshold from `jest.config.js` cannot be expressed in `bunfig.toml` at per-metric granularity. It is dropped from local config. Coverage is still available via `bun test --coverage` and can be enforced in CI by checking the output.

### Scripts

```json
"test": "bun test",
"test:coverage": "bun test --coverage"
```

---

## Biome

Single dependency replacing both ESLint and Prettier. Config:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noConsole": "warn"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "indentWidth": 4,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always"
    }
  },
  "files": {
    "ignore": ["node_modules", "main.js", "esbuild.config.mjs", "version-bump.mjs"]
  }
}
```

`noConsole: "warn"` nudges contributors toward the existing `dev-log.ts` abstraction without blocking builds.

### Scripts

```json
"lint": "biome check src tests",
"format": "biome format --write src tests"
```

---

## Husky + lint-staged

### Pre-commit (fast, ~1s)
Runs Biome check + auto-fix on staged TypeScript files only.

```sh
# .husky/pre-commit
bun lint-staged
```

```json
"lint-staged": {
  "src/**/*.ts": ["biome check --write --no-errors-on-unmatched"],
  "tests/**/*.ts": ["biome check --write --no-errors-on-unmatched"]
}
```

### Pre-push (full gate)
Runs all 223 tests before anything reaches remote.

```sh
# .husky/pre-push
bun test
```

### Wiring

The `prepare` script auto-installs hooks after `bun install`:

```json
"prepare": "husky"
```

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Bun moduleNameMapper gap | Low | Preload file approach is idiomatic Bun |
| Biome rule false positives | Medium | Start with `recommended` only; tune after first run |
| Pre-push slowdown | Low | 223 tests run in ~2-4s with Bun vs ~9-45s with Jest |
| Coverage threshold loss | Low | Enforce in CI; document in CLAUDE.md |

---

## Out of Scope

- Migrating any test logic or src files
- Adding new tests
- Changing CI pipeline beyond what's needed for new scripts
- TypeScript strictness upgrades (`strict: true`)
