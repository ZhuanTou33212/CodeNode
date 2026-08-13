package local.codenode.ui.settings;

import local.codenode.UiTheme;
import local.codenode.config.AgentConfig;

import javax.swing.*;
import java.awt.*;

/** Agent API 配置面板：baseUrl / model / apiKey / default_project_path，保存到本地配置文件。apiKey 掩码显示。 */
public final class AgentSettingsPanel extends JPanel {
    private final AgentConfig config;
    private final JTextField baseUrl = new JTextField(24);
    private final JTextField model = new JTextField(24);
    private final JTextField projectPath = new JTextField(24);
    private final JPasswordField apiKey = new JPasswordField(24);
    private final JTextField permissions = new JTextField(24);
    private final JLabel feedback = new JLabel(" ");

    public AgentSettingsPanel(AgentConfig config) {
        super(new BorderLayout());
        this.config = config;

        JPanel body = new JPanel();
        body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS));
        body.setBorder(BorderFactory.createEmptyBorder(10, 12, 10, 12));

        body.add(field("API Base URL", baseUrl, "如 https://api.openai.com/v1"));
        body.add(Box.createVerticalStrut(8));
        body.add(field("API Key（掩码显示）", apiKey, "仅存本地配置文件，不写入工程"));
        body.add(Box.createVerticalStrut(8));
        body.add(field("模型", model, "如 gpt-4o-mini"));
        body.add(Box.createVerticalStrut(8));
        body.add(field("默认项目路径", projectPath, "工具 scan_project 等的默认根目录"));

        baseUrl.setText(config.apiBase());
        body.add(Box.createVerticalStrut(8));
        body.add(field("Agent 权限", permissions, "如 ui:allow,write:confirm,execute:confirm,system:enabled"));

        model.setText(config.model());
        projectPath.setText(config.defaultProjectPath());
        apiKey.setText(config.apiKey());

        JPanel actions = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 4));
        actions.setOpaque(false);
        permissions.setText(config.permissions());
        JButton save = new JButton("保存配置");
        save.addActionListener(e -> saveSettings());
        JButton close = new JButton("关闭");
        actions.add(save);
        actions.add(close);
        body.add(Box.createVerticalStrut(10));
        body.add(actions);
        feedback.setForeground(UiTheme.MUTED);
        body.add(feedback);

        add(body, BorderLayout.CENTER);
        close.addActionListener(e -> {
            Window window = SwingUtilities.getWindowAncestor(AgentSettingsPanel.this);
            if (window != null) window.dispose();
        });
        UiTheme.apply(this);
    }

    private static JPanel field(String labelText, JComponent field, String hint) {
        JPanel panel = new JPanel(new BorderLayout(0, 3));
        panel.setOpaque(false);
        JLabel label = new JLabel(labelText);
        label.setForeground(UiTheme.TEXT);
        label.setFont(label.getFont().deriveFont(Font.BOLD, 12f));
        panel.add(label, BorderLayout.NORTH);
        panel.add(field, BorderLayout.CENTER);
        if (hint != null && !hint.isBlank()) {
            JLabel hintLabel = new JLabel(hint);
            hintLabel.setForeground(UiTheme.MUTED);
            hintLabel.setFont(hintLabel.getFont().deriveFont(11f));
            panel.add(hintLabel, BorderLayout.SOUTH);
        }
        return panel;
    }

    private void saveSettings() {
        config.setApiBase(baseUrl.getText());
        config.setModel(model.getText());
        config.setDefaultProjectPath(projectPath.getText());
        config.setApiKey(new String(apiKey.getPassword()));
        config.setPermissions(permissions.getText());
        try {
            config.save();
            feedback.setForeground(new Color(58, 116, 73));
            feedback.setText("已保存到 " + config.file());
        } catch (Exception e) {
            feedback.setForeground(new Color(166, 55, 47));
            feedback.setText("保存失败：" + e.getMessage());
        }
    }
}
