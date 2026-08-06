package local.codenode;

import local.codenode.util.BundleDataUtil;

import javax.swing.*;
import javax.swing.text.JTextComponent;
import java.awt.*;
import java.awt.event.*;
import java.awt.geom.*;
import java.util.List;
import java.util.*;
import java.util.function.Consumer;
import java.util.function.Supplier;

public final class CanvasPanel extends JPanel {
    private static final int WIDTH=215,HEADER=34,PORT_STEP=22,PORT=6,RESIZE_HANDLE=10;
    private static final float DETAIL_FONT_SIZE=12f;
    private static final int DETAIL_PAD_X=12,DETAIL_LINE_HEIGHT=17;
    private static final int DETAIL_MIN_WIDTH=215,DETAIL_MAX_WIDTH=420,DETAIL_MIN_HEIGHT=130,DETAIL_MAX_HEIGHT=320;
    private boolean isResizeCorner(WorkflowModel.Node n,Point world){
        int rw=nodeWidth(n),rh=nodeHeight(n);
        return world.x>=n.x+rw-RESIZE_HANDLE&&world.x<=n.x+rw+2&&world.y>=n.y+rh-RESIZE_HANDLE&&world.y<=n.y+rh+2;
    }
    private final WorkflowModel model;
    private final LinkedHashSet<WorkflowModel.Node> selectedNodes=new LinkedHashSet<>();
    private WorkflowModel.Node primary,connecting,inputConnecting;
    private WorkflowModel.Port connectingPort,inputConnectingPort;
    private WorkflowModel.Edge selectedEdge,rerouteEdge;
    private WorkflowModel.Reroute selectedReroute,draggingReroute,connectingReroute;
    private WorkflowModel.Reroute grabReroute;
    private Point dragStart,grabStart,panStart,panOrigin,wirePoint,lastMouse=new Point(300,220),boxStart,boxCurrent,rerouteOrigin,resizeStart;
    private WorkflowModel.Node resizingNode;
    private final Map<WorkflowModel.Node,Point> dragOrigins=new LinkedHashMap<>();
    private final List<Point> cutPath=new ArrayList<>(),reroutePath=new ArrayList<>();
    private SelectionMode boxMode=SelectionMode.REPLACE;
    private int panX,panY;
    private double zoom=1.0;
    private boolean editable=true,dragChanged,keyboardGrab;
    private String groupFocusId="";
    private WorkflowModel.Node hoveringScope;
    private final Map<String,int[]> containerTargets=new LinkedHashMap<>();
    private final javax.swing.Timer animTimer;
    private Consumer<WorkflowModel.Node> selectionListener=node->{};
    private Consumer<String> feedbackListener=message->{};
    private Runnable changeListener=()->{};
    private Supplier<String> languageSupplier=()->"java";
    private WorkflowModel clipboard;
    private Point clipboardAnchor;
    private final Map<String, BundleDataUtil.BundleView> bundleViewCache = new HashMap<>();

    public CanvasPanel(WorkflowModel model){
        this.model=model;setBackground(UiTheme.BACKGROUND);setPreferredSize(new Dimension(1600,1000));setFocusable(true);
        animTimer=new javax.swing.Timer(16,e->animateContainers());
        animTimer.start();
        MouseAdapter mouse=new MouseAdapter(){
            @Override public void mousePressed(MouseEvent e){requestFocusInWindow();lastMouse=e.getPoint();Point world=world(e.getPoint());
                if(keyboardGrab){if(SwingUtilities.isLeftMouseButton(e))finishGrab(true);else if(SwingUtilities.isRightMouseButton(e))finishGrab(false);return;}
                if(SwingUtilities.isMiddleMouseButton(e)){panStart=e.getPoint();panOrigin=new Point(panX,panY);return;}
                if(SwingUtilities.isRightMouseButton(e)){if(!editable)return;if(e.isControlDown()&&e.isShiftDown()){reroutePath.clear();reroutePath.add(world);}else if(e.isControlDown()){cutPath.clear();cutPath.add(world);}else if(e.isAltDown()){EdgeHit hit=hitEdge(world);if(hit!=null){clearNodeSelection();selectReroute(hit.edge,insertReroute(hit,world));changeListener.run();}}return;}
                if(!SwingUtilities.isLeftMouseButton(e))return;
                RerouteHit reroute=hitReroute(world);if(reroute!=null){clearNodeSelection();selectedEdge=reroute.edge;selectReroute(reroute.edge,reroute.point);if(editable&&e.isAltDown()){draggingReroute=reroute.point;rerouteOrigin=new Point(reroute.point.x,reroute.point.y);}else if(editable){connectingReroute=reroute.point;wirePoint=world;}return;}
                PortHit port=hitPort(world);if(editable&&port!=null){if(port.output){connecting=port.node;connectingPort=port.port;}else{inputConnecting=port.node;inputConnectingPort=port.port;}wirePoint=world;repaint();return;}
                WorkflowModel.Node hit=hitNode(world);if(hit!=null){if(editable&&isResizeCorner(hit,world)){resizingNode=hit;resizeStart=new Point(isContainer(hit)?hit.containerWidth:hit.nodeWidth,isContainer(hit)?hit.containerHeight:hit.nodeHeight);return;}                if(hit.nodeKind==WorkflowModel.NodeKind.GROUP&&e.getClickCount()==2){enterGroupFocus(hit.id);repaint();return;}
                if(hit.nodeKind==WorkflowModel.NodeKind.ASSET_BUNDLE&&e.getClickCount()==2&&editable){hit.bundleCollapsed=!hit.bundleCollapsed;replaceSelection(hit);changeListener.run();repaint();return;}
                applyNodeClick(hit,e);if(editable&&selectedNodes.contains(hit)){dragStart=world;dragOrigins.clear();selectedNodes.forEach(node->dragOrigins.put(node,new Point(node.x,node.y)));includeContainerChildren();dragChanged=false;}return;}
                EdgeHit edge=hitEdge(world);if(edge!=null){if(!e.isShiftDown()&&!e.isAltDown())clearNodeSelection();selectedEdge=edge.edge;selectedReroute=null;selectionListener.accept(primary);repaint();return;}
                selectedEdge=null;selectedReroute=null;boxStart=world;boxCurrent=world;boxMode=e.isAltDown()?SelectionMode.SUBTRACT:e.isShiftDown()?SelectionMode.ADD:SelectionMode.REPLACE;if(boxMode==SelectionMode.REPLACE)clearNodeSelection();repaint();
            }
            @Override public void mouseDragged(MouseEvent e){lastMouse=e.getPoint();Point world=world(e.getPoint());
                if(panStart!=null){panX=panOrigin.x+e.getX()-panStart.x;panY=panOrigin.y+e.getY()-panStart.y;repaint();return;}
                if(resizingNode!=null){int nw=resizeStart.x+world.x-(resizingNode.x+nodeWidth(resizingNode));int nh=resizeStart.y+world.y-(resizingNode.y+nodeHeight(resizingNode));if(nw>80){if(isContainer(resizingNode))resizingNode.containerWidth=nw;else resizingNode.nodeWidth=nw;}if(nh>60){if(isContainer(resizingNode))resizingNode.containerHeight=nh;else resizingNode.nodeHeight=nh;}dragChanged=true;repaint();return;}
                if(!cutPath.isEmpty()){cutPath.add(world);repaint();return;}if(!reroutePath.isEmpty()){reroutePath.add(world);repaint();return;}
                if(connecting!=null||inputConnecting!=null||connectingReroute!=null){wirePoint=world;repaint();return;}if(draggingReroute!=null){draggingReroute.x=world.x;draggingReroute.y=world.y;dragChanged=true;repaint();return;}
                if(dragStart!=null&&!dragOrigins.isEmpty()){int dx=world.x-dragStart.x,dy=world.y-dragStart.y;dragOrigins.forEach((node,origin)->{node.x=origin.x+dx;node.y=origin.y+dy;});dragChanged=dx!=0||dy!=0;
                    hoveringScope=null;if(!dragOrigins.keySet().stream().allMatch(CanvasPanel::isContainer)){for(WorkflowModel.Node s:model.nodes()){if(s.nodeKind==WorkflowModel.NodeKind.SCOPE&&containerBody(s).contains(world)){hoveringScope=s;break;}}}
                    repaint();return;}
                if(boxStart!=null){boxCurrent=world;repaint();}
            }
            @Override public void mouseReleased(MouseEvent e){Point world=world(e.getPoint());
                if(panStart!=null){panStart=null;changeListener.run();return;}
                if(resizingNode!=null){if(dragChanged){containerTargets.put(resizingNode.id,new int[]{resizingNode.containerWidth,resizingNode.containerHeight});changeListener.run();}resizingNode=null;resizeStart=null;dragChanged=false;repaint();return;}
                if(!cutPath.isEmpty()){cutEdges();cutPath.clear();repaint();return;}
                if(!reroutePath.isEmpty()){insertReroutesFromStroke();reroutePath.clear();repaint();return;}
                if(connecting!=null){PortHit target=hitPort(world);boolean changed=false;if(target!=null){if(target.output)feedback("连接失败：输出端口只能连接输入端口");else changed=connectNodes(connecting,connectingPort,target.node,target.port);}if(changed){replaceSelection(target.node);changeListener.run();}connecting=null;connectingPort=null;wirePoint=null;repaint();return;}
                if(inputConnecting!=null){PortHit target=hitPort(world);RerouteHit rerouteTarget=hitReroute(world);boolean changed=false;if(target!=null){if(!target.output)feedback("连接失败：输入端口只能连接输出端口");else changed=connectNodes(target.node,target.port,inputConnecting,inputConnectingPort);}else if(rerouteTarget!=null)changed=connectFromReroute(rerouteTarget.point,inputConnecting,inputConnectingPort);if(changed){replaceSelection(inputConnecting);changeListener.run();}inputConnecting=null;inputConnectingPort=null;wirePoint=null;repaint();return;}
                if(connectingReroute!=null){PortHit portTarget=hitPort(world);boolean changed=false;if(portTarget!=null){if(portTarget.output)feedback("连接失败：整理点只能连接输入端口");else changed=connectFromReroute(connectingReroute,portTarget.node,portTarget.port);}if(changed){replaceSelection(portTarget.node);changeListener.run();}connectingReroute=null;wirePoint=null;repaint();return;}
                if(draggingReroute!=null){if(dragChanged)changeListener.run();draggingReroute=null;rerouteOrigin=null;dragChanged=false;return;}
                if(dragStart!=null){if(dragChanged){assignMovedNodesToContainers();changeListener.run();}dragStart=null;dragOrigins.clear();dragChanged=false;hoveringScope=null;repaint();return;}
                if(boxStart!=null){applyBoxSelection();boxStart=boxCurrent=null;repaint();}
            }
            @Override public void mouseMoved(MouseEvent e){lastMouse=e.getPoint();Point world=world(e.getPoint());if(keyboardGrab){updateGrab(world);return;}if(connecting!=null||inputConnecting!=null||connectingReroute!=null){wirePoint=world;repaint();}}
            @Override public void mouseWheelMoved(MouseWheelEvent e){zoomAt(e.getPoint(),e.getPreciseWheelRotation());}
        };addMouseListener(mouse);addMouseMotionListener(mouse);addMouseWheelListener(mouse);installKeys();
    }

