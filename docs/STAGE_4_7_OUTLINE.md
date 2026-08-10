---
AIGC:
    Label: "1"
---

# Stage4.7 方案：实时运行追踪（固定分析程序抓包理解项目在做什么）

> 工程：CodeNode 桌面应用（Java Swing 工作流节点编辑器，Maven，JDK21）
> 代码目录：`E:\CodeNode\codenode-desktop\src\main\java\local\codenode\`
> 方向转变：不再以「静态分析整个项目文件」来建立节点连接（数据量巨大、臃肿），改为**追踪目标程序运行时的方法调用轨迹**，用固定分析程序抓包理解程序实际做了什么。
> 状态：**方案讨论稿，仅提方案，不制作**

---

## 一、背景与目标

静态分析（全量扫描目录→组→文件节点）在大型工程下暴露问题：
- 数千节点、深嵌套，画布臃肿、渲染/交互沉重；
- 建图依赖目录结构，无法体现程序**真实运行逻辑**（谁调用了谁、走了哪条分支）。

**新方向**：通过一个**固定的分析程序**，持续或按需**抓取目标进程运行时的调用信息**，把「程序在做什么」转化为节点图/数据流——理解程序行为，而非罗列文件。

**目标**：
1. 实时/准实时捕捉运行中 Java 程序的**方法调用链、参数、返回值、异常**；
2. 固定分析程序（Java Agent / 采样器）负责采集，不侵入目标业务逻辑；
3. 采集结果映射到工作台节点图（调用→边、方法→节点、参数→端口值）。

---

## 二、总体架构

```
┌─────────────────────────────────────────────────────────┐
│ 目标 Java 程序（被监控）                                  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ JVM + java.lang.instrument 静态/动态字节码插桩      │  │
│  │ （Java Agent：ClassFileTransformer 织入探针）        │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │ 探针回调（方法进入/退出/异常）
                           ▼
┌─────────────────────────────────────────────────────────┐
│ 固定分析程序（本应用内模块，独立于目标进程）                │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 采集通道：本地 Socket / 命名管道 / 文件队列          │  │
│  │  └─ 调用轨迹缓冲（Ring Buffer，限流防爆）             │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ 语义解析：类/方法→节点，调用→边，参数/返回值→端口      │  │
│  │  └─ 聚合去重：按调用签名聚类，记录次数/时长/异常        │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ 工作台映射：实时或批量生成节点图 + runtime_trace      │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           ▼
                    CodeNode 工作台节点图
