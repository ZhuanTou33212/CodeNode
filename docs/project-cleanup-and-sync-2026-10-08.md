# 项目目录清理与远端同步（2026-10-08）

## 范围与结果

本次按用户要求清理 `E:/CodeNode` 的无关生成物。先扫描源码、文档、测试、基线、人工抽检包中的材料路径，再递归保留已引用生成报告的依赖。另保留此前交付的 RAG 评测文件、运行时快照和指标脚本；未以“被 Git 忽略”为理由直接删除整个 out。

- 删除 385 个文件，375 个顶层清理条目，释放 176.62 MiB，删除失败 0。
- 清理对象：未引用的构建/自检日志、一次性编辑辅助脚本、旧检查输出、过期 Electron 44.0.0 下载缓存及 npm 诊断缓存。
- 保留源码、配置、测试、文档、Baseline v3、人工抽检包、用户工程与本地运行记录、已引用评测材料、固定交付包。
- 保留当前 Electron 44.4.1 构建缓存、签名/图标编辑工具缓存和文档涉及的嵌入/重排模型，以支持开发及实验复现。
- 未删除 node_modules、workflow.cnode、.codenode 或 .hermes；未删除 Git 历史。验证所用隔离目录在自检结束后删除。

## 验证

- 126 条已有材料引用在清理后仍可访问。
- `node baselines/rag-regression-v3/verify.cjs`：172 个冻结文件校验通过，原始 100 题结果保持 63/100。
- `npm run check:js`：通过。
- 固定交付包自检：exit=0、ok=true，实际 appPath 为 `E:\CodeNode\release\win-unpacked\resources\app.asar`。
- `CodeNode.exe` 246324736 字节；`resources/app.asar` 34022700 字节；清理前后包 SHA256 一致。此次没有修改应用源码或界面。

## Git 同步与本地私有数据

目标为 `origin/yimi-branch`，对应用户指定的 ZhuanTou33212/CodeNode 仓库。首次网络连接被重置后，使用单次命令 HTTP/1.1 配置成功 fetch；不修改全局 Git 网络或信任配置。

本次提交只包含清理说明。现有源码、测试及公共配置在清理前已与 fetch 后的远端提交一致。`config/soul.md` 的新增内容是本地自动记录的对话样本，保留原文件但不随源码提交公开。`config/agent.properties` 的本地凭据配置保持原有 skip-worktree 状态；已核对提交中的对应配置没有非空凭据，未将本地密钥加入提交。

最终推送采用正常提交，不强推、不重写历史。完成后用在线远端引用检查 `origin/yimi-branch` 与本地 HEAD 一致；若远端在期间有新提交，先保留并整合，不能用强推覆盖。

## 本地审计材料

- [清理计划](../out/project-cleanup-2026-10-08-plan.json)
- [删除结果与明细](../out/project-cleanup-2026-10-08-result.json)
- [固定包自检](../out/project-cleanup-2026-10-08-selftest.json)
- [包身份核验](../out/project-cleanup-2026-10-08-delivery.json)
- [远端同步核验](../out/project-cleanup-2026-10-08-sync.json)

上述生成审计文件按 .gitignore 保留本地。此说明不把本地生成物描述为已上传 GitHub。
