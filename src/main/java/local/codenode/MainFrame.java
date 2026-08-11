/*
 * Decompiled with CFR 0.152.
 */
package local.codenode;

import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.Image;
import java.awt.Insets;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.Toolkit;
import java.awt.datatransfer.StringSelection;
import java.awt.event.ActionEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.CopyOption;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.FileAttribute;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.prefs.Preferences;
import javax.swing.AbstractAction;
import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.DefaultListModel;
import javax.swing.ImageIcon;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JFileChooser;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JPopupMenu;
import javax.swing.JProgressBar;
import javax.swing.JScrollBar;
import javax.swing.JScrollPane;
import javax.swing.JSeparator;
import javax.swing.JSplitPane;
import javax.swing.JTabbedPane;
import javax.swing.JTable;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.KeyStroke;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import javax.swing.border.EmptyBorder;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;
import javax.swing.filechooser.FileNameExtensionFilter;
import javax.swing.text.JTextComponent;
import local.codenode.AgentProvider;
import local.codenode.CanvasPanel;
import local.codenode.CnodeProjectCodec;
import local.codenode.CnodeRecoveryService;
import local.codenode.CodeReviewPanel;
import local.codenode.CodeSlotService;
import local.codenode.CodexAppServerProvider;
import local.codenode.DirectoryGraphBuilder;
import local.codenode.FileContentAnalyzer;
import local.codenode.HierarchyLayout;
import local.codenode.Json;
import local.codenode.NodeControlApi;
import local.codenode.NodeRegistry;
import local.codenode.PortTableModel;
import local.codenode.PortTypeEditor;
import local.codenode.ProjectAnalysisService;
import local.codenode.QueueService;
import local.codenode.ResultService;
import local.codenode.ToolWindow;
import local.codenode.UiTheme;
import local.codenode.WorkflowModel;
import local.codenode.agent.AgentChatController;
import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentInfoSnapshot;
import local.codenode.agent.SoftwareInfoProvider;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.impl.AgentToolkit;
import local.codenode.config.AgentConfig;
import local.codenode.ui.agent.AgentChatPanel;
import local.codenode.ui.settings.AgentSettingsPanel;

public final class MainFrame extends JFrame implements SoftwareInfoProvider {
    private final WorkflowModel model = new WorkflowModel();
    private final CanvasPanel canvas = new CanvasPanel(this.model);
    private final JComboBox<WorkflowModel.Mode> mode = new JComboBox<WorkflowModel.Mode>(WorkflowModel.Mode.values());
    private final JComboBox<String> language = new JComboBox<String>(new String[]{"java", "powershell", "go"});
    private final JComboBox<String> agentProvider = new JComboBox<String>(new String[]{"本地申请槽", "Codex 自动"});
    private final JTextField project = new JTextField("", 25);
    private final JTextField output = new JTextField("output", 18);
    private final JTextField nodeName = new JTextField();
    private final JTextField artifact = new JTextField();
    private final JComboBox<NodeOwnerChoice> fileOwner = new JComboBox();
    private final JComboBox<NodeOwnerChoice> parentScope = new JComboBox();
    private final JComboBox<String> operation = new JComboBox();
    private final JTextField nodeColor = new JTextField();
    private final JCheckBox rangeMode = new JCheckBox("范围模式（作为容器）");
    private final JComboBox<String> assetTypeCombo = new JComboBox();
    private final JTextArea bundleData = new JTextArea(4, 22);
    private final JButton expandBundleBtn = new JButton("展开资源组为独立节点");
    private final JLabel assetPreview = new JLabel();
    private final JTextArea prompt = new JTextArea(7, 22);
    private final JComboBox<SubmissionChoice> submissionTarget = new JComboBox<>();
    private final JButton submitRequestButton = new JButton("提交");
    private CodeReviewPanel codeReviewPanel;
    private final DefaultListModel<String> queueItems = new DefaultListModel();
    private final JList<String> queueList = new JList<String>(this.queueItems);
    private final PortTableModel portModel = new PortTableModel();
    private final JTable portTable = new JTable(this.portModel);
    private final JLabel nodePath = new JLabel("工作流 / 未选择节点");
    private final JLabel status = new JLabel("  就绪");
    private final JProgressBar progressBar = new JProgressBar();
    private final JLabel documentTab = new JLabel();
    private final JTabbedPane documentTabs = new JTabbedPane();
    private final List<DocumentSession> documents = new ArrayList<DocumentSession>();
    private final CnodeProjectCodec projectCodec = new CnodeProjectCodec();
    private final CnodeRecoveryService recovery = new CnodeRecoveryService(this.projectCodec);
    private final CodeSlotService codeSlotService = new CodeSlotService();
    private final AgentProvider codexAgent = new CodexAppServerProvider();
    private final AgentConfig agentConfig = AgentConfig.load();
    private AgentToolContext agentToolContext;
    private AgentToolRegistry agentTools;
    private AgentChatController agentChatController;
    private AgentChatPanel agentChatPanel;
    private NodeControlApi nodeControlApi;
    private final Preferences preferences = Preferences.userNodeForPackage(MainFrame.class);
    private final List<Path> recentProjects = new ArrayList<Path>();
    private final Timer resultPollTimer;
    private final Timer autoSaveTimer;
    private JButton analysisBtn;
    private QueueService queue;
    private ResultService results;
    private Path currentProjectFile;
    private String documentId = UUID.randomUUID().toString();
    private Instant documentCreatedAt = Instant.now();
    private boolean projectReadOnly;
    private boolean loadingProject;
    private boolean loadingInspector;
    private boolean dirty;
    private WorkflowModel.Mode displayedMode = WorkflowModel.Mode.MARKDOWN;
    private String executableOutput = "output";
    private String markdownOutput = "output/docs";
    private final Deque<HistoryState> undoHistory = new ArrayDeque<HistoryState>();
    private final Deque<HistoryState> redoHistory = new ArrayDeque<HistoryState>();
    private final JLabel spaceMode = new JLabel("");
    private HistoryState historyCurrent;
    private final EnumMap<ToolWindow.DockPosition, List<ToolWindow>> docked = new EnumMap(ToolWindow.DockPosition.class);
    private final EnumMap<ToolWindow.DockPosition, Integer> dockOrientation = new EnumMap(ToolWindow.DockPosition.class);
    private final Map<ToolWindow, Integer> tabGroup = new HashMap<ToolWindow, Integer>();
    private int tabGroupSequence = 1;
    private JPanel dockRoot;
    private JComponent editor;
    private ToolWindow inspectorTool;
    private ToolWindow changeTool;
    private ToolWindow queueTool;
    private ToolWindow fileBrowserTool;
    private local.codenode.ui.FileBrowserPanel fileBrowserPanel;
    private local.codenode.ui.FileChangePanel fileChangePanel;
    private local.codenode.ui.ProjectRunPanel projectRunPanel;
    private local.codenode.ui.FloatingOutputOverlay floatingOutput;
    private JTabbedPane inspectorTabs;
    private JTabbedPane workbenchTabs;
    private JScrollPane inspectorScroll;
    private static final int HEADER = 34;

    public MainFrame() {
        super("CodeNode Desktop — 本地节点制作台");
        this.loadRecentProjects();
        for (ToolWindow.DockPosition position : ToolWindow.DockPosition.values()) {
            this.docked.put(position, new ArrayList());
        }
        this.dockOrientation.put(ToolWindow.DockPosition.LEFT, 0);
        this.dockOrientation.put(ToolWindow.DockPosition.RIGHT, 1);
        this.dockOrientation.put(ToolWindow.DockPosition.TOP, 1);
        this.dockOrientation.put(ToolWindow.DockPosition.BOTTOM, 1);
        this.setDefaultCloseOperation(0);
        this.addWindowListener(new WindowAdapter(){

            @Override
            public void windowClosing(WindowEvent e) {
                MainFrame.this.closeApplication();
            }
        });
        this.setMinimumSize(new Dimension(760, 500));
        this.setJMenuBar(this.menuBar());
        this.setLayout(new BorderLayout());
        try {
            this.agentConfig.createDefaultsIfMissing();
        }
        catch (Exception exception) {
            // empty catch block
        }
        this.agentToolContext = new AgentToolContext(() -> this.currentProjectFile != null ? this.currentProjectFile.getParent() : Path.of(this.project.getText(), new String[0]), () -> this.model, this::confirmAgentTool, entry -> SwingUtilities.invokeLater(() -> this.append("[Agent 工具] " + entry)), generated -> SwingUtilities.invokeLater(() -> {
            try {
                this.saveInspector();
                this.model.replaceFrom(generated);
                this.canvas.repaint();
                this.commitHistory();
                this.status.setText("  Agent 已写入工作台  |  节点=" + this.model.nodes().size());
                this.append("[Agent] scan_project 已将结构化节点图写入工作台，节点=" + this.model.nodes().size());
            }
            catch (Exception e) {
                this.append("[Agent] 写入工作台失败：" + e.getMessage());
            }
        }), mutator -> {
            try {
                SwingUtilities.invokeAndWait(() -> {
                    mutator.mutate(this.model);
                    this.canvas.repaint();
                    this.commitHistory();
                });
            }
            catch (Exception e) {
                SwingUtilities.invokeLater(() -> this.append("[Agent] 工作台变更失败：" + e.getMessage()));
            }
        }, () -> SwingUtilities.invokeLater(this::saveProject), () -> SwingUtilities.invokeLater(this::undo), () -> SwingUtilities.invokeLater(this::redo), this::agentUiAction);
        this.agentToolContext.setSoftwareInfoProvider(this);
        this.agentToolContext.setQuestionHandler((question, options) -> {
            String[] result = new String[]{""};
            try {
                SwingUtilities.invokeAndWait(() -> {
                    Object choice;
                    result[0] = options == null || options.isEmpty() ? JOptionPane.showInputDialog(this, question, "Agent 询问", 3) : ((choice = JOptionPane.showInputDialog(this, question, "Agent 询问", 3, null, options.toArray(), options.get(0))) == null ? "" : String.valueOf(choice));
                });
            }
            catch (Exception exception) {
                // empty catch block
            }
            return result[0];
        });
        this.agentTools = AgentToolkit.buildDefaultRegistry(this.agentToolContext, this.agentConfig);
        this.agentChatController = new AgentChatController(this.agentConfig, this.agentTools, this.agentToolContext);
        this.agentToolContext.setFileChangeNotifier((relative, kind, detail) -> SwingUtilities.invokeLater(() -> {
            if (this.fileChangePanel != null) {
                this.fileChangePanel.recordChange(relative, kind, detail);
            }
        }));
        this.add((Component)this.toolbar(), "North");
        this.add((Component)this.workbench(), "Center");
        this.add((Component)this.statusBar(), "South");
        this.canvas.onSelection(this::loadInspector);
        this.canvas.onFeedback(message -> {
            this.status.setText("  " + message);
            this.append((String)message);
        });
        this.canvas.onChange(this::commitHistory);
        this.portModel.onChange(this::commitHistory);
        this.canvas.setLanguageSupplier(() -> String.valueOf(this.language.getSelectedItem()));
        this.mode.addActionListener(e -> this.updateMode());
        this.language.addActionListener(e -> {
            if (!this.loadingProject) {
                this.markDirty();
                this.status.setText("  " + String.valueOf(this.mode.getSelectedItem()) + "  |  " + String.valueOf(this.language.getSelectedItem()));
            }
        });
        this.watch(this.nodeName);
        this.watch(this.prompt);
        this.watch(this.artifact);
        this.watch(this.output);
        this.watch(this.nodeColor);
        this.watch(this.bundleData);
        this.rangeMode.addActionListener(e -> {
            if (!(this.loadingProject || this.loadingInspector || this.projectReadOnly)) {
                this.markDirty();
            }
        });
        this.assetTypeCombo.addActionListener(e -> {
            if (!(this.loadingProject || this.loadingInspector || this.projectReadOnly)) {
                this.markDirty();
            }
        });
        this.initializeProject(false);
        if (this.currentDocument() == null && this.currentProjectFile == null) {
            this.syncProjectPanels(null);
        }
        this.updateMode();
        this.nodeControlApi = new NodeControlApi(this.model, () -> this.currentProjectFile != null ? this.currentProjectFile.getParent() : Path.of(this.project.getText(), new String[0]), this.canvas::selected, ids -> this.canvas.selectNodes(ids.stream().map(this.model::byId).toList()), this.canvas::repaint, this::saveProject, this::undo, this::redo);
        this.installGlobalKeys();
        this.resetHistory();
        UiTheme.apply(this.getJMenuBar());
        UiTheme.apply(this.getContentPane());
        this.getContentPane().setBackground(UiTheme.BACKGROUND);
        if (this.codeReviewPanel != null) {
            this.codeReviewPanel.fixupTheme();
        }
        this.resultPollTimer = new Timer(1800, e -> this.pollResults());
        this.resultPollTimer.start();
        this.autoSaveTimer = new Timer(900000, e -> this.autoSave());
        this.autoSaveTimer.setInitialDelay(900000);
        this.autoSaveTimer.start();
        this.dirty = false;
        this.refreshDocumentTitle();
        this.setSize(1500, 900);
        this.setLocationRelativeTo(null);
        SwingUtilities.invokeLater(() -> this.inspectorScroll.getViewport().setViewPosition(new Point(0, 0)));
    }

    private JMenuBar menuBar() {
        JMenuBar bar = new JMenuBar();
        bar.setBorder(BorderFactory.createMatteBorder(0, 0, 1, 0, UiTheme.BORDER));
        JMenu file = this.menu("文件(F)", this.item("新建工程", this::newProject), this.item("打开 .cnode…", this::openProject), this.item("保存", this::saveProject), this.item("另存为…", this::saveProjectAs));
        file.addSeparator();
        file.add(this.item("选择申请项目目录…", this::chooseProject));
        file.addSeparator();
        file.add(this.item("退出", this::closeApplication));
        JMenu edit = this.menu("编辑(E)", this.item("应用节点修改", this::saveInspector));
        JMenu view = this.menu("视图(V)", this.item("显示文件浏览器", () -> this.fileBrowserTool.redock()), this.item("显示节点资源管理器", () -> this.inspectorTool.redock()), this.item("显示文件变更", () -> this.changeTool.redock()), this.item("切换到代码审查", () -> {
            if (this.workbenchTabs != null) {
                this.workbenchTabs.setSelectedIndex(1);
            }
        }), this.item("切换到内嵌 Agent", () -> {
            if (this.workbenchTabs != null) {
                this.workbenchTabs.setSelectedIndex(2);
            }
        }), this.item("显示申请队列", () -> this.queueTool.redock()));
        JMenu projectMenu = this.menu("项目(P)", this.item("初始化本地申请槽", () -> this.initializeProject(true)), this.item("工程运行", this::openProjectRun));
        JMenu analysisMenu = this.menu("分析项目(A)", this.item("全量扫描（目录层级）", this::fullScanProject), this.item("项目全量解析（按包归组）", this::analyzeProjectFull), this.item("分析项目结构（申请提交）", this::analyzeProject), this.item("识别并构建当前工程", () -> {
            if (this.projectRunPanel != null) this.projectRunPanel.setProjectPath(this.currentProjectRoot());
        }));
        JMenu build = this.menu("生成(B)", this.item("打开输出请求", this::focusSubmissionControls), this.item("提交当前选择", this::submitSelected));
        JMenu debug = this.menu("调试(D)", new JMenuItem[0]);
        JMenu tools = this.menu("工具(T)", this.item("刷新结果", this::pollResults));
        JMenu help = this.menu("帮助(H)", new JMenuItem[0]);
        for (JMenu menu : new JMenu[]{file, edit, view, projectMenu, analysisMenu, build, debug, tools, help}) {
            bar.add(menu);
        }
        return bar;
    }

