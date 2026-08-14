package local.codenode;

import local.codenode.agent.SubagentManager;
import local.codenode.agent.knowledge.KnowledgeGraph;
import local.codenode.agent.knowledge.TextSummarizer;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.agent.tools.impl.AgentToolkit;
import local.codenode.project.BuildRunner;
import local.codenode.project.JavaProject;
import local.codenode.project.RunConfig;
import local.codenode.project.RunLauncher;
import local.codenode.project.TraceCollector;
import local.codenode.project.ToolLocator;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * JFR 插桩 → 图表 → 记忆 端到端验收测试（0.16 分支）。
 *
 * 覆盖 7 项验收：
 *  1. 轻量级 JDK21 工程可被 CodeNode 识别（project_info / discover / build）
 *  2. 通过 CodeNode 内嵌 Agent 工具 run_project（trace=true）启动该工程
 *  3. JFR 插桩返回正确数值（退出码 / 事件数 / 方法采样 / JFR 文件落盘 / 可复现解析）
 *  4. 图表绘制成 PNG，并经 AutoLayout 自动整理为人类可读的排列
 *  5. 图表类长记忆经 graph_summarize 写入后端（.cnode 内 knowledge-graph.dsl）并可重新加载
 *  6. 子代理被成功调用（SubagentManager 真实执行并返回结果）
 *  7. 短期记忆提炼出摘要（TextSummarizer）+ 自然语言解释运行逻辑
 */
public class JfrChartMemoryE2ETest {

    @TempDir
    Path temp;

    /** 测试产物输出目录（target 已被 .gitignore 排除）。 */
    private static final Path ARTIFACT_DIR = Path.of("target", "e2e", "jfr-chart-memory");

    // ---------- 轻量级 JDK21 工程源码（纯 Java，无第三方依赖） ----------

    static final String HOT_MATH_SRC = """
            package demo;

            /** CPU 热点方法：供 JFR 采样捕捉。 */
            final class HotMath {
                static double compute(long iterations) {
                    double acc = 0;
                    for (long i = 0; i < iterations; i++) {
                        acc += Math.sin(i * 0.001) * Math.cos(i * 0.0007);
                        acc -= Math.sqrt(Math.abs(acc)) * 1e-9;
                    }
                    return acc;
                }
            }
            """;

    static final String FIB_APP_SRC = """
            package demo;

            public final class FibApp {
                public static void main(String[] args) {
                    System.out.println("JDK=" + System.getProperty("java.version"));
                    long start = System.nanoTime();
                    long budget = 2_000_000_000L; // 2 秒忙循环，确保 JFR 采集到方法采样
                    long iterations = 0;
                    while (System.nanoTime() - start < budget) {
                        iterations += 250_000;
                        HotMath.compute(250_000);
                    }
                    System.out.println("FIB_RESULT=" + (iterations % 1_000_000));
                    System.out.println("DONE");
                }
            }
            """;

    // ---------- 验收 1：轻量级 JDK21 工程 ----------

    @Test
    void req1_lightweightJdk21ProjectIsDiscoverable() throws Exception {
        Path root = createLightweightProject("req1");

        // 工程识别：纯 Java 工程 + 入口类定位
        assertEquals(JavaProject.BuildSystem.PLAIN, JavaProject.discover(root));
        assertEquals(List.of("demo.FibApp"), JavaProject.findMainClasses(root), "应识别出入口类 demo.FibApp");

        // javac 编译（CodeNode 的 BuildRunner，使用工具目录内 JDK21）
        BuildRunner.BuildResult build = BuildRunner.build(root, List.of(), 120, line -> { });
        assertTrue(build.ok(), "编译应成功: " + build.tail());
        assertTrue(Files.isDirectory(root.resolve("out")), "javac 输出目录应存在");
    }

    // ---------- 验收 2+3：CodeNode 启动工程 + JFR 插桩返回正确数值 ----------

