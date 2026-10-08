# 并发会话边界修复（2026-10-08）

## 会话与请求归属

前台对话按单个活动会话执行。Agent 运行期间，会话列表禁用切换，store 同时拒绝程序调用切换；停止或完成后允许切换。

每次请求绑定 requestId、sessionId、工程目录和工程文件。增量事件、最终结果和异常只有在请求未取消且仍属于当前视图时才能写入界面。首次保存工程时同步更新该请求的工程文件归属。停止立即结束当前流式状态；旧请求的迟到结果不能污染另一会话，也不能停止同会话后来发起的新请求。

这次修复没有增加后台多会话并行聊天能力。

## 工程写入租约

同一个 Electron 主进程中的顶层 Run 按规范化工程路径共享底层租约池；主代理和子代理的 holder 使用 Run 命名空间，避免同名 supervisor 或子任务被误认为同一个持有者。

规范化包含绝对路径、已有父目录的真实路径和 Windows 大小写。活动 Run 定时续租；正常收尾释放主代理租约并停止续租，子代理沿用自己的释放流程，遗留租约可通过 TTL 到期。重复活动 Run 标识被拒绝。

已有的租约开关和 TTL 配置继续生效。该互斥覆盖经过资源租约的工具调用；它不是跨进程或分布式文件锁，也不保证任意 Shell 命令及外部程序写入互斥。

## 验证与交付

- `scripts/core/frontend-incremental-test.cjs`：93 项断言，包含停止后换会话、旧事件迟到、工程变更、同会话停止后重发等竞态。
- `scripts/core/concurrent-run-leases-test.cjs`：真实工具写入冲突、跨 Run 持有者隔离、不同文件和工程、读访问、续租和到期释放。
- 完整核心回归：149/149 通过，记录于 `out/concurrency-2026-10-08-core-final.log`。
- `scripts/packaged/concurrent-session-ui-test.cjs`：实际打包 UI 的会话切换拦截及两种主题检查通过。
- 昼夜主题一致性与打包 RAG worker 检查通过；主题记录于 `out/concurrency-2026-10-08-theme.log`。
- 暂存与固定交付路径的 EXE 自检均通过；记录于 `out/concurrency-2026-10-08-stage-selftest.json`、`out/concurrency-2026-10-08-delivery-selftest.json` 和 `out/concurrency-2026-10-08-delivery.json`。
- 交付路径：`E:\CodeNode\release\win-unpacked`。使用公开配置模板打包，不包含本地私有模型密钥或对话记忆。

本次没有修改 RAG 算法或冻结评测集，也没有重新消耗模型额度跑已曝光的验收题。
