package local.codenode.ui;

import local.codenode.UiTheme;
import local.codenode.project.BuildRunner;
import local.codenode.project.JavaProject;
import local.codenode.project.RunConfig;
import local.codenode.project.RunLauncher;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * 工程运行面板（Stage4.8 4.9 UI / Stage4.7 实时追踪入口）：
 * 选择/输入项目路径 → 识别工程 → 构建（Gradle/Maven/纯javac）→ 运行（入口类/JAR/Gradle任务/Maven目标）→
 * 输出流式回显 + 错误定位 + 可选 JFR 实时追踪摘要。后台线程执行，不阻塞 EDT。
 */
public final class ProjectRunPanel extends JPanel implements Scrollable {
    private final JTextField projectPath = new JTextField("", 28);
    private final JLabel projectInfo = new JLabel("未识别工程");
    private final JComboBox<String> mainClass = new JComboBox<>();
    private final JComboBox<String> taskCombo = new JComboBox<>();
    private final JComboBox<String> runTaskCombo = new JComboBox<>();
    private final JCheckBox traceCheck = new JCheckBox("实时追踪 (JFR)");
    private final Consumer<String> outputSink;
    private final JButton buildBtn = new JButton("构建");
    private final JButton runBtn = new JButton("▶ 运行");
    private final JButton stopBtn = new JButton("■ 停止");
    private final JButton refreshBtn = new JButton("识别工程");
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private Path currentRoot;
    private RunConfig lastConfig;
    private RunLauncher.RunningProcess currentHandle;

    public ProjectRunPanel() {
        this(message -> {});
    }

    public ProjectRunPanel(Consumer<String> outputSink) {
        super(new BorderLayout());
        this.outputSink = outputSink == null ? message -> {} : outputSink;
        setMinimumSize(new Dimension(0, 0));
        setBackground(UiTheme.PANEL);
        add(buildControls(), BorderLayout.NORTH);
    }

    private JComponent buildControls() {
        JPanel top = new JPanel();
        top.setLayout(new BoxLayout(top, BoxLayout.Y_AXIS));
        top.setBackground(UiTheme.PANEL);
        top.setBorder(new EmptyBorder(12, 12, 12, 12));

        JPanel pathControl = new JPanel(new BorderLayout(6, 0));
        pathControl.setOpaque(false);
        pathControl.add(projectPath, BorderLayout.CENTER);
        pathControl.add(refreshBtn, BorderLayout.EAST);
        top.add(formRow("项目路径", pathControl));
        top.add(Box.createVerticalStrut(8));

        projectInfo.setForeground(UiTheme.MUTED);
        projectInfo.setFont(projectInfo.getFont().deriveFont(12f));
        projectInfo.setAlignmentX(Component.LEFT_ALIGNMENT);
        projectInfo.setMinimumSize(new Dimension(0, 24));
        projectInfo.setMaximumSize(new Dimension(Integer.MAX_VALUE, 42));
        top.add(projectInfo);
        top.add(Box.createVerticalStrut(8));

        top.add(formRow("入口类", mainClass));
        top.add(Box.createVerticalStrut(8));
        top.add(formRow("构建任务", taskCombo));
        top.add(Box.createVerticalStrut(8));
        top.add(formRow("运行任务", runTaskCombo));
        top.add(Box.createVerticalStrut(10));

        traceCheck.setAlignmentX(Component.LEFT_ALIGNMENT);
        top.add(traceCheck);
        top.add(Box.createVerticalStrut(8));
        JPanel buttons = new JPanel(new GridLayout(1, 3, 6, 0));
        buttons.setOpaque(false);
        buttons.setAlignmentX(Component.LEFT_ALIGNMENT);
        buttons.setMaximumSize(new Dimension(Integer.MAX_VALUE, 34));
        buttons.add(buildBtn);
        buttons.add(runBtn);
        buttons.add(stopBtn);
        top.add(buttons);
        top.add(Box.createVerticalGlue());

        refreshBtn.addActionListener(e -> discoverProject());
        buildBtn.addActionListener(e -> buildProject());
        runBtn.addActionListener(e -> runProject());
        stopBtn.setEnabled(false);
        stopBtn.addActionListener(e -> {
            RunLauncher.RunningProcess handle = currentHandle;
            if (handle != null) RunLauncher.stop(handle);
            else RunLauncher.stop();
        });
        return top;
    }

