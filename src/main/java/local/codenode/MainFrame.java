package local.codenode;

import local.codenode.agent.AgentChatController;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.impl.AgentToolkit;
import local.codenode.config.AgentConfig;
import local.codenode.ui.agent.AgentChatPanel;
import local.codenode.ui.settings.AgentSettingsPanel;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import javax.swing.filechooser.FileNameExtensionFilter;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;
import java.awt.*;
import java.awt.datatransfer.StringSelection;
import java.awt.event.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.prefs.Preferences;

public final class MainFrame extends JFrame {
    private final WorkflowModel model = new WorkflowModel();
    private final CanvasPanel canvas = new CanvasPanel(model);
    private final JComboBox<WorkflowModel.Mode> mode = new JComboBox<>(WorkflowModel.Mode.values());
    private final JComboBox<String> language = new JComboBox<>(new String[]{"java", "powershell", "go"});
    private final JComboBox<String> agentProvider = new JComboBox<>(new String[]{"本地申请槽", "Codex 自动"});
    private final JTextField project = new JTextField(System.getProperty("user.home"), 25);
    private final JTextField output = new JTextField("output", 18);
    private final JTextField nodeName = new JTextField();
    private final JTextField artifact = new JTextField();
    private final JComboBox<NodeOwnerChoice> fileOwner = new JComboBox<>();
    private final JComboBox<NodeOwnerChoice> parentScope = new JComboBox<>();
    private final JComboBox<String> operation = new JComboBox<>();
    private final JTextField nodeColor = new JTextField();
    private final JCheckBox rangeMode = new JCheckBox("范围模式（作为容器）");
    private final JComboBox<String> assetTypeCombo = new JComboBox<>();
    private final JTextArea bundleData = new JTextArea(4,22);
    private final JButton expandBundleBtn = new JButton("展开资源组为独立节点");
    private final JLabel assetPreview = new JLabel();
    private final JTextArea prompt = new JTextArea(7, 22);
    private final JTextArea log = new JTextArea(7, 80);
    private final JTextArea errors = new JTextArea(7, 50);
    private CodeReviewPanel codeReviewPanel;
    private final DefaultListModel<String> queueItems = new DefaultListModel<>();
    private final JList<String> queueList = new JList<>(queueItems);
    private final PortTableModel portModel = new PortTableModel();
    private final JTable portTable = new JTable(portModel);
    private final JLabel nodePath = new JLabel("工作流 / 未选择节点");
    private final JLabel status = new JLabel("  就绪");
    private final JLabel documentTab = new JLabel();
    private final CnodeProjectCodec projectCodec = new CnodeProjectCodec();
    private final CnodeRecoveryService recovery = new CnodeRecoveryService(projectCodec);
    private final CodeSlotService codeSlotService = new CodeSlotService();
    private final AgentProvider codexAgent = new CodexAppServerProvider();
    private final AgentConfig agentConfig = AgentConfig.load();
    private AgentToolContext agentToolContext;
    private AgentToolRegistry agentTools;
    private AgentChatController agentChatController;
    private AgentChatPanel agentChatPanel;
    private NodeControlApi nodeControlApi;
    private final Preferences preferences=Preferences.userNodeForPackage(MainFrame.class);
    private final List<Path> recentProjects=new ArrayList<>();
    private final Timer resultPollTimer;
    private final Timer autoSaveTimer;
    private JButton analysisBtn;
    private QueueService queue;
    private ResultService results;
    private Path currentProjectFile;
    private String documentId=UUID.randomUUID().toString();
    private Instant documentCreatedAt=Instant.now();
    private boolean projectReadOnly;
    private boolean loadingProject;
    private boolean loadingInspector;
    private boolean dirty;
    private WorkflowModel.Mode displayedMode=WorkflowModel.Mode.EXECUTABLE;
    private String executableOutput="output";
    private String markdownOutput="output/docs";
    private final Deque<HistoryState> undoHistory=new ArrayDeque<>(),redoHistory=new ArrayDeque<>();
    private final JLabel spaceMode = new JLabel("");
    private HistoryState historyCurrent;
    private final EnumMap<ToolWindow.DockPosition,List<ToolWindow>> docked = new EnumMap<>(ToolWindow.DockPosition.class);
    private final EnumMap<ToolWindow.DockPosition,Integer> dockOrientation = new EnumMap<>(ToolWindow.DockPosition.class);
    private final Map<ToolWindow,Integer> tabGroup = new HashMap<>();
    private int tabGroupSequence=1;
    private JPanel dockRoot;
    private JComponent editor;
    private ToolWindow inspectorTool, outputTool, errorTool, queueTool;
    private JTabbedPane workbenchTabs;
    private JScrollPane inspectorScroll;

    public MainFrame() {
        super("CodeNode Desktop — 本地节点制作台");
        loadRecentProjects();
        for(ToolWindow.DockPosition position:ToolWindow.DockPosition.values())docked.put(position,new ArrayList<>());
        dockOrientation.put(ToolWindow.DockPosition.LEFT,JSplitPane.VERTICAL_SPLIT);dockOrientation.put(ToolWindow.DockPosition.RIGHT,JSplitPane.VERTICAL_SPLIT);
        dockOrientation.put(ToolWindow.DockPosition.TOP,JSplitPane.HORIZONTAL_SPLIT);dockOrientation.put(ToolWindow.DockPosition.BOTTOM,JSplitPane.HORIZONTAL_SPLIT);
        setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);
        addWindowListener(new WindowAdapter(){@Override public void windowClosing(WindowEvent e){closeApplication();}});
        setMinimumSize(new Dimension(1180, 760));
        setJMenuBar(menuBar());
        setLayout(new BorderLayout());
        try { agentConfig.createDefaultsIfMissing(); } catch (Exception ignored) {}
        agentToolContext = new AgentToolContext(
                () -> currentProjectFile != null ? currentProjectFile.getParent() : Path.of(project.getText()),
                () -> model,
                this::confirmAgentTool,
                entry -> SwingUtilities.invokeLater(() -> append("[Agent 工具] " + entry)),
                generated -> SwingUtilities.invokeLater(() -> {
                    try {
                        saveInspector();
                        model.replaceFrom(generated);
                        canvas.repaint();
                        commitHistory();
                        status.setText("  Agent 已写入工作台  |  节点=" + model.nodes().size());
                        append("[Agent] scan_project 已将结构化节点图写入工作台，节点=" + model.nodes().size());
                    } catch (Exception e) {
                        append("[Agent] 写入工作台失败：" + e.getMessage());
                    }
                }),
                mutator -> {
                    try {
                        SwingUtilities.invokeAndWait(() -> {
                            mutator.mutate(model);
                            canvas.repaint();
                            commitHistory();
                        });
                    } catch (Exception e) {
                        SwingUtilities.invokeLater(() -> append("[Agent] 工作台变更失败：" + e.getMessage()));
                    }
                },
                () -> SwingUtilities.invokeLater(this::saveProject),
                () -> SwingUtilities.invokeLater(this::undo),
                () -> SwingUtilities.invokeLater(this::redo));
        agentToolContext.setQuestionHandler((question, options) -> {
            final String[] result = {""};
            try {
                SwingUtilities.invokeAndWait(() -> {
                    if (options == null || options.isEmpty()) {
                        result[0] = JOptionPane.showInputDialog(this, question, "Agent 询问", JOptionPane.QUESTION_MESSAGE);
                    } else {
                        Object choice = JOptionPane.showInputDialog(this, question, "Agent 询问",
                                JOptionPane.QUESTION_MESSAGE, null, options.toArray(), options.get(0));
                        result[0] = choice == null ? "" : String.valueOf(choice);
                    }
                });
            } catch (Exception ignored) {}
            return result[0];
        });
        agentTools = AgentToolkit.buildDefaultRegistry(agentToolContext, agentConfig);
        agentChatController = new AgentChatController(agentConfig, agentTools, agentToolContext);
        add(toolbar(), BorderLayout.NORTH);
        add(workbench(), BorderLayout.CENTER);
        add(statusBar(), BorderLayout.SOUTH);

        canvas.onSelection(this::loadInspector);
        canvas.onFeedback(message->{status.setText("  "+message);append(message);});
        canvas.onChange(this::commitHistory);portModel.onChange(this::commitHistory);
        canvas.setLanguageSupplier(() -> String.valueOf(language.getSelectedItem()));
        mode.addActionListener(e -> updateMode());
        language.addActionListener(e->{if(!loadingProject){markDirty();status.setText("  " + mode.getSelectedItem() + "  |  " + language.getSelectedItem());}});
        watch(nodeName);watch(prompt);watch(artifact);watch(output);watch(nodeColor);watch(bundleData);
        rangeMode.addActionListener(e->{if(!loadingProject&&!loadingInspector&&!projectReadOnly)markDirty();});
        assetTypeCombo.addActionListener(e->{if(!loadingProject&&!loadingInspector&&!projectReadOnly)markDirty();});
        WorkflowModel.Node first = model.addNode(100, 100), second = model.addNode(390, 220);
        first.name = "输入与解析"; second.name = "生成产物"; model.connect(first, second); canvas.select(second);
        initializeProject(false); updateMode();
        nodeControlApi = new NodeControlApi(model, () -> currentProjectFile != null ? currentProjectFile.getParent() : Path.of(project.getText()),
                canvas::selected, ids -> canvas.selectNodes(ids.stream().map(model::byId).toList()),
                canvas::repaint, this::saveProject, this::undo, this::redo);
        installGlobalKeys();resetHistory();

