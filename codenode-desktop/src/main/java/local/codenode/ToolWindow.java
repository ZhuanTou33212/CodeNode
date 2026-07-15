package local.codenode;

import javax.swing.*;
import java.awt.*;
import java.awt.event.*;
import java.util.function.Consumer;

final class ToolWindow extends JPanel {
    enum DockPosition { LEFT, RIGHT, TOP, BOTTOM }
    record DockRequest(DockPosition position,ToolWindow mergeWith) {}

    private final Window owner;
    private final String title;
    private final JComponent content;
    private final JButton collapse=new JButton("—"), arrange=new JButton("↔"), floating=new JButton("◇");
    private final Consumer<Boolean> collapseListener;
    private final Consumer<DockRequest> dockListener;
    private final Runnable arrangeListener;
    private boolean collapsed;
    private JDialog dialog;
    private JWindow dockPreview;
    private Timer dockTimer;
    private DockRequest pendingDock;
    private Point floatOrigin;
    private boolean dockArmed;

    ToolWindow(Window owner,String title,JComponent content,Consumer<Boolean> collapseListener,Consumer<DockRequest> dockListener,Runnable arrangeListener){
        super(new BorderLayout());this.owner=owner;this.title=title;this.content=content;this.collapseListener=collapseListener;this.dockListener=dockListener;this.arrangeListener=arrangeListener;setBorder(UiTheme.panelBorder());
        JPanel header=new JPanel(new BorderLayout());header.setBackground(UiTheme.TOOLBAR);header.setBorder(UiTheme.sectionBorder());JLabel label=new JLabel(title);label.setFont(label.getFont().deriveFont(Font.BOLD,13f));header.add(label,BorderLayout.WEST);
        JPanel actions=new JPanel(new FlowLayout(FlowLayout.RIGHT,2,0));actions.setOpaque(false);for(JButton button:new JButton[]{collapse,arrange,floating}){button.setFocusPainted(false);button.setMargin(new Insets(1,6,1,6));actions.add(button);}header.add(actions,BorderLayout.EAST);add(header,BorderLayout.NORTH);add(content,BorderLayout.CENTER);
        arrange.setToolTipText("切换水平 / 竖直编排");collapse.addActionListener(e->setCollapsed(!collapsed));arrange.addActionListener(e->arrangeListener.run());floating.addActionListener(e->floatWindow());
        MouseAdapter drag=new MouseAdapter(){Point start;@Override public void mousePressed(MouseEvent e){start=e.getPoint();}@Override public void mouseDragged(MouseEvent e){if(start!=null&&start.distance(e.getPoint())>12){start=null;floatWindow();}}};header.addMouseListener(drag);header.addMouseMotionListener(drag);
    }
    void setCollapsed(boolean value){if(dialog!=null)return;collapsed=value;content.setVisible(!value);collapse.setText(value?"□":"—");revalidate();collapseListener.accept(value);}
    void floatWindow(){
        if(dialog!=null)return;
        remove(content);collapsed=true;collapseListener.accept(true);
        dialog=new JDialog(owner);dialog.setTitle(title);dialog.setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);dialog.add(content);dialog.setSize(430,560);dialog.setLocationRelativeTo(owner);
        dialog.addWindowListener(new WindowAdapter(){@Override public void windowClosing(WindowEvent e){redock();}});
        dialog.setVisible(true);
        floatOrigin=dialog.getLocation();dockArmed=false;
        dockTimer=new Timer(320,e->{if(pendingDock!=null)dockAt(pendingDock);});dockTimer.setRepeats(false);
        dialog.addComponentListener(new ComponentAdapter(){@Override public void componentMoved(ComponentEvent e){updateDockTarget();}});
    }
    private void updateDockTarget(){
        if(dialog==null||!owner.isShowing())return;
        if(!dockArmed){
            if(floatOrigin==null||floatOrigin.distance(dialog.getLocation())<24){pendingDock=null;hideDockPreview();return;}
            dockArmed=true;
        }
        Point pointer=MouseInfo.getPointerInfo()==null?null:MouseInfo.getPointerInfo().getLocation();
        DockRequest target=pointer==null?null:dockRequestAt(pointer);
        pendingDock=target;
        showDockPreview(target);
        dockTimer.restart();
    }
    private DockRequest dockRequestAt(Point pointer){
        ToolWindow mergeTarget=toolAt(pointer);if(mergeTarget!=null)return new DockRequest(null,mergeTarget);
        Rectangle bounds=owner.getBounds();
        if(!bounds.contains(pointer))return null;
        double x=(pointer.x-bounds.x)/(double)Math.max(1,bounds.width),y=(pointer.y-bounds.y)/(double)Math.max(1,bounds.height);
        double nearest=Math.min(Math.min(x,1-x),Math.min(y,1-y));
        if(nearest>.24)return null;
        if(nearest==x)return new DockRequest(DockPosition.LEFT,null);
        if(nearest==1-x)return new DockRequest(DockPosition.RIGHT,null);
        if(nearest==y)return new DockRequest(DockPosition.TOP,null);
        return new DockRequest(DockPosition.BOTTOM,null);
    }
    private ToolWindow toolAt(Point pointer){
        if(!(owner instanceof RootPaneContainer root))return null;Point local=new Point(pointer);SwingUtilities.convertPointFromScreen(local,root.getContentPane());Component component=SwingUtilities.getDeepestComponentAt(root.getContentPane(),local.x,local.y);
        while(component!=null){if(component instanceof ToolWindow tool&&tool!=this&&tool.isShowing()){Rectangle bounds=new Rectangle(tool.getLocationOnScreen(),tool.getSize());int inset=Math.min(38,Math.min(bounds.width,bounds.height)/5);if(new Rectangle(bounds.x+inset,bounds.y+inset,Math.max(1,bounds.width-inset*2),Math.max(1,bounds.height-inset*2)).contains(pointer))return tool;}component=component.getParent();}return null;
    }
    private void showDockPreview(DockRequest request){
        if(request==null){hideDockPreview();return;}
        if(dockPreview==null){
            dockPreview=new JWindow(owner);dockPreview.setFocusableWindowState(false);
            JPanel fill=new JPanel();fill.setBackground(UiTheme.ACCENT);fill.setBorder(BorderFactory.createLineBorder(Color.WHITE,2));dockPreview.add(fill);
            try{dockPreview.setOpacity(.34f);}catch(UnsupportedOperationException ignored){}
        }
        Rectangle preview;
        if(request.mergeWith()!=null)preview=new Rectangle(request.mergeWith().getLocationOnScreen(),request.mergeWith().getSize());
        else{Rectangle b=owner.getBounds();int w=Math.max(260,b.width/4),h=Math.max(180,b.height/4);preview=switch(request.position()){case LEFT->new Rectangle(b.x,b.y,w,b.height);case RIGHT->new Rectangle(b.x+b.width-w,b.y,w,b.height);case TOP->new Rectangle(b.x,b.y,b.width,h);case BOTTOM->new Rectangle(b.x,b.y+b.height-h,b.width,h);};}
        dockPreview.setBounds(preview);dockPreview.setVisible(true);
    }
    private void hideDockPreview(){if(dockPreview!=null)dockPreview.setVisible(false);}
    private void dockAt(DockRequest request){
        if(dialog==null)return;
        hideDockPreview();dockTimer.stop();dialog.remove(content);dialog.dispose();dialog=null;
        add(content,BorderLayout.CENTER);content.setVisible(true);collapsed=false;collapse.setText("—");dockListener.accept(request);revalidate();repaint();
    }
    void redock(){
        if(dialog==null){setCollapsed(false);return;}
        pendingDock=null;hideDockPreview();if(dockTimer!=null)dockTimer.stop();dialog.remove(content);dialog.dispose();dialog=null;
        add(content,BorderLayout.CENTER);content.setVisible(true);collapsed=false;collapse.setText("—");collapseListener.accept(false);revalidate();repaint();
    }
    boolean isCollapsed(){return collapsed;}
    String title(){return title;}
    void setArrangementHorizontal(boolean horizontal){arrange.setText(horizontal?"↔":"↕");}
}