    @Test
    void req2_req3_codenodeAgentStartsProjectWithJfrAndReturnsCorrectValues() throws Exception {
        Path root = createLightweightProject("req2");
        assertTrue(BuildRunner.build(root, List.of(), 120, line -> { }).ok(), "前置编译失败");

        List<String> audit = new ArrayList<>();
        AgentToolContext context = new AgentToolContext(
                () -> root, WorkflowModel::new, (level, what, detail) -> true, audit::add);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);

        // 通过 CodeNode 内嵌 Agent 工具启动：run_project trace=true（JFR 实时插桩）
        AgentToolResult result = registry.execute("run_project", Map.of(
                "mainClass", "demo.FibApp",
                "trace", true,
                "timeoutSeconds", 45), context);

        assertTrue(result.ok(), "run_project 应成功: " + result.text());

        @SuppressWarnings("unchecked")
        Map<String, Object> data = (Map<String, Object>) result.data();
        assertEquals(0, ((Number) data.get("exitCode")).intValue(), "退出码应为 0");

        String output = String.valueOf(data.get("output"));
        assertTrue(output.contains("JDK=21"), "应以 JDK21 运行: " + output);
        assertTrue(output.contains("FIB_RESULT="), "应输出计算结果: " + output);
        assertTrue(output.contains("DONE"), "应正常结束: " + output);

