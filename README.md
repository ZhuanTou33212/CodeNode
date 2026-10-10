# CodeNode

**Your local codebase, an agent that can act on it, and a visual workflow canvas — in one desktop window.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/ZhuanTou33212/CodeNode/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhuanTou33212/CodeNode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

![CodeNode agent chat and workflow canvas](docs/screenshots/agent-chat.png)

CodeNode is a local development workbench built with Electron and React. The agent runs in the desktop main process and reads, searches and edits the project you open, while the canvas organises tasks, dependencies and runs you can audit afterwards. A project lives in a single `.cnode` file; your source code stays where it is.

**Status:** pre-1.0, actively developed by a single maintainer. Runtime dependencies are deliberately few — React, Zustand and `@xyflow/react`.

## Why CodeNode

Most agent projects optimise for capability. CodeNode also makes a run survive a crash, a cancelled request or a wrong edit without lying about the outcome:

- **Durable runs** — every tool call is checkpointed, and a write is keyed by a content hash scoped to the original run, so resuming skips what already committed and refuses to blind-replay an unknown result. → [run safety and recovery](docs/run-recovery.md)
- **Verifiable delegation** — a subagent's answer is a candidate, and declared artifacts are re-hashed against disk before anything flows downstream. → [multi-agent collaboration](docs/multi-agent.md)
- **Goals that can fail** — acceptance evidence carries a file fingerprint, commit and environment, and expires when they change. → [canvas, workflows and goals](docs/canvas-and-goals.md)
- **Swappable backends** — the built-in agent and external agents share one ACP v1 contract. → [agent backends](docs/backends.md)

## Quick start

Node.js 22.12 or newer, plus a desktop environment able to run Electron (CI pins the 22 line via `.nvmrc`).

```powershell
git clone https://github.com/ZhuanTou33212/CodeNode.git
cd CodeNode
npm ci
npm run dev
```

`npm run dev` starts Vite and Electron together. The packaged Windows build runs from `release/win-unpacked/CodeNode.exe`; macOS and Linux targets exist in the build config (`npm run dist:mac`, `npm run dist:linux`) but are not published as releases today.

### First run

1. Choose **New project**, **Open project** or **Open project file** — an existing `.cnode` file opens directly.
2. Under **Agent → Manage models…** pick a provider, paste an API key, click **Fetch models**, then **Connect and use**. No model ID, base URL, context size or price to type in.
3. Start read-only: "Find the project entry point, explain the startup flow, and give me the file paths." **Enter** sends, **Shift+Enter** inserts a newline.
4. To change code, state the scope and the acceptance conditions, watch the tool calls, and confirm what the UI asks about. You can interject or stop while a run is in progress.
5. **Ctrl+S** saves the project; the **Run** tab at the bottom shows the recovery plan after an interruption.

## Core capabilities

| Capability | What it does |
| --- | --- |
| Project-aware agent | Reads, searches and edits project files, runs approved tools and commands, and shows the calls it makes. |
| Single-agent ReAct run | Handles model responses, tool calls, approvals, cancellation, failures and budget stops inside an explicit run boundary. |
| Resumable run records | Stores events, checkpoints and a side-effect ledger; after an interruption it separates steps that can continue from external operations that need review. |
| Visual workflows | Organises tasks and dependencies with `start`, `task`, `stage`, `tool` and `scope` nodes. |
| Multi-agent delegation | The main agent delegates exploration, implementation, verification and review; results are checked before they reach downstream tasks. |
| [Trellis compatible](docs/trellis-compatibility.md) (Chinese) | Load an existing task's PRD and specs, restore task/run links, and write status, logs and specs back after preview and conflict checks. |
| Streaming replies | SSE token-by-token rendering, configurable and speed-adjustable in General settings. |
| Optional project retrieval | Local lexical and structural search over source and docs; vector retrieval, reranking and strict answer validation are enabled explicitly per scenario. |
| Multiple model providers | OpenAI-compatible endpoints, Anthropic, Gemini, Azure and local servers. |

## Architecture

One agent loop, one run boundary, one execution chain: chat, the canvas and Goal auto-advance all go through it. Retrieval stays local and optional (BM25 plus optional vectors), and a citation must come from a source actually read in that turn.

![Single-agent ReAct run state and recovery](docs/architecture/single-agent-react-state.png)

![Multi-agent delegation and result confirmation](docs/architecture/multi-agent-collaboration.png)

Internals: [run safety and recovery](docs/run-recovery.md) · [multi-agent collaboration](docs/multi-agent.md) · [canvas, workflows and goals](docs/canvas-and-goals.md).

## Development and verification

```powershell
npm run build       # TypeScript check, Vite build and icon check
npm run check:js    # JS type check for the Electron main process and scripts
npm test            # core regression suite (offline, no display)
npm run verify      # build + check:js + core tests
npm run dist:win    # Windows packaging; dist:mac / dist:linux as well
```

| Location | Contents |
| --- | --- |
| `src/` | React UI, canvas and state management |
| `electron/` | Main process: agent loop, tools, sandbox, checkpoints, costs |
| `scripts/` | Regression and gate scripts; `npm run test:list` prints the set |
| `docs/` | Design notes, architecture images and evaluation data |

Executors: the built-in CodeNode agent, plus Codex, DeepSeek Harness, Hermes, OpenCode, OpenClaw and custom ACP agents — all over ACP v1 stdio ([details](docs/backends.md)).

Test principles, the gate list and the release process are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
