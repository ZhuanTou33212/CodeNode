# Stage 4.5 项目大纲：全量程序扫描 + 内嵌 Agent 能力与 Harness

> 目标版本：CodeNode Desktop（Java 21 / Swing 原生桌面节点工作台）
> 状态：**设计大纲 + 实施记录**
> 关联：Stage4（节点组/资源组 v2）、Stage6（固定文件分析 + harness 基础）

---

## 1. 目标

1. **全量程序扫描**：选定工程根目录后按**一个文件夹一个文件夹内容识别**，用节点组模拟文件管理器本身——目录→组、资产目录→资源组、文件→文件/资产节点并引用相对路径；支持资源组「解组」为普通组进入组视图查看全部成员。
2. **内嵌 Agent 能力与 harness**：DSL 解码器嵌套规则让 AI 直接由画布生成完整程序分析架构；软件内建编译器独立完成程序的制作/使用/理解；实时抓取运行数据并据此在已分析项目上编写 md 节点；工具集与系统提示（harness）规则完备；任何环节卡死输出诊断报告。

---

## 2. 核心模型约定（全量扫描）

- 每个目录是一个节点。
- **内容只有资产的叶子目录** → 资源组 `ASSET_BUNDLE`（输出端口即资源组输出，内部每个资产的名字写入 `bundleData.members[]`）。
- **其余目录** → 普通节点组 `GROUP`：组内生成组输入/组输出节点，子目录/文件全部连到组输出；进入组视图即可看到全部内容。
- **组输出节点 = 对应组的输出端口**：所有连到组输出节点的内容都会从该组输出端口流出。
- **组输入节点 = 对应组的输入端口**：外部连接组的数据经组输入进入组视图。
- 子组输出向上汇聚到父组输出，用组的形式模拟文件管理器本身。
- 程序类文件用**文件节点（FILE）**，资产类文件用**资产节点（ASSET）**；**所有文件节点创建时引用相对路径**。
- **忽略缓存/构建类**目录与文件（target/build/.git/.idea/node_modules/dist/out/.gradle/cache/.codenode/.vscode/.settings/logs）。

**解组语义**：解组不是炸开成画布上的独立资产节点，而是保持节点位置不变、原地把 `ASSET_BUNDLE` 降级为普通 `GROUP`。组内生成组输入/组输出节点，`bundleData` 每个成员转为一个资产节点并全部连到组输出节点。组节点保留原 id，下游 `groupInputNodeId` 引用继续有效。

---

## 3. 实施清单

| 模块 | 说明 | 状态 |
|---|---|---|
| `DirectoryGraphBuilder` | 目录递归成组；资产叶子目录→资源组；文件→FILE/ASSET 带相对路径；忽略缓存目录；进度回调 | ✅ |
| `HierarchyLayout` | 对 `role=folder` 根组递归布局 | ✅ |
| `WorkflowModel` | `ungroupAssetBundleToGroup`（解组）、`connectNoRecompute`（批量建边）、`nodeIndex`（O(1) 节点查找）、`refreshFileSpaces` 性能优化 | ✅ |
| `WorkflowDslService` | 嵌套组规则 + `decodeArchitecture`（markdown + AST 架构） | ✅ |
| `LocalCompiler` | 应用内编译/运行，不依赖外部 IDE/终端 | ✅ |
| `RuntimeTraceService` | 目标作用域内程序/资产收集 + 应用内编译运行 | ✅ |
| `ScanDiagnostics` | 分环节诊断日志 + 看门狗，卡死时输出报告 | ✅ |
| 新工具 | `compile_run` / `runtime_trace` / `write_analysis_md` / `ui_control` | ✅ |
| 工具扩展 | `create_nodes`（file/asset/bundle/group 预设+relativePath）、`workbench_structure`（ungroup_bundle） | ✅ |
| MainFrame | 全量扫描按钮 + 进度条 + 目录选择 + frameAll + 诊断接线 | ✅ |
| Harness | `AgentChatController` 系统提示补全（扫描→架构→编译→实时分析→md 节点→UI） | ✅ |
| 测试 | `Stage45FullScanTest`（14 例）+ `UiFullScanFlowTest` + 全量回归 115/115 | ✅ |

---

## 4. 诊断与性能

- **卡死根因**：`refreshFileSpaces` 对每个文件节点 × 每个组输出做 O(E) 上游遍历（O(N²·E)），几千节点时卡死；已改为预计算组输出上游集合（每个组输出只遍历一次）。
- `nodeIndex` 使 `byId` 从 O(N) 变 O(1)，渲染/命中检测性能大幅提升。
- 真实工程（Minecraft_sourceFile，4477 节点/3796 边）全流程约 3~4 秒。
- `ScanDiagnostics`：扫描时记录每个环节 BEGIN/END 与心跳到 `<项目目录>/.codenode/full-scan-diag.log`；超过 90 秒无心跳判为卡死并写 HANG 报告。