    public void onSelection(Consumer<WorkflowModel.Node> listener){selectionListener=listener;}
    public void onFeedback(Consumer<String> listener){feedbackListener=listener;}
    public void onChange(Runnable listener){changeListener=listener;}
    public void setLanguageSupplier(Supplier<String> supplier){languageSupplier=supplier;}
    public void setEditable(boolean value){editable=value;cancelOperation();repaint();}
    public boolean isEditable(){return editable;}
    public WorkflowModel.Node selected(){return primary;}
    public Set<WorkflowModel.Node> selectedNodes(){return Collections.unmodifiableSet(selectedNodes);}
    public void select(WorkflowModel.Node node){if(node==null)clearNodeSelection();else replaceSelection(node);}
    public void selectNodes(Collection<WorkflowModel.Node> nodes){selectedNodes.clear();for(WorkflowModel.Node node:nodes)if(node!=null&&model.nodes().contains(node))selectedNodes.add(node);primary=selectedNodes.isEmpty()?null:selectedNodes.getLast();selectedEdge=null;selectedReroute=null;notifySelection();}
    public int panX(){return panX;}public int panY(){return panY;}public double zoom(){return zoom;}
    public void setView(int x,int y){setView(x,y,1.0);}
    public void setView(int x,int y,double value){panX=x;panY=y;zoom=clamp(value,.25,2.5);repaint();}

    private void installKeys(){
        bind("shift A",this::showAddMenu);bind("shift W",this::showQuickMenu);bind("DELETE",this::deleteSelection);bind("X",this::deleteSelection);bind("control A",this::selectAll);
        bind("control C",this::copySelection);bind("control V",this::pasteSelection);bind("control D",this::duplicateSelection);bind("shift D",this::duplicateSelection);
        bind("H",()->toggleSelected(n->n.collapsed=!n.collapsed));bind("M",()->toggleSelected(n->n.detailMode=!n.detailMode));bind("N",()->toggleSelected(n->n.muted=!n.muted));bind("HOME",this::frameAll);bind("Z",this::frameSelection);
        bind("G",this::startGrab);bind("ENTER",()->finishGrab(true));bind("control X",this::deleteWithReconnect);bind("alt X",this::deleteUnused);bind("ESCAPE",this::cancelOrExitGroup);bind("control G",this::groupSelectedNodes);
    }
    private void bind(String stroke,Runnable action){String key="action-"+stroke;getInputMap(WHEN_FOCUSED).put(KeyStroke.getKeyStroke(stroke),key);getActionMap().put(key,new AbstractAction(){@Override public void actionPerformed(ActionEvent e){if(KeyboardFocusManager.getCurrentKeyboardFocusManager().getFocusOwner() instanceof JTextComponent)return;action.run();}});}

    private void applyNodeClick(WorkflowModel.Node node,MouseEvent e){selectedEdge=null;selectedReroute=null;if(e.isAltDown()){selectedNodes.remove(node);primary=selectedNodes.isEmpty()?null:selectedNodes.getLast();notifySelection();return;}if(e.isShiftDown()){if(!selectedNodes.add(node))selectedNodes.remove(node);primary=selectedNodes.contains(node)?node:selectedNodes.isEmpty()?null:selectedNodes.getLast();notifySelection();return;}if(!selectedNodes.contains(node))replaceSelection(node);else{primary=node;notifySelection();}}
    private void replaceSelection(WorkflowModel.Node node){selectedNodes.clear();if(node!=null)selectedNodes.add(node);primary=node;selectedEdge=null;selectedReroute=null;notifySelection();}
    private void clearNodeSelection(){selectedNodes.clear();primary=null;notifySelection();}
    private void notifySelection(){selectionListener.accept(primary);repaint();}
    private void selectAll(){selectedNodes.clear();selectedNodes.addAll(model.nodes());primary=selectedNodes.isEmpty()?null:selectedNodes.getLast();selectedEdge=null;selectedReroute=null;notifySelection();}
    private void applyBoxSelection(){Rectangle box=box();List<WorkflowModel.Node> hits=model.nodes().stream().filter(this::visibleNode).filter(node->box.intersects(node.x,node.y,nodeWidth(node),nodeHeight(node))).toList();if(boxMode==SelectionMode.SUBTRACT)selectedNodes.removeAll(hits);else selectedNodes.addAll(hits);primary=selectedNodes.isEmpty()?null:selectedNodes.getLast();notifySelection();}

