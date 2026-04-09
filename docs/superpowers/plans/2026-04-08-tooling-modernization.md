# Tooling Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Jest+ts-jest with Bun's test runner, add Biome for lint/format, and wire Husky pre-commit (lint) + pre-push (tests) hooks.

**Architecture:** Three sequential phases — migrate test runner (including two test file fixes), then add Biome, then wire Husky. Each phase ends with a working state and a commit. Never proceed to the next phase until all 223 tests pass.

**Tech Stack:** Bun (test runner + package manager), `@biomejs/biome`, Husky v9, lint-staged, `@types/bun` (IDE types)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `bunfig.toml` | Bun test config — registers preload file |
| Create | `tests/preload.ts` | Registers obsidian mock + wraps requestUrl as mock() before tests run |
| Modify | `tests/api.test.ts` | Replace jest.requireActual + jest.mock with mock.module from bun:test |
| Modify | `tests/search.test.ts` | Replace jest.mock auto-mock + jest.MockedFunction with bun:test types |
| Create | `biome.json` | Lint + format rules |
| Create | `.husky/pre-commit` | Runs lint-staged on staged TS files |
| Create | `.husky/pre-push` | Runs full test suite before push |
| Modify | `package.json` | Scripts, devDeps, lint-staged config, prepare script |
| Delete | `jest.config.js` | Replaced by bunfig.toml |
| Delete | `tsconfig.test.json` | Only existed for ts-jest; Bun handles TS natively |

---

## Task 1: Update package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Replace package.json**

Open `package.json` and replace its entire contents with:

```json
{
  "name": "engram-obsidian-sync",
  "version": "0.8.5",
  "description": "Bidirectional sync between Obsidian and Engram",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "test": "bun test",
    "test:coverage": "bun test --coverage",
    "lint": "biome check src tests",
    "format": "biome format --write src tests",
    "version": "node version-bump.mjs && git add manifest.json versions.json",
    "prepare": "husky"
  },
  "lint-staged": {
    "src/**/*.ts": ["biome check --write --no-errors-on-unmatched"],
    "tests/**/*.ts": ["biome check --write --no-errors-on-unmatched"]
  },
  "keywords": ["obsidian", "engram", "sync", "knowledge-base"],
  "author": "",
  "license": "MIT",
  "devDependencies": {
    "@biomejs/biome": "latest",
    "@types/bun": "latest",
    "@types/diff-match-patch": "^1.0.36",
    "@types/node": "^22.19.17",
    "builtin-modules": "^4.0.0",
    "esbuild": "^0.25.0",
    "husky": "^9.0.0",
    "lint-staged": "^15.0.0",
    "obsidian": "latest",
    "tslib": "^2.8.1",
    "typescript": "^5.9.3"
  },
  "dependencies": {
    "diff-match-patch": "^1.0.5"
  },
  "overrides": {
    "brace-expansion": "^1.1.13",
    "picomatch": "^2.3.2"
  }
}
```

- [ ] **Step 2: Install deps**

```bash
bun install
```

Expected: `bun.lock` updated. `jest`, `ts-jest`, `@types/jest` removed from `node_modules`. `@biomejs/biome`, `husky`, `lint-staged`, `@types/bun` added. The `prepare` script fires automatically, running `husky` which sets `core.hooksPath = .husky` in git config and creates the `.husky/` directory.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "build: swap jest/ts-jest for bun test, add biome/husky/lint-staged"
```

---

## Task 2: Create Bun Test Config

**Files:**
- Create: `bunfig.toml`
- Create: `tests/preload.ts`

- [ ] **Step 1: Create bunfig.toml**

```toml
[test]
preload = ["./tests/preload.ts"]
```

- [ ] **Step 2: Create tests/preload.ts**

This file runs before every test file. It registers the obsidian mock module and wraps `requestUrl` as a Bun `mock()` so test files can call `.mockResolvedValue()` on it.

```ts
import { mock } from "bun:test";
import * as obsidianMock from "./__mocks__/obsidian";

