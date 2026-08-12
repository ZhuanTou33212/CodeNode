package local.codenode.ui.agent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Read-only Git context plus explicit branch creation for the Codex workspace bar. */
public final class GitWorkspaceService {
    public record Snapshot(String branch, int changedFiles, boolean repository) {}

    public Snapshot snapshot(Path root) {
        if (root == null || !Files.isDirectory(root)) return new Snapshot("", 0, false);
        String branch = run(root, List.of("branch", "--show-current"));
        if (branch.isBlank()) branch = run(root, List.of("rev-parse", "--abbrev-ref", "HEAD"));
        String status = run(root, List.of("status", "--porcelain"));
        boolean repo = !branch.isBlank() || Files.isDirectory(root.resolve(".git"));
        int changed = status.isBlank() ? 0 : status.split("\\R").length;
        return new Snapshot(branch.isBlank() ? "未初始化" : branch, changed, repo);
    }

    public List<String> branches(Path root) {
        String output = run(root, List.of("branch", "--format=%(refname:short)"));
        List<String> result = new ArrayList<>();
        for (String line : output.split("\\R")) if (!line.isBlank()) result.add(line.trim());
        return result;
    }

    public boolean createBranch(Path root, String name) {
        if (root == null || name == null || name.isBlank()) return false;
        return run(root, List.of("switch", "-c", name.trim())).contains(name.trim());
    }

    public boolean checkout(Path root, String branch) {
        if (root == null || branch == null || branch.isBlank()) return false;
        return run(root, List.of("switch", branch.trim())).contains(branch.trim());
    }

    private String run(Path root, List<String> args) {
        try {
            List<String> command = new ArrayList<>();
            command.add("git"); command.add("-C"); command.add(root.toAbsolutePath().normalize().toString()); command.addAll(args);
            Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
            if (!process.waitFor(5, TimeUnit.SECONDS)) { process.destroyForcibly(); return ""; }
            return new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        } catch (IOException | InterruptedException error) {
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            return "";
        }
    }
}
