# Branch integration conflict review (2026-10-06)

The legacy agentic RAG tip is from 2026-08-24 (v0.11); the integration base contains the later v0.13 implementation and the current UI changes. Each conflicting file was inspected through its conflict blocks, function names, and exported APIs. No legacy public RAG API is absent from the current implementation.

| File | Reviewed resolution and preserved functionality |
|---|---|
| README.md | Retain current product/runtime instructions; the old milestone checklist describes features now implemented. |
| config/agent.properties.example | Retain extended configuration including every legacy RAG setting, plus vector, graph, budget and role options. |
| electron/agent.cjs | Retain later agent loop; all legacy exported functions including grounding, retrieval config, streaming and chat remain. |
| electron/main.cjs | Retain modular IPC; legacy auditLog and walkProject live in electron/ipc/project.cjs, saveDoc lives in electron/ipc/agent.cjs. |
| electron/rag/index.cjs | Identical legacy public exports; current implementation adds async vectors/documents/runtime isolation without removing BM25, RRF, source lines or exclusions. |
| electron/tools/context.cjs | Same AgentToolContext and ConfirmationLevel exports, with later safety and budget behavior. |
| electron/tools/impl/retrieveContextTool.cjs | Same registry API with later scalar/vector and citation behavior. |
| electron/tools/toolkit.cjs | All old exports retained, plus roles and profiles. |
| package.json | Retain v0.13 scripts, packaging and test coverage rather than reverting to v0.11. |
| scripts/rag-grounding-test.cjs | Retain expanded citation/read-range regression coverage. |
| scripts/rag-test.cjs | Retain updated async retrieval tests including prior RRF, exclusion and cache cases. |
| scripts/rag-ui-test.cjs | Retain current component-based test rather than obsolete floating sidebar assumptions. |
| src/components/ChatSidebar.tsx | Keep its existing removal; its MessageView and SessionTree behavior is implemented by MessageList, AgentPanel and ProjectNavigation. Restoring it would reintroduce the superseded sidebar. |
| src/global.d.ts | Retain all old API fields plus current model, retrieval and workflow interfaces. |
| src/store/chatStore.ts | Preserve grounding transfer plus later streamed call IDs, cancellation, truncation and compaction behavior. |
| src/store/sessionStore.ts | Preserve legacy session behavior plus current draft, archive, per-conversation history and stream handling. |
| src/types.ts | Retain grounding types plus current attachments, compaction and conversation fields. |
| src/styles.css | Keep current RAG and conversation styling; old floating-sidebar CSS belongs to the removed component. |

The merge commit retains the legacy tip as a parent. Later retry-budget and dependency branches are reviewed separately. Validate retrieval, grounding, UI, build and package before publishing main or deleting branches.

## Retry-budget branch conflict review

Reviewed every conflict in CLI, config, agent, IPC, request budget and Dify test. Current conflict-side blocks retain shared retry limits plus later money reservations, actual-model pricing, image billing ceilings, routing and trace spans. Choosing the legacy blocks would remove those later controls. Kept the current blocks while retaining the branch's non-conflicting CI/JSDoc typing changes and ledger changes. The request-budget and retry regression suites are required before publishing.

## Dependency compatibility review

React DOM 19.3 requires React 19.3; both runtime packages and both React type packages are paired. React Flow declares support for versions >=17. Plugin React 6.1.1 requires Vite 8, so the bundler must be paired with that upgrade. TypeScript 7 exposes the native CLI and version entry point, not the classic compiler API; runtime AST consumers and the incremental test use the official @typescript/typescript6 compatibility package. CheckJS module resolution is migrated from removed node10 behavior to Node16 before the compiler upgrade.
