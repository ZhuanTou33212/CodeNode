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

/**
 * 工程运行面板（Stage4.8 4.9 UI / Stage4.7 实时追踪入口）：
 * 选择/输入项目路径 → 识别工程 → 构建（Gradle/Maven/纯javac）→ 运行（入口类/JAR/Gradle任务/Maven目标）→
 * 输出流式回显 + 错误定位 + 可选 JFR 实时追踪摘要。后台线程执行，不阻塞 EDT。
 */
public final class ProjectRunPanel extends JPanel {
    private final JTextField projectPath = new JTextField("", 28);
    private final JLabel projectInfo = new JLabel("未识别工程");
    private final JComboBox<String> mainClass = new JComboBox<>();
    private final JComboBox<String> taskCombo = new JComboBox<>();
    private final JComboBox<String> runTaskCombo = new JComboBox<>();
    private final JCheckBox traceCheck = new JCheckBox("实时追踪 (JFR)");
    private final JTextArea log = new JTextArea(12, 60);
    private final JTextArea errors = new JTextArea(5, 60);
    private final JButton buildBtn = new JButton("构建");
    private final JButton runBtn = new JButton("▶ 运行");
    private final JButton stopBtn = new JButton("■ 停止");
    private final JButton refreshBtn = new JButton("识别工程");
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private Path currentRoot;
    private RunConfig lastConfig;
    private RunLauncher.RunningProcess currentHandle;

    public ProjectRunPanel() {
        super(new BorderLayout());
        setBackground(UiTheme.PANEL);
        add(buildControls(), BorderLayout.NORTH);
        add(outputArea(), BorderLayout.CENTER);
    }

    private JComponent buildControls() {
        JPanel top = new JPanel(new BorderLayout());
        top.setBackground(UiTheme.PANEL);
        top.setBorder(new EmptyBorder(6, 8, 4, 8));

        JPanel row1 = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 4));
        row1.setOpaque(false);
        row1.add(label("项目路径"));
        row1.add(projectPath);
        row1.add(refreshBtn);
        top.add(row1, BorderLayout.NORTH);

        JPanel row2 = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 4));
        row2.setOpaque(false);
        row2.add(label("入口类"));
        row2.add(mainClass);
        row2.add(label("构建任务"));
        row2.add(taskCombo);
        row2.add(label("运行任务"));
        row2.add(runTaskCombo);
        row2.add(traceCheck);
        row2.add(buildBtn);
        row2.add(runBtn);
        row2.add(stopBtn);
        top.add(row2, BorderLayout.SOUTH);

        JPanel middle = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 2));
        middle.setOpaque(false);
        projectInfo.setForeground(UiTheme.MUTED);
        middle.add(projectInfo);
        top.add(middle, BorderLayout.CENTER);

        mainClass.setPreferredSize(new Dimension(180, 26));
        taskCombo.setPreferredSize(new Dimension(140, 26));
        runTaskCombo.setPreferredSize(new Dimension(220, 26));
        projectPath.setPreferredSize(new Dimension(360, 26));

        refreshBtn.addActionListener(e -> discoverProject());
        buildBtn.addActionListener(e -> buildProject());
        runBtn.addActionListener(e -> runProject());
        stopBtn.addActionListener(e -> {
            RunLauncher.RunningProcess handle = currentHandle;
            if (handle != null) {
                RunLauncher.stop(handle);
            } else {
                RunLauncher.stop();
            }
        });
        return top;
    }

    private JComponent outputArea() {
        JPanel panel = new JPanel(new BorderLayout());
        panel.setBackground(UiTheme.PANEL);
        log.setEditable(false);
        log.setFont(new Font("Consolas", Font.PLAIN, 13));
        errors.setEditable(false);
        errors.setFont(new Font("Consolas", Font.PLAIN, 13));
        errors.setForeground(new Color(255, 120, 120));
        panel.add(new JScrollPane(log), BorderLayout.CENTER);
        panel.add(new JScrollPane(errors), BorderLayout.SOUTH);
        errors.setRows(4);
        return panel;
    }

    private static JLabel label(String text) {
        JLabel l = new JLabel(text);
        l.setForeground(UiTheme.TEXT);
        return l;
    }

    public void setProjectPath(String path) {
        if (path != null && !path.isBlank()) {
            projectPath.setText(path);
            discoverProject();
        }
    }

    public void setProjectPathSilent(String path) {
        if (path != null && !path.isBlank()) {
            projectPath.setText(path);
        }
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
                        errors.setText(sb.toString());
                    } else {
                        errors.setText(result.ok() ? "构建成功 (exit " + result.exitCode() + ")" : "构建失败 (exit " + result.exitCode() + ")");
                    }
                    appendLog("[构建完成] exit=" + result.exitCode());
                    buildBtn.setEnabled(true);
                });
            } catch (Exception e) {
                SwingUtilities.invokeLater(() -> {
                    errors.setText("构建异常: " + e.getMessage());
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
                            errors.setText(compiled.tail());
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
        log.append((log.getText().isEmpty() ? "" : "\n") + line);
        log.setCaretPosition(log.getDocument().getLength());
    }

    private void clearErrors() {
        errors.setText("");
    }
}