mock.module("obsidian", () => ({
	...obsidianMock,
	requestUrl: mock(obsidianMock.requestUrl),
}));
```

- [ ] **Step 3: Commit**

```bash
git add bunfig.toml tests/preload.ts
git commit -m "test: add Bun test config and obsidian mock preload"
```

---

## Task 3: Fix Two Test Files for Bun Compatibility

**Context:** `jest.mock()` auto-mock and `jest.requireActual()` have no Bun equivalents. Both test files that use these can drop their local `jest.mock()` calls entirely — the preload already registers `requestUrl` as a `mock()` function, so importing it from `"obsidian"` gives a full mock instance. Two files need surgery; all other test files use `jest.fn()` / `jest.spyOn()` / `jest.clearAllMocks()` which Bun's jest compat layer supports without changes.

**Files:**
- Modify: `tests/api.test.ts`
- Modify: `tests/search.test.ts`

### Fix api.test.ts

- [ ] **Step 1: Replace lines 1–15 in tests/api.test.ts**

Current:

```ts
/**
 * Tests for api.ts — utility functions and EngramApi method behavior.
 */
import { EngramApi, arrayBufferToBase64, base64ToArrayBuffer } from "../src/api";

// Replace the obsidian module's requestUrl with a proper jest.fn()
const mockRequestUrl = jest.fn();
jest.mock("obsidian", () => ({
    ...jest.requireActual("obsidian"),
    requestUrl: (...args: any[]) => mockRequestUrl(...args),
}));

beforeEach(() => {
    mockRequestUrl.mockReset();
});
```

Replace with:

```ts
/**
 * Tests for api.ts — utility functions and EngramApi method behavior.
 */
import { type Mock } from "bun:test";
import { requestUrl } from "obsidian";
import { EngramApi, arrayBufferToBase64, base64ToArrayBuffer } from "../src/api";

// requestUrl is mocked via tests/preload.ts — it is already a mock() instance
const mockRequestUrl = requestUrl as unknown as Mock<() => Promise<any>>;

beforeEach(() => {
	mockRequestUrl.mockReset();
});
```

**Why:** The preload runs before any test file and registers `mock.module("obsidian", ...)` with `requestUrl: mock(obsidianMock.requestUrl)`. When `api.test.ts` imports `requestUrl from "obsidian"`, it gets the same shared mock instance that `src/api.ts` uses — so setting up `mockRequestUrl.mockResolvedValueOnce(...)` in a test controls what `api.ts` receives. `jest.requireActual` has no Bun equivalent and is unnecessary since the preload already spreads the full mock.

### Fix search.test.ts

- [ ] **Step 2: Replace lines 1–6 in tests/search.test.ts**

Current:

```ts
import { requestUrl } from "obsidian";
import { EngramApi } from "../src/api";

jest.mock("obsidian");

const mockRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;
```

Replace with:

```ts
import { type Mock } from "bun:test";
import { requestUrl } from "obsidian";
import { EngramApi } from "../src/api";

