package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * code_review：本地规则引擎静态扫描（硬编码密码、空指针风险、过长方法、TODO 遗留等），确定性输出。
 * 支持 code 参数或 path 参数读取文件。
 */
public final class CodeReviewTool {

    private static final Pattern PASSWORD_PATTERN = Pattern.compile(
        "(?i)(password|passwd|pwd|secret|api_key|apikey|token)\\s*[:=]\\s*['\"][^'\"]{4,}['\"]");
    private static final Pattern TODO_PATTERN = Pattern.compile("(?i)(TODO|FIXME|XXX|HACK)\\b");
    private static final Pattern NULL_CHECK_PATTERN = Pattern.compile("\\.equals\\s*\\(\\s*null\\s*\\)");

    private CodeReviewTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "code_review",
            "本地规则引擎静态代码审查：硬编码密码、空指针风险、过长方法、TODO 遗留。code 与 path 二选一。",
            Map.of("type", "object",
                "properties", Map.of(
                    "code", Map.of("type", "string", "description", "要审查的代码文本"),
                    "path", Map.of("type", "string", "description", "项目内相对路径，与 code 二选一"),
                    "maxMethodLines", Map.of("type", "integer", "description", "过长方法阈值，默认 200"))),
            CodeReviewTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String code = null;
        String relative = null;
        Object codeObj = arguments.get("code");
        if (codeObj != null && !String.valueOf(codeObj).isBlank()) {
            code = String.valueOf(codeObj);
        } else {
            Object pathObj = arguments.get("path");
            if (pathObj == null || String.valueOf(pathObj).isBlank()) {
                return AgentToolResult.error("需要提供 code 或 path");
            }
            relative = String.valueOf(pathObj);
            Path root = context.projectRoot().toAbsolutePath().normalize();
            Path file = root.resolve(relative).normalize();
            if (!file.startsWith(root)) return AgentToolResult.error("路径越过项目边界");
            if (!Files.isRegularFile(file)) return AgentToolResult.error("文件不存在：" + relative);
            try {
                code = Files.readString(file, StandardCharsets.UTF_8);
            } catch (Exception e) {
                return AgentToolResult.error("读取失败：" + e.getMessage());
            }
        }
        int maxMethodLines = arguments.get("maxMethodLines") instanceof Number n ? Math.max(1, n.intValue()) : 200;
        List<Map<String, Object>> findings = new ArrayList<>();

        Matcher pwd = PASSWORD_PATTERN.matcher(code);
        while (pwd.find()) {
            addFinding(findings, "security", "疑似硬编码密码/密钥", lineOf(code, pwd.start()));
        }
        Matcher todo = TODO_PATTERN.matcher(code);
        while (todo.find()) {
            addFinding(findings, "todo", "遗留 TODO/FIXME", lineOf(code, todo.start()));
        }
        Matcher npe = NULL_CHECK_PATTERN.matcher(code);
        while (npe.find()) {
            addFinding(findings, "null-safety", "对 null 调用 equals（空指针风险）", lineOf(code, npe.start()));
        }
        findLongMethods(code, maxMethodLines, findings);
        findNullDereferenceHeuristic(code, findings);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("findings", findings);
        data.put("total", findings.size());
        data.put("source", relative == null ? "inline" : relative);
        if (findings.isEmpty()) {
            return AgentToolResult.ok("未发现明显问题", data);
        }
        StringBuilder text = new StringBuilder("发现 " + findings.size() + " 个问题：\n");
        for (Map<String, Object> finding : findings) {
            text.append("• [").append(finding.get("severity")).append("] ")
                .append(finding.get("message")).append("（行 ").append(finding.get("line")).append("）\n");
        }
        return AgentToolResult.ok(text.toString(), data);
    }

    private static void findLongMethods(String code, int maxLines, List<Map<String, Object>> findings) {
        String[] lines = code.split("\n", -1);
        int start = -1, depth = 0;
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            if (isMethodSignature(line)) { start = i; depth = braceDepth(lines[i]); continue; }
            if (start >= 0) {
                depth += braceDelta(line);
                if (depth <= 0 && braceDepth(lines[i]) <= 0) {
                    int length = i - start + 1;
                    if (length > maxLines) {
                        addFinding(findings, "complexity", "方法过长（" + length + " 行，阈值 " + maxLines + "）", start + 1);
                    }
                    start = -1;
                }
            }
        }
    }

    private static boolean isMethodSignature(String line) {
        String trimmed = line.trim();
        if (trimmed.isEmpty() || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false;
        return (trimmed.contains("(") && trimmed.contains(")") && trimmed.contains("{"))
            && (trimmed.contains("public") || trimmed.contains("private") || trimmed.contains("protected")
                || trimmed.contains("static") || trimmed.contains("def ") || trimmed.contains("func ")
                || trimmed.contains("fun "));
    }

    private static int braceDelta(String line) {
        int delta = 0;
        for (char c : line.toCharArray()) {
            if (c == '{') delta++;
            else if (c == '}') delta--;
        }
        return delta;
    }

    private static int braceDepth(String line) {
        int depth = 0;
        for (char c : line.toCharArray()) {
            if (c == '{') depth++;
            else if (c == '}') depth--;
        }
        return depth;
    }

    /** 启发式：对可能为 null 的链式调用（对象.方法().方法()）——保守，仅提示。 */
    private static void findNullDereferenceHeuristic(String code, List<Map<String, Object>> findings) {
        Pattern chain = Pattern.compile("\\b([a-zA-Z_][\\w]*)\\.([a-zA-Z_][\\w]*)\\.([a-zA-Z_][\\w]*)\\(");
        Matcher matcher = chain.matcher(code);
        while (matcher.find()) {
            String receiver = matcher.group(1);
            if (isLikelyParameter(code, receiver)) {
                addFinding(findings, "null-safety", "可能的空指针风险：对参数 " + receiver + " 的多级调用", lineOf(code, matcher.start()));
            }
        }
    }

    private static boolean isLikelyParameter(String code, String name) {
        for (String line : code.split("\n")) {
            String trimmed = line.trim();
            if (trimmed.contains("(" + name + ",") || trimmed.contains("," + name + ")")
                || trimmed.contains("String " + name) || trimmed.contains("Object " + name)
                || trimmed.contains("def " + name) || trimmed.contains("(" + name + ":")) {
                return true;
            }
        }
        return false;
    }

    private static void addFinding(List<Map<String, Object>> findings, String severity, String message, int line) {
        Map<String, Object> finding = new LinkedHashMap<>();
        finding.put("severity", severity);
        finding.put("message", message);
        finding.put("line", line);
        findings.add(finding);
    }

    private static int lineOf(String code, int offset) {
        int line = 1;
        for (int i = 0; i < Math.min(offset, code.length()); i++) {
            if (code.charAt(i) == '\n') line++;
        }
        return line;
    }
}
