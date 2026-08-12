package local.codenode.ui.agent;

import local.codenode.UiTheme;
import local.codenode.agent.AgentExecutionTimeline;

import javax.swing.BorderFactory;
import javax.swing.DefaultListModel;
import javax.swing.JButton;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.ListSelectionModel;
import javax.swing.SwingUtilities;
import java.awt.BorderLayout;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;

public final class AgentTimelinePanel extends JPanel {
    private final AgentExecutionTimeline timeline;
    private final JLabel state = new JLabel("IDLE");
    private final DefaultListModel<String> items = new DefaultListModel<>();
    private final JButton undo = new JButton("Undo");

    public AgentTimelinePanel(AgentExecutionTimeline timeline) {
        super(new BorderLayout(6, 0));
        this.timeline = timeline;
        setOpaque(false);
        setBorder(BorderFactory.createEmptyBorder(4, 8, 4, 8));
        state.setFont(state.getFont().deriveFont(Font.BOLD, 11f));
        state.setForeground(UiTheme.TEXT);
        add(state, BorderLayout.WEST);
        JList<String> list = new JList<>(items);
        list.setVisibleRowCount(1);
        list.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        list.setOpaque(false);
        list.setFont(list.getFont().deriveFont(11f));
        JScrollPane scroll = new JScrollPane(list);
        scroll.setBorder(null);
        scroll.setOpaque(false);
        scroll.getViewport().setOpaque(false);
        add(scroll, BorderLayout.CENTER);
        undo.setFocusable(false);
        undo.setMargin(new java.awt.Insets(2, 8, 2, 8));
        undo.addActionListener(e -> timeline.undoLast());
        add(undo, BorderLayout.EAST);
        setPreferredSize(new Dimension(10, 34));
        timeline.addListener(snapshot -> SwingUtilities.invokeLater(() -> render(snapshot)));
    }

    private void render(AgentExecutionTimeline.Snapshot snapshot) {
        state.setText(snapshot.taskState().name());
        items.clear();
        for (AgentExecutionTimeline.Step step : snapshot.steps()) {
            items.addElement(symbol(step.state()) + " " + step.tool());
        }
        undo.setEnabled(snapshot.canUndo());
        revalidate();
        repaint();
    }

    private static String symbol(AgentExecutionTimeline.StepState state) {
        return switch (state) {
            case RUNNING -> "...";
            case COMPLETED -> "OK";
            case FAILED -> "!";
            case CANCELLED -> "x";
            case UNDONE -> "<";
        };
    }
}
