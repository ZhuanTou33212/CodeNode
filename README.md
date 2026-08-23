# CodeNode Next

CodeNode 重构版：以 **DeepSeek Harness（DSH）** 为目标的 Agent 工作台。

> 当前里程碑：**基础画布**。采用 Electron + React + React Flow 重构原 Java/Swing 版本，
> 保留节点画布操作逻辑（Blender 风格），并将节点语义改为「Agent 工作流可视化」。
> 完整重构方案见 `REFACTOR_PLAN_DSH.md`（在仓库 `codenodeNew` 分支历史/工作区）。

## 技术栈

```
桌面壳      Electron（主进程 Node.js + 内嵌 Chromium，无外部浏览器）
前端        React 18 + TypeScript + Vite
画布        React Flow（@xyflow/react）+ zustand
工程格式    .cnode（ZIP 容器 + mimetype + manifest/graph/workspace/integrity + SHA-256）
```

## 功能特性

### 画布（Blender 风格操作）
- 鼠标中键 / 右键拖动画布，左键框选，滚轮缩放
- `Shift+A` 光标处弹出节点菜单（入口 / 出口 / 任务 / 阶段 / 工具）
- 节点拖拽、端口连线（右侧拖出 → 左侧，箭头 + 动画）
- 快捷键：`Ctrl+Z/Y` 撤销重做、`Ctrl+D` 复制、`Del`/`X` 删除、`Home`/`Z` 聚焦全部、`Escape` 关闭菜单
- 节点状态（待执行 / 执行中 / 已完成 / 失败 / 阻塞）实时着色

### 工程文件（专属 `.cnode` 格式，参考原版 .cnode）
- UTF-8 ZIP 容器，`mimetype` 首条目：`application/vnd.codenode.project+zip`
- 条目：`mimetype` / `manifest.json` / `graph.json` / `workspace.json` / `integrity.json`
- `integrity.json` 记录各文件 SHA-256，打开时校验完整性（篡改会提示）
- 宽松读取：未知字段忽略、缺失字段默认值、更高版本只读打开
- 保存确定性写入当前工程文件；重启自动恢复上次工程
- 格式 Schema：`src/resources/schemas/cnode-project-1.0.schema.json`

### 项目管理器（左栏，Unity 风格）
- 选择项目目录 → 递归文件树（忽略 node_modules/.git/dist 等），点击文件预览内容
- 面板可收起 / 拖拽调宽；`.cnode` 工程文件在树中高亮

### 检查器（右上角悬浮角标）
- 默认显示悬浮角标（节点数 / 选中提示），点击展开为检查器浮层，可编辑节点名称 / 状态 / 目标说明

## 开发运行

```powershell
# 需要 Node.js 18+（本项目自带 tool/node，见工作区）
npm install          # 安装依赖
npm run dev          # 开发模式（Vite HMR + Electron）
npm run build        # 类型检查 + 构建到 dist/
npm start            # 生产模式（加载 dist/）
npm start:prod       # 先构建再启动
```

> 国内网络建议保留 `.npmrc`（npmmirror 源 + Electron 镜像）。

## 项目结构

```
electron/           Electron 主进程 / 预加载 / .cnode 编解码
src/
  components/       画布、项目管理器、检查器、工具栏、状态栏、添加菜单
  lib/              项目生命周期（新建/打开/保存）
  nodes/            画布节点类型与模板
  resources/schemas/.cnode 格式 JSON Schema
  store/            zustand：图模型 / 项目 / UI 状态
  types.ts          节点数据类型
scripts/            冒烟测试
```

## 测试

```powershell
# DOM 冒烟（加载 dist/，校验画布/面板/控件）
node_modules\.bin\electron scripts\smoke.cjs
# 主进程自检（验证 preload + IPC + .cnode 保存/加载/完整性）
$env:CODENODE_TEST=1; node_modules\electron\dist\electron.exe .
```

## 路线图

- [x] 基础画布 + 基础 UI + `.cnode` 专属格式
- [ ] 接入 DeepSeek Harness（DSH）：Agent 引擎 / 工具 / 摘要 / 记忆 / MCP
- [ ] 节点 = Agent 工作流：进度 / 顺序 / 结果摘要可视化
- [ ] Agent 通过工具控制画布（创建 / 连线 / 推进状态）
- [ ] 打包分发（electron-builder）与 `.cnode` 文件关联
