# Canvas, workflows and goals

[English](canvas-and-goals.md) · [简体中文](canvas-and-goals.zh-CN.md)

The canvas is a real workflow engine, not a sketch pad: execution state is persisted by the main process, and the same project file carries the graph, the sessions and the Goal records.

## The canvas

![CodeNode workflow canvas](screenshots/codenode-canvas.png)

- The visible graph layer uses Canvas 2D; node selection, dragging, connection hit-testing, zooming and keyboard operations stay on a transparent interaction layer.
- Selecting an image, object, scope or embedded vector-canvas node shows its editing controls temporarily above the layer.
- The saved format remains node and edge data and does not depend on screen pixels. `显示全部节点` (View → show all nodes) fits every node into the canvas viewport.
- Press **Shift+A** on an empty canvas to add a node; the minimal runnable chain is `start → task → end`. Select a node, fill in its goal and connect from its ports.
- The toolbar **✦ 画布节点** button and the canvas-node entry in the Shift+A menu are one and the same path: they ignore the cursor, place the node at the centre of the visible canvas and zoom out one step so the whole canvas node stays visible (a canvas node is 1040×640 by default — larger than most viewports).
- The **Run** button on top opens the bottom panel — start the workflow from the "Continuous execution" tab. "Data flow" only computes node inputs and outputs.

A canvas workflow orders execution by node connections; a chat task is executed by the agent against the current project and available tools. Both live in the same workbench, but drawing a `stage` node does not start a subagent. Node execution goes through the same run chain as chat (see [run safety and recovery](run-recovery.md)): a node is persisted as `prepared` before it runs, with a compare-and-swap on the graph revision.

## Planning a workflow

Typing `/plan <task goal>` makes CodeNode use its built-in planning model to generate read-only steps and create editable task nodes with dependency edges in the current canvas. Review the result and click "Continuous execution" to run it.

An existing agent `update_plan` plan can also be imported once from the plan card with "Generate editable workflow"; later canvas edits are never overwritten by the plan card.

## Goals

`/goal <description>` opens the goal form, asks for at least one verifiable acceptance condition and creates a Goal. CodeNode then generates a task-graph preview that you confirm before it is written into the Goal.

