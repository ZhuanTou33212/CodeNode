package local.codenode.ui.agent;

import local.codenode.UiTheme;
import local.codenode.agent.AgentChatController;
import local.codenode.agent.AgentToolCall;
import local.codenode.agent.AgentContext;
import local.codenode.agent.ChatEvent;
import local.codenode.agent.ChatListener;
import local.codenode.config.AgentConfig;

import javax.swing.*;
import javax.swing.text.BadLocationException;
import javax.swing.text.Style;
import javax.swing.text.StyleConstants;
import javax.swing.text.StyledDocument;
import java.awt.*;
import java.awt.event.ActionEvent;
import java.awt.event.HierarchyEvent;
import java.util.List;

/** 内嵌 Agent 对话面板（opencode 风格：❯ 输入提示、Enter 发送、紧凑顶部栏、彩色消息、推理折叠区）。 */
public final class AgentChatPanel extends JPanel {
    private static final Color USER = UiTheme.ACCENT;
    private static final Color TEXT = UiTheme.TEXT;
    private static final Color TOOL = new Color(130, 108, 67);
    private static final Color ERROR = new Color(166, 55, 47);
    private static final Color DIM = UiTheme.MUTED;

    private final AgentChatController controller;
    private final AgentConfig config;
    private final Runnable openSettings;
    private final java.util.function.Consumer<String> activitySink;

    private final JTextPane transcript = new JTextPane();
    private final StyledDocument document;
    private final JTextArea input = new JTextArea(2, 20);
    private final JButton send = new JButton("发送");
    private final JButton stop = new JButton("停止");
    private final JButton cancelTool = new JButton("取消当前工具");
    private final JCheckBox rememberApprovals = new JCheckBox("本次会话记住批准", true);
    private final JComboBox<String> model = new JComboBox<>();
    private final JLabel status = new JLabel("空闲");
    private final JLabel context = new JLabel(" ");
    private final CollapsibleReasoningPanel reasoning = new CollapsibleReasoningPanel();
    private final AgentTimelinePanel timelinePanel;
    private final WorkspaceContextBar workspaceBar;

    private final ChatListener listener = event -> SwingUtilities.invokeLater(() -> onEvent(event));

    public AgentChatPanel(AgentChatController controller, AgentConfig config, Runnable openSettings) {
        this(controller, config, openSettings, activity -> {});
    }

    public AgentChatPanel(AgentChatController controller, AgentConfig config, Runnable openSettings,
                          java.util.function.Consumer<String> activitySink) {
        super(new BorderLayout());
        this.controller = controller;
        this.config = config;
        this.openSettings = openSettings;
        this.activitySink = activitySink == null ? activity -> {} : activitySink;
        this.timelinePanel = new AgentTimelinePanel(controller.timeline());
        this.workspaceBar = new WorkspaceContextBar(this::projectPath, this::setProjectPath);
        setBackground(UiTheme.PANEL);

        document = transcript.getStyledDocument();
        transcript.setEditable(false);
        transcript.setOpaque(false);
        transcript.setFont(new Font("Microsoft YaHei UI", Font.PLAIN, 13));
        transcript.setForeground(TEXT);
        transcript.setCaretColor(TEXT);

        JScrollPane scroll = new JScrollPane(transcript);
        scroll.setBorder(null);
        scroll.getViewport().setBackground(UiTheme.PANEL);
        scroll.setHorizontalScrollBarPolicy(ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER);

        JPanel center = new JPanel(new BorderLayout());
        center.setOpaque(false);
        center.add(timelinePanel, BorderLayout.NORTH);
        center.add(scroll, BorderLayout.CENTER);
        center.add(reasoning, BorderLayout.SOUTH);

        add(topBar(), BorderLayout.NORTH);
        add(center, BorderLayout.CENTER);
        JPanel composer = new JPanel(new BorderLayout(0, 8));
        composer.setOpaque(false);
        composer.add(bottomBar(), BorderLayout.CENTER);
        composer.add(workspaceBar, BorderLayout.SOUTH);
        add(composer, BorderLayout.SOUTH);

        refreshModelCombo();
        refreshContext();
    }

