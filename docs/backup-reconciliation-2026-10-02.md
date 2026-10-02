# 本机备份与 `yimi-branch` 对账（2026-10-02）

本次核对了 `release-backups/` 下两份 CodeNode Windows 解包目录，以及 `git stash` 中两份旧工作区快照。比较对象是当前工作区、当前 `release/win-unpacked/resources/app.asar` 和本地 `yimi-branch`。

## Windows 解包备份

| 备份目录 | `CodeNode.exe` SHA-256 | `app.asar` SHA-256 | 与当前包不同的应用源码文件 |
| --- | --- | --- | ---: |
| `win-unpacked-before-delegate-20261002-180617` | `1DC2D12E5C60341782E68C4B65A8E49CBD86217F81568F90575547CEC13B5610` | `72349E52B19400B805C71F1F2252E9612781D13358F25590F7992CBA95E8FB67` | 12 |
| `win-unpacked-before-token-fix-20261002-183154` | `1DC2D12E5C60341782E68C4B65A8E49CBD86217F81568F90575547CEC13B5610` | `233C1E9EA7A82C1F92C5A853CF169190A44E6D967AB77618E43AC8B6717D7405` | 7 |

两份备份的 exe 与当前交付版哈希相同。逐一比较 `app.asar` 内的 `electron/`、`config/` 和 `package.json` 后，没有发现只存在于备份中的应用源码路径；所有不同的源码文件在当前包里都与当前工作区的文件逐字节相同。`dist/` 中各有 3 个不同的生成文件，属于前端构建版本差异。旧解包目录本身没有需要覆盖当前源码的独有实现。

## Git stash 快照

- `stash@{0}` 建于 2026-10-01，以 `085fbe2` 为基线；`stash@{1}` 建于 2026-09-30，以 `31c5288` 为基线。两者都早于当前 `yimi-branch` 的后续记忆、RAG、工具和 CI 修复提交。
- 按文件比较，`stash@{0}` 的 111 个路径中 55 个与当前工作区一致，50 个已有后续实现，另有 4 个缺失的旧图稿路径和 2 个已移除的旧画布工具路径。`stash@{1}` 的 41 个路径中 10 个一致、29 个已有后续实现，缺失的是同样 2 个旧画布工具路径。
- 4 个旧图稿路径实际只有 **1 份 SVG + 1 份 PNG**：`agent-react-state-machine` 与 `agent-react-statechart` 两组名字的 Git blob 完全相同。已去重恢复到 [SVG](archive/agent-react-state-machine.svg) 和 [PNG](archive/agent-react-state-machine.png)。
- `createNodesTool.cjs` 与 `workbenchConnectTool.cjs` 是旧版已删除工具；当前工作台使用统一的 `workbench_edit`，因此未重新接回旧工具。

上述对账用于提取备份中的独有源码或文档内容。完整旧安装目录是历史构建产物，不应以旧文件覆盖已验证的新实现。