    private JComponent toolbar() {
        JPanel toolbar = new UiTheme.ResponsiveWrapPanel(FlowLayout.LEFT, 8, 6);
        toolbar.setBackground(UiTheme.TOOLBAR);
        toolbar.setBorder(new EmptyBorder(7, 12, 7, 12));
        toolbar.setMinimumSize(new Dimension(0, 0));
        JButton choose = this.button("打开项目", this::chooseProject);
        JButton recent = new JButton("最近打开");
        JButton init = this.button("初始化", () -> this.initializeProject(true));
        recent.addActionListener(e -> this.showRecentProjects(recent));
        JButton add = this.button("＋ 添加节点", this::addNode);
        JButton analyzeProjectBtn = this.button("分析项目结构", this::analyzeProject);
        this.analysisBtn = this.button("项目全量解析", this::analyzeProjectFull);
        this.analysisBtn.setEnabled(false);
        JButton fullScanBtn = this.button("全量扫描", this::fullScanProject);
        JButton runProjectBtn = this.button("工程构建运行", () -> {
            if (this.projectRunPanel != null) this.projectRunPanel.setProjectPath(this.currentProjectRoot());
            this.openProjectRun();
        });
        this.project.setMinimumSize(new Dimension(120, 30));
        this.project.setPreferredSize(new Dimension(220, 30));
        toolbar.add(new JLabel("项目"));
        toolbar.add(this.project);
        toolbar.add(choose);
        toolbar.add(recent);
        toolbar.add(init);
        toolbar.add(MainFrame.separator());
        toolbar.add(new JLabel("模式"));
        toolbar.add(this.mode);
        toolbar.add(new JLabel("语言"));
        toolbar.add(this.language);
        toolbar.add(new JLabel("Agent"));
        toolbar.add(this.agentProvider);
        toolbar.add(MainFrame.separator());
        toolbar.add(add);
        toolbar.add(analyzeProjectBtn);
        toolbar.add(this.analysisBtn);
        toolbar.add(fullScanBtn);
        toolbar.add(runProjectBtn);
        return toolbar;
    }

    private JComponent workbench() {
        JScrollPane canvasScroll = new JScrollPane(this.canvas);
        canvasScroll.getHorizontalScrollBar().setUnitIncrement(20);
        canvasScroll.getVerticalScrollBar().setUnitIncrement(20);
        JPanel canvasPanel = new JPanel(new BorderLayout());
        canvasPanel.add((Component)this.documentTabs(), "North");
        javax.swing.JLayeredPane canvasLayer = new javax.swing.JLayeredPane() {
            @Override public void doLayout() {
                for (Component child : getComponents()) child.setBounds(0, 0, getWidth(), getHeight());
            }
        };
        canvasLayer.setMinimumSize(new Dimension(0, 0));
        canvasLayer.add(canvasScroll, javax.swing.JLayeredPane.DEFAULT_LAYER);
        this.floatingOutput = new local.codenode.ui.FloatingOutputOverlay();
        canvasLayer.add(this.floatingOutput, javax.swing.JLayeredPane.PALETTE_LAYER);
        canvasPanel.add(canvasLayer, "Center");
        this.workbenchTabs = new JTabbedPane();
        this.workbenchTabs.addTab("节点图", canvasPanel);
        this.workbenchTabs.addTab("代码审查", this.reviewPanel());
        this.agentChatPanel = new AgentChatPanel(this.agentChatController, this.agentConfig, this::openAgentSettings);
        this.workbenchTabs.addTab("内嵌 Agent", this.agentChatPanel);
        UiTheme.apply(this.workbenchTabs);
        this.editor = this.workbenchTabs;
        this.editor.setMinimumSize(new Dimension(260, 220));
        this.dockRoot = new JPanel(new BorderLayout());
        this.fileBrowserPanel = new local.codenode.ui.FileBrowserPanel((file, text) -> this.openFileFromBrowser(file, text));
        this.fileBrowserTool = new ToolWindow(this, "文件浏览器", this.fileBrowserPanel, collapsed -> this.rebuildDockLayout(), position -> this.dock(this.fileBrowserTool, (ToolWindow.DockRequest)position), () -> this.toggleDockOrientation(this.fileBrowserTool));
        this.inspectorTool = new ToolWindow(this, "节点资源管理器", this.inspector(), collapsed -> this.rebuildDockLayout(), position -> this.dock(this.inspectorTool, (ToolWindow.DockRequest)position), () -> this.toggleDockOrientation(this.inspectorTool));
        this.fileChangePanel = new local.codenode.ui.FileChangePanel(() -> this.currentProjectRoot() != null && !this.currentProjectRoot().isBlank() ? Path.of(this.currentProjectRoot()) : Path.of("."));
        this.changeTool = new ToolWindow(this, "文件变更", this.fileChangePanel, collapsed -> this.rebuildDockLayout(), position -> this.dock(this.changeTool, (ToolWindow.DockRequest)position), () -> this.toggleDockOrientation(this.changeTool));
        this.queueTool = new ToolWindow(this, "申请队列", this.queuePanel(), collapsed -> this.rebuildDockLayout(), position -> this.dock(this.queueTool, (ToolWindow.DockRequest)position), () -> this.toggleDockOrientation(this.queueTool));
        int rightTabs = this.tabGroupSequence++;
        for (ToolWindow tool : List.of(this.inspectorTool, this.changeTool, this.queueTool)) {
            this.tabGroup.put(tool, rightTabs);
        }
        this.fileBrowserTool.setMinimumSize(new Dimension(180, 180));
        this.inspectorTool.setMinimumSize(new Dimension(300, 220));
        this.changeTool.setMinimumSize(new Dimension(260, 180));
        this.queueTool.setMinimumSize(new Dimension(260, 180));
        this.docked.get((Object)ToolWindow.DockPosition.LEFT).add(this.fileBrowserTool);
        this.docked.get((Object)ToolWindow.DockPosition.RIGHT).add(this.inspectorTool);
        this.docked.get((Object)ToolWindow.DockPosition.RIGHT).addAll(List.of(this.changeTool, this.queueTool));
        this.canvas.onFileDropped((file, point) -> this.dropFileToCanvas(file, point));
        this.rebuildDockLayout();
        return this.dockRoot;
    }

    private void dock(ToolWindow tool, ToolWindow.DockRequest request) {
        for (List<ToolWindow> tools : this.docked.values()) {
            tools.remove(tool);
        }
        if (request.mergeWith() != null) {
            ToolWindow target = request.mergeWith();
            ToolWindow.DockPosition position = this.positionOf(target);
            if (position == null) {
                return;
            }
            this.docked.get((Object)position).add(tool);
            this.tabGroup.put(tool, this.tabGroup.get(target));
        } else {
            this.docked.get((Object)request.position()).add(tool);
            this.tabGroup.put(tool, this.tabGroupSequence++);
        }
        this.rebuildDockLayout();
    }

    private ToolWindow.DockPosition positionOf(ToolWindow tool) {
        for (ToolWindow.DockPosition position : ToolWindow.DockPosition.values()) {
            if (!this.docked.get((Object)position).contains(tool)) continue;
            return position;
        }
        return null;
    }

    private void toggleDockOrientation(ToolWindow tool) {
        for (ToolWindow.DockPosition position : ToolWindow.DockPosition.values()) {
            if (!this.docked.get((Object)position).contains(tool)) continue;
            int current = this.dockOrientation.get((Object)position);
            this.dockOrientation.put(position, current == 1 ? 0 : 1);
            this.rebuildDockLayout();
            return;
        }
    }

    private void rebuildDockLayout() {
        if (this.dockRoot == null || this.editor == null) {
            return;
        }
        JComponent layout = this.editor;
        for (ToolWindow.DockPosition position : new ToolWindow.DockPosition[]{ToolWindow.DockPosition.LEFT, ToolWindow.DockPosition.RIGHT, ToolWindow.DockPosition.TOP, ToolWindow.DockPosition.BOTTOM}) {
            JComponent group = this.dockGroup(position);
            if (group == null) continue;
            layout = this.attachDock(layout, group, position);
        }
        this.dockRoot.removeAll();
        this.dockRoot.add((Component)layout, "Center");
        JComponent rail = this.collapsedRail();
        if (rail != null) {
            this.dockRoot.add((Component)rail, "East");
        }
        this.dockRoot.revalidate();
        this.dockRoot.repaint();
    }

    private JComponent dockGroup(ToolWindow.DockPosition position) {
        List<ToolWindow> all = this.docked.get((Object)position);
        int orientation = this.dockOrientation.get((Object)position);
        for (ToolWindow toolWindow : all) {
            toolWindow.setArrangementHorizontal(orientation == 1);
        }
        LinkedHashMap<Integer, List> groups = new LinkedHashMap<Integer, List>();
        for (ToolWindow tool : all) {
            if (tool.isCollapsed()) continue;
            groups.computeIfAbsent(this.tabGroup.get(tool), key -> new ArrayList()).add(tool);
        }
        List<JComponent> list = groups.values().stream().map(this::tabSlot).toList();
        if (list.isEmpty()) {
            return null;
        }
        if (list.size() == 1) {
            return list.getFirst();
        }
        JComponent group = list.getFirst();
        for (int i = 1; i < list.size(); ++i) {
            JComponent first = group;
            JComponent second = list.get(i);
            JSplitPane split = new JSplitPane(orientation, first, second);
            UiTheme.styleSplit(split);
            // 两侧弹性可调：拖动分隔线即可缩放左右任一窗口
            split.setDividerSize(8);
            split.setOneTouchExpandable(true);
            final double proportion = i / (double) (i + 1);
            split.setResizeWeight(proportion);
            SwingUtilities.invokeLater(() -> {
                int extent = split.getOrientation() == JSplitPane.HORIZONTAL_SPLIT ? split.getWidth() : split.getHeight();
                int fallback = split.getOrientation() == JSplitPane.HORIZONTAL_SPLIT ? 600 : 420;
                split.setDividerLocation((int) Math.round(Math.max(1, extent > 0 ? extent : fallback) * proportion));
            });
            group = split;
        }
        return group;
    }

    private JComponent tabSlot(List<ToolWindow> tools) {
        if (tools.size() == 1) {
            return tools.getFirst();
        }
        JTabbedPane tabs = new JTabbedPane();
        tabs.setTabLayoutPolicy(1);
        for (ToolWindow tool : tools) {
            tabs.addTab(tool.title(), tool);
        }
        UiTheme.apply(tabs);
        return tabs;
    }

    private JComponent attachDock(JComponent center, JComponent tool, ToolWindow.DockPosition position) {
        boolean horizontal = position == ToolWindow.DockPosition.LEFT || position == ToolWindow.DockPosition.RIGHT;
        boolean leading = position == ToolWindow.DockPosition.LEFT || position == ToolWindow.DockPosition.TOP;
        JSplitPane split = new JSplitPane(horizontal ? JSplitPane.HORIZONTAL_SPLIT : JSplitPane.VERTICAL_SPLIT,
                leading ? tool : center, leading ? center : tool);
        UiTheme.styleSplit(split);
        split.setDividerSize(8);
        split.setOneTouchExpandable(true);
        // Side tools keep a legible working width; the canvas absorbs resize first.
        split.setResizeWeight(leading ? 0.0 : 1.0);
        SwingUtilities.invokeLater(() -> this.setInitialDockExtent(split, position));
        split.addComponentListener(new java.awt.event.ComponentAdapter() {
            @Override public void componentResized(java.awt.event.ComponentEvent event) {
                MainFrame.this.enforceDockMinimum(split, position);
            }
        });
        return split;
    }

    private void setInitialDockExtent(JSplitPane split, ToolWindow.DockPosition position) {
        int total = split.getOrientation() == JSplitPane.HORIZONTAL_SPLIT ? split.getWidth() : split.getHeight();
        if (total <= 0) return;
        int desired = preferredDockExtent(position, total);
        boolean leading = position == ToolWindow.DockPosition.LEFT || position == ToolWindow.DockPosition.TOP;
        int location = leading ? desired : total - desired - split.getDividerSize();
        split.setDividerLocation(Math.max(0, location));
    }

    private void enforceDockMinimum(JSplitPane split, ToolWindow.DockPosition position) {
        int total = split.getOrientation() == JSplitPane.HORIZONTAL_SPLIT ? split.getWidth() : split.getHeight();
        if (total <= 0) return;
        boolean leading = position == ToolWindow.DockPosition.LEFT || position == ToolWindow.DockPosition.TOP;
        int current = leading ? split.getDividerLocation()
                : total - split.getDividerLocation() - split.getDividerSize();
        int minimum = minimumDockExtent(position, total);
        int centerMinimum = split.getOrientation() == JSplitPane.HORIZONTAL_SPLIT ? 260 : 180;
        int allowed = Math.max(0, total - centerMinimum - split.getDividerSize());
        int target = Math.min(preferredDockExtent(position, total), allowed);
        if (current < minimum && target >= minimum) {
            int location = leading ? target : total - target - split.getDividerSize();
            split.setDividerLocation(Math.max(0, location));
        }
    }

    private static int minimumDockExtent(ToolWindow.DockPosition position, int total) {
        if (position == ToolWindow.DockPosition.RIGHT) return total < 900 ? 270 : 300;
        if (position == ToolWindow.DockPosition.LEFT) return total < 900 ? 175 : 200;
        return total < 650 ? 160 : 200;
    }

    private static int preferredDockExtent(ToolWindow.DockPosition position, int total) {
        return switch (position) {
            case RIGHT -> total >= 1400 ? 390 : total >= 1100 ? 350 : total >= 900 ? 315 : Math.max(270, total - 490);
            case LEFT -> total >= 1300 ? 250 : total >= 950 ? 220 : 180;
            case TOP, BOTTOM -> Math.max(190, Math.min(300, total / 3));
        };
    }

    private JComponent collapsedRail() {
        List<ToolWindow> collapsed = this.docked.values().stream().flatMap(Collection::stream).filter(ToolWindow::isCollapsed).toList();
        if (collapsed.isEmpty()) {
            return null;
        }
        JPanel rail = new JPanel();
        rail.setLayout(new BoxLayout(rail, 1));
        rail.setBorder(BorderFactory.createMatteBorder(0, 1, 0, 0, UiTheme.BORDER));
        for (final ToolWindow tool : collapsed) {
            JButton button = new JButton(tool.title().substring(0, 1));
            button.setToolTipText(tool.title());
            button.setPreferredSize(new Dimension(30, 34));
            button.setMaximumSize(new Dimension(30, 34));
            button.setMargin(new Insets(1, 1, 1, 1));
            MouseAdapter action = new MouseAdapter(){
                Point start;
                boolean dragged;

                @Override
                public void mousePressed(MouseEvent e) {
                    this.start = e.getPoint();
                    this.dragged = false;
                }

                @Override
                public void mouseDragged(MouseEvent e) {
                    if (!this.dragged && this.start != null && this.start.distance(e.getPoint()) > 8.0) {
                        this.dragged = true;
                        tool.floatWindow();
                    }
                }

                @Override
                public void mouseReleased(MouseEvent e) {
                    if (!this.dragged) {
                        tool.redock();
                    }
                }
            };
            button.addMouseListener(action);
            button.addMouseMotionListener(action);
            rail.add(button);
        }
        UiTheme.apply(rail);
        for (Component child : rail.getComponents()) {
            if (!(child instanceof JButton)) continue;
            JButton button = (JButton)child;
            button.setBorder(BorderFactory.createLineBorder(UiTheme.BORDER));
            button.setBackground(UiTheme.TOOLBAR);
            button.setForeground(UiTheme.TEXT);
        }
        return rail;
    }

    private JComponent documentTabs() {
        this.documentTabs.setTabLayoutPolicy(JTabbedPane.SCROLL_TAB_LAYOUT);
        this.documentTabs.setBackground(UiTheme.PANEL);
        this.documentTabs.setForeground(UiTheme.TEXT);
        this.documentTabs.addChangeListener(e -> this.onDocumentTabChanged());
        return this.documentTabs;
    }

    /** 切换文档 tab：把对应文档模型换入主 model（快照换入）。 */
    private void onDocumentTabChanged() {
        int index = this.documentTabs.getSelectedIndex();
        if (index < 0 || index >= this.documents.size()) {
            return;
        }
        DocumentSession session = this.documents.get(index);
        if (session.model == this.model) {
            return;
        }
        this.loadingProject = true;
        try {
            this.model.replaceFrom(session.model);
            this.canvas.setView(session.panX, session.panY, session.zoom);
            this.canvas.select(null);
            this.canvas.repaint();
            this.currentProjectFile = session.file;
            this.documentId = session.documentId;
            this.documentCreatedAt = session.createdAt;
            this.projectReadOnly = session.readOnly;
            this.dirty = session.dirty;
            this.executableOutput = session.executableOutput;
            this.markdownOutput = session.markdownOutput;
            this.displayedMode = session.mode;
            this.mode.setSelectedItem((Object)session.mode);
            this.output.setText(session.mode == WorkflowModel.Mode.EXECUTABLE ? session.executableOutput : session.markdownOutput);
            this.loadInspector(null);
            this.refreshDocumentTitle();
            this.status.setText("  已切换文档  |  " + (session.file == null ? "未命名" : session.file.getFileName()));
            this.canvas.repaint();
        } finally {
            this.loadingProject = false;
        }
        this.syncProjectPanels(session.file == null ? null : session.file.getParent());
    }

