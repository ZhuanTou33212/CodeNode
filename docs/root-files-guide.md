# 根目录文件说明

这些文件按作用放在项目根目录。构建工具、Git、CI 和 GitHub 默认会在这里寻找其中一些文件；“没有放进文件夹”不等于没有用途。

| 文件 | 当前用途 | 处理 |
| --- | --- | --- |
| `.editorconfig` | 统一缩进、UTF-8、行尾和末尾换行，供支持 EditorConfig 的编辑器使用 | 保留 |
| `.gitattributes` | Git 文本行尾及二进制文件规则，减少跨平台整文件差异 | 保留 |
| `.gitignore` | 排除 node_modules、构建包、缓存、运行日志等生成物 | 保留 |
| `.npmrc` | npm 注册表与 Electron 下载镜像配置 | 保留 |
| `.nvmrc` | 指定 Node 22 系列；CI 的 setup-node 读取它 | 保留 |
| `AGENTS.md` | 项目交付、Git 同步、界面及配置约定 | 仅本地保留，已忽略，不提交或推送 |
| `CONTRIBUTING.md` | 开发环境、验证流程和贡献约定 | 保留 |
| `LICENSE` | 开源授权许可证；package.json 声明 MIT | 保留 |
| `README.md` | 项目首页、启动方法、功能及文档入口 | 保留 |
| `package.json` | 依赖、npm 命令、Electron 入口和打包配置 | 保留，核心文件 |
| `package-lock.json` | 锁定实际依赖版本；npm ci 和 CI 缓存使用 | 保留，不能因为有 package.json 就删除 |
| `index.html` | Vite/React 页面入口及 CSP，构建后生成 dist/index.html | 保留，核心文件 |
| `vite.config.mts` | React 构建插件、开发端口、相对资源路径及 dist 输出配置 | 保留 |
| `tsconfig.json` | 前端 TS/TSX 类型检查 | 保留 |
| `tsconfig.checkjs.json` | Electron 主进程和工具层 CJS 静态检查 | 保留 |
| `tsconfig.checkjs-scripts.json` | 测试与构建脚本的 CJS 静态检查，与主进程分档 | 保留 |
| `workflow.cnode` | 仓库示例工程，也是默认工程文件名；截图脚本使用此示例 | 保留，不能当缓存清理 |

旧文档中提到的 `CHANGELOG.md` 是历史版本记录；若当前工作区不含该文件，可从 Git 历史查阅，不影响构建。核心配置继续保留在根目录。

## 品牌资源

`codenode-icon.png` 已从根目录移到 `assets/branding/codenode-icon.png`，SHA256 相同，图片内容未改动。构建脚本、Electron 主进程和打包清单均使用新路径；根目录不保留副本。`build` 中的 ICO/PNG 是实际构建需要的派生图标。

## 本次删除及同步

- `codenode-icon.svg`：旧矢量图稿。已核对程序、构建脚本、说明与 CI 无引用，当前图标管线使用 PNG，删除不改变应用图标。
- `启动项目.bat`、`创建桌面快捷方式.bat`：本次开始前已在本地删除，Git 仍记录为待删除。两者是通用开发启动/快捷方式包装；同步这两项删除，并修正 README 的旧入口。开发仍用 npm run dev；已打包程序仍从 release/win-unpacked/CodeNode.exe 启动。
- `scripts/make-launcher.cjs`：保留。这是打包产物的独立启动器生成脚本，与上述两个根目录批处理不是同一入口。

只调整品牌资源路径、删除旧入口与无引用旧图稿；不移动工具默认查找的配置，不清空用户工程，不修改 Agent/RAG 算法。已通过构建、类型检查、冻结基线校验、图标解码/新路径验证、实际包启动、打包 RAG worker、昼夜主题控件与状态一致性检查、暂存及固定路径自检。

## 文件夹速查

- `assets/branding`：品牌源资源。
- `build`：构建所需的派生图标。
- `src`：React 前端源码。
- `electron`：桌面主进程、IPC、Agent、工具与检索。
- `scripts`：根目录只保留启动、构建与调度入口；测试按 `core/`、`ui/`、`packaged/` 分类，评测放 `eval/`，专项工具放 `tools/`，共用代码和输入放 `lib/`、`fixtures/`。见 [脚本目录](../scripts/README.md)。
- `config`：集中设置、主题和 Agent 配置；本地密钥及自动对话记录不作为此次提交内容。
- `docs`：技术说明、变更分析与评测说明。
- `baselines`：冻结回归快照与原始成绩。
- `reviews`：人工盲审材料。
- `release/win-unpacked`：固定可运行交付包。

## 后续目录维护规则

1. 根目录保留工具约定的入口/配置、仓库首页/许可证/协作说明和现有示例工程；新增图片等源资源归 assets，不散放根目录。
2. 源码归 src/electron，脚本归 scripts，可调整配置归 config；变更文件位置必须同步程序、测试、CI 和打包引用。
3. 生成物归 dist、out、.cache 和独立 .stage-*；用户工程、.codenode、.hermes 和实际记忆不按垃圾清理。
4. 每次交付先暂存与自检，确认程序未运行后覆盖 release/win-unpacked，不保留旧版包；交付后删除独立暂存及隔离自检数据。
5. 保留有用途的构建配置、依赖锁、许可证、测试和文档；删除无引用旧资源、重复包装入口、临时编辑脚本和无关缓存。文档/基线引用的材料不删除。
6. 源码、测试、公共配置及文档同步 origin/yimi-branch；本地密钥、自动对话和生成物不加入提交。此次打包使用公共配置模板，不把本地密钥与对话样本写入包；实际用户模型、工程和运行数据不清空。

验证记录：`out/root-structure-2026-10-08-assets.json`、`out/root-structure-2026-10-08-package-check.json`、`out/root-structure-2026-10-08-theme.log`、`out/root-structure-2026-10-08-stage-selftest.json`、`out/root-structure-2026-10-08-fixed-selftest.json`、`out/root-structure-2026-10-08-delivery.json`、`out/root-structure-2026-10-08-sync.json`。

脚本分类整理的检查记录：`out/scripts-organization-audit.json`、`out/scripts-organize-verify-final.log`、`out/scripts-organize-display-final.log`、`out/scripts-organization-stage-selftest.json`、`out/scripts-organization-fixed-selftest.json`、`out/scripts-organization-delivery.json`。冻结材料使用 `.gitattributes` 的 `baselines/** binary` 按原始字节保存，避免行尾转换和文本合并破坏校验；不更新数据集、原始成绩或其哈希清单。
