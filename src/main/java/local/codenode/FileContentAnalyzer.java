package local.codenode;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

public final class FileContentAnalyzer {
    private FileContentAnalyzer() {}

    public static final class FileSummary {
        public final String language;
        public final int lineCount;
        public final List<String> imports = new ArrayList<>();
        public final List<String> classes = new ArrayList<>();
        public final List<String> functions = new ArrayList<>();
        public final List<String> variables = new ArrayList<>();
        public final List<String> annotations = new ArrayList<>();
        public final String rawSummary;

        FileSummary(String language, int lineCount, String rawSummary) {
            this.language = language;
            this.lineCount = lineCount;
            this.rawSummary = rawSummary;
        }

        public String toPrompt() {
            StringBuilder sb = new StringBuilder();
            sb.append("语言: ").append(language).append(", 行数: ").append(lineCount).append("\n");
            if (!imports.isEmpty()) sb.append("导入/引用: ").append(String.join(", ", imports)).append("\n");
            if (!classes.isEmpty()) sb.append("类/结构体: ").append(String.join(", ", classes)).append("\n");
            if (!functions.isEmpty()) sb.append("函数/方法: ").append(String.join(", ", functions)).append("\n");
            if (!variables.isEmpty()) sb.append("变量/常量: ").append(String.join(", ", variables)).append("\n");
            if (!annotations.isEmpty()) sb.append("注解/装饰器: ").append(String.join(", ", annotations)).append("\n");
            if (!rawSummary.isBlank()) sb.append("\n内容概要:\n").append(rawSummary);
            return sb.toString().trim();
        }
    }

