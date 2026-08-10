---
AIGC:
    Label: "1"
---

# Stage4.8 方案：内置完整 Java 项目开发环境（类 IntelliJ 的工程支持）

> 工程：CodeNode 桌面应用（Java Swing 工作流节点编辑器，Maven，JDK21）
> 代码目录：`E:\CodeNode\codenode-desktop\src\main\java\local\codenode\`
> 方向：让软件像 IntelliJ 一样，**独立运行一个完整 Java 项目**——内置项目创建、JDK 管理、构建系统（Gradle/Maven）、依赖管理、运行配置、打包、调试、测试与代码辅助。MC 模组（Forge/Fabric/NeoForge）是其中一类目标，但**不限于 MC**。
> 参考：IntelliJ IDEA 官方手册（项目/工具窗口、构建系统、运行配置、Artifacts/JAR、调试、JUnit、重构、Git）。
> 状态：**方案讨论稿，仅提方案，不制作**

---

## 一、目标（对齐 IntelliJ 核心能力）

| IntelliJ 能力 | CodeNode 对应目标 |
|--------------|------------------|
| 新建项目向导（选择构建系统/JDK） | 「新建 Java 项目」向导：选 Gradle / Maven / 纯 Java，选 JDK 版本 |
| JDK 管理（本机已装 / 下载 / Add from Disk） | JDK 探测（`JAVA_HOME`、常见安装路径）、手动指定路径 |
| Project 工具窗口（浏览结构/库/模块） | 工程树面板：源目录、资源、依赖库、模块 |
| 构建系统（IntelliJ 内置 / Maven / Gradle） | 多构建系统：Gradle（含 MC 模组）、Maven、纯 javac |
| 运行配置（Run Configurations，含 Before launch 构建） | 运行配置：入口类 / JAR / Gradle 任务 / Maven 目标，可存多套 |
| Build Artifacts（JAR 打包 + MANIFEST.MF） | 打包配置：主类 + 依赖 → 生成可运行 JAR |
| Run / Debug 工具窗口（输出+退出码） | 运行面板：日志流式、错误定位、退出码 |
| Debugger（断点/变量/栈） | 调试器（衔接 Stage4.7 实时追踪，最小实现：断点+调用栈） |
| JUnit 运行 | 测试运行器：识别 `@Test`，构建+运行+结果面板 |
| 代码辅助（补全/模板/检查/重构） | 代码编辑器增强：补全、Live Template、Inspections、重构 |
| Git 集成 | Git 面板：分支/提交/日志（复用 git CLI） |

---

## 二、现状差距

| 现有能力 | 缺口 |
|---------|------|
| `LocalCompiler`：javac 单文件编译+运行 | 无多模块、无依赖、无 Gradle/Maven 任务、无 classpath 组装、无打包 |
| `ExecuteShellTool`：命令白名单执行 | 白名单需扩展 gradle/maven/git/java；无工程上下文、无日志流式回显 |
| `RuntimeTraceService`：内存源码→运行 | 无法构建真实工程、无法启动 MC 客户端 |
| `scan_project`：目录层级成图 | 只建图，不执行构建/运行 |
| `CodeEditor`：文本编辑器 | 无补全、模板、检查、重构、断点 |

---

## 三、总体架构

```
CodeNode 工作台
│
├─ Java 项目模型（JavaProject）
│    ├─ 工程类型识别：Gradle / Maven / 纯 Java
│    ├─ Gradle 解析（settings/build/wrapper/模块/依赖/MC加载器）
│    ├─ Maven 解析（pom.xml：模块/依赖/插件）
│    ├─ 纯 Java（src 布局：src/main/java + resources + test）
│    ├─ JDK 探测与选择（JAVA_HOME、安装路径、手动指定、下载引导）
│    └─ 模块/源集/依赖库模型
│
├─ 构建执行器（BuildRunner）
│    ├─ GradleRunner：gradlew/gradle（tasks/compileJava/build/runClient）
│    ├─ MavenRunner：mvnw/mvn（compile/test/package/exec:java）
│    ├─ JavacRunner：纯 javac + classpath 组装
│    ├─ 流式日志（stdout/stderr → 输出面板 + 错误列表 文件:行:列）
│    ├─ 任务/目标执行与结果
│    └─ 产物定位（build/classes、target/classes、libs、jar）
│
├─ 运行启动器（RunLauncher）
│    ├─ 运行配置模型（入口类/JAR/Gradle任务/Maven目标 + JVM参数 + Before launch）
│    ├─ classpath 组装（模块 classes + 依赖 jars + 资源）
│    ├─ 进程管理（启动/停止/超时强杀/崩溃重启）
│    ├─ 附加 Stage4.7 Agent（实时运行追踪）
│    └─ JAR 打包（Artifact：主类+依赖 → 可运行 jar + MANIFEST.MF）
│
├─ 调试器（Debugger，最小实现）
│    ├─ 断点（行号/方法）
│    ├─ 调用栈与变量读取（JDI：jdk.jdi / jdwp 附加）
│    └─ 单步/继续/停止
│
├─ 测试运行器（TestRunner）
│    ├─ 识别 JUnit（@Test）测试类
│    ├─ Gradle/Maven test 或直跑
│    └─ 结果面板（通过/失败/失败堆栈定位）
│
└─ UI（ProjectWindow / BuildPanel / RunPanel / DebugPanel）
     ├─ 新建/打开工程、工程树、任务树、运行配置编辑器
     ├─ 构建/运行/调试/测试/打包按钮
     ├─ 日志、错误定位、运行状态、断点
