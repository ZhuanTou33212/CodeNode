# CodeNode Desktop

CodeNode 的 Java 21 / Swing 原生桌面程序。运行链路不使用 HTML、浏览器、Electron、WebView 或 MCP：

`桌面节点画布 → 项目 .codenode/queue/inbox → Codex 本地队列 Skill → .codenode/results → 节点状态/错误标红`

## 开发运行

```powershell
$env:JAVA_HOME = "E:\CodeNode\tools\jdk-21.0.9+10"
.\mvnw.cmd test
.\mvnw.cmd package
java -jar .\target\codenode-desktop.jar
```

## 独立程序镜像

```powershell
.\scripts\package-app.ps1 -JavaHome "E:\CodeNode\tools\jdk-21.0.9+10"
```

入口为 `dist\CodeNodeDesktop\CodeNodeDesktop.exe`，自带裁剪后的 Java 运行时，无需浏览器。

## 使用

1. 选择项目目录并初始化本地申请槽。
2. 选择“代码工作流”或“Markdown 蓝图”，编排节点并填写 Prompt。
3. 提交单节点或连接工作流；软件会复制一条 Codex 指令。
4. 在 Codex 中发送该指令。插件处理本地申请并回写结果。
5. 软件定时读取结果；编译诊断对应的节点会标红。

## 节点编辑快捷键

- `Shift+A`：打开节点库；基础/数值节点通用，语言专用分类随 Java、PowerShell、Go 切换。
- 鼠标中键拖动：平移画布。
- `Ctrl+鼠标右键`拖动：绘制红色切线并断开经过的连接。
- 从输出端口拖动：连线实时跟随鼠标，释放到输入端口后连接。
- `Shift+D`：复制节点；`Delete`/`X`：删除；`Ctrl+X`：删除并尝试重连。
- `H`：折叠节点；`M`：静音节点；`Home`：查看全部；`Shift+W`：快捷操作菜单。

右侧节点资源管理器可以编辑任意数量的输入/输出端口名称、数据类型和必需标记。节点资源管理器与底部输出/代码审查窗口均可收起或浮动，关闭浮动窗口时会重新停靠。