    private void showAddMenu(){if(editable)nodeMenu().show(this,lastMouse.x,lastMouse.y);}
    private JPopupMenu nodeMenu(){JPopupMenu menu=new JPopupMenu();menu.add(menuItem("空白节点",()->addTemplate("空白节点","基础","说明这个节点应完成的工作",1,1)));menu.add(menuItem("组输出",this::addGroupOutput));    JMenu basic=new JMenu("基础与范围");basic.add(menuItem("文件节点",this::addFileNode));basic.add(menuItem("范围文件",this::addRangeFileNode));basic.add(menuItem("If 判断范围",()->addTemplate("If 判断范围","范围与流程控制","按布尔条件执行 then 或 else 区域",1,1)));basic.add(menuItem("For Each 循环范围",()->addTemplate("For Each 循环范围","范围与流程控制","遍历数组并执行 body 区域",2,1)));basic.add(menuItem("While 循环范围",()->addTemplate("While 循环范围","范围与流程控制","条件成立时执行 body 区域",1,1)));basic.add(menuItem("Repeat 循环范围",()->addTemplate("Repeat 循环范围","范围与流程控制","按固定次数执行 body 区域",1,1)));menu.add(basic);
    JMenu assets=new JMenu("资产类文件");for(String type:NodeRegistry.allAssetTypes()){String label=NodeRegistry.assetTypeLabel(type);assets.add(menuItem(label+" 文件",()->addAssetNode(type)));}JMenu assetBundle=new JMenu("资产资源组");for(String type:NodeRegistry.allAssetTypes()){String label=NodeRegistry.assetTypeLabel(type);assetBundle.add(menuItem(label+" 资源组",()->addAssetBundleNode(type)));}assets.add(assetBundle);menu.add(assets);
    JMenu groups=new JMenu("节点组");groups.add(menuItem("组输入节点",()->addGroupInputNode()));groups.add(menuItem("捕获节点",()->addCaptureNode()));menu.add(groups);JMenu values=new JMenu("数值与常量");for(String name:List.of("整数常量","浮点常量","数值变量","Vector2","Vector3","Vector4","法向","颜色","数组"))values.add(menuItem(name,()->addTemplate(name,name.matches("Vector.*|法向|颜色|数组")?"向量与数组":"数值","提供或保存 "+name,0,1)));values.add(menuItem("布尔常量",()->addTemplate("布尔常量","布尔值","提供布尔条件",0,1)));values.add(menuItem("字符串常量",()->addTemplate("字符串常量","文本","提供字符串常量",0,1)));menu.add(values);JMenu conditions=new JMenu("条件");for(String name:List.of("比较","范围判断","为空判断","AND","OR","NOT","XOR"))conditions.add(menuItem(name,()->addTemplate(name,"布尔值","计算并输出布尔条件",name.equals("NOT")?1:2,1)));menu.add(conditions);JMenu calculations=new JMenu("计算");for(String name:List.of("浮点计算","整数计算","向量计算","颜色计算","数组计算"))calculations.add(menuItem(name,()->addTemplate(name,name.matches("向量计算|颜色计算|数组计算")?"向量与数组":"数值","选择运算并计算输入",2,1)));menu.add(calculations);JMenu language=new JMenu(languageSupplier.get()+" 专用");switch(languageSupplier.get()){case "powershell"->{language.add(menuItem("管道处理",()->addTemplate("PowerShell 管道","PowerShell","通过管道变换输入对象",1,1)));language.add(menuItem("Cmdlet 调用",()->addTemplate("Cmdlet 调用","PowerShell","调用指定 PowerShell Cmdlet",1,1)));}case "go"->{language.add(menuItem("Goroutine",()->addTemplate("Goroutine","Go","并发执行输入任务并等待结果",1,1)));language.add(menuItem("Channel",()->addTemplate("Channel","Go","通过类型化 Channel 传递数据",1,1)));}default->{language.add(menuItem("Stream 处理",()->addTemplate("Java Stream","Java","使用 Stream API 变换集合",1,1)));language.add(menuItem("异常捕获",()->addTemplate("Try / Catch","Java","捕获并处理 Java 异常",1,2)));}}menu.add(language);UiTheme.apply(menu);return menu;}
    private void showQuickMenu(){JPopupMenu menu=new JPopupMenu();menu.add(menuItem("复制节点  Shift+D",this::duplicateSelection));menu.add(menuItem("折叠节点  H",()->toggleSelected(n->n.collapsed=!n.collapsed)));menu.add(menuItem("静音节点  N",()->toggleSelected(n->n.muted=!n.muted)));menu.add(menuItem("详细模式  M",()->toggleSelected(n->n.detailMode=!n.detailMode)));menu.add(menuItem("聚焦选择  Z",this::frameSelection));menu.add(menuItem("查看全部  Home",this::frameAll));menu.add(menuItem("删除并重连  Ctrl+X",this::deleteWithReconnect));menu.add(menuItem("清理未连接节点  Alt+X",this::deleteUnused));if(primary!=null&&primary.nodeKind==WorkflowModel.NodeKind.ASSET_BUNDLE){menu.addSeparator();menu.add(menuItem("完整展开资源组",this::expandBundleNode));}UiTheme.apply(menu);menu.show(this,lastMouse.x,lastMouse.y);}
    private JMenuItem menuItem(String text,Runnable action){JMenuItem item=new JMenuItem(text);item.addActionListener(e->action.run());return item;}
    private void addGroupOutput(){if(!editable)return;Point p=world(lastMouse);WorkflowModel.Node node=model.addGroupOutput(p.x,p.y,"组输出 "+(model.groupOutputs().size()+1));replaceSelection(node);changeListener.run();}
    private void addFileNode(){if(!editable)return;Point p=world(lastMouse);String lang=switch(languageSupplier.get()){case "go"->"go";case "powershell"->"ps1";default->"java";};WorkflowModel.Node node=model.addFileNode(p.x,p.y,"文件节点","src/Main."+lang);replaceSelection(node);changeListener.run();}
    private void addRangeFileNode(){if(!editable)return;Point p=world(lastMouse);WorkflowModel.Node node=model.addFileNode(p.x,p.y,"范围文件","");node.rangeMode=true;node.containerWidth=520;node.containerHeight=320;replaceSelection(node);changeListener.run();}
    private void addAssetNode(String assetType){if(!editable)return;Point p=world(lastMouse);WorkflowModel.Node node=model.addAssetNode(p.x,p.y,"资源-"+NodeRegistry.assetTypeLabel(assetType),"assets/example."+assetType,assetType);replaceSelection(node);changeListener.run();}
    private void addAssetBundleNode(String assetType){if(!editable)return;Point p=world(lastMouse);WorkflowModel.Node node=model.addAssetBundleNode(p.x,p.y,"资源组-"+NodeRegistry.assetTypeLabel(assetType),"{\"files\":[]}",assetType);replaceSelection(node);changeListener.run();}
    private void addGroupInputNode(){if(!editable)return;Point p=world(lastMouse);WorkflowModel.Node node=model.addGroupInputNode(p.x,p.y,"组输入");replaceSelection(node);changeListener.run();}
    private void addCaptureNode(){if(!editable)return;Point p=world(lastMouse);WorkflowModel.Node node=model.addCaptureNode(p.x,p.y,"捕获 "+(model.nodes().stream().filter(n->n.nodeKind==WorkflowModel.NodeKind.CAPTURE).count()+1));replaceSelection(node);changeListener.run();}
    private void addTemplate(String name,String category,String prompt,int inputCount,int outputCount){if(!editable)return;Point p=world(lastMouse);WorkflowModel.Node node=model.addNode(p.x,p.y);node.name=name;node.category=category;node.prompt=prompt;node.templateLibrary="builtin";node.templateId=name;node.templateLanguage=Set.of("Java","PowerShell","Go").contains(category)?languageSupplier.get():"neutral";configureTemplate(node,name,category);node.inputs.clear();node.outputs.clear();if(node.nodeKind==WorkflowModel.NodeKind.SCOPE){if(name.startsWith("Repeat"))node.inputs.add(new WorkflowModel.Port("count","次数","integer",true));else{node.inputs.add(new WorkflowModel.Port("condition","条件","boolean",!name.startsWith("For Each")));if(name.startsWith("For Each"))node.inputs.add(new WorkflowModel.Port("collection","集合","array<any>",true));}node.outputs.add(new WorkflowModel.Port("out","完成","flow",false));}else if(!NodeRegistry.operations(node).isEmpty())NodeRegistry.applyOperation(model,node,NodeRegistry.operationForLabel(node,name));else{for(int i=0;i<inputCount;i++)node.inputs.add(new WorkflowModel.Port("in"+(i+1),inputCount==1?"输入":"输入 "+(i+1),portType(node),false));for(int i=0;i<outputCount;i++)node.outputs.add(new WorkflowModel.Port("out"+(i+1),outputCount==1?"输出":"输出 "+(i+1),portType(node),false));}replaceSelection(node);changeListener.run();}
    private void configureTemplate(WorkflowModel.Node node,String name,String category){if(category.equals("范围与流程控制")){node.nodeKind=WorkflowModel.NodeKind.SCOPE;node.classificationKey="scope.flow";model.setCodeBearing(node,false);}else if(category.equals("布尔值")){node.nodeKind=name.equals("布尔常量")?WorkflowModel.NodeKind.REGULAR:WorkflowModel.NodeKind.CONDITION;node.valueType="boolean";node.classificationKey=node.nodeKind==WorkflowModel.NodeKind.CONDITION?"calculation.boolean":"value.boolean";}else if(category.equals("向量与数组")){node.nodeKind=name.endsWith("计算")?WorkflowModel.NodeKind.CALCULATION:WorkflowModel.NodeKind.REGULAR;node.valueType=name.contains("数组")?"array<any>":name.contains("颜色")?"color":name.contains("法向")?"normal":name.startsWith("Vector")?name.toLowerCase(Locale.ROOT):"vector3";node.classificationKey=node.nodeKind==WorkflowModel.NodeKind.CALCULATION?"calculation.vector":name.contains("数组")?"value.array":"value.vector";}else if(category.equals("数值")){node.nodeKind=name.endsWith("计算")?WorkflowModel.NodeKind.CALCULATION:WorkflowModel.NodeKind.REGULAR;node.valueType=name.contains("整数")?"integer":"number";node.classificationKey=node.nodeKind==WorkflowModel.NodeKind.CALCULATION?"calculation.scalar":"value.scalar";}else if(category.equals("文本")){node.valueType="string";node.classificationKey="text.string";}else node.classificationKey="foundation.object";}
    private static String portType(WorkflowModel.Node node){return node.valueType.equals("any")?node.nodeKind==WorkflowModel.NodeKind.SCOPE?"boolean":"any":node.valueType;}

