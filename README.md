# CodeNode

CodeNode 是一个面向 Codex 的可视化代码编排插件项目。第一阶段聚焦 Java 支持：在 Codex 中通过自然语言描述 Java 节点，逐步验证 Java 21 + Maven 的代码生成、审查、编译和运行闭环。

## 当前阶段

当前仓库对应“第一步项目执行方案 / 阶段 0”：

- 已建立可安装的 Codex 插件骨架；
- 已加入 `codenode-java` Skill；
- 已加入 Java/Maven 环境检查脚本；
- 已加入最小 Java 示例项目生成脚本；
- 已建立 Obsidian 项目入口和阶段 0 制作记录；
- 可视化节点画布、Agent 自动生成 Java 代码和错误回溯属于后续阶段。

## 目录结构

```text
CodeNode/
├─ .obsidian/                         # Obsidian vault 配置（不含会话缓存）
├─ codenode/                          # Codex 插件项目
│  ├─ .codex-plugin/plugin.json       # 插件清单
│  ├─ skills/codenode-java/           # Java 第一阶段 Skill
│  ├─ scripts/                        # 环境检查和示例生成脚本
│  └─ README.md                       # 插件使用说明
├─ 欢迎.md                            # Obsidian 项目入口
├─ 阶段0-插件制作记录.md               # 阶段 0 实施与验收记录
├─ CodeNode项目执行方案.md             # 完整执行方案
└─ README.md                          # 本项目说明
```

## 使用方式

1. 在 Codex 中安装或刷新 `codenode` 插件。
2. 使用 `codenode-java` Skill 检查 Java/Maven 环境。
3. 在获得用户确认后运行 `codenode/scripts/create-java-demo.ps1` 生成示例项目。
4. 安装 Java 21 LTS 和 Maven Wrapper 后执行示例测试。

Windows 检查命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\codenode\scripts\check-java-env.ps1
```

## 环境要求

- Codex（支持本地插件的版本）；
- Java 21 LTS（完整 JDK，需包含 `javac`）；
- Maven Wrapper 或 Maven；
- Windows 优先，其他平台待后续适配。

## 安全边界

插件默认不自动安装依赖、不覆盖已有文件、不执行未知脚本。涉及文件写入、进程执行、联网或敏感文件读取时，必须经过用户确认。

## 文档入口

- Obsidian 入口：[欢迎.md](CodeNode/欢迎.md)
- 执行方案：[CodeNode项目执行方案.md](CodeNode/CodeNode项目执行方案.md)
- 阶段 0 记录：[阶段0-插件制作记录.md](CodeNode/阶段0-插件制作记录.md)
- 插件说明：[codenode/README.md](CodeNode/codenode/README.md)