    /**
     * 对 .class 字节码文件调用 javap -public -p 反汇编，提取类名、方法签名、字段信息。
     */
    public static FileSummary analyzeClassFile(Path classPath) throws IOException {
        String name = classPath.getFileName().toString();
        FileSummary summary = new FileSummary("java", 0, "");

        try {
            ProcessBuilder pb = new ProcessBuilder(
                "javap", "-p",
                classPath.toAbsolutePath().toString()
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            String output = new String(p.getInputStream().readAllBytes());
            int exitCode = p.waitFor();

            if (exitCode == 0 && !output.isBlank()) {
                for (String line : output.split("\\R")) {
                    String t = line.trim();
                    if (t.isBlank() || t.equals("}")) continue;

                    // 类定义行: "public class Foo extends Bar {" 或 "public class Foo {"
                    if (t.contains(" class ") && (t.endsWith("{") || t.contains("extends") || t.contains("implements"))) {
                        String cn = t.replaceAll("(public |abstract |final )*class ", "")
                                    .split("[\\s{<]")[0].trim();
                        summary.classes.add(cn);
                        continue;
                    }
                    // 接口定义行
                    if (t.contains(" interface ") && (t.endsWith("{") || t.contains("extends"))) {
                        String cn = t.replaceAll("(public |abstract )*interface ", "")
                                    .split("[\\s{<]")[0].trim();
                        summary.classes.add(cn);
                        continue;
                    }
                    // 方法签名: 含括号的行
                    if (t.contains("(") && t.contains(")")) {
                        summary.functions.add(cleanJavapSignature(t));
                        continue;
                    }
                    // 字段/变量声明
                    if (t.contains(";") && !t.contains("(") && !t.contains("Compiled from") && !t.startsWith("//")) {
                        summary.variables.add(t.replace(";", "").trim());
                    }
                }
            } else {
                summary.variables.add("javap 反汇编失败（exit=" + exitCode + "）");
            }
        } catch (IOException | InterruptedException e) {
            summary.variables.add("javap 调用异常: " + e.getMessage());
        }
        return summary;
    }

    /**
     * 将 javap 输出的方法签名行清洗为紧凑形式。
     * 例: "  public static void main(java.lang.String[]);" → "main(String[])"
     * 例: "  public int foo(int, java.lang.String);" → "foo(int, String)"
     */
    private static String cleanJavapSignature(String line) {
        String s = line.trim();
        // 去尾部分号
        if (s.endsWith(";")) s = s.substring(0, s.length() - 1);
        // 去掉 modifiers 关键词
        s = s.replaceAll("\\b(public |private |protected |static |final |abstract |synchronized |native |volatile |transient |strictfp )", "");
        // 提取方法名（最后一个点号后、左括号前的词）
        int paren = s.indexOf('(');
        if (paren < 0) return s;
        String beforeParen = s.substring(0, paren);
        String afterParen = s.substring(paren);
        int lastDot = beforeParen.lastIndexOf('.');
        String methodName = lastDot >= 0 ? beforeParen.substring(lastDot + 1) : beforeParen;
        // 简化参数类型（去掉包名）
        String params = afterParen.replaceAll("[\\w.]+\\.([A-Z][\\w$]+)", "$1");
        return (methodName + params).trim();
    }

    public static FileSummary analyze(Path filePath) throws IOException {
        String content = Files.readString(filePath);
        String fileName = filePath.getFileName().toString().toLowerCase(java.util.Locale.ROOT);
        String language = detectLanguage(fileName);
        int lineCount = content.lines().toArray().length;
        FileSummary summary = new FileSummary(language, lineCount, "");

        for (String line : content.split("\\R")) {
            String trimmed = line.trim();
            if (trimmed.isBlank()) continue;

            switch (language) {
                case "java" -> analyzeJavaLine(trimmed, summary);
                case "python" -> analyzePythonLine(trimmed, summary);
                case "javascript", "typescript" -> analyzeJsLine(trimmed, summary);
                case "cpp", "c" -> analyzeCppLine(trimmed, summary);
                case "go" -> analyzeGoLine(trimmed, summary);
                case "rust" -> analyzeRustLine(trimmed, summary);
                case "csharp" -> analyzeCSharpLine(trimmed, summary);
                case "json" -> analyzeJsonContent(content, summary);
                case "xml", "html" -> analyzeXmlContent(content, summary);
                default -> {}
            }
        }
        return summary;
    }

    public static List<Map<String, Object>> generateNodesForExpansion(WorkflowModel model, FileSummary summary, int baseX, int baseY) {
        List<Map<String, Object>> nodes = new ArrayList<>();
        int y = baseY + 60;
        for (String imp : summary.imports) {
            nodes.add(Map.of("type", "import", "name", imp, "x", baseX, "y", y));
            y += 60;
        }
        for (String var : summary.variables) {
            nodes.add(Map.of("type", "variable", "name", var, "x", baseX, "y", y));
            y += 60;
        }
        for (String func : summary.functions) {
            nodes.add(Map.of("type", "function", "name", func, "x", baseX, "y", y));
            y += 60;
        }
        return nodes;
    }

    private static void analyzeJavaLine(String line, FileSummary s) {
        if (line.startsWith("import ")) s.imports.add(extractWord(line.replace("import ", "").replace(";", "").trim()));
        else if (line.startsWith("package ")) s.annotations.add(line.trim());
        else if (line.matches("(public|private|protected|static|abstract|final)*\\s*class\\s+\\w+")) s.classes.add(extractClass(line));
        else if (line.matches("(public|private|protected|static|abstract|final)*\\s*(interface|enum)\\s+\\w+")) s.classes.add(extractClass(line));
        else if (line.matches("(public|private|protected|static|abstract|final)*\\s+\\w+\\s+\\w+\\s*\\(.*\\)") && !line.contains("=")) s.functions.add(extractFunction(line));
        else if (line.startsWith("@")) s.annotations.add(line.trim());
    }

    private static void analyzePythonLine(String line, FileSummary s) {
        if (line.startsWith("import ") || line.startsWith("from ")) s.imports.add(line.trim());
        else if (line.startsWith("def ")) s.functions.add(extractFunction(line));
        else if (line.startsWith("class ")) s.classes.add(extractClass(line));
        else if (line.startsWith("@")) s.annotations.add(line.trim());
        else if (line.contains(" = ") && !line.contains("(") && line.length() < 80) s.variables.add(line.split(" = ")[0].trim());
    }

    private static void analyzeJsLine(String line, FileSummary s) {
        if (line.startsWith("import ") || line.startsWith("require(") || line.startsWith("const ") && line.contains("require(")) s.imports.add(line.trim());
        else if (line.matches("(export\\s+)?(async\\s+)?function\\s+\\w+.*")) s.functions.add(extractFunction(line));
        else if (line.startsWith("class ")) s.classes.add(extractClass(line));
        else if (line.startsWith("@")) s.annotations.add(line.trim());
        else if (line.matches("(const|let|var)\\s+\\w+\\s*=") && !line.contains("(")) s.variables.add(line.split("[=;]")[0].replaceAll("(const|let|var)\\s+", "").trim());
    }

    private static void analyzeCppLine(String line, FileSummary s) {
        if (line.startsWith("#include") || line.startsWith("#import")) s.imports.add(line.trim());
        else if (line.startsWith("using ")) s.annotations.add(line.trim());
        else if (line.matches("(class|struct|enum)\\s+\\w+")) s.classes.add(extractClass(line));
        else if (line.contains("(") && line.contains(")") && !line.contains("=") && !line.contains(";") && line.length() < 120) s.functions.add(extractFunction(line));
    }

    private static void analyzeGoLine(String line, FileSummary s) {
        if (line.startsWith("import ")) s.imports.add(line.trim());
        else if (line.startsWith("func ")) s.functions.add(extractFunction(line));
        else if (line.startsWith("type ")) s.classes.add(extractClass(line));
        else if (line.startsWith("var ") || line.startsWith("const ")) s.variables.add(line.trim());
    }

    private static void analyzeRustLine(String line, FileSummary s) {
        if (line.startsWith("use ")) s.imports.add(line.trim());
        else if (line.startsWith("fn ")) s.functions.add(extractFunction(line));
        else if (line.startsWith("struct ") || line.startsWith("enum ") || line.startsWith("trait ") || line.startsWith("impl ")) s.classes.add(extractClass(line));
        else if (line.startsWith("#[") || line.startsWith("//!")) s.annotations.add(line.trim());
        else if (line.startsWith("let ") && !line.contains("(") && line.length() < 80) s.variables.add(line.trim());
    }

    private static void analyzeCSharpLine(String line, FileSummary s) {
        if (line.startsWith("using ")) s.imports.add(line.trim());
        else if (line.matches("(public|private|protected|internal|static|abstract|sealed)*\\s*class\\s+\\w+")) s.classes.add(extractClass(line));
        else if (line.contains("(") && line.contains(")") && !line.contains("=") && !line.contains(";") && line.length() < 120) s.functions.add(extractFunction(line));
        else if (line.startsWith("[")) s.annotations.add(line.trim());
    }

    private static void analyzeJsonContent(String content, FileSummary s) {
        try {
            Map<String, Object> obj = Json.object(content);
            for (String key : obj.keySet()) s.variables.add(key);
            s.variables.add(obj.size() + " 个顶层键");
        } catch (RuntimeException e) {
            s.variables.add("JSON 解析失败: " + e.getMessage());
        }
    }

    private static void analyzeXmlContent(String content, FileSummary s) {
        int count = 0;
        for (int i = 0; i < content.length(); i++) {
            int open = content.indexOf('<', i);
            if (open < 0) break;
            int close = content.indexOf('>', open);
            if (close < 0) break;
            String tag = content.substring(open + 1, close).split("\\s")[0];
            if (!tag.startsWith("/") && !tag.startsWith("?") && !tag.startsWith("!")) {
                count++;
                if (count <= 20) s.classes.add("<" + tag + ">");
            }
            i = close;
        }
        if (count > 20) s.classes.add("... 共 " + count + " 个标签");
    }

    private static String extractWord(String line) {
        return line.split("[^\\w.]")[0].trim();
    }

    private static String extractClass(String line) {
        return line.replaceAll("(public|private|protected|static|abstract|final|export|async|sealed|internal)\\s+", "").replaceAll("(class|interface|enum|struct|trait|impl|type)\\s+", "").split("[\\s{<(]")[0].trim();
    }

    private static String extractFunction(String line) {
        return line.replaceAll("(public|private|protected|static|abstract|final|export|async|def|fn|func|function)\\s+", "").split("\\(")[0].split("\\s")[0].trim();
    }

    public static String detectLanguage(String fileName) {
        String ext = fileName.contains(".") ? fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase(java.util.Locale.ROOT) : "";
        return switch (ext) {
            case "java", "class" -> "java";
            case "py", "pyw" -> "python";
            case "js", "mjs", "cjs" -> "javascript";
            case "ts", "tsx" -> "typescript";
            case "c", "h" -> "c";
            case "cpp", "cc", "cxx", "hpp", "hxx" -> "cpp";
            case "go" -> "go";
            case "rs" -> "rust";
            case "cs" -> "csharp";
            case "json" -> "json";
            case "xml", "html", "htm" -> "xml";
            case "yaml", "yml" -> "yaml";
            case "md", "markdown" -> "markdown";
            case "ps1", "psm1" -> "powershell";
            case "sh", "bash" -> "shell";
            case "sql" -> "sql";
            case "css", "scss", "less" -> "css";
            case "php" -> "php";
            case "rb" -> "ruby";
            case "swift" -> "swift";
            case "kt", "kts" -> "kotlin";
            case "scala" -> "scala";
            case "lua" -> "lua";
            default -> ext.isBlank() ? "unknown" : ext;
        };
    }
}
