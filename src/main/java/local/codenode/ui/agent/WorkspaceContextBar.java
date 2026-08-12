package local.codenode.ui.agent;

import local.codenode.UiTheme;

import javax.swing.BorderFactory;
import javax.swing.DefaultListModel;
import javax.swing.JButton;
import javax.swing.JDialog;
import javax.swing.JFileChooser;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTextField;
import javax.swing.SwingUtilities;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Dialog;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.Window;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Compact translucent workspace/context controls inspired by the Codex composer. */
public final class WorkspaceContextBar extends JPanel {
    private final GitWorkspaceService git = new GitWorkspaceService();
    private final Supplier<String> projectSupplier;
    private final Consumer<String> projectConsumer;
    private final JLabel project = new JLabel("未选择项目");
    private final JLabel branch = new JLabel("未初始化");
    private final JButton projectButton = new JButton();
    private final JButton branchButton = new JButton();
    private final JButton modeButton = new JButton("本地处理");
    private final JButton voiceButton = new JButton("◉");
    private final JButton sendButton = new JButton("↑");

    public WorkspaceContextBar(Supplier<String> projectSupplier, Consumer<String> projectConsumer) {
        super(new BorderLayout(6, 0));
        this.projectSupplier = projectSupplier;
        this.projectConsumer = projectConsumer;
        setOpaque(false);
        setBorder(BorderFactory.createCompoundBorder(BorderFactory.createLineBorder(new Color(210, 203, 185)), BorderFactory.createEmptyBorder(4, 8, 4, 8)));
        JPanel context = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 0));
        context.setOpaque(false);
        style(projectButton); style(branchButton); style(modeButton); style(voiceButton); style(sendButton);
        projectButton.addActionListener(e -> showProjectMenu(projectButton));
        branchButton.addActionListener(e -> showBranchMenu(branchButton));
        modeButton.addActionListener(e -> showModeMenu(modeButton));
        projectButton.add(project);
        branchButton.add(branch);
        context.add(projectButton); context.add(branchButton);
        add(context, BorderLayout.WEST);
        JPanel actions = new JPanel(new FlowLayout(FlowLayout.RIGHT, 4, 0));
        actions.setOpaque(false);
        actions.add(modeButton); actions.add(voiceButton); actions.add(sendButton);
        add(actions, BorderLayout.EAST);
        refresh();
    }

    public void refresh() {
        String root = projectSupplier.get();
        Path path = root == null || root.isBlank() ? null : Path.of(root);
        project.setText(path == null ? "未选择项目" : abbreviate(path));
        GitWorkspaceService.Snapshot snapshot = git.snapshot(path);
        branch.setText(snapshot.branch());
        branchButton.setToolTipText(snapshot.repository() ? "Git 分支 · 未提交 " + snapshot.changedFiles() + " 个文件" : "当前项目不是 Git 仓库");
    }

    private void showProjectMenu(JButton anchor) {
        JDialog dialog = popup(anchor, "项目");
        JPanel body = (JPanel) dialog.getContentPane();
        JTextField search = new JTextField(); search.putClientProperty("JTextField.placeholderText", "搜索项目");
        body.add(search, BorderLayout.NORTH);
        DefaultListModel<String> model = new DefaultListModel<>();
        String current = projectSupplier.get(); if (current != null && !current.isBlank()) model.addElement(current);
        JList<String> list = new JList<>(model); body.add(new JScrollPane(list), BorderLayout.CENTER);
        JPanel footer = new JPanel(new FlowLayout(FlowLayout.LEFT));
        JButton choose = new JButton("＋ 选择项目…"); choose.addActionListener(e -> { dialog.dispose(); JFileChooser chooser = new JFileChooser(projectPath() == null ? null : projectPath().toFile()); chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY); if (chooser.showOpenDialog(this) == JFileChooser.APPROVE_OPTION) projectConsumer.accept(chooser.getSelectedFile().toPath().toAbsolutePath().normalize().toString()); });
        JButton clear = new JButton("× 不在项目中工作"); clear.addActionListener(e -> { dialog.dispose(); projectConsumer.accept(""); });
        footer.add(choose); footer.add(clear); body.add(footer, BorderLayout.SOUTH);
        search.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() { public void insertUpdate(javax.swing.event.DocumentEvent e){filter(model, search.getText());} public void removeUpdate(javax.swing.event.DocumentEvent e){filter(model, search.getText());} public void changedUpdate(javax.swing.event.DocumentEvent e){} });
        dialog.setVisible(true);
    }

    private void showBranchMenu(JButton anchor) {
        JDialog dialog = popup(anchor, "Git 分支");
        JPanel body = (JPanel) dialog.getContentPane();
        JTextField search = new JTextField(); search.putClientProperty("JTextField.placeholderText", "搜索分支"); body.add(search, BorderLayout.NORTH);
        DefaultListModel<String> model = new DefaultListModel<>();
        Path root = projectPath(); for (String value : git.branches(root)) model.addElement(value);
        JList<String> list = new JList<>(model); body.add(new JScrollPane(list), BorderLayout.CENTER);
        JPanel footer = new JPanel(new FlowLayout(FlowLayout.LEFT)); JButton create = new JButton("＋ 创建并检出新分支…");
        create.addActionListener(e -> { String name = javax.swing.JOptionPane.showInputDialog(dialog, "分支名称"); if (name != null && git.createBranch(root, name)) { refresh(); dialog.dispose(); } }); footer.add(create); body.add(footer, BorderLayout.SOUTH);
        list.addListSelectionListener(e -> { if (!e.getValueIsAdjusting() && git.checkout(root, list.getSelectedValue())) { refresh(); dialog.dispose(); } });
        dialog.setVisible(true);
    }

    private void showModeMenu(JButton anchor) {
        JDialog dialog = popup(anchor, "启动模式"); JPanel body = (JPanel) dialog.getContentPane();
        String[] modes = {"在本地处理", "新工作树", "关联 Codex web", "发送至云端", "剩余用量"};
        body.setLayout(new javax.swing.BoxLayout(body, javax.swing.BoxLayout.Y_AXIS));
        for (String mode : modes) { JButton item = new JButton(mode); item.setHorizontalAlignment(JButton.LEFT); item.setBorderPainted(false); item.setContentAreaFilled(false); item.addActionListener(e -> { modeButton.setText(mode); dialog.dispose(); }); body.add(item, BorderLayout.NORTH); }
        dialog.setVisible(true);
    }

    private JDialog popup(JButton anchor, String title) {
        Window owner = SwingUtilities.getWindowAncestor(this); JDialog dialog = new JDialog(owner, title, Dialog.ModalityType.MODELESS);
        dialog.setLayout(new BorderLayout()); dialog.getContentPane().setBackground(UiTheme.BACKGROUND); dialog.setSize(new Dimension(360, 300)); dialog.setLocationRelativeTo(anchor); return dialog;
    }

    private Path projectPath() { String value = projectSupplier.get(); return value == null || value.isBlank() ? null : Path.of(value); }
    private static void filter(DefaultListModel<String> model, String query) { for (int i = 0; i < model.size(); i++) model.set(i, model.get(i)); }
    private static String abbreviate(Path path) { String text = path.getFileName() == null ? path.toString() : path.getFileName().toString(); return text.length() > 24 ? text.substring(0, 21) + "…" : text; }
    private static void style(JButton button) { button.setFocusable(false); button.setFont(button.getFont().deriveFont(Font.PLAIN, 12f)); button.setBorder(BorderFactory.createEmptyBorder(4, 6, 4, 6)); button.setContentAreaFilled(false); }
}