```

---

## 三、采集方案（重点评估三种）

### 方案 A：Java Agent 字节码插桩（推荐，Java 程序专用）
- **原理**：`-javaagent:codetrace-agent.jar` 随目标进程启动；`ClassFileTransformer` 在类加载时对方法织入探针（进入/退出/异常回调）；或 Attach API 动态加载到已运行进程。
- **捕获内容**：类名、方法名、参数摘要、返回值、耗时、异常栈、线程 id。
- **优点**：语义精确（真实调用链）、可过滤只关注业务包、采样率可控。
- **缺点**：需目标为 Java（本工程正是 Java 生态）；插桩有轻微性能开销（可限采样）；字节码织入较复杂。

### 方案 B：jstack / JFR / Async-profiler 采样（低侵入）
- **原理**：周期 dump 线程栈（jstack）或 JFR 记录方法采样 / CPU profile。
- **优点**：几乎零侵入、支持已运行进程、JFR 是 JDK 内置。
- **缺点**：采样是**近似**调用关系（栈快照聚合），不如插桩精确；无法直接拿参数/返回值；实时性差。

### 方案 C：外部抓包（网络/系统调用级）
- **原理**：对目标进程做网络抓包（tcpdump/Wireshark）、文件访问、系统调用监控（Procmon）。
- **优点**：不侵入目标 JVM，覆盖跨进程交互。
- **缺点**：**无法反映 Java 方法级调用**，只能看到网络/文件，与"理解程序逻辑"目标偏差大。

**推荐：方案 A 为主**（精确调用链），**方案 B 作为兜底**（无法插桩时采样）。方案 C 仅作为补充观察 I/O。

---

## 四、固定分析程序模块设计

| 模块 | 职责 | 关键点 |
|------|------|--------|
| `AgentProbe`（Java Agent，独立 jar） | 字节码插桩 + 探针回调 | `premain`/`agentmain`；`ClassFileTransformer`；按配置过滤包名/类名；采样率；`Instrumentation.retransformClasses` |
| `TraceCollector` | 接收探针回调，缓冲/限流 | 本地 `ServerSocket` 或命名管道；环形缓冲；按调用签名合并（累计次数/总耗时/最大耗时/异常数）；内存上限保护 |
| `TraceAnalyzer` | 轨迹→语义 | 方法→节点（含分类/入参出参端口）、调用→边、聚合统计；识别 main 入口与调用深度 |
| `TraceGraphMapper` | 映射到工作台 | 生成/更新节点图；`runtime_trace` 目标作用域复用；写 md 分析节点 |
| `RuntimeMonitor`（UI） | 启停/状态/实时刷新 | 「实时运行追踪」工具窗口；attach 目标进程或指定启动命令；开关采样 |

### 与现有代码的衔接
- **`RuntimeTraceService`**：已实现"目标节点作用域内代码槽→编译运行→收集程序/资产"。新方案扩展为：**目标进程运行时轨迹**，`runtime_trace` 结果叠加运行时调用数据。
- **`LocalCompiler`**：可复用其启动子进程的能力，作为"以指定命令启动目标程序 + 附加 agent"的入口。
- **`WriteAnalysisMdTool` / `write_analysis_md`**：把调用轨迹分析结果写成 md 节点，延续"在已分析项目上写分析节点"的链路。

---

## 五、工作台映射规则（核心概念）

1. **方法 → 节点**：被调用方法的签名（`类.方法(签名)`）作为节点名，分类 `analysis.*`；入参=输入端口，返回值=输出端口。
2. **调用 → 边**：A 方法调用 B 方法 → 边 A→B，端口为参数/返回值。
3. **入口 → 根**：`main` 或指定入口方法作为根节点。
4. **聚合**：高频调用合并为一个节点，记录 `调用次数/平均耗时/最大耗时/异常数`；超阈值展开为子图。
5. **过滤**：只追踪业务包（如 `com.qianxin.*` / `net.minecraft.*`），忽略 `java.*`/`jdk.*` 库内部，避免海量噪声。
6. **实时 vs 快照**：可实时流式更新，也可在某次操作后生成静态快照节点图。

---

## 六、关键约束与风险

1. **性能**：插桩必须限采样（如每方法每 N 秒记录一次）或按调用深度截断，防止吞吐下降/内存爆炸；环形缓冲上限 + 丢弃策略。
2. **侵入性**：Java Agent 不改业务字节码语义，但目标进程需 JVM 支持（本工程 Java 21，OK）；Attach 到已运行进程需同用户权限。
3. **噪声**：依赖包名过滤与聚合去重，否则图会爆炸。
4. **并发**：多线程程序调用交错，轨迹需带线程 id，边按「同一线程内时序」推断调用关系。
5. **安全**：抓包内容（参数/返回值）可能含敏感数据，仅本地展示、不入库、不写日志。

---

## 七、混淆程序的应对与外部监测（完全不动原程序）

### 7.1 混淆应对（按类型分级）

**是否需要开源？** 不需要。Java Agent 作用于**字节码**层面（`ClassFileTransformer` 在 `defineClass` 必经），只要目标能被 JVM 明文加载即可，闭源 jar / 反编译产物 / 第三方库都能织入。

| 混淆类型 | 表现 | 对策 |
|---------|------|------|
| 重命名混淆（ProGuard/R8） | `com.qianxin.Foo#bar` → `a.a.a#b` | 插桩仍可用，只是名不可读；配**反混淆映射表**（deobf map，Minecraft 官方发布 mappings）还原后再展示 |
| 加密类加载器 | 自定义 ClassLoader 解密后 defineClass | 插桩通常仍能看到（transformer 必经），除非 native 层解密 |
| 完整性校验 | 加载后校验哈希，发现被改即退出 | 插桩会被检测，需绕过校验（风险高，不建议） |
| 代码虚拟化（VMProtect 式） | 字节码转成自定义 VM 指令 | 插桩彻底失效，只能外部采样/行为观测 |

