package local.codenode;

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
    private static final int WIDTH=215, HEADER=34, PORT_STEP=22, PORT=6;
    private final WorkflowModel model;
    private WorkflowModel.Node selected, dragging, connecting;
    private WorkflowModel.Port connectingPort;
    private Point dragOffset, panStart, panOrigin, wirePoint, lastMouse=new Point(300,220);
    private final List<Point> cutPath=new ArrayList<>();
    private int panX,panY;
    private Consumer<WorkflowModel.Node> selectionListener=node->{};
    private Supplier<String> languageSupplier=()->"java";

    public CanvasPanel(WorkflowModel model) {
        this.model=model;setBackground(UiTheme.BACKGROUND);setPreferredSize(new Dimension(1600,1000));setFocusable(true);
        MouseAdapter mouse=new MouseAdapter(){
            @Override public void mousePressed(MouseEvent e){requestFocusInWindow();lastMouse=e.getPoint();Point world=world(e.getPoint());
                if(SwingUtilities.isMiddleMouseButton(e)){panStart=e.getPoint();panOrigin=new Point(panX,panY);return;}
                if(SwingUtilities.isRightMouseButton(e)&&e.isControlDown()){cutPath.clear();cutPath.add(world);return;}
                if(!SwingUtilities.isLeftMouseButton(e))return;
                PortHit port=hitPort(world);if(port!=null&&port.output){connecting=port.node;connectingPort=port.port;wirePoint=world;repaint();return;}
                WorkflowModel.Node hit=hitNode(world);setSelected(hit);if(hit!=null){dragging=hit;dragOffset=new Point(world.x-hit.x,world.y-hit.y);}
            }
            @Override public void mouseDragged(MouseEvent e){lastMouse=e.getPoint();Point world=world(e.getPoint());
                if(panStart!=null){panX=panOrigin.x+e.getX()-panStart.x;panY=panOrigin.y+e.getY()-panStart.y;repaint();return;}
                if(!cutPath.isEmpty()){cutPath.add(world);repaint();return;}
                if(connecting!=null){wirePoint=world;repaint();return;}
                if(dragging!=null){dragging.x=world.x-dragOffset.x;dragging.y=world.y-dragOffset.y;repaint();}
            }
            @Override public void mouseReleased(MouseEvent e){Point world=world(e.getPoint());
                if(panStart!=null){panStart=null;return;}
                if(!cutPath.isEmpty()){cutEdges();cutPath.clear();repaint();return;}
                if(connecting!=null){PortHit target=hitPort(world);if(target!=null&&!target.output&&model.connect(connecting,connectingPort,target.node,target.port))setSelected(target.node);connecting=null;connectingPort=null;wirePoint=null;repaint();}
                dragging=null;
            }
            @Override public void mouseMoved(MouseEvent e){lastMouse=e.getPoint();if(connecting!=null){wirePoint=world(e.getPoint());repaint();}}
        };addMouseListener(mouse);addMouseMotionListener(mouse);installKeys();
    }

    public void onSelection(Consumer<WorkflowModel.Node> listener){selectionListener=listener;}
    public void setLanguageSupplier(Supplier<String> supplier){languageSupplier=supplier;}
    public WorkflowModel.Node selected(){return selected;}
    public void select(WorkflowModel.Node node){setSelected(node);}
    private void setSelected(WorkflowModel.Node node){selected=node;selectionListener.accept(node);repaint();}

    private void installKeys(){
        bind("shift A",this::showAddMenu);bind("shift W",this::showQuickMenu);bind("DELETE",this::deleteSelected);bind("X",this::deleteSelected);
        bind("shift D",this::duplicateSelected);bind("H",()->toggleSelected(n->n.collapsed=!n.collapsed));bind("M",()->toggleSelected(n->n.muted=!n.muted));
        bind("HOME",this::frameAll);bind("control X",this::deleteWithReconnect);bind("alt X",this::deleteUnused);
    }
    private void bind(String stroke,Runnable action){String key="action-"+stroke;getInputMap(WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke(stroke),key);getActionMap().put(key,new AbstractAction(){@Override public void actionPerformed(ActionEvent e){if(KeyboardFocusManager.getCurrentKeyboardFocusManager().getFocusOwner() instanceof JTextComponent)return;action.run();}});}

    private void showAddMenu(){nodeMenu().show(this,lastMouse.x,lastMouse.y);}
    private JPopupMenu nodeMenu(){JPopupMenu menu=new JPopupMenu();menu.add(menuItem("空白节点",()->addTemplate("空白节点","基础","说明这个节点应完成的工作",1,1)));
        JMenu basic=new JMenu("基础");basic.add(menuItem("If 判断",()->addTemplate("If 判断","基础","根据布尔条件选择执行分支",2,2)));basic.add(menuItem("For 循环",()->addTemplate("For 循环","基础","遍历输入集合并执行循环体",2,2)));basic.add(menuItem("While 循环",()->addTemplate("While 循环","基础","条件成立时重复执行循环体",2,2)));menu.add(basic);
        JMenu values=new JMenu("数值与常量");values.add(menuItem("整数常量",()->addTemplate("整数常量","数值","提供一个整数常量",0,1)));values.add(menuItem("浮点常量",()->addTemplate("浮点常量","数值","提供一个浮点常量",0,1)));values.add(menuItem("布尔常量",()->addTemplate("布尔常量","数值","提供一个布尔常量",0,1)));values.add(menuItem("字符串常量",()->addTemplate("字符串常量","数值","提供一个字符串常量",0,1)));menu.add(values);
        JMenu language=new JMenu(languageSupplier.get()+" 专用");switch(languageSupplier.get()){
            case "powershell"->{language.add(menuItem("管道处理",()->addTemplate("PowerShell 管道","PowerShell","通过管道变换输入对象",1,1)));language.add(menuItem("Cmdlet 调用",()->addTemplate("Cmdlet 调用","PowerShell","调用指定 PowerShell Cmdlet",1,1)));}
            case "go"->{language.add(menuItem("Goroutine",()->addTemplate("Goroutine","Go","并发执行输入任务并等待结果",1,1)));language.add(menuItem("Channel",()->addTemplate("Channel","Go","通过类型化 Channel 传递数据",1,1)));}
            default->{language.add(menuItem("Stream 处理",()->addTemplate("Java Stream","Java","使用 Stream API 变换集合",1,1)));language.add(menuItem("异常捕获",()->addTemplate("Try / Catch","Java","捕获并处理 Java 异常",1,2)));}
        }menu.add(language);UiTheme.apply(menu);return menu;
    }
    private void showQuickMenu(){JPopupMenu menu=new JPopupMenu();menu.add(menuItem("复制节点  Shift+D",this::duplicateSelected));menu.add(menuItem("折叠节点  H",()->toggleSelected(n->n.collapsed=!n.collapsed)));menu.add(menuItem("静音节点  M",()->toggleSelected(n->n.muted=!n.muted)));menu.add(menuItem("查看全部  Home",this::frameAll));menu.add(menuItem("删除并重连  Ctrl+X",this::deleteWithReconnect));menu.add(menuItem("清理未连接节点  Alt+X",this::deleteUnused));UiTheme.apply(menu);menu.show(this,lastMouse.x,lastMouse.y);}
    private JMenuItem menuItem(String text,Runnable action){JMenuItem item=new JMenuItem(text);item.addActionListener(e->action.run());return item;}
    private void addTemplate(String name,String category,String prompt,int inputCount,int outputCount){Point p=world(lastMouse);WorkflowModel.Node node=model.addNode(p.x,p.y);node.name=name;node.category=category;node.prompt=prompt;node.inputs.clear();node.outputs.clear();for(int i=0;i<inputCount;i++)node.inputs.add(new WorkflowModel.Port("in"+(i+1),inputCount==1?"输入":"输入 "+(i+1),"any",false));for(int i=0;i<outputCount;i++)node.outputs.add(new WorkflowModel.Port("out"+(i+1),outputCount==1?"输出":"输出 "+(i+1),"any",false));setSelected(node);}
    private void duplicateSelected(){if(selected==null)return;WorkflowModel.Node copy=model.duplicate(selected,selected.x+30,selected.y+30);setSelected(copy);}
    private void deleteSelected(){if(selected==null)return;model.removeNode(selected);setSelected(null);}
    private void deleteWithReconnect(){if(selected==null)return;List<WorkflowModel.Edge> incoming=model.edges().stream().filter(e->e.target().equals(selected.id)).toList();List<WorkflowModel.Edge> outgoing=model.edges().stream().filter(e->e.source().equals(selected.id)).toList();if(!incoming.isEmpty()&&!outgoing.isEmpty()){WorkflowModel.Edge a=incoming.getFirst(),b=outgoing.getFirst();WorkflowModel.Node source=model.byId(a.source()),target=model.byId(b.target());WorkflowModel.Port sp=model.output(source,a.sourcePort()),tp=model.input(target,b.targetPort());if(source!=null&&target!=null&&sp!=null&&tp!=null)model.connect(source,sp,target,tp);}deleteSelected();}
    private void deleteUnused(){List<WorkflowModel.Node> unused=model.nodes().stream().filter(n->n!=selected&&model.edges().stream().noneMatch(e->e.source().equals(n.id)||e.target().equals(n.id))).toList();unused.forEach(model::removeNode);repaint();}
    private void toggleSelected(Consumer<WorkflowModel.Node> action){if(selected!=null){action.accept(selected);repaint();}}
    private void frameAll(){if(model.nodes().isEmpty()){panX=panY=0;repaint();return;}int minX=model.nodes().stream().mapToInt(n->n.x).min().orElse(0),minY=model.nodes().stream().mapToInt(n->n.y).min().orElse(0);panX=60-minX;panY=70-minY;repaint();}

    @Override protected void paintComponent(Graphics raw){super.paintComponent(raw);Graphics2D g=(Graphics2D)raw.create();g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,RenderingHints.VALUE_ANTIALIAS_ON);drawGrid(g);g.translate(panX,panY);drawEdges(g);if(connecting!=null&&wirePoint!=null)drawCurve(g,portCenter(outputPort(connecting,connectingPort)),wirePoint,new Color(86,156,214),2.5f);for(WorkflowModel.Node node:model.nodes())drawNode(g,node);drawCut(g);g.dispose();}
    private void drawGrid(Graphics2D g){int sx=Math.floorMod(panX,20),sy=Math.floorMod(panY,20);for(int x=sx;x<getWidth();x+=20){g.setColor(Math.floorMod(x-panX,100)==0?new Color(52,52,54):new Color(39,39,41));g.drawLine(x,0,x,getHeight());}for(int y=sy;y<getHeight();y+=20){g.setColor(Math.floorMod(y-panY,100)==0?new Color(52,52,54):new Color(39,39,41));g.drawLine(0,y,getWidth(),y);}}
    private void drawEdges(Graphics2D g){for(WorkflowModel.Edge edge:model.edges()){WorkflowModel.Node a=model.byId(edge.source()),b=model.byId(edge.target());if(a==null||b==null)continue;WorkflowModel.Port ap=model.output(a,edge.sourcePort()),bp=model.input(b,edge.targetPort());if(ap==null||bp==null)continue;drawCurve(g,portCenter(outputPort(a,ap)),portCenter(inputPort(b,bp)),a.muted||b.muted?new Color(180,70,70):new Color(86,156,214),2f);}}
    private void drawCurve(Graphics2D g,Point p,Point q,Color color,float width){g.setStroke(new BasicStroke(width));g.setColor(color);int handle=Math.max(55,Math.abs(q.x-p.x)/2);g.draw(new CubicCurve2D.Float(p.x,p.y,p.x+handle,p.y,q.x-handle,q.y,q.x,q.y));}
    private void drawNode(Graphics2D g,WorkflowModel.Node n){int height=nodeHeight(n);Color border=switch(n.status){case FAILED->new Color(244,71,71);case SUCCEEDED->new Color(78,201,176);case QUEUED,PROCESSING->new Color(220,170,70);default->new Color(82,82,88);};RoundRectangle2D box=new RoundRectangle2D.Float(n.x,n.y,WIDTH,height,7,7);g.setColor(UiTheme.PANEL);g.fill(box);g.setColor(n==selected?UiTheme.SELECTION:new Color(45,45,48));g.fill(new RoundRectangle2D.Float(n.x+1,n.y+1,WIDTH-2,HEADER,6,6));g.setStroke(new BasicStroke(n==selected?2.5f:1.5f));g.setColor(n==selected?UiTheme.ACCENT:border);g.draw(box);g.setColor(n.muted?new Color(190,110,110):UiTheme.TEXT);g.setFont(getFont().deriveFont(Font.BOLD,14f));g.drawString(trim(n.name,22),n.x+13,n.y+22);if(n.collapsed)return;
        g.setFont(getFont().deriveFont(12f));for(int i=0;i<n.inputs.size();i++){WorkflowModel.Port p=n.inputs.get(i);g.setColor(UiTheme.MUTED);g.drawString(trim(p.name+" : "+p.dataType,17),n.x+13,portY(n,i)+4);g.setColor(portColor(p));g.fill(inputPort(n,p));}for(int i=0;i<n.outputs.size();i++){WorkflowModel.Port p=n.outputs.get(i);String text=trim(p.name+" : "+p.dataType,17);g.setColor(UiTheme.MUTED);g.drawString(text,n.x+WIDTH-13-g.getFontMetrics().stringWidth(text),portY(n,i)+4);g.setColor(portColor(p));g.fill(outputPort(n,p));}g.setColor(UiTheme.MUTED);g.drawString(n.status.name().toLowerCase(),n.x+13,n.y+height-10);}
    private Color portColor(WorkflowModel.Port p){return switch(p.dataType.toLowerCase()){case "int","integer"->new Color(120,190,150);case "float","double","number"->new Color(110,170,220);case "boolean","bool"->new Color(210,100,110);case "string"->new Color(190,135,210);default->new Color(150,155,165);};}
    private void drawCut(Graphics2D g){if(cutPath.size()<2)return;g.setColor(new Color(244,71,71));g.setStroke(new BasicStroke(2.5f));for(int i=1;i<cutPath.size();i++)g.drawLine(cutPath.get(i-1).x,cutPath.get(i-1).y,cutPath.get(i).x,cutPath.get(i).y);}
    private void cutEdges(){if(cutPath.size()<2)return;List<WorkflowModel.Edge> removed=new ArrayList<>();for(WorkflowModel.Edge edge:model.edges())if(edgeIntersectsCut(edge))removed.add(edge);model.removeEdges(removed);}
    private boolean edgeIntersectsCut(WorkflowModel.Edge edge){WorkflowModel.Node a=model.byId(edge.source()),b=model.byId(edge.target());if(a==null||b==null)return false;WorkflowModel.Port ap=model.output(a,edge.sourcePort()),bp=model.input(b,edge.targetPort());if(ap==null||bp==null)return false;Point p=portCenter(outputPort(a,ap)),q=portCenter(inputPort(b,bp));int handle=Math.max(55,Math.abs(q.x-p.x)/2);Point previous=p;for(int step=1;step<=24;step++){double t=step/24d,u=1-t;Point next=new Point((int)(u*u*u*p.x+3*u*u*t*(p.x+handle)+3*u*t*t*(q.x-handle)+t*t*t*q.x),(int)(u*u*u*p.y+3*u*u*t*p.y+3*u*t*t*q.y+t*t*t*q.y));for(int i=1;i<cutPath.size();i++)if(Line2D.linesIntersect(previous.x,previous.y,next.x,next.y,cutPath.get(i-1).x,cutPath.get(i-1).y,cutPath.get(i).x,cutPath.get(i).y))return true;previous=next;}return false;}

    private int nodeHeight(WorkflowModel.Node n){return n.collapsed?HEADER+2:Math.max(92,HEADER+Math.max(n.inputs.size(),n.outputs.size())*PORT_STEP+28);}
    private int portY(WorkflowModel.Node n,int index){return n.y+HEADER+14+index*PORT_STEP;}
    private Ellipse2D inputPort(WorkflowModel.Node n,WorkflowModel.Port p){int i=Math.max(0,n.inputs.indexOf(p));int y=n.collapsed?n.y+HEADER/2:portY(n,i);return new Ellipse2D.Float(n.x-PORT,y-PORT,PORT*2,PORT*2);}
    private Ellipse2D outputPort(WorkflowModel.Node n,WorkflowModel.Port p){int i=Math.max(0,n.outputs.indexOf(p));int y=n.collapsed?n.y+HEADER/2:portY(n,i);return new Ellipse2D.Float(n.x+WIDTH-PORT,y-PORT,PORT*2,PORT*2);}
    private PortHit hitPort(Point p){for(int i=model.nodes().size()-1;i>=0;i--){WorkflowModel.Node n=model.nodes().get(i);for(WorkflowModel.Port port:n.outputs)if(outputPort(n,port).contains(p))return new PortHit(n,port,true);for(WorkflowModel.Port port:n.inputs)if(inputPort(n,port).contains(p))return new PortHit(n,port,false);}return null;}
    private WorkflowModel.Node hitNode(Point p){for(int i=model.nodes().size()-1;i>=0;i--){WorkflowModel.Node n=model.nodes().get(i);if(new Rectangle(n.x,n.y,WIDTH,nodeHeight(n)).contains(p))return n;}return null;}
    private Point world(Point screen){return new Point(screen.x-panX,screen.y-panY);}
    private static Point portCenter(Ellipse2D p){return new Point((int)p.getCenterX(),(int)p.getCenterY());}
    private static String trim(String text,int max){return text.length()<=max?text:text.substring(0,max-1)+"…";}
    private record PortHit(WorkflowModel.Node node,WorkflowModel.Port port,boolean output){}
}
