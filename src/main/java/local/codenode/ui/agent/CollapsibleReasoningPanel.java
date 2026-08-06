package local.codenode.ui.agent;

import local.codenode.UiTheme;

import javax.swing.*;
import java.awt.*;
import java.util.Objects;

/** 推理折叠区：显示模型 reasoning_content，可展开/收起（Stage4.2）。 */
public final class CollapsibleReasoningPanel extends JPanel {
    private final JToggleButton toggle = new JToggleButton("推理 ▸");
    private final JTextArea area = new JTextArea(5, 24);
    private final JScrollPane scroll;
    private boolean expanded;

    public CollapsibleReasoningPanel() {
        super(new BorderLayout());
        setBackground(UiTheme.PANEL);
        setBorder(BorderFactory.createMatteBorder(1, 0, 0, 0, UiTheme.BORDER));

        toggle.setFocusPainted(false);
        toggle.setFont(toggle.getFont().deriveFont(Font.PLAIN, 12f));
        toggle.setBackground(UiTheme.INPUT);
        toggle.setForeground(UiTheme.MUTED);
        toggle.setOpaque(true);
        toggle.addActionListener(e -> setExpanded(toggle.isSelected()));

        area.setEditable(false);
        area.setLineWrap(true);
        area.setWrapStyleWord(true);
        area.setFont(new Font("Consolas", Font.PLAIN, 12));
        area.setForeground(new Color(170, 200, 230));
        scroll = new JScrollPane(area);
        scroll.setVisible(false);

        JPanel header = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 3));
        header.setBackground(UiTheme.PANEL);
        header.add(toggle);
        add(header, BorderLayout.NORTH);
        add(scroll, BorderLayout.CENTER);
    }

    public void appendReasoning(String text) {
        area.append(Objects.requireNonNullElse(text, ""));
        if (expanded) scroll.getVerticalScrollBar().setValue(scroll.getVerticalScrollBar().getMaximum());
    }

    public void clear() {
        area.setText("");
    }

    public boolean isExpanded() {
        return expanded;
    }

    public void setExpanded(boolean value) {
        expanded = value;
        toggle.setSelected(value);
        toggle.setText(value ? "推理 ▾" : "推理 ▸");
        scroll.setVisible(value);
        revalidate();
        repaint();
    }
}