```

---

## 四、模块设计

### 4.1 Java 项目模型（`JavaProject`）

| 方法 | 说明 |
|------|------|
| `discover(Path root)` | 识别 `settings.gradle`/`build.gradle`（Gradle）、`pom.xml`（Maven）、`src/`（纯 Java），返回工程类型 |
| `jdk()` | 探测 JDK：`JAVA_HOME` → 常见路径（`E:\CodeNode\tools\jdk-*`、`C:\Program Files\Java\*`）→ 手动指定 → 下载引导（Adoptium API） |
| `modules()` | Gradle `include 'x'` 或 Maven `<module>`，得到模块列表 |
| `dependencies()` | 解析依赖坐标，映射本地缓存（`~/.gradle`、`~/.m2`）或远程仓库 |
| `sourceRoots()` | `src/main/java`、`src/main/resources`、`src/test/java` 等源集 |
| `buildSystem()` | GRADLE / MAVEN / PLAIN 枚举，决定走哪个 Runner |
| `minecraftInfo()` | （MC 专用）识别 Fabric/Forge/NeoForge 加载器、MC 版本、mappings 类型 |

**解析策略**：优先用构建工具自身输出（`gradle tasks` / `gradle properties`、`mvn help:evaluate`）程序化读取；手写 DSL 解析仅作 fallback（Gradle 脚本是动态语言，不硬解析）。

### 4.2 JDK 管理（`JdkManager`）

- **探测**：扫描 `JAVA_HOME`、`C:\Program Files\Java\*`、`E:\CodeNode\tools\jdk-*`、`~/.codenode/jdks`，列出可用版本（读 `release` 文件 Java 版本号）
- **选择**：每个工程/运行配置可指定 JDK；默认继承工程设置
- **下载引导**：无匹配 JDK 时，从 Adoptium/Eclipse Temurin API 下载对应版本到 `~/.codenode/jdks`（进度条）
- **多 JDK**：支持工程用 JDK 17、运行时用 JDK 21 等不同组合（编译与运行可分离）

### 4.3 构建执行器（`BuildRunner`）

```java
public final class BuildRunner {
    static BuildResult run(JavaProject project, List<String> tasks, Consumer<String> logSink, Consumer<BuildError> errorSink);
}
```

- **GradleRunner**：探测 `gradlew.bat` → 系统 `gradle` → 内置发行版（下载 `~/.codenode/gradle`）；命令白名单 + 受控参数
- **MavenRunner**：探测 `mvnw.cmd` → 系统 `mvn`；白名单目标（`compile/test/package/exec:java/clean`）
- **JavacRunner**：纯 Java 工程用 `javac -d out -cp <deps>` 编译，classpath 从依赖模型组装
- **日志**：逐行推送到输出面板；匹配 `文件:行:列: error` → 错误列表 + 可跳转节点
- **超时/强杀**：复用 `LocalCompiler.run()` 的 ProcessBuilder 管理

### 4.4 运行启动器（`RunLauncher`）与运行配置

运行配置模型（对标 IntelliJ Run/Debug Configurations，可存多套）：
```java
record RunConfig(String name, Kind kind, String mainClass, String jarPath,
                 List<String> vmArgs, List<String> programArgs, Path workingDir,
                 List<String> beforeLaunch /* 构建步骤 */, boolean attachAgent) {}
