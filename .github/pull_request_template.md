## What changed / 这次改了什么

<!-- 一句话说明动机与范围；如果是修 bug，把复现路径写清楚 -->
<!-- One sentence on the motive and scope; for a bug fix, include the reproduction path. -->

## Change type / 改动类型

- [ ] Feature / 功能（feat）
- [ ] Fix / 修复（fix）
- [ ] Refactor / 重构（refactor）
- [ ] Docs / chore / 文档与工程（docs / chore）

## Verification — must really be run, paste evidence / 验证（必须真实跑过，请贴证据）

- [ ] `npm run verify`（= build + check:js + full core regression and gates / 全量回归与门禁，core 套件）
- [ ] `npm run test:display`（touches UI / Electron window / canvas 时 / 涉及 UI、Electron 窗口、画布）
- [ ] Manual path / 手测路径：<!-- e.g. open xxx project → trigger xxx → expect yyy -->

## Impact self-check / 影响面自查

- [ ] Does the new capability have a real assertion (not "some string appears in the source")? / 新能力是否有真实断言？
- [ ] Are degraded paths reported honestly (no fake isolation, no fake success)? / 降级路径是否如实上报？
- [ ] Did you change execution isolation (sandbox), run checkpoints (runCheckpoint), side-effect idempotency (sideEffects) or the cost ledger (costLedger)?
      / 是否改动了执行隔离、断点续跑、副作用幂等、成本账本？
      If yes, run / 改动这些请务必跑 `npm run test:sandbox && npm run test:resume && npm run test:cost && npm run test:runtime-gate`
- [ ] Are generated artifacts (build output, eval reports, temp files) covered by `.gitignore`? / 新增生成物是否已进 `.gitignore`？
- [ ] Did you change CI triggers or the gate list? The gate list is maintained in one place only: `scripts/run-all-tests.cjs`. / 是否修改了 CI 触发条件或门禁清单？

## Related issue / context / 关联 issue 与上下文

<!-- e.g. Closes #12 -->
