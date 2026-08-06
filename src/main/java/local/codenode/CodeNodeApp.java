package local.codenode;

import javax.swing.*;
import javax.swing.plaf.metal.MetalLookAndFeel;
import java.nio.file.Path;

public final class CodeNodeApp {
    private CodeNodeApp() {}
    public static void main(String[] args) {
        System.setProperty("file.encoding","UTF-8");
        if(args.length>=2&&"--mcp".equals(args[0])){
            try{CodeNodeMcpServer.main(Path.of(args[1]));return;}
            catch(Exception error){System.err.println("CodeNode MCP 启动失败："+error.getMessage());System.exit(2);return;}
        }
        SwingUtilities.invokeLater(() -> {
            try { UIManager.setLookAndFeel(new MetalLookAndFeel()); } catch (Exception ignored) {}
            UiTheme.install();
            MainFrame frame=new MainFrame();frame.setVisible(true);if(args.length>0&&args[0].toLowerCase().endsWith(".cnode"))frame.openProject(Path.of(args[0]));
        });
    }
}