enum Kind { MAIN_CLASS, JAR_APPLICATION, GRADLE_TASK, MAVEN_GOAL }
```

- **MAIN_CLASS**：`java -cp <classpath> 主类`，`-cp` 从依赖模型 + 编译产物组装
- **JAR_APPLICATION**：`java -jar xxx.jar`（需先执行 Artifact 打包）
- **GRADLE_TASK / MAVEN_GOAL**：委托 BuildRunner 执行（如 `runClient`、`exec:java`）
- **Before launch**：运行前自动执行构建步骤（编译/打包），对标 IntelliJ "Before launch: Build"
- **进程管理**：独立线程 + 停止/强杀/崩溃重启；输出到运行面板 + 退出码

### 4.5 JAR 打包（`ArtifactBuilder`）

- 配置：主类 + 打包依赖（module 依赖 / 外部库 / 全量 fat-jar）
- 生成 `MANIFEST.MF`（`Main-Class`、`Class-Path`）+ 拷贝 classes/资源/依赖 → 可运行 jar
- 输出到 `out/artifacts` 或工程 build 产物目录
- 对标 IntelliJ "Build | Build Artifacts"

### 4.6 调试器（`Debugger`，最小实现）

- **JDI 架构**：`jdk.jdi`（JDK 自带）attach 到 `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y` 启动的进程
- 能力：断点（行号/方法）、暂停/继续、调用栈、变量读取（本线程栈帧）
- 单步（step over/into/out）作为后续增强
- **衔接 Stage4.7**：不插桩即可用 jdwp 读取栈；插桩可补方法级详情

### 4.7 测试运行器（`TestRunner`）

- 识别 `@Test` 方法/类（JUnit 4/5 注解或命名约定）
- 方式 A：`gradle test` / `mvn test`（有构建系统）；方式 B：javac 编译测试 + 直跑
- 结果面板：用例列表、通过/失败、失败堆栈（定位 文件:行）
- 对标 IntelliJ "Tutorial: Get started with JUnit"

### 4.8 代码辅助（`CodeAssistant`，编辑器增强）

对标 IntelliJ 手册，按优先级：
1. **补全**：包内类名/方法补全（基于源码索引），`Ctrl+Space`
2. **Live Templates**：`main`/`psvm`/`fori`/`try` 等模板展开
3. **Inspections（检查）**：当前文件语法/常见问题标记（复用 `FileContentAnalyzer`/`NodeRegistry`）
4. **重构**（后续）：`Move`（移动类到包）、`Rename`（跨文件重命名）
5. 这些在 `CodeEditor` 上扩展，不阻塞核心构建/运行

### 4.9 UI（`ProjectWindow`）

- **新建项目**：向导（名称/位置/构建系统/JDK/是否 Git）
- **打开项目**：选目录 → 识别类型 → 加载工程树
- **工程树面板**（对标 Project 工具窗口 Alt+1）：源目录、模块、依赖库、测试
- **构建/运行/调试工具栏**：任务选择器 + 执行 + 停止
- **运行配置编辑器**：多套配置增删改
- **日志/错误/运行面板**：复用现有 ToolWindow（输出/错误/队列）

### 4.10 文件浏览器（左侧 Project 面板，对标 IntelliJ Project 工具窗口）

**布局**：左侧 `ToolWindow`（DockPosition.LEFT），显示项目目录树（`JTree`）。

**交互能力**：
| 交互 | 行为 |
|------|------|
| 双击文件 | ① 在画布创建/定位该文件的 FILE/ASSET 节点（复用 `indexLocalFile` 逻辑）；② 在代码栏（代码审查/编辑器）打开文件内容 |
| 拖拽文件到画布 | 在画布落点创建对应文件节点（CanvasPanel 增加 `DropTarget`/`TransferHandler`，接收 `javaFileListFlavor`） |
| 拖拽目录 | 整体作为一个组/文件节点导入 |
| 右键 | 打开文件 / 导入到画布 / 复制路径 / 在资源管理器中显示 |
| 刷新 | 重新扫描目录树（忽略缓存目录，复用 `ProjectScanner` 规则） |

**代码栏打开**：
- 文本文件：读内容 → `CodeEditor.setCode(...)`（复用现有代码审查编辑器），并可绑定文件节点代码槽（`model.ensureFileSlot(node).activeCode`）
- 二进制/资产：不读取内容，仅创建 ASSET 节点，提示用专用工具

**拖入生成节点**：
```java
// CanvasPanel 增加：
setTransferHandler(new TransferHandler() {
    boolean canImport(...) { return isFileFlavor; }
    boolean importData(...) {
        List<File> files = getFileList(); // DropTarget 落点转世界坐标
        for (File f : files) onFileDropped(f, dropPoint); // 回调给 MainFrame 建节点
    }
});
```
- MainFrame 注册 `canvas.onFileDropped(path, point)` → `model.addFileNode(...)` + `commitHistory()` + `loadInspector`

**实现要点**：
- 目录树构建复用 `DirectoryGraphBuilder` 的遍历/忽略规则（`ProjectScanner.isIgnoredDirName/isIgnoredExt`）
- `ProjectScanner` 已提供忽略判定，文件浏览器直接用
- 文件节点创建/代码栏打开复用 MainFrame 现有方法（`indexLocalFile`、`CodeReviewPanel.loadFrom`）
- EDT 约束：树刷新、节点创建都在 EDT

---

## 五、Minecraft 模组工程适配（MC 是其中一类）

| 加载器 | 关键差异 | 适配 |
|--------|---------|------|
| Forge / NeoForge | `build.gradle` 用 ForgeGradle 插件，任务 `runClient/runServer` | 识别插件 → 用 GradleRunner 跑对应任务；mappings（MCP/Mojmap） |
| Fabric | `fabric-loom` 插件，任务 `runClient`，`fabric.mod.json` | 识别 loom → runClient；loom 生成的依赖 |
| 通用 | MC 版本 + mappings 决定反混淆 | 衔接 Stage4.7 反混淆映射表 |

识别 `minecraftInfo()` 后，把构建/运行任务、mappings、资源目录（`src/main/resources`）自动配置好，用户无需手写 Gradle。

---

## 六、与现有代码衔接

| 现有 | 扩展 |
|------|------|
| `LocalCompiler` | 子进程管理（ProcessBuilder/超时/强杀/输出）抽为公共底层，供 GradleRunner/MavenRunner/RunLauncher/TestRunner 复用 |
| `ExecuteShellTool` 白名单 | 扩展 `gradle/gradlew/mvn/mvnw/java/jar/git`；新增工具 `build_project` / `run_project` / `test_project` / `package_jar` / `list_tasks` |
| `ScanProjectTool` | 新增 `mode=gradle`/`mode=maven`：扫描工程生成模块/依赖/产物节点图 |
| `RuntimeTraceService` | 叠加 Stage4.7 实时追踪（启动时挂 agent） |
| `CodeEditor` | 补全/模板/检查增强 |
| `MainFrame` | 「项目」菜单：新建/打开 Java 工程、构建/运行/调试/测试/打包 |
| `AgentChatController` harness | 追加规则：构建/运行/测试项目用对应工具，错误定位回显 |

---

## 七、关键约束与风险

1. **动态构建脚本**：不硬解析 Gradle DSL，用构建工具自身输出 + 少量正则 fallback，避免脆断。
2. **首次构建下载慢**：Gradle/Maven wrapper 首次需下载发行版+依赖；离线缓存 + 进度提示。
3. **多 JDK 组合**：编译/运行/调试可能用不同 JDK；运行配置需显式指定，避免误用。
4. **命令安全**：gradle/maven/git 白名单 + 参数校验，禁止任意参数注入；工作目录限制在工程内。
5. **进程生命周期**：runClient/长驻进程需独立线程 + 停止/强杀/崩溃重启。
6. **调试器复杂度**：JDI 调试涉及暂停/栈读取，做最小可用（断点+栈），单步作后续。
7. **MC 加载器差异**：不同加载器构建/运行任务名不同，需 `minecraftInfo()` 识别后自动配置。
8. **日志解析**：编译错误匹配 `文件:行:列` 定位；运行时异常栈匹配方法（衔接 Stage4.7）。

---

## 八、建议实施顺序

1. `JavaProject.discover` + `JdkManager`（探测 JDK）跑通。
2. `BuildRunner` 基础：纯 Java（JavacRunner）编译 + 日志流式回显 + 错误定位。
3. `GradleRunner`：`gradle tasks` / `compileJava` 跑通；MavenRunner 后续。
4. `RunLauncher` + 运行配置（MAIN_CLASS）：启动 + 停止 + 输出 + 退出码。
5. 新建项目向导 + 工程树面板（ProjectWindow）。
6. `ArtifactBuilder`：JAR 打包（主类+依赖）可运行。
7. `TestRunner`：JUnit 识别 + 运行 + 结果面板。
8. `Debugger` 最小实现（断点+栈）。
9. MC 模组适配（`minecraftInfo` → runClient）。
10. 衔接 Stage4.7（运行 + 实时追踪 + 反混淆映射）。
11. `CodeAssistant`（补全/模板/检查）渐进增强。
12. Git 面板（分支/提交/日志）。

*（内容由 AI 整理自 Stage4.8 内置完整 Java 项目开发环境方案，参考 IntelliJ IDEA 官方手册，仅供参考）*
*（内容由AI生成，仅供参考）*
