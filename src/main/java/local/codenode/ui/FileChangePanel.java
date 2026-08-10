package local.codenode.ui;

import local.codenode.UiTheme;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 文件变更预览面板（对标 Opencode 的变更显示）：显示 Agent 通过 write_file/edit_file
 * 产生的文件增删改（diff），以及 git 工程的文件变更状态（git status / git diff --stat）。
 * 替换原"错误列表"栏位；错误与运行报告合并进输出面板。
 */
public final class FileChangePanel extends JPanel {
    private final JTextArea diff = new JTextArea(10, 60);
    private final JLabel summary = new JLabel("暂无文件变更");
    private final java.util.function.Supplier<Path> projectRootSupplier;
    private final List<Map<String, Object>> changes = new ArrayList<>();

    public FileChangePanel(java.util.function.Supplier<Path> projectRootSupplier) {
        super(new BorderLayout());
        this.projectRootSupplier = projectRootSupplier;
        setBackground(UiTheme.PANEL);

        JPanel top = new JPanel(new BorderLayout());
        top.setBackground(UiTheme.PANEL);
        top.setBorder(new EmptyBorder(4, 8, 4, 8));
        summary.setForeground(UiTheme.MUTED);
        top.add(summary, BorderLayout.WEST);
        JPanel actions = new JPanel(new FlowLayout(FlowLayout.RIGHT, 6, 0));
        actions.setOpaque(false);
        actions.add(button("刷新", this::refresh));
        actions.add(button("清空", () -> {
            changes.clear();
            diff.setText("");
            summary.setText("暂无文件变更");
        }));
        top.add(actions, BorderLayout.EAST);
        add(top, BorderLayout.NORTH);

        diff.setEditable(false);
        diff.setFont(new Font("Consolas", Font.PLAIN, 12));
        diff.setLineWrap(false);
        diff.setBackground(UiTheme.BACKGROUND);
        add(new JScrollPane(diff), BorderLayout.CENTER);
    }

    private static JButton button(String text, Runnable action) {
        JButton b = new JButton(text);
        b.setFocusPainted(false);
        b.addActionListener(e -> action.run());
        return b;
    }

    /** Agent 写入/修改文件后调用：记录变更并刷新 diff。 */
    public void recordChange(String relative, String kind, String detail) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("path", relative);
        entry.put("kind", kind); // create / modify / delete
        entry.put("detail", detail);
        changes.add(entry);
        refresh();
    }

    /** 重新渲染 diff 与 git 状态。 */
    public void refresh() {
        StringBuilder sb = new StringBuilder();
        Path root = projectRootSupplier == null ? null : projectRootSupplier.get();
        if (root != null) {
            appendGitStatus(sb, root);
        }
        if (!changes.isEmpty()) {
            if (sb.length() > 0) sb.append("\n\n");
            sb.append("## Agent 本次文件变更\n");
            for (Map<String, Object> c : changes) {
                sb.append("- [").append(c.get("kind")).append("] ").append(c.get("path"))
                        .append(c.get("detail") == null || String.valueOf(c.get("detail")).isBlank() ? "" : " — " + c.get("detail"))
                        .append('\n');
            }
        }
        diff.setText(sb.toString());
        if (sb.length() == 0) {
            summary.setText("暂无文件变更");
        } else {
            summary.setText("文件变更 " + changes.size() + " 项" + (isGitRepo(root) ? "  |  Git 状态已读取" : ""));
        }
        diff.setCaretPosition(0);
    }

    private void appendGitStatus(StringBuilder sb, Path root) {
        if (!isGitRepo(root)) return;
        sb.append("## Git 工作区状态\n");
        try {
            ProcessResult r = run(root, "git", "status", "--short");
            sb.append(r.output == null || r.output.isBlank() ? "  （工作区干净）\n" : r.output + "\n");
            ProcessResult stat = run(root, "git", "diff", "--stat");
            if (stat.output != null && !stat.output.isBlank()) {
                sb.append("\n## Git 变更统计\n").append(stat.output).append('\n');
            }
        } catch (Exception e) {
            sb.append("  （读取 git 状态失败：" + e.getMessage() + "）\n");
        }
    }

    private static boolean isGitRepo(Path root) {
        return root != null && Files.isDirectory(root.resolve(".git"));
    }

    private static ProcessResult run(Path dir, String... command) {
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(dir.toFile());
            builder.redirectErrorStream(true);
            Process p = builder.start();
            StringBuilder out = new StringBuilder();
            try (var in = p.getInputStream()) {
                byte[] buf = new byte[4096];
                int read;
                while ((read = in.read(buf)) >= 0) {
                    out.append(new String(buf, 0, read, StandardCharsets.UTF_8));
                }
            }
            p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
            return new ProcessResult(p.exitValue(), out.toString());
        } catch (IOException e) {
            return new ProcessResult(-1, "");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new ProcessResult(-1, "");
        }
    }

    private record ProcessResult(int exitCode, String output) {}
}
