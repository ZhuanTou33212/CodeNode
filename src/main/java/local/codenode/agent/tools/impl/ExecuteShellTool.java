package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * execute_shell：ProcessBuilder 执行命令。命令白名单（mvn/mvnw/git/java/javac 等），
 * 超时 destroyForcibly，执行前必须用户确认并写审计日志。
 */
public final class ExecuteShellTool {

    private static final Set<String> ALLOWED = Set.of(
        "mvn", "mvnw", "mvnw.cmd", "git", "java", "javac", "gradle", "gradlew", "gradlew.bat",
        "go", "python", "python3", "node", "npm", "nuget"
    );

    private ExecuteShellTool() {}

    public static void register(AgentToolRegistry registry) {
        registry.register(
            "execute_shell",
            "在项目根目录执行白名单命令（mvn/mvnw/git/java/javac/go/python 等构建工具）。"
                + "运行环境是 Windows，不要使用 ls/find/cat/~/head 等 Unix 命令（它们不可用）；"
                + "探索项目用 scan_project / read_file。每次执行前请求用户确认；超时自动强杀。",
            Map.of("type", "object",
                "properties", Map.of(
                    "command", Map.of("type", "string", "description", "要执行的命令行"),
                    "timeoutSeconds", Map.of("type", "integer", "description", "超时秒数，默认 30")),
                "required", List.of("command")),
            ExecuteShellTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String command = String.valueOf(arguments.getOrDefault("command", "")).trim();
        if (command.isBlank()) return AgentToolResult.error("缺少 command");
        List<String> tokens = splitCommand(command);
        if (tokens.isEmpty()) return AgentToolResult.error("空命令");
        String base = tokens.get(0);
        String normalized = base.replace('\\', '/');
        int slash = normalized.lastIndexOf('/');
        if (slash >= 0) normalized = normalized.substring(slash + 1);
        if (!ALLOWED.contains(normalized)) return AgentToolResult.error("命令不在白名单：" + base);
        long timeoutSeconds = arguments.get("timeoutSeconds") instanceof Number n ? Math.max(1, n.longValue()) : 30;
        if (!context.confirm("确认执行命令：" + command + " ？（超时 " + timeoutSeconds + " 秒）")) {
            return AgentToolResult.error("已取消执行");
        }
        ProcessBuilder builder = new ProcessBuilder(tokens);
        builder.directory(context.projectRoot().toFile());
        builder.redirectErrorStream(true);
        try {
            Process process = builder.start();
            StringBuilder output = new StringBuilder();
            Thread reader = new Thread(() -> {
                try (var in = process.getInputStream()) {
                    byte[] buffer = new byte[4096];
                    int read;
                    while ((read = in.read(buffer)) >= 0) {
                        output.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
                    }
                } catch (IOException ignored) {}
            });
            reader.setDaemon(true);
            reader.start();
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            int exitCode;
            if (!finished) {
                process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
                exitCode = -1;
                output.append("\n…（执行超时，已强制终止）");
            } else {
                exitCode = process.exitValue();
            }
            reader.join(500);
            context.audit("execute_shell " + command + " exit=" + exitCode);
            String text = "退出码 " + exitCode + "\n" + output.toString().trim();
            return new AgentToolResult(true, text, Map.of("exitCode", exitCode, "command", command));
        } catch (Exception e) {
            return AgentToolResult.error("执行失败：" + e.getMessage());
        }
    }

    private static List<String> splitCommand(String command) {
        List<String> tokens = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean quoted = false;
        for (int i = 0; i < command.length(); i++) {
            char c = command.charAt(i);
            if (c == '"') { quoted = !quoted; continue; }
            if (Character.isWhitespace(c) && !quoted) {
                if (current.length() > 0) { tokens.add(current.toString()); current.setLength(0); }
                continue;
            }
            current.append(c);
        }
        if (current.length() > 0) tokens.add(current.toString());
        return tokens;
    }
}
