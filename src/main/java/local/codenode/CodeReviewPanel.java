package local.codenode;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;

public class CodeReviewPanel extends JPanel {
    private final CodeEditor leftEditor;
    private final CodeEditor rightEditor;
    private final JLabel infoBar;
    private final JButton acceptBtn;
    private final JButton rejectBtn;
    private final JButton rollbackBtn;
    private final JButton refreshBtn;
    private final Runnable onAccept;
    private final Runnable onReject;
    private final Runnable onRollback;
    private final Runnable onRefresh;

    private WorkflowModel.Node currentNode;
    private WorkflowModel.CodeSlot currentSlot;
    private boolean draftModified;

    public CodeReviewPanel(Runnable onAccept, Runnable onReject, Runnable onRollback, Runnable onRefresh) {
        super(new BorderLayout());
        this.onAccept = onAccept;
        this.onReject = onReject;
        this.onRollback = onRollback;
        this.onRefresh = onRefresh;

        setPreferredSize(new Dimension(400, 250));

        infoBar = new JLabel("选择节点后显示代码审查摘要。");
        infoBar.setForeground(UiTheme.MUTED);
        infoBar.setBorder(new EmptyBorder(4, 10, 4, 10));

        leftEditor = new CodeEditor(true);
        rightEditor = new CodeEditor(false);
        leftEditor.syncScrollWith(rightEditor);

        JLabel leftTitle = new JLabel("  活动代码（当前版本） — 只读");
        leftTitle.setOpaque(true);
        leftTitle.setBackground(UiTheme.TOOLBAR);
        leftTitle.setForeground(UiTheme.MUTED);
        leftTitle.setBorder(BorderFactory.createMatteBorder(0, 0, 1, 0, UiTheme.BORDER));

        JLabel rightTitle = new JLabel("  草稿代码（可编辑） — 可编辑");
        rightTitle.setOpaque(true);
        rightTitle.setBackground(UiTheme.TOOLBAR);
        rightTitle.setForeground(UiTheme.MUTED);
        rightTitle.setBorder(BorderFactory.createMatteBorder(0, 0, 1, 0, UiTheme.BORDER));

        JPanel leftPanel = new JPanel(new BorderLayout());
        leftPanel.add(leftTitle, BorderLayout.NORTH);
        leftPanel.add(leftEditor, BorderLayout.CENTER);

        JPanel rightPanel = new JPanel(new BorderLayout());
        rightPanel.add(rightTitle, BorderLayout.NORTH);
        rightPanel.add(rightEditor, BorderLayout.CENTER);

        JSplitPane splitPane = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, leftPanel, rightPanel);
        splitPane.setResizeWeight(0.5);
        UiTheme.styleSplit(splitPane);

        rightEditor.setOnChanged(code -> {
            draftModified = true;
            updateButtonStates();
        });

        JPanel actions = new JPanel(new FlowLayout(FlowLayout.LEFT, 5, 4));
        acceptBtn = new JButton("接受草稿");
        rejectBtn = new JButton("拒绝草稿");
        rollbackBtn = new JButton("回滚上一版");
        refreshBtn = new JButton("刷新审查");

        acceptBtn.addActionListener(e -> { if (onAccept != null) onAccept.run(); });
        rejectBtn.addActionListener(e -> { if (onReject != null) onReject.run(); });
        rollbackBtn.addActionListener(e -> { if (onRollback != null) onRollback.run(); });
        refreshBtn.addActionListener(e -> { if (onRefresh != null) onRefresh.run(); });

        actions.add(acceptBtn);
        actions.add(rejectBtn);
        actions.add(rollbackBtn);
        actions.add(refreshBtn);
        JLabel hint = new JLabel("在右侧编辑代码后点击「接受草稿」");
        hint.setForeground(UiTheme.MUTED);
        actions.add(hint);

        add(infoBar, BorderLayout.NORTH);
        add(splitPane, BorderLayout.CENTER);
        add(actions, BorderLayout.SOUTH);

