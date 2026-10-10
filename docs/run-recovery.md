# Run safety and recovery

[English](run-recovery.md) · [简体中文](run-recovery.zh-CN.md)

A run is the unit of work in CodeNode: one ReAct loop with explicit states, an auditable tool contract and a recovery plan that survives a crash. Every delegated subtask uses the same loop, so this page also explains the multi-agent layer's building block.

## How a default run works

The default coding flow is: search for a symbol or error, read the file, edit, run tests.

- `retrieve_context` is not part of the resident coding tool set — enable it on demand with `discover_tools`. Local retrieval never calls a model to decompose the query. `query_scalars` is a separate canvas-property tool and is unaffected by `rag.enabled`.
- Ordinary file reads and writes plus non-delete canvas edits execute automatically; high-risk operations and worktree operations keep their approval step. **Settings → General** can switch automatic execution of ordinary tools per project.
- The conversation shows "edited N files" with an expandable diff, and editing the same file twice counts once. Reasoning, task traces and raw tool records stay in the run data.
- **Settings → Retrieval** toggles local retrieval, vector expansion and strict answer validation per project. Vectors and strict validation are off by default; SQLite vector support and the Milvus SDK are not installed with the default dependencies — install the extension yourself and repackage if you need them. Explicitly enabled model services still cost extra requests and time.

## Roles, models and budgets

**Settings → Cost & models** assigns a connected model to the explorer, builder, verifier, reviewer and canvas roles; by default they follow the model selected in the conversation. Small-task admission is decided locally: a single ordinary operation or a clear single-file read goes back to the main agent rather than starting a submodel. The settings page shows token, cache-hit, retry and cost attribution per task and role, along with run completion and per-check results; a missing price shows as unknown, and completion is never treated as correctness.

Repeated read-only results are reused by reference as long as the body is still intact in the current context; after compaction or truncation the reference is validated and the body is supplied again when the original text is needed. Each role can configure a turn limit, a cumulative token limit and a single-output cap, all inherited by default; the "light exploration preset" offers 6 turns / 60,000 total tokens / 8,192 output tokens and never silently caps complex exploration.

## Run states

![Single-agent ReAct run state and recovery](architecture/single-agent-react-state.png)

A run starts in `RUNNING`:

- The model returns a final answer → `COMPLETED`.
- The model requests a tool call → streaming arguments are assembled and structurally validated, then the run enters `WAITING_TOOL`, executes the tool, writes the result back into the conversation and returns to `RUNNING`.
- Approval or a question for the user → `WAITING_USER`.
- `FAILED`, `CANCELLED` and `LIMIT_REACHED` are the other terminal states.

**ACTIVE** in the diagram is only a grouping drawn for readability, not an extra state in the code. An ordinary tool failure is handed back to the model as a tool result; only a corrupted stream, a run error, a user cancellation or a budget stop terminates the run by their own rules. The optional Observation/Blackboard layer organises tool results but never replaces the raw tool records.

## What keeps it safe

Tools are validated by the registry for arguments, capabilities and confirmation policy. Write, command and external-network capabilities execute under their own contracts and leave audit records; operations with side effects use an idempotency ledger so an unknown outcome is never replayed blindly.

Recovery is decided jointly by run events, checkpoints and the side-effect ledger:

1. `planResume` reads the events and checkpoints of the previous run.
2. Steps that are safe and whose result is known resume automatically.
3. Writes or external operations with an unknown result go to manual review.
4. Continuing creates a new run; the old run keeps its original state and evidence.

A stream retry resends the whole turn — a half-received answer is never appended to a new request. Connection retries and stream resends share the same per-call HTTP request cap, and every actual request reserves its input plus maximum output from the run's token budget before it is sent. Configuration lives in `config/agent.properties.example`.

## Where it lives

| Area | Code |
| --- | --- |
| Tool loop and run state machine | `electron/agent.cjs`, `electron/agentState.cjs` |
| Events, checkpoints, resume plans | `electron/runStore.cjs`, `electron/runCheckpoint.cjs` |
| Side-effect ledger and rollback | `electron/sideEffects.cjs`, `electron/runRollback.cjs` |
| Budgets and cost attribution | `electron/requestBudget.cjs`, `electron/contextBudget.cjs`, `electron/costLedger.cjs`, `electron/costAttribution.cjs` |
| Permissions, approvals, sandbox | `electron/tools/registry.cjs`, `electron/approvalRules.cjs`, `electron/sandbox.cjs` |

Relevant acceptance: `npm run test:resume`, `test:side-effect-idem`, `test:run-rollback`, `test:agent-limits`, `test:context-budget`, `test:sandbox`, `test:runtime-gate` (asserts these capabilities are really wired up rather than merely present in the source). Deeper background on why recovery is built this way is in [the harness notes](agent-harness-and-workflow-recommendations.md) (Chinese).
