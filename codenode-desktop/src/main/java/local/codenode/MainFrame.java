package local.codenode;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.awt.datatransfer.StringSelection;
import java.awt.event.*;
import java.io.IOException;
import java.nio.file.*;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class MainFrame extends JFrame {
    private final WorkflowModel model = new WorkflowModel();
    private final CanvasPanel canvas = new CanvasPanel(model);
    private final JComboBox<WorkflowModel.Mode> mode = new JComboBox<>(WorkflowModel.Mode.values());
    private final JComboBox<String> language = new JComboBox<>(new String[]{"java", "powershell", "go"});
    private final JTextField project = new JTextField(System.getProperty("user.home"), 25);
    private final JTextField output = new JTextField("output", 18);
    private final JTextField nodeName = new JTextField();
    private final JTextField artifact = new JTextField();
    private final JTextArea prompt = new JTextArea(7, 22);
    private final JTextArea log = new JTextArea(7, 80);
    private final JTextArea errors = new JTextArea(7, 50);
    private final JTextArea review = new JTextArea(9, 50);
    private final DefaultListModel<String> queueItems = new DefaultListModel<>();
    private final JList<String> queueList = new JList<>(queueItems);
    private final PortTableModel portModel = new PortTableModel();
    private final JTable portTable = new JTable(portModel);
    private final JLabel nodePath = new JLabel("工作流 / 未选择节点");
    private final JLabel status = new JLabel("  就绪");
    private QueueService queue;
    private ResultService results;
    private final EnumMap<ToolWindow.DockPosition,List<ToolWindow>> docked = new EnumMap<>(ToolWindow.DockPosition.class);
    private final EnumMap<ToolWindow.DockPosition,Integer> dockOrientation = new EnumMap<>(ToolWindow.DockPosition.class);
    private final Map<ToolWindow,Integer> tabGroup = new HashMap<>();
    private int tabGroupSequence=1;
    private JPanel dockRoot;
    private JComponent editor;
    private ToolWindow inspectorTool, outputTool, errorTool, reviewTool, queueTool;
    private JScrollPane inspectorScroll;

    public MainFrame() {
        super("CodeNode Desktop — 本地节点制作台");
        for(ToolWindow.DockPosition position:ToolWindow.DockPosition.values())docked.put(position,new ArrayList<>());
        dockOrientation.put(ToolWindow.DockPosition.LEFT,JSplitPane.VERTICAL_SPLIT);dockOrientation.put(ToolWindow.DockPosition.RIGHT,JSplitPane.VERTICAL_SPLIT);
        dockOrientation.put(ToolWindow.DockPosition.TOP,JSplitPane.HORIZONTAL_SPLIT);dockOrientation.put(ToolWindow.DockPosition.BOTTOM,JSplitPane.HORIZONTAL_SPLIT);
        setDefaultCloseOperation(WindowConstants.EXIT_ON_CLOSE);
        setMinimumSize(new Dimension(1180, 760));
        setJMenuBar(menuBar());
        setLayout(new BorderLayout());
        add(toolbar(), BorderLayout.NORTH);
        add(workbench(), BorderLayout.CENTER);
        add(statusBar(), BorderLayout.SOUTH);

        canvas.onSelection(this::loadInspector);
        canvas.setLanguageSupplier(() -> String.valueOf(language.getSelectedItem()));
        mode.addActionListener(e -> updateMode());
        WorkflowModel.Node first = model.addNode(100, 100), second = model.addNode(390, 220);
        first.name = "输入与解析"; second.name = "生成产物"; model.connect(first, second); canvas.select(second);
        initializeProject(false); updateMode();

        UiTheme.apply(getJMenuBar());
        UiTheme.apply(getContentPane());
        getContentPane().setBackground(UiTheme.BACKGROUND);
        new Timer(1800, e -> pollResults()).start();
        setSize(1500, 900); setLocationRelativeTo(null);SwingUtilities.invokeLater(()->inspectorScroll.getViewport().setViewPosition(new Point(0,0)));
    }

    private JMenuBar menuBar() {
        JMenuBar bar = new JMenuBar(); bar.setBorder(BorderFactory.createMatteBorder(0, 0, 1, 0, UiTheme.BORDER));
        JMenu file = menu("文件(F)", item("选择项目…", this::chooseProject), item("退出", this::dispose));
        JMenu edit = menu("编辑(E)", item("应用节点修改", this::saveInspector));
        JMenu view = menu("视图(V)", item("显示节点资源管理器", () -> inspectorTool.redock()), item("显示输出", () -> outputTool.redock()),item("显示错误列表",()->errorTool.redock()),item("显示代码审查",()->reviewTool.redock()),item("显示申请队列",()->queueTool.redock()));
        JMenu projectMenu = menu("项目(P)", item("初始化本地申请槽", () -> initializeProject(true)));
        JMenu build = menu("生成(B)", item("提交所选节点", () -> submit(true)), item("提交连接工作流", () -> submit(false)));
        JMenu debug = menu("调试(D)");
        JMenu tools = menu("工具(T)", item("刷新结果", this::pollResults));
        JMenu help = menu("帮助(H)");
        for (JMenu menu : new JMenu[]{file, edit, view, projectMenu, build, debug, tools, help}) bar.add(menu);
        return bar;
    }

    private JComponent toolbar() {
        JPanel toolbar = new JPanel(new FlowLayout(FlowLayout.LEFT, 7, 7));
        toolbar.setBackground(UiTheme.TOOLBAR); toolbar.setBorder(new EmptyBorder(1, 7, 1, 7));
        JButton choose = button("打开项目", this::chooseProject), init = button("初始化", () -> initializeProject(true));
        JButton add = button("＋ 添加节点", this::addNode), one = button("▷ 提交节点", () -> submit(true)), graph = button("▶ 提交工作流", () -> submit(false));
        toolbar.add(new JLabel("项目")); toolbar.add(project); toolbar.add(choose); toolbar.add(init); toolbar.add(separator());
        toolbar.add(new JLabel("模式")); toolbar.add(mode); toolbar.add(new JLabel("语言")); toolbar.add(language); toolbar.add(separator());
        toolbar.add(add); toolbar.add(one); toolbar.add(graph);
        return toolbar;
    }

    private JComponent workbench() {
        JScrollPane canvasScroll = new JScrollPane(canvas);
        canvasScroll.getHorizontalScrollBar().setUnitIncrement(20); canvasScroll.getVerticalScrollBar().setUnitIncrement(20);
        JPanel editorPanel = new JPanel(new BorderLayout()); editorPanel.add(documentTabs(), BorderLayout.NORTH); editorPanel.add(canvasScroll, BorderLayout.CENTER);editor=editorPanel;
        dockRoot=new JPanel(new BorderLayout());
        inspectorTool = new ToolWindow(this,"节点资源管理器",inspector(),collapsed -> rebuildDockLayout(),position -> dock(inspectorTool,position),()->toggleDockOrientation(inspectorTool));
        outputTool = new ToolWindow(this,"输出",outputPanel(),collapsed -> rebuildDockLayout(),position -> dock(outputTool,position),()->toggleDockOrientation(outputTool));
        errorTool = new ToolWindow(this,"错误列表",errorPanel(),collapsed -> rebuildDockLayout(),position -> dock(errorTool,position),()->toggleDockOrientation(errorTool));
        reviewTool = new ToolWindow(this,"代码审查",reviewPanel(),collapsed -> rebuildDockLayout(),position -> dock(reviewTool,position),()->toggleDockOrientation(reviewTool));
        queueTool = new ToolWindow(this,"申请队列",queuePanel(),collapsed -> rebuildDockLayout(),position -> dock(queueTool,position),()->toggleDockOrientation(queueTool));
        for(ToolWindow tool:List.of(inspectorTool,outputTool,errorTool,reviewTool,queueTool))tabGroup.put(tool,tabGroupSequence++);
        docked.get(ToolWindow.DockPosition.RIGHT).add(inspectorTool);
        docked.get(ToolWindow.DockPosition.BOTTOM).addAll(List.of(outputTool,errorTool,reviewTool,queueTool));
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
        SwingUtilities.invokeLater(()->split.setDividerLocation(leading?.24:.76));return split;
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
        JLabel active = new JLabel("  CodeNode.graph   ×  "); active.setOpaque(true); active.setBackground(UiTheme.BACKGROUND);
        active.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createMatteBorder(2, 0, 0, 0, UiTheme.ACCENT), new EmptyBorder(7, 8, 7, 8)));
        tabs.add(active); return tabs;
    }

    private JComponent inspector() {
        JPanel outer = new JPanel(new BorderLayout()); outer.setPreferredSize(new Dimension(335, 600));
        JPanel body = new JPanel(); body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS)); body.setBorder(new EmptyBorder(10, 11, 12, 11));
        nodePath.setForeground(UiTheme.MUTED); nodePath.setBorder(new EmptyBorder(0, 0, 9, 0)); nodePath.setAlignmentX(Component.LEFT_ALIGNMENT); body.add(nodePath);
        body.add(label("名称")); body.add(fixedField(nodeName)); body.add(Box.createVerticalStrut(10));
        body.add(label("Prompt / 文档职责")); prompt.setLineWrap(true); prompt.setWrapStyleWord(true);
        JScrollPane promptScroll = new JScrollPane(prompt); promptScroll.setMaximumSize(new Dimension(Integer.MAX_VALUE, 175)); promptScroll.setAlignmentX(Component.LEFT_ALIGNMENT); body.add(promptScroll); body.add(Box.createVerticalStrut(10));
        body.add(label("产物相对路径")); body.add(fixedField(artifact)); body.add(Box.createVerticalStrut(10));
        body.add(label("输入 / 输出端口"));portTable.setRowHeight(23);portTable.setFillsViewportHeight(true);portTable.getColumnModel().getColumn(0).setPreferredWidth(42);portTable.getColumnModel().getColumn(3).setPreferredWidth(38);
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
        JButton apply = button("应用节点修改", this::saveInspector); apply.setAlignmentX(Component.LEFT_ALIGNMENT); body.add(apply); body.add(Box.createVerticalGlue());
        JTextArea hint = new JTextArea("连线：从节点右侧端口拖到另一节点左侧端口。\n失败结果会标红节点，并在输出面板显示文件、行与列。");
        hint.setEditable(false); hint.setLineWrap(true); hint.setWrapStyleWord(true); hint.setOpaque(false); hint.setForeground(UiTheme.MUTED); hint.setAlignmentX(Component.LEFT_ALIGNMENT); body.add(hint);
        inspectorScroll = new JScrollPane(body); inspectorScroll.setHorizontalScrollBarPolicy(ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER); inspectorScroll.setBorder(null);
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
        review.setEditable(false);review.setLineWrap(true);review.setWrapStyleWord(true);review.setFont(new Font("Microsoft YaHei UI",Font.PLAIN,13));
        JPanel reviewPanel=new JPanel(new BorderLayout());JPanel reviewActions=new JPanel(new FlowLayout(FlowLayout.LEFT,5,4));reviewActions.add(button("刷新审查",this::refreshReview));reviewActions.add(new JLabel("根据所选节点的职责、端口和诊断生成本地审查摘要"));reviewPanel.add(reviewActions,BorderLayout.NORTH);reviewPanel.add(new JScrollPane(review),BorderLayout.CENTER);
        reviewPanel.setPreferredSize(new Dimension(320,190));return reviewPanel;
    }
    private JComponent queuePanel(){
        JPanel panel=new JPanel(new BorderLayout());JPanel actions=new JPanel(new FlowLayout(FlowLayout.LEFT,5,4));actions.add(button("刷新队列",this::refreshQueue));actions.add(new JLabel("本地申请槽实时状态"));panel.add(actions,BorderLayout.NORTH);panel.add(new JScrollPane(queueList),BorderLayout.CENTER);panel.setPreferredSize(new Dimension(320,190));return panel;
    }

    private JComponent statusBar() {
        JPanel bar = new JPanel(new BorderLayout()); bar.setBackground(UiTheme.TOOLBAR); bar.setBorder(new EmptyBorder(4, 5, 4, 8));
        status.setForeground(UiTheme.TEXT); bar.add(status, BorderLayout.WEST);
        JLabel queueState = new JLabel("本地文件队列  |  UTF-8  |  Java 21"); queueState.setForeground(UiTheme.MUTED); bar.add(queueState, BorderLayout.EAST); return bar;
    }

    private static JPanel emptyPanel(String text) { JPanel p = new JPanel(new BorderLayout()); JLabel l = new JLabel("  " + text); l.setForeground(UiTheme.MUTED); p.add(l, BorderLayout.NORTH); return p; }
    private static JSeparator separator() { JSeparator s = new JSeparator(SwingConstants.VERTICAL); s.setPreferredSize(new Dimension(8, 25)); s.setForeground(UiTheme.BORDER); return s; }
    private static JComponent fixedField(JTextField field) { field.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30)); field.setAlignmentX(Component.LEFT_ALIGNMENT); return field; }
    private static JLabel label(String text) { JLabel label = new JLabel(text); label.setAlignmentX(Component.LEFT_ALIGNMENT); label.setForeground(UiTheme.TEXT); label.setBorder(new EmptyBorder(0, 0, 4, 0)); return label; }
    private JButton button(String text, Runnable action) { JButton button = new JButton(text); button.addActionListener(e -> action.run()); return button; }
    private JMenuItem item(String text, Runnable action) { JMenuItem item = new JMenuItem(text); item.addActionListener(e -> action.run()); return item; }
    private JMenu menu(String title, JMenuItem... items) { JMenu menu = new JMenu(title); for (JMenuItem item : items) menu.add(item); return menu; }

    private void addNode() { WorkflowModel.Node node = model.addNode(120 + model.nodes().size() * 35, 120 + model.nodes().size() * 25); canvas.select(node); canvas.repaint(); }
    private void chooseProject() { JFileChooser chooser = new JFileChooser(project.getText()); chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY); if (chooser.showOpenDialog(this) == JFileChooser.APPROVE_OPTION) { project.setText(chooser.getSelectedFile().getAbsolutePath()); initializeProject(true); } }
    private void initializeProject(boolean announce) { try { queue = new QueueService(Path.of(project.getText())); results = new ResultService(queue.stateRoot()); refreshQueue();status.setText("  就绪  |  " + queue.projectRoot()); if (announce) append("项目申请槽已初始化：" + queue.stateRoot()); } catch (Exception e) { error(e); } }
    private void updateMode() { boolean code = mode.getSelectedItem() == WorkflowModel.Mode.EXECUTABLE; language.setEnabled(true); if (!code && output.getText().equals("output")) output.setText("output/docs"); if (code && output.getText().equals("output/docs")) output.setText("output"); status.setText("  " + mode.getSelectedItem() + "  |  就绪"); canvas.repaint(); }
    private void loadInspector(WorkflowModel.Node node) { boolean enabled = node != null; nodeName.setEnabled(enabled); prompt.setEnabled(enabled); artifact.setEnabled(enabled);portTable.setEnabled(enabled);portModel.setNode(node); nodePath.setText(node == null ? "工作流 / 未选择节点" : "工作流  ›  " + node.id); if (node == null) { nodeName.setText(""); prompt.setText(""); artifact.setText(""); } else { nodeName.setText(node.name); prompt.setText(node.prompt); artifact.setText(node.artifact); }refreshReview();if(inspectorScroll!=null)SwingUtilities.invokeLater(()->inspectorScroll.getViewport().setViewPosition(new Point(0,0))); }
    private void addPort(boolean outputPort){WorkflowModel.Node node=canvas.selected();if(node==null)return;model.addPort(node,outputPort);portModel.setNode(node);canvas.repaint();}
    private void removePort(){WorkflowModel.Node node=canvas.selected();int row=portTable.getSelectedRow();WorkflowModel.Port port=portModel.portAt(row);if(node==null||port==null)return;model.removePort(node,port,portModel.outputAt(row));portModel.setNode(node);canvas.repaint();}
    private void refreshReview(){WorkflowModel.Node node=canvas.selected();if(node==null){review.setText("选择节点后显示代码审查摘要。");return;}StringBuilder text=new StringBuilder("节点：").append(node.name).append("  [").append(node.id).append("]\n分类：").append(node.category).append("\n\n职责\n").append(node.prompt).append("\n\n输入端口\n");for(WorkflowModel.Port port:node.inputs)text.append("- ").append(port.name).append(" : ").append(port.dataType).append(port.required?"（必需）":"").append('\n');text.append("\n输出端口\n");for(WorkflowModel.Port port:node.outputs)text.append("- ").append(port.name).append(" : ").append(port.dataType).append(port.required?"（必需）":"").append('\n');text.append("\n产物：").append(node.artifact).append("\n状态：").append(node.status);if(!node.diagnostic.isBlank())text.append("\n\n诊断\n").append(node.diagnostic);review.setText(text.toString());review.setCaretPosition(0);}
    private void saveInspector() { WorkflowModel.Node node = canvas.selected(); if (node == null) return; node.name = nodeName.getText().trim(); node.prompt = prompt.getText().trim(); node.artifact = artifact.getText().trim(); canvas.repaint(); append("已更新 " + node.id); }
    private void submit(boolean selectedOnly) { try { saveInspector(); if (queue == null || !queue.projectRoot().equals(Path.of(project.getText()).toAbsolutePath().normalize())) initializeProject(false); QueueService.Submission submission = queue.submit(model, (WorkflowModel.Mode) mode.getSelectedItem(), canvas.selected(), selectedOnly, String.valueOf(language.getSelectedItem()), output.getText()); refreshQueue();Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(submission.codexPrompt()), null); append("已提交 " + submission.requestId() + "\n位置：" + submission.inboxPath() + "\n已复制给 Codex 的指令：" + submission.codexPrompt()); status.setText("  已排队  |  " + submission.requestId()); canvas.repaint(); } catch (Exception e) { error(e); } }
    private void refreshQueue(){if(queue==null)return;try{queueItems.clear();for(QueueService.QueueEntry entry:queue.entries())queueItems.addElement(entry.toString());if(queueItems.isEmpty())queueItems.addElement("当前没有申请");}catch(IOException e){queueItems.clear();queueItems.addElement("读取队列失败："+e.getMessage());}}
    private void pollResults() { if (results == null) return; try { for (String message : results.poll(model)) append(message); refreshQueue();canvas.repaint(); WorkflowModel.Node node = canvas.selected(); if (node != null && node.status == WorkflowModel.Status.FAILED && !node.diagnostic.isBlank()){String message="错误定位 [" + node.id + "] " + node.diagnostic;append(message);if(errors.getText().startsWith("暂无"))errors.setText("");errors.append((errors.getText().isEmpty()?"":"\n")+message);} } catch (IOException | RuntimeException e) { append("读取结果失败：" + e.getMessage()); } }
    private void append(String message) { log.append((log.getText().isEmpty() ? "" : "\n") + message); log.setCaretPosition(log.getDocument().getLength()); }
    private void error(Exception e) { JOptionPane.showMessageDialog(this, e.getMessage(), "CodeNode", JOptionPane.ERROR_MESSAGE); append("操作失败：" + e.getMessage()); status.setText("  操作失败"); }
}
