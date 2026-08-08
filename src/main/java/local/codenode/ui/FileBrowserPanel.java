package local.codenode.ui;

import local.codenode.ProjectScanner;
import local.codenode.UiTheme;

import javax.swing.*;
import javax.swing.tree.DefaultMutableTreeNode;
import javax.swing.tree.DefaultTreeModel;
import javax.swing.tree.TreePath;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.function.BiConsumer;

/**
 * 左侧文件浏览器（对标 IntelliJ Project 工具窗口）：显示项目目录树，
 * 双击文件 → 回调（在画布创建/定位文件节点 + 代码栏打开）。
 * 目录/文件忽略规则复用 {@link ProjectScanner}。
 */
public final class FileBrowserPanel extends JPanel {
    private final DefaultMutableTreeNode root = new DefaultMutableTreeNode("项目");
    private final JTree tree = new JTree(root);
    private final BiConsumer<Path, Boolean> openFile; // (文件路径, 是否文本) 双击回调
    private Path projectRoot;

    public FileBrowserPanel(BiConsumer<Path, Boolean> openFile) {
        super(new BorderLayout());
        this.openFile = openFile;
        setBackground(UiTheme.BACKGROUND);
        tree.setRootVisible(false);
        tree.setShowsRootHandles(true);
        tree.setBorder(BorderFactory.createEmptyBorder(4, 4, 4, 4));
        tree.setFont(new Font("Microsoft YaHei UI", Font.PLAIN, 13));
        // 与全局 UI 统一的暗色主题
        tree.setBackground(UiTheme.PANEL);
        tree.setForeground(UiTheme.TEXT);
        tree.setOpaque(true);
        tree.setRowHeight(0);
        javax.swing.tree.DefaultTreeCellRenderer renderer = (javax.swing.tree.DefaultTreeCellRenderer) tree.getCellRenderer();
        renderer.setBackgroundSelectionColor(UiTheme.SELECTION);
        renderer.setBackgroundNonSelectionColor(UiTheme.PANEL);
        renderer.setTextNonSelectionColor(UiTheme.TEXT);
        renderer.setTextSelectionColor(UiTheme.TEXT);
        renderer.setBorderSelectionColor(UiTheme.ACCENT);
        renderer.setClosedIcon(null);
        renderer.setOpenIcon(null);
        renderer.setLeafIcon(null);
        tree.addMouseListener(new MouseAdapter() {
            @Override public void mouseClicked(MouseEvent e) {
                if (e.getClickCount() == 2) {
                    TreePath path = tree.getPathForLocation(e.getX(), e.getY());
                    if (path == null) return;
                    DefaultMutableTreeNode node = (DefaultMutableTreeNode) path.getLastPathComponent();
                    Object user = node.getUserObject();
                    if (user instanceof FileEntry entry && !entry.isDir) {
                        openFile.accept(entry.file, entry.text);
                    }
                }
            }
        });
        JScrollPane scroll = new JScrollPane(tree);
        scroll.setBorder(BorderFactory.createEmptyBorder());
        scroll.getViewport().setBackground(UiTheme.PANEL);
        scroll.setBackground(UiTheme.PANEL);
        add(scroll, BorderLayout.CENTER);
    }

    /** 刷新目录树为指定项目根目录。 */
    public void setRoot(Path rootDir) {
        this.projectRoot = rootDir == null ? null : rootDir.toAbsolutePath().normalize();
        refresh();
    }

    public void refresh() {
        if (projectRoot == null) {
            root.removeAllChildren();
        } else {
            root.removeAllChildren();
            root.setUserObject(projectRoot.getFileName() == null ? "项目" : projectRoot.getFileName().toString());
            for (Path child : listChildren(projectRoot)) {
                DefaultMutableTreeNode node = new DefaultMutableTreeNode();
                node.setUserObject(entryFor(child));
                root.add(node);
                if (Files.isDirectory(child)) {
                    populateDir(child, node, 0);
                }
            }
        }
        ((DefaultTreeModel) tree.getModel()).reload();
        expandRoot();
    }

    private void populateDir(Path dir, DefaultMutableTreeNode parent, int depth) {
        if (depth > 8) return;
        for (Path child : listChildren(dir)) {
            DefaultMutableTreeNode node = new DefaultMutableTreeNode();
            node.setUserObject(entryFor(child));
            parent.add(node);
            if (Files.isDirectory(child)) {
                populateDir(child, node, depth + 1);
            }
        }
    }

    private List<Path> listChildren(Path dir) {
        try (var stream = Files.list(dir)) {
            return stream.sorted(Comparator.comparing(p -> p.getFileName().toString().toLowerCase()))
                    .toList();
        } catch (Exception e) {
            return List.of();
        }
    }

    private Object entryFor(Path child) {
        String name = child.getFileName() == null ? "" : child.getFileName().toString();
        if (Files.isDirectory(child)) {
            return ProjectScanner.isIgnoredDirName(name) ? null : new FileEntry(child, false, false);
        }
        String ext = ext(name);
        if (ProjectScanner.isIgnoredExt(ext)) return null;
        boolean text = isText(ext);
        return new FileEntry(child, false, text);
    }

    private static String ext(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase();
    }

    private static boolean isText(String ext) {
        return switch (ext) {
            case "java", "kt", "groovy", "gradle", "kts", "xml", "json", "yml", "yaml", "properties",
                 "txt", "md", "html", "css", "js", "ts", "py", "c", "cpp", "h", "cs", "go", "rs",
                 "sql", "sh", "bat", "cfg", "conf", "toml", "ini", "csv" -> true;
            default -> false;
        };
    }

    private void expandRoot() {
        for (int i = 0; i < tree.getRowCount(); i++) tree.expandRow(i);
    }

    public Path projectRoot() {
        return projectRoot;
    }

    /** 节点条目：文件或目录。 */
    public record FileEntry(Path file, boolean isDir, boolean text) {
        @Override public String toString() {
            return file.getFileName() == null ? "" : file.getFileName().toString();
        }
    }
}