    /** 当前文档会话。 */
    private DocumentSession currentDocument() {
        int index = this.documentTabs.getSelectedIndex();
        if (index >= 0 && index < this.documents.size()) {
            return this.documents.get(index);
        }
        return null;
    }

    private JComponent inspector() {
        JPanel panel = new JPanel(new BorderLayout());
        panel.setMinimumSize(new Dimension(280, 240));
        panel.setPreferredSize(new Dimension(340, 620));

        JPanel requestBar = new JPanel(new BorderLayout(6, 4));
        requestBar.setBorder(new EmptyBorder(8, 9, 8, 9));
        JLabel requestLabel = new JLabel("输出请求");
        requestLabel.setForeground(UiTheme.MUTED);
        requestBar.add(requestLabel, BorderLayout.NORTH);
        this.submissionTarget.setToolTipText("选择当前节点或有效组输出作为请求目标");
        this.submissionTarget.setMinimumSize(new Dimension(120, 30));
        this.submissionTarget.addPopupMenuListener(new javax.swing.event.PopupMenuListener() {
            @Override public void popupMenuWillBecomeVisible(javax.swing.event.PopupMenuEvent e) { refreshSubmissionTargets(); }
            @Override public void popupMenuWillBecomeInvisible(javax.swing.event.PopupMenuEvent e) {}
            @Override public void popupMenuCanceled(javax.swing.event.PopupMenuEvent e) {}
        });
        requestBar.add(this.submissionTarget, BorderLayout.CENTER);
        this.submitRequestButton.addActionListener(e -> this.submitSubmissionChoice());
        requestBar.add(this.submitRequestButton, BorderLayout.EAST);

        this.inspectorTabs = new JTabbedPane();
        this.inspectorTabs.setTabLayoutPolicy(JTabbedPane.SCROLL_TAB_LAYOUT);
        this.inspectorTabs.addTab("节点", this.nodeInspector());
        this.projectRunPanel = new local.codenode.ui.ProjectRunPanel(this::append);
        JScrollPane runScroll = new JScrollPane(this.projectRunPanel);
        runScroll.setHorizontalScrollBarPolicy(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
        runScroll.setBorder(null);
        runScroll.getVerticalScrollBar().setUnitIncrement(24);
        this.inspectorTabs.addTab("工程运行", runScroll);
        panel.add(requestBar, BorderLayout.NORTH);
        panel.add(this.inspectorTabs, BorderLayout.CENTER);
        this.refreshSubmissionTargets();
        return panel;
    }

    private void refreshSubmissionTargets() {
        SubmissionChoice previous = (SubmissionChoice)this.submissionTarget.getSelectedItem();
        this.submissionTarget.removeAllItems();
        WorkflowModel.Mode currentMode = (WorkflowModel.Mode)this.mode.getSelectedItem();
        boolean virtualOnly = currentMode == WorkflowModel.Mode.MARKDOWN
                && this.model.nodes().stream().noneMatch(n -> n.nodeKind == WorkflowModel.NodeKind.FILE);
        WorkflowModel.Node selected = this.canvas.selected();
        if (!virtualOnly && selected != null && selected.nodeKind != WorkflowModel.NodeKind.GROUP_OUTPUT) {
            this.submissionTarget.addItem(new SubmissionChoice("当前节点 · " + selected.name, "", true));
        }
        for (WorkflowModel.Node group : this.model.groupOutputs()) {
            if (!this.model.isValidGroupOutput(group)) continue;
            int count = this.model.upstreamOf(group).size();
            this.submissionTarget.addItem(new SubmissionChoice("组输出 · " + group.name + "  (" + count + ")", group.id, false));
        }
        if (previous != null) {
            for (int i = 0; i < this.submissionTarget.getItemCount(); i++) {
                SubmissionChoice item = this.submissionTarget.getItemAt(i);
                if (item.nodeId().equals(previous.nodeId()) && item.selectedNode() == previous.selectedNode()) {
                    this.submissionTarget.setSelectedIndex(i);
                    break;
                }
            }
        }
        boolean available = this.submissionTarget.getItemCount() > 0;
        this.submissionTarget.setEnabled(available);
        this.submitRequestButton.setEnabled(available);
        if (!available) this.submissionTarget.setToolTipText(virtualOnly ? "虚拟文件空间需要有效组输出" : "请选择节点或连接有效组输出");
    }

    private void submitSubmissionChoice() {
        SubmissionChoice choice = (SubmissionChoice)this.submissionTarget.getSelectedItem();
        if (choice == null) return;
        if (choice.selectedNode()) {
            this.submitSelected();
        } else {
            WorkflowModel.Node group = this.model.byId(choice.nodeId());
            if (group != null) this.submitGroup(group);
        }
        this.refreshSubmissionTargets();
    }

    private void focusSubmissionControls() {
        this.inspectorTool.redock();
        if (this.inspectorTabs != null) this.inspectorTabs.setSelectedIndex(0);
        this.refreshSubmissionTargets();
        SwingUtilities.invokeLater(() -> this.submissionTarget.requestFocusInWindow());
    }

    private void openProjectRun() {
        this.inspectorTool.redock();
        if (this.projectRunPanel != null) this.projectRunPanel.setProjectPath(this.currentProjectRoot());
        if (this.inspectorTabs != null) this.inspectorTabs.setSelectedIndex(1);
    }

    private JComponent nodeInspector() {
        JPanel outer = new JPanel(new BorderLayout());
        outer.setMinimumSize(new Dimension(0, 0));
        JPanel body = new UiTheme.VerticalScrollPanel();
        body.setLayout(new BoxLayout(body, 1));
        body.setBorder(new EmptyBorder(6, 9, 8, 9));
        this.nodePath.setForeground(UiTheme.MUTED);
        this.nodePath.setBorder(new EmptyBorder(0, 0, 5, 0));
        this.nodePath.setAlignmentX(0.0f);
        body.add(this.nodePath);
        body.add(MainFrame.label("名称"));
        body.add(MainFrame.fixedField(this.nodeName));
        body.add(Box.createVerticalStrut(5));
        body.add(MainFrame.label("Prompt / 文档职责"));
        this.prompt.setLineWrap(true);
        this.prompt.setWrapStyleWord(true);
        JScrollPane promptScroll = new JScrollPane(this.prompt);
        promptScroll.setMaximumSize(new Dimension(Integer.MAX_VALUE, 110));
        promptScroll.setAlignmentX(0.0f);
        body.add(promptScroll);
        body.add(Box.createVerticalStrut(5));
        body.add(MainFrame.label("产物相对路径"));
        body.add(MainFrame.fixedField(this.artifact));
        body.add(Box.createVerticalStrut(5));
        body.add(MainFrame.label("所属文件节点（Markdown 共享代码槽）"));
        this.fileOwner.setMaximumSize(new Dimension(Integer.MAX_VALUE, 28));
        this.fileOwner.setAlignmentX(0.0f);
        body.add(this.fileOwner);
        body.add(Box.createVerticalStrut(5));
        body.add(MainFrame.label("所属范围节点"));
        this.parentScope.setMaximumSize(new Dimension(Integer.MAX_VALUE, 28));
        this.parentScope.setAlignmentX(0.0f);
        body.add(this.parentScope);
        body.add(Box.createVerticalStrut(5));
        body.add(MainFrame.label("条件 / 计算运算"));
        this.operation.setMaximumSize(new Dimension(Integer.MAX_VALUE, 28));
        this.operation.setAlignmentX(0.0f);
        body.add(this.operation);
        body.add(Box.createVerticalStrut(5));
        body.add(MainFrame.label("节点颜色 (空=默认, #RRGGBB 格式)"));
        this.nodeColor.setMaximumSize(new Dimension(Integer.MAX_VALUE, 28));
        this.nodeColor.setAlignmentX(0.0f);
        body.add(this.nodeColor);
        body.add(Box.createVerticalStrut(5));
        this.rangeMode.setAlignmentX(0.0f);
        body.add(this.rangeMode);
        body.add(Box.createVerticalStrut(5));
        body.add(MainFrame.label("资产类型"));
        this.assetTypeCombo.setMaximumSize(new Dimension(Integer.MAX_VALUE, 28));
        this.assetTypeCombo.setAlignmentX(0.0f);
        for (String type : NodeRegistry.allAssetTypes()) {
            this.assetTypeCombo.addItem(type);
        }
        body.add(this.assetTypeCombo);
        body.add(Box.createVerticalStrut(5));
        body.add(MainFrame.label("资源组数据 (JSON 格式)"));
        this.bundleData.setLineWrap(true);
        this.bundleData.setWrapStyleWord(true);
        JScrollPane bundleScroll = new JScrollPane(this.bundleData);
        bundleScroll.setMaximumSize(new Dimension(Integer.MAX_VALUE, 55));
        bundleScroll.setAlignmentX(0.0f);
        body.add(bundleScroll);
        body.add(Box.createVerticalStrut(4));
        this.expandBundleBtn.setAlignmentX(0.0f);
        this.expandBundleBtn.addActionListener(e -> this.expandBundle());
        body.add(this.expandBundleBtn);
        body.add(Box.createVerticalStrut(5));
        JButton analyzeBtn = new JButton("分析文件内容");
        analyzeBtn.setAlignmentX(0.0f);
        analyzeBtn.addActionListener(e -> this.analyzeFileContent());
        body.add(analyzeBtn);
        body.add(Box.createVerticalStrut(5));
        JButton expandFileBtn = new JButton("展开为范围节点");
        expandFileBtn.setAlignmentX(0.0f);
        expandFileBtn.addActionListener(e -> this.expandFileToRange());
        body.add(expandFileBtn);
        body.add(Box.createVerticalStrut(5));
        JButton indexFileBtn = new JButton("索引本地文件");
        indexFileBtn.setAlignmentX(0.0f);
        indexFileBtn.addActionListener(e -> this.indexLocalFile());
        body.add(indexFileBtn);
        body.add(Box.createVerticalStrut(5));
        JButton virtualPathBtn = new JButton("新建相对路径");
        virtualPathBtn.setAlignmentX(0.0f);
        virtualPathBtn.addActionListener(e -> this.createVirtualFileNode());
        body.add(virtualPathBtn);
        body.add(Box.createVerticalStrut(5));
        this.assetPreview.setAlignmentX(0.0f);
        this.assetPreview.setMinimumSize(new Dimension(0, 100));
        this.assetPreview.setPreferredSize(new Dimension(240, 145));
        this.assetPreview.setMaximumSize(new Dimension(Integer.MAX_VALUE, 160));
        this.assetPreview.setHorizontalAlignment(0);
        this.assetPreview.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createMatteBorder(1, 1, 1, 1, UiTheme.BORDER), new EmptyBorder(4, 4, 4, 4)));
        this.assetPreview.setOpaque(true);
        this.assetPreview.setBackground(UiTheme.PANEL);
        this.assetPreview.setForeground(UiTheme.MUTED);
        body.add(this.assetPreview);
        body.add(Box.createVerticalStrut(5));
        body.add(MainFrame.label("输入 / 输出端口"));
        this.portTable.setRowHeight(22);
        this.portTable.setFillsViewportHeight(true);
        this.portTable.getColumnModel().getColumn(0).setPreferredWidth(42);
        this.portTable.getColumnModel().getColumn(3).setPreferredWidth(38);
        this.portTable.getColumnModel().getColumn(2).setCellEditor(new PortTypeEditor());
        JScrollPane portScroll = new JScrollPane(this.portTable);
        portScroll.setMinimumSize(new Dimension(100, 70));
        portScroll.setMaximumSize(new Dimension(Integer.MAX_VALUE, 110));
        portScroll.setAlignmentX(0.0f);
        body.add(portScroll);
        JPanel portButtons = new JPanel(new FlowLayout(0, 4, 3));
        portButtons.setAlignmentX(0.0f);
        portButtons.setMinimumSize(new Dimension(100, 32));
        portButtons.setMaximumSize(new Dimension(Integer.MAX_VALUE, 32));
        portButtons.add(this.button("＋输入", () -> this.addPort(false)));
        portButtons.add(this.button("＋输出", () -> this.addPort(true)));
        portButtons.add(this.button("删除端口", this::removePort));
        body.add(portButtons);
        body.add(MainFrame.label("申请输出目录"));
        body.add(MainFrame.fixedField(this.output));
        body.add(Box.createVerticalStrut(8));
        JButton apply = this.button("应用节点修改", this::saveInspector);
        apply.setAlignmentX(0.0f);
        body.add(apply);
        JButton ungroup = this.button("解开组", this::ungroupNode);
        ungroup.setAlignmentX(0.0f);
        body.add(ungroup);
        body.add(Box.createVerticalGlue());
        JTextArea hint = new JTextArea("连线：输出端口和输入端口都可以向外拖；整理点可拖到输入端口建立分支，Alt+左键拖动整理点可移动。\n失败结果会标红节点，并在画布右侧短暂显示文件、行与列。");
        hint.setEditable(false);
        hint.setLineWrap(true);
        hint.setWrapStyleWord(true);
        hint.setOpaque(false);
        hint.setForeground(UiTheme.MUTED);
        hint.setAlignmentX(0.0f);
        body.add(hint);
        this.inspectorScroll = new JScrollPane(body);
        this.inspectorScroll.setHorizontalScrollBarPolicy(31);
        this.inspectorScroll.setBorder(null);
        this.inspectorScroll.getVerticalScrollBar().setUnitIncrement(24);
        for (JScrollPane inner : List.of(promptScroll, portScroll, bundleScroll)) {
            inner.setWheelScrollingEnabled(false);
            inner.addMouseWheelListener(e -> {
                JScrollBar bar = this.inspectorScroll.getVerticalScrollBar();
                int step = 24;
                bar.setValue(bar.getValue() + (e.getWheelRotation() < 0 ? -step : step));
                e.consume();
            });
        }
        outer.add((Component)this.inspectorScroll, "Center");
        return outer;
    }

    private JComponent reviewPanel() {
        this.codeReviewPanel = new CodeReviewPanel(this::acceptDraft, this::rejectDraft, this::rollbackCode, this::refreshReview);
        return this.codeReviewPanel;
    }

    private JComponent queuePanel() {
        JPanel panel = new JPanel(new BorderLayout());
        JPanel actions = new JPanel(new FlowLayout(0, 5, 4));
        actions.add(this.button("刷新队列", this::refreshQueue));
        actions.add(this.button("取消申请", this::cancelRequest));
        actions.add(new JLabel("本地申请槽实时状态"));
        panel.add((Component)actions, "North");
        panel.add((Component)new JScrollPane(this.queueList), "Center");
        panel.setPreferredSize(new Dimension(320, 190));
        return panel;
    }

    private JComponent statusBar() {
        JPanel bar = new JPanel(new BorderLayout());
        bar.setBackground(UiTheme.TOOLBAR);
        bar.setBorder(new EmptyBorder(6, 12, 6, 12));
        this.status.setForeground(UiTheme.TEXT);
        bar.add((Component)this.status, "West");
        JLabel queueState = new JLabel("本地文件队列  |  UTF-8  |  Java 21");
        queueState.setForeground(UiTheme.MUTED);
        JPanel eastPanel = new JPanel(new FlowLayout(FlowLayout.RIGHT, 10, 0));
        eastPanel.setOpaque(false);
        this.progressBar.setPreferredSize(new Dimension(180, 14));
        this.progressBar.setStringPainted(true);
        this.progressBar.setVisible(false);
        eastPanel.add(this.progressBar);
        this.spaceMode.setForeground(UiTheme.ACCENT);
        eastPanel.add(this.spaceMode);
        eastPanel.add(queueState);
        bar.add((Component)eastPanel, "East");
        bar.addComponentListener(new java.awt.event.ComponentAdapter() {
            @Override public void componentResized(java.awt.event.ComponentEvent event) {
                int width = bar.getWidth();
                queueState.setVisible(width >= 900);
                spaceMode.setVisible(width >= 720);
                progressBar.setPreferredSize(new Dimension(width >= 1050 ? 180 : 120, 14));
                eastPanel.revalidate();
            }
        });
        return bar;
    }

    private void showProgress(boolean visible, boolean indeterminate, String message) {
        this.progressBar.setVisible(visible);
        this.progressBar.setIndeterminate(indeterminate);
        if (message != null && !message.isBlank()) {
            this.status.setText("  " + message);
        }
        if (!visible) {
            this.progressBar.setValue(0);
        }
    }

    private static JPanel emptyPanel(String text) {
        JPanel p = new JPanel(new BorderLayout());
        JLabel l = new JLabel("  " + text);
        l.setForeground(UiTheme.MUTED);
        p.add((Component)l, "North");
        return p;
    }

    private static JSeparator separator() {
        JSeparator s = new JSeparator(1);
        s.setPreferredSize(new Dimension(8, 25));
        s.setForeground(UiTheme.BORDER);
        return s;
    }

    private static JComponent fixedField(JTextField field) {
        field.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));
        field.setAlignmentX(0.0f);
        return field;
    }

    private static JLabel label(String text) {
        JLabel label = new JLabel(text);
        label.setAlignmentX(0.0f);
        label.setForeground(UiTheme.TEXT);
        label.setBorder(new EmptyBorder(0, 0, 4, 0));
        return label;
    }

    private JButton button(String text, Runnable action) {
        JButton button = new JButton(text);
        button.addActionListener(e -> action.run());
        return button;
    }

    private JMenuItem item(String text, Runnable action) {
        JMenuItem item = new JMenuItem(text);
        item.addActionListener(e -> action.run());
        return item;
    }

    private JMenu menu(String title, JMenuItem ... items) {
        JMenu menu = new JMenu(title);
        for (JMenuItem item : items) {
            menu.add(item);
        }
        return menu;
    }

    private void addNode() {
        if (this.projectReadOnly) {
            return;
        }
        WorkflowModel.Node node = this.model.addNode(120 + this.model.nodes().size() * 35, 120 + this.model.nodes().size() * 25);
        this.canvas.select(node);
        this.commitHistory();
        this.canvas.repaint();
    }

    private void newProject() {
        this.newDocumentTab();
    }

    private void openProject() {
        JFileChooser chooser = this.projectChooser(false);
        if (chooser.showOpenDialog(this) == 0) {
            this.openProject(chooser.getSelectedFile().toPath());
        }
    }

    @Override public Map<String, Object> softwareInfo() {
        LinkedHashMap<String, Object> info = new LinkedHashMap<>();
        info.put("version", "CodeNode Desktop 0.16"); info.put("formatVersion", "cnode 1.1");
        info.put("mode", String.valueOf(mode.getSelectedItem())); info.put("language", String.valueOf(language.getSelectedItem()));
        info.put("projectRoot", currentProjectRoot().toString()); info.put("projectName", projectName());
        info.put("openDocuments", documents.size()); info.put("currentDocument", currentProjectFile == null ? "" : currentProjectFile.getFileName().toString());
        info.put("canvasNodes", model.nodes().size()); info.put("canvasEdges", model.edges().size());
        info.put("groups", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP).count());
        info.put("assetBundles", model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE).count());
        info.put("selectedNodes", canvas.selected() == null ? 0 : 1); info.put("toolCount", agentTools == null ? 0 : agentTools.listTools().size());
        info.put("uiActions", List.of("view_all","focus","zoom","pan","resize","toggle_panel","switch_tab","open_document","close_document","save_document","dock_panel","run_config","build_project","run_project","stop_run","select_node","open_menu","read_ui_state"));
        return info;
    }
    @Override public Map<String, Object> environmentInfo() {
        LinkedHashMap<String, Object> info = new LinkedHashMap<>();
        info.put("jdk", System.getProperty("java.version")); info.put("gradle", "tool directory"); info.put("maven", "wrapper"); return info;
    }
    public NodeControlApi nodeControlApi() {
        return this.nodeControlApi;
    }

    void openProject(Path file) {
        try {
            CnodeProjectCodec.Loaded loaded = this.projectCodec.load(file);
            Path root = file.toAbsolutePath().normalize().getParent();
            Optional<Path> checkpoint = this.recovery.newerCheckpoint(root, loaded.metadata().documentId(), file);
            if (checkpoint.isPresent() && JOptionPane.showConfirmDialog(this, "发现比正式工程更新的 15 分钟自动保存快照，是否恢复？", "CodeNode 恢复", 0) == 0) {
                loaded = this.projectCodec.load(checkpoint.get());
            }
            this.applyLoaded(loaded, file.toAbsolutePath().normalize());
            try { this.projectCodec.loadAgentContext(file).ifPresent(this.agentChatController::restoreContext); } catch (Exception ignored) { }
            this.append("已打开工程：" + String.valueOf(file));
        }
        catch (Exception e) {
            this.error(e);
        }
    }

    private void applyLoaded(CnodeProjectCodec.Loaded loaded, Path file) {
        CnodeProjectCodec.Metadata metadata = loaded.metadata();
        CnodeProjectCodec.Settings settings = metadata.settings();
        // 若该文件已在某 tab 打开，切到它
        for (int i = 0; i < this.documents.size(); i++) {
            DocumentSession s = this.documents.get(i);
            if (s.file != null && s.file.equals(file.toAbsolutePath().normalize())) {
                this.documentTabs.setSelectedIndex(i);
                this.switchToDocument(i);
                return;
            }
        }
        DocumentSession session = new DocumentSession();
        session.model = loaded.model().deepCopy();
        session.file = file.toAbsolutePath().normalize();
        session.documentId = metadata.documentId();
        session.createdAt = metadata.createdAt();
        session.readOnly = loaded.readOnly();
        session.executableOutput = settings.executablePath();
        session.markdownOutput = settings.markdownPath();
        session.mode = settings.mode();
        session.panX = settings.panX();
        session.panY = settings.panY();
        session.zoom = settings.zoom();
        this.documents.add(session);
        int index = this.documents.size() - 1;
        String tabTitle = file.getFileName() == null ? "工程" : file.getFileName().toString();
        this.documentTabs.addTab(tabTitle, null);
        installTabCloseButton(index);
        this.documentTabs.setSelectedIndex(index);
        this.switchToDocument(index);
        this.canvas.selectNodes(settings.selectedNodeIds().stream().map(this.model::byId).toList());
        this.syncProjectLocation(file);
        this.rememberRecent(file);
        this.dirty = false;
        this.resetHistory();
        this.refreshDocumentTitle();
        this.status.setText((String)(this.projectReadOnly ? "  使用更高格式版本，只读打开" : "  已加载  |  " + String.valueOf(file)));
        this.canvas.repaint();
    }

    private void agentUiAction(String action, Map<String, Object> arguments) {
        try {
            switch (action) {
                case "view_all": {
                    this.canvas.frameAll();
                    break;
                }
                case "focus": {
                    String nodeId = String.valueOf(arguments.getOrDefault("nodeId", ""));
                    this.canvas.focusNode(this.model.byId(nodeId));
                    break;
                }
                case "zoom": {
                    double d;
                    Object object = arguments.get("zoom");
                    if (object instanceof Number) {
                        Number number = (Number)object;
                        d = number.doubleValue();
                    } else {
                        d = 1.0;
                    }
                    double next = d;
                    this.canvas.setView(this.canvas.panX(), this.canvas.panY(), next);
                    break;
                }
                case "pan": {
                    int n;
                    int n2;
                    Object number = arguments.get("x");
                    if (number instanceof Number) {
                        Number number2 = (Number)number;
                        n2 = number2.intValue();
                    } else {
                        n2 = 0;
                    }
                    int x = n2;
                    Object object = arguments.get("y");
                    if (object instanceof Number) {
                        number = (Number)object;
                        n = ((Number)number).intValue();
                    } else {
                        n = 0;
                    }
                    int y = n;
                    this.canvas.setView(x, y, this.canvas.zoom());
                    break;
                }
                case "resize": {
                    int n;
                    int n3;
                    Object number = arguments.get("width");
                    if (number instanceof Number) {
                        Number number3 = (Number)number;
                        n3 = number3.intValue();
                    } else {
                        n3 = this.getWidth();
                    }
                    int width = n3;
                    Object object = arguments.get("height");
                    if (object instanceof Number) {
                        number = (Number)object;
                        n = ((Number)number).intValue();
                    } else {
                        n = this.getHeight();
                    }
                    int height = n;
                    this.setSize(Math.max(640, width), Math.max(420, height));
                    break;
                }
                case "toggle_panel": {
                    this.toggleAgentPanel(String.valueOf(arguments.getOrDefault("panel", "")));
                    break;
                }
                case "new_content": {
                    String name;
                    int n;
                    int n4;
                    Object number = arguments.get("x");
                    if (number instanceof Number) {
                        Number number4 = (Number)number;
                        n4 = number4.intValue();
                    } else {
                        n4 = 200;
                    }
                    int x = n4;
                    Object object = arguments.get("y");
                    if (object instanceof Number) {
                        number = (Number)object;
                        n = ((Number)number).intValue();
                    } else {
                        n = 200;
                    }
                    int y = n;
                    this.model.addNode((int)x, (int)y).name = name = String.valueOf(arguments.getOrDefault("name", "新内容"));
                    this.canvas.repaint();
                    this.commitHistory();
                    this.append("[Agent] 已新建内容节点：" + name);
                    break;
                }
                                case "switch_tab": {
                    int index = arguments.get("index") instanceof Number n ? n.intValue() : -1;
                    if (index < 0) { String tab = String.valueOf(arguments.getOrDefault("tab", "")); index = tab.equals("code") ? 1 : tab.equals("agent") ? 2 : 0; }
                    if (workbenchTabs != null && index >= 0 && index < workbenchTabs.getTabCount()) workbenchTabs.setSelectedIndex(index);
                    break;
                }
                case "open_document": { Object path = arguments.get("path"); if (path == null || String.valueOf(path).isBlank()) openProject(); else openProject(Path.of(String.valueOf(path))); break; }
                case "close_document": { closeDocument(documentTabs.getSelectedIndex()); break; }
                case "save_document": { saveProject(); break; }
                case "select_node": { String id = String.valueOf(arguments.getOrDefault("nodeId", "")); WorkflowModel.Node selected = model.byId(id); if (selected != null) canvas.select(selected); break; }
                case "read_ui_state": { append("[Agent UI] tab=" + (workbenchTabs == null ? -1 : workbenchTabs.getSelectedIndex()) + " size=" + getWidth() + "x" + getHeight()); break; }
                case "open_menu": { append("[Agent] 菜单动作已请求：" + arguments.getOrDefault("menu", "")); break; }
                case "dock_panel": { toggleAgentPanel(String.valueOf(arguments.getOrDefault("panel", ""))); break; }
                case "run_config", "build_project", "run_project", "stop_run": { openProjectRun(); append("[Agent] 已打开工程运行：" + action); break; }                default: {
                    break;
                }
            }
        }
        catch (Exception e) {
            this.append("[Agent] 界面操控失败：" + e.getMessage());
        }
    }

    private void toggleAgentPanel(String panel) {
        ToolWindow target = switch (panel) {
            case "inspector" -> this.inspectorTool;
            case "output" -> this.inspectorTool;
            case "error", "changes", "files" -> this.changeTool;
            case "queue" -> this.queueTool;
            default -> null;
        };
        if (target == null) {
            this.append("[Agent] 未知面板：" + panel);
            return;
        }
        if (target.isCollapsed()) {
            target.redock();
        } else {
            target.setCollapsed(true);
        }
    }

    static boolean canSave(boolean hasActiveProject, boolean readOnly) {
        return hasActiveProject && !readOnly;
    }

    private boolean hasActiveProject() {
        return this.currentDocument() != null;
    }

    private void saveProject() {
        if (!canSave(this.hasActiveProject(), this.projectReadOnly)) {
            this.status.setText("  未创建或打开项目  |  请先新建或打开项目");
            this.append("保存不可用：请先创建或打开项目");
            return;
        }
        if (this.projectReadOnly) {
            this.error(new IllegalStateException("更高版本工程只能只读打开"));
            return;
        }
        if (this.currentProjectFile == null) {
            this.saveProjectAs();
            return;
        }
        this.saveProjectTo(this.currentProjectFile, true);
    }

    private void saveProjectAs() {
        if (!canSave(this.hasActiveProject(), this.projectReadOnly)) {
            this.status.setText("  未创建或打开项目  |  请先新建或打开项目");
            this.append("保存不可用：请先创建或打开项目");
            return;
        }
        if (this.projectReadOnly) {
            this.error(new IllegalStateException("更高版本工程不能另存为当前格式"));
            return;
        }
        JFileChooser chooser = this.projectChooser(true);
        if (chooser.showSaveDialog(this) != 0) {
            return;
        }
        Path target = chooser.getSelectedFile().toPath();
        if (!target.getFileName().toString().toLowerCase().endsWith(".cnode")) {
            target = target.resolveSibling(String.valueOf(target.getFileName()) + ".cnode");
        }
        this.saveProjectTo(target.toAbsolutePath().normalize(), true);
    }

    private void saveProjectTo(Path target, boolean clearRecovery) {
        try {
            target = target.toAbsolutePath().normalize();
            this.saveInspector();
            this.storeActiveOutput();
            this.projectCodec.save(target, this.model, this.metadata(this.projectName(target)), AgentContext.of(this.agentChatController.sessionId(), this.agentChatController.summary(), this.agentChatController.messageHistory()), this.agentChatController.infoSnapshot());
            this.currentProjectFile = target;
            this.syncProjectLocation(target);
            this.rememberRecent(target);
            if (clearRecovery) {
                this.recovery.clear(target.getParent(), this.documentId);
            }
            this.dirty = false;
            DocumentSession session = this.currentDocument();
            if (session != null) {
                session.file = target;
                session.dirty = false;
                session.executableOutput = this.executableOutput;
                session.markdownOutput = this.markdownOutput;
                session.mode = this.displayedMode;
                session.panX = this.canvas.panX();
                session.panY = this.canvas.panY();
                session.zoom = this.canvas.zoom();
            }
            this.refreshDocumentTitle();
            this.status.setText("  已保存  |  " + String.valueOf(target));
            this.append("工程已保存：" + String.valueOf(target));
        }
        catch (Exception e) {
            this.error(e);
        }
    }

    private void autoSave() {
        if (this.currentProjectFile == null || this.projectReadOnly || !this.dirty) {
            return;
        }
        try {
            this.saveInspector();
            this.storeActiveOutput();
            Path root = this.currentProjectFile.getParent();
            this.recovery.saveCheckpoint(root, this.model, this.metadata());
            this.projectCodec.save(this.currentProjectFile, this.model, this.metadata(), AgentContext.of(this.agentChatController.sessionId(), this.agentChatController.summary(), this.agentChatController.messageHistory()), this.agentChatController.infoSnapshot());
            this.recovery.clear(root, this.documentId);
            this.dirty = false;
            this.refreshDocumentTitle();
            this.status.setText("  已自动保存（15 分钟）  |  " + String.valueOf(this.currentProjectFile));
            this.append("15 分钟自动保存完成：" + String.valueOf(this.currentProjectFile));
        }
        catch (Exception e) {
            this.append("自动保存失败，已保留恢复快照：" + e.getMessage());
            this.status.setText("  自动保存失败");
        }
    }

    private CnodeProjectCodec.Metadata metadata() {
        return this.metadata(this.projectName());
    }

    private CnodeProjectCodec.Metadata metadata(String name) {
        return new CnodeProjectCodec.Metadata(this.documentId, name, this.documentCreatedAt, this.currentSettings());
    }

    private CnodeProjectCodec.Settings currentSettings() {
        WorkflowModel.Node selected = this.canvas.selected();
        return new CnodeProjectCodec.Settings((WorkflowModel.Mode)((Object)this.mode.getSelectedItem()), String.valueOf(this.language.getSelectedItem()), this.executableOutput, this.markdownOutput, selected == null ? null : selected.id, this.canvas.panX(), this.canvas.panY(), this.canvas.zoom(), selected == null ? null : selected.id, this.selectedNodeIds());
    }

    private List<String> selectedNodeIds() {
        ArrayList<String> ids = new ArrayList<String>(this.canvas.selectedNodes().stream().map(node -> node.id).toList());
        WorkflowModel.Node primary = this.canvas.selected();
        if (primary != null) {
            ids.remove(primary.id);
            ids.add(primary.id);
        }
        return List.copyOf(ids);
    }

    private String projectName() {
        if (this.currentProjectFile == null) {
            return "未命名";
        }
        String name = this.currentProjectFile.getFileName().toString();
        return name.toLowerCase().endsWith(".cnode") ? name.substring(0, name.length() - 6) : name;
    }

    private String projectName(Path file) {
        String name = file.getFileName().toString();
        return name.toLowerCase().endsWith(".cnode") ? name.substring(0, name.length() - 6) : name;
    }

    private void storeActiveOutput() {
        String value = this.output.getText().trim();
        if (this.displayedMode == WorkflowModel.Mode.EXECUTABLE) {
            this.executableOutput = value;
        } else {
            this.markdownOutput = value;
        }
    }

    private void setProjectEditable(boolean editable) {
        this.canvas.setEditable(editable);
        this.nodeName.setEditable(editable);
        this.prompt.setEditable(editable);
        this.artifact.setEditable(editable);
        this.fileOwner.setEnabled(editable);
        this.parentScope.setEnabled(editable);
        this.operation.setEnabled(editable);
        this.portTable.setEnabled(editable);
        this.output.setEditable(editable);
        this.mode.setEnabled(editable);
        this.language.setEnabled(editable);
        this.agentProvider.setEnabled(editable);
    }

    private JFileChooser projectChooser(boolean save) {
        Path start = this.currentProjectFile == null ? Path.of(this.project.getText(), new String[0]) : this.currentProjectFile.getParent();
        JFileChooser chooser = new JFileChooser(start.toFile());
        chooser.setFileSelectionMode(0);
        chooser.setFileFilter(new FileNameExtensionFilter("CodeNode 工程 (*.cnode)", "cnode"));
        if (save) {
            chooser.setSelectedFile(new File(this.currentProjectFile == null ? "未命名.cnode" : this.currentProjectFile.getFileName().toString()));
        }
        return chooser;
    }

    private void syncProjectLocation(Path file) {
        Path parent = file.toAbsolutePath().normalize().getParent();
        if (parent != null) {
            this.project.setText(parent.toString());
        }
        this.syncProjectPanels(parent);
    }

    /** 让文件浏览器与工程构建运行面板跟随当前项目根目录。 */
    private void syncProjectPanels(Path projectDir) {
        // null is an explicit blank state: never retain the previous project directory.
        if (projectDir == null) {
            if (this.fileBrowserPanel != null) this.fileBrowserPanel.setRoot(null);
            if (this.projectRunPanel != null) this.projectRunPanel.setProjectPathSilent("");
            if (this.agentChatPanel != null) this.agentChatPanel.setProjectPath("");
            return;
        }
        Path root = projectDir.toAbsolutePath().normalize();
        if (this.fileBrowserPanel != null) {
            this.fileBrowserPanel.setRoot(root);
        }
        if (this.projectRunPanel != null) {
            this.projectRunPanel.setProjectPathSilent(root.toString());
        }
        // Agent 工作环境随当前项目迁移（不再使用写死的默认路径）
        if (this.agentChatPanel != null) {
            this.agentChatPanel.setProjectPath(root.toString());
        }
    }

    private void loadRecentProjects() {
        String saved = this.preferences.get("recentProjects", "");
        if (saved.isBlank()) {
            return;
        }
        for (String value : saved.split("\\R")) {
            try {
                Path file = Path.of(value, new String[0]).toAbsolutePath().normalize();
                if (!Files.isRegularFile(file, new LinkOption[0]) || this.recentProjects.contains(file)) continue;
                this.recentProjects.add(file);
            }
            catch (InvalidPathException invalidPathException) {
                // empty catch block
            }
        }
        this.persistRecentProjects();
    }

    private void rememberRecent(Path file) {
        Path normalized = file.toAbsolutePath().normalize();
        this.recentProjects.remove(normalized);
        this.recentProjects.addFirst(normalized);
        while (this.recentProjects.size() > 10) {
            this.recentProjects.removeLast();
        }
        this.persistRecentProjects();
    }

    private void persistRecentProjects() {
        try {
            this.preferences.put("recentProjects", String.join((CharSequence)"\n", this.recentProjects.stream().map(Path::toString).toList()));
        }
        catch (RuntimeException runtimeException) {
            // empty catch block
        }
    }

    private void showRecentProjects(Component anchor) {
        this.recentProjects.removeIf(path -> !Files.isRegularFile(path, new LinkOption[0]));
        this.persistRecentProjects();
        JPopupMenu menu = new JPopupMenu();
        if (this.recentProjects.isEmpty()) {
            JMenuItem empty = new JMenuItem("暂无最近文件");
            empty.setEnabled(false);
            menu.add(empty);
        } else {
            for (Path path2 : List.copyOf(this.recentProjects)) {
                JMenuItem item = new JMenuItem(String.valueOf(path2.getFileName()) + "  —  " + String.valueOf(path2.getParent()));
                item.setToolTipText(path2.toString());
                item.addActionListener(e -> this.openProject(path2));
                menu.add(item);
            }
        }
        UiTheme.apply(menu);
        menu.show(anchor, 0, anchor.getHeight());
    }

    private void chooseProject() {
        JFileChooser chooser = new JFileChooser(this.project.getText());
        chooser.setFileSelectionMode(1);
        if (chooser.showOpenDialog(this) == 0) {
            this.project.setText(chooser.getSelectedFile().getAbsolutePath());
            this.initializeProject(true);
        }
    }

    private void initializeProject(boolean announce) {
        String rootText = this.project.getText() == null ? "" : this.project.getText().trim();
        if (rootText.isEmpty()) {
            // 空白状态：未选择项目，不创建申请槽、不加载目录树
            this.status.setText("  未选择项目  |  可从「项目」选择目录或新建工程");
            return;
        }
        try {
            this.queue = new QueueService(Path.of(rootText));
            this.results = new ResultService(this.queue.stateRoot());
            int restored = this.queue.restoreActiveStatuses(this.model);
            this.refreshQueue();
            if (this.fileBrowserPanel != null) {
                this.fileBrowserPanel.setRoot(this.queue.projectRoot());
            }
            if (this.projectRunPanel != null) {
                this.projectRunPanel.setProjectPathSilent(this.queue.projectRoot().toString());
            }
            this.status.setText("  就绪  |  " + String.valueOf(this.queue.projectRoot()));
            if (announce) {
                this.append("项目申请槽已初始化：" + String.valueOf(this.queue.stateRoot()));
            }
            if (restored > 0) {
                this.append("已从本地申请槽恢复 " + restored + " 个节点状态");
            }
        }
        catch (Exception e) {
            this.error(e);
        }
    }

    private String currentProjectRoot() {
        if (this.queue != null && this.queue.projectRoot() != null) {
            return this.queue.projectRoot().toString();
        }
        if (this.currentProjectFile != null && this.currentProjectFile.getParent() != null) {
            return this.currentProjectFile.getParent().toString();
        }
        return "";
    }
    private void updateMode() {
        WorkflowModel.Mode next;
        if (this.loadingProject) {
            return;
        }
        this.markDirty();
        this.storeActiveOutput();
        this.displayedMode = next = (WorkflowModel.Mode)((Object)this.mode.getSelectedItem());
        boolean code = next == WorkflowModel.Mode.EXECUTABLE;
        this.loadingProject = true;
        this.output.setText(code ? this.executableOutput : this.markdownOutput);
        this.loadingProject = false;
        this.language.setEnabled(!this.projectReadOnly);
        this.status.setText("  " + String.valueOf((Object)next) + "  |  就绪");
        this.updateSpaceModeLabel();
        this.canvas.repaint();
        if (this.analysisBtn != null) {
            this.analysisBtn.setEnabled(next == WorkflowModel.Mode.MARKDOWN);
        }
    }

    private void updateSpaceModeLabel() {
        WorkflowModel.Mode current = (WorkflowModel.Mode)((Object)this.mode.getSelectedItem());
        if (current != WorkflowModel.Mode.MARKDOWN) {
            this.spaceMode.setText("");
            return;
        }
        boolean hasFileNode = this.model.nodes().stream().anyMatch(n -> n.nodeKind == WorkflowModel.NodeKind.FILE);
        long fileCount = this.model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.FILE).count();
        this.spaceMode.setText((String)(hasFileNode ? "实体文件空间（" + fileCount + " 个文件空间）" : "虚拟文件空间"));
    }

    private void loadInspector(WorkflowModel.Node node) {
        this.loadingInspector = true;
        boolean enabled = node != null;
        this.nodeName.setEnabled(enabled);
        this.prompt.setEnabled(enabled);
        this.artifact.setEnabled(enabled);
        this.populateOwnerChoices(this.fileOwner, node, WorkflowModel.NodeKind.FILE, node == null ? "" : node.fileNodeId);
        this.populateOwnerChoices(this.parentScope, node, WorkflowModel.NodeKind.SCOPE, node == null ? "" : node.parentScopeId);
        this.operation.removeAllItems();
        if (node != null) {
            for (String value : NodeRegistry.operations(node)) {
                this.operation.addItem(value);
            }
        }
        if (node != null && !node.operation.isBlank()) {
            this.operation.setSelectedItem(node.operation);
        }
        this.fileOwner.setEnabled(enabled && !this.projectReadOnly && node.nodeKind != WorkflowModel.NodeKind.FILE);
        this.parentScope.setEnabled(enabled && !this.projectReadOnly);
        this.operation.setEnabled(enabled && !this.projectReadOnly && this.operation.getItemCount() > 0);
        this.portTable.setEnabled(enabled && !this.projectReadOnly);
        this.portModel.setNode(node);
        this.nodePath.setText((String)(node == null ? "工作流 / 未选择节点" : "工作流  ›  " + node.id));
        if (node == null) {
            this.nodeName.setText("");
            this.prompt.setText("");
            this.artifact.setText("");
            this.nodeColor.setText("");
            this.rangeMode.setSelected(false);
            this.assetTypeCombo.setSelectedItem("image");
            this.bundleData.setText("");
            this.assetPreview.setIcon(null);
        } else {
            this.nodeName.setText(node.name);
            this.prompt.setText(node.prompt);
            this.artifact.setText(node.artifact);
            this.nodeColor.setText(node.nodeColor);
            this.rangeMode.setSelected(node.rangeMode);
            this.rangeMode.setEnabled(enabled && !this.projectReadOnly && node.nodeKind == WorkflowModel.NodeKind.FILE);
            if (!node.assetType.isBlank() && MainFrame.containsItem(this.assetTypeCombo, node.assetType)) {
                this.assetTypeCombo.setSelectedItem(node.assetType);
            }
            this.assetTypeCombo.setEnabled(enabled && !this.projectReadOnly && (node.nodeKind == WorkflowModel.NodeKind.ASSET || node.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE));
            this.bundleData.setText(node.bundleData);
            this.bundleData.setEnabled(enabled && !this.projectReadOnly && node.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE);
            this.expandBundleBtn.setEnabled(enabled && !this.projectReadOnly && node.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE);
            this.updateAssetPreview(node);
            this.nodeColor.setEnabled(enabled && !this.projectReadOnly);
        }
        this.loadingInspector = false;
        this.refreshSubmissionTargets();
        this.refreshReview();
        if (this.inspectorScroll != null) {
            SwingUtilities.invokeLater(() -> this.inspectorScroll.getViewport().setViewPosition(new Point(0, 0)));
        }
    }

    private void populateOwnerChoices(JComboBox<NodeOwnerChoice> combo, WorkflowModel.Node selected, WorkflowModel.NodeKind kind, String currentId) {
        combo.removeAllItems();
        NodeOwnerChoice none = new NodeOwnerChoice("", "未指定");
        combo.addItem(none);
        NodeOwnerChoice chosen = none;
        for (WorkflowModel.Node candidate : this.model.nodes()) {
            if (candidate.nodeKind != kind || candidate == selected || kind == WorkflowModel.NodeKind.SCOPE && this.scopeAncestor(selected, candidate)) continue;
            NodeOwnerChoice choice = new NodeOwnerChoice(candidate.id, candidate.name + "  [" + candidate.id + "]");
            combo.addItem(choice);
            if (!candidate.id.equals(currentId)) continue;
            chosen = choice;
        }
        combo.setSelectedItem(chosen);
    }

    private boolean scopeAncestor(WorkflowModel.Node ancestor, WorkflowModel.Node candidate) {
        if (ancestor == null || ancestor.nodeKind != WorkflowModel.NodeKind.SCOPE) {
            return false;
        }
        HashSet<String> seen = new HashSet<String>();
        WorkflowModel.Node current = candidate;
        while (current != null && !current.parentScopeId.isBlank() && seen.add(current.id)) {
            if (current.parentScopeId.equals(ancestor.id)) {
                return true;
            }
            current = this.model.byId(current.parentScopeId);
        }
        return false;
    }

    private void addPort(boolean outputPort) {
        if (this.projectReadOnly) {
            return;
        }
        WorkflowModel.Node node = this.canvas.selected();
        if (node == null) {
            return;
        }
        this.model.addPort(node, outputPort);
        this.portModel.setNode(node);
        this.commitHistory();
        this.canvas.repaint();
    }

    private void removePort() {
        if (this.projectReadOnly) {
            return;
        }
        WorkflowModel.Node node = this.canvas.selected();
        int row = this.portTable.getSelectedRow();
        WorkflowModel.Port port = this.portModel.portAt(row);
        if (node == null || port == null) {
            return;
        }
        this.model.removePort(node, port, this.portModel.outputAt(row));
        this.portModel.setNode(node);
        this.commitHistory();
        this.canvas.repaint();
    }

    private void refreshReview() {
        WorkflowModel.Node node = this.canvas.selected();
        WorkflowModel.CodeSlot slot = this.selectedCodeSlot();
        if (this.codeReviewPanel != null) {
            this.codeReviewPanel.loadFrom(node, slot);
        }
    }

    private void saveInspector() {
        int removed;
        if (this.projectReadOnly) {
            return;
        }
        WorkflowModel.Node node = this.canvas.selected();
        if (node == null) {
            return;
        }
        String name = this.nodeName.getText().trim();
        String responsibility = this.prompt.getText().trim();
        String path = this.artifact.getText().trim();
        String fileId = node.nodeKind == WorkflowModel.NodeKind.FILE ? "" : MainFrame.ownerId(this.fileOwner);
        String scopeId = node.nodeKind == WorkflowModel.NodeKind.SCOPE ? "" : MainFrame.ownerId(this.parentScope);
        String nextOperation = this.operation.getSelectedItem() == null ? node.operation : String.valueOf(this.operation.getSelectedItem());
        String color = this.nodeColor.getText().trim();
        boolean wasRange = node.rangeMode;
        boolean nextRange = this.rangeMode.isSelected();
        boolean changed = !node.name.equals(name) || !Objects.toString(node.prompt, "").equals(responsibility) || !Objects.toString(node.artifact, "").equals(path) || !node.fileNodeId.equals(fileId) || !node.parentScopeId.equals(scopeId) || !node.operation.equals(nextOperation) || !node.nodeColor.equals(color) || node.rangeMode != nextRange || !node.assetType.equals(Objects.toString(this.assetTypeCombo.getSelectedItem(), node.assetType)) || !node.bundleData.equals(Objects.toString(this.bundleData.getText(), ""));
        node.name = name;
        node.prompt = responsibility;
        node.artifact = path;
        node.fileNodeId = fileId;
        node.parentScopeId = scopeId;
        node.nodeColor = color;
        node.assetType = Objects.toString(this.assetTypeCombo.getSelectedItem(), "");
        node.bundleData = Objects.toString(this.bundleData.getText(), "");
        if (node.nodeKind == WorkflowModel.NodeKind.FILE && wasRange != nextRange) {
            node.rangeMode = nextRange;
            if (wasRange && !nextRange) {
                List<WorkflowModel.Node> children = this.model.nodes().stream().filter(n -> n.fileNodeId.equals(node.id)).toList();
                for (WorkflowModel.Node child : children) {
                    child.fileNodeId = "";
                }
            }
        }
        if (!node.operation.equals(nextOperation) && !nextOperation.isBlank() && (removed = NodeRegistry.applyOperation(this.model, node, nextOperation)) > 0) {
            this.append("切换运算时移除了 " + removed + " 条不兼容连线");
        }
        if (changed) {
            this.commitHistory();
            this.append("已更新 " + node.id);
        }
        this.portModel.setNode(node);
        this.canvas.repaint();
    }

    private static String ownerId(JComboBox<NodeOwnerChoice> combo) {
        String string;
        Object selected = combo.getSelectedItem();
        if (selected instanceof NodeOwnerChoice) {
            NodeOwnerChoice choice = (NodeOwnerChoice)selected;
            string = choice.id();
        } else {
            string = "";
        }
        return string;
    }

    private void submitSelected() {
        Set<WorkflowModel.Node> nodes = this.canvas.selectedNodes();
        if (nodes.size() > 1) {
            this.submit(QueueService.SubmitTarget.multi(new ArrayList<WorkflowModel.Node>(nodes), this.canvas.selected()));
        } else {
            this.submit(QueueService.SubmitTarget.selected(this.canvas.selected()));
        }
    }

    private void submitGroup(WorkflowModel.Node outputNode) {
        this.submit(QueueService.SubmitTarget.group(outputNode));
    }

    private void analyzeProject() {
        JFileChooser chooser = new JFileChooser(this.project.getText());
        chooser.setFileSelectionMode(1);
        chooser.setDialogTitle("选择要分析的项目根目录");
        if (chooser.showOpenDialog(this) != 0) {
            return;
        }
        Path projectDir = chooser.getSelectedFile().toPath().toAbsolutePath().normalize();
        if (!Files.isDirectory(projectDir, new LinkOption[0])) {
            this.error(new IllegalArgumentException("选择的路径不是有效目录"));
            return;
        }
        Thread.startVirtualThread(() -> {
            try {
                List<ProjectAnalysisService.FileMeta> files;
                if (this.queue == null || !this.queue.projectRoot().equals(Path.of(this.project.getText(), new String[0]).toAbsolutePath().normalize())) {
                    this.initializeProject(false);
                }
                if ((files = ProjectAnalysisService.scanDirectory(projectDir)).isEmpty()) {
                    SwingUtilities.invokeLater(() -> this.append("项目分析：未在 " + String.valueOf(projectDir) + " 中发现受支持的源文件"));
                    return;
                }
                String stamp = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS").withZone(ZoneOffset.UTC).format(Instant.now());
                String requestId = "analysis-" + stamp;
                Path staging = this.queue.stateRoot().resolve("queue/staging").resolve(requestId);
                Path inbox = this.queue.stateRoot().resolve("queue/inbox").resolve(requestId);
                Map<String, Object> request = ProjectAnalysisService.buildAnalysisRequest(projectDir, this.queue.stateRoot(), files, requestId);
                Files.createDirectories(staging, new FileAttribute[0]);
                Files.writeString(staging.resolve("request.json"), (CharSequence)Json.stringify(request), StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
                StringBuilder requestMd = new StringBuilder("# 项目分析申请 " + requestId + "\n\n");
                requestMd.append("- 项目根目录: `").append(projectDir).append("`\n");
                requestMd.append("- 源文件总数: ").append(files.size()).append("\n");
                requestMd.append("- 模式: `analysis`\n");
                requestMd.append("- 操作: `analyze-project`\n\n");
                requestMd.append("## 目录结构\n\n```text\n");
                requestMd.append(ProjectAnalysisService.generateDirectoryTree(projectDir, files));
                requestMd.append("\n```\n\n## 文件清单\n\n");
                for (ProjectAnalysisService.FileMeta f : files) {
                    requestMd.append("- `").append(f.relativePath()).append("` (").append(f.language()).append(", ").append(f.lineCount()).append("行)\n");
                }
                Files.writeString(staging.resolve("request.md"), (CharSequence)requestMd.toString(), StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
                try {
                    Files.move(staging, inbox, StandardCopyOption.ATOMIC_MOVE);
                }
                catch (AtomicMoveNotSupportedException e) {
                    Files.move(staging, inbox, new CopyOption[0]);
                }
                SwingUtilities.invokeLater(() -> {
                    this.append("项目分析申请已提交: " + requestId + " | 目录: " + String.valueOf(projectDir) + " | 文件数: " + files.size());
                    this.refreshQueue();
                });
                Map<String, Object> result = ProjectAnalysisService.processAnalysis(inbox, this.queue.stateRoot().resolve("results"));
                SwingUtilities.invokeLater(() -> {
                    this.append("项目分析完成: " + requestId + " | " + String.valueOf(result.get("summary")));
                    this.pollResults();
                });
            }
            catch (Exception e) {
                SwingUtilities.invokeLater(() -> this.error(e));
            }
        });
    }

    private void fullScanProject() {
        Path projectDir;
        String rootText = this.project.getText().trim();
        if (rootText.isEmpty() || Path.of(rootText, new String[0]).equals(Path.of(System.getProperty("user.home"), new String[0]))) {
            JFileChooser chooser = new JFileChooser(rootText.isEmpty() ? System.getProperty("user.home") : rootText);
            chooser.setFileSelectionMode(1);
            chooser.setDialogTitle("选择要全量扫描的项目根目录");
            if (chooser.showOpenDialog(this) != 0) {
                return;
            }
            projectDir = chooser.getSelectedFile().toPath().toAbsolutePath().normalize();
            this.project.setText(projectDir.toString());
        } else {
            projectDir = Path.of(rootText, new String[0]).toAbsolutePath().normalize();
        }
        if (!Files.isDirectory(projectDir, new LinkOption[0])) {
            JOptionPane.showMessageDialog(this, "目录不存在: " + String.valueOf(projectDir), "全量扫描", 0);
            return;
        }
        this.append("[全量扫描] 开始按目录层级扫描: " + String.valueOf(projectDir));
        this.showProgress(true, true, "全量扫描中…  " + String.valueOf(projectDir));
        ScanDiagnostics diag = new ScanDiagnostics(projectDir, 90_000);
        diag.writeReport();
        diag.startWatchdog(() -> SwingUtilities.invokeLater(() -> {
            this.showProgress(false, false, "全量扫描疑似卡死（见诊断报告）");
            this.append("[诊断] 全量扫描疑似卡死在「" + diag.currentStage() + "」环节，已写入 "
                    + String.valueOf(projectDir.resolve(".codenode/full-scan-diag.log")));
        }));
        Thread.startVirtualThread(() -> {
            try {
                diag.begin("初始化项目队列");
                if (this.queue == null || !this.queue.projectRoot().equals(projectDir)) {
                    this.initializeProject(false);
                }
                diag.end("初始化项目队列");
                WorkflowModel result = new WorkflowModel();
                diag.begin("扫描目录并建图 (DirectoryGraphBuilder)");
                DirectoryGraphBuilder.build(result, projectDir, (stage, done, total) -> {
                    diag.heartbeat();
                    SwingUtilities.invokeLater(() -> {
                        if (total > 0) {
                            this.progressBar.setIndeterminate(false);
                            this.progressBar.setMaximum(Math.max(1, total));
                            this.progressBar.setValue(Math.min(total, done));
                        } else {
                            this.progressBar.setIndeterminate(true);
                        }
                        this.progressBar.setString(stage);
                        this.status.setText("  " + stage + "  " + (String)(total > 0 ? done + "/" + total : ""));
                    });
                });
                diag.end("扫描目录并建图 (DirectoryGraphBuilder)");
                diag.begin("嵌套组布局 (HierarchyLayout)");
                HierarchyLayout.layout(result);
                diag.end("嵌套组布局 (HierarchyLayout)");
                diag.begin("写入工作台 (replaceFrom)");
                final WorkflowModel finalResult = result;
                try {
                    SwingUtilities.invokeAndWait(() -> {
                        this.saveInspector();
                        this.storeActiveOutput();
                        this.model.replaceFrom(finalResult);
                        this.canvas.frameAll();
                        this.canvas.repaint();
                    });
                } catch (java.lang.reflect.InvocationTargetException ite) {
                    throw new RuntimeException("写入工作台失败: " + ite.getCause(), ite.getCause());
                }
                diag.end("写入工作台 (replaceFrom)");
                diag.begin("保存工程 (codec.save)");
                String stamp = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS").withZone(ZoneOffset.UTC).format(Instant.now());
                Path target = projectDir.resolve("全量扫描-" + stamp + ".cnode").toAbsolutePath().normalize();
                this.projectCodec.save(target, this.model, this.metadata("全量扫描"));
                diag.end("保存工程 (codec.save)");
                diag.begin("提交历史 (commitHistory)");
                try {
                    SwingUtilities.invokeAndWait(() -> this.commitHistory());
                } catch (java.lang.reflect.InvocationTargetException ite) {
                    throw new RuntimeException("提交历史失败: " + ite.getCause(), ite.getCause());
                }
                diag.end("提交历史 (commitHistory)");
                diag.writeReport();
                this.showProgress(false, false, "全量扫描完成  |  节点=" + this.model.nodes().size() + " 边=" + this.model.edges().size());
                this.append("[全量扫描完成] 节点=" + this.model.nodes().size() + " 边=" + this.model.edges().size() + " 已保存: " + String.valueOf(target)
                        + "\n[诊断报告] " + String.valueOf(projectDir.resolve(".codenode/full-scan-diag.log")));
            }
            catch (Exception e) {
                diag.end("失败");
                diag.writeReport();
                SwingUtilities.invokeLater(() -> {
                    this.showProgress(false, false, "  全量扫描失败");
                    this.error(e);
                });
            }
            finally {
                diag.stopWatchdog();
            }
        });
    }

    private void analyzeProjectFull() {
        String rootText = this.project.getText().trim();
        Path projectDir;
        if (rootText.isEmpty() || Path.of(rootText, new String[0]).equals(Path.of(System.getProperty("user.home"), new String[0]))) {
            JFileChooser chooser = new JFileChooser(rootText.isEmpty() ? System.getProperty("user.home") : rootText);
            chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
            chooser.setDialogTitle("选择要分析的项目根目录");
            if (chooser.showOpenDialog(this) != JFileChooser.APPROVE_OPTION) {
                return;
            }
            projectDir = chooser.getSelectedFile().toPath().toAbsolutePath().normalize();
            this.project.setText(projectDir.toString());
        } else {
            projectDir = Path.of(rootText, new String[0]).toAbsolutePath().normalize();
        }
        if (!Files.isDirectory(projectDir, new LinkOption[0])) {
            JOptionPane.showMessageDialog(this, "目录不存在: " + String.valueOf(projectDir), "项目全量解析", 0);
            return;
        }
        this.append("[项目全量解析] 开始按目录层级扫描: " + String.valueOf(projectDir));
        this.showProgress(true, true, "项目全量解析中…  " + String.valueOf(projectDir));
        ScanDiagnostics diag = new ScanDiagnostics(projectDir, 90_000);
        diag.writeReport();
        diag.startWatchdog(() -> SwingUtilities.invokeLater(() -> {
            this.showProgress(false, false, "项目全量解析疑似卡死（见诊断报告）");
            this.append("[诊断] 项目全量解析疑似卡死在「" + diag.currentStage() + "」环节，已写入 "
                    + String.valueOf(projectDir.resolve(".codenode/full-scan-diag.log")));
        }));
        Thread.startVirtualThread(() -> {
            try {
                diag.begin("初始化项目队列");
                if (this.queue == null || !this.queue.projectRoot().equals(projectDir)) {
                    this.initializeProject(false);
                }
                diag.end("初始化项目队列");
                WorkflowModel result = new WorkflowModel();
                diag.begin("扫描目录并建图 (DirectoryGraphBuilder)");
                DirectoryGraphBuilder.build(result, projectDir, (stage, done, total) -> {
                    diag.heartbeat();
                    SwingUtilities.invokeLater(() -> {
                        if (total > 0) {
                            this.progressBar.setIndeterminate(false);
                            this.progressBar.setMaximum(Math.max(1, total));
                            this.progressBar.setValue(Math.min(total, done));
                        } else {
                            this.progressBar.setIndeterminate(true);
                        }
                        this.progressBar.setString(stage);
                        this.status.setText("  " + stage + "  " + (String)(total > 0 ? done + "/" + total : ""));
                    });
                });
                diag.end("扫描目录并建图 (DirectoryGraphBuilder)");
                diag.begin("嵌套组布局 (HierarchyLayout)");
                HierarchyLayout.layout(result);
                diag.end("嵌套组布局 (HierarchyLayout)");
                diag.begin("写入工作台 (replaceFrom)");
                final WorkflowModel finalResult = result;
                try {
                    SwingUtilities.invokeAndWait(() -> {
                        this.saveInspector();
                        this.storeActiveOutput();
                        this.model.replaceFrom(finalResult);
                        this.canvas.frameAll();
                        this.canvas.repaint();
                    });
                } catch (java.lang.reflect.InvocationTargetException ite) {
                    throw new RuntimeException("写入工作台失败: " + ite.getCause(), ite.getCause());
                }
                diag.end("写入工作台 (replaceFrom)");
                diag.begin("提交历史 (commitHistory)");
                try {
                    SwingUtilities.invokeAndWait(() -> this.commitHistory());
                } catch (java.lang.reflect.InvocationTargetException ite) {
                    throw new RuntimeException("提交历史失败: " + ite.getCause(), ite.getCause());
                }
                diag.end("提交历史 (commitHistory)");
                diag.writeReport();
                this.showProgress(false, false, "全量解析完成  |  节点=" + this.model.nodes().size() + " 边=" + this.model.edges().size());
                this.append("[项目全量解析完成] 已在当前工作台生成节点图：节点=" + this.model.nodes().size()
                        + " 边=" + this.model.edges().size()
                        + "\n[诊断报告] " + String.valueOf(projectDir.resolve(".codenode/full-scan-diag.log")));
            }
            catch (Exception e) {
                diag.end("失败");
                diag.writeReport();
                SwingUtilities.invokeLater(() -> {
                    this.showProgress(false, false, "  全量解析失败");
                    this.error(e);
                });
            }
            finally {
                diag.stopWatchdog();
            }
        });
    }

    private void submit(QueueService.SubmitTarget target) {
        try {
            this.saveInspector();
            if (this.queue == null || !this.queue.projectRoot().equals(Path.of(this.project.getText(), new String[0]).toAbsolutePath().normalize())) {
                this.initializeProject(false);
            }
            QueueService.Submission submission = this.queue.submit(this.model, (WorkflowModel.Mode)((Object)this.mode.getSelectedItem()), target, String.valueOf(this.language.getSelectedItem()), this.output.getText());
            if ("Codex 自动".equals(this.agentProvider.getSelectedItem())) {
                this.startCodexAgent(submission);
            } else {
                Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(submission.codexPrompt()), null);
                this.append("已复制给 Codex 的手动处理指令：" + submission.codexPrompt());
            }
            this.refreshQueue();
            this.append("已提交 " + submission.requestId() + "\n位置：" + String.valueOf(submission.inboxPath()) + "\n目标代码槽：" + String.valueOf(submission.codeSlotIds()));
            this.status.setText("  已排队  |  " + submission.requestId());
            this.commitHistory();
            this.canvas.repaint();
            this.refreshReview();
        }
        catch (Exception e) {
            this.error(e);
        }
    }

    private void startCodexAgent(QueueService.Submission submission) throws IOException {
        Path processing = this.queue.beginProcessing(submission.requestId());
        try {
            this.codexAgent.start(this.queue.projectRoot(), processing, message -> SwingUtilities.invokeLater(() -> {
                this.append((String)message);
                this.refreshQueue();
                this.pollResults();
                this.canvas.repaint();
                this.refreshReview();
            }));
            for (String slotId : submission.codeSlotIds()) {
                for (WorkflowModel.Node owner : this.codeSlotService.owners(this.model, slotId)) {
                    owner.status = WorkflowModel.Status.PROCESSING;
                }
            }
            this.append("Codex Agent 已接收：" + submission.requestId());
        }
        catch (IOException | RuntimeException failure) {
            this.queue.returnToInbox(submission.requestId());
            throw failure;
        }
    }

    private void showSubmissionMenu(Component anchor) {
        boolean isMarkdownNoFile;
        JPopupMenu menu = new JPopupMenu();
        WorkflowModel.Mode currentMode = (WorkflowModel.Mode)((Object)this.mode.getSelectedItem());
        boolean bl = isMarkdownNoFile = currentMode == WorkflowModel.Mode.MARKDOWN && this.model.nodes().stream().noneMatch(n -> n.nodeKind == WorkflowModel.NodeKind.FILE);
        if (isMarkdownNoFile) {
            JMenuItem virtualHint = new JMenuItem("虚拟文件空间 — 仅支持组输出提交");
            virtualHint.setEnabled(false);
            menu.add(virtualHint);
            menu.addSeparator();
        } else {
            JMenuItem selectedItem = new JMenuItem("提交选择的节点到 Agent");
            selectedItem.setEnabled(this.canvas.selected() != null && this.canvas.selected().nodeKind != WorkflowModel.NodeKind.GROUP_OUTPUT);
            selectedItem.addActionListener(e -> this.submitSelected());
            menu.add(selectedItem);
            menu.addSeparator();
        }
        int index = 0;
        for (WorkflowModel.Node group : this.model.groupOutputs()) {
            if (!this.model.isValidGroupOutput(group)) continue;
            int count = this.model.upstreamOf(group).size();
            JMenuItem item = new JMenuItem("提交组输出 " + ++index + " 节点：" + group.name + "（包含 " + count + " 个节点）");
            item.addActionListener(e -> this.submitGroup(group));
            menu.add(item);
        }
        if (index == 0) {
            JMenuItem empty = new JMenuItem("没有可提交的组输出");
            empty.setEnabled(false);
            menu.add(empty);
        }
        UiTheme.apply(menu);
        Component target = anchor == null ? this.getJMenuBar() : anchor;
        menu.show(target, 0, target.getHeight());
    }

    private WorkflowModel.CodeSlot selectedCodeSlot() {
        WorkflowModel.Node node = this.canvas.selected();
        if (node == null) {
            return null;
        }
        String id = this.model.codeSlotId(node, (WorkflowModel.Mode)((Object)this.mode.getSelectedItem()));
        return id.isBlank() ? null : this.model.codeSlot(id);
    }

    private void acceptDraft() {
        try {
            WorkflowModel.CodeSlot slot = this.selectedCodeSlot();
            if (slot == null) {
                throw new IllegalStateException("当前节点没有代码槽");
            }
            if (this.codeReviewPanel != null && this.codeReviewPanel.isDraftModified()) {
                String editedCode = this.codeReviewPanel.getEditedDraftCode();
                if (slot.draft == null) {
                    slot.draft = new WorkflowModel.CodeDraft("manual", slot.activeRevision, editedCode, "foundation.object");
                } else {
                    slot.draft.code = editedCode;
                }
            }
            this.codeSlotService.accept(this.model, slot.id);
            this.commitHistory();
            if (this.codeReviewPanel != null) {
                this.codeReviewPanel.resetModifiedFlag();
            }
            this.refreshReview();
            this.canvas.repaint();
            this.append("已接受代码草稿：" + slot.id);
        }
        catch (Exception e) {
            this.error(e);
        }
    }

    private void rejectDraft() {
        try {
            WorkflowModel.CodeSlot slot = this.selectedCodeSlot();
            if (slot == null) {
                throw new IllegalStateException("当前节点没有代码槽");
            }
            this.codeSlotService.reject(this.model, slot.id);
            this.commitHistory();
            this.refreshReview();
            this.canvas.repaint();
            this.append("已拒绝代码草稿：" + slot.id);
        }
        catch (Exception e) {
            this.error(e);
        }
    }

    private void rollbackCode() {
        try {
            WorkflowModel.CodeSlot slot = this.selectedCodeSlot();
            if (slot == null) {
                throw new IllegalStateException("当前节点没有代码槽");
            }
            this.codeSlotService.rollback(this.model, slot.id);
            this.commitHistory();
            this.refreshReview();
            this.canvas.repaint();
            this.append("已回滚代码槽：" + slot.id);
        }
        catch (Exception e) {
            this.error(e);
        }
    }

    private void refreshQueue() {
        if (this.queue == null) {
            return;
        }
        try {
            this.queueItems.clear();
            for (QueueService.QueueEntry entry : this.queue.entries()) {
                this.queueItems.addElement(entry.toString());
            }
            if (this.queueItems.isEmpty()) {
                this.queueItems.addElement("当前没有申请");
            }
        }
        catch (IOException e) {
            this.queueItems.clear();
            this.queueItems.addElement("读取队列失败：" + e.getMessage());
        }
    }

    private void pollResults() {
        if (this.results == null) {
            return;
        }
        try {
            long before = this.model.revision();
            for (String string : this.results.poll(this.model)) {
                this.append(string);
            }
            if (this.model.revision() != before) {
                this.commitHistory();
            }
            this.refreshQueue();
            this.canvas.repaint();
            this.refreshReview();
            WorkflowModel.Node node = this.canvas.selected();
            if (node != null && node.status == WorkflowModel.Status.FAILED && !node.diagnostic.isBlank()) {
                String string = "错误定位 [" + node.id + "] " + node.diagnostic;
                this.append(string);
            }
        }
        catch (IOException | RuntimeException e) {
            this.append("读取结果失败：" + e.getMessage());
        }
    }

    private void cancelRequest() {
        if (this.queue == null || this.projectReadOnly) {
            return;
        }
        String selected = this.queueList.getSelectedValue();
        if (selected == null) {
            JOptionPane.showMessageDialog(this, "请先在队列中选中要取消的申请", "提示", 1);
            return;
        }
        String requestId = selected.split("\\s+")[0];
        try {
            this.queue.cancel(requestId);
            this.refreshQueue();
            this.model.clearStatuses();
            this.queue.restoreActiveStatuses(this.model);
            this.canvas.repaint();
            this.append("已取消申请：" + requestId);
        }
        catch (IOException e) {
            this.error(e);
        }
    }

    private void ungroupNode() {
        if (this.projectReadOnly) {
            return;
        }
        WorkflowModel.Node node = this.canvas.selected();
        if (node == null || node.nodeKind != WorkflowModel.NodeKind.GROUP) {
            JOptionPane.showMessageDialog(this, "请先选中一个组节点", "提示", 1);
            return;
        }
        int confirm = JOptionPane.showConfirmDialog(this, "确定要解开组「" + node.name + "」吗？组内子节点将移到上一层作用域。", "解开组", 2);
        if (confirm != 0) {
            return;
        }
        String parentId = node.parentScopeId;
        this.model.nodes().stream().filter(n -> n.parentScopeId.equals(node.id)).forEach(n -> {
            n.parentScopeId = parentId;
        });
        this.model.removeNode(node);
        this.commitHistory();
        this.canvas.repaint();
        this.loadInspector(null);
    }

    private void append(String message) {
        if (message == null || message.isBlank()) return;
        if (this.floatingOutput != null) this.floatingOutput.showMessage(message);
    }

    private void watch(JTextComponent component) {
        component.getDocument().addDocumentListener(new DocumentListener(){

            private void changed() {
                if (!(MainFrame.this.loadingProject || MainFrame.this.loadingInspector || MainFrame.this.projectReadOnly)) {
                    MainFrame.this.markDirty();
                }
            }

            @Override
            public void insertUpdate(DocumentEvent e) {
                this.changed();
            }

            @Override
            public void removeUpdate(DocumentEvent e) {
                this.changed();
            }

            @Override
            public void changedUpdate(DocumentEvent e) {
                this.changed();
            }
        });
    }

    private void markDirty() {
        if (this.loadingProject || this.loadingInspector || this.projectReadOnly) {
            return;
        }
        if (!this.dirty) {
            this.dirty = true;
            DocumentSession session = this.currentDocument();
            if (session != null) session.dirty = true;
            this.refreshDocumentTitle();
        }
    }

    private void installGlobalKeys() {
        this.bindGlobal("control S", this::saveProject);
        this.bindGlobal("control shift S", this::saveProjectAs);
        this.bindGlobal("control O", this::openProject);
        this.bindGlobal("control N", this::newProject);
        this.bindGlobal("control Z", this::undo);
        this.bindGlobal("control Y", this::redo);
        this.bindGlobal("control shift Z", this::redo);
    }

    private void bindGlobal(String key, final Runnable action) {
        String name = "global-" + key;
        this.getRootPane().getInputMap(2).put(KeyStroke.getKeyStroke(key), name);
        this.getRootPane().getActionMap().put(name, new AbstractAction(){

            @Override
            public void actionPerformed(ActionEvent e) {
                action.run();
            }
        });
    }

    private void resetHistory() {
        this.undoHistory.clear();
        this.redoHistory.clear();
        this.historyCurrent = this.captureHistory();
    }

    private void commitHistory() {
        if (this.loadingProject || this.projectReadOnly) {
            return;
        }
        this.model.refreshFileSpaces();
        if (this.historyCurrent != null) {
            this.undoHistory.addLast(this.historyCurrent);
            while (this.undoHistory.size() > 100) {
                this.undoHistory.removeFirst();
            }
        }
        this.redoHistory.clear();
        this.historyCurrent = this.captureHistory();
        this.markDirty();
        this.updateSpaceModeLabel();
    }

    private HistoryState captureHistory() {
        return new HistoryState(this.model.deepCopy(), this.selectedNodeIds(), this.canvas.panX(), this.canvas.panY(), this.canvas.zoom());
    }

    private void undo() {
        if (this.undoHistory.isEmpty() || this.projectReadOnly) {
            return;
        }
        this.redoHistory.addLast(this.captureHistory());
        HistoryState state = this.undoHistory.removeLast();
        this.restoreHistory(state);
        this.historyCurrent = this.captureHistory();
        this.markDirty();
    }

    private void redo() {
        if (this.redoHistory.isEmpty() || this.projectReadOnly) {
            return;
        }
        this.undoHistory.addLast(this.captureHistory());
        HistoryState state = this.redoHistory.removeLast();
        this.restoreHistory(state);
        this.historyCurrent = this.captureHistory();
        this.markDirty();
    }

    private void restoreHistory(HistoryState state) {
        this.loadingProject = true;
        this.model.replaceFrom(state.model());
        this.canvas.setView(state.panX(), state.panY(), state.zoom());
        this.canvas.selectNodes(state.selectedNodeIds().stream().map(this.model::byId).toList());
        this.loadingProject = false;
        this.canvas.repaint();
    }

    private void refreshDocumentTitle() {
        String name = this.currentProjectFile == null ? "未命名.cnode" : this.currentProjectFile.getFileName().toString();
        String marker = this.dirty ? " *" : "";
        String readonly = this.projectReadOnly ? " [只读]" : "";
        DocumentSession current = this.currentDocument();
        int index = this.documentTabs.getSelectedIndex();
        if (current != null && index >= 0) {
            String tabText = name + readonly + marker;
            this.documentTabs.setTitleAt(index, tabText);
            if (this.documentTabs.getTabComponentAt(index) instanceof JPanel comp) {
                for (java.awt.Component c : comp.getComponents()) {
                    if (c instanceof JLabel) ((JLabel) c).setText(tabText);
                }
            }
            current.dirty = this.dirty;
        }
        this.setTitle("CodeNode Desktop — " + name + readonly + marker);
    }

    private boolean confirmDiscardOrSave() {
        if (!this.dirty || this.projectReadOnly) {
            return true;
        }
        int choice = JOptionPane.showConfirmDialog(this, "当前工程有未保存修改。是否先保存？", "CodeNode", 1, 2);
        if (choice == 2 || choice == -1) {
            return false;
        }
        if (choice == 0) {
            this.saveProject();
            return !this.dirty;
        }
        return true;
    }

    private void closeApplication() {
        if (!this.confirmDiscardOrSave()) {
            return;
        }
        this.dispose();
        System.exit(0);
    }

    @Override
    public void dispose() {
        this.resultPollTimer.stop();
        this.autoSaveTimer.stop();
        this.codexAgent.close();
        for (ToolWindow tool : new ToolWindow[]{this.inspectorTool, this.changeTool, this.queueTool}) {
            if (tool == null) continue;
            tool.shutdown();
        }
        super.dispose();
    }

    private void openAgentSettings() {
        AgentSettingsPanel panel = new AgentSettingsPanel(this.agentConfig);
        JDialog dialog = new JDialog(this, "Agent 设置", true);
        dialog.setContentPane(panel);
        dialog.setSize(430, 330);
        dialog.setLocationRelativeTo(this);
        dialog.setVisible(true);
    }

    private void error(Exception e) {
        Throwable cause = e;
        while (cause.getCause() != null && cause.getCause() != cause) {
            cause = cause.getCause();
        }
        String message = cause.getMessage();
        if (message == null || message.isBlank()) {
            message = cause.getClass().getSimpleName() + (cause.getStackTrace().length > 0 ? " @ " + cause.getStackTrace()[0] : "");
        }
        JOptionPane.showMessageDialog(this, message, "CodeNode", 0);
        this.append("操作失败：" + message);
        this.status.setText("  操作失败");
    }

    private boolean confirmAgentTool(local.codenode.agent.tools.AgentToolContext.ConfirmationLevel level, String what, String detail) {
        // 低/中风险：项目内常规操作直接放行，不打扰用户（记录审计）
        if (level == local.codenode.agent.tools.AgentToolContext.ConfirmationLevel.LOW
                || level == local.codenode.agent.tools.AgentToolContext.ConfirmationLevel.WRITE) {
            this.append("[Agent] " + what);
            return true;
        }
        // 高风险：用自然语言解释 Agent 想做什么，而非代码字符串
        StringBuilder message = new StringBuilder();
        message.append("Agent 想执行以下操作：\n\n");
        message.append("  ").append(what).append("\n");
        if (detail != null && !detail.isBlank()) {
            message.append("\n详细说明：\n  ").append(detail).append("\n");
        }
        message.append("\n是否允许？");
        boolean[] result = new boolean[]{false};
        try {
            SwingUtilities.invokeAndWait(() -> {
                result[0] = JOptionPane.showConfirmDialog(this, message.toString(), "Agent 操作确认", 0) == 0;
            });
        }
        catch (Exception exception) {
            // empty catch block
        }
        return result[0];
    }

    private static boolean containsItem(JComboBox<String> combo, String item) {
        for (int i = 0; i < combo.getItemCount(); ++i) {
            if (!combo.getItemAt(i).equals(item)) continue;
            return true;
        }
        return false;
    }

    private void updateAssetPreview(WorkflowModel.Node node) {
        if (node == null) {
            this.assetPreview.setIcon(null);
            this.assetPreview.setText("");
            return;
        }
        boolean isAssetImage = node.nodeKind == WorkflowModel.NodeKind.ASSET
                && "image".equals(node.assetType);
        boolean isImagePath = NodeRegistry.isImageAsset(node.relativePath);
        if (!isAssetImage && !isImagePath) {
            this.assetPreview.setIcon(null);
            this.assetPreview.setText("");
            return;
        }
        try {
            Path assetRoot = this.currentProjectFile != null ? this.currentProjectFile.getParent() : Path.of(this.project.getText(), new String[0]);
            String rel = node.relativePath == null || node.relativePath.isBlank() ? node.artifact : node.relativePath;
            if (rel == null || rel.isBlank()) {
                this.assetPreview.setIcon(null);
                this.assetPreview.setText("图片路径为空");
                return;
            }
            Path imagePath = assetRoot.resolve(rel);
            if (Files.isRegularFile(imagePath, new LinkOption[0])) {
                ImageIcon icon = new ImageIcon(imagePath.toString());
                if (icon.getIconWidth() > 0 && icon.getIconHeight() > 0) {
                    // 等比缩放，保持比例，适配预览区
                    int maxW = 300;
                    int maxH = 170;
                    int w = icon.getIconWidth();
                    int h = icon.getIconHeight();
                    double scale = Math.min(1.0, Math.min((double) maxW / w, (double) maxH / h));
                    Image scaled = icon.getImage().getScaledInstance(Math.max(1, (int) (w * scale)), Math.max(1, (int) (h * scale)), 4);
                    this.assetPreview.setIcon(new ImageIcon(scaled));
                    this.assetPreview.setText("");
                } else {
                    this.assetPreview.setIcon(null);
                    this.assetPreview.setText("无法预览");
                }
            } else {
                this.assetPreview.setIcon(null);
                this.assetPreview.setText("文件不存在: " + String.valueOf(imagePath));
            }
        }
        catch (Exception e) {
            this.assetPreview.setIcon(null);
            this.assetPreview.setText("预览失败: " + e.getMessage());
        }
    }

    private void expandBundle() {
        WorkflowModel.Node node = this.canvas.selected();
        if (node == null || node.nodeKind != WorkflowModel.NodeKind.ASSET_BUNDLE) {
            return;
        }
        List<WorkflowModel.Node> created = this.model.expandAssetBundle(node);
        if (!created.isEmpty()) {
            this.canvas.selectNodes(created);
            this.commitHistory();
            this.canvas.repaint();
            this.append("已从资源组展开 " + created.size() + " 个资产节点");
        }
    }

    private void analyzeFileContent() {
        WorkflowModel.Node node = this.canvas.selected();
        if (node == null || node.nodeKind != WorkflowModel.NodeKind.FILE && node.nodeKind != WorkflowModel.NodeKind.ASSET) {
            return;
        }
        try {
            Path root = this.currentProjectFile != null ? this.currentProjectFile.getParent() : Path.of(this.project.getText(), new String[0]);
            Path file = root.resolve(node.relativePath);
            if (Files.isRegularFile(file, new LinkOption[0])) {
                FileContentAnalyzer.FileSummary summary = FileContentAnalyzer.analyze(file);
                node.prompt = summary.toPrompt();
                this.commitHistory();
                this.loadInspector(node);
                this.canvas.repaint();
                this.append("已分析文件内容: " + node.relativePath);
            } else {
                this.append("文件不存在: " + String.valueOf(file));
            }
        }
        catch (Exception e) {
            this.error(e);
        }
    }

    private void expandFileToRange() {
        WorkflowModel.Node node = this.canvas.selected();
        if (node == null || node.nodeKind != WorkflowModel.NodeKind.FILE && node.nodeKind != WorkflowModel.NodeKind.ASSET) {
            return;
        }
        try {
            Path root = this.currentProjectFile != null ? this.currentProjectFile.getParent() : Path.of(this.project.getText(), new String[0]);
            Path file = root.resolve(node.relativePath);
            if (!Files.isRegularFile(file, new LinkOption[0])) {
                node.rangeMode = true;
                node.containerWidth = 520;
                node.containerHeight = 320;
                this.commitHistory();
                this.loadInspector(node);
                this.canvas.repaint();
                this.append("虚拟相对路径文件不存在，已按范围节点展开（跳过内容分析）: " + node.relativePath);
                return;
            }
            FileContentAnalyzer.FileSummary summary = FileContentAnalyzer.analyze(file);
            node.rangeMode = true;
            node.prompt = summary.toPrompt();
            List<Map<String, Object>> specs = FileContentAnalyzer.generateNodesForExpansion(this.model, summary, node.x + 40, node.y + 34 + 70);
            for (Map<String, Object> spec : specs) {
                WorkflowModel.Node child = this.model.addNode(((Number)spec.get("x")).intValue(), ((Number)spec.get("y")).intValue());
                child.name = String.valueOf(spec.get("name"));
                child.prompt = "自动解析自 " + node.relativePath;
                child.fileNodeId = node.id;
                child.nodeKind = WorkflowModel.NodeKind.REGULAR;
                child.codeBearing = false;
                child.category = switch (String.valueOf(spec.get("type"))) {
                    case "import" -> "导入";
                    case "function" -> "函数";
                    case "variable" -> "变量";
                    case "class" -> "类";
                    default -> "解析";
                };
            }
            this.commitHistory();
            this.canvas.select(node);
            this.loadInspector(node);
            this.canvas.repaint();
            this.append("已展开文件为范围模式: " + node.relativePath);
        }
        catch (Exception e) {
            this.error(e);
        }
    }

    private void indexLocalFile() {
        String relative;
        if (this.projectReadOnly) {
            return;
        }
        Path root = (this.currentProjectFile != null ? this.currentProjectFile.getParent() : Path.of(this.project.getText(), new String[0])).toAbsolutePath().normalize();
        JFileChooser chooser = new JFileChooser(root.toFile());
        chooser.setFileSelectionMode(0);
        if (chooser.showOpenDialog(this) != 0) {
            return;
        }
        Path file = chooser.getSelectedFile().toPath().toAbsolutePath().normalize();
        if (file.startsWith(root)) {
            relative = root.relativize(file).toString().replace('\\', '/');
        } else {
            try {
                Path targetDir = root.resolve("output/imports").toAbsolutePath().normalize();
                Files.createDirectories(targetDir, new FileAttribute[0]);
                String name = file.getFileName().toString();
                Path target = targetDir.resolve(name);
                int i = 1;
                while (Files.exists(target, new LinkOption[0])) {
                    String base = name.contains(".") ? name.substring(0, name.lastIndexOf(46)) : name;
                    String ext = name.contains(".") ? name.substring(name.lastIndexOf(46)) : "";
                    target = targetDir.resolve(base + "-" + i + ext);
                    ++i;
                }
                Files.copy(file, target, new CopyOption[0]);
                relative = root.relativize(target).toString().replace('\\', '/');
            }
            catch (IOException e) {
                this.error(e);
                return;
            }
        }
        WorkflowModel.Node node = this.canvas.selected();
        boolean created = false;
        if (node == null || node.nodeKind != WorkflowModel.NodeKind.FILE && node.nodeKind != WorkflowModel.NodeKind.ASSET) {
            Point p = this.newNodePosition();
            node = this.model.addFileNode(p.x, p.y, file.getFileName().toString(), relative);
            this.canvas.select(node);
            created = true;
        } else {
            node.relativePath = relative;
            if (node.name.isBlank() || node.name.equals("文件节点") || node.name.equals("范围文件")) {
                node.name = file.getFileName().toString();
            }
        }
        this.commitHistory();
        this.loadInspector(node);
        this.canvas.repaint();
        this.append((created ? "已创建文件节点并索引本地文件: " : "已更新文件节点索引: ") + relative);
    }

    /** 文件浏览器双击：在画布创建/定位文件节点，并在代码栏（代码审查）打开内容。 */
    private void openFileFromBrowser(Path file, boolean text) {
        if (file == null) return;
        Path root = projectRootForFile(file);
        String relative;
        try {
            relative = root.relativize(file).toString().replace('\\', '/');
        } catch (Exception e) {
            relative = file.getFileName() == null ? file.toString() : file.getFileName().toString();
        }
        if (projectReadOnly) return;
        WorkflowModel.Node node = this.canvas.selected();
        if (node == null || (node.nodeKind != WorkflowModel.NodeKind.FILE && node.nodeKind != WorkflowModel.NodeKind.ASSET)) {
            Point p = this.newNodePosition();
            node = this.model.addFileNode(p.x, p.y, file.getFileName() == null ? "文件" : file.getFileName().toString(), relative);
            this.canvas.select(node);
        } else {
            node.relativePath = relative;
            if (node.name.isBlank() || node.name.equals("文件节点") || node.name.equals("范围文件")) {
                node.name = file.getFileName() == null ? "文件" : file.getFileName().toString();
            }
        }
        // 文本文件：先在代码槽写入内容，再提交历史（避免历史快照里的代码槽为空导致 undo 后内容被清理）
        if (text) {
            try {
                WorkflowModel.CodeSlot slot = this.model.ensureFileSlot(node);
                String content = Files.isRegularFile(file) ? Files.readString(file, java.nio.charset.StandardCharsets.UTF_8) : "";
                slot.activeCode = content;
                slot.language = languageOf(relative);
            } catch (Exception e) {
                this.append("读取文件失败: " + e.getMessage());
            }
        }
        this.commitHistory();
        this.loadInspector(node);
        this.canvas.repaint();
        // 在代码栏打开内容（代码审查面板加载该文件节点的代码槽）
        if (text) {
            try {
                WorkflowModel.CodeSlot slot = this.model.ensureFileSlot(node);
                if (this.codeReviewPanel != null) this.codeReviewPanel.loadFrom(node, slot);
                if (this.workbenchTabs != null) this.workbenchTabs.setSelectedIndex(1);
                this.append("已在代码栏打开: " + relative);
            } catch (Exception e) {
                this.append("打开代码栏失败: " + e.getMessage());
            }
        }
    }

    /** 拖放文件到画布：在落点创建文件节点。 */
    private void dropFileToCanvas(Path file, Point world) {
        if (file == null || this.projectReadOnly) return;
        Path root = projectRootForFile(file);
        String relative;
        try {
            relative = root.relativize(file).toString().replace('\\', '/');
        } catch (Exception e) {
            relative = file.getFileName() == null ? file.toString() : file.getFileName().toString();
        }
        if (Files.isDirectory(file)) {
            // 目录整体作为一个文件节点（相对路径），不递归展开
            WorkflowModel.Node node = this.model.addFileNode(world.x, world.y, file.getFileName() == null ? "目录" : file.getFileName().toString(), relative);
            node.rangeMode = true;
            this.canvas.select(node);
            this.commitHistory();
            this.loadInspector(node);
            this.canvas.repaint();
            this.append("已拖入目录节点: " + relative);
            return;
        }
        WorkflowModel.Node node = this.model.addFileNode(world.x, world.y, file.getFileName() == null ? "文件" : file.getFileName().toString(), relative);
        this.canvas.select(node);
        this.commitHistory();
        this.loadInspector(node);
        this.canvas.repaint();
        this.append("已拖入文件节点: " + relative);
    }

    private Path projectRootForFile(Path file) {
        Path root = (this.currentProjectFile != null ? this.currentProjectFile.getParent() : Path.of(this.project.getText(), new String[0])).toAbsolutePath().normalize();
        try {
            if (file.startsWith(root)) return root;
        } catch (Exception ignored) {}
        return root;
    }

    private static String languageOf(String relative) {
        String lower = relative.toLowerCase();
        if (lower.endsWith(".java")) return "java";
        if (lower.endsWith(".kt")) return "kotlin";
        if (lower.endsWith(".py")) return "python";
        if (lower.endsWith(".js")) return "javascript";
        if (lower.endsWith(".ts")) return "typescript";
        if (lower.endsWith(".md")) return "markdown";
        if (lower.endsWith(".json")) return "json";
        if (lower.endsWith(".xml")) return "xml";
        return "text";
    }

    private void createVirtualFileNode() {
        if (this.projectReadOnly) {
            return;
        }
        String relative = JOptionPane.showInputDialog(this, "输入项目内相对路径（文件可不存在，作为虚拟路径，如 output/agent/note.md）：", "新建相对路径", -1);
        if (relative == null) {
            return;
        }
        if ((relative = relative.trim()).isBlank()) {
            JOptionPane.showMessageDialog(this, "相对路径不能为空");
            return;
        }
        Path p = Path.of(relative, new String[0]).normalize();
        if (p.isAbsolute() || p.startsWith("..")) {
            JOptionPane.showMessageDialog(this, "请输入项目内的相对路径（不允许绝对路径或 ../）");
            return;
        }
        String normalized = relative.replace('\\', '/');
        Point pos = this.newNodePosition();
        WorkflowModel.Node node = this.model.addFileNode(pos.x, pos.y, "文件节点", normalized);
        this.canvas.select(node);
        this.commitHistory();
        this.loadInspector(node);
        this.canvas.repaint();
        this.append("已创建虚拟文件节点: " + normalized);
    }

    private Point newNodePosition() {
        Rectangle view = this.canvas.getVisibleRect();
        double cx = (double)view.x + (double)view.width / 2.0;
        double cy = (double)view.y + (double)view.height / 2.0;
        int wx = (int)Math.max(0.0, (cx - (double)this.canvas.panX()) / this.canvas.zoom() - 60.0);
        int wy = (int)Math.max(0.0, (cy - (double)this.canvas.panY()) / this.canvas.zoom() - 30.0);
        return new Point(wx, wy);
    }

    private record SubmissionChoice(String label, String nodeId, boolean selectedNode) {
        @Override public String toString() { return this.label; }
    }

    private record NodeOwnerChoice(String id, String label) {
        @Override
        public String toString() {
            return this.label;
        }
    }

    private record HistoryState(WorkflowModel model, List<String> selectedNodeIds, int panX, int panY, double zoom) {
    }

    /** 单个文档标签会话：独立的模型与文档状态。 */
    private static final class DocumentSession {
        WorkflowModel model;
        Path file;
        String documentId;
        Instant createdAt;
        boolean readOnly;
        boolean dirty;
        String executableOutput = "output";
        String markdownOutput = "output/docs";
        WorkflowModel.Mode mode = WorkflowModel.Mode.MARKDOWN;
        int panX;
        int panY;
        double zoom = 1.0;
    }

    /** 新建一个空白文档 tab（不打开任何文件）。 */
    private void newDocumentTab() {
        DocumentSession session = new DocumentSession();
        session.model = new WorkflowModel();
        session.documentId = UUID.randomUUID().toString();
        session.createdAt = Instant.now();
        session.panX = 0;
        session.panY = 0;
        session.zoom = 1.0;
        this.documents.add(session);
        int index = this.documents.size() - 1;
        this.documentTabs.addTab("未命名.cnode", null);
        installTabCloseButton(index);
        this.documentTabs.setSelectedIndex(index);
        this.switchToDocument(index);
        this.dirty = false;
        this.refreshDocumentTitle();
        this.resetHistory();
        this.canvas.repaint();
        this.status.setText("  新文档  |  未命名");
    }

    /** 安装 tab 的关闭按钮。 */
    private void installTabCloseButton(int index) {
        JPanel panel = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 0));
        panel.setOpaque(false);
        JLabel title = new JLabel("未命名.cnode");
        title.setForeground(UiTheme.TEXT);
        JButton close = new JButton("×");
        close.setBorderPainted(false);
        close.setContentAreaFilled(false);
        close.setFocusPainted(false);
        close.setForeground(UiTheme.MUTED);
        close.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        close.addActionListener(e -> this.closeDocument(index));
        panel.add(title);
        panel.add(close);
        this.documentTabs.setTabComponentAt(index, panel);
    }

    /** 切换到指定文档：快照换入主 model。 */
    private void switchToDocument(int index) {
        if (index < 0 || index >= this.documents.size()) return;
        DocumentSession session = this.documents.get(index);
        this.loadingProject = true;
        try {
            this.model.replaceFrom(session.model);
            this.canvas.setView(session.panX, session.panY, session.zoom);
            this.canvas.select(null);
            this.canvas.repaint();
            this.currentProjectFile = session.file;
            this.documentId = session.documentId;
            this.documentCreatedAt = session.createdAt;
            this.projectReadOnly = session.readOnly;
            this.dirty = session.dirty;
            this.executableOutput = session.executableOutput;
            this.markdownOutput = session.markdownOutput;
            this.displayedMode = session.mode;
            this.mode.setSelectedItem((Object)session.mode);
            this.output.setText(session.mode == WorkflowModel.Mode.EXECUTABLE ? session.executableOutput : session.markdownOutput);
            this.loadInspector(null);
            this.refreshDocumentTitle();
        } finally {
            this.loadingProject = false;
        }
        this.syncProjectPanels(session.file == null ? null : session.file.getParent());
    }

    /** 关闭指定文档 tab。 */
    private void closeDocument(int index) {
        if (index < 0 || index >= this.documents.size()) return;
        DocumentSession session = this.documents.get(index);
        boolean wasCurrent = index == this.documentTabs.getSelectedIndex();
        this.documents.remove(index);
        this.documentTabs.removeTabAt(index);
        if (this.documents.isEmpty()) {
            // 全部关闭 → 空白画布
            this.model.clear();
            this.canvas.select(null);
            this.canvas.setView(0, 0);
            this.currentProjectFile = null;
            this.documentId = UUID.randomUUID().toString();
            this.documentCreatedAt = Instant.now();
            this.dirty = false;
            this.loadInspector(null);
            this.refreshDocumentTitle();
            this.resetHistory();
            this.project.setText("");
            this.queue = null;
            this.results = null;
            this.syncProjectPanels(null);
            this.canvas.repaint();
            this.status.setText("  无打开的文档  |  新建或打开项目");
            return;
        }
        // 重新编号 tab 关闭按钮（后续 tab 序号变化）
        for (int i = 0; i < this.documents.size(); i++) {
            installTabCloseButton(i);
        }
        if (wasCurrent) {
            int next = Math.min(index, this.documents.size() - 1);
            this.documentTabs.setSelectedIndex(next);
            this.switchToDocument(next);
        } else {
            this.documentTabs.repaint();
        }
    }
}
