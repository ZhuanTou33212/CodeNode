## 这次改了什么

<!-- 一句话说明动机与范围；如果是修 bug，把复现路径写清楚 -->

## 改动类型

- [ ] 功能（feat）
- [ ] 修复（fix）
- [ ] 重构（refactor）
- [ ] 文档 / 工程（docs / chore）

## 验证（必须真实跑过，请贴证据）

- [ ] `npm run verify`（= build + check:js + 全量回归与门禁，core 套件）
- [ ] `npm run test:display`（涉及 UI / Electron 窗口 / 画布时）
- [ ] 手测路径：<!-- 例如：打开 xxx 工程 → 触发 xxx → 期望 yyy -->

## 影响面自查

- [ ] 新能力是否有真实断言（不是"源码里出现过某字符串"）？
- [ ] 降级路径是否如实上报（不假装隔离 / 不假装成功）？
- [ ] 是否改动了执行隔离（sandbox）、断点续跑（runCheckpoint）、副作用幂等（sideEffects）、成本账本（costLedger）？
      改动这些请务必跑 `npm run test:sandbox && npm run test:resume && npm run test:cost && npm run test:runtime-gate`
- [ ] 是否新增了生成物（构建产物、评测报告、临时文件）？如果是，确认已进 `.gitignore`
- [ ] 是否修改了 CI 触发条件或门禁清单？门禁清单只在 `scripts/run-all-tests.cjs` 里维护一处

## 关联 issue / 上下文

<!-- 例如：Closes #12 -->