    private JPanel topBar() {
        JPanel bar = new JPanel(new BorderLayout());
        bar.setOpaque(false);
        bar.setBorder(BorderFactory.createEmptyBorder(12, 16, 8, 16));
        JLabel title = new JLabel("内嵌 Agent");
        title.setFont(title.getFont().deriveFont(Font.BOLD, 13f));
        title.setForeground(UiTheme.TEXT);
        bar.add(title, BorderLayout.WEST);

        JPanel actions = new JPanel(new FlowLayout(FlowLayout.RIGHT, 6, 0));
        actions.setOpaque(false);
        model.setEditable(true);
        actions.add(new JLabel("模型"));
        actions.add(model);
        model.addActionListener(e -> syncModelFromCombo());
        JButton settings = new JButton("设置");
        settings.setFocusPainted(false);
        settings.addActionListener(e -> openSettings.run());
        JButton clear = new JButton("清空");
        clear.setFocusPainted(false);
        clear.addActionListener(e -> {
            controller.reset();
            transcript.setText("");
            reasoning.clear();
            refreshContext();
        });
        JButton newSession = new JButton("新建会话");
        newSession.setFocusPainted(false);
        newSession.addActionListener(e -> {
            controller.reset();
            transcript.setText("");
            reasoning.clear();
            append("— 已新建会话，历史已清空（若需恢复旧会话请勿清空并重启前保留 .codenode/agent-sessions）\n\n", DIM);
            refreshContext();
        });
        actions.add(settings);
        actions.add(newSession);
        actions.add(clear);
        bar.add(actions, BorderLayout.EAST);
        return bar;
    }

    private JPanel bottomBar() {
        JPanel bottom = new JPanel(new BorderLayout(0, 4));
        bottom.setOpaque(false);
        bottom.setBorder(BorderFactory.createEmptyBorder(10, 16, 14, 16));

        JPanel inputRow = new JPanel(new BorderLayout(8, 0));
        inputRow.setOpaque(false);
        JLabel prompt = new JLabel("❯");
        prompt.setFont(new Font("Consolas", Font.BOLD, 18));
        prompt.setForeground(UiTheme.ACCENT);
        prompt.setBorder(BorderFactory.createEmptyBorder(0, 2, 0, 0));
        inputRow.add(prompt, BorderLayout.WEST);

        input.setFont(new Font("Consolas", Font.PLAIN, 14));
        input.setLineWrap(true);
        input.setWrapStyleWord(true);
        input.setBackground(UiTheme.PANEL);
        input.getInputMap().put(KeyStroke.getKeyStroke("ENTER"), "sendLine");
        input.getActionMap().put("sendLine", new AbstractAction() {
            @Override public void actionPerformed(ActionEvent e) { doSend(); }
        });
        input.getInputMap().put(KeyStroke.getKeyStroke("shift ENTER"), "newline");
        input.getActionMap().put("newline", new AbstractAction() {
            @Override public void actionPerformed(ActionEvent e) { input.replaceSelection("\n"); }
        });
        addHierarchyListener(e -> {
            if ((e.getChangeFlags() & HierarchyEvent.SHOWING_CHANGED) != 0 && isShowing()) {
                input.requestFocusInWindow();
            }
        });
        inputRow.add(input, BorderLayout.CENTER);

        JPanel buttons = new JPanel(new GridLayout(1, 3, 6, 0));
        buttons.setOpaque(false);
        send.setFocusPainted(false);
        send.addActionListener(e -> doSend());
        stop.setFocusPainted(false);
        stop.setEnabled(false);
        stop.addActionListener(e -> controller.requestStop());
        cancelTool.setFocusPainted(false);
        cancelTool.setEnabled(false);
        cancelTool.addActionListener(e -> controller.requestToolStop());
        buttons.add(send);
        buttons.add(cancelTool);
        buttons.add(stop);
        inputRow.add(buttons, BorderLayout.EAST);

        bottom.add(inputRow, BorderLayout.CENTER);

        JPanel statusRow = new JPanel(new BorderLayout());
        statusRow.setOpaque(false);
        status.setForeground(UiTheme.MUTED);
        status.setFont(status.getFont().deriveFont(11f));
        statusRow.add(status, BorderLayout.WEST);
        rememberApprovals.setOpaque(false);
        rememberApprovals.setForeground(UiTheme.MUTED);
        rememberApprovals.setFont(rememberApprovals.getFont().deriveFont(11f));
        rememberApprovals.addActionListener(e -> controller.setRememberApprovals(rememberApprovals.isSelected()));
        statusRow.add(rememberApprovals, BorderLayout.CENTER);
        context.setForeground(UiTheme.MUTED);
        context.setFont(context.getFont().deriveFont(11f));
        statusRow.add(context, BorderLayout.EAST);
        bottom.add(statusRow, BorderLayout.NORTH);
        return bottom;
    }