        UiTheme.apply(getJMenuBar());
        UiTheme.apply(getContentPane());
        getContentPane().setBackground(UiTheme.BACKGROUND);
        if(codeReviewPanel!=null)codeReviewPanel.fixupTheme();
        resultPollTimer=new Timer(1800,e->pollResults());resultPollTimer.start();
        autoSaveTimer=new Timer(15*60*1000,e->autoSave());autoSaveTimer.setInitialDelay(15*60*1000);autoSaveTimer.start();
        dirty=false;refreshDocumentTitle();
        setSize(1500, 900); setLocationRelativeTo(null);SwingUtilities.invokeLater(()->inspectorScroll.getViewport().setViewPosition(new Point(0,0)));
    }

    private JMenuBar menuBar() {
        JMenuBar bar = new JMenuBar(); bar.setBorder(BorderFactory.createMatteBorder(0, 0, 1, 0, UiTheme.BORDER));
        JMenu file = menu("文件(F)", item("新建工程", this::newProject), item("打开 .cnode…", this::openProject), item("保存", this::saveProject), item("另存为…", this::saveProjectAs));file.addSeparator();file.add(item("选择申请项目目录…", this::chooseProject));file.addSeparator();file.add(item("退出", this::closeApplication));
        JMenu edit = menu("编辑(E)", item("应用节点修改", this::saveInspector));
        JMenu view = menu("视图(V)", item("显示节点资源管理器", () -> inspectorTool.redock()), item("显示输出", () -> outputTool.redock()),item("显示错误列表",()->errorTool.redock()),item("切换到代码审查",()->{if(workbenchTabs!=null)workbenchTabs.setSelectedIndex(1);}),item("切换到内嵌 Agent",()->{if(workbenchTabs!=null)workbenchTabs.setSelectedIndex(2);}),item("显示申请队列",()->queueTool.redock()));
        JMenu projectMenu = menu("项目(P)", item("初始化本地申请槽", () -> initializeProject(true)));
        JMenu build = menu("生成(B)", item("提交选择的节点到 Agent", this::submitSelected), item("选择组输出提交…", () -> showSubmissionMenu(null)));
        JMenu debug = menu("调试(D)");
        JMenu tools = menu("工具(T)", item("刷新结果", this::pollResults));
        JMenu help = menu("帮助(H)");
        for (JMenu menu : new JMenu[]{file, edit, view, projectMenu, build, debug, tools, help}) bar.add(menu);
        return bar;
    }

    private JComponent toolbar() {
        JPanel toolbar = new JPanel(new FlowLayout(FlowLayout.LEFT, 7, 7));
        toolbar.setBackground(UiTheme.TOOLBAR); toolbar.setBorder(new EmptyBorder(1, 7, 1, 7));
        JButton choose = button("打开项目", this::chooseProject), recent = new JButton("最近打开"), init = button("初始化", () -> initializeProject(true));recent.addActionListener(e->showRecentProjects(recent));
        JButton add = button("＋ 添加节点", this::addNode), submit = button("▷ 提交申请", this::submitSelected), submitMenu = new JButton("▼");submitMenu.setToolTipText("选择单节点或组输出申请");submitMenu.addActionListener(e->showSubmissionMenu(submitMenu));
        JButton analyzeProjectBtn = button("分析项目结构", this::analyzeProject);
        analysisBtn = button("项目全量解析", this::analyzeProjectFull);
        analysisBtn.setEnabled(false);
        toolbar.add(new JLabel("项目")); toolbar.add(project); toolbar.add(choose);toolbar.add(recent); toolbar.add(init); toolbar.add(separator());
        toolbar.add(new JLabel("模式")); toolbar.add(mode); toolbar.add(new JLabel("语言")); toolbar.add(language); toolbar.add(new JLabel("Agent")); toolbar.add(agentProvider); toolbar.add(separator());
        toolbar.add(add); toolbar.add(submit); toolbar.add(submitMenu); toolbar.add(separator());
        toolbar.add(analyzeProjectBtn); toolbar.add(analysisBtn);
        return toolbar;
    }

    private JComponent workbench() {
        JScrollPane canvasScroll = new JScrollPane(canvas);
        canvasScroll.getHorizontalScrollBar().setUnitIncrement(20); canvasScroll.getVerticalScrollBar().setUnitIncrement(20);
        JPanel canvasPanel = new JPanel(new BorderLayout()); canvasPanel.add(documentTabs(), BorderLayout.NORTH); canvasPanel.add(canvasScroll, BorderLayout.CENTER);
        workbenchTabs=new JTabbedPane();
        workbenchTabs.addTab("节点图",canvasPanel);
        workbenchTabs.addTab("代码审查",reviewPanel());
        agentChatPanel = new AgentChatPanel(agentChatController, agentConfig, this::openAgentSettings);
        workbenchTabs.addTab("内嵌 Agent",agentChatPanel);
        UiTheme.apply(workbenchTabs);
        editor=workbenchTabs;
        dockRoot=new JPanel(new BorderLayout());
        inspectorTool = new ToolWindow(this,"节点资源管理器",inspector(),collapsed -> rebuildDockLayout(),position -> dock(inspectorTool,position),()->toggleDockOrientation(inspectorTool));
        outputTool = new ToolWindow(this,"输出",outputPanel(),collapsed -> rebuildDockLayout(),position -> dock(outputTool,position),()->toggleDockOrientation(outputTool));
        errorTool = new ToolWindow(this,"错误列表",errorPanel(),collapsed -> rebuildDockLayout(),position -> dock(errorTool,position),()->toggleDockOrientation(errorTool));
        queueTool = new ToolWindow(this,"申请队列",queuePanel(),collapsed -> rebuildDockLayout(),position -> dock(queueTool,position),()->toggleDockOrientation(queueTool));
        for(ToolWindow tool:List.of(inspectorTool,outputTool,errorTool,queueTool))tabGroup.put(tool,tabGroupSequence++);
        docked.get(ToolWindow.DockPosition.RIGHT).add(inspectorTool);
        docked.get(ToolWindow.DockPosition.BOTTOM).addAll(List.of(outputTool,errorTool,queueTool));
        rebuildDockLayout();return dockRoot;
    }

    private void dock(ToolWindow tool,ToolWindow.DockRequest request){
        for(List<ToolWindow> tools:docked.values())tools.remove(tool);
        if(request.mergeWith()!=null){
            ToolWindow target=request.mergeWith();ToolWindow.DockPosition position=positionOf(target);if(position==null)return;docked.get(position).add(tool);tabGroup.put(tool,tabGroup.get(target));
        }else{docked.get(request.position()).add(tool);tabGroup.put(tool,tabGroupSequence++);}
        rebuildDockLayout();
    }
    private ToolWindow.DockPosition positionOf(ToolWindow tool){for(ToolWindow.DockPosition position:ToolWindow.DockPosition.values())if(docked.get(position).contains(tool))return position;return null;}
    private void toggleDockOrientation(ToolWindow tool){
        for(ToolWindow.DockPosition position:ToolWindow.DockPosition.values())if(docked.get(position).contains(tool)){
            int current=dockOrientation.get(position);dockOrientation.put(position,current==JSplitPane.HORIZONTAL_SPLIT?JSplitPane.VERTICAL_SPLIT:JSplitPane.HORIZONTAL_SPLIT);rebuildDockLayout();return;
        }
    }
    private void rebuildDockLayout(){
        if(dockRoot==null||editor==null)return;
        JComponent layout=editor;
        for(ToolWindow.DockPosition position:new ToolWindow.DockPosition[]{ToolWindow.DockPosition.LEFT,ToolWindow.DockPosition.RIGHT,ToolWindow.DockPosition.TOP,ToolWindow.DockPosition.BOTTOM}){
            JComponent group=dockGroup(position);if(group!=null)layout=attachDock(layout,group,position);
        }
        dockRoot.removeAll();dockRoot.add(layout,BorderLayout.CENTER);
        JComponent rail=collapsedRail();if(rail!=null)dockRoot.add(rail,BorderLayout.EAST);
        dockRoot.revalidate();dockRoot.repaint();
    }
    private JComponent dockGroup(ToolWindow.DockPosition position){
        List<ToolWindow> all=docked.get(position);int orientation=dockOrientation.get(position);for(ToolWindow tool:all)tool.setArrangementHorizontal(orientation==JSplitPane.HORIZONTAL_SPLIT);
        Map<Integer,List<ToolWindow>> groups=new LinkedHashMap<>();for(ToolWindow tool:all)if(!tool.isCollapsed())groups.computeIfAbsent(tabGroup.get(tool),key->new ArrayList<>()).add(tool);
        List<JComponent> slots=groups.values().stream().map(this::tabSlot).toList();if(slots.isEmpty())return null;if(slots.size()==1)return slots.getFirst();
        JComponent group=slots.getFirst();
        for(int i=1;i<slots.size();i++){
            JComponent first=group,second=slots.get(i);JSplitPane split=new JSplitPane(orientation,first,second);UiTheme.styleSplit(split);double ratio=i/(double)(i+1);split.setResizeWeight(ratio);SwingUtilities.invokeLater(()->split.setDividerLocation(ratio));group=split;
        }
        return group;
    }
    private JComponent tabSlot(List<ToolWindow> tools){
        if(tools.size()==1)return tools.getFirst();JTabbedPane tabs=new JTabbedPane();tabs.setTabLayoutPolicy(JTabbedPane.SCROLL_TAB_LAYOUT);for(ToolWindow tool:tools)tabs.addTab(tool.title(),tool);UiTheme.apply(tabs);return tabs;
    }
    private JComponent attachDock(JComponent center,JComponent tool,ToolWindow.DockPosition position){
        boolean horizontal=position==ToolWindow.DockPosition.LEFT||position==ToolWindow.DockPosition.RIGHT;boolean leading=position==ToolWindow.DockPosition.LEFT||position==ToolWindow.DockPosition.TOP;
        JSplitPane split=new JSplitPane(horizontal?JSplitPane.HORIZONTAL_SPLIT:JSplitPane.VERTICAL_SPLIT,leading?tool:center,leading?center:tool);UiTheme.styleSplit(split);split.setResizeWeight(leading?0:1);
        SwingUtilities.invokeLater(()->split.setDividerLocation(leading ? .24 : .76));return split;
    }
    private JComponent collapsedRail(){
        List<ToolWindow> collapsed=docked.values().stream().flatMap(List::stream).filter(ToolWindow::isCollapsed).toList();if(collapsed.isEmpty())return null;
        JPanel rail=new JPanel();rail.setLayout(new BoxLayout(rail,BoxLayout.Y_AXIS));rail.setBorder(BorderFactory.createMatteBorder(0,1,0,0,UiTheme.BORDER));
        for(ToolWindow tool:collapsed){
            JButton button=new JButton(tool.title().substring(0,1));button.setToolTipText(tool.title());button.setPreferredSize(new Dimension(30,34));button.setMaximumSize(new Dimension(30,34));button.setMargin(new Insets(1,1,1,1));
            MouseAdapter action=new MouseAdapter(){Point start;boolean dragged;@Override public void mousePressed(MouseEvent e){start=e.getPoint();dragged=false;}@Override public void mouseDragged(MouseEvent e){if(!dragged&&start!=null&&start.distance(e.getPoint())>8){dragged=true;tool.floatWindow();}}@Override public void mouseReleased(MouseEvent e){if(!dragged)tool.redock();}};
            button.addMouseListener(action);button.addMouseMotionListener(action);rail.add(button);
        }
        UiTheme.apply(rail);for(Component child:rail.getComponents())if(child instanceof JButton button){button.setBorder(BorderFactory.createLineBorder(UiTheme.BORDER));button.setBackground(UiTheme.TOOLBAR);button.setForeground(UiTheme.TEXT);}return rail;
    }

    private JComponent documentTabs() {
        JPanel tabs = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 0)); tabs.setBackground(UiTheme.PANEL);
        documentTab.setText("  未命名.cnode   ×  "); documentTab.setOpaque(true); documentTab.setBackground(UiTheme.BACKGROUND);
        documentTab.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createMatteBorder(2, 0, 0, 0, UiTheme.ACCENT), new EmptyBorder(7, 8, 7, 8)));
        tabs.add(documentTab); return tabs;
    }

    private JComponent inspector() {
        JPanel outer = new JPanel(new BorderLayout()); outer.setPreferredSize(new Dimension(335, 600));
        JPanel body = new JPanel(); body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS)); body.setBorder(new EmptyBorder(10, 11, 12, 11));
        nodePath.setForeground(UiTheme.MUTED); nodePath.setBorder(new EmptyBorder(0, 0, 9, 0)); nodePath.setAlignmentX(Component.LEFT_ALIGNMENT); body.add(nodePath);
        body.add(label("名称")); body.add(fixedField(nodeName)); body.add(Box.createVerticalStrut(10));
        body.add(label("Prompt / 文档职责")); prompt.setLineWrap(true); prompt.setWrapStyleWord(true);
        JScrollPane promptScroll = new JScrollPane(prompt); promptScroll.setMaximumSize(new Dimension(Integer.MAX_VALUE, 175)); promptScroll.setAlignmentX(Component.LEFT_ALIGNMENT); body.add(promptScroll); body.add(Box.createVerticalStrut(10));
        body.add(label("产物相对路径")); body.add(fixedField(artifact)); body.add(Box.createVerticalStrut(10));
        body.add(label("所属文件节点（Markdown 共享代码槽）"));fileOwner.setMaximumSize(new Dimension(Integer.MAX_VALUE,30));fileOwner.setAlignmentX(Component.LEFT_ALIGNMENT);body.add(fileOwner);body.add(Box.createVerticalStrut(10));
        body.add(label("所属范围节点"));parentScope.setMaximumSize(new Dimension(Integer.MAX_VALUE,30));parentScope.setAlignmentX(Component.LEFT_ALIGNMENT);body.add(parentScope);body.add(Box.createVerticalStrut(10));
        body.add(label("条件 / 计算运算"));operation.setMaximumSize(new Dimension(Integer.MAX_VALUE,30));operation.setAlignmentX(Component.LEFT_ALIGNMENT);body.add(operation);body.add(Box.createVerticalStrut(10));
        body.add(label("节点颜色 (空=默认, #RRGGBB 格式)"));nodeColor.setMaximumSize(new Dimension(Integer.MAX_VALUE,30));nodeColor.setAlignmentX(Component.LEFT_ALIGNMENT);body.add(nodeColor);body.add(Box.createVerticalStrut(10));
        rangeMode.setAlignmentX(Component.LEFT_ALIGNMENT);body.add(rangeMode);body.add(Box.createVerticalStrut(10));
        body.add(label("资产类型"));assetTypeCombo.setMaximumSize(new Dimension(Integer.MAX_VALUE,30));assetTypeCombo.setAlignmentX(Component.LEFT_ALIGNMENT);for(String type:NodeRegistry.allAssetTypes())assetTypeCombo.addItem(type);body.add(assetTypeCombo);body.add(Box.createVerticalStrut(10));
        body.add(label("资源组数据 (JSON 格式)"));bundleData.setLineWrap(true);bundleData.setWrapStyleWord(true);JScrollPane bundleScroll=new JScrollPane(bundleData);bundleScroll.setMaximumSize(new Dimension(Integer.MAX_VALUE,80));bundleScroll.setAlignmentX(Component.LEFT_ALIGNMENT);body.add(bundleScroll);body.add(Box.createVerticalStrut(5));
        expandBundleBtn.setAlignmentX(Component.LEFT_ALIGNMENT);expandBundleBtn.addActionListener(e->expandBundle());body.add(expandBundleBtn);body.add(Box.createVerticalStrut(10));
        JButton analyzeBtn = new JButton("分析文件内容");analyzeBtn.setAlignmentX(Component.LEFT_ALIGNMENT);analyzeBtn.addActionListener(e->analyzeFileContent());body.add(analyzeBtn);body.add(Box.createVerticalStrut(10));
        JButton expandFileBtn = new JButton("展开为范围节点");expandFileBtn.setAlignmentX(Component.LEFT_ALIGNMENT);expandFileBtn.addActionListener(e->expandFileToRange());body.add(expandFileBtn);body.add(Box.createVerticalStrut(10));
        JButton indexFileBtn = new JButton("索引本地文件");indexFileBtn.setAlignmentX(Component.LEFT_ALIGNMENT);indexFileBtn.addActionListener(e->indexLocalFile());body.add(indexFileBtn);body.add(Box.createVerticalStrut(10));
        JButton virtualPathBtn = new JButton("新建相对路径");virtualPathBtn.setAlignmentX(Component.LEFT_ALIGNMENT);virtualPathBtn.addActionListener(e->createVirtualFileNode());body.add(virtualPathBtn);body.add(Box.createVerticalStrut(10));
        assetPreview.setAlignmentX(Component.LEFT_ALIGNMENT);assetPreview.setPreferredSize(new Dimension(300,150));body.add(assetPreview);body.add(Box.createVerticalStrut(10));
        body.add(label("输入 / 输出端口"));portTable.setRowHeight(23);portTable.setFillsViewportHeight(true);portTable.getColumnModel().getColumn(0).setPreferredWidth(42);portTable.getColumnModel().getColumn(3).setPreferredWidth(38);
        portTable.getColumnModel().getColumn(2).setCellEditor(new PortTypeEditor());
        JScrollPane portScroll=new JScrollPane(portTable);
        portScroll.setPreferredSize(new Dimension(300,110));
        portScroll.setMinimumSize(new Dimension(100,80));
        portScroll.setMaximumSize(new Dimension(Integer.MAX_VALUE,140));
        portScroll.setAlignmentX(Component.LEFT_ALIGNMENT);
        body.add(portScroll);
        JPanel portButtons=new JPanel(new FlowLayout(FlowLayout.LEFT,4,4));
        portButtons.setAlignmentX(Component.LEFT_ALIGNMENT);
        portButtons.setPreferredSize(new Dimension(300,38));
        portButtons.setMinimumSize(new Dimension(100,38));
        portButtons.setMaximumSize(new Dimension(Integer.MAX_VALUE,38));
        portButtons.add(button("＋输入",()->addPort(false)));
        portButtons.add(button("＋输出",()->addPort(true)));
        portButtons.add(button("删除端口",this::removePort));
        body.add(portButtons);
        body.add(label("申请输出目录")); body.add(fixedField(output)); body.add(Box.createVerticalStrut(12));
        JButton apply = button("应用节点修改", this::saveInspector); apply.setAlignmentX(Component.LEFT_ALIGNMENT); body.add(apply);
        JButton ungroup = button("解开组", this::ungroupNode); ungroup.setAlignmentX(Component.LEFT_ALIGNMENT); body.add(ungroup); body.add(Box.createVerticalGlue());
        JTextArea hint = new JTextArea("连线：输出端口和输入端口都可以向外拖；整理点可拖到输入端口建立分支，Alt+左键拖动整理点可移动。\n失败结果会标红节点，并在输出面板显示文件、行与列。");
        hint.setEditable(false); hint.setLineWrap(true); hint.setWrapStyleWord(true); hint.setOpaque(false); hint.setForeground(UiTheme.MUTED); hint.setAlignmentX(Component.LEFT_ALIGNMENT); body.add(hint);
        inspectorScroll = new JScrollPane(body); inspectorScroll.setHorizontalScrollBarPolicy(ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER); inspectorScroll.setBorder(null);
        inspectorScroll.getVerticalScrollBar().setUnitIncrement(24);
        for (JScrollPane inner : List.of(promptScroll, portScroll, bundleScroll)) {
            inner.setWheelScrollingEnabled(false);
            inner.addMouseWheelListener(e -> {
                JScrollBar bar = inspectorScroll.getVerticalScrollBar();
                int step = 24;
                bar.setValue(bar.getValue() + (e.getWheelRotation() < 0 ? -step : step));
                e.consume();
            });
        }
        outer.add(inspectorScroll, BorderLayout.CENTER); return outer;
    }

    private JComponent outputPanel() {
        log.setEditable(false); log.setLineWrap(true); log.setFont(new Font("Consolas", Font.PLAIN, 13));
        JScrollPane scroll=new JScrollPane(log);scroll.setPreferredSize(new Dimension(320,190));return scroll;
    }
    private JComponent errorPanel(){
        errors.setEditable(false);errors.setLineWrap(true);errors.setWrapStyleWord(true);errors.setFont(new Font("Consolas",Font.PLAIN,13));errors.setText("暂无编译或运行错误。");
        JScrollPane scroll=new JScrollPane(errors);scroll.setPreferredSize(new Dimension(320,190));return scroll;
    }
    private JComponent reviewPanel(){
        codeReviewPanel=new CodeReviewPanel(this::acceptDraft,this::rejectDraft,this::rollbackCode,this::refreshReview);
        return codeReviewPanel;
    }
    private JComponent queuePanel(){
        JPanel panel=new JPanel(new BorderLayout());JPanel actions=new JPanel(new FlowLayout(FlowLayout.LEFT,5,4));actions.add(button("刷新队列",this::refreshQueue));actions.add(button("取消申请",this::cancelRequest));actions.add(new JLabel("本地申请槽实时状态"));panel.add(actions,BorderLayout.NORTH);panel.add(new JScrollPane(queueList),BorderLayout.CENTER);panel.setPreferredSize(new Dimension(320,190));return panel;
    }

    private JComponent statusBar() {
        JPanel bar = new JPanel(new BorderLayout()); bar.setBackground(UiTheme.TOOLBAR); bar.setBorder(new EmptyBorder(4, 5, 4, 8));
        status.setForeground(UiTheme.TEXT); bar.add(status, BorderLayout.WEST);
        JLabel queueState = new JLabel("本地文件队列  |  UTF-8  |  Java 21"); queueState.setForeground(UiTheme.MUTED);
        JPanel eastPanel=new JPanel(new FlowLayout(FlowLayout.LEFT,12,0));eastPanel.setOpaque(false);
        spaceMode.setForeground(UiTheme.ACCENT);eastPanel.add(spaceMode);eastPanel.add(queueState);
        bar.add(eastPanel, BorderLayout.EAST); return bar;
    }

    private static JPanel emptyPanel(String text) { JPanel p = new JPanel(new BorderLayout()); JLabel l = new JLabel("  " + text); l.setForeground(UiTheme.MUTED); p.add(l, BorderLayout.NORTH); return p; }
    private static JSeparator separator() { JSeparator s = new JSeparator(SwingConstants.VERTICAL); s.setPreferredSize(new Dimension(8, 25)); s.setForeground(UiTheme.BORDER); return s; }
    private static JComponent fixedField(JTextField field) { field.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30)); field.setAlignmentX(Component.LEFT_ALIGNMENT); return field; }
    private static JLabel label(String text) { JLabel label = new JLabel(text); label.setAlignmentX(Component.LEFT_ALIGNMENT); label.setForeground(UiTheme.TEXT); label.setBorder(new EmptyBorder(0, 0, 4, 0)); return label; }
    private JButton button(String text, Runnable action) { JButton button = new JButton(text); button.addActionListener(e -> action.run()); return button; }
    private JMenuItem item(String text, Runnable action) { JMenuItem item = new JMenuItem(text); item.addActionListener(e -> action.run()); return item; }
    private JMenu menu(String title, JMenuItem... items) { JMenu menu = new JMenu(title); for (JMenuItem item : items) menu.add(item); return menu; }

    private void addNode() { if(projectReadOnly)return;WorkflowModel.Node node = model.addNode(120 + model.nodes().size() * 35, 120 + model.nodes().size() * 25); canvas.select(node);commitHistory();canvas.repaint(); }
    private void newProject(){
        if(!confirmDiscardOrSave())return;
        model.clear();canvas.select(null);canvas.setView(0,0);currentProjectFile=null;documentId=UUID.randomUUID().toString();documentCreatedAt=Instant.now();projectReadOnly=false;executableOutput="output";markdownOutput="output/docs";displayedMode=WorkflowModel.Mode.EXECUTABLE;
        loadingProject=true;mode.setSelectedItem(WorkflowModel.Mode.EXECUTABLE);language.setSelectedItem("java");output.setText(executableOutput);loadingProject=false;setProjectEditable(true);dirty=false;resetHistory();refreshDocumentTitle();status.setText("  新工程  |  自动保存间隔 15 分钟");canvas.repaint();
    }
    private void openProject(){JFileChooser chooser=projectChooser(false);if(chooser.showOpenDialog(this)==JFileChooser.APPROVE_OPTION)openProject(chooser.getSelectedFile().toPath());}
    public NodeControlApi nodeControlApi(){ return nodeControlApi; }
    void openProject(Path file){
        if(!confirmDiscardOrSave())return;
        try{
            CnodeProjectCodec.Loaded loaded=projectCodec.load(file);Path root=file.toAbsolutePath().normalize().getParent();var checkpoint=recovery.newerCheckpoint(root,loaded.metadata().documentId(),file);
            if(checkpoint.isPresent()&&JOptionPane.showConfirmDialog(this,"发现比正式工程更新的 15 分钟自动保存快照，是否恢复？","CodeNode 恢复",JOptionPane.YES_NO_OPTION)==JOptionPane.YES_OPTION)loaded=projectCodec.load(checkpoint.get());
            applyLoaded(loaded,file.toAbsolutePath().normalize());append("已打开工程："+file);
        }catch(Exception e){error(e);}
    }
    private void applyLoaded(CnodeProjectCodec.Loaded loaded,Path file){
        model.replaceFrom(loaded.model());CnodeProjectCodec.Metadata metadata=loaded.metadata();CnodeProjectCodec.Settings settings=metadata.settings();currentProjectFile=file;syncProjectLocation(file);rememberRecent(file);documentId=metadata.documentId();documentCreatedAt=metadata.createdAt();projectReadOnly=loaded.readOnly();executableOutput=settings.executablePath();markdownOutput=settings.markdownPath();displayedMode=settings.mode();
        loadingProject=true;mode.setSelectedItem(settings.mode());language.setSelectedItem(settings.language());output.setText(settings.mode()==WorkflowModel.Mode.EXECUTABLE?executableOutput:markdownOutput);loadingProject=false;canvas.setView(settings.panX(),settings.panY(),settings.zoom());canvas.selectNodes(settings.selectedNodeIds().stream().map(model::byId).toList());setProjectEditable(!projectReadOnly);
        dirty=false;resetHistory();refreshDocumentTitle();status.setText(projectReadOnly?"  使用更高格式版本，只读打开":"  已加载  |  "+file);canvas.repaint();
    }
    private void saveProject(){if(projectReadOnly){error(new IllegalStateException("更高版本工程只能只读打开"));return;}if(currentProjectFile==null){saveProjectAs();return;}saveProjectTo(currentProjectFile,true);}
    private void saveProjectAs(){if(projectReadOnly){error(new IllegalStateException("更高版本工程不能另存为当前格式"));return;}JFileChooser chooser=projectChooser(true);if(chooser.showSaveDialog(this)!=JFileChooser.APPROVE_OPTION)return;Path target=chooser.getSelectedFile().toPath();if(!target.getFileName().toString().toLowerCase().endsWith(".cnode"))target=target.resolveSibling(target.getFileName()+".cnode");saveProjectTo(target.toAbsolutePath().normalize(),true);}
    private void saveProjectTo(Path target,boolean clearRecovery){
        try{target=target.toAbsolutePath().normalize();saveInspector();storeActiveOutput();projectCodec.save(target,model,metadata(projectName(target)));currentProjectFile=target;syncProjectLocation(target);rememberRecent(target);if(clearRecovery)recovery.clear(target.getParent(),documentId);dirty=false;refreshDocumentTitle();status.setText("  已保存  |  "+target);append("工程已保存："+target);}catch(Exception e){error(e);}
    }
    private void autoSave(){
        if(currentProjectFile==null||projectReadOnly||!dirty)return;try{saveInspector();storeActiveOutput();Path root=currentProjectFile.getParent();recovery.saveCheckpoint(root,model,metadata());projectCodec.save(currentProjectFile,model,metadata());recovery.clear(root,documentId);dirty=false;refreshDocumentTitle();status.setText("  已自动保存（15 分钟）  |  "+currentProjectFile);append("15 分钟自动保存完成："+currentProjectFile);}catch(Exception e){append("自动保存失败，已保留恢复快照："+e.getMessage());status.setText("  自动保存失败");}
    }
    private CnodeProjectCodec.Metadata metadata(){return metadata(projectName());}
    private CnodeProjectCodec.Metadata metadata(String name){return new CnodeProjectCodec.Metadata(documentId,name,documentCreatedAt,currentSettings());}
    private CnodeProjectCodec.Settings currentSettings(){WorkflowModel.Node selected=canvas.selected();return new CnodeProjectCodec.Settings((WorkflowModel.Mode)mode.getSelectedItem(),String.valueOf(language.getSelectedItem()),executableOutput,markdownOutput,selected==null?null:selected.id,canvas.panX(),canvas.panY(),canvas.zoom(),selected==null?null:selected.id,selectedNodeIds());}
    private List<String> selectedNodeIds(){List<String> ids=new ArrayList<>(canvas.selectedNodes().stream().map(node->node.id).toList());WorkflowModel.Node primary=canvas.selected();if(primary!=null){ids.remove(primary.id);ids.add(primary.id);}return List.copyOf(ids);}
    private String projectName(){if(currentProjectFile==null)return "未命名";String name=currentProjectFile.getFileName().toString();return name.toLowerCase().endsWith(".cnode")?name.substring(0,name.length()-6):name;}
    private String projectName(Path file){String name=file.getFileName().toString();return name.toLowerCase().endsWith(".cnode")?name.substring(0,name.length()-6):name;}
    private void storeActiveOutput(){String value=output.getText().trim();if(displayedMode==WorkflowModel.Mode.EXECUTABLE)executableOutput=value;else markdownOutput=value;}
    private void setProjectEditable(boolean editable){canvas.setEditable(editable);nodeName.setEditable(editable);prompt.setEditable(editable);artifact.setEditable(editable);fileOwner.setEnabled(editable);parentScope.setEnabled(editable);operation.setEnabled(editable);portTable.setEnabled(editable);output.setEditable(editable);mode.setEnabled(editable);language.setEnabled(editable);agentProvider.setEnabled(editable);}
    private JFileChooser projectChooser(boolean save){Path start=currentProjectFile==null?Path.of(project.getText()):currentProjectFile.getParent();JFileChooser chooser=new JFileChooser(start.toFile());chooser.setFileSelectionMode(JFileChooser.FILES_ONLY);chooser.setFileFilter(new FileNameExtensionFilter("CodeNode 工程 (*.cnode)","cnode"));if(save)chooser.setSelectedFile(new java.io.File(currentProjectFile==null?"未命名.cnode":currentProjectFile.getFileName().toString()));return chooser;}
    private void syncProjectLocation(Path file){Path parent=file.toAbsolutePath().normalize().getParent();if(parent!=null)project.setText(parent.toString());}
    private void loadRecentProjects(){String saved=preferences.get("recentProjects","");if(saved.isBlank())return;for(String value:saved.split("\\R")){try{Path file=Path.of(value).toAbsolutePath().normalize();if(Files.isRegularFile(file)&&!recentProjects.contains(file))recentProjects.add(file);}catch(InvalidPathException ignored){}}persistRecentProjects();}
    private void rememberRecent(Path file){Path normalized=file.toAbsolutePath().normalize();recentProjects.remove(normalized);recentProjects.addFirst(normalized);while(recentProjects.size()>10)recentProjects.removeLast();persistRecentProjects();}
    private void persistRecentProjects(){try{preferences.put("recentProjects",String.join("\n",recentProjects.stream().map(Path::toString).toList()));}catch(RuntimeException ignored){}}
    private void showRecentProjects(Component anchor){recentProjects.removeIf(path->!Files.isRegularFile(path));persistRecentProjects();JPopupMenu menu=new JPopupMenu();if(recentProjects.isEmpty()){JMenuItem empty=new JMenuItem("暂无最近文件");empty.setEnabled(false);menu.add(empty);}else for(Path path:List.copyOf(recentProjects)){JMenuItem item=new JMenuItem(path.getFileName()+"  —  "+path.getParent());item.setToolTipText(path.toString());item.addActionListener(e->openProject(path));menu.add(item);}UiTheme.apply(menu);menu.show(anchor,0,anchor.getHeight());}
    private void chooseProject() { JFileChooser chooser = new JFileChooser(project.getText()); chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY); if (chooser.showOpenDialog(this) == JFileChooser.APPROVE_OPTION) { project.setText(chooser.getSelectedFile().getAbsolutePath()); initializeProject(true); } }
    private void initializeProject(boolean announce) { try { queue = new QueueService(Path.of(project.getText())); results = new ResultService(queue.stateRoot());int restored=queue.restoreActiveStatuses(model); refreshQueue();status.setText("  就绪  |  " + queue.projectRoot()); if (announce) append("项目申请槽已初始化：" + queue.stateRoot());if(restored>0)append("已从本地申请槽恢复 "+restored+" 个节点状态"); } catch (Exception e) { error(e); } }
    private void updateMode() { if(loadingProject)return;markDirty();storeActiveOutput();WorkflowModel.Mode next=(WorkflowModel.Mode)mode.getSelectedItem();displayedMode=next;boolean code=next==WorkflowModel.Mode.EXECUTABLE;loadingProject=true;output.setText(code?executableOutput:markdownOutput);loadingProject=false;language.setEnabled(!projectReadOnly);status.setText("  " + next + "  |  就绪"); updateSpaceModeLabel(); canvas.repaint(); if(analysisBtn!=null)analysisBtn.setEnabled(next==WorkflowModel.Mode.MARKDOWN); }
    private void updateSpaceModeLabel(){
        WorkflowModel.Mode current=(WorkflowModel.Mode)mode.getSelectedItem();
        if(current!=WorkflowModel.Mode.MARKDOWN){spaceMode.setText("");return;}
        boolean hasFileNode=model.nodes().stream().anyMatch(n->n.nodeKind==WorkflowModel.NodeKind.FILE);
        long fileCount=model.nodes().stream().filter(n->n.nodeKind==WorkflowModel.NodeKind.FILE).count();
        spaceMode.setText(hasFileNode?"实体文件空间（"+fileCount+" 个文件空间）":"虚拟文件空间");
    }
    private void loadInspector(WorkflowModel.Node node) { loadingInspector=true;boolean enabled = node != null; nodeName.setEnabled(enabled); prompt.setEnabled(enabled); artifact.setEnabled(enabled);populateOwnerChoices(fileOwner,node,WorkflowModel.NodeKind.FILE,node==null?"":node.fileNodeId);populateOwnerChoices(parentScope,node,WorkflowModel.NodeKind.SCOPE,node==null?"":node.parentScopeId);operation.removeAllItems();if(node!=null)for(String value:NodeRegistry.operations(node))operation.addItem(value);if(node!=null&&!node.operation.isBlank())operation.setSelectedItem(node.operation);fileOwner.setEnabled(enabled&&!projectReadOnly&&node.nodeKind!=WorkflowModel.NodeKind.FILE);parentScope.setEnabled(enabled&&!projectReadOnly);operation.setEnabled(enabled&&!projectReadOnly&&operation.getItemCount()>0);portTable.setEnabled(enabled&&!projectReadOnly);portModel.setNode(node); nodePath.setText(node == null ? "工作流 / 未选择节点" : "工作流  ›  " + node.id); if (node == null) { nodeName.setText(""); prompt.setText(""); artifact.setText("");nodeColor.setText("");rangeMode.setSelected(false);assetTypeCombo.setSelectedItem("image");bundleData.setText("");assetPreview.setIcon(null); } else { nodeName.setText(node.name); prompt.setText(node.prompt); artifact.setText(node.artifact);nodeColor.setText(node.nodeColor);rangeMode.setSelected(node.rangeMode);rangeMode.setEnabled(enabled&&!projectReadOnly&&node.nodeKind==WorkflowModel.NodeKind.FILE);if(!node.assetType.isBlank()&&containsItem(assetTypeCombo,node.assetType))assetTypeCombo.setSelectedItem(node.assetType);assetTypeCombo.setEnabled(enabled&&!projectReadOnly&&(node.nodeKind==WorkflowModel.NodeKind.ASSET||node.nodeKind==WorkflowModel.NodeKind.ASSET_BUNDLE));bundleData.setText(node.bundleData);bundleData.setEnabled(enabled&&!projectReadOnly&&node.nodeKind==WorkflowModel.NodeKind.ASSET_BUNDLE);expandBundleBtn.setEnabled(enabled&&!projectReadOnly&&node.nodeKind==WorkflowModel.NodeKind.ASSET_BUNDLE);updateAssetPreview(node);nodeColor.setEnabled(enabled&&!projectReadOnly);}loadingInspector=false;refreshReview();if(inspectorScroll!=null)SwingUtilities.invokeLater(()->inspectorScroll.getViewport().setViewPosition(new Point(0,0))); }
    private void populateOwnerChoices(JComboBox<NodeOwnerChoice> combo,WorkflowModel.Node selected,WorkflowModel.NodeKind kind,String currentId){combo.removeAllItems();NodeOwnerChoice none=new NodeOwnerChoice("","未指定");combo.addItem(none);NodeOwnerChoice chosen=none;for(WorkflowModel.Node candidate:model.nodes())if(candidate.nodeKind==kind&&candidate!=selected&&!(kind==WorkflowModel.NodeKind.SCOPE&&scopeAncestor(selected,candidate))){NodeOwnerChoice choice=new NodeOwnerChoice(candidate.id,candidate.name+"  ["+candidate.id+"]");combo.addItem(choice);if(candidate.id.equals(currentId))chosen=choice;}combo.setSelectedItem(chosen);}
    private boolean scopeAncestor(WorkflowModel.Node ancestor,WorkflowModel.Node candidate){if(ancestor==null||ancestor.nodeKind!=WorkflowModel.NodeKind.SCOPE)return false;Set<String> seen=new HashSet<>();for(WorkflowModel.Node current=candidate;current!=null&&!current.parentScopeId.isBlank()&&seen.add(current.id);current=model.byId(current.parentScopeId))if(current.parentScopeId.equals(ancestor.id))return true;return false;}
    private void addPort(boolean outputPort){if(projectReadOnly)return;WorkflowModel.Node node=canvas.selected();if(node==null)return;model.addPort(node,outputPort);portModel.setNode(node);commitHistory();canvas.repaint();}
    private void removePort(){if(projectReadOnly)return;WorkflowModel.Node node=canvas.selected();int row=portTable.getSelectedRow();WorkflowModel.Port port=portModel.portAt(row);if(node==null||port==null)return;model.removePort(node,port,portModel.outputAt(row));portModel.setNode(node);commitHistory();canvas.repaint();}
    private void refreshReview(){WorkflowModel.Node node=canvas.selected();WorkflowModel.CodeSlot slot=selectedCodeSlot();if(codeReviewPanel!=null)codeReviewPanel.loadFrom(node,slot);}
    private void saveInspector() { if(projectReadOnly)return;WorkflowModel.Node node = canvas.selected(); if (node == null) return;String name=nodeName.getText().trim(),responsibility=prompt.getText().trim(),path=artifact.getText().trim();String fileId=node.nodeKind==WorkflowModel.NodeKind.FILE?"":ownerId(fileOwner),scopeId=node.nodeKind==WorkflowModel.NodeKind.SCOPE?"":ownerId(parentScope),nextOperation=operation.getSelectedItem()==null?node.operation:String.valueOf(operation.getSelectedItem());String color=nodeColor.getText().trim();boolean wasRange=node.rangeMode,nextRange=rangeMode.isSelected();boolean changed=!node.name.equals(name)||!node.prompt.equals(responsibility)||!node.artifact.equals(path)||!node.fileNodeId.equals(fileId)||!node.parentScopeId.equals(scopeId)||!node.operation.equals(nextOperation)||!node.nodeColor.equals(color)||node.rangeMode!=nextRange||!node.assetType.equals(Objects.toString(assetTypeCombo.getSelectedItem(),node.assetType))||!node.bundleData.equals(Objects.toString(bundleData.getText(),""));node.name=name;node.prompt=responsibility;node.artifact=path;node.fileNodeId=fileId;node.parentScopeId=scopeId;node.nodeColor=color;node.assetType=Objects.toString(assetTypeCombo.getSelectedItem(),"");node.bundleData=Objects.toString(bundleData.getText(),"");if(node.nodeKind==WorkflowModel.NodeKind.FILE&&wasRange!=nextRange){node.rangeMode=nextRange;if(wasRange&&!nextRange){List<WorkflowModel.Node> children=model.nodes().stream().filter(n->n.fileNodeId.equals(node.id)).toList();for(WorkflowModel.Node child:children)child.fileNodeId="";}}if(!node.operation.equals(nextOperation)&&!nextOperation.isBlank()){int removed=NodeRegistry.applyOperation(model,node,nextOperation);if(removed>0)append("切换运算时移除了 "+removed+" 条不兼容连线");}if(changed){commitHistory();append("已更新 " + node.id);}portModel.setNode(node);canvas.repaint(); }
    private static String ownerId(JComboBox<NodeOwnerChoice> combo){Object selected=combo.getSelectedItem();return selected instanceof NodeOwnerChoice choice?choice.id():"";}
    private void submitSelected(){Set<WorkflowModel.Node> nodes=canvas.selectedNodes();if(nodes.size()>1){submit(QueueService.SubmitTarget.multi(new ArrayList<>(nodes),canvas.selected()));}else{submit(QueueService.SubmitTarget.selected(canvas.selected()));}}
    private void submitGroup(WorkflowModel.Node outputNode){submit(QueueService.SubmitTarget.group(outputNode));}
    private void analyzeProject(){
        JFileChooser chooser = new JFileChooser(project.getText());
        chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
        chooser.setDialogTitle("选择要分析的项目根目录");
        if(chooser.showOpenDialog(this)!=JFileChooser.APPROVE_OPTION)return;
        Path projectDir = chooser.getSelectedFile().toPath().toAbsolutePath().normalize();
        if(!Files.isDirectory(projectDir)){error(new IllegalArgumentException("选择的路径不是有效目录"));return;}
        Thread.startVirtualThread(()->{
            try{
                if(queue==null||!queue.projectRoot().equals(Path.of(project.getText()).toAbsolutePath().normalize()))initializeProject(false);
                List<ProjectAnalysisService.FileMeta> files = ProjectAnalysisService.scanDirectory(projectDir);
                if(files.isEmpty()){
                    SwingUtilities.invokeLater(()->append("项目分析：未在 " + projectDir + " 中发现受支持的源文件"));
                    return;
                }
                String stamp = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS").withZone(java.time.ZoneOffset.UTC).format(Instant.now());
                String requestId = "analysis-" + stamp;
                Path staging = queue.stateRoot().resolve("queue/staging").resolve(requestId);
                Path inbox = queue.stateRoot().resolve("queue/inbox").resolve(requestId);
                Map<String,Object> request = ProjectAnalysisService.buildAnalysisRequest(projectDir, queue.stateRoot(), files, requestId);
                Files.createDirectories(staging);
                Files.writeString(staging.resolve("request.json"), Json.stringify(request), StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
                StringBuilder requestMd = new StringBuilder("# 项目分析申请 " + requestId + "\n\n");
                requestMd.append("- 项目根目录: `").append(projectDir).append("`\n");
                requestMd.append("- 源文件总数: ").append(files.size()).append("\n");
                requestMd.append("- 模式: `analysis`\n");
                requestMd.append("- 操作: `analyze-project`\n\n");
                requestMd.append("## 目录结构\n\n```text\n");
                requestMd.append(ProjectAnalysisService.generateDirectoryTree(projectDir, files));
                requestMd.append("\n```\n\n## 文件清单\n\n");
                for(ProjectAnalysisService.FileMeta f : files)
                    requestMd.append("- `").append(f.relativePath()).append("` (").append(f.language()).append(", ").append(f.lineCount()).append("行)\n");
                Files.writeString(staging.resolve("request.md"), requestMd.toString(), StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
                try{Files.move(staging, inbox, StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException e){Files.move(staging, inbox);}
                SwingUtilities.invokeLater(()->{append("项目分析申请已提交: " + requestId + " | 目录: " + projectDir + " | 文件数: " + files.size());refreshQueue();});
                Map<String,Object> result = ProjectAnalysisService.processAnalysis(inbox, queue.stateRoot().resolve("results"));
                SwingUtilities.invokeLater(()->{
                    append("项目分析完成: " + requestId + " | " + result.get("summary"));
                    pollResults();
                });
            }catch(Exception e){
                SwingUtilities.invokeLater(()->error(e));
            }
        });
    }
    private void analyzeProjectFull(){
        String rootText=project.getText().trim();
        if(rootText.isEmpty()){JOptionPane.showMessageDialog(this,"请先在上方输入框填写项目根目录（如 E:\\TeaCraft\\Branch.1\\TeaCraft）","项目全量解析",JOptionPane.WARNING_MESSAGE);return;}
        Path projectDir=Path.of(rootText).toAbsolutePath().normalize();
        if(!Files.isDirectory(projectDir)){JOptionPane.showMessageDialog(this,"目录不存在: "+projectDir,"项目全量解析",JOptionPane.ERROR_MESSAGE);return;}
        append("[项目全量解析] 开始扫描: "+projectDir);
        Thread.startVirtualThread(()->{
            try{
                if(queue==null||!queue.projectRoot().equals(projectDir))initializeProject(false);
                WorkflowModel result=ProjectAnalysisService.scanProject(projectDir);
                SwingUtilities.invokeLater(()->{
                    try{
                        saveInspector();storeActiveOutput();
                        model.replaceFrom(result);
                        canvas.repaint();
                        String stamp=DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS").withZone(java.time.ZoneOffset.UTC).format(Instant.now());
                        Path target=projectDir.resolve("项目全量解析-"+stamp+".cnode").toAbsolutePath().normalize();
                        projectCodec.save(target,model,metadata("项目全量解析"));
                        commitHistory();
                        status.setText("  全量解析完成  |  节点="+model.nodes().size()+" 边="+model.edges().size());
                        append("[项目全量解析完成] 节点="+model.nodes().size()+" 边="+model.edges().size()+" 已保存: "+target);
                    }catch(Exception e){error(e);}
                });
            }catch(Exception e){
                SwingUtilities.invokeLater(()->error(e));
            }
        });
    }
    private void submit(QueueService.SubmitTarget target){try{saveInspector();if(queue==null||!queue.projectRoot().equals(Path.of(project.getText()).toAbsolutePath().normalize()))initializeProject(false);QueueService.Submission submission=queue.submit(model,(WorkflowModel.Mode)mode.getSelectedItem(),target,String.valueOf(language.getSelectedItem()),output.getText());if("Codex 自动".equals(agentProvider.getSelectedItem()))startCodexAgent(submission);else{Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(submission.codexPrompt()),null);append("已复制给 Codex 的手动处理指令："+submission.codexPrompt());}refreshQueue();append("已提交 "+submission.requestId()+"\n位置："+submission.inboxPath()+"\n目标代码槽："+submission.codeSlotIds());status.setText("  已排队  |  "+submission.requestId());commitHistory();canvas.repaint();refreshReview();}catch(Exception e){error(e);}}
    private void startCodexAgent(QueueService.Submission submission) throws IOException {Path processing=queue.beginProcessing(submission.requestId());try{codexAgent.start(queue.projectRoot(),processing,message->SwingUtilities.invokeLater(()->{append(message);refreshQueue();pollResults();canvas.repaint();refreshReview();}));for(String slotId:submission.codeSlotIds())for(WorkflowModel.Node owner:codeSlotService.owners(model,slotId))owner.status=WorkflowModel.Status.PROCESSING;append("Codex Agent 已接收："+submission.requestId());}catch(IOException|RuntimeException failure){queue.returnToInbox(submission.requestId());throw failure;}}
    private void showSubmissionMenu(Component anchor){
        JPopupMenu menu=new JPopupMenu();
        WorkflowModel.Mode currentMode=(WorkflowModel.Mode)mode.getSelectedItem();
        boolean isMarkdownNoFile=currentMode==WorkflowModel.Mode.MARKDOWN
            && model.nodes().stream().noneMatch(n->n.nodeKind==WorkflowModel.NodeKind.FILE);
        if(isMarkdownNoFile){
            JMenuItem virtualHint=new JMenuItem("虚拟文件空间 — 仅支持组输出提交");
            virtualHint.setEnabled(false);
            menu.add(virtualHint);
            menu.addSeparator();
        }else{
            JMenuItem selectedItem=new JMenuItem("提交选择的节点到 Agent");
            selectedItem.setEnabled(canvas.selected()!=null&&canvas.selected().nodeKind!=WorkflowModel.NodeKind.GROUP_OUTPUT);
            selectedItem.addActionListener(e->submitSelected());
            menu.add(selectedItem);
            menu.addSeparator();
        }
        int index=0;
        for(WorkflowModel.Node group:model.groupOutputs()){
            if(!model.isValidGroupOutput(group))continue;
            index++;
            int count=model.upstreamOf(group).size();
            JMenuItem item=new JMenuItem("提交组输出 "+index+" 节点："+group.name+"（包含 "+count+" 个节点）");
            item.addActionListener(e->submitGroup(group));
            menu.add(item);
        }
        if(index==0){
            JMenuItem empty=new JMenuItem("没有可提交的组输出");
            empty.setEnabled(false);
            menu.add(empty);
        }
        UiTheme.apply(menu);
        Component target=anchor==null?getJMenuBar():anchor;
        menu.show(target,0,target.getHeight());
    }
    private WorkflowModel.CodeSlot selectedCodeSlot(){WorkflowModel.Node node=canvas.selected();if(node==null)return null;String id=model.codeSlotId(node,(WorkflowModel.Mode)mode.getSelectedItem());return id.isBlank()?null:model.codeSlot(id);}
    private void acceptDraft(){try{WorkflowModel.CodeSlot slot=selectedCodeSlot();if(slot==null)throw new IllegalStateException("当前节点没有代码槽");if(codeReviewPanel!=null&&codeReviewPanel.isDraftModified()){String editedCode=codeReviewPanel.getEditedDraftCode();if(slot.draft==null){slot.draft=new WorkflowModel.CodeDraft("manual",slot.activeRevision,editedCode,"foundation.object");}else{slot.draft.code=editedCode;}}codeSlotService.accept(model,slot.id);commitHistory();if(codeReviewPanel!=null)codeReviewPanel.resetModifiedFlag();refreshReview();canvas.repaint();append("已接受代码草稿："+slot.id);}catch(Exception e){error(e);}}
    private void rejectDraft(){try{WorkflowModel.CodeSlot slot=selectedCodeSlot();if(slot==null)throw new IllegalStateException("当前节点没有代码槽");codeSlotService.reject(model,slot.id);commitHistory();refreshReview();canvas.repaint();append("已拒绝代码草稿："+slot.id);}catch(Exception e){error(e);}}
    private void rollbackCode(){try{WorkflowModel.CodeSlot slot=selectedCodeSlot();if(slot==null)throw new IllegalStateException("当前节点没有代码槽");codeSlotService.rollback(model,slot.id);commitHistory();refreshReview();canvas.repaint();append("已回滚代码槽："+slot.id);}catch(Exception e){error(e);}}
    private void refreshQueue(){if(queue==null)return;try{queueItems.clear();for(QueueService.QueueEntry entry:queue.entries())queueItems.addElement(entry.toString());if(queueItems.isEmpty())queueItems.addElement("当前没有申请");}catch(IOException e){queueItems.clear();queueItems.addElement("读取队列失败："+e.getMessage());}}
    private void pollResults() { if (results == null) return; try {long before=model.revision(); for (String message : results.poll(model)) append(message);if(model.revision()!=before)commitHistory(); refreshQueue();canvas.repaint();refreshReview(); WorkflowModel.Node node = canvas.selected(); if (node != null && node.status == WorkflowModel.Status.FAILED && !node.diagnostic.isBlank()){String message="错误定位 [" + node.id + "] " + node.diagnostic;append(message);if(errors.getText().startsWith("暂无"))errors.setText("");errors.append((errors.getText().isEmpty()?"":"\n")+message);} } catch (IOException | RuntimeException e) { append("读取结果失败：" + e.getMessage()); } }
    private void cancelRequest(){if(queue==null||projectReadOnly)return;String selected=queueList.getSelectedValue();if(selected==null){JOptionPane.showMessageDialog(this,"请先在队列中选中要取消的申请","提示",JOptionPane.INFORMATION_MESSAGE);return;}String requestId=selected.split("\\s+")[0];try{queue.cancel(requestId);refreshQueue();model.clearStatuses();queue.restoreActiveStatuses(model);canvas.repaint();append("已取消申请："+requestId);}catch(IOException e){error(e);}}
    private void ungroupNode(){if(projectReadOnly)return;WorkflowModel.Node node=canvas.selected();if(node==null||node.nodeKind!=WorkflowModel.NodeKind.GROUP){JOptionPane.showMessageDialog(this,"请先选中一个组节点","提示",JOptionPane.INFORMATION_MESSAGE);return;}int confirm=JOptionPane.showConfirmDialog(this,"确定要解开组「"+node.name+"」吗？组内子节点将移到上一层作用域。","解开组",JOptionPane.OK_CANCEL_OPTION);if(confirm!=JOptionPane.OK_OPTION)return;String parentId=node.parentScopeId;model.nodes().stream().filter(n->n.parentScopeId.equals(node.id)).forEach(n->n.parentScopeId=parentId);model.removeNode(node);commitHistory();canvas.repaint();loadInspector(null);}
    private void append(String message) { log.append((log.getText().isEmpty() ? "" : "\n") + message); log.setCaretPosition(log.getDocument().getLength()); }
    private void watch(javax.swing.text.JTextComponent component){component.getDocument().addDocumentListener(new DocumentListener(){private void changed(){if(!loadingProject&&!loadingInspector&&!projectReadOnly)markDirty();}@Override public void insertUpdate(DocumentEvent e){changed();}@Override public void removeUpdate(DocumentEvent e){changed();}@Override public void changedUpdate(DocumentEvent e){changed();}});}
    private void markDirty(){if(loadingProject||loadingInspector||projectReadOnly)return;if(!dirty){dirty=true;refreshDocumentTitle();}}
    private void installGlobalKeys(){bindGlobal("control S",this::saveProject);bindGlobal("control shift S",this::saveProjectAs);bindGlobal("control O",this::openProject);bindGlobal("control N",this::newProject);bindGlobal("control Z",this::undo);bindGlobal("control Y",this::redo);bindGlobal("control shift Z",this::redo);}
    private void bindGlobal(String key,Runnable action){String name="global-"+key;getRootPane().getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke(key),name);getRootPane().getActionMap().put(name,new AbstractAction(){@Override public void actionPerformed(ActionEvent e){action.run();}});}
    private void resetHistory(){undoHistory.clear();redoHistory.clear();historyCurrent=captureHistory();}
    private void commitHistory(){if(loadingProject||projectReadOnly)return;model.refreshFileSpaces();if(historyCurrent!=null){undoHistory.addLast(historyCurrent);while(undoHistory.size()>100)undoHistory.removeFirst();}redoHistory.clear();historyCurrent=captureHistory();markDirty();updateSpaceModeLabel();}
    private HistoryState captureHistory(){return new HistoryState(model.deepCopy(),selectedNodeIds(),canvas.panX(),canvas.panY(),canvas.zoom());}
    private void undo(){if(undoHistory.isEmpty()||projectReadOnly)return;redoHistory.addLast(captureHistory());HistoryState state=undoHistory.removeLast();restoreHistory(state);historyCurrent=captureHistory();markDirty();}
    private void redo(){if(redoHistory.isEmpty()||projectReadOnly)return;undoHistory.addLast(captureHistory());HistoryState state=redoHistory.removeLast();restoreHistory(state);historyCurrent=captureHistory();markDirty();}
    private void restoreHistory(HistoryState state){loadingProject=true;model.replaceFrom(state.model());canvas.setView(state.panX(),state.panY(),state.zoom());canvas.selectNodes(state.selectedNodeIds().stream().map(model::byId).toList());loadingProject=false;canvas.repaint();}
    private void refreshDocumentTitle(){String name=currentProjectFile==null?"未命名.cnode":currentProjectFile.getFileName().toString();String marker=dirty?" *":"";String readonly=projectReadOnly?" [只读]":"";documentTab.setText("  "+name+readonly+marker+"   ×  ");setTitle("CodeNode Desktop — "+name+readonly+marker);}
    private boolean confirmDiscardOrSave(){if(!dirty||projectReadOnly)return true;int choice=JOptionPane.showConfirmDialog(this,"当前工程有未保存修改。是否先保存？","CodeNode",JOptionPane.YES_NO_CANCEL_OPTION,JOptionPane.WARNING_MESSAGE);if(choice==JOptionPane.CANCEL_OPTION||choice==JOptionPane.CLOSED_OPTION)return false;if(choice==JOptionPane.YES_OPTION){saveProject();return !dirty;}return true;}
    private void closeApplication(){if(!confirmDiscardOrSave())return;dispose();System.exit(0);}
    @Override public void dispose(){resultPollTimer.stop();autoSaveTimer.stop();codexAgent.close();for(ToolWindow tool:new ToolWindow[]{inspectorTool,outputTool,errorTool,queueTool})if(tool!=null)tool.shutdown();super.dispose();}
    private void openAgentSettings(){
        AgentSettingsPanel panel = new AgentSettingsPanel(agentConfig);
        JDialog dialog = new JDialog(this, "Agent 设置", true);
        dialog.setContentPane(panel);
        dialog.setSize(430, 330);
        dialog.setLocationRelativeTo(this);
        dialog.setVisible(true);
    }
    private void error(Exception e) { JOptionPane.showMessageDialog(this, e.getMessage(), "CodeNode", JOptionPane.ERROR_MESSAGE); append("操作失败：" + e.getMessage()); status.setText("  操作失败"); }
    private boolean confirmAgentTool(String message) {
        final boolean[] result = {false};
        try { SwingUtilities.invokeAndWait(() -> result[0] = JOptionPane.showConfirmDialog(this, message, "Agent 工具确认", JOptionPane.OK_CANCEL_OPTION) == JOptionPane.OK_OPTION); } catch (Exception ignored) {}
        return result[0];
    }
    private static boolean containsItem(JComboBox<String> combo,String item){for(int i=0;i<combo.getItemCount();i++)if(combo.getItemAt(i).equals(item))return true;return false;}
    private void updateAssetPreview(WorkflowModel.Node node){
        if(node==null||!NodeRegistry.isImageAsset(node.relativePath)){assetPreview.setIcon(null);assetPreview.setText("");return;}
        try{Path assetRoot=currentProjectFile!=null?currentProjectFile.getParent():Path.of(project.getText());Path imagePath=assetRoot.resolve(node.relativePath);if(Files.isRegularFile(imagePath)){ImageIcon icon=new ImageIcon(imagePath.toString());if(icon.getIconWidth()>0){Image scaled=icon.getImage().getScaledInstance(280,140,Image.SCALE_SMOOTH);assetPreview.setIcon(new ImageIcon(scaled));assetPreview.setText("");}else{assetPreview.setIcon(null);assetPreview.setText("无法预览");}}else{assetPreview.setIcon(null);assetPreview.setText("文件不存在: "+imagePath);}}catch(Exception e){assetPreview.setIcon(null);assetPreview.setText("预览失败: "+e.getMessage());}
    }
    private void expandBundle(){
        WorkflowModel.Node node=canvas.selected();if(node==null||node.nodeKind!=WorkflowModel.NodeKind.ASSET_BUNDLE)return;
        List<WorkflowModel.Node> created=model.expandAssetBundle(node);if(!created.isEmpty()){canvas.selectNodes(created);commitHistory();canvas.repaint();append("已从资源组展开 "+created.size()+" 个资产节点");}
    }
    private void analyzeFileContent(){
        WorkflowModel.Node node=canvas.selected();if(node==null||(node.nodeKind!=WorkflowModel.NodeKind.FILE&&node.nodeKind!=WorkflowModel.NodeKind.ASSET))return;
        try{Path root=currentProjectFile!=null?currentProjectFile.getParent():Path.of(project.getText());Path file=root.resolve(node.relativePath);if(Files.isRegularFile(file)){FileContentAnalyzer.FileSummary summary=FileContentAnalyzer.analyze(file);node.prompt=summary.toPrompt();commitHistory();loadInspector(node);canvas.repaint();append("已分析文件内容: "+node.relativePath);}else{append("文件不存在: "+file);}}catch(Exception e){error(e);}
    }
    private void expandFileToRange(){
        WorkflowModel.Node node=canvas.selected();if(node==null||(node.nodeKind!=WorkflowModel.NodeKind.FILE&&node.nodeKind!=WorkflowModel.NodeKind.ASSET))return;
        try{Path root=currentProjectFile!=null?currentProjectFile.getParent():Path.of(project.getText());Path file=root.resolve(node.relativePath);
            if(!Files.isRegularFile(file)){
                node.rangeMode=true;node.containerWidth=520;node.containerHeight=320;
                commitHistory();loadInspector(node);canvas.repaint();
                append("虚拟相对路径文件不存在，已按范围节点展开（跳过内容分析）: "+node.relativePath);
                return;
            }
            FileContentAnalyzer.FileSummary summary=FileContentAnalyzer.analyze(file);
            node.rangeMode=true;node.prompt=summary.toPrompt();
            List<Map<String,Object>> specs=FileContentAnalyzer.generateNodesForExpansion(model,summary,node.x+40,node.y+HEADER+70);
            for(Map<String,Object> spec:specs){
                WorkflowModel.Node child=model.addNode(((Number)spec.get("x")).intValue(),((Number)spec.get("y")).intValue());
                child.name=String.valueOf(spec.get("name"));child.prompt="自动解析自 "+node.relativePath;child.fileNodeId=node.id;
                child.nodeKind=WorkflowModel.NodeKind.REGULAR;child.codeBearing=false;
                child.category=switch(String.valueOf(spec.get("type"))){case "import"->"导入";case "function"->"函数";case "variable"->"变量";case "class"->"类";default->"解析";};
            }
            commitHistory();canvas.select(node);loadInspector(node);canvas.repaint();append("已展开文件为范围模式: "+node.relativePath);
        }catch(Exception e){error(e);}
    }
    private void indexLocalFile(){
        if(projectReadOnly)return;
        Path root=(currentProjectFile!=null?currentProjectFile.getParent():Path.of(project.getText())).toAbsolutePath().normalize();
        JFileChooser chooser=new JFileChooser(root.toFile());
        chooser.setFileSelectionMode(JFileChooser.FILES_ONLY);
        if(chooser.showOpenDialog(this)!=JFileChooser.APPROVE_OPTION)return;
        Path file=chooser.getSelectedFile().toPath().toAbsolutePath().normalize();
        String relative;
        if(file.startsWith(root)){
            relative=root.relativize(file).toString().replace('\\','/');
        }else{
            try{
                Path targetDir=root.resolve("output/imports").toAbsolutePath().normalize();
                Files.createDirectories(targetDir);
                String name=file.getFileName().toString();
                Path target=targetDir.resolve(name);
                int i=1;
                while(Files.exists(target)){
                    String base=name.contains(".")?name.substring(0,name.lastIndexOf('.')):name;
                    String ext=name.contains(".")?name.substring(name.lastIndexOf('.')):"";
                    target=targetDir.resolve(base+"-"+i+ext);i++;
                }
                Files.copy(file,target);
                relative=root.relativize(target).toString().replace('\\','/');
            }catch(IOException e){error(e);return;}
        }
        WorkflowModel.Node node=canvas.selected();
        boolean created=false;
        if(node==null||(node.nodeKind!=WorkflowModel.NodeKind.FILE&&node.nodeKind!=WorkflowModel.NodeKind.ASSET)){
            Point p=newNodePosition();
            node=model.addFileNode(p.x,p.y,file.getFileName().toString(),relative);
            canvas.select(node);created=true;
        }else{
            node.relativePath=relative;
            if(node.name.isBlank()||node.name.equals("文件节点")||node.name.equals("范围文件"))node.name=file.getFileName().toString();
        }
        commitHistory();loadInspector(node);canvas.repaint();
        append((created?"已创建文件节点并索引本地文件: ":"已更新文件节点索引: ")+relative);
    }
    private void createVirtualFileNode(){
        if(projectReadOnly)return;
        String relative=JOptionPane.showInputDialog(this,"输入项目内相对路径（文件可不存在，作为虚拟路径，如 output/agent/note.md）：","新建相对路径",JOptionPane.PLAIN_MESSAGE);
        if(relative==null)return;
        relative=relative.trim();
        if(relative.isBlank()){JOptionPane.showMessageDialog(this,"相对路径不能为空");return;}
        Path p=Path.of(relative).normalize();
        if(p.isAbsolute()||p.startsWith("..")){JOptionPane.showMessageDialog(this,"请输入项目内的相对路径（不允许绝对路径或 ../）");return;}
        String normalized=relative.replace('\\','/');
        Point pos=newNodePosition();
        WorkflowModel.Node node=model.addFileNode(pos.x,pos.y,"文件节点",normalized);
        canvas.select(node);
        commitHistory();loadInspector(node);canvas.repaint();
        append("已创建虚拟文件节点: "+normalized);
    }
    private Point newNodePosition(){
        Rectangle view=canvas.getVisibleRect();
        double cx=view.x+view.width/2.0,cy=view.y+view.height/2.0;
        int wx=(int)Math.max(0,(cx-canvas.panX())/canvas.zoom()-60);
        int wy=(int)Math.max(0,(cy-canvas.panY())/canvas.zoom()-30);
        return new Point(wx,wy);
    }
    private static final int HEADER=34;
    private record HistoryState(WorkflowModel model,List<String> selectedNodeIds,int panX,int panY,double zoom){}
    private record NodeOwnerChoice(String id,String label){@Override public String toString(){return label;}}
}