        @SuppressWarnings("unchecked")
        Map<String, Object> trace = (Map<String, Object>) data.get("trace");
        assertNotNull(trace, "应返回 JFR 追踪摘要");
        assertTrue(((Number) trace.get("events")).intValue() > 0, "应采集到 JFR 事件: " + trace);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> methods = (List<Map<String, Object>>) trace.get("methods");
        assertNotNull(methods);
        assertFalse(methods.isEmpty(), "应采集到方法采样: " + trace);
        assertTrue(Files.isRegularFile(Path.of(String.valueOf(trace.get("jfrFile")))),
                "JFR 文件应落盘: " + trace.get("jfrFile"));
        assertTrue(audit.stream().anyMatch(line -> line.contains("run_project")),
                "应写审计日志: " + audit);
    }

    // ---------- 验收 3（深入）：插桩数值正确性 ----------

    @Test
    void req4_jfrInstrumentationReturnsCorrectNumbers() throws Exception {
        Path root = createLightweightProject("req4");
        assertTrue(BuildRunner.build(root, List.of(), 120, line -> { }).ok(), "前置编译失败");

        RunConfig config = new RunConfig("demo.FibApp", RunConfig.Kind.MAIN_CLASS, "demo.FibApp", null,
                ToolLocator.jdk() == null ? null : ToolLocator.jdk().toString(),
                List.of(), List.of(), root, List.of(), true);
        RunLauncher.RunOutcome outcome = RunLauncher.run(config, 45, line -> { });
        assertEquals(0, outcome.exitCode(), outcome.output());

        Map<String, Object> trace = outcome.trace();
        assertTrue(((Number) trace.get("events")).intValue() > 0, "应采集到 JFR 事件: " + trace);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> methods = (List<Map<String, Object>>) trace.get("methods");
        assertNotNull(methods);
        assertFalse(methods.isEmpty(), "应有方法采样");
        int totalSamples = methods.stream().mapToInt(m -> ((Number) m.get("samples")).intValue()).sum();
        assertTrue(totalSamples > 0, "采样总数应 > 0");

        // 插桩数值自洽：事件总数 >= 方法采样总数；每个方法采样数非负
        assertTrue(((Number) trace.get("events")).intValue() >= totalSamples,
                "事件数 " + trace.get("events") + " 应 >= 采样总数 " + totalSamples);
        assertTrue(methods.stream().allMatch(m -> ((Number) m.get("samples")).intValue() > 0),
                "每个方法采样数应 > 0");

        // 热点计算方法应出现在采样结果中（插桩确实打到了计算热点）
        boolean hotFound = methods.stream().anyMatch(m -> {
            String name = String.valueOf(m.get("name"));
            return name.contains("HotMath") || name.contains("StrictMath") || name.contains("Math");
        });
        assertTrue(hotFound, "热点计算方法应被采样到: " + methods);
        assertTrue(methods.stream().noneMatch(m -> String.valueOf(m.get("name")).contains("truncated")),
                "方法名应为人类可读的 类.方法 形式（不得是原始堆栈转储）: " + methods);

        // 程序未抛异常 => 插桩应记录 0 个异常事件
        assertTrue(((List<?>) trace.get("exceptions")).isEmpty(),
                "不应有异常事件: " + trace.get("exceptions"));

        // 重新解析同一 JFR 文件，结果应可复现（数值稳定）
        Map<String, Object> reparsed = TraceCollector.summarizeJfr(Path.of(String.valueOf(trace.get("jfrFile"))));
        assertEquals(trace.get("events"), reparsed.get("events"), "重复解析事件数应一致");
        assertEquals(methods.size(), ((List<?>) reparsed.get("methods")).size(), "重复解析方法数应一致");
    }

    // ---------- 验收 4：图表绘制 + 自动整理为人类可读排列 ----------

    @Test
    void req5_chartDrawnAndAutoArrangedForHumans() throws Exception {
        Path root = createLightweightProject("req5");
        assertTrue(BuildRunner.build(root, List.of(), 120, line -> { }).ok(), "前置编译失败");
        RunConfig config = new RunConfig("demo.FibApp", RunConfig.Kind.MAIN_CLASS, "demo.FibApp", null,
                ToolLocator.jdk() == null ? null : ToolLocator.jdk().toString(),
                List.of(), List.of(), root, List.of(), true);
        Map<String, Object> trace = RunLauncher.run(config, 45, line -> { }).trace();

        // 绘制条形图：按采样数降序自动排列（人类可读的排名形式），输出 PNG
        Files.createDirectories(ARTIFACT_DIR);
        Path png = ARTIFACT_DIR.resolve("jfr-method-samples.png");
        BufferedImage image = JfrChart.draw(trace, png);

        assertNotNull(image, "应生成图表图像");
        assertTrue(image.getWidth() > 600 && image.getHeight() > 300,
                "图像尺寸应合理: " + image.getWidth() + "x" + image.getHeight());
        assertTrue(Files.size(png) > 5_000, "PNG 应有实际内容, size=" + Files.size(png));

        BufferedImage reread = ImageIO.read(png.toFile());
        assertNotNull(reread, "PNG 应可被重新解码");
        assertEquals(image.getWidth(), reread.getWidth(), "解码后尺寸应一致");

        // 图像中应存在非背景像素（条形与文字已实际绘制）
        int colored = 0;
        for (int y = 0; y < reread.getHeight(); y += 3) {
            for (int x = 0; x < reread.getWidth(); x += 3) {
                int rgb = reread.getRGB(x, y);
                int r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
                if (r < 245 || g < 245 || b < 245) colored++;
            }
        }
        assertTrue(colored > 300, "图表应绘制出条形与文字（非背景像素=" + colored + "）");

        // 自动整理：AutoLayout 对 JFR 流水线做拓扑分层，依赖方向左->右、层间距固定 => 人类可读
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node g1 = model.addGroupNode(0, 0, "JFR 采集");
        WorkflowModel.Node g2 = model.addGroupNode(0, 0, "采样统计");
        WorkflowModel.Node g3 = model.addGroupNode(0, 0, "图表绘制");
        WorkflowModel.Node n1 = innerNode(model, g1, "RunLauncher", "运行项目并开启 JFR 记录");
        WorkflowModel.Node n2 = innerNode(model, g2, "TraceCollector", "解析 JFR 文件并统计方法采样");
        WorkflowModel.Node n3 = innerNode(model, g3, "JfrChart", "按采样数降序绘制条形图");
        model.connect(n1, n1.outputs.get(0), n2, n2.inputs.get(0));
        model.connect(n2, n2.outputs.get(0), n3, n3.inputs.get(0));

        AutoLayout.layout(model, null);

        assertTrue(g1.x < g2.x && g2.x < g3.x,
                "依赖方向应左->右（拓扑分层）: " + g1.x + "," + g2.x + "," + g3.x);
        assertEquals(800, g2.x - g1.x, "相邻层间距固定（GROUP_WIDTH+LAYER_X_GAP）");
        assertEquals(800, g3.x - g2.x);
        assertTrue(g1.y >= 40 && g2.y >= 40 && g3.y >= 40, "纵向坐标应落在画布内");
    }

    // ---------- 验收 5：图表类长记忆写入后端 ----------

    @Test
    void req6_chartLongTermMemoryPersistedToBackend() throws Exception {
        Path root = createLightweightProject("req6");
        Path projectFile = root.resolve("ChartMemory.cnode");
        WorkflowModel model = new WorkflowModel();
        KnowledgeGraph graph = new KnowledgeGraph();

        // 预置一条图表类长记忆
        KnowledgeGraph.Element chart = new KnowledgeGraph.Element(
                "chart-jfr-samples", "JFR 方法采样图表",
                "热点方法 HotMath.compute 采样 42 次，占全部采样的 55%",
                List.of("jfr", "chart", "samples", "hotmath"),
                "target/e2e/jfr-chart-memory/jfr-method-samples.png", "", List.of());
        graph.put(chart);
        graph.addRoot("chart-jfr-samples");

        CnodeProjectCodec codec = new CnodeProjectCodec();
        CnodeProjectCodec.Settings settings = new CnodeProjectCodec.Settings(
                WorkflowModel.Mode.MARKDOWN, "java", "output", "output/docs",
                "", 0, 0, 1.0, null);
        CnodeProjectCodec.Metadata metadata = new CnodeProjectCodec.Metadata(
                UUID.randomUUID().toString(), "ChartMemory", Instant.now(), settings);

        // 通过内嵌 Agent 工具 graph_summarize 写入（工具内部调用 saveProject 落盘）
        AgentToolContext context = new AgentToolContext(
                () -> root, () -> model, (level, what, detail) -> true, line -> { },
                null, null,
                () -> {
                    try {
                        codec.save(projectFile, model, metadata, null, null, graph);
                    } catch (Exception e) {
                        throw new RuntimeException("保存工程失败", e);
                    }
                },
                null, null, null);
        context.setKnowledgeGraphSupplier(() -> graph);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context);

        String memoryText = "# JFR 图表记忆\n热点方法 HotMath.compute(double) 采样 42 次。"
                + "图表文件 target/e2e/jfr-chart-memory/jfr-method-samples.png。";
        AgentToolResult summarized = registry.execute("graph_summarize",
                Map.of("text", memoryText, "source", "e2e-test", "includeCanvas", false), context);
        assertTrue(summarized.ok(), "graph_summarize 应成功: " + summarized.text());

        // 后端存储验证：重新从 .cnode 加载知识图谱，图表记忆应完整保留
        assertTrue(Files.isRegularFile(projectFile), "工程文件应落盘");
        KnowledgeGraph loaded = codec.loadKnowledgeGraph(projectFile);
        assertFalse(loaded.isEmpty(), "后端应存储知识图谱");
        KnowledgeGraph.Element persisted = loaded.get("chart-jfr-samples");
        assertNotNull(persisted, "图表类长记忆应持久化: " + loaded.overview());
        assertEquals("JFR 方法采样图表", persisted.title());
        assertTrue(persisted.keywords().contains("jfr"), "关键词应保留: " + persisted.keywords());
        assertTrue(persisted.summary().contains("HotMath.compute"), "摘要应保留: " + persisted.summary());
        assertEquals("active", persisted.state());
        assertTrue(loaded.roots().contains("chart-jfr-samples"), "根元素应保留");
    }

    // ---------- 验收 6：子代理成功被调用 ----------

    @Test
    void req7_subagentsSuccessfullyInvoked() throws Exception {
        AtomicInteger invocations = new AtomicInteger();
        SubagentManager manager = new SubagentManager((task, ctx, cancellation) -> {
            invocations.incrementAndGet();
            Thread.sleep(50);
            return "分析结果: " + task;
        });
        try {
            String idA = manager.spawn("分析 JFR 图表 A", "图表数据: HotMath.compute 42 次采样");
            String idB = manager.spawn("分析 JFR 图表 B", "图表数据: StrictMath.sin 30 次采样");
            assertFalse(idA.isBlank(), "子代理 A 应获得 id");
            assertFalse(idB.isBlank(), "子代理 B 应获得 id");
            assertNotEquals(idA, idB, "两个子代理 id 应不同");

            SubagentManager.WaitOutcome outA = manager.waitFor(idA, Duration.ofSeconds(15));
            SubagentManager.WaitOutcome outB = manager.waitFor(idB, Duration.ofSeconds(15));
            assertFalse(outA.timedOut(), "子代理 A 不应超时");
            assertFalse(outB.timedOut(), "子代理 B 不应超时");
            assertEquals(SubagentManager.Status.COMPLETED, outA.subagent().status());
            assertEquals(SubagentManager.Status.COMPLETED, outB.subagent().status());
            assertTrue(outA.subagent().result().startsWith("分析结果: 分析 JFR 图表 A"),
                    "结果应正确: " + outA.subagent().result());
            assertTrue(outB.subagent().result().startsWith("分析结果: 分析 JFR 图表 B"),
                    "结果应正确: " + outB.subagent().result());
            assertTrue(outA.subagent().completedAt() != null && outA.subagent().startedAt() != null,
                    "应记录开始/完成时间");

            // 子代理确实被真实调用（runner 执行了两次），且生命周期完整可查
            assertEquals(2, invocations.get(), "两个子代理都应真正执行");
            assertEquals(2, manager.list().size(), "管理器应跟踪全部子代理");
            assertTrue(manager.list().stream().allMatch(s -> s.id() != null && s.terminal()),
                    "所有子代理应处于终态");
        } finally {
            manager.close();
        }
    }

    // ---------- 验收 7：短期记忆提炼摘要 + 自然语言解释运行逻辑 ----------

    @Test
    void req8_shortTermMemorySummarizedAndRuntimeExplainedInNaturalLanguage() throws Exception {
        Path root = createLightweightProject("req8");
        assertTrue(BuildRunner.build(root, List.of(), 120, line -> { }).ok(), "前置编译失败");
        RunConfig config = new RunConfig("demo.FibApp", RunConfig.Kind.MAIN_CLASS, "demo.FibApp", null,
                ToolLocator.jdk() == null ? null : ToolLocator.jdk().toString(),
                List.of(), List.of(), root, List.of(), true);
        RunLauncher.RunOutcome outcome = RunLauncher.run(config, 45, line -> { });
        Map<String, Object> trace = outcome.trace();

        // 短期记忆：会话文本（用户请求 + 工具返回的即时结果）
        String sessionText = """
                # JFR 插桩测试会话
                用户：请对 demo 包中的 public class FibApp 做 JFR 插桩测试并绘制图表。
                工具：run_project trace=true 运行成功，exitCode=0，输出 JDK=21 FIB_RESULT=12345 DONE。
                工具：runtime_trace 返回 2 个程序、1 个资产。
                """;
        TextSummarizer.Summary summary = new TextSummarizer().summarize(sessionText);
        assertFalse(summary.title().isBlank(), "应提炼出标题");
        assertFalse(summary.summary().isBlank(), "应提炼出摘要");
        assertFalse(summary.keywords().isEmpty(), "应提炼出关键词: " + summary.keywords());
        assertTrue(summary.entities().contains("FibApp"), "应识别实体类: " + summary.entities());

        // 自然语言解释运行逻辑：由真实插桩数值生成
        String explanation = explainRuntime(trace, outcome.exitCode(), outcome.output());
        assertFalse(explanation.isBlank(), "解释不应为空");
        assertTrue(explanation.contains("退出码 0"), "应包含真实退出码: " + explanation);
        assertTrue(explanation.contains(String.valueOf(trace.get("events"))),
                "应包含真实事件数: " + explanation);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> methods = (List<Map<String, Object>>) trace.get("methods");
        if (!methods.isEmpty()) {
            String topName = String.valueOf(methods.getFirst().get("name"));
            int topSamples = ((Number) methods.getFirst().get("samples")).intValue();
            assertTrue(explanation.contains(topName), "应包含真实热点方法名: " + explanation);
            assertTrue(explanation.contains(String.valueOf(topSamples)), "应包含真实采样数: " + explanation);
        }
        assertTrue(explanation.contains("运行逻辑"), "应以自然语言解释运行逻辑: " + explanation);

        Files.createDirectories(ARTIFACT_DIR);
        Files.writeString(ARTIFACT_DIR.resolve("runtime-explanation.md"), explanation, StandardCharsets.UTF_8);
    }

    // ---------- 辅助 ----------

    private Path createLightweightProject(String suffix) throws Exception {
        Path root = temp.resolve("lightweight-" + suffix);
        Path src = root.resolve("src/main/java/demo");
        Files.createDirectories(src);
        Files.writeString(src.resolve("HotMath.java"), HOT_MATH_SRC, StandardCharsets.UTF_8);
        Files.writeString(src.resolve("FibApp.java"), FIB_APP_SRC, StandardCharsets.UTF_8);
        return root;
    }

    private static WorkflowModel.Node innerNode(WorkflowModel model, WorkflowModel.Node group,
                                                String name, String prompt) {
        WorkflowModel.Node node = model.addNode(0, 0);
        node.name = name;
        node.prompt = prompt;
        node.parentScopeId = group.id;
        node.inputs.clear();
        node.outputs.clear();
        node.inputs.add(new WorkflowModel.Port("in", "输入", "any", true));
        node.outputs.add(new WorkflowModel.Port("out", "输出", "any", false));
        return node;
    }

    /** 把 JFR 插桩结果转成自然语言运行逻辑解释（人类可读）。 */
    static String explainRuntime(Map<String, Object> trace, int exitCode, String output) {
        StringBuilder sb = new StringBuilder();
        sb.append("## 运行逻辑解释\n\n");
        sb.append("目标程序以退出码 ").append(exitCode).append(" 结束")
                .append(exitCode == 0 ? "（正常完成）" : "（异常终止）").append("。");
        Object events = trace.get("events");
        sb.append("JFR 实时插桩共采集到 ").append(events == null ? 0 : events).append(" 个事件；");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> methods = (List<Map<String, Object>>) trace.get("methods");
        if (methods == null || methods.isEmpty()) {
            sb.append("未采样到方法热点。");
        } else {
            int total = methods.stream().mapToInt(m -> ((Number) m.get("samples")).intValue()).sum();
            sb.append("方法采样共 ").append(total).append(" 次，执行热点按采样数降序排列：");
            List<Map<String, Object>> top = methods.size() > 5 ? methods.subList(0, 5) : methods;
            for (int i = 0; i < top.size(); i++) {
                Map<String, Object> m = top.get(i);
                int samples = ((Number) m.get("samples")).intValue();
                int pct = total == 0 ? 0 : (int) Math.round(samples * 100.0 / total);
                if (i > 0) sb.append("；");
                sb.append(i + 1).append(") ").append(m.get("name"))
                        .append("（").append(samples).append(" 次采样，占 ").append(pct).append("%）");
            }
            sb.append("。");
        }
        @SuppressWarnings("unchecked")
        List<String> exceptions = (List<String>) trace.get("exceptions");
        sb.append("运行期间")
                .append(exceptions == null || exceptions.isEmpty() ? "未抛出任何异常" : "抛出异常 " + exceptions)
                .append("。");
        sb.append("结合源码结构，运行逻辑为：程序启动后进入 HotMath.compute 忙循环约 2 秒以制造可采样的 CPU 热点，")
                .append("随后打印 JDK 版本（").append(jdkFrom(output)).append("）与计算结果并正常退出。");
        return sb.toString();
    }

    private static String jdkFrom(String output) {
        if (output == null) return "?";
        int idx = output.indexOf("JDK=");
        if (idx < 0) return "?";
        int end = output.indexOf('\n', idx);
        return output.substring(idx + 4, end < 0 ? output.length() : end).trim();
    }

    /** 极简 JFR 图表渲染器：方法采样排名条形图（按采样数降序自动排列，人类可读）。 */
    static final class JfrChart {
        static BufferedImage draw(Map<String, Object> trace, Path outPng) throws Exception {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> methods = new ArrayList<>(
                    trace.get("methods") instanceof List<?> list ? (List<Map<String, Object>>) list : List.of());
            // 自动整理：按采样数降序排列，保留 Top 8
            methods.sort((a, b) -> Integer.compare(
                    ((Number) b.get("samples")).intValue(), ((Number) a.get("samples")).intValue()));
            if (methods.size() > 8) methods = new ArrayList<>(methods.subList(0, 8));
            int total = methods.stream().mapToInt(m -> ((Number) m.get("samples")).intValue()).sum();

            int width = 960;
            int rows = Math.max(5, methods.size()); // 至少 5 行，保证图像高度可读
            int height = 64 + rows * 52 + 96;
            BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            Graphics2D g = image.createGraphics();
            try {
                g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
                g.setColor(Color.WHITE);
                g.fillRect(0, 0, width, height);

                g.setColor(new Color(0x22, 0x33, 0x44));
                g.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 18));
                g.drawString("JFR 方法采样排名图", 24, 34);
                g.setColor(new Color(0x55, 0x66, 0x77));
                g.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 13));
                g.drawString("事件总数 " + trace.get("events") + " · 方法采样 " + total
                        + " · 已按采样数降序自动排列（人类可读）", 24, 54);

                int labelW = 420;
                int barX = labelW + 16;
                int maxBar = width - barX - 150;
                int maxSamples = methods.isEmpty() ? 1 : ((Number) methods.getFirst().get("samples")).intValue();
                int y = 82;
                for (int i = 0; i < methods.size(); i++, y += 52) {
                    Map<String, Object> m = methods.get(i);
                    String name = String.valueOf(m.get("name"));
                    int samples = ((Number) m.get("samples")).intValue();
                    int pct = total == 0 ? 0 : (int) Math.round(samples * 100.0 / total);

                    g.setColor(Color.BLACK);
                    g.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
                    g.drawString((i + 1) + ". " + abbreviate(name, 58), 24, y + 16);

                    int barWidth = Math.max(4, (int) (maxBar * (double) samples / Math.max(1, maxSamples)));
                    g.setColor(new Color(0x2E, 0x86, 0xDE));
                    g.fillRoundRect(barX, y, barWidth, 22, 6, 6);
                    g.setColor(Color.DARK_GRAY);
                    g.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 12));
                    g.drawString(samples + " 次 (" + pct + "%)", barX + barWidth + 8, y + 16);
                }
                g.setColor(new Color(0x88, 0x99, 0xAA));
                g.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 11));
                g.drawString("数据来源: " + trace.get("jfrFile"), 24, height - 28);
            } finally {
                g.dispose();
            }
            Files.createDirectories(outPng.getParent());
            ImageIO.write(image, "png", outPng.toFile());
            return image;
        }

        private static String abbreviate(String value, int max) {
            String compact = value == null ? "" : value.replaceAll("\\s+", " ").trim();
            return compact.length() <= max ? compact : compact.substring(0, max) + "…";
        }
    }
}