**建议路线**：重命名混淆 → 插桩 + mappings 映射表；无法织入 → 采样级（JFR）；只看行为 → 系统级观测。

### 7.2 外部监测（不织入字节码、不注入 agent）

| 方法 | 原理 | 侵入性 | 适用 |
|------|------|--------|------|
| **JFR**（首选） | JDK 内置，`jcmd <pid> JFR.start` 动态开启，采样方法执行/分配/锁；不织入字节码，动态 attach 运行中进程，无需重启 | 极低（采样） | 对混淆/加密程序也有效；方法名混淆可用映射表 |
| jstack 线程栈 | 周期 dump 线程栈聚合调用关系 | 极低 | 近似调用树、卡顿定位 |
| Async-profiler | 采样 CPU 火焰图，attach 运行进程 | 极低 | 性能热点 |
| Windows 系统级 | Procmon / ETW / Wireshark | 零 | 文件/网络/系统调用行为 |
| Arthas | 基于 attach 的动态增强 | 中等 | 已运行进程热诊断 |

**JFR 优势**：JDK 自带零部署、动态 attach 不重启、不织入字节码（加密/校验混淆也能工作）、记录方法级事件+异常+分配+锁。

**局限**：采样/事件而非精确调用树；拿不到参数/返回值细节；混淆后方法名不可读（需映射表）。

**组合建议**（针对 Minecraft / teacraft）：Agent 插桩（精确调用链）+ mappings 反混淆为主；JFR 外部采样为兜底；系统级抓包补充观察 I/O。

---

## 八、程序化实现设计（如何把以上效果做成代码）

### 8.1 采集端程序化（Java Agent）

**入口类**（独立 jar：`codetrace-agent.jar`）：
```java
public final class TraceAgent {
    // 静态挂载：目标启动时 -javaagent:codetrace-agent.jar=port=0,packages=com.qianxin.*
    public static void premain(String args, Instrumentation inst) throws Exception {
        Config cfg = Config.parse(args);              // 端口/包过滤/采样率/深度上限
        inst.addTransformer(new TraceTransformer(cfg), false);
    }
    // 动态挂载：Attach 到已运行进程（VirtualMachine.attach(pid) + loadAgent）
    public static void agentmain(String args, Instrumentation inst) throws Exception {
        Config cfg = Config.parse(args);
        inst.addTransformer(new TraceTransformer(cfg), true);
    }
}
```

**字节码织入**（`TraceTransformer implements ClassFileTransformer`）：
```java
byte[] transform(loader, className, ...) {
    if (!cfg.matches(className)) return null;       // 包过滤
    // 用 ASM（org.ow2.asm）读取字节码，ClassWriter 重写：
    //   方法入口插入  TraceProbe.enter(sig, args, threadId, parentDepth)
    //   方法返回插入  TraceProbe.exit(sig, ret, startNanos)
    //   异常处理插入 TraceProbe.thrown(sig, t, startNanos)
    // 采样：AtomicInteger 计数器取模，跳过部分方法
    // 深度上限：方法内静态计数，超限不织入
}
```

**探针本地缓冲**（不直接网络 IO，防阻塞目标）：
```java
public final class TraceProbe {
    // 无锁环形队列，容量可配（默认 10 万），满则丢弃最旧
    static final RingBuffer<Record> BUFFER = new RingBuffer<>(100_000);
    // ThreadLocal 调用栈：enter 压栈记录父签名，exit 弹栈
    static final ThreadLocal<Deque<String>> STACK = ThreadLocal.withInitial(ArrayDeque::new);
    public static void enter(String sig, Object[] args, long thr) {
        String parent = STACK.get().peek();         // 父调用签名
        BUFFER.add(new Record("enter", sig, truncateArgs(args), thr, parent));
        STACK.get().push(sig);
    }
    // ... exit / thrown 同理
}
```

**上报线程**：独立守护线程从 RingBuffer 批量取记录，经 `Socket` 发送到分析端；断线重连。

