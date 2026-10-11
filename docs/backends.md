# Agent backends

[English](backends.md) · [简体中文](backends.zh-CN.md)

CodeNode can run its own agent loop or hand the same conversation to an external agent over **ACP v1 (stdio)**. The UI, canvas workflows and Goal auto-advance all use this one execution chain; only the executor changes.

## Choosing an executor

At the top of the chat panel, pick the executor under **Chat / Agent name**.

- Selecting an entry is a preview; **Confirm switch** saves it.
- Switching keeps the same conversation, messages, input draft and canvas — the next message is handled by the new agent.
- The entry is disabled while a run or a switch is in progress.
- The menu is for switching only (no duplicate connection settings) and marks the current agent with a checkmark.
- Entries whose local launch command is missing or unconfigured are greyed out as "unavailable". That check is command probing only — no model request. Full connection tests live in Settings.
- A quick switch with a project open saves the choice for that project; without a project it saves the machine default.
- Each agent remembers its own connection configuration and restores the existing command, arguments, model and ACP settings when you switch back. Advanced settings can change the configuration scope, and a project can follow the machine settings.

Connection paths, arguments, authentication and MCP are configured in **Settings → Agent connection**.

| Backend | Installed launch command | Default arguments |
| --- | --- | --- |
| Qwen Code | `qwen` | `--acp`; uses Qwen Code's native stdio ACP entry |
| OpenCode | `opencode` | `acp` |
| OpenClaw | `openclaw` | `acp`; needs a working Gateway |
| Qoder | `qodercli`, falling back to `qoder` | `--acp` |
| MiniMax Code | `mcode` | `acp`; requires MiniMax Code 0.3.7 or newer |
| Kimi Code | `kimi` | `acp`; requires Kimi Code 0.31.0 or newer |
| Hermes | `hermes` | `acp` |
| CodeBuddy | `codebuddy` | `--acp` |
| Codex | `codex-acp` | none; needs an existing Codex CLI and local login |
| Claude Code | `claude-agent-acp`, falling back to the legacy `claude-code-acp` | none; needs an existing Claude Code login |
| DeepSeek Harness | `dsh` | `--profile acp`; an existing `DSH_HOME` is picked up |
| Pi | `pi-acp` | none; needs the `pi` agent itself. Pi has no sandbox and `pi-acp` sends no permission requests |
| Muse Code | `muse` | `serve`; speaks MSP rather than ACP and needs a local Muse Code install |
| Custom ACP | your own command or absolute path | your own JSON argument array |

CodeNode never downloads an agent and never installs through `npx`. Launch commands are resolved from `PATH` and the Windows npm global directory, including npm JS/native shims (`.cmd` shims whose target is a `.js`/`.mjs`/`.cjs` file, a Windows `.exe`, or an extension-less launcher that proves itself with a Node shebang); a documented alias is only tried when the primary name is missing, and shell command strings are never concatenated. Leaving the model blank follows the agent's native configuration; authentication, skills and native tools are managed by the agent itself. A manual Windows system proxy is injected only into that run's subprocess, and only when no explicit proxy environment variable is set; neither system nor account settings are modified.

## BackendPort contract

The shared contract follows [qwen-audio-agent BackendPort](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/src/backend/backend-port.mjs):

- `describe`: identity, transport and capabilities; `start`: idempotent connection preparation without sending a model prompt; `health`: current availability.
- `submit`: submit a Task; `status`: Task status within the running process or owner scope; `cancel`: cancel a given Task.
- `respondAuthorization` / `respondInput`: answer the pending request for the current Task/owner; cross-Task, cross-owner, unknown and duplicate replies are rejected.
- `subscribe`: subscribe to message/state/activity/authorization/input/artifact events carrying Task/owner; `close`: idempotently release the connection and pending requests.

The built-in executor also submits through BackendPort and keeps using CodeNode's own model and tool loop internally. The ACP client shares initialisation, session create/load/resume, text and multimedia prompts, permissions, cancellation, configuration and error handling. Muse Code uses the same contract but speaks MSP instead of ACP (see below). The old Codex app-server and DeepSeek SDK JSON-RPC adapters have been removed; background calls really go through the contract above.

## Configuration detection and migration

"Detect current configuration" only validates ACP initialisation for the current command and arguments. It writes no settings and sends no model request.

The old default `codex` and saved Codex CLI paths are rewritten to the adapter command, and DeepSeek's old `--profile sdk` becomes `--profile acp`; once saved this persists as settings version 2. Other custom commands are preserved and you must confirm that they support ACP. Old app-server/SDK runs keep their history but cannot be resumed through ACP — review the old run and the project diff, then start a new ACP session. Session IDs are never converted silently and side effects are never replayed.

## Conversations, sessions and run records

The UI conversation and the internal ACP session are managed separately.

- An explicit agent switch persists the conversation binding and the switch generation in the project's `backend.json` without rebuilding the UI conversation.
- Within the same generation the exact ACP session ID is reused; a cross-agent switch or a switch back starts a new internal session and hands over the visible history plus the current canvas as context.
- Switching to CodeNode goes straight to the built-in model loop and is not taken over by an old external session. Isolated tasks create a new internal session.
- Muse Code session handles live for one turn only: no resumable protocol session record is written, so every turn starts a new Muse session and carries the visible history plus the current canvas over as context.
- When a result is unknown you must review it and resume explicitly.
- A Run stores the protocol, session, permissions, state, events and project file fingerprints, and code changes always require independent local validation.
- Non-terminal results such as `max_tokens` are recorded as failures and cannot serve as completion evidence.
- Goal admission, budget, write scope, restart-with-unknown-state and acceptance-evidence rules all still apply — see [canvas and goals](canvas-and-goals.md).

