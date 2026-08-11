package local.codenode;

import javax.swing.*;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;
import java.awt.*;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.util.function.Consumer;

public class CodeEditor extends JPanel {
    private final JTextArea codeArea;
    private final JTextArea lineNumbers;
    private final JScrollPane scrollPane;
    private boolean readOnly;
    private Consumer<String> onChanged;

    public CodeEditor(boolean readOnly) {
        super(new BorderLayout());
        this.readOnly = readOnly;

        codeArea = new JTextArea();
        codeArea.setFont(new Font("Consolas", Font.PLAIN, 13));
        codeArea.setTabSize(4);
        codeArea.setLineWrap(false);
        codeArea.setWrapStyleWord(false);
        codeArea.setEditable(!readOnly);
        codeArea.setBorder(BorderFactory.createEmptyBorder(4, 6, 4, 6));
        codeArea.addKeyListener(new KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == KeyEvent.VK_TAB && !readOnly) {
                    e.consume();
                    int pos = codeArea.getCaretPosition();
                    try {
                        codeArea.getDocument().insertString(pos, "    ", null);
                    } catch (javax.swing.text.BadLocationException ignored) {
                    }
                }
            }
        });

        lineNumbers = new JTextArea();
        lineNumbers.setFont(new Font("Consolas", Font.PLAIN, 13));
        lineNumbers.setEditable(false);
        lineNumbers.setBorder(BorderFactory.createEmptyBorder(4, 6, 4, 6));
        lineNumbers.setLineWrap(false);
        lineNumbers.setWrapStyleWord(false);

        scrollPane = new JScrollPane(codeArea);
        scrollPane.setRowHeaderView(lineNumbers);
        scrollPane.setBorder(null);

        codeArea.getDocument().addDocumentListener(new DocumentListener() {
            private void update() {
                updateLineNumbers();
                if (onChanged != null) onChanged.accept(codeArea.getText());
            }

            @Override
            public void insertUpdate(DocumentEvent e) { update(); }

            @Override
            public void removeUpdate(DocumentEvent e) { update(); }

            @Override
            public void changedUpdate(DocumentEvent e) { update(); }
        });

        updateLineNumbers();
        add(scrollPane, BorderLayout.CENTER);

        applyCustomTheme();
    }

    public void applyCustomTheme() {
        codeArea.setBackground(readOnly ? UiTheme.PANEL : UiTheme.INPUT);
        codeArea.setForeground(UiTheme.TEXT);
        codeArea.setCaretColor(UiTheme.TEXT);
        codeArea.setSelectionColor(UiTheme.SELECTION);
        codeArea.setSelectedTextColor(UiTheme.TEXT);
        lineNumbers.setBackground(UiTheme.TOOLBAR);
        lineNumbers.setForeground(UiTheme.MUTED);
    }

    private void updateLineNumbers() {
        int lines = Math.max(codeArea.getLineCount(), 1);
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i <= lines; i++) {
            sb.append(i).append('\n');
        }
        lineNumbers.setText(sb.toString());
    }

    public void setCode(String code) {
        codeArea.setText(code == null ? "" : code);
        updateLineNumbers();
        codeArea.setCaretPosition(0);
    }

    public String getCode() {
        return codeArea.getText();
    }

    public void setReadOnly(boolean readOnly) {
        this.readOnly = readOnly;
        codeArea.setEditable(!readOnly);
        codeArea.setBackground(readOnly ? UiTheme.PANEL : UiTheme.INPUT);
    }

    public boolean isReadOnly() { return readOnly; }

    public void setOnChanged(Consumer<String> listener) { this.onChanged = listener; }

    public void syncScrollWith(CodeEditor other) {
        JScrollBar thisBar = scrollPane.getVerticalScrollBar();
        JScrollBar otherBar = other.scrollPane.getVerticalScrollBar();
        thisBar.addAdjustmentListener(e -> {
            if (!e.getValueIsAdjusting()) {
                otherBar.setValue(e.getValue());
            }
        });
        otherBar.addAdjustmentListener(e -> {
            if (!e.getValueIsAdjusting()) {
                thisBar.setValue(e.getValue());
            }
        });
    }

    public JScrollPane getScrollPane() { return scrollPane; }

    public void requestCodeFocus() {
        codeArea.requestFocusInWindow();
    }
}
