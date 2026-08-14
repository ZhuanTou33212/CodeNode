package local.codenode.ui.agent;

import local.codenode.UiTheme;
import local.codenode.agent.AgentChatController;
import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentSessionManager;
import local.codenode.config.AgentConfig;

import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JTabbedPane;
import javax.swing.SwingUtilities;
import java.awt.BorderLayout;
import java.awt.FlowLayout;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;

/** Multi-conversation Agent workbench. Each tab owns an independent controller and transcript. */
public final class AgentSessionPanel extends JPanel {
    private final AgentSessionManager manager;
    private final AgentConfig config;
    private final Runnable openSettings;
    private final Consumer<String> activitySink;
    private final Consumer<AgentChatController> activeControllerSink;
    private String projectPath = "";
    private final JTabbedPane tabs = new JTabbedPane();
    private final Map<String, AgentChatPanel> panels = new LinkedHashMap<>();
    private boolean rebuilding;

    public AgentSessionPanel(AgentSessionManager manager, AgentConfig config, Runnable openSettings,
                             Consumer<String> activitySink,
                             Consumer<AgentChatController> activeControllerSink) {
        super(new BorderLayout());
        this.manager = java.util.Objects.requireNonNull(manager);
        this.config = java.util.Objects.requireNonNull(config);
        this.openSettings = openSettings == null ? () -> { } : openSettings;
        this.activitySink = activitySink == null ? ignored -> { } : activitySink;
        this.activeControllerSink = activeControllerSink == null ? ignored -> { } : activeControllerSink;
        setBackground(UiTheme.PANEL);
        add(header(), BorderLayout.NORTH);
        add(tabs, BorderLayout.CENTER);
        tabs.addChangeListener(e -> activateSelected());
        rebuild();
    }

    private JPanel header() {
        JPanel bar = new JPanel(new BorderLayout());
        bar.setOpaque(false);
        bar.setBorder(BorderFactory.createEmptyBorder(5, 8, 3, 8));
        JLabel hint = new JLabel("Agent conversations share project tasks and knowledge; chat history is isolated.");
        hint.setForeground(UiTheme.MUTED);
        JPanel actions = new JPanel(new FlowLayout(FlowLayout.RIGHT, 5, 0));
        actions.setOpaque(false);
        JButton add = new JButton("+ Conversation");
        add.addActionListener(e -> createSession());
        actions.add(add);
        bar.add(hint, BorderLayout.WEST);
        bar.add(actions, BorderLayout.EAST);
        return bar;
    }

    public AgentSessionManager manager() { return manager; }
    public AgentChatController activeController() { return manager.activeSession().controller(); }
    public AgentContext snapshotContext() { return manager.snapshot(); }

    public String createSession() {
        AgentSessionManager.AgentSession created = manager.createSession();
        addSession(created);
        tabs.setSelectedIndex(tabs.getTabCount() - 1);
        activeControllerSink.accept(created.controller());
        return created.sessionId();
    }

    public boolean closeSession(String sessionId) {
        if (!manager.close(sessionId)) return false;
        rebuild();
        return true;
    }

    public boolean activateSession(String sessionId) {
        AgentSessionManager.AgentSession session;
        try { session = manager.activate(sessionId); }
        catch (IllegalArgumentException missing) { return false; }
        int index = manager.sessions().indexOf(session);
        if (index >= 0) tabs.setSelectedIndex(index);
        activeControllerSink.accept(session.controller());
        return true;
    }

    public void restoreContext(AgentContext context) {
        manager.restore(context);
        rebuild();
    }

    public void setProjectPath(String projectRoot) {
        this.projectPath = projectRoot == null ? "" : projectRoot;
        panels.values().forEach(panel -> panel.setProjectPath(projectRoot));
    }

    private void rebuild() {
        rebuilding = true;
        try {
            tabs.removeAll();
            panels.clear();
            for (AgentSessionManager.AgentSession session : manager.sessions()) addSession(session);
            String active = manager.activeSession().sessionId();
            for (int i = 0; i < manager.sessions().size(); i++) {
                if (manager.sessions().get(i).sessionId().equals(active)) tabs.setSelectedIndex(i);
            }
        } finally {
            rebuilding = false;
        }
        activeControllerSink.accept(manager.activeSession().controller());
    }

    private void addSession(AgentSessionManager.AgentSession session) {
        AgentChatPanel panel = new AgentChatPanel(session.controller(), config, openSettings, activitySink);
        panel.setProjectPath(projectPath);
        panel.showContext(session.controller().snapshotContext());
        panels.put(session.sessionId(), panel);
        tabs.addTab(session.title(), panel);
        int index = tabs.getTabCount() - 1;
        tabs.setTabComponentAt(index, tabHeader(session));
    }

    private JPanel tabHeader(AgentSessionManager.AgentSession session) {
        JPanel header = new JPanel(new FlowLayout(FlowLayout.LEFT, 3, 0));
        header.setOpaque(false);
        header.add(new JLabel(session.title()));
        JButton close = new JButton("×");
        close.setBorderPainted(false);
        close.setContentAreaFilled(false);
        close.setFocusable(false);
        close.addActionListener(e -> closeSession(session.sessionId()));
        header.add(close);
        return header;
    }

    private void activateSelected() {
        if (rebuilding) return;
        int index = tabs.getSelectedIndex();
        if (index < 0 || index >= manager.sessions().size()) return;
        AgentSessionManager.AgentSession selected = manager.sessions().get(index);
        manager.activate(selected.sessionId());
        activeControllerSink.accept(selected.controller());
    }
}