    private void refreshModelCombo() {
        List<String> models = config.models();
        String current = config.model();
        if (model.getItemCount() == 0) {
            for (String m : models) model.addItem(m);
        }
        boolean found = false;
        for (int i = 0; i < model.getItemCount(); i++) {
            if (model.getItemAt(i).equals(current)) { found = true; break; }
        }
        if (!found) model.addItem(current);
        model.setSelectedItem(current);
    }

    private void syncModelFromCombo() {
        Object selected = model.getSelectedItem();
        if (selected == null) return;
        String value = String.valueOf(selected).trim();
        if (value.isEmpty() || value.equals(config.model())) return;
        config.setModel(value);
        try { config.save(); } catch (Exception ignored) {}
    }

    private void refreshContext() {
        int tools = controller.tools().listTools().size();
        String project = config.defaultProjectPath().isBlank() ? "（未设置）" : config.defaultProjectPath();
        context.setText("工具 " + tools + "  |  项目 " + project + "  |  " + (config.isConfigured() ? "已连接" : "未配置"));
    }

    /**
     * 设置 Agent 工作项目路径（随当前打开的项目迁移，而非固定默认值）。
     * 同步更新 config 的 defaultProjectPath，使工具/Agent 上下文指向当前项目。
     */
    public void setProjectPath(String projectRoot) {
        String normalized = projectRoot == null ? "" : projectRoot.trim();
        if (normalized.equals(config.defaultProjectPath())) {
            refreshContext();
            return;
        }
        config.setDefaultProjectPath(normalized);
        try { config.save(); } catch (Exception ignored) {}
        refreshContext();
    }

    /** 当前 Agent 工作项目路径。 */
    public String projectPath() {
        return config.defaultProjectPath();
    }

    /** Replace the visible transcript when switching to another .cnode document. */
    public void showContext(AgentContext context) {
        transcript.setText("");
        reasoning.clear();
        if (context == null) { refreshContext(); return; }
        for (java.util.Map<String, Object> message : context.messages()) {
            String role = String.valueOf(message.getOrDefault("role", ""));
            Object content = message.get("content");
            if (content == null || String.valueOf(content).isBlank()) continue;
            Color color = "user".equals(role) ? USER : "tool".equals(role) ? TOOL : TEXT;
            append(("user".equals(role) ? "❯ " : role + "：") + content + "\n\n", color);
        }
        refreshContext();
    }

    private void doSend() {
        String text = input.getText().trim();
        if (text.isEmpty()) return;
        syncModelFromCombo();
        append("❯ " + text + "\n\n", USER);
        input.setText("");
        refreshModelCombo();
        controller.sendMessage(text, listener);
    }

    private void onEvent(ChatEvent event) {
        switch (event.kind()) {
            case STREAM -> {
                // 正式答案/正文始终显示在主对话区（推理与工具过程放在折叠区）
                append(event.text(), TEXT);
            }
            case REASONING -> {
                reasoning.appendReasoning(event.text());
                if (!reasoning.isExpanded()) reasoning.setExpanded(true);
            }
            case TOOL_CALL -> {
                AgentToolCall call = event.toolCall();
                if (call != null) {
                    reasoning.appendReasoning("\n▸ 调用 " + call.name() + "\n");
                    if (!reasoning.isExpanded()) reasoning.setExpanded(true);
                }
            }
            case TURN_COMPLETE -> {
                append("\n\n", DIM);
            }
            case ERROR -> {
                append("\n✗ " + event.error() + "\n\n", ERROR);
            }
            case CANCELLED -> {
                append("\n— 已停止\n\n", DIM);
            }
            case SYSTEM -> {
                append("\n· " + event.text() + "\n", DIM);
            }
            case STATE -> updateState(event.state() != null ? event.state().name() : "IDLE", event.activity());
        }
    }

    private void updateState(String stateName, String activity) {
        boolean running = "ACTIVE_RUNNING".equals(stateName) || "ACTIVE_CANCELLED".equals(stateName);
        boolean toolActive = activity != null && !activity.isBlank();
        status.setText("IDLE".equals(stateName) ? "空闲"
                : toolActive ? "Agent 正在执行：" + activity
                : "ACTIVE_RUNNING".equals(stateName) ? "生成中…" : stateName);
        send.setEnabled(!running);
        stop.setEnabled(running);
        cancelTool.setEnabled(running && toolActive);
        activitySink.accept(toolActive ? activity : "");
    }

    private void append(String text, Color color) {
        try {
            Style style = transcript.addStyle("s" + System.nanoTime(), null);
            StyleConstants.setForeground(style, color);
            document.insertString(document.getLength(), text, style);
            transcript.setCaretPosition(document.getLength());
        } catch (BadLocationException ignored) {}
    }
}