## Permissions and isolation

Every external backend shares the same **permission policy**: read-only requests refuse privilege escalation and writes ask each time — ACP over `session/request_permission`, Muse Code over MSP's `approval/request`, with identical meaning. Client-side file reads and writes stay inside the project boundary and are checked for file fingerprints, editor drafts and Task write scope before submission; the terminal reuses the local sandbox policy.

An agent's native tools are not comprehensively intercepted by CodeNode, ACP permissions are not operating-system isolation, and external usage or cost may be unknown. The local isolation CodeNode itself provides is described in [run safety and recovery](run-recovery.md).

**Exception: Pi sends no permission requests.** `pi-acp` does not implement ACP `session/request_permission`, and Pi officially has no built-in sandbox — its read/write/bash run directly with the current user's privileges. Neither read-only nor per-write approval can constrain Pi. CodeNode does not pretend otherwise: the settings panel warns as soon as Pi is selected, the capability snapshot returns `permissionEnforcement: "unavailable"`, and a `backend_info` event states the limitation before the turn starts. Use Pi only with trusted projects and trusted prompts.

## ACP session configuration

**ACP session configuration** persists `authMethodId`, `modeId`, `configValues`, `mcpServers` and `codeNodeTools`. "Read ACP options" queries the values that are actually available, and authentication and control are executed according to the agent's declared capabilities.

Images, audio and resources are checked for capability before they are sent, and unknown client methods return `-32601`. Form elicitation supports structured field replies, and a single string field accepts plain text; URL authentication or interactive terminal login is handled by the agent itself. When a turn needs CodeNode's canvas and project tools, the MCP relay can be enabled explicitly for that turn, reusing the existing role, capability, scope, approval and cancellation gates.

## Muse Code and MSP

Muse Code is not an ACP agent: it speaks Meta's **Muse Session Protocol (MSP)**. CodeNode starts a `muse serve` child, runs MSP (newline-delimited JSON-RPC 2.0) over its stdio, and maps MSP execution items, permission requests, supplementary input, cancellation and final messages onto the same BackendPort.

- Handshake: `initialize` (`clientInfo`) → validate `schema.version === 1` → send the `initialized` notification. An incompatible version fails instead of being guessed at.
- Session: `session/start` with UUIDv7 `commandId`/`sessionId`, `workspaceRoot` and an optional `modelId`. Write mode sends **no** `approvalMode`, so Muse keeps its own default approval mode and nothing is pre-authorised.
- Turn: `turn/start` (`input` text and inline images, `displayText`, `ifBusy: "queue"`) → streamed `item/*` deltas → `turn/completed` as the single authoritative terminal event. `item/delta` carries the text and reasoning progressively, and `item/completed` only appends what the deltas did not already cover, so the answer is never duplicated.
- Permissions: `approval/requested` (notification) and `approval/request` (server request) are two channels for the same ask; the request only gets an empty `{}` receipt. The real decision goes through `approval/decide` with the current `requirementId` so multi-stage races are rejected. Read-only picks the rejection option without asking; write mode asks each time and **only ever picks the single-use allow**, never escalating a grant into a session or provider-persistent policy.
- Supplementary input: `userInput/requested` / `userInput/request` work the same way, answered through `userInput/answer` (a single choice maps to the offered label, multi-select and free text use Muse's declared fields), falling back to `userInput/cancel` when nothing is answered.
- Cancellation: `turn/cancel` is only ever sent for the `turnId` this backend started. There is no `session/close`; shutdown closes stdin so Muse drains and exits on its own.
- Workspace: on Windows Muse usually lives inside WSL2 and is launched through `wsl.exe`. The **workspace** field carries the path Muse sees inside Linux and becomes `workspaceRoot`; when blank the project directory is used.
- Limits: Muse session handles are not persisted across restarts, and CodeNode tools are not injected (no MCP relay). Attachments are limited to inline images; other types are refused explicitly. Workspace changes still land in the selected project and are checked independently by CodeNode.

## Acceptance

Offline: `npm run test:backend-port`, `test:backends`, `test:multi-backends`, `test:muse-backend`, `test:acp-full` and `test:backend-workflow`. Dual theme and settings persistence: `test:backend-ui`.

Explicit real-model acceptance: `test:goal-auto-live` (OpenCode auto-advance), `test:backend-live` (Codex ACP), `test:backend-live-deepseek` (DeepSeek ACP), `test:backend-live-agents` / `test:backend-live-workflow` (`--backends=` accepts any installed Qwen Code, Qoder, MiniMax Code, Kimi Code, CodeBuddy, Claude Code or Pi backend) and `test:backend-live-openclaw`. These require an existing agent and credentials, may incur model usage, and are not part of offline CI.

References: [qwen-audio-agent backend integration](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/backends/overview.md), [per-backend configuration](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/backends/configuration.md), [ACP v1](https://agentclientprotocol.com/protocol/v1/overview). The real model path was verified locally with OpenCode; a machine without `codex-acp` or `dsh` is not reported as tested.
