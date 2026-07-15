package local.codenode;

import javax.swing.*;
import javax.swing.plaf.metal.MetalLookAndFeel;

public final class CodeNodeApp {
    private CodeNodeApp() {}
    public static void main(String[] args) {
        System.setProperty("file.encoding","UTF-8");
        SwingUtilities.invokeLater(() -> {
            try { UIManager.setLookAndFeel(new MetalLookAndFeel()); } catch (Exception ignored) {}
            UiTheme.install();
            new MainFrame().setVisible(true);
        });
    }
}
