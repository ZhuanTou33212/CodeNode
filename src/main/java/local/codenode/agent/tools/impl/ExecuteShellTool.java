package local.codenode.agent.tools.impl;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.project.ProcessRunner;

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
        // 分级确认：仅危险命令（删除/强改/清理/提交推送等）或白名单外需要用户确认；
        // 普通构建/运行/查询命令直接放行。
        boolean sensitive = isSensitiveCommand(tokens);
        if (sensitive) {
            String what = "在项目目录执行命令：" + command;
            String detail = "这是一条" + (isDestructiveCommand(tokens) ? "具有破坏性" : "可能影响系统/仓库状态") +
                    "的命令，执行后可能不可撤销。超时 " + timeoutSeconds + " 秒。";
            if (!context.confirm(local.codenode.agent.tools.AgentToolContext.ConfirmationLevel.HIGH, what, detail)) {
                return AgentToolResult.error("已取消执行");
            }
        } else {
            context.confirm(local.codenode.agent.tools.AgentToolContext.ConfirmationLevel.LOW,
                    "执行命令：" + command, "普通构建/查询命令，直接执行。");
        }
        ProcessBuilder builder = new ProcessBuilder(tokens);
        builder.directory(context.projectRoot().toFile());
        builder.redirectErrorStream(true);
        Process process = null;
        try {
            process = builder.start();
            final Process runningProcess = process;
            StringBuilder output = new StringBuilder();
            Thread reader = new Thread(() -> {
                try (var in = runningProcess.getInputStream()) {
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
                ProcessRunner.terminateTree(process);
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
        } catch (InterruptedException e) {
            ProcessRunner.terminateTree(process);
            Thread.currentThread().interrupt();
            return AgentToolResult.error("执行已取消");
        } catch (Exception e) {
            ProcessRunner.terminateTree(process);
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

    /** 是否危险/敏感命令：删除、清理、强制、push/publish、reset/checkout 危险参数等。 */
    private static boolean isSensitiveCommand(List<String> tokens) {
        if (tokens.isEmpty()) return false;
        String base = tokens.get(0).toLowerCase();
        for (String flag : tokens) {
            String f = flag.toLowerCase();
            if (f.equals("rm") || f.equals("del") || f.equals("rmdir") || f.equals("rd")
                    || f.equals("rm -rf") || f.equals("clean") || f.equals("distclean")
                    || f.equals("reset") || f.equals("hard") || f.equals("push") || f.equals("publish")
                    || f.equals("-f") || f.equals("--force") || f.equals("--hard")) {
                return true;
            }
        }
        if (base.contains("git")) {
            for (String flag : tokens) {
                String f = flag.toLowerCase();
                if (f.equals("reset") || f.equals("clean") || f.equals("push") || f.equals("rebase")
                        || f.equals("checkout") || f.equals("--hard") || f.equals("-f")) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 是否破坏性命令（删除/清理/覆盖历史）。 */
    private static boolean isDestructiveCommand(List<String> tokens) {
        if (tokens.isEmpty()) return false;
        for (String flag : tokens) {
            String f = flag.toLowerCase();
            if (f.equals("rm") || f.equals("del") || f.equals("rmdir") || f.equals("clean")
                    || f.equals("reset") || f.equals("--hard") || f.equals("push")) {
                return true;
            }
        }
        return false;
    }
}