    private static JPanel formRow(String title, JComponent field) {
        JPanel row = new JPanel();
        row.setLayout(new BoxLayout(row, BoxLayout.Y_AXIS));
        row.setOpaque(false);
        row.setAlignmentX(Component.LEFT_ALIGNMENT);
        row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 58));
        JLabel caption = label(title);
        caption.setAlignmentX(Component.LEFT_ALIGNMENT);
        field.setAlignmentX(Component.LEFT_ALIGNMENT);
        field.setMinimumSize(new Dimension(0, 30));
        field.setMaximumSize(new Dimension(Integer.MAX_VALUE, 32));
        row.add(caption);
        row.add(Box.createVerticalStrut(3));
        row.add(field);
        return row;
    }

    private static JLabel label(String text) {
        JLabel l = new JLabel(text);
        l.setForeground(UiTheme.TEXT);
        return l;
    }

    public void setProjectPath(String path) {
        String normalized = path == null ? "" : path.trim();
        projectPath.setText(normalized);
        if (normalized.isBlank()) {
            projectInfo.setText("未选择项目路径");
            return;
        }
        discoverProject();
    }

    public void setProjectPathSilent(String path) {
        projectPath.setText(path == null ? "" : path.trim());
        if (projectPath.getText().isBlank()) projectInfo.setText("未选择项目路径");
    }

    private void discoverProject() {
        String text = projectPath.getText() == null ? "" : projectPath.getText().trim();
        if (text.isBlank()) {
            projectInfo.setText("未选择项目路径");
            return;
        }
        Path root = Path.of(text).toAbsolutePath().normalize();
        if (!Files.isDirectory(root)) {
            projectInfo.setText("目录不存在: " + root);
            return;
        }
        this.currentRoot = root;
        executor.submit(() -> {
            Map<String, Object> info = JavaProject.describe(root);
            @SuppressWarnings("unchecked")
            List<String> mains = (List<String>) info.getOrDefault("mainClasses", List.of());
            @SuppressWarnings("unchecked")
            List<String> modules = (List<String>) info.getOrDefault("modules", List.of());
            String system = String.valueOf(info.get("buildSystem"));
            SwingUtilities.invokeLater(() -> {
                mainClass.removeAllItems();
                if (mains.isEmpty()) mainClass.addItem("（未发现 main）");
                else for (String m : mains) mainClass.addItem(m);
                taskCombo.removeAllItems();
                runTaskCombo.removeAllItems();
                String buildSystem = String.valueOf(system);
                if ("GRADLE".equals(buildSystem)) {
                    for (String t : new String[]{"compileJava", "build", "run"}) taskCombo.addItem(t);
                    // 收集可运行的 Gradle 任务（runClient/runServer/模块前缀）
                    List<String> runTasks = BuildRunner.listRunTasks(root);
                    if (runTasks.isEmpty()) {
                        runTaskCombo.addItem("runClient");
                    } else {
                        for (String t : runTasks) runTaskCombo.addItem(t);
                        // 默认选中主工程 runClient（teaart 主类），用户可在下拉切换任意模块
                        runTaskCombo.setSelectedItem("runClient");
                    }
                } else if ("MAVEN".equals(buildSystem)) {
                    for (String t : BuildRunner.listMavenGoals()) taskCombo.addItem(t);
                    runTaskCombo.addItem("exec:java");
                } else if ("PLAIN".equals(buildSystem)) {
                    taskCombo.addItem("compile");
                    runTaskCombo.addItem("run");
                } else {
                    taskCombo.addItem("无");
                    runTaskCombo.addItem("无");
                }
                StringBuilder sb = new StringBuilder();
                sb.append("构建系统: ").append(system);
                if (!modules.isEmpty()) sb.append("  |  模块: ").append(modules);
                sb.append("  |  源集: ").append(JavaProject.sourceRoots(root).size());
                if (!mains.isEmpty()) sb.append("  |  入口: ").append(mains.size());
                projectInfo.setText(sb.toString());
                projectInfo.setToolTipText(sb.toString());
            });
        });
    }

    private void buildProject() {
        if (currentRoot == null) { discoverProject(); return; }
        appendLog("[构建] " + currentRoot);
        clearErrors();
        buildBtn.setEnabled(false);
        executor.submit(() -> {
            try {
                List<String> tasks = new ArrayList<>();
                if (!String.valueOf(taskCombo.getSelectedItem()).isBlank()
                        && !"无".equals(String.valueOf(taskCombo.getSelectedItem()))
                        && !"compile".equals(String.valueOf(taskCombo.getSelectedItem()))) {
                    tasks.add(String.valueOf(taskCombo.getSelectedItem()));
                }
                BuildRunner.BuildResult result = BuildRunner.build(currentRoot, tasks, 300, line -> SwingUtilities.invokeLater(() -> appendLog(line)));
                SwingUtilities.invokeLater(() -> {
                    if (!result.errors().isEmpty()) {
                        StringBuilder sb = new StringBuilder("编译错误 " + result.errors().size() + " 条:\n");
                        for (Map<String, Object> err : result.errors()) {
                            sb.append("  ").append(err.get("file")).append(':').append(err.get("line"))
                              .append(err.get("column") == null || ((Number) err.get("column")).intValue() == 0 ? "" : ":" + err.get("column"))
                              .append("  ").append(err.get("message")).append('\n');
                        }
                        appendLog("[编译错误] " + sb);
                    } else {
                        appendLog(result.ok() ? "构建成功 (exit " + result.exitCode() + ")" : "构建失败 (exit " + result.exitCode() + ")");
                    }
                    appendLog("[构建完成] exit=" + result.exitCode());
                    buildBtn.setEnabled(true);
                });
            } catch (Exception e) {
                SwingUtilities.invokeLater(() -> {
                    appendLog("[构建异常] " + e.getMessage());
                    buildBtn.setEnabled(true);
                });
            }
        });
    }

    private void runProject() {
        if (currentRoot == null) { discoverProject(); return; }
        String main = String.valueOf(mainClass.getSelectedItem());
        boolean trace = traceCheck.isSelected();
        String buildSystem = String.valueOf(JavaProject.discover(currentRoot));
        if ("GRADLE".equals(buildSystem)) {
            // 用「运行任务」下拉选择启动哪个模块/任务（如 :tea_art_addition:runClient、runClient）
            main = String.valueOf(runTaskCombo.getSelectedItem());
            lastConfig = new RunConfig(main, RunConfig.Kind.GRADLE_TASK, main, null, null, List.of(), List.of(), currentRoot, List.of(), trace);
        } else if ("MAVEN".equals(buildSystem)) {
            main = String.valueOf(runTaskCombo.getSelectedItem());
            lastConfig = new RunConfig(main, RunConfig.Kind.MAVEN_GOAL, main, null, null, List.of(), List.of(), currentRoot, List.of(), trace);
        } else {
            if (main.isBlank() || main.startsWith("（")) {
                appendLog("[运行] 未指定有效入口类");
                return;
            }
            lastConfig = new RunConfig(main, RunConfig.Kind.MAIN_CLASS, main, null, null, List.of(), List.of(), currentRoot, List.of("compile"), trace);
        }
        appendLog("[运行] " + main + "  工作目录=" + currentRoot);
        runBtn.setEnabled(false);
        stopBtn.setEnabled(true);
        // 统一用非阻塞后台运行（IntelliJ 风格）：进程持续运行、输出实时回显，手动「停止」才终止。
        // 纯 Java main 也可能是长驻程序（如服务器），不能阻塞等待或超时强杀。
        boolean needCompile = lastConfig.kind() == RunConfig.Kind.MAIN_CLASS && !Files.isRegularFile(currentRoot.resolve("out").resolve(main.replace('.', '/') + ".class"));
        executor.submit(() -> {
            try {
                if (needCompile) {
                    appendLog("[运行] 未发现编译产物，先编译…");
                    BuildRunner.BuildResult compiled = BuildRunner.build(currentRoot, List.of(), 300, line -> SwingUtilities.invokeLater(() -> appendLog(line)));
                    if (!compiled.ok()) {
                        SwingUtilities.invokeLater(() -> {
                            appendLog("[编译错误] " + compiled.tail());
                            appendLog("[运行] 编译失败，未启动");
                            runBtn.setEnabled(true);
                            stopBtn.setEnabled(false);
                        });
                        return;
                    }
                }
                RunLauncher.RunningProcess handle = RunLauncher.launch(lastConfig, line -> SwingUtilities.invokeLater(() -> appendLog(line)));
                if (handle == null) {
                    SwingUtilities.invokeLater(() -> {
                        appendLog("[运行] 启动失败");
                        runBtn.setEnabled(true);
                        stopBtn.setEnabled(false);
                    });
                    return;
                }
                currentHandle = handle;
                // 等待进程结束（用户停止或自行退出）
                synchronized (handle) {
                    while (!handle.finished() && handle.isAlive()) {
                        try { handle.wait(200); } catch (InterruptedException ignored) { break; }
                    }
                }
                currentHandle = null;
                SwingUtilities.invokeLater(() -> {
                    appendLog("[运行结束] exit=" + handle.exitCode());
                    if (lastConfig.trace() && !lastConfig.vmArgs().isEmpty()) {
                        // JFR 追踪已在进程内 dump，这里不再阻塞收集
                    }
                    runBtn.setEnabled(true);
                    stopBtn.setEnabled(false);
                });
            } catch (Exception e) {
                SwingUtilities.invokeLater(() -> {
                    appendLog("[运行异常] " + e.getMessage());
                    runBtn.setEnabled(true);
                    stopBtn.setEnabled(false);
                });
            }
        });
    }

    private static String summarizeTrace(Map<String, Object> trace) {
        StringBuilder sb = new StringBuilder();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> methods = (List<Map<String, Object>>) trace.get("methods");
        if (methods != null && !methods.isEmpty()) {
            sb.append("方法采样 Top ").append(Math.min(methods.size(), 10)).append(":");
            int i = 0;
            for (Map<String, Object> m : methods) {
                if (i++ >= 10) break;
                sb.append("\n  ").append(m.get("name")).append("  x").append(m.get("samples"));
            }
        }
        if (trace.get("jfrFile") != null) sb.append("\nJFR: ").append(trace.get("jfrFile"));
        if (trace.get("trace") != null) sb.append("\n").append(trace.get("trace"));
        if (trace.get("traceError") != null) sb.append("\n").append(trace.get("traceError"));
        return sb.length() == 0 ? "无追踪数据" : sb.toString();
    }

    private void appendLog(String line) {
        if (line == null || line.isBlank()) return;
        this.outputSink.accept(line);
    }

    private void clearErrors() {
        // Floating output has no persistent error surface to clear.
    }

    @Override public Dimension getPreferredScrollableViewportSize() { return getPreferredSize(); }
    @Override public int getScrollableUnitIncrement(Rectangle visibleRect, int orientation, int direction) { return 24; }
    @Override public int getScrollableBlockIncrement(Rectangle visibleRect, int orientation, int direction) { return Math.max(48, visibleRect.height - 32); }
    @Override public boolean getScrollableTracksViewportWidth() { return true; }
    @Override public boolean getScrollableTracksViewportHeight() { return false; }
}