### 8.2 传输协议

本地 `ServerSocket`（分析端为 server，agent 为 client），每行一个 JSON：
```json
{"t":"enter","sig":"com.qianxin.Foo#bar(int,String)","args":["42","abc…"],"thr":12,"parent":"com.qianxin.Foo#main"}
{"t":"exit","sig":"com.qianxin.Foo#bar(int,String)","ret":"ok","dur":15320}
{"t":"throw","sig":"...","ex":"java.lang.NullPointerException","msg":"null","dur":1200}
{"t":"heartbeat","ts":1754600000000}
```

### 8.3 分析端程序化（固定分析程序）

**`TraceCollector`**：`ServerSocket` 监听 → 逐行 parse → 写入环形缓冲（上限保护）。

**`TraceAnalyzer`**：轨迹 → 语义模型
```java
record MethodNode(String sig, String cls, String method) { long count,totalNanos,maxNanos,errorCount; }
record CallEdge(String fromSig, String toSig) { long count; }
record CallTree(MethodNode root, Map<String,MethodNode> methods, List<CallEdge> edges) {}
```
- 按 `sig` 聚合方法统计；按 `(parent→sig)` 聚合调用边
- 排除 `java.*/jdk.*/sun.*`（除非配置包含）；`<init>` 只在顶级
- 从入口（main 或指定）按边重建调用树，限制节点数（如 500）

**`TraceGraphMapper`**：映射到工作台
| 轨迹 | 工作台 |
|------|--------|
| 入口方法 | 根节点（GROUP/SCOPE，分类 analysis.java） |
| 方法 | REGULAR 节点（名=`类.方法()`，prompt=签名+统计） |
| 入参/返回值 | 输入/输出端口 |
| 调用 A→B | 边 A.out→B.in |
| 异常 | 节点状态 FAILED + diagnostic |

**`RuntimeMonitor`（UI）**：ToolWindow——输入 PID 或启动命令 → attach/start；采样率滑块；包过滤框；定时（1s）刷新节点图/统计表；停止 detach/kill。

**反混淆映射**：`Deobfuscator` 读取 mappings 文件（`<in>=<out>`），展示前把混淆名还原。

### 8.4 衔接现有代码

- **`RuntimeTraceService`** 扩展 `traceLive(pid, packages, ...)`（Agent 采集）；现有 `trace()` 保留
- **`LocalCompiler`** 复用 `run()` 启动子进程 → 加 `-javaagent` 参数
- **`WriteAnalysisMdTool`** 把调用树分析写成 md 节点
- **`AgentToolkit`** 新增：`attach_trace`（attach 进程）、`runtime_call_graph`（取调用图）、`runtime_summary`（统计摘要）

### 8.5 外部监测程序化（JFR 兜底）

- 用 `jcmd` 子进程：`jcmd <pid> JFR.start name=trace settings=profile duration=0` → `JFR.dump filename=x.jfr` → `JFR.stop`
- 或 JDK `jdk.jfr` API：`FlightRecorder.startRecording` + `RecordingFile.readAllEvents(jfr)` 程序化解析事件
- `jstack` 子进程：周期 dump 线程栈，本地解析聚合调用栈
- 均通过 `LocalCompiler.run()`（现有子进程工具）启动，复用超时/强杀

---

## 九、建议实施顺序（后续若制作）

1. 最小 Agent：`ClassFileTransformer` 对指定包织入进入/退出探针 → Socket 上报。
2. `TraceCollector` 环形缓冲 + 调用签名聚合。
3. 简单示例程序跑通：启动目标 → 分析程序收到调用轨迹。
4. `TraceAnalyzer` 生成节点图（方法节点 + 调用边）。
5. 接入工作台：`RuntimeMonitor` 窗口 + `runtime_trace` 叠加 + `write_analysis_md`。
6. 反混淆映射表（Minecraft mappings）接入。
7. JFR 兜底通道（外部采样）接入。
8. 采样率/过滤/聚合调优 + 性能基准。

*（内容由 AI 整理自 Stage4.7 实时运行追踪方向讨论，仅供参考）*
*（内容由AI生成，仅供参考）*
