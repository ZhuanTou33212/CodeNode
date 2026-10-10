# Contributing

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

CodeNode desktop is an Electron main process (`electron/`), a React renderer (`src/`) and an executable suite of regression and gate scripts (`scripts/`).

## Environment

| Item | Requirement |
|---|---|
| Node | **22.12 or newer** (`engines` in `package.json` defines the minimum; CI uses `node-version-file: .nvmrc`, pinned to the 22 line) |
| Package manager | npm (`package-lock.json` is committed; CI uses `npm ci`) |
| Line endings | LF everywhere (`.gitattributes` enforces it — do not commit CRLF on Windows with `core.autocrlf=true`), 2-space indentation (`.editorconfig`) |

```bash
npm ci
npm run dev          # renderer (vite) + Electron (VITE_DEV_SERVER_URL)
```

## Before you commit

```bash
npm run verify       # = build (tsc + vite) + check:js (Electron/scripts static checks) + full regression and gates
```

Run the pieces separately:

| Command | Coverage |
|---|---|
| `npm run build` | `tsc --noEmit` over `src/` + the vite build + icons |
| `npm run check:js` | checkJs static checks for `electron/**` and `scripts/**` (they are `.cjs`, so `tsc` over `src/` does not cover them). **Two tiers**: `electron/**` uses `tsconfig.checkjs.json` (with `strictNullChecks`), `scripts/**` uses `tsconfig.checkjs-scripts.json` (looser) |
| `npm test` | **core suite**: regressions and gates that need no display environment; the current set and count come from `npm run test:list` (this is what CI runs) |
| `npm run test:display` | Cases that need an Electron window or the local headless Edge (smoke, RAG UI, vector canvas) |
| `npm run test:list` | Print the suite list |

Scripts are grouped by purpose into `scripts/core`, `scripts/ui`, `scripts/packaged`, `scripts/eval` and `scripts/tools`; shared code and inputs stay in `scripts/lib` and `scripts/fixtures`. The grouping and the manual acceptance entry points are documented in the [scripts directory](scripts/README.md).

For a single failing area: `npm run test:sandbox`, `npm run test:eval -- --list`, and so on. The unified runner accepts
`--only test:eval,test:sandbox` and `--stop-on-fail`.

### Test principles (please follow)

1. **Judge only on the end state**: file bytes, real tool return values, Run JSONL, the exit code of an independent re-run — never the model's own account of what it did.
2. **Do not bypass the built-in agent toolchain**: go through `AgentToolkit.buildDefaultRegistry + registry.execute` / `agent.runAgentChat`; never call `RunLauncher` / `BuildRunner` directly just to make a test pass.
3. **Never fake it**: when a capability is missing, degrade honestly and write an audit record (`sandbox.capabilities()` must not overstate isolation, and a missing backend must not pretend to be isolated).
4. **Assertions must have force**: isolation assertions should prove the kernel really blocked something (process count, memory limit, orphan cleanup), not that "an error string came back".

## Repository layout

| Directory | Contents |
|---|---|
| `electron/` | Main process: `main.cjs` (window and IPC), `agent.cjs` (tool loop), `tools/` (tool registry and implementations), `sandbox.cjs` (execution isolation), `runCheckpoint.cjs` (resume), `sideEffects.cjs` (idempotency), `costLedger.cjs` + `alerts.cjs` (cost and alerts), `selfTest.cjs` (release self-check) |
| `src/` | Renderer (React + zustand + xyflow); `src/vector/` is the vector studio |
| `scripts/*-test.cjs` | Regression cases (plain Node assertions, see above) |
| `scripts/core/runtime-gate.cjs` | **Runtime gate**: asserts those capabilities are really wired up and usable (not that "some string appears in the source") |
| `docs/` | Latest design notes, architecture images and evaluation data; `docs/eval-reports/` is **generated** (CI uploads it as an artifact, it is not committed) |

## Documentation is bilingual

The default branches show the English entry point: `README.md`, `CONTRIBUTING.md` and `scripts/README.md`; their full Chinese counterparts are `README.zh-CN.md`, `CONTRIBUTING.zh-CN.md` and `scripts/README.zh-CN.md`. Every pair must keep matching structure, commands, numbers and links — change one and update the other, keeping the language switcher line at the top.
`scripts/eval/rag-eval.cjs` indexes both READMEs, so update its `include` list when you add a root-level document. `.github/pull_request_template.md` carries both languages in one file because GitHub only renders a single default template; `docs/**` is Chinese-only today, and the English README marks those links as "(Chinese)".

## Do not commit generated artifacts

- `docs/eval-reports/` (agent evaluation reports, produced by `npm run test:eval`)
- `.codenode-selftest/` (temporary build and backups of the release self-check), `.codenode/tmp-sandbox/`
- `.codenode/tools_trace.jsonl` (runtime trace, appended by a single test run)
- `out/` (UI verification screenshots)

`build/icon.ico` and `build/icon-*.png` are generated from `codenode-icon.png` by `npm run icons:build`. **The rendered result is platform-dependent**, so the script keeps a source hash manifest (`build/.icon-source.sha256`) and will not rewrite them while the source image is unchanged — do not re-commit icons just to make the tree look tidy.

## Branches and pull requests

- The default branch is `main` (the same line as `0_2`) and it is what GitHub renders on the repository home page; `yimi-branch` is the active development line — fast-forward it into `main` once work is complete and verified. The two once drifted 81 commits apart, which left stale documentation on the home page, so check `git rev-list --count origin/main..yimi-branch` before a release or a public demo.
- Pushing to `main` directly is allowed, but **changes to the gates, execution isolation, signing or the release process** should go through a pull request, self-checked with the list in [.github/pull_request_template.md](.github/pull_request_template.md).
- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) and the production gate ([production-gate.yml](.github/workflows/production-gate.yml)) run on every branch push and every pull request. Both call `npm test`, and **the gate list is maintained in exactly one place: `scripts/run-all-tests.cjs`**.
- Commit messages use a conventional prefix (`feat:` / `fix:` / `refactor:` / `chore:` / `docs:`) and explain the motive and the verification method from the second line on. The existing history is written in Chinese; English messages are fine for outside contributions.

## Releases

The version number lives only in `package.json`; tags use `vX.Y.Z`; release artifacts must be signed
(`npm run release:sign`) — an unsigned Windows portable build gets misreported or tampered with by security software.