- The "Task graph" view in the goal details shows the Tasks and `dependsOn` from `.codenode/goals.json`, and you can add, edit and connect them by hand.
- A node can bind one of the Goal's acceptance conditions: intermediate tasks that carry no overall condition submit only their own stage evidence, while the final acceptance task takes the overall conditions.
- Click a node to see the agent's stage summary and the current acceptance evidence. Only Tasks that have not run and have no downstream dependency can be deleted; Tasks with a Run or evidence keep their history.
- "Start executing goal" persists execution intent in the main process and advances under the Goal's admission, budget, write-scope, settlement and evidence rules. Closing the editor, switching views or reloading the renderer retains that intent. Supplying valid evidence for the current Task allows the scheduler to reconsider its downstream Tasks.
- The main process checks time, GitHub Actions and Agent Eval waits. Resuming after a wait still requires Goal authorization and consumes its automatic-attempt allowance; revocation blocks a claimed continuation that has not started. "Stop subsequent stages" persists the stop request and allows the current Run to finish.
- Contract changes, failure and unknown results block continuation, with review reasons shown in the overview. Startup reconciles persisted Runs: unadmitted claims are not retried, unknown effects require review, and safe between-stage waits can resume when the project is bound again. Scheduling operates while the application has a live session window bound to the project.
- Acceptance evidence carries a source fingerprint, commit and environment; changing the files or the condition invalidates it. A Goal is never marked complete on a model's own claim.
- Automatic code verification records stage evidence only; it does not satisfy the Task's bound Goal criteria. After execution, select each applicable criterion under independent acceptance and run a command that checks it. The Task completes once all its bound criteria have valid evidence. Legacy local verification copied onto Goal criteria remains in history but no longer qualifies acceptance.
- Per-criterion regression and fixed-path package self-test results: [2026-10-12 validation](validation/goal-criterion-acceptance-2026-10-12.json).
- Independent acceptance commands are mutually exclusive with Agent writes. Evidence recording atomically checks the approved Goal contract: a passing command cannot certify criteria or scope revised while it was running.
- Main-process scheduling, renderer reload, waiting authorization and package results: [2026-10-13 validation](validation/goal-main-scheduler-2026-10-13.json). Deadline inputs use the device's local time zone; completed Goals with stale evidence are marked for recheck in the overview.
- The planning model and the execution backend are configured separately (see [backends](backends.md)).
- Each Goal Task request derives a fresh handoff from persisted project records: direct and earlier predecessors, latest Run outcomes and summaries, evidence freshness, relevant decisions and current acceptance criteria. Foreign Goals and unrelated branches are excluded; historical completion never upgrades stale evidence.
- Handoffs are reference data. Long summaries, commands and results are explicitly marked excerpts; command previews are not complete executable commands. Optional handoff data is reduced to fit the existing dynamic context budget. Required criteria and rules retain their original text, and an oversized required context stops explicitly. Internal bounds are centralized in `config/goal.handoff.json`.
- Handoff, actual post-reload requests and fixed-path delivery results: [2026-10-13 handoff validation](validation/goal-handoff-2026-10-13.json).
- Acceptance and waiting-authorization holds affect their dependent branches; unrelated explicitly started stages may proceed. Failures and unknown outcomes still stop automatic continuation. A polling deadline alone does not release a waiting Task.
- Reaching a budget ceiling prevents new Runs. Already completed, verified work can complete a Goal at the ceiling when usage has not exceeded it and capped costs are known. Overspend or unknown capped costs remain blocking.
- Built-in model requests reserve estimated input and output against the remaining Goal allowance and lower the actual `max_tokens` accordingly; if the input cannot fit, the request is not sent. ACP v1 `usage_update.used/size` describes current session context occupancy rather than cumulative consumption ([ACP spec](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/prompt-turn.mdx#session-usage-updates)). CodeNode uses only an explicitly reported `total_tokens` value for token-overrun cancellation.
- When ACP reports cumulative USD session cost, CodeNode subtracts the last persisted value for the same session and charges the run delta, requesting cancellation if that delta exceeds the Goal allowance. Missing usage, cost baseline or USD currency marks the budget for review. A source-noted cumulative Token/USD reconciliation is required before another capped run; external cancellation still depends on timely provider reports.
- Fixed package checks for Goal token admission, USD session-cost deltas, request reservations, overruns and manual reconciliation: [2026-10-13 budget validation](validation/goal-budget-enforcement-2026-10-13.json).
- Token reconciliation requires a source note, cannot lower the already recorded usage floor, and is retained in Goal budget history.

### The overview page

The **Overview / Conversation** buttons at the top of the workbench switch between two independent pages. Overview shows a short project brief, pending items and a single-column goal list; with no goals it shows neither statistic cards nor a permanent form, and the editor opens only after you click "New" or a goal entry. The Conversation page keeps the canvas and the chat and shows a short goal hint only when a task is bound.

Both pages stay mounted, so switching back and forth preserves messages, input drafts, canvas, model and any unsaved goal form. The current page is persisted in the shared UI configuration and can also be set in **Settings → General → Default workbench**.

## Node deletion

To delete a node, click its title or border and press Delete / Backspace / X; Ctrl+Z undoes it.

- When a graphic inside the node is selected, Delete removes only that graphic; clicking inner blank space with only the outer node selected removes the whole node.
- Deleting a graphic clears the outer selection so repeated key presses cannot delete the node by accident, and a focused input or goal control never deletes canvas nodes.
- The bottom status bar shows the actual multi-selection count and the current deletion target, and adding, loading, undoing and redoing keep the visual selection in sync with the real one.

`npm run test:workspace-ux-ui` drives real mouse and keyboard events to verify this behaviour; the packaged acceptance evidence is in [acceptance.json](validation/workspace-ux-preview/acceptance.json). Skins: [night](validation/simple-overview-preview/dark.png) · [light](validation/simple-overview-preview/light.png).

## Retrieval and project storage

Local agentic RAG builds a BM25 index over project files, with optional vector backends (`memory` in-process by default, or SQLite/Milvus). A retrieval hit only helps you locate something; a citation still has to come from a source actually read in that turn. The settings entry is the "Retrieval settings" tab in the bottom workbench.

The `.cnode` container stores the canvas, sessions, workspace and integrity information; `.codenode/` stores project-level run records, indexes and scalar data. The model list lives in the Electron user data directory, and API keys require OS secure storage.