    private void deleteSelection(){if(!editable)return;if(selectedReroute!=null){model.removeReroute(selectedReroute);selectedReroute=null;rerouteEdge=null;changeListener.run();repaint();return;}if(selectedEdge!=null){model.removeEdges(List.of(selectedEdge));selectedEdge=null;changeListener.run();repaint();return;}if(selectedNodes.isEmpty())return;Set<WorkflowModel.Node> containers=selectedNodes.stream().filter(CanvasPanel::isContainer).collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));Set<WorkflowModel.Node> deleting=new LinkedHashSet<>(selectedNodes);if(!containers.isEmpty()){Object[] options={"仅解除范围","连同内部节点删除","取消"};int choice=JOptionPane.showOptionDialog(this,"删除范围或文件节点时如何处理内部节点？","CodeNode",JOptionPane.DEFAULT_OPTION,JOptionPane.WARNING_MESSAGE,null,options,options[0]);if(choice<0||choice==2)return;if(choice==1)for(WorkflowModel.Node container:containers)deleting.addAll(descendants(container));else for(WorkflowModel.Node container:containers)for(WorkflowModel.Node child:descendants(container)){if((container.nodeKind==WorkflowModel.NodeKind.FILE||container.nodeKind==WorkflowModel.NodeKind.ASSET)&&child.fileNodeId.equals(container.id))child.fileNodeId="";if(container.nodeKind==WorkflowModel.NodeKind.SCOPE&&child.parentScopeId.equals(container.id))child.parentScopeId="";}}deleting.forEach(model::removeNode);for(WorkflowModel.Node del:new LinkedHashSet<>(deleting)){if(del.nodeKind==WorkflowModel.NodeKind.GROUP){for(WorkflowModel.Node child:model.nodes()){if(child.parentScopeId.equals(del.id))child.parentScopeId="";}}}clearNodeSelection();changeListener.run();}
    private void deleteWithReconnect(){if(!editable||selectedNodes.size()!=1)return;WorkflowModel.Node node=primary;List<WorkflowModel.Edge> incoming=model.edges().stream().filter(e->e.target().equals(node.id)).toList(),outgoing=model.edges().stream().filter(e->e.source().equals(node.id)).toList();if(!incoming.isEmpty()&&!outgoing.isEmpty()){WorkflowModel.Edge a=incoming.getFirst(),b=outgoing.getFirst();WorkflowModel.Node source=model.byId(a.source()),target=model.byId(b.target());WorkflowModel.Port sp=model.output(source,a.sourcePort()),tp=model.input(target,b.targetPort());if(source!=null&&target!=null&&sp!=null&&tp!=null)model.connect(source,sp,target,tp);}model.removeNode(node);clearNodeSelection();changeListener.run();}
    private void deleteUnused(){if(!editable)return;List<WorkflowModel.Node> unused=model.nodes().stream().filter(n->!selectedNodes.contains(n)&&model.edges().stream().noneMatch(e->e.source().equals(n.id)||e.target().equals(n.id))).toList();unused.forEach(model::removeNode);if(!unused.isEmpty())changeListener.run();repaint();}
    private void toggleSelected(Consumer<WorkflowModel.Node> action){if(!editable||selectedNodes.isEmpty())return;selectedNodes.forEach(action);changeListener.run();repaint();}
    private void expandBundleNode(){
        if(!editable)return;
        WorkflowModel.Node node=primary;
        if(node==null||node.nodeKind!=WorkflowModel.NodeKind.ASSET_BUNDLE)return;
        List<WorkflowModel.Node> created=model.expandAssetBundle(node);
        if(!created.isEmpty()){
            clearNodeSelection();replaceSelection(created.getFirst());
            changeListener.run();
            feedback("已从资源组展开 "+created.size()+" 个资产节点");
        }
        repaint();
    }

    private void copySelection(){if(selectedNodes.isEmpty())return;Set<String> copiedIds=new LinkedHashSet<>();for(WorkflowModel.Node selected:selectedNodes){copiedIds.add(selected.id);if(isContainer(selected))descendants(selected).forEach(node->copiedIds.add(node.id));}WorkflowModel source=model.deepCopy();source.nodes().stream().filter(node->!copiedIds.contains(node.id)).toList().forEach(source::removeNode);clipboard=source;int minX=source.nodes().stream().mapToInt(n->n.x).min().orElse(0),minY=source.nodes().stream().mapToInt(n->n.y).min().orElse(0);clipboardAnchor=new Point(minX,minY);}
    private void pasteSelection(){if(!editable||clipboard==null||clipboard.nodes().isEmpty())return;pasteAt(world(lastMouse));}
    private void duplicateSelection(){if(!editable||selectedNodes.isEmpty())return;copySelection();pasteAt(new Point(clipboardAnchor.x+30,clipboardAnchor.y+30));}
    private void pasteAt(Point target){Map<String,WorkflowModel.Node> mapping=new HashMap<>();LinkedHashSet<WorkflowModel.Node> pasted=new LinkedHashSet<>();for(WorkflowModel.Node source:clipboard.nodes()){WorkflowModel.Node copy=model.addNode(target.x+source.x-clipboardAnchor.x,target.y+source.y-clipboardAnchor.y);copyNode(source,copy);model.setCodeBearing(copy,source.codeBearing);if(copy.nodeKind==WorkflowModel.NodeKind.FILE)model.ensureFileSlot(copy);mapping.put(source.id,copy);pasted.add(copy);}for(WorkflowModel.Node source:clipboard.nodes()){WorkflowModel.Node copy=mapping.get(source.id);if(mapping.containsKey(source.parentScopeId))copy.parentScopeId=mapping.get(source.parentScopeId).id;if(mapping.containsKey(source.fileNodeId))copy.fileNodeId=mapping.get(source.fileNodeId).id;copySlotContents(source,copy);}for(WorkflowModel.Edge edge:clipboard.edges()){WorkflowModel.Node from=mapping.get(edge.source()),to=mapping.get(edge.target());if(from==null||to==null)continue;WorkflowModel.Port out=model.output(from,edge.sourcePort()),in=model.input(to,edge.targetPort());if(out!=null&&in!=null&&model.connect(from,out,to,in)){WorkflowModel.Edge created=model.edges().getLast();for(WorkflowModel.Reroute point:edge.reroutes())created.reroutes().add(new WorkflowModel.Reroute(target.x+point.x-clipboardAnchor.x,target.y+point.y-clipboardAnchor.y));}}selectedNodes.clear();selectedNodes.addAll(pasted);primary=pasted.getLast();notifySelection();changeListener.run();}
    private void copySlotContents(WorkflowModel.Node source,WorkflowModel.Node copy){String sourceId=source.nodeKind==WorkflowModel.NodeKind.FILE?"file:"+source.id:source.codeBearing?"node:"+source.id:"",targetId=copy.nodeKind==WorkflowModel.NodeKind.FILE?"file:"+copy.id:copy.codeBearing?"node:"+copy.id:"";if(sourceId.isBlank()||targetId.isBlank())return;WorkflowModel.CodeSlot from=clipboard.codeSlot(sourceId),to=model.codeSlot(targetId);if(from==null||to==null)return;to.language=from.language;to.activeCode=from.activeCode;to.activeRevision=from.activeRevision;to.previousCode=from.previousCode;to.previousSourceRevision=from.previousSourceRevision;to.lastAppliedRequestId=from.lastAppliedRequestId;to.draft=null;}
    private List<WorkflowModel.Node> descendants(WorkflowModel.Node container){LinkedHashSet<WorkflowModel.Node> result=new LinkedHashSet<>();ArrayDeque<WorkflowModel.Node> pending=new ArrayDeque<>();pending.add(container);while(!pending.isEmpty()){WorkflowModel.Node parent=pending.removeFirst();for(WorkflowModel.Node node:model.nodes())if(!result.contains(node)&&belongsTo(node,parent)){result.add(node);if(isContainer(node))pending.add(node);}}return List.copyOf(result);}
    private static void copyNode(WorkflowModel.Node source,WorkflowModel.Node target){target.name=source.name;target.prompt=source.prompt;target.artifact=source.artifact;target.category=source.category;target.templateLibrary=source.templateLibrary;target.templateId=source.templateId;target.templateVersion=source.templateVersion;target.templateLanguage=source.templateLanguage;target.nodeKind=source.nodeKind;target.valueType=source.valueType;target.operation=source.operation;target.classificationKey=source.classificationKey;target.codeBearing=source.codeBearing;target.parentScopeId="";target.scopeRegion=source.scopeRegion;target.fileNodeId="";target.relativePath=source.relativePath;target.role=source.role;target.containerWidth=source.containerWidth;target.containerHeight=source.containerHeight;target.collapsed=source.collapsed;target.muted=source.muted;target.detailMode=source.detailMode;target.rangeMode=source.rangeMode;target.nodeColor=source.nodeColor;target.assetType=source.assetType;target.bundleData=source.bundleData;target.groupInputNodeId=source.groupInputNodeId;target.bundleCollapsed=source.bundleCollapsed;target.nodeWidth=source.nodeWidth;target.nodeHeight=source.nodeHeight;target.inputs.clear();target.outputs.clear();source.inputs.forEach(p->target.inputs.add(new WorkflowModel.Port(p.id,p.name,p.declaredType,p.dataType,p.required)));source.outputs.forEach(p->target.outputs.add(new WorkflowModel.Port(p.id,p.name,p.declaredType,p.dataType,p.required)));}

    private void zoomAt(Point screen,double wheel){double old=zoom,next=clamp(old*Math.pow(1.12,-wheel),.25,2.5);Point2D.Double world=new Point2D.Double((screen.x-panX)/old,(screen.y-panY)/old);zoom=next;panX=(int)Math.round(screen.x-world.x*next);panY=(int)Math.round(screen.y-world.y*next);changeListener.run();repaint();}
    public void frameAll(){frameNodes(model.nodes());}
    private void frameSelection(){if(selectedNodes.isEmpty())return;frameNodes(selectedNodes);}
    private void frameNodes(Collection<WorkflowModel.Node> nodes){if(nodes.isEmpty()){setView(0,0,1);return;}int minX=nodes.stream().mapToInt(n->n.x).min().orElse(0),minY=nodes.stream().mapToInt(n->n.y).min().orElse(0),maxX=nodes.stream().mapToInt(n->n.x+nodeWidth(n)).max().orElse(WIDTH),maxY=nodes.stream().mapToInt(n->n.y+nodeHeight(n)).max().orElse(100);double availableW=Math.max(200,getWidth()-120),availableH=Math.max(160,getHeight()-120);zoom=clamp(Math.min(availableW/Math.max(1,maxX-minX),availableH/Math.max(1,maxY-minY)),.25,2.5);panX=(int)Math.round(getWidth()/2d-(minX+maxX)/2d*zoom);panY=(int)Math.round(getHeight()/2d-(minY+maxY)/2d*zoom);changeListener.run();repaint();}
    private void startGrab(){if(!editable||keyboardGrab||selectedReroute==null&&selectedNodes.isEmpty())return;cancelOperation();keyboardGrab=true;grabStart=world(lastMouse);dragChanged=false;if(selectedReroute!=null){grabReroute=selectedReroute;rerouteOrigin=new Point(grabReroute.x,grabReroute.y);}else{dragOrigins.clear();selectedNodes.forEach(node->dragOrigins.put(node,new Point(node.x,node.y)));includeContainerChildren();}setCursor(Cursor.getPredefinedCursor(Cursor.MOVE_CURSOR));repaint();}
    private void updateGrab(Point world){if(!keyboardGrab||grabStart==null)return;int dx=world.x-grabStart.x,dy=world.y-grabStart.y;if(grabReroute!=null&&rerouteOrigin!=null){grabReroute.x=rerouteOrigin.x+dx;grabReroute.y=rerouteOrigin.y+dy;}else dragOrigins.forEach((node,origin)->{node.x=origin.x+dx;node.y=origin.y+dy;});dragChanged=dx!=0||dy!=0;repaint();}
    private void finishGrab(boolean confirm){if(!keyboardGrab)return;if(!confirm){if(grabReroute!=null&&rerouteOrigin!=null){grabReroute.x=rerouteOrigin.x;grabReroute.y=rerouteOrigin.y;}dragOrigins.forEach((node,origin)->{node.x=origin.x;node.y=origin.y;});}else if(dragChanged){assignMovedNodesToContainers();changeListener.run();}keyboardGrab=false;grabStart=null;grabReroute=null;rerouteOrigin=null;dragOrigins.clear();dragChanged=false;setCursor(Cursor.getDefaultCursor());repaint();}
    private void cancelOrExitGroup(){if(!groupFocusId.isBlank()){cancelGroupFocus();return;}cancelOperation();}
    private void cancelOperation(){if(resizingNode!=null){resizingNode=null;resizeStart=null;dragChanged=false;repaint();return;}if(keyboardGrab){finishGrab(false);return;}if(dragStart!=null)dragOrigins.forEach((node,origin)->{node.x=origin.x;node.y=origin.y;});if(draggingReroute!=null&&rerouteOrigin!=null){draggingReroute.x=rerouteOrigin.x;draggingReroute.y=rerouteOrigin.y;}connecting=null;connectingPort=null;inputConnecting=null;inputConnectingPort=null;connectingReroute=null;wirePoint=null;dragStart=null;dragOrigins.clear();draggingReroute=null;rerouteOrigin=null;boxStart=boxCurrent=null;cutPath.clear();reroutePath.clear();dragChanged=false;repaint();}
    private void groupSelectedNodes(){if(!editable||selectedNodes.isEmpty())return;
        int minX=Integer.MAX_VALUE,minY=Integer.MAX_VALUE;
        Set<String> selIds=new HashSet<>();for(WorkflowModel.Node n:selectedNodes){selIds.add(n.id);if(n.x<minX)minX=n.x;if(n.y<minY)minY=n.y;}
        WorkflowModel.Node group=model.addGroupNode(minX-20,minY-40,"节点组 "+(model.groupOutputs().size()+1));
        WorkflowModel.Node gi=model.addGroupInputNode(group.x+30,group.y+60,"节点组输入");
        gi.parentScopeId=group.id;
        WorkflowModel.Node go=model.addNodeGroupOutput(group.x+30,group.y+120,"节点组输出");
        go.parentScopeId=group.id;
        for(WorkflowModel.Node n:selectedNodes)n.parentScopeId=group.id;
        // auto-connect: GROUP_INPUT -> nodes with external incoming edges
        boolean giConnected=false,goConnected=false;
        for(WorkflowModel.Edge e:model.edges()){
            if(!giConnected&&selIds.contains(e.target())&&!selIds.contains(e.source())){
                WorkflowModel.Node target=model.byId(e.target());
                WorkflowModel.Port giOut=model.output(gi,"value"),tp=target==null?null:model.input(target,e.targetPort());
                if(giOut!=null&&tp!=null){model.connect(gi,giOut,target,tp);giConnected=true;}
            }
            if(!goConnected&&selIds.contains(e.source())&&!selIds.contains(e.target())){
                WorkflowModel.Node source=model.byId(e.source());
                WorkflowModel.Port sp=source==null?null:model.output(source,e.sourcePort()),goIn=model.input(go,"value");
                if(sp!=null&&goIn!=null){model.connect(source,sp,go,goIn);goConnected=true;}
            }
        }
        // fallback: connect to first/last selected node if nothing with external edges was found
        if(!giConnected&&!selectedNodes.isEmpty()){
            WorkflowModel.Node first=selectedNodes.getFirst();
            WorkflowModel.Port giOut=model.output(gi,"value"),fp=first.inputs.isEmpty()?null:first.inputs.get(0);
            if(giOut!=null&&fp!=null)model.connect(gi,giOut,first,fp);
        }
        if(!goConnected&&!selectedNodes.isEmpty()){
            WorkflowModel.Node last=selectedNodes.getLast();
            WorkflowModel.Port sp=last.outputs.isEmpty()?null:last.outputs.get(0),goIn=model.input(go,"value");
            if(sp!=null&&goIn!=null)model.connect(last,sp,go,goIn);
        }
        syncGroupPorts(group);clearNodeSelection();select(group);changeListener.run();}
    private void enterGroupFocus(String groupId){groupFocusId=groupId;syncGroupPorts(model.byId(groupId));clearNodeSelection();List<WorkflowModel.Node> children=model.nodes().stream().filter(n->n.parentScopeId.equals(groupId)).toList();frameNodes(children);}
    private void cancelGroupFocus(){groupFocusId="";clearNodeSelection();frameAll();repaint();}
    private void syncGroupPorts(WorkflowModel.Node group){
        if(group==null||group.nodeKind!=WorkflowModel.NodeKind.GROUP)return;
        List<WorkflowModel.Node> groupInputNodes=model.nodes().stream().filter(n->n.nodeKind==WorkflowModel.NodeKind.GROUP_INPUT&&n.parentScopeId.equals(group.id)).toList();
        List<WorkflowModel.Node> groupOutputNodes=model.nodes().stream().filter(n->n.nodeKind==WorkflowModel.NodeKind.GROUP_OUTPUT&&n.parentScopeId.equals(group.id)).toList();
        List<WorkflowModel.Port> newInputs=new ArrayList<>(),newOutputs=new ArrayList<>();
        for(WorkflowModel.Node gin:groupInputNodes)for(WorkflowModel.Port p:gin.outputs)newInputs.add(new WorkflowModel.Port("grp_in_"+p.id,gin.name+"·"+p.name,p.dataType,p.required));
        for(WorkflowModel.Node gout:groupOutputNodes)for(WorkflowModel.Port p:gout.inputs)newOutputs.add(new WorkflowModel.Port("grp_out_"+p.id,gout.name+"·"+p.name,p.dataType,p.required));
        if(newInputs.isEmpty()&&newOutputs.isEmpty())return;
        if(newInputs.isEmpty())newInputs.add(new WorkflowModel.Port("grp_in_default","输入","any",false));
        if(newOutputs.isEmpty())newOutputs.add(new WorkflowModel.Port("grp_out_default","输出","any",false));
        model.replacePorts(group,newInputs,newOutputs);
    }

    private void includeContainerChildren(){boolean added;do{added=false;for(WorkflowModel.Node container:List.copyOf(dragOrigins.keySet()))if(isContainer(container))for(WorkflowModel.Node node:model.nodes())if(!dragOrigins.containsKey(node)&&belongsTo(node,container)){dragOrigins.put(node,new Point(node.x,node.y));added=true;}}while(added);}
    private void assignMovedNodesToContainers(){for(WorkflowModel.Node node:dragOrigins.keySet())if(!isContainer(node)||!selectedNodes.contains(node)){WorkflowModel.Node scope=containing(node,WorkflowModel.NodeKind.SCOPE),file=containing(node,WorkflowModel.NodeKind.FILE);WorkflowModel.Node currentGroup=node.parentScopeId.isBlank()?null:model.byId(node.parentScopeId);boolean inGroup=currentGroup!=null&&currentGroup.nodeKind==WorkflowModel.NodeKind.GROUP;node.parentScopeId=scope!=null?scope.id:inGroup?node.parentScopeId:"";node.scopeRegion=scope==null?"body":scope.name.startsWith("If")&&node.x+nodeWidth(node)/2>=scope.x+nodeWidth(scope)/2?"else":scope.name.startsWith("If")?"then":"body";node.fileNodeId=file==null?"":file.id;}resizeContainersToFit();}
    private void resizeContainersToFit(){
        for(WorkflowModel.Node container:model.nodes()){
            if(!isContainer(container)||container.collapsed||container==resizingNode)continue;
            List<WorkflowModel.Node> children=model.nodes().stream().filter(n->belongsTo(n,container)).toList();
            int tw,th;
            if(children.isEmpty()){tw=320;th=220;}
            else{
                int maxCX=Integer.MIN_VALUE,maxCY=Integer.MIN_VALUE;
                for(WorkflowModel.Node c:children){if(c.x+nodeWidth(c)>maxCX)maxCX=c.x+nodeWidth(c);if(c.y+nodeHeight(c)>maxCY)maxCY=c.y+nodeHeight(c);}
                tw=Math.max(320,maxCX-container.x+40);th=Math.max(220,maxCY-container.y+HEADER+40);
            }
            containerTargets.put(container.id,new int[]{tw,th});
        }
    }
    private void animateContainers(){
        boolean needsRepaint=false;
        var it=containerTargets.entrySet().iterator();
        while(it.hasNext()){
            var entry=it.next();
            WorkflowModel.Node c=model.byId(entry.getKey());
            if(c==null){it.remove();continue;}
            int[] t=entry.getValue();
            int cw=lerp(c.containerWidth,t[0],0.25),ch=lerp(c.containerHeight,t[1],0.25);
            if(cw!=c.containerWidth||ch!=c.containerHeight)needsRepaint=true;
            c.containerWidth=cw;c.containerHeight=ch;
            if(Math.abs(cw-t[0])<2&&Math.abs(ch-t[1])<2)it.remove();
        }
        if(needsRepaint)repaint();
    }
    private static int lerp(int from,int to,double t){return from+(int)((to-from)*Math.max(0,Math.min(1,t)));}
    private WorkflowModel.Node containing(WorkflowModel.Node node,WorkflowModel.NodeKind kind){Point center=new Point(node.x+nodeWidth(node)/2,node.y+Math.min(nodeHeight(node)/2,60));List<WorkflowModel.Node> candidates=model.nodes().stream().filter(candidate->candidate!=node&&candidate.nodeKind==kind&&containerBody(candidate).contains(center)&&!(kind==WorkflowModel.NodeKind.SCOPE&&scopeAncestor(node,candidate))).toList();return candidates.isEmpty()?null:candidates.getLast();}
    private boolean scopeAncestor(WorkflowModel.Node ancestor,WorkflowModel.Node candidate){if(ancestor.nodeKind!=WorkflowModel.NodeKind.SCOPE)return false;Set<String> seen=new HashSet<>();for(WorkflowModel.Node current=candidate;current!=null&&!current.parentScopeId.isBlank()&&seen.add(current.id);current=model.byId(current.parentScopeId))if(current.parentScopeId.equals(ancestor.id))return true;return false;}
    private static boolean belongsTo(WorkflowModel.Node node,WorkflowModel.Node container){if(container.nodeKind==WorkflowModel.NodeKind.FILE&&container.rangeMode)return node.fileNodeId.equals(container.id);if(container.nodeKind==WorkflowModel.NodeKind.ASSET)return node.fileNodeId.equals(container.id);return container.nodeKind==WorkflowModel.NodeKind.SCOPE?node.parentScopeId.equals(container.id):false;}
    private static boolean isContainer(WorkflowModel.Node node){return node.nodeKind==WorkflowModel.NodeKind.SCOPE||node.nodeKind==WorkflowModel.NodeKind.ASSET_BUNDLE||(node.nodeKind==WorkflowModel.NodeKind.FILE&&node.rangeMode);}
    private Rectangle containerBody(WorkflowModel.Node node){return new Rectangle(node.x+8,node.y+HEADER,nodeWidth(node)-16,nodeHeight(node)-HEADER-8);}

    private WorkflowModel.Reroute insertReroute(EdgeHit hit,Point point){WorkflowModel.Reroute reroute=new WorkflowModel.Reroute(point.x,point.y);hit.edge.reroutes().add(Math.min(hit.segmentIndex,hit.edge.reroutes().size()),reroute);return reroute;}
    private void selectReroute(WorkflowModel.Edge edge,WorkflowModel.Reroute point){selectedEdge=edge;rerouteEdge=edge;selectedReroute=point;repaint();}
    private boolean connectNodes(WorkflowModel.Node source,WorkflowModel.Port sourcePort,WorkflowModel.Node target,WorkflowModel.Port targetPort){WorkflowModel.ConnectionResult result=model.connectChecked(source,sourcePort,target,targetPort);if(!result.connected())feedback(result.reason());return result.connected();}
    private void feedback(String message){feedbackListener.accept(message);}
    private boolean connectFromReroute(WorkflowModel.Reroute point,WorkflowModel.Node target,WorkflowModel.Port targetPort){RerouteOrigin origin=rerouteOrigin(point);if(origin==null)return false;WorkflowModel.Node source=model.byId(origin.edge.source());WorkflowModel.Port sourcePort=source==null?null:model.output(source,origin.edge.sourcePort());if(source==null||sourcePort==null)return false;List<WorkflowModel.Reroute> route=new ArrayList<>();for(WorkflowModel.Reroute candidate:origin.edge.reroutes()){route.add(candidate);if(candidate.id.equals(origin.anchor.id))break;}if(!connectNodes(source,sourcePort,target,targetPort))return false;model.edges().getLast().reroutes().addAll(route);return true;}
    private RerouteOrigin rerouteOrigin(WorkflowModel.Reroute point){for(WorkflowModel.Edge edge:model.edges())if(edge.reroutes().stream().anyMatch(candidate->candidate.id.equals(point.id)))return new RerouteOrigin(edge,point);return null;}
    private void insertReroutesFromStroke(){Set<WorkflowModel.Edge> changed=new HashSet<>();for(int i=1;i<reroutePath.size();i++){Point a=reroutePath.get(i-1),b=reroutePath.get(i);for(WorkflowModel.Edge edge:model.edges()){if(changed.contains(edge))continue;EdgeHit hit=intersectEdge(edge,a,b);if(hit!=null){Point point=new Point((a.x+b.x)/2,(a.y+b.y)/2);insertReroute(hit,point);changed.add(edge);}}}if(!changed.isEmpty())changeListener.run();}
    private void cutEdges(){if(cutPath.size()<2)return;List<WorkflowModel.Edge> removed=new ArrayList<>();for(WorkflowModel.Edge edge:model.edges())for(int i=1;i<cutPath.size();i++)if(intersectEdge(edge,cutPath.get(i-1),cutPath.get(i))!=null){removed.add(edge);break;}model.removeEdges(removed);if(!removed.isEmpty())changeListener.run();}

    @Override protected void paintComponent(Graphics raw){super.paintComponent(raw);Graphics2D screen=(Graphics2D)raw.create();screen.setRenderingHint(RenderingHints.KEY_ANTIALIASING,RenderingHints.VALUE_ANTIALIAS_ON);
        if(!groupFocusId.isBlank()){WorkflowModel.Node g=model.byId(groupFocusId);if(g!=null){screen.setColor(new Color(45,45,48));screen.fillRect(0,0,getWidth(),28);screen.setColor(UiTheme.ACCENT);screen.setFont(getFont().deriveFont(Font.BOLD,13f));screen.drawString("根 > "+g.name,12,20);screen.setColor(new Color(70,70,73));screen.drawLine(0,28,getWidth(),28);}}
        drawGrid(screen);screen.translate(panX,panY);screen.scale(zoom,zoom);for(WorkflowModel.Node node:model.nodes())if(isContainer(node)&&visibleNode(node))drawNode(screen,node);drawEdges(screen);if(connecting!=null&&wirePoint!=null)drawCurve(screen,portCenter(outputPort(connecting,connectingPort)),wirePoint,new Color(86,156,214),2.5f);if(inputConnecting!=null&&wirePoint!=null)drawCurve(screen,wirePoint,portCenter(inputPort(inputConnecting,inputConnectingPort)),new Color(86,156,214),2.5f);if(connectingReroute!=null&&wirePoint!=null)drawCurve(screen,new Point(connectingReroute.x,connectingReroute.y),wirePoint,new Color(210,170,70),2.5f);for(WorkflowModel.Node node:model.nodes())if(!isContainer(node)&&visibleNode(node))drawNode(screen,node);drawOverlay(screen);screen.dispose();}
    private void drawGrid(Graphics2D g){double step=20*zoom;if(step<6)return;double sx=mod(panX,step),sy=mod(panY,step);for(double x=sx;x<getWidth();x+=step){int index=(int)Math.round((x-panX)/step);g.setColor(Math.floorMod(index,5)==0?new Color(52,52,54):new Color(39,39,41));g.drawLine((int)x,0,(int)x,getHeight());}for(double y=sy;y<getHeight();y+=step){int index=(int)Math.round((y-panY)/step);g.setColor(Math.floorMod(index,5)==0?new Color(52,52,54):new Color(39,39,41));g.drawLine(0,(int)y,getWidth(),(int)y);}}
    private void drawEdges(Graphics2D g){LinkedHashSet<WorkflowModel.Reroute> visibleReroutes=new LinkedHashSet<>();for(WorkflowModel.Edge edge:model.edges()){WorkflowModel.Node source=model.byId(edge.source()),target=model.byId(edge.target());if(!visibleNode(source)||!visibleNode(target))continue;List<Point> points=edgePoints(edge);if(points.size()<2)continue;visibleReroutes.addAll(edge.reroutes());Color color=edge==selectedEdge?UiTheme.ACCENT:new Color(86,156,214);float width=edge==selectedEdge?3f:2f;for(int i=1;i<points.size();i++)drawCurve(g,points.get(i-1),points.get(i),color,width);}for(WorkflowModel.Reroute point:visibleReroutes){g.setColor(UiTheme.PANEL);g.fill(new Ellipse2D.Double(point.x-6,point.y-6,12,12));g.setColor(point==selectedReroute?UiTheme.ACCENT:new Color(210,170,70));g.setStroke(new BasicStroke(2f));g.draw(new Ellipse2D.Double(point.x-6,point.y-6,12,12));}}
    private void drawCurve(Graphics2D g,Point p,Point q,Color color,float width){g.setStroke(new BasicStroke((float)(width/zoom)));g.setColor(color);int handle=Math.max(35,Math.abs(q.x-p.x)/2);g.draw(new CubicCurve2D.Float(p.x,p.y,p.x+handle,p.y,q.x-handle,q.y,q.x,q.y));}
    private void drawNode(Graphics2D g,WorkflowModel.Node n){
        int width=nodeWidth(n),height=nodeHeight(n);Color border=switch(n.status){case FAILED->new Color(244,71,71);case SUCCEEDED->new Color(78,201,176);case QUEUED,PROCESSING->new Color(220,170,70);default->new Color(82,82,88);};
        Color bgColor=n.status==WorkflowModel.Status.SUCCEEDED?new Color(55,55,60):(isContainer(n)?new Color(38,38,40,150):UiTheme.PANEL);
        RoundRectangle2D box=new RoundRectangle2D.Float(n.x,n.y,width,height,7,7);g.setColor(bgColor);g.fill(box);Color header=n.status==WorkflowModel.Status.QUEUED||n.status==WorkflowModel.Status.PROCESSING?new Color(138,116,64):categoryColor(n);g.setColor(selectedNodes.contains(n)?header.brighter():header);g.fill(new RoundRectangle2D.Float(n.x+1,n.y+1,width-2,HEADER,6,6));
        g.setStroke(new BasicStroke((float)((n==primary?2.8:selectedNodes.contains(n)?2.1:n==hoveringScope?3.5:1.5)/zoom)));
        g.setColor(n==hoveringScope?UiTheme.ACCENT:selectedNodes.contains(n)?UiTheme.ACCENT:border);g.draw(box);
        if(n==hoveringScope){g.setColor(new Color(0,122,204,40));g.fill(box);}
        g.setColor(n.muted?new Color(230,160,160):Color.WHITE);g.setFont(getFont().deriveFont(Font.BOLD,14f));g.drawString(trim(n.name,isContainer(n)?35:(n.nodeKind==WorkflowModel.NodeKind.GROUP?30:17)),n.x+13,n.y+22);
        if(n.nodeKind==WorkflowModel.NodeKind.GROUP){
            g.setFont(getFont().deriveFont(Font.BOLD,9f));
            g.setColor(new Color(180,170,220));
            String grpLabel="GRP";int grpW=g.getFontMetrics().stringWidth(grpLabel);
            g.drawString(grpLabel,n.x+width-24-grpW,n.y+21);
        }
        String category=trim(n.category,12);g.setFont(getFont().deriveFont(10f));g.setColor(new Color(225,225,225));g.drawString(category,n.x+width-11-g.getFontMetrics().stringWidth(category),n.y+21);if(n.collapsed)return;
        if(n.nodeKind==WorkflowModel.NodeKind.ASSET_BUNDLE){
            BundleDataUtil.BundleView view=bundleView(n);
            g.setColor(new Color(120,160,220));g.setFont(getFont().deriveFont(Font.BOLD,11f));
            g.drawString("成员 "+view.memberCount(),n.x+13,n.y+HEADER+18);
            int bx=n.x+13,by=n.y+HEADER+28;
            for(Map.Entry<String,Integer> e:view.categoryStats().entrySet()){
                String text=e.getKey()+" "+e.getValue();
                int w=g.getFontMetrics().stringWidth(text)+12;
                if(bx+w>n.x+nodeWidth(n)-10){bx=n.x+13;by+=18;}
                g.setColor(new Color(70,90,120));g.fillRoundRect(bx,by-12,w,16,5,5);
                g.setColor(new Color(200,215,230));g.drawString(text,bx+6,by);
                bx+=w+5;
            }
            if(!n.bundleCollapsed){
                int py=by+20;
                int shown=0;
                for(BundleDataUtil.BundleMember m:view.members()){
                    if(shown>=8)break;
                    g.setColor(UiTheme.MUTED);g.setFont(getFont().deriveFont(10f));
                    g.drawString(trim(m.relativePath(),26),n.x+16,py);
                    py+=14;shown++;
                }
                if(view.members().size()>8){g.setColor(new Color(210,200,120));g.drawString("… 共 "+view.members().size()+" 项",n.x+16,py);}
                g.setColor(new Color(100,100,105));g.drawString("双击收起/展开预览",n.x+16,py+14);
            }else{
                g.setColor(new Color(100,100,105));g.drawString("双击展开成员预览",n.x+13,by+20);
            }
        }
        if(n.detailMode&&!isContainer(n)&&hasPrompt(n)){
            FontMetrics fm=detailMetrics();
            List<String> lines=wrapPrompt(n.prompt,width-2*DETAIL_PAD_X,fm);
            int portsArea=Math.max(n.inputs.size(),n.outputs.size())*PORT_STEP+28;
            int visible=Math.max(1,(height-HEADER-6-portsArea-4)/DETAIL_LINE_HEIGHT);
            int show=Math.min(visible,lines.size());
            g.setFont(getFont().deriveFont(DETAIL_FONT_SIZE));
            g.setColor(UiTheme.MUTED);
            int baseline=n.y+HEADER+6+fm.getAscent();
            for(int i=0;i<show;i++)g.drawString(lines.get(i),n.x+DETAIL_PAD_X,baseline+i*DETAIL_LINE_HEIGHT);
            if(lines.size()>visible)g.drawString("…",n.x+DETAIL_PAD_X+fm.stringWidth(lines.get(visible-1)),baseline+(visible-1)*DETAIL_LINE_HEIGHT);
        }
        g.setFont(getFont().deriveFont(12f));for(int i=0;i<n.inputs.size();i++){WorkflowModel.Port p=n.inputs.get(i);g.setColor(UiTheme.MUTED);g.drawString(trim(p.name+" : "+p.dataType,17),n.x+13,portY(n,i)+4);g.setColor(portColor(p));boolean isCondition=n.nodeKind==WorkflowModel.NodeKind.SCOPE&&i==0&&(p.dataType.contains("boolean")||p.dataType.contains("bool"));if(isCondition){int cx=(int)inputPort(n,p).getCenterX(),cy=(int)inputPort(n,p).getCenterY();g.fill(new Polygon(new int[]{cx-PORT,cx,cx+PORT,cx},new int[]{cy,cy-PORT-2,cy,cy+PORT+2},4));}else g.fill(inputPort(n,p));}for(int i=0;i<n.outputs.size();i++){WorkflowModel.Port p=n.outputs.get(i);String text=trim(p.name+" : "+p.dataType,17);g.setColor(UiTheme.MUTED);g.drawString(text,n.x+width-13-g.getFontMetrics().stringWidth(text),portY(n,i)+4);g.setColor(portColor(p));g.fill(outputPort(n,p));}        g.setColor(UiTheme.MUTED);g.drawString(n.category+" · "+statusLabel(n.status),n.x+13,n.y+height-10);
        g.setColor(new Color(100,100,105));g.fillPolygon(new int[]{n.x+width-10,n.x+width,n.x+width},new int[]{n.y+height,n.y+height-10,n.y+height},3);
        if(isContainer(n)){g.setColor(new Color(190,190,195));g.setFont(getFont().deriveFont(Font.BOLD,11f));if(n.name.startsWith("If")){int middle=n.x+width/2;g.drawLine(middle,n.y+HEADER+34,middle,n.y+height-28);g.drawString("then",n.x+14,n.y+HEADER+22);g.drawString("else",middle+12,n.y+HEADER+22);}else g.drawString("body",n.x+14,n.y+HEADER+22);}
    }
    private void drawOverlay(Graphics2D g){if(boxStart!=null&&boxCurrent!=null){g.setColor(new Color(0,122,204,45));g.fill(box());g.setColor(UiTheme.ACCENT);g.setStroke(new BasicStroke((float)(1.5/zoom)));g.draw(box());}drawPath(g,cutPath,new Color(244,71,71));drawPath(g,reroutePath,new Color(210,170,70));}
    private void drawPath(Graphics2D g,List<Point> path,Color color){if(path.size()<2)return;g.setColor(color);g.setStroke(new BasicStroke((float)(2.5/zoom)));for(int i=1;i<path.size();i++)g.drawLine(path.get(i-1).x,path.get(i-1).y,path.get(i).x,path.get(i).y);}

    private EdgeHit hitEdge(Point point){double limit=9/zoom;for(int i=model.edges().size()-1;i>=0;i--){WorkflowModel.Edge edge=model.edges().get(i);List<Point> anchors=edgePoints(edge);for(int segment=0;segment<anchors.size()-1;segment++){List<Point> samples=curveSamples(anchors.get(segment),anchors.get(segment+1));for(int j=1;j<samples.size();j++)if(Line2D.ptSegDist(samples.get(j-1).x,samples.get(j-1).y,samples.get(j).x,samples.get(j).y,point.x,point.y)<=limit)return new EdgeHit(edge,segment);}}return null;}
    private EdgeHit intersectEdge(WorkflowModel.Edge edge,Point a,Point b){List<Point> anchors=edgePoints(edge);for(int segment=0;segment<anchors.size()-1;segment++){List<Point> samples=curveSamples(anchors.get(segment),anchors.get(segment+1));for(int i=1;i<samples.size();i++)if(Line2D.linesIntersect(a.x,a.y,b.x,b.y,samples.get(i-1).x,samples.get(i-1).y,samples.get(i).x,samples.get(i).y))return new EdgeHit(edge,segment);}return null;}
    private List<Point> edgePoints(WorkflowModel.Edge edge){WorkflowModel.Node a=model.byId(edge.source()),b=model.byId(edge.target());if(a==null||b==null||!visibleNode(a)||!visibleNode(b))return List.of();WorkflowModel.Port out=model.output(a,edge.sourcePort()),in=model.input(b,edge.targetPort());if(out==null||in==null)return List.of();List<Point> points=new ArrayList<>();points.add(portCenter(outputPort(a,out)));edge.reroutes().forEach(p->points.add(new Point(p.x,p.y)));points.add(portCenter(inputPort(b,in)));return points;}
    private static List<Point> curveSamples(Point p,Point q){int handle=Math.max(35,Math.abs(q.x-p.x)/2);List<Point> points=new ArrayList<>();for(int step=0;step<=24;step++){double t=step/24d,u=1-t;points.add(new Point((int)(u*u*u*p.x+3*u*u*t*(p.x+handle)+3*u*t*t*(q.x-handle)+t*t*t*q.x),(int)(u*u*u*p.y+3*u*u*t*p.y+3*u*t*t*q.y+t*t*t*q.y)));}return points;}
    private RerouteHit hitReroute(Point p){double radius=9/zoom;for(int i=model.edges().size()-1;i>=0;i--){WorkflowModel.Edge edge=model.edges().get(i);for(WorkflowModel.Reroute point:edge.reroutes())if(Point2D.distance(p.x,p.y,point.x,point.y)<=radius)return new RerouteHit(edge,point);}return null;}
    private PortHit hitPort(Point p){double radius=12/zoom;for(int i=model.nodes().size()-1;i>=0;i--){WorkflowModel.Node n=model.nodes().get(i);if(!visibleNode(n))continue;for(WorkflowModel.Port port:n.outputs)if(portCenter(outputPort(n,port)).distance(p)<=radius)return new PortHit(n,port,true);for(WorkflowModel.Port port:n.inputs)if(portCenter(inputPort(n,port)).distance(p)<=radius)return new PortHit(n,port,false);}return null;}
    private WorkflowModel.Node hitNode(Point p){for(int pass=0;pass<2;pass++)for(int i=model.nodes().size()-1;i>=0;i--){WorkflowModel.Node n=model.nodes().get(i);if(!visibleNode(n)||(pass==0)==isContainer(n))continue;if(new Rectangle(n.x,n.y,nodeWidth(n),nodeHeight(n)).contains(p))return n;}return null;}
    private boolean visibleNode(WorkflowModel.Node node){if(node==null)return false;if(!groupFocusId.isBlank()&&!node.parentScopeId.equals(groupFocusId))return false;return !hiddenByAncestor(node,new HashSet<>());}
    private boolean hiddenByAncestor(WorkflowModel.Node node,Set<String> seen){if(node==null||!seen.add(node.id))return false;WorkflowModel.Node parent=node.parentScopeId.isBlank()?null:model.byId(node.parentScopeId),file=node.fileNodeId.isBlank()?null:model.byId(node.fileNodeId);if(parent!=null&&parent.nodeKind==WorkflowModel.NodeKind.GROUP&&!node.parentScopeId.equals(groupFocusId))return true;return parent!=null&&(parent.collapsed||hiddenByAncestor(parent,seen))||file!=null&&((file.collapsed)||hiddenByAncestor(file,seen));}
    private Rectangle box(){int x=Math.min(boxStart.x,boxCurrent.x),y=Math.min(boxStart.y,boxCurrent.y);return new Rectangle(x,y,Math.abs(boxCurrent.x-boxStart.x),Math.abs(boxCurrent.y-boxStart.y));}
    private int nodeWidth(WorkflowModel.Node n){
        if(!n.collapsed&&!isContainer(n)&&n.detailMode&&hasPrompt(n)){int w=detailPromptWidth(n);int maxPortLen=w<160?w/9:20;for(WorkflowModel.Port p:n.inputs)maxPortLen=Math.max(maxPortLen,p.name.length()+p.dataType.length()+4);for(WorkflowModel.Port p:n.outputs)maxPortLen=Math.max(maxPortLen,p.name.length()+p.dataType.length()+4);return Math.max(w,Math.max(140,50+maxPortLen*7));}
        int w=!n.collapsed&&isContainer(n)?Math.max(320,n.containerWidth):Math.max(140,n.nodeWidth);
        int maxPortLen=w<160?w/9:20;
        for(WorkflowModel.Port p:n.inputs)maxPortLen=Math.max(maxPortLen,p.name.length()+p.dataType.length()+4);
        for(WorkflowModel.Port p:n.outputs)maxPortLen=Math.max(maxPortLen,p.name.length()+p.dataType.length()+4);
        return Math.max(w,Math.max(140,50+maxPortLen*7));
    }
    private int nodeHeight(WorkflowModel.Node n){
        if(n.collapsed)return HEADER+2;
        if(n.nodeKind==WorkflowModel.NodeKind.ASSET_BUNDLE&&!n.bundleCollapsed){
            int body=HEADER+bundlePreviewOffset(n)+Math.max(2,n.inputs.size())*PORT_STEP+28;
            return Math.max(240,Math.max(220,body));
        }
        if(isContainer(n))return Math.max(220,n.containerHeight);
        if(n.detailMode&&hasPrompt(n))return detailPromptHeight(n);
        int base=Math.max(92,n.nodeHeight);
        int ports=Math.max(n.inputs.size(),n.outputs.size())*PORT_STEP+28;
        return Math.max(base,HEADER+ports);
    }
    private int portY(WorkflowModel.Node n,int index){
        int base=n.y+HEADER+14;
        if(n.nodeKind==WorkflowModel.NodeKind.ASSET_BUNDLE&&!n.bundleCollapsed)base+=bundlePreviewOffset(n);
        if(n.detailMode&&!n.collapsed&&!isContainer(n)&&hasPrompt(n))base+=promptAreaHeight(n)+6;
        return base+index*PORT_STEP;
    }
    private boolean hasPrompt(WorkflowModel.Node n){return n.prompt!=null&&!n.prompt.isBlank();}
    private BundleDataUtil.BundleView bundleView(WorkflowModel.Node n){
        String key=n.id+"|"+n.bundleData;
        BundleDataUtil.BundleView cached=bundleViewCache.get(key);
        if(cached!=null)return cached;
        BundleDataUtil.BundleView view;
        if(n.bundleData==null||n.bundleData.isBlank())view=new BundleDataUtil.BundleView(1,0,Map.of(),"",List.of());
        else{BundleDataUtil.BundleView parsed=BundleDataUtil.parseV2(n.bundleData);view=parsed.schemaVersion()!=2?BundleDataUtil.downgradeV1(n.bundleData):parsed;}
        bundleViewCache.put(key,view);
        return view;
    }
    private int bundlePreviewOffset(WorkflowModel.Node n){
        if(n.nodeKind!=WorkflowModel.NodeKind.ASSET_BUNDLE||n.bundleCollapsed)return 0;
        return Math.min(8,bundleView(n).members().size())*14+64;
    }
    private FontMetrics detailMetrics(){return getFontMetrics(getFont().deriveFont(DETAIL_FONT_SIZE));}
    private int detailPromptWidth(WorkflowModel.Node n){
        FontMetrics fm=detailMetrics();
        List<String> lines=wrapPrompt(n.prompt,Integer.MAX_VALUE/2,fm);
        int maxLine=0;for(String line:lines)maxLine=Math.max(maxLine,fm.stringWidth(line));
        return Math.min(DETAIL_MAX_WIDTH,Math.max(DETAIL_MIN_WIDTH,maxLine+2*DETAIL_PAD_X));
    }
    private int detailPromptHeight(WorkflowModel.Node n){
        int w=nodeWidth(n);
        FontMetrics fm=detailMetrics();
        List<String> lines=wrapPrompt(n.prompt,w-2*DETAIL_PAD_X,fm);
        int portsArea=Math.max(n.inputs.size(),n.outputs.size())*PORT_STEP+28;
        int maxTextArea=DETAIL_MAX_HEIGHT-HEADER-6-portsArea-4;
        int visible=Math.max(1,maxTextArea/DETAIL_LINE_HEIGHT);
        int textArea=Math.min(visible,lines.size())*DETAIL_LINE_HEIGHT;
        return Math.min(DETAIL_MAX_HEIGHT,Math.max(DETAIL_MIN_HEIGHT,HEADER+6+textArea+portsArea+4));
    }
    private int promptAreaHeight(WorkflowModel.Node n){
        int w=nodeWidth(n);
        FontMetrics fm=detailMetrics();
        List<String> lines=wrapPrompt(n.prompt,w-2*DETAIL_PAD_X,fm);
        int portsArea=Math.max(n.inputs.size(),n.outputs.size())*PORT_STEP+28;
        int maxTextArea=DETAIL_MAX_HEIGHT-HEADER-6-portsArea-4;
        int visible=Math.max(1,maxTextArea/DETAIL_LINE_HEIGHT);
        return Math.min(visible,lines.size())*DETAIL_LINE_HEIGHT;
    }
    private List<String> wrapPrompt(String text,int targetWidth,FontMetrics fm){
        List<String> lines=new ArrayList<>();
        String[] paragraphs=text.split("\n",-1);
        for(int p=0;p<paragraphs.length;p++){
            StringBuilder current=new StringBuilder();
            for(String word:paragraphs[p].split(" ",-1)){
                if(word.isEmpty()){if(current.length()>0)current.append(' ');continue;}
                if(current.length()==0){
                    if(fm.stringWidth(word)<=targetWidth){current.append(word);}
                    else{breakLongWord(current,word,targetWidth,fm,lines);}
                    continue;
                }
                String candidate=current+" "+word;
                if(fm.stringWidth(candidate)<=targetWidth){current.setLength(0);current.append(candidate);}
                else{
                    lines.add(current.toString());current.setLength(0);
                    if(fm.stringWidth(word)<=targetWidth){current.append(word);}
                    else{breakLongWord(current,word,targetWidth,fm,lines);}
                }
            }
            lines.add(current.toString());
            if(p<paragraphs.length-1)lines.add("");
        }
        return lines;
    }
    private void breakLongWord(StringBuilder current,String word,int targetWidth,FontMetrics fm,List<String> lines){
        int idx=0;
        while(idx<word.length()){
            int end=idx+1;
            while(end<=word.length()&&fm.stringWidth(word.substring(idx,end))<=targetWidth)end++;
            end--;
            if(end<idx+1)end=idx+1;
            String piece=word.substring(idx,end);
            if(current.length()==0)current.append(piece);
            else{lines.add(current.toString());current.setLength(0);current.append(piece);}
            idx=end;
        }
    }
    private Ellipse2D inputPort(WorkflowModel.Node n,WorkflowModel.Port p){int i=Math.max(0,n.inputs.indexOf(p)),y=n.collapsed?n.y+HEADER/2:portY(n,i);return new Ellipse2D.Double(n.x-PORT,y-PORT,PORT*2,PORT*2);}
    private Ellipse2D outputPort(WorkflowModel.Node n,WorkflowModel.Port p){int i=Math.max(0,n.outputs.indexOf(p)),y=n.collapsed?n.y+HEADER/2:portY(n,i);return new Ellipse2D.Double(n.x+nodeWidth(n)-PORT,y-PORT,PORT*2,PORT*2);}
    private Point world(Point screen){return new Point((int)Math.round((screen.x-panX)/zoom),(int)Math.round((screen.y-panY)/zoom));}
    private static Point portCenter(Ellipse2D port){return new Point((int)port.getCenterX(),(int)port.getCenterY());}
    private static Color portColor(WorkflowModel.Port p){String type=p.dataType.toLowerCase(Locale.ROOT);if(type.startsWith("array")||type.contains("vector")||type.equals("normal")||type.equals("color"))return new Color(142,105,205);return switch(type){case "int","integer","float","double","number"->new Color(90,145,205);case "boolean","bool"->new Color(210,100,145);case "string"->new Color(105,160,115);default->new Color(150,155,165);};}
    private static Color categoryColor(WorkflowModel.Node node){if(!node.nodeColor.isBlank()){try{if(node.nodeColor.startsWith("#"))return Color.decode(node.nodeColor);}catch(Exception ignored){}}if(node.composite)return new Color(65,65,72);if(node.classificationKey.startsWith("asset.")){return switch(node.assetType){case "image","texture"->new Color(140,60,100);case "model"->new Color(50,120,140);case "animation"->new Color(160,80,40);case "particle"->new Color(120,40,160);case "language"->new Color(40,120,85);case "audio"->new Color(60,80,160);case "video"->new Color(160,40,60);default->new Color(90,85,80);};}return switch(node.classificationKey){case "value.scalar","calculation.scalar"->new Color(63,111,168);case "value.vector","value.array","calculation.vector"->new Color(118,81,168);case "value.boolean","calculation.boolean"->new Color(182,78,122);case "scope.flow"->new Color(167,101,50);case "scope.group"->new Color(100,95,140);case "file.source"->new Color(40,122,120);case "text.string"->new Color(79,125,87);case "io.input","io.output","io.group-output","io.group-input"->new Color(47,125,140);case "io.capture"->new Color(160,90,45);case "agent.custom"->new Color(138,116,64);default->switch(node.category.toLowerCase(Locale.ROOT)){case "java"->new Color(125,82,42);case "powershell"->new Color(45,82,125);case "go"->new Color(38,105,118);case "输入","输入与解析"->new Color(55,95,105);default->new Color(92,99,112);};};}
    private static String statusLabel(WorkflowModel.Status status){return switch(status){case IDLE->"空闲";case QUEUED->"已排队";case PROCESSING->"制作中";case REVIEW_READY->"待审查";case ACCEPTED->"已接受";case SUCCEEDED->"成功";case FAILED->"失败";case CANCELLED->"已取消";case REJECTED->"已拒绝";case CONFLICTED->"版本冲突";};}
    private static double clamp(double value,double min,double max){return Math.max(min,Math.min(max,value));}
    private static double mod(double value,double divisor){double result=value%divisor;return result<0?result+divisor:result;}
    private static String trim(String text,int max){return text.length()<=max?text:text.substring(0,max-1)+"…";}
    private enum SelectionMode{REPLACE,ADD,SUBTRACT}
    private record PortHit(WorkflowModel.Node node,WorkflowModel.Port port,boolean output){}
    private record EdgeHit(WorkflowModel.Edge edge,int segmentIndex){}
    private record RerouteHit(WorkflowModel.Edge edge,WorkflowModel.Reroute point){}
    private record RerouteOrigin(WorkflowModel.Edge edge,WorkflowModel.Reroute anchor){}
}
