import local.codenode.*;
import local.codenode.agent.tools.*;
import local.codenode.agent.tools.impl.*;
import local.codenode.config.AgentConfig;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/**
 * Stage6 自检：固定文件分析程序 + 文件类型解析指引 + harness/工具设置。
 * 运行：java -cp target/classes Stage6Test
 */
public class Stage6Test {
    static int passed, failed;

    public static void main(String[] args) throws Exception {
        System.out.println("=== Stage6 固定文件分析 / 类型解析指引 / harness 设置 自检 ===");
        testTypeDetectorMagic();
        testTypeDetectorText();
        testAnalyzeFileJava();
        testAnalyzeFileBinaryRejected();
        testAnalyzeFileYamlAndProperties();
        testAnalyzeFileTruncation();
        testReadFileToolBinaryRejected();
        testReadFileToolAnalyzeMode();
        testAgentConfigToolFilter();
        testToolkitFilterByConfig();
        System.out.printf("=== 结果: %d PASS, %d FAIL ===%n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    // ---------- 1) 固定文件分析：magic bytes 检测 ----------

    static void testTypeDetectorMagic() throws Exception {
        System.out.println("[1] magic bytes 类型检测");
        Path tmp = Files.createTempDirectory("stage6-magic");
        try {
            // PNG
            Path png = tmp.resolve("icon.png");
            Files.write(png, hexBytes("89504E470D0A1A0A0000000D49484452"));
            FileTypeDetector.TypeInfo t = FileTypeDetector.detect(png);
            check("PNG 识别为图片", t.description().contains("PNG") && !t.text());

            // Java 字节码
            Path cls = tmp.resolve("Foo.class");
            Files.write(cls, hexBytes("CAFEBABE00000034000D0A0003000C"));
            t = FileTypeDetector.detect(cls);
            check(".class 识别为 Java 字节码", t.description().contains("Java 字节码") && !t.text());

            // ZIP
            Path zip = tmp.resolve("a.jar");
            Files.write(zip, hexBytes("504B0304140000000800A164"));
            t = FileTypeDetector.detect(zip);
            check("ZIP 识别为归档", t.description().contains("ZIP") && !t.text());

            // PDF
            Path pdf = tmp.resolve("doc.pdf");
            Files.write(pdf, hexBytes("255044462D312E340A25E2E3CFD3"));
            t = FileTypeDetector.detect(pdf);
            check("PDF 识别为文档", t.description().contains("PDF") && !t.text());
        } finally {
            deleteRecursively(tmp);
        }
    }

    static void testTypeDetectorText() throws Exception {
        System.out.println("[2] 文本/二进制判定");
        Path tmp = Files.createTempDirectory("stage6-text");
        try {
            Path java = tmp.resolve("Hello.java");
            Files.writeString(java, "package demo;\npublic class Hello { void run() {} }\n");
            FileTypeDetector.TypeInfo t = FileTypeDetector.detect(java);
            check("Java 源文件判定为文本", t.text() && t.description().contains("java"));

            Path bin = tmp.resolve("data.bin");
            Files.write(bin, hexBytes("000102030405060708090A0B0C0D0E0F"));
            t = FileTypeDetector.detect(bin);
            check("NUL 开头判定为二进制", !t.text() && t.kind() == FileTypeDetector.FileKind.BINARY);
        } finally {
            deleteRecursively(tmp);
        }
    }

    // ---------- 1) 固定文件分析：analyzeFile 统一入口 ----------

    static void testAnalyzeFileJava() throws Exception {
        System.out.println("[3] analyzeFile Java 结构摘要");
        Path tmp = Files.createTempDirectory("stage6-ana");
        try {
            Path java = tmp.resolve("Service.java");
            Files.writeString(java, """
                package demo;
                import java.util.List;
                import java.io.File;
                public class Service {
                    private int count = 0;
                    public String run(String name) { return name; }
                }
                """);
            FileContentAnalyzer.FileSummary s = FileContentAnalyzer.analyzeFile(java, 200);
            check("导入提取", s.imports.size() == 2 && s.imports.contains("java.util.List"));
            check("类提取", s.classes.contains("Service"));
            check("函数提取", s.functions.contains("run"));
            check("变量提取", s.variables.contains("count"));
            check("toPrompt 含类型行", s.toPrompt().startsWith("类型:"));
        } finally {
            deleteRecursively(tmp);
        }
    }

    static void testAnalyzeFileBinaryRejected() throws Exception {
        System.out.println("[4] analyzeFile 二进制拒绝读取");
        Path tmp = Files.createTempDirectory("stage6-bin");
        try {
            Path cls = tmp.resolve("Foo.class");
            Files.write(cls, hexBytes("CAFEBABE00000034000D0A0003000C"));
            FileContentAnalyzer.FileSummary s = FileContentAnalyzer.analyzeFile(cls, 200);
            check("二进制 kind=BINARY", s.kind == FileTypeDetector.FileKind.BINARY);
            check("二进制不含源码内容", s.functions.isEmpty() && s.classes.isEmpty());
            check("二进制给出解析建议", s.toPrompt().contains("javap"));
        } finally {
            deleteRecursively(tmp);
        }
    }

    static void testAnalyzeFileYamlAndProperties() throws Exception {
        System.out.println("[5] YAML / properties 摘要");
        Path tmp = Files.createTempDirectory("stage6-markup");
        try {
            Path yaml = tmp.resolve("config.yaml");
            Files.writeString(yaml, "server:\n  port: 8080\nname: demo\nenabled: true\n");
            FileContentAnalyzer.FileSummary s = FileContentAnalyzer.analyzeFile(yaml, 200);
            check("YAML 顶层键提取", s.variables.contains("server") && s.variables.contains("name"));

            Path props = tmp.resolve("app.properties");
            Files.writeString(props, "# comment\napp.name=CodeNode\napp.port=8080\n");
            s = FileContentAnalyzer.analyzeFile(props, 200);
            check("properties 键提取", s.variables.contains("app.name") && s.variables.contains("app.port"));
        } finally {
            deleteRecursively(tmp);
        }
    }

    static void testAnalyzeFileTruncation() throws Exception {
        System.out.println("[6] 大文件截断分析");
        Path tmp = Files.createTempDirectory("stage6-trunc");
        try {
            Path big = tmp.resolve("Big.java");
            StringBuilder sb = new StringBuilder("public class Big {\n");
            for (int i = 0; i < 500; i++) sb.append("  int v").append(i).append(";\n");
            sb.append("}\n");
            Files.writeString(big, sb.toString());
            FileContentAnalyzer.FileSummary s = FileContentAnalyzer.analyzeFile(big, 50);
            check("行数统计正确", s.lineCount == 502);
            check("截断标注", s.toPrompt().contains("截断，共 502 行"));
        } finally {
            deleteRecursively(tmp);
        }
    }

    // ---------- 2) 告诉 AI 解析文件类型：read_file 工具 ----------

    static void testReadFileToolBinaryRejected() throws Exception {
        System.out.println("[7] read_file 二进制拒绝");
        Path tmp = Files.createTempDirectory("stage6-read");
        try {
            Path png = tmp.resolve("icon.png");
            Files.write(png, hexBytes("89504E470D0A1A0A0000000D49484452"));
            AgentToolContext ctx = new AgentToolContext(() -> tmp, () -> null, msg -> true, entry -> {});
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(ctx);
            AgentToolResult r = registry.execute("read_file", Map.of("path", "icon.png"), ctx);
            check("二进制返回错误", !r.ok());
            check("错误信息含类型说明", r.text().contains("PNG"));
            check("错误信息含解析建议", r.text().contains("图片"));
        } finally {
            deleteRecursively(tmp);
        }
    }

    static void testReadFileToolAnalyzeMode() throws Exception {
        System.out.println("[8] read_file analyze=true 摘要模式");
        Path tmp = Files.createTempDirectory("stage6-analyze");
        try {
            Path java = tmp.resolve("Util.java");
            Files.writeString(java, "import java.util.Map;\npublic class Util { public static int add(int a, int b) { return a + b; } }\n");
            AgentToolContext ctx = new AgentToolContext(() -> tmp, () -> null, msg -> true, entry -> {});
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(ctx);
            AgentToolResult r = registry.execute("read_file",
                Map.of("path", "Util.java", "analyze", true), ctx);
            check("analyze 模式成功", r.ok());
            check("摘要含类 Util", r.text().contains("Util"));
            check("摘要含函数 add", r.text().contains("add"));
            check("摘要不含全文", !r.text().contains("return a + b"));
        } finally {
            deleteRecursively(tmp);
        }
    }

    // ---------- 3) harness 与工具设置 ----------

    static void testAgentConfigToolFilter() throws Exception {
        System.out.println("[9] AgentConfig 工具过滤");
        Path tmp = Files.createTempDirectory("stage6-cfg");
        try {
            Path props = tmp.resolve("agent.properties");
            Files.writeString(props, "tools.disabled=execute_shell,write_file\nharness.extra_prompt=不要动 config。\\n第二行\nread_file.max_lines=50\n", StandardCharsets.UTF_8);
            AgentConfig config = new AgentConfig(props);
            config.reload();
            check("禁用列表解析", config.disabledTools().contains("execute_shell") && config.disabledTools().contains("write_file"));
            check("禁用优先", !config.isToolAllowed("execute_shell"));
            check("未禁用保留", config.isToolAllowed("read_file"));
            check("自定义提示多行转义", config.extraHarnessPrompt().contains("不要动 config。\n第二行"));
            check("默认行数可配", config.readFileMaxLines() == 50);

            // 仅启用模式
            Path props2 = tmp.resolve("agent2.properties");
            Files.writeString(props2, "tools.enabled=read_file,find_files\n", StandardCharsets.UTF_8);
            AgentConfig config2 = new AgentConfig(props2);
            config2.reload();
            check("enabled 白名单放行", config2.isToolAllowed("read_file"));
            check("enabled 白名单拦截", !config2.isToolAllowed("execute_shell"));
        } finally {
            deleteRecursively(tmp);
        }
    }

    static void testToolkitFilterByConfig() throws Exception {
        System.out.println("[10] 工具注册表按配置过滤");
        Path tmp = Files.createTempDirectory("stage6-tools");
        try {
            Path props = tmp.resolve("agent.properties");
            Files.writeString(props, "tools.disabled=execute_shell,fetch_url,ask_user\n", StandardCharsets.UTF_8);
            AgentConfig config = new AgentConfig(props);
            config.reload();
            AgentToolContext ctx = new AgentToolContext(() -> tmp, () -> null, msg -> true, entry -> {});
            AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(ctx, config);
            List<String> names = registry.listTools().stream().map(spec -> spec.name()).toList();
            check("全量注册数=17", names.size() == 17 - 3);
            check("execute_shell 已移除", !names.contains("execute_shell"));
            check("read_file 保留", names.contains("read_file"));
            AgentToolResult r = registry.execute("execute_shell", Map.of("command", "echo hi"), ctx);
            check("移除后执行返回未知工具", !r.ok() && r.text().contains("未知工具"));
        } finally {
            deleteRecursively(tmp);
        }
    }

    // ---------- helpers ----------

    static byte[] hexBytes(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    static void deleteRecursively(Path path) throws Exception {
        if (path == null || !Files.exists(path)) return;
        try (var stream = Files.walk(path)) {
            stream.sorted(Comparator.reverseOrder()).forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception ignored) {} });
        }
    }

    static void check(String desc, boolean cond) {
        if (cond) { System.out.println("  PASS: " + desc); passed++; }
        else { System.out.println("  FAIL: " + desc); failed++; }
    }
}
