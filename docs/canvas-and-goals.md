# Canvas, workflows and goals

[English](canvas-and-goals.md) · [简体中文](canvas-and-goals.zh-CN.md)

The canvas is a real workflow engine, not a sketch pad: execution state is persisted by the main process, and the same project file carries the graph, the sessions and the Goal records.

## The canvas

![CodeNode workflow canvas](screenshots/codenode-canvas.png)

- The visible graph layer uses Canvas 2D; node selection, dragging, connection hit-testing, zooming and keyboard operations stay on a transparent interaction layer.
- Selecting an image, object, scope or embedded vector-canvas node shows its editing controls temporarily above the layer.
- The saved format remains node and edge data and does not depend on screen pixels. `显示全部节点` (View → show all nodes) fits every node into the canvas viewport.
- Press **Shift+A** on an empty canvas to add a node; the minimal runnable chain is `start → task → end`. Select a node, fill in its goal and connect from its ports.
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
- "Start executing goal" advances stage by stage under the Goal's own admission, budget, write-scope, settlement and evidence rules, and stops on a wait, a failure, insufficient evidence or a required manual review.
- Acceptance evidence carries a source fingerprint, commit and environment; changing the files or the condition invalidates it. A Goal is never marked complete on a model's own claim.
- The planning model and the execution backend are configured separately (see [backends](backends.md)).

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
