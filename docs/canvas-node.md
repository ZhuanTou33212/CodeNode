# 画布节点（Canvas Node）——矢量画布内嵌到 Agent 画布

> 状态：已实现 ｜ 分支：`n0_13` ｜ 相关代码：`src/vector/*`、`electron/tools/impl/{createNodesTool,workbenchEditTool}.cjs`

## 1. 为什么重构

上一版把矢量画布做成了**独立全屏工作区**（`uiStore.workspace = 'vector'` + `VectorStudio` 全屏组件 + 工具栏「矢量设计」按钮），
用户必须离开 Agent 画布才能画图，无法和节点/连线一起看。

重构目标：

1. 矢量画布**直接作用在 Agent 画布上**——作为一个节点存在，不再另起一栏；
2. 新增**画布节点**，可用预设配件自由绘制；
3. 画布节点**左上角切换模式**；
4. 保留原有 Blender 风格节点连接与节点外观。

## 2. 结构

```
src/vector/
  vectorStore.ts   zustand 文档 store：createVectorStore() 工厂 + 按节点 id 的注册表 + Context/useVector()
  Surface.tsx      可嵌入的绘制表面（纸张/网格/参考线/图形/选中框/手势/逻辑高亮），由 VectorStudio.tsx 拆分而来
  Panels.tsx       右栏面板：属性 / 图层 / 逻辑分析
  VectorNode.tsx   画布节点（React Flow 节点）：标题栏 + 工具/配件栏 + 绘制表面 + 右栏 + 底栏
  node.css         画布节点外观（Blender 风格 + 内嵌布局）
  vector.css       矢量画布 token 与组件样式（.vs / .vs-scope 双作用域）
  model.ts         图形模型、预设构造、几何工具
  region.ts        集合逻辑分析（位掩码区域统计、结果位图）
  types.ts         文档类型与常量
```

数据流：

```
VectorNode(id)
  └─ getVectorStore(id)                      每个节点一份独立文档 store（localStorage: codenode.vector.node.<id>）
       └─ VectorStoreContext.Provider        注入给子组件
            ├─ VectorNodeHead               左上角 设计/逻辑 切换、撤销/重做、适应画布、右栏开关
            ├─ VectorNodeRail               工具 + 预设配件
            ├─ VectorSurface                绘制表面（stageScale = React Flow 的 zoom）
            ├─ Panels                       属性 / 图层 / 逻辑分析
            └─ VectorNodeFoot               状态 / 结果 / 指针坐标 / 缩放
```

## 3. 关键决策

- **每个画布节点一份文档**：`createVectorStore({ storageKey, seed })` 工厂按节点 id 生成实例，注册表复用；节点删除不会互相影响，新增节点是空白纸（`seed: 'empty'`）。
- **模式在节点左上角**：`设计` / `逻辑` 两个按钮放在标题栏最左侧；切换同时写回 `node.data.mode`，便于导出与 Agent 读取。图形内容不进 `node.data`，避免污染画布摘要。
- **嵌套缩放**：React Flow 会对节点整体做 CSS `scale(zoom)`，屏幕像素与 SVG 本地像素不再 1:1。
  `VectorSurface` 接收 `stageScale`（取自 `useStore(s => s.transform[2])`），在
  `toWorld()` / 平移手势 / 滚轮锚定 / 吸附容差 / ResizeObserver 尺寸换算上统一扣除，保证在任意画布缩放下命中与拖拽都准确。
- **快捷键互斥**：只有**选中的**画布节点绑定节点内快捷键（`store` + `activeVectorNodeId`）；
  选中画布节点时工作台全局快捷键让位（`App.tsx` 检查 `getActiveVectorNode() === selectedId` 与 `.vs-scope` 焦点）。
- **拖拽范围**：节点的 `dragHandle` 固定为 `.wf-vector-title`，节点内部所有指针交互都不会误拖整块画布。
- **滚轮**：节点主体带 `nowheel`，滚轮缩放纸张而不是缩放整个 Agent 画布。
- **Agent 集成**：`create_nodes` 与 `workbench_edit` 的 `type` 支持 `canvas`（别名 `vector`），
  创建的节点会带默认尺寸/模式；`GraphModel.stats()` 增加 `canvases` 统计。

## 4. 验收

`scripts/vector-ui-test.cjs`（`npm run test:vector`）用无头 Edge + CDP 驱动真实 DOM，覆盖 48 项：

- 画布节点直接出现在 Agent 画布上、工作台画布未被替换；节点带左右端口与标题栏
- 模式切换位于节点左上角、切换写回 data
- 预设配件放置图形；工具拖拽绘制并校验尺寸；双击改文字
- 节点内 Ctrl+Z/Y；`Delete` 只删除图形、不删除画布节点
- 逻辑模式：集合/区域/关系/表达式、并集高亮、真实拖拽后结果面积实时更新
- 属性/图层面板、编组/解组/显隐/锁定/重命名/层级重排
- 文档写入 `codenode.vector.node.<id>`；两个画布节点文档互相隔离
- 页面无未捕获异常

```powershell
npx vite --port 5199          # 终端 A
npm run test:vector           # 终端 B（可用 VECTOR_TEST_URL / VECTOR_TEST_PORT / VECTOR_TEST_EDGE 覆盖）
```

其余回归：`npm run test:model`（含画布节点创建）、`npm run test:arrange`、`npm run test:scope-frame`、`npm run test:cache`、`npm run build`（typecheck + 产物构建）。
