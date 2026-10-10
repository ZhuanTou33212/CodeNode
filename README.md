# CodeNode

**Your local codebase, an agent that can act on it, and a visual workflow canvas — in one desktop window.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/ZhuanTou33212/CodeNode/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhuanTou33212/CodeNode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

CodeNode is a local development workbench built with Electron and React. The canvas draws nodes, edges and the grid with HTML Canvas 2D while React Flow keeps interaction and coordinate management; the agent runs in the Electron main process and reads, searches and edits files in the project you open, while the canvas organises tasks and dependencies. Run records, tool results and recovery plans are inspectable in the UI.

A project lives in a single `.cnode` file; your source code stays in the directory you chose. The desktop main process owns files, tools, models and run state, so opening the renderer in a plain browser is not a substitute for the desktop app.

![CodeNode agent chat and workflow canvas](docs/screenshots/agent-chat.png)

**Project status:** pre-1.0, actively developed by a single maintainer. The runtime dependency set is deliberately small — React, Zustand and `@xyflow/react`.

[Design focus](#design-focus-runs-you-can-audit-and-resume) · [Core capabilities](#core-capabilities) · [Quick start](#quick-start) · [Single-agent architecture](#single-agent-architecture) · [Multi-agent collaboration](#multi-agent-collaboration) · [Workflows and retrieval](#workflows-and-retrieval) · [Development and verification](#development-and-verification) · [Agent backends](#agent-backends) · [Goals and node deletion](#goals-and-node-deletion)

## Design focus: runs you can audit and resume

Most agent projects optimise for capability. CodeNode also treats a run as something that must survive a crash, a cancelled request or a wrong edit without silently lying about the outcome:

- **Every tool call is checkpointed.** The side-effect ledger keys a write by a content hash of its canonical arguments, scoped to the *original* Run, so a resumed run skips writes that already committed and refuses to blind-replay ones whose result is unknown ([electron/sideEffects.cjs](electron/sideEffects.cjs), [electron/runCheckpoint.cjs](electron/runCheckpoint.cjs)).
- **The canvas is durable too.** A node must be persisted as `prepared` before it executes, with a compare-and-swap on the graph revision, so an interrupted canvas run can be audited instead of guessed ([electron/workflowState.cjs](electron/workflowState.cjs)).
- **Subagent answers are candidates, not facts.** Declared artifacts are re-hashed against disk before anything flows downstream ([electron/subagentEnvelope.cjs](electron/subagentEnvelope.cjs)).
- **A goal completes on evidence that can expire.** Acceptance evidence carries a source fingerprint, commit and environment; changing the files or the condition invalidates it ([electron/goalStore.cjs](electron/goalStore.cjs)).
- **The model cannot widen its own permissions.** Write tools are refused access to the approval file, and approvals are server-signed tokens bound to a capability, scope and tool call ([electron/approvalRules.cjs](electron/approvalRules.cjs)).
- **Backends are swappable.** CodeNode's own agent loop and external agents (Codex, DeepSeek Harness, Hermes, OpenCode, OpenClaw, custom) all submit through one ACP/BackendPort contract.

The workbench also ships a large offline regression suite; run `npm run test:list` for the current set. The default gate needs no network and no display.

## Core capabilities

| Capability | What it does |
| --- | --- |
| Project-aware agent | Reads, searches and edits project files, runs approved tools and commands, and shows the calls it makes. |
| Single-agent ReAct run | Handles model responses, tool calls, approvals, cancellation, failures and budget stops within an explicit Run boundary. |
| Resumable run records | Stores events, checkpoints and a side-effect ledger; after an interruption it separates steps that can continue from external operations that need review. |
| Visual workflows | Organises tasks and dependencies with `start`, `task`, `stage`, `tool` and `scope` nodes. |
| Multi-agent delegation | The main agent delegates exploration, implementation, verification and review; results are checked before they reach downstream tasks. |
| [Trellis compatible](docs/trellis-compatibility.md) (Chinese) | Select an existing task, load its PRD and specs, restore task/run links; write status, logs and specs back after preview and conflict checks, and bind canvas flows to real role actions. |
| Streaming replies | SSE token-by-token rendering, configurable and speed-adjustable in General settings; the full reply is stored and strict verification rules still apply. |
| Optional project retrieval | Local lexical and structural search over source and docs; vector retrieval, reranking and strict answer validation are enabled explicitly per scenario. |
| Multiple model providers | OpenAI-compatible endpoints, Anthropic, Gemini, Azure and local servers. |

## Quick start

You need **Node.js 22.12 or newer** and a desktop environment able to run Electron; CI pins the 22 line via `.nvmrc`.

```powershell
git clone https://github.com/ZhuanTou33212/CodeNode.git
cd CodeNode
npm ci
npm run dev
```

`npm run dev` starts Vite and Electron together. The packaged Windows build runs directly from `release/win-unpacked/CodeNode.exe`. macOS and Linux targets exist in the electron-builder config (`npm run dist:mac`, `npm run dist:linux`) but are not published as releases today.

To build and run the desktop app in production mode:

```powershell
npm run start:prod
```

### First run

1. On the start page choose **New project**, **Open project** or **Open project file**; an existing `.cnode` file can be opened directly.
2. In the left **Agent → Manage models…** panel pick a provider, paste an API key, click **Fetch models**, choose from the returned list and click **Connect and use**. You do not fill in model IDs, base URLs, context sizes or prices by hand.
3. Start with a read-only task, for example: "Find the project entry point, explain the startup flow, and give me the file paths." **Enter** sends, **Shift+Enter** inserts a newline.
4. When you need edits, state the scope and the acceptance conditions; watch the tool calls and results, and confirm the operations the UI asks about. You can interject or stop while a run is in progress.
5. **Ctrl+S** saves the `.cnode` project. After an interrupted task, open the **Run** tab at the bottom to see the recovery plan.

## Single-agent architecture

The default coding flow is: search for a symbol or error, read the file, edit, run tests. `retrieve_context` is not part of the resident coding tool set — enable it on demand with `discover_tools`, and local retrieval never calls a model to decompose the query. `query_scalars` is a separate canvas-property tool and is unaffected by `rag.enabled`.

Ordinary file reads and writes plus non-delete canvas edits execute automatically; high-risk operations and worktree operations keep their approval step. **Settings → General** can switch automatic execution of ordinary tools per project. The conversation shows "edited N files" with an expandable diff, and editing the same file twice counts once; reasoning, task traces and raw tool records stay in the run data.

**Settings → Retrieval** toggles local retrieval, vector expansion and strict answer validation per project. Vectors and strict validation are off by default, and SQLite vector support plus the Milvus SDK are not installed with the default dependencies — install the extension yourself and repackage if you need them. Explicitly enabled model services still cost extra requests and time.

The single agent is the basic execution unit. Every delegated subtask runs the same ReAct loop internally, so understanding one agent's state machine, tool boundary and recovery behaviour explains the multi-agent layer as well.

**Settings → Cost & models** assigns a connected model to the explorer, builder, verifier, reviewer and canvas roles; by default they follow the model selected in the conversation. Small-task admission is decided locally: a single ordinary operation or a clear single-file read goes back to the main agent rather than starting a submodel. The settings page shows token, cache-hit, retry and cost attribution per task and role, along with run completion and per-check results; a missing price shows as unknown, and completion is never treated as correctness.

Repeated read-only results are reused by reference as long as the body is still intact in the current context; after compaction or truncation the reference is validated and the body is supplied again when the original text is needed. Each role can configure a turn limit, a cumulative token limit and a single-output cap, all inherited by default; the "light exploration preset" offers 6 turns / 60,000 total tokens / 8,192 output tokens and never silently caps complex exploration.

![Single-agent ReAct run state and recovery](docs/architecture/single-agent-react-state.png)

A run starts in `RUNNING`:

- The model returns a final answer → `COMPLETED`.
- The model requests a tool call → streaming arguments are assembled and structurally validated, then the run enters `WAITING_TOOL`, executes the tool, writes the result back into the conversation and returns to `RUNNING`.
- Approval or a question for the user → `WAITING_USER`.
- `FAILED`, `CANCELLED` and `LIMIT_REACHED` are the other terminal states.

**ACTIVE** in the diagram is only a grouping drawn for readability, not an extra state in the code. An ordinary tool failure is handed back to the model as a tool result; only a corrupted stream, a run error, a user cancellation or a budget stop terminates the run by their own rules. The optional Observation/Blackboard layer organises tool results but never replaces the raw tool records.

### Run safety and recovery

Tools are validated by the registry for arguments, capabilities and confirmation policy. Write, command and external-network capabilities execute under their own contracts and leave audit records; operations with side effects use an idempotency ledger so an unknown outcome is never replayed blindly.

Recovery is decided jointly by run events, checkpoints and the side-effect ledger:

1. `planResume` reads the events and checkpoints of the previous run.
2. Steps that are safe and whose result is known resume automatically.
3. Writes or external operations with an unknown result go to manual review.
4. Continuing creates a new run; the old run keeps its original state and evidence.

A stream retry resends the whole turn — a half-received answer is never appended to a new request. Connection retries and stream resends share the same per-call HTTP request cap, and every actual request reserves its input plus maximum output from the run's token budget before it is sent. Configuration lives in `config/agent.properties.example`.

## Multi-agent collaboration

Multi-agent work builds on the single-agent run above. The main agent calls `delegate_task` or `delegate_tasks` when a task needs it, giving each subtask its own prompt, conversation, role permissions, deadline and budget.

![Multi-agent delegation and result confirmation](docs/architecture/multi-agent-collaboration.png)

[Open the scalable SVG](docs/architecture/multi-agent-collaboration.svg)

A bounded FIFO scheduler runs at most **4** subtasks concurrently and shares one global concurrency value with the model request queue. Safe read-only tasks run in parallel; tasks that write to a shared workspace take it exclusively; with `isolation: "worktree"` a writing task runs in its own Git worktree. Canvas roles do not support that mode.

Each run starts at most **24** subtasks by default, at most **8** per batch; at **75%** (18/24) the main agent is told how much budget remains so it converges on planning, verification and summarising. Failed or cancelled-after-start subtasks still count. Request-level transient retries draw on a separate shared retry budget. These options are stored together in **Settings → General → Global scheduling**, shared across projects, restarts and both themes; the desktop app and the CLI read the same user-level `$CODENODE_HOME/agent-scheduling.json` (default `~/.codenode/agent-scheduling.json`).

Redoing a whole task uses `inspect_subagent_retry` to check the execution version, dependencies and compensation plan, then `retry_subagent_task` to run it explicitly. The redo keeps the `taskId`, increments Attempt and creates a fresh `executionId`; the defaults are **3** attempts per task and **72** per run (both including the first). A redo does not add a logical task but consumes attempt allowance and real request budget; file compensation needs approval, and later edits, unknown side effects or already-merged code block it. The run panel keeps the attempt history.

| Role | Responsibility | Boundary |
| --- | --- | --- |
| `explorer` | Locate files, symbols and evidence | Read-only; no file changes, no commands |
| `builder` | Implement changes within the task scope | Writes constrained by permissions and confirmation policy |
| `verifier` | Run tests, builds and checks | Does not modify the code under test |
| `reviewer` | Independently review the implementation and edge cases | Read-only; does not fix what the builder wrote |
| `canvas` | Edit and save the canvas | Does not write project source files |

A subagent's answer is a **candidate result**. The main agent can read the task envelope, check the source and artifacts, and have `verifier` re-run the work independently; only a confirmed and still-valid summary is passed downstream through `dependsOnTaskIds`. `merge_subagent_results` summarises candidate claims — it never merges Git code for you.

When you use isolated worktrees, preview files, branch versions and content fingerprints with `inspect_merge` first, then confirm `merge`. Conflicts or version drift block downstream work, and changes from other tasks in the main worktree are never rolled back automatically.

## Workflows and retrieval

A canvas workflow orders execution by node connections; a chat task is executed by the agent against the current project and available tools. Both live in the same workbench, but drawing a `stage` node does not start a subagent.

The visible graph layer uses Canvas 2D, while node selection, dragging, connection hit-testing, zooming and keyboard operations stay on a transparent interaction layer. Selecting an image, object, scope or embedded vector-canvas node shows its editing controls temporarily above the layer. The saved format remains node and edge data and does not depend on screen pixels.

Press **Shift+A** on an empty canvas to add a node; the minimal runnable chain is `start → task → end`. Select a node, fill in its goal and connect from its ports. The **Run** button on top opens the bottom panel — start the workflow from the "Continuous execution" tab. "Data flow" only computes node inputs and outputs.

Typing `/plan <task goal>` makes CodeNode use its built-in planning model to generate read-only steps and create editable task nodes with dependency edges in the current canvas. Review the result and click "Continuous execution" to run it. An existing agent `update_plan` plan can also be imported once from the plan card with "Generate editable workflow"; later canvas edits are never overwritten by the plan card.

`/goal <description>` opens the goal form, asks for at least one verifiable acceptance condition and creates a Goal; CodeNode then generates a task-graph preview that you confirm before it is written into the Goal. The "Task graph" view in the goal details shows the Tasks and `dependsOn` from `.codenode/goals.json`, and you can add, edit and connect them by hand. A node can bind one of the Goal's acceptance conditions: intermediate tasks that carry no overall condition submit only their own stage evidence, while the final acceptance task takes the overall conditions. Click a node to see the agent's stage summary and the current acceptance evidence. Only Tasks that have not run and have no downstream dependency can be deleted; Tasks with a Run or evidence keep their history. "Start executing goal" advances stage by stage under the Goal's own admission, budget, write-scope, settlement and evidence rules, and stops on a wait, a failure, insufficient evidence or a required manual review. The planning model and the execution backend are configured separately.

![CodeNode workflow canvas](docs/screenshots/codenode-canvas.png)

Local agentic RAG builds a BM25 index over project files, with optional vector backends (`memory` in-process by default, or SQLite/Milvus). A retrieval hit only helps you locate something; a citation still has to come from a source actually read in that turn. The settings entry is the "Retrieval settings" tab in the bottom workbench.

The `.cnode` container stores the canvas, sessions, workspace and integrity information; `.codenode/` stores project-level run records, indexes and scalar data. The model list lives in the Electron user data directory, and API keys require OS secure storage.

## Development and verification

```powershell
npm run build       # TypeScript check, Vite build and icon check
npm run check:js    # JS type check for the Electron main process and scripts
npm test            # core regression suite
npm run verify      # build + check:js + core tests
npm run dist:win    # Windows packaging; dist:mac / dist:linux as well
```

| Location | Contents |
| --- | --- |
| `src/` | React UI, canvas and state management |
| `electron/agent.cjs`, `electron/agentState.cjs` | Agent tool loop and Run state machine |
| `electron/tools/`, `electron/subagents.cjs` | Tool permissions, confirmation, subagent delegation and result verification |
| `electron/runStore.cjs`, `electron/runCheckpoint.cjs` | Run events, checkpoints and recovery plans |
| `docs/` | Latest design notes, architecture images and evaluation data |

Development entry points are documented in [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese) and the [scripts directory](scripts/README.md) (Chinese); the CI and test-gate rules are the same files.

### Agent backends

At the top of the chat panel, choose the executor under **Chat / Agent name**. Selecting is only a preview; **Confirm switch** saves it. Switching keeps the same conversation, messages, input draft and canvas, and the next message is handled by the new agent. The entry is disabled while a run or a switch is in progress. The Agent menu is for switching only — it does not duplicate connection settings — and it marks the current agent with a checkmark. Entries whose local launch command is missing or unconfigured are greyed out with an "unavailable" note, based on command probing only, with no model request; full connection tests live in Settings. Connection paths, arguments, authentication and MCP are still configured in **Settings → Agent connection**, where you can pick CodeNode (its own agent), Codex ACP, DeepSeek Harness ACP, Hermes, OpenCode, OpenClaw or a custom ACP agent. Every external backend goes through ACP v1 over stdio, and the UI, canvas workflows and Goal auto-advance share that one execution chain. A quick switch with a project open saves the choice for that project and otherwise saves the machine default. Each agent remembers its own connection configuration and restores the existing command, arguments, model and ACP settings when you switch back; the advanced settings still let you change the configuration scope, and a project can follow the machine settings.

| Backend | Installed launch command | Default arguments |
| --- | --- | --- |
| Codex | `codex-acp` | none; needs an existing Codex CLI and local login |
| DeepSeek Harness | `dsh` | `--profile acp`; an existing `DSH_HOME` is picked up |
| Hermes | `hermes` | `acp` |
| OpenCode | `opencode` | `acp` |
| OpenClaw | `openclaw` | `acp`; needs a working Gateway |
| Custom ACP | your own command or absolute path | your own JSON argument array |

CodeNode never downloads an agent and never installs through `npx`. Launch commands are resolved from `PATH` and the Windows npm global directory, including npm JS/native shims, and shell command strings are never concatenated. Leaving the model blank follows the agent's native configuration; authentication, skills and native tools are managed by the agent itself. A manual Windows system proxy is injected only into that run's subprocess, and only when no explicit proxy environment variable is set; neither system nor account settings are modified.

The shared backend contract follows [qwen-audio-agent BackendPort](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/src/backend/backend-port.mjs):

- `describe`: identity, transport and capabilities; `start`: idempotent connection preparation without sending a model prompt; `health`: current availability.
- `submit`: submit a Task; `status`: Task status within the running process or owner scope; `cancel`: cancel a given Task.
- `respondAuthorization` / `respondInput`: answer the pending request for the current Task/owner; cross-Task, cross-owner, unknown and duplicate replies are rejected.
- `subscribe`: subscribe to message/state/activity/authorization/input/artifact events carrying Task/owner; `close`: idempotently release the connection and pending requests.

The built-in executor also submits through BackendPort and keeps using CodeNode's own model and tool loop internally. The ACP client shares initialisation, session create/load/resume, text and multimedia prompts, permissions, cancellation, configuration and error handling. The old Codex app-server and DeepSeek SDK JSON-RPC adapters have been removed; the background calls really go through the contract above.

"Detect current configuration" only validates ACP initialisation for the current command and arguments. It writes no settings and sends no model request. The old default `codex` and saved Codex CLI paths are rewritten to the adapter command, and DeepSeek's old `--profile sdk` becomes `--profile acp`; once saved this persists as settings version 2. Other custom commands are preserved and you must confirm that they support ACP. Old app-server/SDK runs keep their history but cannot be resumed through ACP — review the old run and the project diff, then start a new ACP session. Session IDs are never converted silently and side effects are never replayed.

The UI conversation and the internal ACP session are managed separately. An explicit agent switch persists the conversation binding and the switch generation in the project's `backend.json` without rebuilding the UI conversation; within the same generation the exact ACP session ID is reused, while a cross-agent switch or a switch back starts a new internal session and hands over the visible history plus the current canvas as context. Switching to CodeNode goes straight to the built-in model loop and is not taken over by an old external session. Isolated tasks create a new internal session. When a result is unknown you must review it and resume explicitly. A Run stores the protocol, session, permissions, state, events and project file fingerprints, and code changes always require independent local validation. Non-terminal results such as `max_tokens` are recorded as failures and cannot serve as completion evidence. Goal admission, budget, write scope, restart-with-unknown-state and acceptance-evidence rules all still apply.

Every external backend shares the same **ACP permission policy**: read-only requests refuse privilege escalation and writes ask each time. Client-side file reads and writes stay inside the project boundary and are checked for file fingerprints, editor drafts and Task write scope before submission; the terminal reuses the local sandbox policy. An agent's native tools are not comprehensively intercepted by CodeNode, ACP permissions are not operating-system isolation, and external usage or cost may be unknown.

**ACP session configuration** persists `authMethodId`, `modeId`, `configValues`, `mcpServers` and `codeNodeTools`. "Read ACP options" queries the values that are actually available, and authentication and control are executed according to the agent's declared capabilities. Images, audio and resources are checked for capability before they are sent, and unknown client methods return `-32601`. Form elicitation supports structured field replies, and a single string field accepts plain text; URL authentication or interactive terminal login is handled by the agent itself. When a turn needs CodeNode's canvas and project tools, the MCP relay can be enabled explicitly for that turn, reusing the existing role, capability, scope, approval and cancellation gates.

Offline acceptance: `npm run test:backend-port`, `test:backends`, `test:multi-backends`, `test:acp-full` and `test:backend-workflow`. Dual theme and settings persistence: `test:backend-ui`. Explicit real-model acceptance: `test:goal-auto-live` (OpenCode auto-advance), `test:backend-live` (Codex ACP), `test:backend-live-deepseek` (DeepSeek ACP) and `test:backend-live-workflow` (isolated source task). These require an existing agent and credentials, may incur model usage, and are not part of offline CI.

References: [qwen-audio-agent backend integration](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/backends/overview.md), [ACP v1](https://agentclientprotocol.com/protocol/v1/overview). The real model path was verified locally with OpenCode; a machine without `codex-acp` or `dsh` is not reported as tested.

### Goals and node deletion

The **Overview / Conversation** buttons at the top of the workbench switch between two independent pages. Overview shows a short project brief, pending items and a single-column goal list; with no goals it shows neither statistic cards nor a permanent form, and the editor opens only after you click "New" or a goal entry. The Conversation page keeps the canvas and the chat and shows a short goal hint only when a task is bound. Both pages stay mounted, so switching back and forth preserves messages, input drafts, canvas, model and any unsaved goal form. The current page is persisted in the shared UI configuration and can also be set in **Settings → General → Default workbench**.

To delete a node, click its title or border and press Delete / Backspace / X; Ctrl+Z undoes it. When a graphic inside the node is selected, Delete removes only that graphic; clicking inner blank space with only the outer node selected removes the whole node. Deleting a graphic clears the outer selection so repeated key presses cannot delete the node by accident, and a focused input or goal control never deletes canvas nodes. The bottom status bar shows the actual multi-selection count and the current deletion target, and adding, loading, undoing and redoing keep the visual selection in sync with the real one.

[Night theme](docs/validation/simple-overview-preview/dark.png) · [Light theme](docs/validation/simple-overview-preview/light.png). `npm run test:workspace-ux-ui` drives real mouse and keyboard events to verify the behaviour above; the packaged acceptance evidence is in [acceptance.json](docs/validation/workspace-ux-preview/acceptance.json).

## License

[MIT](LICENSE)