        updateButtonStates();
    }

    public void loadFrom(WorkflowModel.Node node, WorkflowModel.CodeSlot slot) {
        boolean sameSlot = currentSlot != null && currentSlot == slot;
        boolean sameNode = currentNode != null && currentNode == node;

        if (draftModified && sameSlot && sameNode) {
            updateInfoBar(node, slot);
            updateButtonStates();
            return;
        }

        String pendingCode = null;
        if (draftModified && sameNode && sameSlot) {
            pendingCode = rightEditor.getCode();
        }

        this.currentNode = node;
        this.currentSlot = slot;
        this.draftModified = false;

        if (node == null) {
            infoBar.setText("选择节点后显示代码审查摘要。");
            leftEditor.setCode("");
            rightEditor.setCode("");
            rightEditor.setReadOnly(true);
            updateButtonStates();
            return;
        }

        leftEditor.setReadOnly(true);
        rightEditor.setReadOnly(false);

        StringBuilder info = new StringBuilder();
        info.append("节点: ").append(node.name).append(" [").append(node.id).append("]");
        info.append("  |  类型: ").append(node.nodeKind);
        info.append("  |  状态: ").append(node.status);

        if (slot != null) {
            info.append("  |  代码槽: ").append(slot.id);
            info.append("  |  活动版本: ").append(slot.activeRevision);

            leftEditor.setCode(slot.activeCode.isBlank() ? "// 尚无活动代码" : slot.activeCode);

            if (pendingCode != null) {
                rightEditor.setCode(pendingCode);
                draftModified = true;
                info.append("  |  (编辑中)");
            } else if (slot.draft != null) {
                rightEditor.setCode(slot.draft.code);
                info.append("  |  草稿来源: ").append(slot.draft.requestId);
            } else {
                String activeCode = slot.activeCode.isBlank() ? "" : slot.activeCode;
                rightEditor.setCode(activeCode);
                info.append("  |  (无草稿，可直接编辑)");
            }
        } else {
            info.append("  |  (无代码槽)");
            leftEditor.setCode("");
            rightEditor.setCode("");
            rightEditor.setReadOnly(true);
        }

        infoBar.setText(info.toString());
        updateButtonStates();

        leftEditor.getScrollPane().getViewport().setViewPosition(new Point(0, 0));
        rightEditor.getScrollPane().getViewport().setViewPosition(new Point(0, 0));
    }

    private void updateInfoBar(WorkflowModel.Node node, WorkflowModel.CodeSlot slot) {
        StringBuilder info = new StringBuilder();
        info.append("节点: ").append(node.name).append(" [").append(node.id).append("]");
        info.append("  |  类型: ").append(node.nodeKind);
        info.append("  |  状态: ").append(node.status);
        if (slot != null) {
            info.append("  |  代码槽: ").append(slot.id);
            info.append("  |  活动版本: ").append(slot.activeRevision);
            if (slot.draft != null) {
                info.append("  |  草稿来源: ").append(slot.draft.requestId);
            }
        }
        info.append("  |  (编辑中)");
        infoBar.setText(info.toString());
    }

    private void updateButtonStates() {
        boolean hasNode = currentNode != null;
        boolean hasSlot = currentSlot != null;
        boolean hasDraft = hasSlot && currentSlot.draft != null;
        boolean canRollback = hasSlot && currentSlot.previousSourceRevision >= 0;

        acceptBtn.setEnabled(hasNode && hasSlot && (hasDraft || draftModified));
        rejectBtn.setEnabled(hasNode && hasSlot && hasDraft);
        rollbackBtn.setEnabled(hasNode && canRollback);
    }

    public boolean isDraftModified() {
        return draftModified;
    }

    public String getEditedDraftCode() {
        return rightEditor.getCode();
    }

    public void resetModifiedFlag() {
        draftModified = false;
        updateButtonStates();
    }

    public void fixupTheme() {
        leftEditor.applyCustomTheme();
        rightEditor.applyCustomTheme();
    }
}