// obsidian is mocked via tests/preload.ts — requestUrl is already a mock()
const mockRequestUrl = requestUrl as unknown as Mock<() => Promise<any>>;
```

**Why:** `jest.mock("obsidian")` with no factory is Jest's auto-mock — Bun doesn't support it. The preload already covers this: `requestUrl` imported from `"obsidian"` is a `mock()` instance. `jest.MockedFunction` is a `@types/jest` type; `Mock` from `bun:test` is the equivalent.

- [ ] **Step 3: Commit**

```bash
git add tests/api.test.ts tests/search.test.ts
git commit -m "test: fix api.test.ts and search.test.ts for bun:test compatibility"
```

---

## Task 4: Verify Tests Pass and Remove Jest Files

**Files:**
- Delete: `jest.config.js`
- Delete: `tsconfig.test.json`

- [ ] **Step 1: Run bun test**

```bash
bun test
```

Expected: 223 tests pass, 0 failures. All 8 test files complete.

If you see **"Cannot find module 'obsidian'"**: verify `bunfig.toml` is at the project root and the preload path resolves. Run `ls bunfig.toml` to confirm.

If you see **"mockRequestUrl.mockReset is not a function"** in api.test.ts: the `mock()` wrapping in preload.ts is conflicting with the per-file `mock.module()` override. Ensure the `mock.module()` in `api.test.ts` is using its own `mockRequestUrl` (defined in that file) and not the preload's version.

If you see **"mockResolvedValue is not a function"** in search.test.ts: the preload's `requestUrl: mock(obsidianMock.requestUrl)` didn't run. Verify `preload.ts` path in `bunfig.toml` is `"./tests/preload.ts"` (relative to project root, not to `tests/`).

- [ ] **Step 2: Delete Jest config files**

```bash
git rm jest.config.js tsconfig.test.json
```

- [ ] **Step 3: Run bun test again to confirm no regression**

```bash
bun test
```

Expected: 223 pass.

- [ ] **Step 4: Commit**

```bash
git commit -m "build: remove jest.config.js and tsconfig.test.json"
```

---

## Task 5: Add Biome

**Files:**
- Create: `biome.json`

- [ ] **Step 1: Get the correct schema URL for the installed version**

```bash
bunx biome --version
```

Note the version number (e.g., `1.9.4` or `2.0.0`).

- [ ] **Step 2: Create biome.json**

Replace `X.Y.Z` in `$schema` with the version from Step 1:

```json
{
  "$schema": "https://biomejs.dev/schemas/X.Y.Z/schema.json",
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

- [ ] **Step 3: Run check to see violations**

```bash
bunx biome check src tests
```

Read through the output. Violations are grouped by rule. `error` level items will block commits once Husky is live; `warn` items (like `noConsole`) do not block.

- [ ] **Step 4: Auto-fix all safe violations**

```bash
bunx biome check --write src tests
```

Biome rewrites formatting (indentation, quotes, semicolons, trailing commas) and safe lint rules in place.

- [ ] **Step 5: Fix remaining errors manually**

```bash
bunx biome check src tests
```

Iterate until zero `error` items remain. Common ones:

- `noExplicitAny` in test helpers: suppress with `// biome-ignore lint/suspicious/noExplicitAny: test mock`
- `useConst`: change `let` to `const` where variable is never reassigned
- `noUnusedVariables`: remove or prefix with `_`
- `noConsole`: these are `warn` — ignore them, they won't block commits

- [ ] **Step 6: Confirm tests still pass**

```bash
bun test
```

Expected: 223 pass. Biome's auto-fix is style-only and should not affect runtime behavior. If tests fail, run `git diff` to inspect what changed and revert any logic-touching edits with `git checkout -- <file>`.

- [ ] **Step 7: Commit**

```bash
git add biome.json src/ tests/
git commit -m "feat: add Biome lint and format config"
```

---

## Task 6: Add Husky Git Hooks

**Context:** The `prepare` script (`"husky"`) already ran during Task 1's `bun install`, so Husky initialized the `.husky/` directory and set `core.hooksPath` in git. We just need to create the hook files.

**Files:**
- Create: `.husky/pre-commit`
- Create: `.husky/pre-push`

- [ ] **Step 1: Create .husky/pre-commit**

```bash
cat > .husky/pre-commit << 'EOF'
bunx lint-staged
EOF
chmod +x .husky/pre-commit
```

- [ ] **Step 2: Create .husky/pre-push**

```bash
cat > .husky/pre-push << 'EOF'
bun test
EOF
chmod +x .husky/pre-push
```

- [ ] **Step 3: Test pre-commit hook**

Stage a trivial change to a TS file:

```bash
echo "" >> src/api.ts
git add src/api.ts
GIT_DIR=$(git rev-parse --git-dir) bash .husky/pre-commit
```

Expected: Biome runs on `src/api.ts` and exits 0. If you see `command not found: bunx`, Husky isn't inheriting your PATH. Add this line to the top of `.husky/pre-commit`:

```sh
export PATH="$HOME/.bun/bin:$PATH"
bunx lint-staged
```

Revert the test change:

```bash
git checkout -- src/api.ts
```

- [ ] **Step 4: Test pre-push hook**

```bash
bash .husky/pre-push
```

Expected: `bun test` runs, 223 tests pass.

- [ ] **Step 5: Commit**

```bash
git add .husky/
git commit -m "feat: add Husky pre-commit lint and pre-push test hooks"
```

---

## Verification Checklist

After all tasks complete, run these end-to-end checks:

- [ ] `bun test` — 223 pass
- [ ] `bunx biome check src tests` — 0 errors
- [ ] `npm run build` — TypeScript type-checks src/ and builds main.js without errors
- [ ] Make a real commit: stage a `.ts` file change → `git commit` → see Biome run on staged files
- [ ] `bun test --coverage` — coverage output renders without errors
