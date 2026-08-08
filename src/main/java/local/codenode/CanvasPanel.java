/*
 * Decompiled with CFR 0.152.
 */
package local.codenode;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.KeyboardFocusManager;
import java.awt.Point;
import java.awt.Polygon;
import java.awt.Rectangle;
import java.awt.RenderingHints;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.Transferable;
import java.awt.event.ActionEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.MouseWheelEvent;
import java.awt.geom.CubicCurve2D;
import java.awt.geom.Ellipse2D;
import java.awt.geom.Line2D;
import java.awt.geom.Point2D;
import java.awt.geom.RoundRectangle2D;
import java.io.File;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import javax.swing.AbstractAction;
import javax.swing.JMenu;
import javax.swing.JMenuItem;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.TransferHandler;
import javax.swing.JPopupMenu;
import javax.swing.KeyStroke;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import javax.swing.text.JTextComponent;
import local.codenode.NodeRegistry;
import local.codenode.UiTheme;
import local.codenode.WorkflowModel;
import local.codenode.util.BundleDataUtil;

public final class CanvasPanel
extends JPanel {
    private static final int WIDTH = 215;
    private static final int HEADER = 34;
    private static final int PORT_STEP = 22;
    private static final int PORT = 6;
    private static final int RESIZE_HANDLE = 10;
    private static final float DETAIL_FONT_SIZE = 12.0f;
    private static final int DETAIL_PAD_X = 12;
    private static final int DETAIL_LINE_HEIGHT = 17;
    private static final int DETAIL_MIN_WIDTH = 215;
    private static final int DETAIL_MAX_WIDTH = 420;
    private static final int DETAIL_MIN_HEIGHT = 130;
    private static final int DETAIL_MAX_HEIGHT = 320;
    private final WorkflowModel model;
    private final LinkedHashSet<WorkflowModel.Node> selectedNodes = new LinkedHashSet();
    private WorkflowModel.Node primary;
    private WorkflowModel.Node connecting;
    private WorkflowModel.Node inputConnecting;
    private WorkflowModel.Port connectingPort;
    private WorkflowModel.Port inputConnectingPort;
    private WorkflowModel.Edge selectedEdge;
    private WorkflowModel.Edge rerouteEdge;
    private WorkflowModel.Reroute selectedReroute;
    private WorkflowModel.Reroute draggingReroute;
    private WorkflowModel.Reroute connectingReroute;
    private WorkflowModel.Reroute grabReroute;
    private Point dragStart;
    private Point grabStart;
    private Point panStart;
    private Point panOrigin;
    private Point wirePoint;
    private Point lastMouse = new Point(300, 220);
    private java.util.function.BiConsumer<Path, Point> fileDroppedListener = (path, point) -> {};
    private Point boxStart;
    private Point boxCurrent;
    private Point rerouteOrigin;
    private Point resizeStart;
    private WorkflowModel.Node resizingNode;
    private final Map<WorkflowModel.Node, Point> dragOrigins = new LinkedHashMap<WorkflowModel.Node, Point>();
    private final List<Point> cutPath = new ArrayList<Point>();
    private final List<Point> reroutePath = new ArrayList<Point>();
    private SelectionMode boxMode = SelectionMode.REPLACE;
    private int panX;
    private int panY;
    private double zoom = 1.0;
    private boolean editable = true;
    private boolean dragChanged;
    private boolean keyboardGrab;
    private String groupFocusId = "";
    private WorkflowModel.Node hoveringScope;
    private final Map<String, int[]> containerTargets = new LinkedHashMap<String, int[]>();
    private final Timer animTimer;
    private Consumer<WorkflowModel.Node> selectionListener = node -> {};
    private Consumer<String> feedbackListener = message -> {};
    private Runnable changeListener = () -> {};
    private Supplier<String> languageSupplier = () -> "java";
    private WorkflowModel clipboard;
    private Point clipboardAnchor;
    private final Map<String, BundleDataUtil.BundleView> bundleViewCache = new HashMap<String, BundleDataUtil.BundleView>();

    private boolean isResizeCorner(WorkflowModel.Node n, Point world) {
        int rw = this.nodeWidth(n);
        int rh = this.nodeHeight(n);
        return world.x >= n.x + rw - 10 && world.x <= n.x + rw + 2 && world.y >= n.y + rh - 10 && world.y <= n.y + rh + 2;
    }

    public CanvasPanel(final WorkflowModel model) {
        this.model = model;
        this.setBackground(UiTheme.BACKGROUND);
        this.setPreferredSize(new Dimension(1600, 1000));
        this.setFocusable(true);
        this.animTimer = new Timer(16, e -> this.animateContainers());
        this.animTimer.start();
        MouseAdapter mouse = new MouseAdapter(){

            @Override
            public void mousePressed(MouseEvent e) {
                CanvasPanel.this.requestFocusInWindow();
                CanvasPanel.this.lastMouse = e.getPoint();
                Point world = CanvasPanel.this.world(e.getPoint());
                if (CanvasPanel.this.keyboardGrab) {
                    if (SwingUtilities.isLeftMouseButton(e)) {
                        CanvasPanel.this.finishGrab(true);
                    } else if (SwingUtilities.isRightMouseButton(e)) {
                        CanvasPanel.this.finishGrab(false);
                    }
                    return;
                }
                if (SwingUtilities.isMiddleMouseButton(e)) {
                    CanvasPanel.this.panStart = e.getPoint();
                    CanvasPanel.this.panOrigin = new Point(CanvasPanel.this.panX, CanvasPanel.this.panY);
                    return;
                }
                if (SwingUtilities.isRightMouseButton(e)) {
                    EdgeHit hit;
                    if (!CanvasPanel.this.editable) {
                        return;
                    }
                    if (e.isControlDown() && e.isShiftDown()) {
                        CanvasPanel.this.reroutePath.clear();
                        CanvasPanel.this.reroutePath.add(world);
                    } else if (e.isControlDown()) {
                        CanvasPanel.this.cutPath.clear();
                        CanvasPanel.this.cutPath.add(world);
                    } else if (e.isAltDown() && (hit = CanvasPanel.this.hitEdge(world)) != null) {
                        CanvasPanel.this.clearNodeSelection();
                        CanvasPanel.this.selectReroute(hit.edge, CanvasPanel.this.insertReroute(hit, world));
                        CanvasPanel.this.changeListener.run();
                    }
                    return;
                }
                if (!SwingUtilities.isLeftMouseButton(e)) {
                    return;
                }
                RerouteHit reroute = CanvasPanel.this.hitReroute(world);
                if (reroute != null) {
                    CanvasPanel.this.clearNodeSelection();
                    CanvasPanel.this.selectedEdge = reroute.edge;
                    CanvasPanel.this.selectReroute(reroute.edge, reroute.point);
                    if (CanvasPanel.this.editable && e.isAltDown()) {
                        CanvasPanel.this.draggingReroute = reroute.point;
                        CanvasPanel.this.rerouteOrigin = new Point(reroute.point.x, reroute.point.y);
                    } else if (CanvasPanel.this.editable) {
                        CanvasPanel.this.connectingReroute = reroute.point;
                        CanvasPanel.this.wirePoint = world;
                    }
                    return;
                }
                PortHit port = CanvasPanel.this.hitPort(world);
                if (CanvasPanel.this.editable && port != null) {
                    if (port.output) {
                        CanvasPanel.this.connecting = port.node;
                        CanvasPanel.this.connectingPort = port.port;
                    } else {
                        CanvasPanel.this.inputConnecting = port.node;
                        CanvasPanel.this.inputConnectingPort = port.port;
                    }
                    CanvasPanel.this.wirePoint = world;
                    CanvasPanel.this.repaint();
                    return;
                }
                WorkflowModel.Node hit = CanvasPanel.this.hitNode(world);
                if (hit != null) {
                    if (CanvasPanel.this.editable && CanvasPanel.this.isResizeCorner(hit, world)) {
                        CanvasPanel.this.resizingNode = hit;
                        CanvasPanel.this.resizeStart = new Point(CanvasPanel.isContainer(hit) ? hit.containerWidth : hit.nodeWidth, CanvasPanel.isContainer(hit) ? hit.containerHeight : hit.nodeHeight);
                        return;
                    }
                    if (hit.nodeKind == WorkflowModel.NodeKind.GROUP && e.getClickCount() == 2) {
                        CanvasPanel.this.enterGroupFocus(hit.id);
                        CanvasPanel.this.repaint();
                        return;
                    }
                    if (hit.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE && e.getClickCount() == 2 && CanvasPanel.this.editable) {
                        hit.bundleCollapsed = !hit.bundleCollapsed;
                        CanvasPanel.this.replaceSelection(hit);
                        CanvasPanel.this.changeListener.run();
                        CanvasPanel.this.repaint();
                        return;
                    }
                    CanvasPanel.this.applyNodeClick(hit, e);
                    if (CanvasPanel.this.editable && CanvasPanel.this.selectedNodes.contains(hit)) {
                        CanvasPanel.this.dragStart = world;
                        CanvasPanel.this.dragOrigins.clear();
                        CanvasPanel.this.selectedNodes.forEach(node -> CanvasPanel.this.dragOrigins.put((WorkflowModel.Node)node, new Point(node.x, node.y)));
                        CanvasPanel.this.includeContainerChildren();
                        CanvasPanel.this.dragChanged = false;
                    }
                    return;
                }
                EdgeHit edge = CanvasPanel.this.hitEdge(world);
                if (edge != null) {
                    if (!e.isShiftDown() && !e.isAltDown()) {
                        CanvasPanel.this.clearNodeSelection();
                    }
                    CanvasPanel.this.selectedEdge = edge.edge;
                    CanvasPanel.this.selectedReroute = null;
                    CanvasPanel.this.selectionListener.accept(CanvasPanel.this.primary);
                    CanvasPanel.this.repaint();
                    return;
                }
                CanvasPanel.this.selectedEdge = null;
                CanvasPanel.this.selectedReroute = null;
                CanvasPanel.this.boxStart = world;
                CanvasPanel.this.boxCurrent = world;
                SelectionMode selectionMode = e.isAltDown() ? SelectionMode.SUBTRACT : (CanvasPanel.this.boxMode = e.isShiftDown() ? SelectionMode.ADD : SelectionMode.REPLACE);
                if (CanvasPanel.this.boxMode == SelectionMode.REPLACE) {
                    CanvasPanel.this.clearNodeSelection();
                }
                CanvasPanel.this.repaint();
            }

            @Override
            public void mouseDragged(MouseEvent e) {
                CanvasPanel.this.lastMouse = e.getPoint();
                Point world = CanvasPanel.this.world(e.getPoint());
                if (CanvasPanel.this.panStart != null) {
                    CanvasPanel.this.panX = CanvasPanel.this.panOrigin.x + e.getX() - CanvasPanel.this.panStart.x;
                    CanvasPanel.this.panY = CanvasPanel.this.panOrigin.y + e.getY() - CanvasPanel.this.panStart.y;
                    CanvasPanel.this.repaint();
                    return;
                }
                if (CanvasPanel.this.resizingNode != null) {
                    int nw = CanvasPanel.this.resizeStart.x + world.x - (CanvasPanel.this.resizingNode.x + CanvasPanel.this.nodeWidth(CanvasPanel.this.resizingNode));
                    int nh = CanvasPanel.this.resizeStart.y + world.y - (CanvasPanel.this.resizingNode.y + CanvasPanel.this.nodeHeight(CanvasPanel.this.resizingNode));
                    if (nw > 80) {
                        if (CanvasPanel.isContainer(CanvasPanel.this.resizingNode)) {
                            CanvasPanel.this.resizingNode.containerWidth = nw;
                        } else {
                            CanvasPanel.this.resizingNode.nodeWidth = nw;
                        }
                    }
                    if (nh > 60) {
                        if (CanvasPanel.isContainer(CanvasPanel.this.resizingNode)) {
                            CanvasPanel.this.resizingNode.containerHeight = nh;
                        } else {
                            CanvasPanel.this.resizingNode.nodeHeight = nh;
                        }
                    }
                    CanvasPanel.this.dragChanged = true;
                    CanvasPanel.this.repaint();
                    return;
                }
                if (!CanvasPanel.this.cutPath.isEmpty()) {
                    CanvasPanel.this.cutPath.add(world);
                    CanvasPanel.this.repaint();
                    return;
                }
                if (!CanvasPanel.this.reroutePath.isEmpty()) {
                    CanvasPanel.this.reroutePath.add(world);
                    CanvasPanel.this.repaint();
                    return;
                }
                if (CanvasPanel.this.connecting != null || CanvasPanel.this.inputConnecting != null || CanvasPanel.this.connectingReroute != null) {
                    CanvasPanel.this.wirePoint = world;
                    CanvasPanel.this.repaint();
                    return;
                }
                if (CanvasPanel.this.draggingReroute != null) {
                    CanvasPanel.this.draggingReroute.x = world.x;
                    CanvasPanel.this.draggingReroute.y = world.y;
                    CanvasPanel.this.dragChanged = true;
                    CanvasPanel.this.repaint();
                    return;
                }
                if (CanvasPanel.this.dragStart != null && !CanvasPanel.this.dragOrigins.isEmpty()) {
                    int dx = world.x - CanvasPanel.this.dragStart.x;
                    int dy = world.y - CanvasPanel.this.dragStart.y;
                    CanvasPanel.this.dragOrigins.forEach((node, origin) -> {
                        node.x = origin.x + dx;
                        node.y = origin.y + dy;
                    });
                    CanvasPanel.this.dragChanged = dx != 0 || dy != 0;
                    CanvasPanel.this.hoveringScope = null;
                    if (!CanvasPanel.this.dragOrigins.keySet().stream().allMatch(CanvasPanel::isContainer)) {
                        for (WorkflowModel.Node s : model.nodes()) {
                            if (s.nodeKind != WorkflowModel.NodeKind.SCOPE || !CanvasPanel.this.containerBody(s).contains(world)) continue;
                            CanvasPanel.this.hoveringScope = s;
                            break;
                        }
                    }
                    CanvasPanel.this.repaint();
                    return;
                }
                if (CanvasPanel.this.boxStart != null) {
                    CanvasPanel.this.boxCurrent = world;
                    CanvasPanel.this.repaint();
                }
            }

            @Override
            public void mouseReleased(MouseEvent e) {
                Point world = CanvasPanel.this.world(e.getPoint());
                if (CanvasPanel.this.panStart != null) {
                    CanvasPanel.this.panStart = null;
                    // 平移画布是纯视图操作，不记录撤销历史
                    return;
                }
                if (CanvasPanel.this.resizingNode != null) {
                    if (CanvasPanel.this.dragChanged) {
                        CanvasPanel.this.containerTargets.put(CanvasPanel.this.resizingNode.id, new int[]{CanvasPanel.this.resizingNode.containerWidth, CanvasPanel.this.resizingNode.containerHeight});
                        CanvasPanel.this.changeListener.run();
                    }
                    CanvasPanel.this.resizingNode = null;
                    CanvasPanel.this.resizeStart = null;
                    CanvasPanel.this.dragChanged = false;
                    CanvasPanel.this.repaint();
                    return;
                }
                if (!CanvasPanel.this.cutPath.isEmpty()) {
                    CanvasPanel.this.cutEdges();
                    CanvasPanel.this.cutPath.clear();
                    CanvasPanel.this.repaint();
                    return;
                }
                if (!CanvasPanel.this.reroutePath.isEmpty()) {
                    CanvasPanel.this.insertReroutesFromStroke();
                    CanvasPanel.this.reroutePath.clear();
                    CanvasPanel.this.repaint();
                    return;
                }
                if (CanvasPanel.this.connecting != null) {
                    PortHit target = CanvasPanel.this.hitPort(world);
                    boolean changed = false;
                    if (target != null) {
                        if (target.output) {
                            CanvasPanel.this.feedback("连接失败：输出端口只能连接输入端口");
                        } else {
                            changed = CanvasPanel.this.connectNodes(CanvasPanel.this.connecting, CanvasPanel.this.connectingPort, target.node, target.port);
                        }
                    }
                    if (changed) {
                        CanvasPanel.this.replaceSelection(target.node);
                        CanvasPanel.this.changeListener.run();
                    }
                    CanvasPanel.this.connecting = null;
                    CanvasPanel.this.connectingPort = null;
                    CanvasPanel.this.wirePoint = null;
                    CanvasPanel.this.repaint();
                    return;
                }
                if (CanvasPanel.this.inputConnecting != null) {
                    PortHit target = CanvasPanel.this.hitPort(world);
                    RerouteHit rerouteTarget = CanvasPanel.this.hitReroute(world);
                    boolean changed = false;
                    if (target != null) {
                        if (!target.output) {
                            CanvasPanel.this.feedback("连接失败：输入端口只能连接输出端口");
                        } else {
                            changed = CanvasPanel.this.connectNodes(target.node, target.port, CanvasPanel.this.inputConnecting, CanvasPanel.this.inputConnectingPort);
                        }
                    } else if (rerouteTarget != null) {
                        changed = CanvasPanel.this.connectFromReroute(rerouteTarget.point, CanvasPanel.this.inputConnecting, CanvasPanel.this.inputConnectingPort);
                    }
                    if (changed) {
                        CanvasPanel.this.replaceSelection(CanvasPanel.this.inputConnecting);
                        CanvasPanel.this.changeListener.run();
                    }
                    CanvasPanel.this.inputConnecting = null;
                    CanvasPanel.this.inputConnectingPort = null;
                    CanvasPanel.this.wirePoint = null;
                    CanvasPanel.this.repaint();
                    return;
                }
                if (CanvasPanel.this.connectingReroute != null) {
                    PortHit portTarget = CanvasPanel.this.hitPort(world);
                    boolean changed = false;
                    if (portTarget != null) {
                        if (portTarget.output) {
                            CanvasPanel.this.feedback("连接失败：整理点只能连接输入端口");
                        } else {
                            changed = CanvasPanel.this.connectFromReroute(CanvasPanel.this.connectingReroute, portTarget.node, portTarget.port);
                        }
                    }
                    if (changed) {
                        CanvasPanel.this.replaceSelection(portTarget.node);
                        CanvasPanel.this.changeListener.run();
                    }
                    CanvasPanel.this.connectingReroute = null;
                    CanvasPanel.this.wirePoint = null;
                    CanvasPanel.this.repaint();
                    return;
                }
                if (CanvasPanel.this.draggingReroute != null) {
                    if (CanvasPanel.this.dragChanged) {
                        CanvasPanel.this.changeListener.run();
                    }
                    CanvasPanel.this.draggingReroute = null;
                    CanvasPanel.this.rerouteOrigin = null;
                    CanvasPanel.this.dragChanged = false;
                    return;
                }
                if (CanvasPanel.this.dragStart != null) {
                    if (CanvasPanel.this.dragChanged) {
                        CanvasPanel.this.assignMovedNodesToContainers();
                        CanvasPanel.this.changeListener.run();
                    }
                    CanvasPanel.this.dragStart = null;
                    CanvasPanel.this.dragOrigins.clear();
                    CanvasPanel.this.dragChanged = false;
                    CanvasPanel.this.hoveringScope = null;
                    CanvasPanel.this.repaint();
                    return;
                }
                if (CanvasPanel.this.boxStart != null) {
                    CanvasPanel.this.applyBoxSelection();
                    CanvasPanel.this.boxCurrent = null;
                    CanvasPanel.this.boxStart = null;
                    CanvasPanel.this.repaint();
                }
            }

            @Override
            public void mouseMoved(MouseEvent e) {
                CanvasPanel.this.lastMouse = e.getPoint();
                Point world = CanvasPanel.this.world(e.getPoint());
                if (CanvasPanel.this.keyboardGrab) {
                    CanvasPanel.this.updateGrab(world);
                    return;
                }
                if (CanvasPanel.this.connecting != null || CanvasPanel.this.inputConnecting != null || CanvasPanel.this.connectingReroute != null) {
                    CanvasPanel.this.wirePoint = world;
                    CanvasPanel.this.repaint();
                }
            }

            @Override
            public void mouseWheelMoved(MouseWheelEvent e) {
                CanvasPanel.this.zoomAt(e.getPoint(), e.getPreciseWheelRotation());
            }
        };
        this.addMouseListener(mouse);
        this.addMouseMotionListener(mouse);
        this.addMouseWheelListener(mouse);
        this.installKeys();
        this.installFileDrop();
    }

    /** 注册文件拖放回调：拖入文件到画布时调用（世界坐标落点）。 */
    public void onFileDropped(java.util.function.BiConsumer<Path, Point> listener) {
        this.fileDroppedListener = listener == null ? (path, point) -> {} : listener;
    }

    private void installFileDrop() {
        this.setTransferHandler(new TransferHandler() {
            @Override public boolean canImport(TransferSupport support) {
                return support.isDrop() && support.isDataFlavorSupported(DataFlavor.javaFileListFlavor);
            }
            @Override public boolean importData(TransferSupport support) {
                if (!canImport(support)) return false;
                try {
                    Transferable t = support.getTransferable();
                    @SuppressWarnings("unchecked")
                    List<File> files = (List<File>) t.getTransferData(DataFlavor.javaFileListFlavor);
                    if (files == null || files.isEmpty()) return false;
                    Point screen = support.getDropLocation().getDropPoint();
                    Point world = CanvasPanel.this.world(screen);
                    for (File file : files) {
                        if (file == null) continue;
                        CanvasPanel.this.fileDroppedListener.accept(file.toPath().toAbsolutePath().normalize(), new Point(world.x, world.y));
                    }
                    return true;
                } catch (Exception ignored) {
                    return false;
                }
            }
        });
    }

    public void onSelection(Consumer<WorkflowModel.Node> listener) {
        this.selectionListener = listener;
    }

    public void onFeedback(Consumer<String> listener) {
        this.feedbackListener = listener;
    }

    public void onChange(Runnable listener) {
        this.changeListener = listener;
    }

    public void setLanguageSupplier(Supplier<String> supplier) {
        this.languageSupplier = supplier;
    }

    public void setEditable(boolean value) {
        this.editable = value;
        this.cancelOperation();
        this.repaint();
    }

    public boolean isEditable() {
        return this.editable;
    }

    public WorkflowModel.Node selected() {
        return this.primary;
    }

    public Set<WorkflowModel.Node> selectedNodes() {
        return Collections.unmodifiableSet(this.selectedNodes);
    }

    public void select(WorkflowModel.Node node) {
        if (node == null) {
            this.clearNodeSelection();
        } else {
            this.replaceSelection(node);
        }
    }

    public void selectNodes(Collection<WorkflowModel.Node> nodes) {
        this.selectedNodes.clear();
        for (WorkflowModel.Node node : nodes) {
            if (node == null || !this.model.nodes().contains(node)) continue;
            this.selectedNodes.add(node);
        }
        this.primary = this.selectedNodes.isEmpty() ? null : this.selectedNodes.getLast();
        this.selectedEdge = null;
        this.selectedReroute = null;
        this.notifySelection();
    }

    public int panX() {
        return this.panX;
    }

    public int panY() {
        return this.panY;
    }

    public double zoom() {
        return this.zoom;
    }

    public void setView(int x, int y) {
        this.setView(x, y, 1.0);
    }

    public void setView(int x, int y, double value) {
        this.panX = x;
        this.panY = y;
        this.zoom = CanvasPanel.clamp(value, 0.25, 2.5);
        this.repaint();
    }

    private void installKeys() {
        this.bind("shift A", this::showAddMenu);
        this.bind("shift W", this::showQuickMenu);
        this.bind("DELETE", this::deleteSelection);
        this.bind("X", this::deleteSelection);
        this.bind("control A", this::selectAll);
        this.bind("control C", this::copySelection);
        this.bind("control V", this::pasteSelection);
        this.bind("control D", this::duplicateSelection);
        this.bind("shift D", this::duplicateSelection);
        this.bind("H", () -> this.toggleSelected(n -> {
            n.collapsed = !n.collapsed;
        }));
        this.bind("M", () -> this.toggleSelected(n -> {
            n.detailMode = !n.detailMode;
        }));
        this.bind("N", () -> this.toggleSelected(n -> {
            n.muted = !n.muted;
        }));
        this.bind("HOME", this::frameAll);
        this.bind("Z", this::centerOnBounds);
        this.bind("G", this::startGrab);
        this.bind("ENTER", () -> this.finishGrab(true));
        this.bind("control X", this::deleteWithReconnect);
        this.bind("alt X", this::deleteUnused);
        this.bind("ESCAPE", this::cancelOrExitGroup);
        this.bind("control G", this::groupSelectedNodes);
    }

    private void bind(String stroke, final Runnable action) {
        String key = "action-" + stroke;
        this.getInputMap(0).put(KeyStroke.getKeyStroke(stroke), key);
        this.getActionMap().put(key, new AbstractAction(){

            @Override
            public void actionPerformed(ActionEvent e) {
                if (KeyboardFocusManager.getCurrentKeyboardFocusManager().getFocusOwner() instanceof JTextComponent) {
                    return;
                }
                action.run();
            }
        });
    }

    private void applyNodeClick(WorkflowModel.Node node, MouseEvent e) {
        this.selectedEdge = null;
        this.selectedReroute = null;
        if (e.isAltDown()) {
            this.selectedNodes.remove(node);
            this.primary = this.selectedNodes.isEmpty() ? null : this.selectedNodes.getLast();
            this.notifySelection();
            return;
        }
        if (e.isShiftDown()) {
            if (!this.selectedNodes.add(node)) {
                this.selectedNodes.remove(node);
            }
            this.primary = this.selectedNodes.contains(node) ? node : (this.selectedNodes.isEmpty() ? null : this.selectedNodes.getLast());
            this.notifySelection();
            return;
        }
        if (!this.selectedNodes.contains(node)) {
            this.replaceSelection(node);
        } else {
            this.primary = node;
            this.notifySelection();
        }
    }

    private void replaceSelection(WorkflowModel.Node node) {
        this.selectedNodes.clear();
        if (node != null) {
            this.selectedNodes.add(node);
        }
        this.primary = node;
        this.selectedEdge = null;
        this.selectedReroute = null;
        this.notifySelection();
    }

    private void clearNodeSelection() {
        this.selectedNodes.clear();
        this.primary = null;
        this.notifySelection();
    }

    private void notifySelection() {
        this.selectionListener.accept(this.primary);
        this.repaint();
    }

    private void selectAll() {
        this.selectedNodes.clear();
        this.selectedNodes.addAll(this.model.nodes());
        this.primary = this.selectedNodes.isEmpty() ? null : this.selectedNodes.getLast();
        this.selectedEdge = null;
        this.selectedReroute = null;
        this.notifySelection();
    }

    private void applyBoxSelection() {
        Rectangle box = this.box();
        List<WorkflowModel.Node> hits = this.model.nodes().stream().filter(this::visibleNode).filter(node -> box.intersects(node.x, node.y, this.nodeWidth((WorkflowModel.Node)node), this.nodeHeight((WorkflowModel.Node)node))).toList();
        if (this.boxMode == SelectionMode.SUBTRACT) {
            this.selectedNodes.removeAll(hits);
        } else {
            this.selectedNodes.addAll(hits);
        }
        this.primary = this.selectedNodes.isEmpty() ? null : this.selectedNodes.getLast();
        this.notifySelection();
    }

    private void showAddMenu() {
        if (this.editable) {
            this.nodeMenu().show(this, this.lastMouse.x, this.lastMouse.y);
        }
    }

    private JPopupMenu nodeMenu() {
        JPopupMenu menu = new JPopupMenu();
        menu.add(this.menuItem("空白节点", () -> this.addTemplate("空白节点", "基础", "说明这个节点应完成的工作", 1, 1)));
        menu.add(this.menuItem("组输出", this::addGroupOutput));
        JMenu basic = new JMenu("基础与范围");
        basic.add(this.menuItem("文件节点", this::addFileNode));
        basic.add(this.menuItem("范围文件", this::addRangeFileNode));
        basic.add(this.menuItem("If 判断范围", () -> this.addTemplate("If 判断范围", "范围与流程控制", "按布尔条件执行 then 或 else 区域", 1, 1)));
        basic.add(this.menuItem("For Each 循环范围", () -> this.addTemplate("For Each 循环范围", "范围与流程控制", "遍历数组并执行 body 区域", 2, 1)));
        basic.add(this.menuItem("While 循环范围", () -> this.addTemplate("While 循环范围", "范围与流程控制", "条件成立时执行 body 区域", 1, 1)));
        basic.add(this.menuItem("Repeat 循环范围", () -> this.addTemplate("Repeat 循环范围", "范围与流程控制", "按固定次数执行 body 区域", 1, 1)));
        menu.add(basic);
        JMenu assets = new JMenu("资产类文件");
        for (String string : NodeRegistry.allAssetTypes()) {
            String label = NodeRegistry.assetTypeLabel(string);
            assets.add(this.menuItem(label + " 文件", () -> this.addAssetNode(string)));
        }
        JMenu assetBundle = new JMenu("资产资源组");
        for (String type : NodeRegistry.allAssetTypes()) {
            String label = NodeRegistry.assetTypeLabel(type);
            assetBundle.add(this.menuItem((String)label + " 资源组", () -> this.addAssetBundleNode(type)));
        }
        assets.add(assetBundle);
        menu.add(assets);
        JMenu jMenu = new JMenu("节点组");
        jMenu.add(this.menuItem("组输入节点", () -> this.addGroupInputNode()));
        jMenu.add(this.menuItem("捕获节点", () -> this.addCaptureNode()));
        menu.add(jMenu);
        JMenu values = new JMenu("数值与常量");
        for (String string : List.of("整数常量", "浮点常量", "数值变量", "Vector2", "Vector3", "Vector4", "法向", "颜色", "数组")) {
            values.add(this.menuItem(string, () -> this.addTemplate(string, string.matches("Vector.*|法向|颜色|数组") ? "向量与数组" : "数值", "提供或保存 " + string, 0, 1)));
        }
        values.add(this.menuItem("布尔常量", () -> this.addTemplate("布尔常量", "布尔值", "提供布尔条件", 0, 1)));
        values.add(this.menuItem("字符串常量", () -> this.addTemplate("字符串常量", "文本", "提供字符串常量", 0, 1)));
        menu.add(values);
        JMenu conditions = new JMenu("条件");
        for (String string : List.of("比较", "范围判断", "为空判断", "AND", "OR", "NOT", "XOR")) {
            conditions.add(this.menuItem(string, () -> this.addTemplate(string, "布尔值", "计算并输出布尔条件", string.equals("NOT") ? 1 : 2, 1)));
        }
        menu.add(conditions);
        JMenu jMenu2 = new JMenu("计算");
        for (String name : List.of("浮点计算", "整数计算", "向量计算", "颜色计算", "数组计算")) {
            jMenu2.add(this.menuItem(name, () -> this.addTemplate(name, name.matches("向量计算|颜色计算|数组计算") ? "向量与数组" : "数值", "选择运算并计算输入", 2, 1)));
        }
        menu.add(jMenu2);
        JMenu jMenu3 = new JMenu(this.languageSupplier.get() + " 专用");
        switch (this.languageSupplier.get()) {
            case "powershell": {
                jMenu3.add(this.menuItem("管道处理", () -> this.addTemplate("PowerShell 管道", "PowerShell", "通过管道变换输入对象", 1, 1)));
                jMenu3.add(this.menuItem("Cmdlet 调用", () -> this.addTemplate("Cmdlet 调用", "PowerShell", "调用指定 PowerShell Cmdlet", 1, 1)));
                break;
            }
            case "go": {
                jMenu3.add(this.menuItem("Goroutine", () -> this.addTemplate("Goroutine", "Go", "并发执行输入任务并等待结果", 1, 1)));
                jMenu3.add(this.menuItem("Channel", () -> this.addTemplate("Channel", "Go", "通过类型化 Channel 传递数据", 1, 1)));
                break;
            }
            default: {
                jMenu3.add(this.menuItem("Stream 处理", () -> this.addTemplate("Java Stream", "Java", "使用 Stream API 变换集合", 1, 1)));
                jMenu3.add(this.menuItem("异常捕获", () -> this.addTemplate("Try / Catch", "Java", "捕获并处理 Java 异常", 1, 2)));
            }
        }
        menu.add(jMenu3);
        UiTheme.apply(menu);
        return menu;
    }

    private void showQuickMenu() {
        JPopupMenu menu = new JPopupMenu();
        menu.add(this.menuItem("复制节点  Shift+D", this::duplicateSelection));
        menu.add(this.menuItem("折叠节点  H", () -> this.toggleSelected(n -> {
            n.collapsed = !n.collapsed;
        })));
        menu.add(this.menuItem("静音节点  N", () -> this.toggleSelected(n -> {
            n.muted = !n.muted;
        })));
        menu.add(this.menuItem("详细模式  M", () -> this.toggleSelected(n -> {
            n.detailMode = !n.detailMode;
        })));
        menu.add(this.menuItem("定位画面中心  Z", this::centerOnBounds));
        menu.add(this.menuItem("查看全部  Home", this::frameAll));
        menu.add(this.menuItem("删除并重连  Ctrl+X", this::deleteWithReconnect));
        menu.add(this.menuItem("清理未连接节点  Alt+X", this::deleteUnused));
        if (this.primary != null && this.primary.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) {
            menu.addSeparator();
            menu.add(this.menuItem("完整展开资源组", this::expandBundleNode));
        }
        UiTheme.apply(menu);
        menu.show(this, this.lastMouse.x, this.lastMouse.y);
    }

    private JMenuItem menuItem(String text, Runnable action) {
        JMenuItem item = new JMenuItem(text);
        item.addActionListener(e -> action.run());
        return item;
    }

    private void addGroupOutput() {
        if (!this.editable) {
            return;
        }
        Point p = this.world(this.lastMouse);
        WorkflowModel.Node node = this.model.addGroupOutput(p.x, p.y, "组输出 " + (this.model.groupOutputs().size() + 1));
        this.replaceSelection(node);
        this.changeListener.run();
    }

    private void addFileNode() {
        if (!this.editable) {
            return;
        }
        Point p = this.world(this.lastMouse);
        String lang = switch (this.languageSupplier.get()) {
            case "go" -> "go";
            case "powershell" -> "ps1";
            default -> "java";
        };
        WorkflowModel.Node node = this.model.addFileNode(p.x, p.y, "文件节点", "src/Main." + lang);
        this.replaceSelection(node);
        this.changeListener.run();
    }

    private void addRangeFileNode() {
        if (!this.editable) {
            return;
        }
        Point p = this.world(this.lastMouse);
        WorkflowModel.Node node = this.model.addFileNode(p.x, p.y, "范围文件", "");
        node.rangeMode = true;
        node.containerWidth = 520;
        node.containerHeight = 320;
        this.replaceSelection(node);
        this.changeListener.run();
    }

    private void addAssetNode(String assetType) {
        if (!this.editable) {
            return;
        }
        Point p = this.world(this.lastMouse);
        WorkflowModel.Node node = this.model.addAssetNode(p.x, p.y, "资源-" + NodeRegistry.assetTypeLabel(assetType), "assets/example." + assetType, assetType);
        this.replaceSelection(node);
        this.changeListener.run();
    }

    private void addAssetBundleNode(String assetType) {
        if (!this.editable) {
            return;
        }
        Point p = this.world(this.lastMouse);
        WorkflowModel.Node node = this.model.addAssetBundleNode(p.x, p.y, "资源组-" + NodeRegistry.assetTypeLabel(assetType), "{\"files\":[]}", assetType);
        this.replaceSelection(node);
        this.changeListener.run();
    }

    private void addGroupInputNode() {
        if (!this.editable) {
            return;
        }
        Point p = this.world(this.lastMouse);
        WorkflowModel.Node node = this.model.addGroupInputNode(p.x, p.y, "组输入");
        this.replaceSelection(node);
        this.changeListener.run();
    }

    private void addCaptureNode() {
        if (!this.editable) {
            return;
        }
        Point p = this.world(this.lastMouse);
        WorkflowModel.Node node = this.model.addCaptureNode(p.x, p.y, "捕获 " + (this.model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.CAPTURE).count() + 1L));
        this.replaceSelection(node);
        this.changeListener.run();
    }

    private void addTemplate(String name, String category, String prompt, int inputCount, int outputCount) {
        if (!this.editable) {
            return;
        }
        Point p = this.world(this.lastMouse);
        WorkflowModel.Node node = this.model.addNode(p.x, p.y);
        node.name = name;
        node.category = category;
        node.prompt = prompt;
        node.templateLibrary = "builtin";
        node.templateId = name;
        node.templateLanguage = Set.of("Java", "PowerShell", "Go").contains(category) ? this.languageSupplier.get() : "neutral";
        this.configureTemplate(node, name, category);
        node.inputs.clear();
        node.outputs.clear();
        if (node.nodeKind == WorkflowModel.NodeKind.SCOPE) {
            if (name.startsWith("Repeat")) {
                node.inputs.add(new WorkflowModel.Port("count", "次数", "integer", true));
            } else {
                node.inputs.add(new WorkflowModel.Port("condition", "条件", "boolean", !name.startsWith("For Each")));
                if (name.startsWith("For Each")) {
                    node.inputs.add(new WorkflowModel.Port("collection", "集合", "array<any>", true));
                }
            }
            node.outputs.add(new WorkflowModel.Port("out", "完成", "flow", false));
        } else if (!NodeRegistry.operations(node).isEmpty()) {
            NodeRegistry.applyOperation(this.model, node, NodeRegistry.operationForLabel(node, name));
        } else {
            int i;
            for (i = 0; i < inputCount; ++i) {
                node.inputs.add(new WorkflowModel.Port("in" + (i + 1), (String)(inputCount == 1 ? "输入" : "输入 " + (i + 1)), CanvasPanel.portType(node), false));
            }
            for (i = 0; i < outputCount; ++i) {
                node.outputs.add(new WorkflowModel.Port("out" + (i + 1), (String)(outputCount == 1 ? "输出" : "输出 " + (i + 1)), CanvasPanel.portType(node), false));
            }
        }
        this.replaceSelection(node);
        this.changeListener.run();
    }

    private void configureTemplate(WorkflowModel.Node node, String name, String category) {
        if (category.equals("范围与流程控制")) {
            node.nodeKind = WorkflowModel.NodeKind.SCOPE;
            node.classificationKey = "scope.flow";
            this.model.setCodeBearing(node, false);
        } else if (category.equals("布尔值")) {
            node.nodeKind = name.equals("布尔常量") ? WorkflowModel.NodeKind.REGULAR : WorkflowModel.NodeKind.CONDITION;
            node.valueType = "boolean";
            node.classificationKey = node.nodeKind == WorkflowModel.NodeKind.CONDITION ? "calculation.boolean" : "value.boolean";
        } else if (category.equals("向量与数组")) {
            WorkflowModel.NodeKind nodeKind = node.nodeKind = name.endsWith("计算") ? WorkflowModel.NodeKind.CALCULATION : WorkflowModel.NodeKind.REGULAR;
            String string = name.contains("数组") ? "array<any>" : (name.contains("颜色") ? "color" : (name.contains("法向") ? "normal" : (node.valueType = name.startsWith("Vector") ? name.toLowerCase(Locale.ROOT) : "vector3")));
            node.classificationKey = node.nodeKind == WorkflowModel.NodeKind.CALCULATION ? "calculation.vector" : (name.contains("数组") ? "value.array" : "value.vector");
        } else if (category.equals("数值")) {
            node.nodeKind = name.endsWith("计算") ? WorkflowModel.NodeKind.CALCULATION : WorkflowModel.NodeKind.REGULAR;
            node.valueType = name.contains("整数") ? "integer" : "number";
            node.classificationKey = node.nodeKind == WorkflowModel.NodeKind.CALCULATION ? "calculation.scalar" : "value.scalar";
        } else if (category.equals("文本")) {
            node.valueType = "string";
            node.classificationKey = "text.string";
        } else {
            node.classificationKey = "foundation.object";
        }
    }

    private static String portType(WorkflowModel.Node node) {
        return node.valueType.equals("any") ? (node.nodeKind == WorkflowModel.NodeKind.SCOPE ? "boolean" : "any") : node.valueType;
    }

    private void deleteSelection() {
        if (!this.editable) {
            return;
        }
        if (this.selectedReroute != null) {
            this.model.removeReroute(this.selectedReroute);
            this.selectedReroute = null;
            this.rerouteEdge = null;
            this.changeListener.run();
            this.repaint();
            return;
        }
        if (this.selectedEdge != null) {
            this.model.removeEdges(List.of(this.selectedEdge));
            this.selectedEdge = null;
            this.changeListener.run();
            this.repaint();
            return;
        }
        if (this.selectedNodes.isEmpty()) {
            return;
        }
        Set<WorkflowModel.Node> containers = this.selectedNodes.stream().filter(CanvasPanel::isContainer).collect(Collectors.toCollection(LinkedHashSet::new));
        LinkedHashSet<WorkflowModel.Node> deleting = new LinkedHashSet<WorkflowModel.Node>(this.selectedNodes);
        if (!containers.isEmpty()) {
            Object[] options = new Object[]{"仅解除范围", "连同内部节点删除", "取消"};
            int choice = JOptionPane.showOptionDialog(this, "删除范围或文件节点时如何处理内部节点？", "CodeNode", -1, 2, null, options, options[0]);
            if (choice < 0 || choice == 2) {
                return;
            }
            if (choice == 1) {
                for (WorkflowModel.Node container : containers) {
                    deleting.addAll(this.descendants(container));
                }
            } else {
                for (WorkflowModel.Node container : containers) {
                    for (WorkflowModel.Node child : this.descendants(container)) {
                        if ((container.nodeKind == WorkflowModel.NodeKind.FILE || container.nodeKind == WorkflowModel.NodeKind.ASSET) && child.fileNodeId.equals(container.id)) {
                            child.fileNodeId = "";
                        }
                        if (container.nodeKind != WorkflowModel.NodeKind.SCOPE || !child.parentScopeId.equals(container.id)) continue;
                        child.parentScopeId = "";
                    }
                }
            }
        }
        deleting.forEach(this.model::removeNode);
        for (WorkflowModel.Node del : new LinkedHashSet<WorkflowModel.Node>(deleting)) {
            if (del.nodeKind != WorkflowModel.NodeKind.GROUP) continue;
            for (WorkflowModel.Node child : this.model.nodes()) {
                if (!child.parentScopeId.equals(del.id)) continue;
                child.parentScopeId = "";
            }
        }
        this.clearNodeSelection();
        this.changeListener.run();
    }

    private void deleteWithReconnect() {
        if (!this.editable || this.selectedNodes.size() != 1) {
            return;
        }
        WorkflowModel.Node node = this.primary;
        List<WorkflowModel.Edge> incoming = this.model.edges().stream().filter(e -> e.target().equals(node.id)).toList();
        List<WorkflowModel.Edge> outgoing = this.model.edges().stream().filter(e -> e.source().equals(node.id)).toList();
        if (!incoming.isEmpty() && !outgoing.isEmpty()) {
            WorkflowModel.Edge a = incoming.getFirst();
            WorkflowModel.Edge b = outgoing.getFirst();
            WorkflowModel.Node source = this.model.byId(a.source());
            WorkflowModel.Node target = this.model.byId(b.target());
            WorkflowModel.Port sp = this.model.output(source, a.sourcePort());
            WorkflowModel.Port tp = this.model.input(target, b.targetPort());
            if (source != null && target != null && sp != null && tp != null) {
                this.model.connect(source, sp, target, tp);
            }
        }
        this.model.removeNode(node);
        this.clearNodeSelection();
        this.changeListener.run();
    }

    private void deleteUnused() {
        if (!this.editable) {
            return;
        }
        List<WorkflowModel.Node> unused = this.model.nodes().stream().filter(n -> !this.selectedNodes.contains(n) && this.model.edges().stream().noneMatch(e -> e.source().equals(n.id) || e.target().equals(n.id))).toList();
        unused.forEach(this.model::removeNode);
        if (!unused.isEmpty()) {
            this.changeListener.run();
        }
        this.repaint();
    }

    private void toggleSelected(Consumer<WorkflowModel.Node> action) {
        if (!this.editable || this.selectedNodes.isEmpty()) {
            return;
        }
        this.selectedNodes.forEach(action);
        this.changeListener.run();
        this.repaint();
    }

    private void expandBundleNode() {
        if (!this.editable) {
            return;
        }
        WorkflowModel.Node node = this.primary;
        if (node == null || node.nodeKind != WorkflowModel.NodeKind.ASSET_BUNDLE) {
            return;
        }
        List<WorkflowModel.Node> created = this.model.expandAssetBundle(node);
        if (!created.isEmpty()) {
            this.clearNodeSelection();
            this.replaceSelection(created.getFirst());
            this.changeListener.run();
            this.feedback("已从资源组展开 " + created.size() + " 个资产节点");
        }
        this.repaint();
    }

    private void copySelection() {
        if (this.selectedNodes.isEmpty()) {
            return;
        }
        LinkedHashSet<String> copiedIds = new LinkedHashSet<String>();
        for (WorkflowModel.Node selected : this.selectedNodes) {
            copiedIds.add(selected.id);
            if (!CanvasPanel.isContainer(selected)) continue;
            this.descendants(selected).forEach(node -> copiedIds.add(node.id));
        }
        WorkflowModel source = this.model.deepCopy();
        source.nodes().stream().filter(node -> !copiedIds.contains(node.id)).toList().forEach(source::removeNode);
        this.clipboard = source;
        int minX = source.nodes().stream().mapToInt(n -> n.x).min().orElse(0);
        int minY = source.nodes().stream().mapToInt(n -> n.y).min().orElse(0);
        this.clipboardAnchor = new Point(minX, minY);
    }

    private void pasteSelection() {
        if (!this.editable || this.clipboard == null || this.clipboard.nodes().isEmpty()) {
            return;
        }
        this.pasteAt(this.world(this.lastMouse));
    }

    private void duplicateSelection() {
        if (!this.editable || this.selectedNodes.isEmpty()) {
            return;
        }
        this.copySelection();
        this.pasteAt(new Point(this.clipboardAnchor.x + 30, this.clipboardAnchor.y + 30));
    }

    private void pasteAt(Point target) {
        WorkflowModel.Node copy;
        HashMap<String, WorkflowModel.Node> mapping = new HashMap<String, WorkflowModel.Node>();
        LinkedHashSet<WorkflowModel.Node> pasted = new LinkedHashSet<WorkflowModel.Node>();
        for (WorkflowModel.Node source : this.clipboard.nodes()) {
            copy = this.model.addNode(target.x + source.x - this.clipboardAnchor.x, target.y + source.y - this.clipboardAnchor.y);
            CanvasPanel.copyNode(source, copy);
            this.model.setCodeBearing(copy, source.codeBearing);
            if (copy.nodeKind == WorkflowModel.NodeKind.FILE) {
                this.model.ensureFileSlot(copy);
            }
            mapping.put(source.id, copy);
            pasted.add(copy);
        }
        for (WorkflowModel.Node source : this.clipboard.nodes()) {
            copy = (WorkflowModel.Node)mapping.get(source.id);
            if (mapping.containsKey(source.parentScopeId)) {
                copy.parentScopeId = ((WorkflowModel.Node)mapping.get((Object)source.parentScopeId)).id;
            }
            if (mapping.containsKey(source.fileNodeId)) {
                copy.fileNodeId = ((WorkflowModel.Node)mapping.get((Object)source.fileNodeId)).id;
            }
            this.copySlotContents(source, copy);
        }
        for (WorkflowModel.Edge edge : this.clipboard.edges()) {
            WorkflowModel.Node from = (WorkflowModel.Node)mapping.get(edge.source());
            WorkflowModel.Node to = (WorkflowModel.Node)mapping.get(edge.target());
            if (from == null || to == null) continue;
            WorkflowModel.Port out = this.model.output(from, edge.sourcePort());
            WorkflowModel.Port in = this.model.input(to, edge.targetPort());
            if (out == null || in == null || !this.model.connect(from, out, to, in)) continue;
            WorkflowModel.Edge created = this.model.edges().getLast();
            for (WorkflowModel.Reroute point : edge.reroutes()) {
                created.reroutes().add(new WorkflowModel.Reroute(target.x + point.x - this.clipboardAnchor.x, target.y + point.y - this.clipboardAnchor.y));
            }
        }
        this.selectedNodes.clear();
        this.selectedNodes.addAll(pasted);
        this.primary = (WorkflowModel.Node)pasted.getLast();
        this.notifySelection();
        this.changeListener.run();
    }

    private void copySlotContents(WorkflowModel.Node source, WorkflowModel.Node copy) {
        String sourceId = source.nodeKind == WorkflowModel.NodeKind.FILE ? "file:" + source.id : (source.codeBearing ? "node:" + source.id : "");
        String targetId = copy.nodeKind == WorkflowModel.NodeKind.FILE ? "file:" + copy.id : (copy.codeBearing ? "node:" + copy.id : "");
        if (sourceId.isBlank() || targetId.isBlank()) {
            return;
        }
        WorkflowModel.CodeSlot from = this.clipboard.codeSlot(sourceId);
        WorkflowModel.CodeSlot to = this.model.codeSlot(targetId);
        if (from == null || to == null) {
            return;
        }
        to.language = from.language;
        to.activeCode = from.activeCode;
        to.activeRevision = from.activeRevision;
        to.previousCode = from.previousCode;
        to.previousSourceRevision = from.previousSourceRevision;
        to.lastAppliedRequestId = from.lastAppliedRequestId;
        to.draft = null;
    }

    private List<WorkflowModel.Node> descendants(WorkflowModel.Node container) {
        LinkedHashSet<WorkflowModel.Node> result = new LinkedHashSet<WorkflowModel.Node>();
        ArrayDeque<WorkflowModel.Node> pending = new ArrayDeque<WorkflowModel.Node>();
        pending.add(container);
        while (!pending.isEmpty()) {
            WorkflowModel.Node parent = (WorkflowModel.Node)pending.removeFirst();
            for (WorkflowModel.Node node : this.model.nodes()) {
                if (result.contains(node) || !CanvasPanel.belongsTo(node, parent)) continue;
                result.add(node);
                if (!CanvasPanel.isContainer(node)) continue;
                pending.add(node);
            }
        }
        return List.copyOf(result);
    }

    private static void copyNode(WorkflowModel.Node source, WorkflowModel.Node target) {
        target.name = source.name;
        target.prompt = source.prompt;
        target.artifact = source.artifact;
        target.category = source.category;
        target.templateLibrary = source.templateLibrary;
        target.templateId = source.templateId;
        target.templateVersion = source.templateVersion;
        target.templateLanguage = source.templateLanguage;
        target.nodeKind = source.nodeKind;
        target.valueType = source.valueType;
        target.operation = source.operation;
        target.classificationKey = source.classificationKey;
        target.codeBearing = source.codeBearing;
        target.parentScopeId = "";
        target.scopeRegion = source.scopeRegion;
        target.fileNodeId = "";
        target.relativePath = source.relativePath;
        target.role = source.role;
        target.containerWidth = source.containerWidth;
        target.containerHeight = source.containerHeight;
        target.collapsed = source.collapsed;
        target.muted = source.muted;
        target.detailMode = source.detailMode;
        target.rangeMode = source.rangeMode;
        target.nodeColor = source.nodeColor;
        target.assetType = source.assetType;
        target.bundleData = source.bundleData;
        target.groupInputNodeId = source.groupInputNodeId;
        target.bundleCollapsed = source.bundleCollapsed;
        target.nodeWidth = source.nodeWidth;
        target.nodeHeight = source.nodeHeight;
        target.inputs.clear();
        target.outputs.clear();
        source.inputs.forEach(p -> target.inputs.add(new WorkflowModel.Port(p.id, p.name, p.declaredType, p.dataType, p.required)));
        source.outputs.forEach(p -> target.outputs.add(new WorkflowModel.Port(p.id, p.name, p.declaredType, p.dataType, p.required)));
    }

    private void zoomAt(Point screen, double wheel) {
        double old = this.zoom;
        double next = CanvasPanel.clamp(old * Math.pow(1.12, -wheel), 0.25, 2.5);
        Point2D.Double world = new Point2D.Double((double)(screen.x - this.panX) / old, (double)(screen.y - this.panY) / old);
        this.zoom = next;
        this.panX = (int)Math.round((double)screen.x - world.x * next);
        this.panY = (int)Math.round((double)screen.y - world.y * next);
        // 缩放是纯视图操作，不记录撤销历史
        this.repaint();
    }

    public void frameAll() {
        this.frameNodes(this.model.nodes());
    }

    public void focusNode(WorkflowModel.Node node) {
        if (node == null) {
            return;
        }
        this.select(node);
        this.frameNodes(List.of(node));
    }

    private void frameSelection() {
        if (this.selectedNodes.isEmpty()) {
            return;
        }
        this.frameNodes(this.selectedNodes);
    }

    /** 定位画面最中心：计算全部可见节点包围盒（最上/最左/最右/最下）的中心点，平移到画面正中（保持当前缩放）。 */
    public void centerOnBounds() {
        List<WorkflowModel.Node> visible = this.model.nodes().stream()
                .filter(this::visibleNode)
                .toList();
        if (visible.isEmpty()) {
            visible = this.model.nodes();
        }
        if (visible.isEmpty()) {
            this.setView(0, 0, this.zoom);
            return;
        }
        int minX = visible.stream().mapToInt(n -> n.x).min().orElse(0);
        int minY = visible.stream().mapToInt(n -> n.y).min().orElse(0);
        int maxX = visible.stream().mapToInt(n -> n.x + this.nodeWidth(n)).max().orElse(215);
        int maxY = visible.stream().mapToInt(n -> n.y + this.nodeHeight(n)).max().orElse(100);
        int centerX = (minX + maxX) / 2;
        int centerY = (minY + maxY) / 2;
        this.panX = (int)Math.round((double)this.getWidth() / 2.0 - (double)centerX * this.zoom);
        this.panY = (int)Math.round((double)this.getHeight() / 2.0 - (double)centerY * this.zoom);
        this.repaint();
    }

    private void frameNodes(Collection<WorkflowModel.Node> nodes) {
        if (nodes.isEmpty()) {
            this.setView(0, 0, 1.0);
            return;
        }
        int minX = nodes.stream().mapToInt(n -> n.x).min().orElse(0);
        int minY = nodes.stream().mapToInt(n -> n.y).min().orElse(0);
        int maxX = nodes.stream().mapToInt(n -> n.x + this.nodeWidth((WorkflowModel.Node)n)).max().orElse(215);
        int maxY = nodes.stream().mapToInt(n -> n.y + this.nodeHeight((WorkflowModel.Node)n)).max().orElse(100);
        double availableW = Math.max(200, this.getWidth() - 120);
        double availableH = Math.max(160, this.getHeight() - 120);
        this.zoom = CanvasPanel.clamp(Math.min(availableW / (double)Math.max(1, maxX - minX), availableH / (double)Math.max(1, maxY - minY)), 0.25, 2.5);
        this.panX = (int)Math.round((double)this.getWidth() / 2.0 - (double)(minX + maxX) / 2.0 * this.zoom);
        this.panY = (int)Math.round((double)this.getHeight() / 2.0 - (double)(minY + maxY) / 2.0 * this.zoom);
        this.repaint();
    }

    private void startGrab() {
        if (!this.editable || this.keyboardGrab || this.selectedReroute == null && this.selectedNodes.isEmpty()) {
            return;
        }
        this.cancelOperation();
        this.keyboardGrab = true;
        this.grabStart = this.world(this.lastMouse);
        this.dragChanged = false;
        if (this.selectedReroute != null) {
            this.grabReroute = this.selectedReroute;
            this.rerouteOrigin = new Point(this.grabReroute.x, this.grabReroute.y);
        } else {
            this.dragOrigins.clear();
            this.selectedNodes.forEach(node -> this.dragOrigins.put((WorkflowModel.Node)node, new Point(node.x, node.y)));
            this.includeContainerChildren();
        }
        this.setCursor(Cursor.getPredefinedCursor(13));
        this.repaint();
    }

    private void updateGrab(Point world) {
        if (!this.keyboardGrab || this.grabStart == null) {
            return;
        }
        int dx = world.x - this.grabStart.x;
        int dy = world.y - this.grabStart.y;
        if (this.grabReroute != null && this.rerouteOrigin != null) {
            this.grabReroute.x = this.rerouteOrigin.x + dx;
            this.grabReroute.y = this.rerouteOrigin.y + dy;
        } else {
            this.dragOrigins.forEach((node, origin) -> {
                node.x = origin.x + dx;
                node.y = origin.y + dy;
            });
        }
        this.dragChanged = dx != 0 || dy != 0;
        this.repaint();
    }

    private void finishGrab(boolean confirm) {
        if (!this.keyboardGrab) {
            return;
        }
        if (!confirm) {
            if (this.grabReroute != null && this.rerouteOrigin != null) {
                this.grabReroute.x = this.rerouteOrigin.x;
                this.grabReroute.y = this.rerouteOrigin.y;
            }
            this.dragOrigins.forEach((node, origin) -> {
                node.x = origin.x;
                node.y = origin.y;
            });
        } else if (this.dragChanged) {
            this.assignMovedNodesToContainers();
            this.changeListener.run();
        }
        this.keyboardGrab = false;
        this.grabStart = null;
        this.grabReroute = null;
        this.rerouteOrigin = null;
        this.dragOrigins.clear();
        this.dragChanged = false;
        this.setCursor(Cursor.getDefaultCursor());
        this.repaint();
    }

    private void cancelOrExitGroup() {
        if (!this.groupFocusId.isBlank()) {
            this.cancelGroupFocus();
            return;
        }
        this.cancelOperation();
    }

    private void cancelOperation() {
        if (this.resizingNode != null) {
            this.resizingNode = null;
            this.resizeStart = null;
            this.dragChanged = false;
            this.repaint();
            return;
        }
        if (this.keyboardGrab) {
            this.finishGrab(false);
            return;
        }
        if (this.dragStart != null) {
            this.dragOrigins.forEach((node, origin) -> {
                node.x = origin.x;
                node.y = origin.y;
            });
        }
        if (this.draggingReroute != null && this.rerouteOrigin != null) {
            this.draggingReroute.x = this.rerouteOrigin.x;
            this.draggingReroute.y = this.rerouteOrigin.y;
        }
        this.connecting = null;
        this.connectingPort = null;
        this.inputConnecting = null;
        this.inputConnectingPort = null;
        this.connectingReroute = null;
        this.wirePoint = null;
        this.dragStart = null;
        this.dragOrigins.clear();
        this.draggingReroute = null;
        this.rerouteOrigin = null;
        this.boxCurrent = null;
        this.boxStart = null;
        this.cutPath.clear();
        this.reroutePath.clear();
        this.dragChanged = false;
        this.repaint();
    }

    private void groupSelectedNodes() {
        if (!this.editable || this.selectedNodes.isEmpty()) {
            return;
        }
        int minX = Integer.MAX_VALUE;
        int minY = Integer.MAX_VALUE;
        HashSet<String> selIds = new HashSet<String>();
        for (WorkflowModel.Node n : this.selectedNodes) {
            selIds.add(n.id);
            if (n.x < minX) {
                minX = n.x;
            }
            if (n.y >= minY) continue;
            minY = n.y;
        }
        WorkflowModel.Node group = this.model.addGroupNode(minX - 20, minY - 40, "节点组 " + (this.model.groupOutputs().size() + 1));
        WorkflowModel.Node gi = this.model.addGroupInputNode(group.x + 30, group.y + 60, "节点组输入");
        gi.parentScopeId = group.id;
        WorkflowModel.Node go = this.model.addNodeGroupOutput(group.x + 30, group.y + 120, "节点组输出");
        go.parentScopeId = group.id;
        for (WorkflowModel.Node n : this.selectedNodes) {
            n.parentScopeId = group.id;
        }
        boolean giConnected = false;
        boolean goConnected = false;
        for (WorkflowModel.Edge e : this.model.edges()) {
            if (!giConnected && selIds.contains(e.target()) && !selIds.contains(e.source())) {
                WorkflowModel.Port tp;
                WorkflowModel.Node target = this.model.byId(e.target());
                WorkflowModel.Port giOut = this.model.output(gi, "value");
                WorkflowModel.Port port = tp = target == null ? null : this.model.input(target, e.targetPort());
                if (giOut != null && tp != null) {
                    this.model.connect(gi, giOut, target, tp);
                    giConnected = true;
                }
            }
            if (goConnected || !selIds.contains(e.source()) || selIds.contains(e.target())) continue;
            WorkflowModel.Node source = this.model.byId(e.source());
            WorkflowModel.Port sp = source == null ? null : this.model.output(source, e.sourcePort());
            WorkflowModel.Port goIn = this.model.input(go, "value");
            if (sp == null || goIn == null) continue;
            this.model.connect(source, sp, go, goIn);
            goConnected = true;
        }
        if (!giConnected && !this.selectedNodes.isEmpty()) {
            WorkflowModel.Port fp;
            WorkflowModel.Node first = this.selectedNodes.getFirst();
            WorkflowModel.Port giOut = this.model.output(gi, "value");
            WorkflowModel.Port port = fp = first.inputs.isEmpty() ? null : first.inputs.get(0);
            if (giOut != null && fp != null) {
                this.model.connect(gi, giOut, first, fp);
            }
        }
        if (!goConnected && !this.selectedNodes.isEmpty()) {
            WorkflowModel.Node last = this.selectedNodes.getLast();
            WorkflowModel.Port sp = last.outputs.isEmpty() ? null : last.outputs.get(0);
            WorkflowModel.Port goIn = this.model.input(go, "value");
            if (sp != null && goIn != null) {
                this.model.connect(last, sp, go, goIn);
            }
        }
        this.syncGroupPorts(group);
        this.clearNodeSelection();
        this.select(group);
        this.changeListener.run();
    }

    private void enterGroupFocus(String groupId) {
        this.groupFocusId = groupId;
        this.syncGroupPorts(this.model.byId(groupId));
        this.clearNodeSelection();
        List<WorkflowModel.Node> children = this.model.nodes().stream().filter(n -> n.parentScopeId.equals(groupId)).toList();
        this.frameNodes(children);
    }

    private void cancelGroupFocus() {
        this.groupFocusId = "";
        this.clearNodeSelection();
        this.frameAll();
        this.repaint();
    }

    private void syncGroupPorts(WorkflowModel.Node group) {
        if (group == null || group.nodeKind != WorkflowModel.NodeKind.GROUP) {
            return;
        }
        List<WorkflowModel.Node> groupInputNodes = this.model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT && n.parentScopeId.equals(group.id)).toList();
        List<WorkflowModel.Node> groupOutputNodes = this.model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT && n.parentScopeId.equals(group.id)).toList();
        ArrayList<WorkflowModel.Port> newInputs = new ArrayList<WorkflowModel.Port>();
        ArrayList<WorkflowModel.Port> newOutputs = new ArrayList<WorkflowModel.Port>();
        for (WorkflowModel.Node gin : groupInputNodes) {
            for (WorkflowModel.Port p : gin.outputs) {
                newInputs.add(new WorkflowModel.Port("grp_in_" + p.id, gin.name + "·" + p.name, p.dataType, p.required));
            }
        }
        for (WorkflowModel.Node gout : groupOutputNodes) {
            for (WorkflowModel.Port p : gout.inputs) {
                newOutputs.add(new WorkflowModel.Port("grp_out_" + p.id, gout.name + "·" + p.name, p.dataType, p.required));
            }
        }
        if (newInputs.isEmpty() && newOutputs.isEmpty()) {
            return;
        }
        if (newInputs.isEmpty()) {
            newInputs.add(new WorkflowModel.Port("grp_in_default", "输入", "any", false));
        }
        if (newOutputs.isEmpty()) {
            newOutputs.add(new WorkflowModel.Port("grp_out_default", "输出", "any", false));
        }
        this.model.replacePorts(group, newInputs, newOutputs);
    }

    private void includeContainerChildren() {
        boolean added;
        do {
            added = false;
            for (WorkflowModel.Node container : List.copyOf(this.dragOrigins.keySet())) {
                if (!CanvasPanel.isContainer(container)) continue;
                for (WorkflowModel.Node node : this.model.nodes()) {
                    if (this.dragOrigins.containsKey(node) || !CanvasPanel.belongsTo(node, container)) continue;
                    this.dragOrigins.put(node, new Point(node.x, node.y));
                    added = true;
                }
            }
        } while (added);
    }

    private void assignMovedNodesToContainers() {
        for (WorkflowModel.Node node : this.dragOrigins.keySet()) {
            boolean inGroup;
            if (CanvasPanel.isContainer(node) && this.selectedNodes.contains(node)) continue;
            WorkflowModel.Node scope = this.containing(node, WorkflowModel.NodeKind.SCOPE);
            WorkflowModel.Node file = this.containing(node, WorkflowModel.NodeKind.FILE);
            WorkflowModel.Node currentGroup = node.parentScopeId.isBlank() ? null : this.model.byId(node.parentScopeId);
            boolean bl = inGroup = currentGroup != null && currentGroup.nodeKind == WorkflowModel.NodeKind.GROUP;
            String string = scope != null ? scope.id : (node.parentScopeId = inGroup ? node.parentScopeId : "");
            node.scopeRegion = scope == null ? "body" : (scope.name.startsWith("If") && node.x + this.nodeWidth(node) / 2 >= scope.x + this.nodeWidth(scope) / 2 ? "else" : (scope.name.startsWith("If") ? "then" : "body"));
            node.fileNodeId = file == null ? "" : file.id;
        }
        this.resizeContainersToFit();
    }

    private void resizeContainersToFit() {
        for (WorkflowModel.Node container : this.model.nodes()) {
            int th;
            int tw;
            if (!CanvasPanel.isContainer(container) || container.collapsed || container == this.resizingNode) continue;
            List<WorkflowModel.Node> children = this.model.nodes().stream().filter(n -> CanvasPanel.belongsTo(n, container)).toList();
            if (children.isEmpty()) {
                tw = 320;
                th = 220;
            } else {
                int maxCX = Integer.MIN_VALUE;
                int maxCY = Integer.MIN_VALUE;
                for (WorkflowModel.Node c : children) {
                    if (c.x + this.nodeWidth(c) > maxCX) {
                        maxCX = c.x + this.nodeWidth(c);
                    }
                    if (c.y + this.nodeHeight(c) <= maxCY) continue;
                    maxCY = c.y + this.nodeHeight(c);
                }
                tw = Math.max(320, maxCX - container.x + 40);
                th = Math.max(220, maxCY - container.y + 34 + 40);
            }
            this.containerTargets.put(container.id, new int[]{tw, th});
        }
    }

    private void animateContainers() {
        boolean needsRepaint = false;
        Iterator<Map.Entry<String, int[]>> it = this.containerTargets.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, int[]> entry = it.next();
            WorkflowModel.Node c = this.model.byId(entry.getKey());
            if (c == null) {
                it.remove();
                continue;
            }
            int[] t = entry.getValue();
            int cw = CanvasPanel.lerp(c.containerWidth, t[0], 0.25);
            int ch = CanvasPanel.lerp(c.containerHeight, t[1], 0.25);
            if (cw != c.containerWidth || ch != c.containerHeight) {
                needsRepaint = true;
            }
            c.containerWidth = cw;
            c.containerHeight = ch;
            if (Math.abs(cw - t[0]) >= 2 || Math.abs(ch - t[1]) >= 2) continue;
            it.remove();
        }
        if (needsRepaint) {
            this.repaint();
        }
    }

    private static int lerp(int from, int to, double t) {
        return from + (int)((double)(to - from) * Math.max(0.0, Math.min(1.0, t)));
    }

    private WorkflowModel.Node containing(WorkflowModel.Node node, WorkflowModel.NodeKind kind) {
        Point center = new Point(node.x + this.nodeWidth(node) / 2, node.y + Math.min(this.nodeHeight(node) / 2, 60));
        List<WorkflowModel.Node> candidates = this.model.nodes().stream().filter(candidate -> candidate != node && candidate.nodeKind == kind && this.containerBody((WorkflowModel.Node)candidate).contains(center) && (kind != WorkflowModel.NodeKind.SCOPE || !this.scopeAncestor(node, (WorkflowModel.Node)candidate))).toList();
        return candidates.isEmpty() ? null : candidates.getLast();
    }

    private boolean scopeAncestor(WorkflowModel.Node ancestor, WorkflowModel.Node candidate) {
        if (ancestor.nodeKind != WorkflowModel.NodeKind.SCOPE) {
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

    private static boolean belongsTo(WorkflowModel.Node node, WorkflowModel.Node container) {
        if (container.nodeKind == WorkflowModel.NodeKind.FILE && container.rangeMode) {
            return node.fileNodeId.equals(container.id);
        }
        if (container.nodeKind == WorkflowModel.NodeKind.ASSET) {
            return node.fileNodeId.equals(container.id);
        }
        return container.nodeKind == WorkflowModel.NodeKind.SCOPE ? node.parentScopeId.equals(container.id) : false;
    }

    private static boolean isContainer(WorkflowModel.Node node) {
        return node.nodeKind == WorkflowModel.NodeKind.SCOPE || node.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE || node.nodeKind == WorkflowModel.NodeKind.FILE && node.rangeMode;
    }

    private Rectangle containerBody(WorkflowModel.Node node) {
        return new Rectangle(node.x + 8, node.y + 34, this.nodeWidth(node) - 16, this.nodeHeight(node) - 34 - 8);
    }

    private WorkflowModel.Reroute insertReroute(EdgeHit hit, Point point) {
        WorkflowModel.Reroute reroute = new WorkflowModel.Reroute(point.x, point.y);
        hit.edge.reroutes().add(Math.min(hit.segmentIndex, hit.edge.reroutes().size()), reroute);
        return reroute;
    }

    private void selectReroute(WorkflowModel.Edge edge, WorkflowModel.Reroute point) {
        this.selectedEdge = edge;
        this.rerouteEdge = edge;
        this.selectedReroute = point;
        this.repaint();
    }

    private boolean connectNodes(WorkflowModel.Node source, WorkflowModel.Port sourcePort, WorkflowModel.Node target, WorkflowModel.Port targetPort) {
        WorkflowModel.ConnectionResult result = this.model.connectChecked(source, sourcePort, target, targetPort);
        if (!result.connected()) {
            this.feedback(result.reason());
        }
        return result.connected();
    }

    private void feedback(String message) {
        this.feedbackListener.accept(message);
    }

    private boolean connectFromReroute(WorkflowModel.Reroute point, WorkflowModel.Node target, WorkflowModel.Port targetPort) {
        WorkflowModel.Port sourcePort;
        RerouteOrigin origin = this.rerouteOrigin(point);
        if (origin == null) {
            return false;
        }
        WorkflowModel.Node source = this.model.byId(origin.edge.source());
        WorkflowModel.Port port = sourcePort = source == null ? null : this.model.output(source, origin.edge.sourcePort());
        if (source == null || sourcePort == null) {
            return false;
        }
        ArrayList<WorkflowModel.Reroute> route = new ArrayList<WorkflowModel.Reroute>();
        for (WorkflowModel.Reroute candidate : origin.edge.reroutes()) {
            route.add(candidate);
            if (!candidate.id.equals(origin.anchor.id)) continue;
            break;
        }
        if (!this.connectNodes(source, sourcePort, target, targetPort)) {
            return false;
        }
        this.model.edges().getLast().reroutes().addAll(route);
        return true;
    }

    private RerouteOrigin rerouteOrigin(WorkflowModel.Reroute point) {
        for (WorkflowModel.Edge edge : this.model.edges()) {
            if (!edge.reroutes().stream().anyMatch(candidate -> candidate.id.equals(point.id))) continue;
            return new RerouteOrigin(edge, point);
        }
        return null;
    }

    private void insertReroutesFromStroke() {
        HashSet<WorkflowModel.Edge> changed = new HashSet<WorkflowModel.Edge>();
        for (int i = 1; i < this.reroutePath.size(); ++i) {
            Point a = this.reroutePath.get(i - 1);
            Point b = this.reroutePath.get(i);
            for (WorkflowModel.Edge edge : this.model.edges()) {
                EdgeHit hit;
                if (changed.contains(edge) || (hit = this.intersectEdge(edge, a, b)) == null) continue;
                Point point = new Point((a.x + b.x) / 2, (a.y + b.y) / 2);
                this.insertReroute(hit, point);
                changed.add(edge);
            }
        }
        if (!changed.isEmpty()) {
            this.changeListener.run();
        }
    }

    private void cutEdges() {
        if (this.cutPath.size() < 2) {
            return;
        }
        ArrayList<WorkflowModel.Edge> removed = new ArrayList<WorkflowModel.Edge>();
        block0: for (WorkflowModel.Edge edge : this.model.edges()) {
            for (int i = 1; i < this.cutPath.size(); ++i) {
                if (this.intersectEdge(edge, this.cutPath.get(i - 1), this.cutPath.get(i)) == null) continue;
                removed.add(edge);
                continue block0;
            }
        }
        this.model.removeEdges(removed);
        if (!removed.isEmpty()) {
            this.changeListener.run();
        }
    }

    @Override
    protected void paintComponent(Graphics raw) {
        WorkflowModel.Node g;
        super.paintComponent(raw);
        Graphics2D screen = (Graphics2D)raw.create();
        screen.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        if (!this.groupFocusId.isBlank() && (g = this.model.byId(this.groupFocusId)) != null) {
            screen.setColor(new Color(45, 45, 48));
            screen.fillRect(0, 0, this.getWidth(), 28);
            screen.setColor(UiTheme.ACCENT);
            screen.setFont(this.getFont().deriveFont(1, 13.0f));
            screen.drawString("根 > " + g.name, 12, 20);
            screen.setColor(new Color(70, 70, 73));
            screen.drawLine(0, 28, this.getWidth(), 28);
        }
        this.drawGrid(screen);
        screen.translate(this.panX, this.panY);
        screen.scale(this.zoom, this.zoom);
        for (WorkflowModel.Node node : this.model.nodes()) {
            if (!CanvasPanel.isContainer(node) || !this.visibleNode(node)) continue;
            this.drawNode(screen, node);
        }
        this.drawEdges(screen);
        if (this.connecting != null && this.wirePoint != null) {
            this.drawCurve(screen, CanvasPanel.portCenter(this.outputPort(this.connecting, this.connectingPort)), this.wirePoint, new Color(86, 156, 214), 2.5f);
        }
        if (this.inputConnecting != null && this.wirePoint != null) {
            this.drawCurve(screen, this.wirePoint, CanvasPanel.portCenter(this.inputPort(this.inputConnecting, this.inputConnectingPort)), new Color(86, 156, 214), 2.5f);
        }
        if (this.connectingReroute != null && this.wirePoint != null) {
            this.drawCurve(screen, new Point(this.connectingReroute.x, this.connectingReroute.y), this.wirePoint, new Color(210, 170, 70), 2.5f);
        }
        for (WorkflowModel.Node node : this.model.nodes()) {
            if (CanvasPanel.isContainer(node) || !this.visibleNode(node)) continue;
            this.drawNode(screen, node);
        }
        this.drawOverlay(screen);
        screen.dispose();
    }

    private void drawGrid(Graphics2D g) {
        int index;
        double step = 20.0 * this.zoom;
        if (step < 6.0) {
            return;
        }
        double sx = CanvasPanel.mod(this.panX, step);
        double sy = CanvasPanel.mod(this.panY, step);
        for (double x = sx; x < (double)this.getWidth(); x += step) {
            index = (int)Math.round((x - (double)this.panX) / step);
            g.setColor(Math.floorMod(index, 5) == 0 ? new Color(52, 52, 54) : new Color(39, 39, 41));
            g.drawLine((int)x, 0, (int)x, this.getHeight());
        }
        for (double y = sy; y < (double)this.getHeight(); y += step) {
            index = (int)Math.round((y - (double)this.panY) / step);
            g.setColor(Math.floorMod(index, 5) == 0 ? new Color(52, 52, 54) : new Color(39, 39, 41));
            g.drawLine(0, (int)y, this.getWidth(), (int)y);
        }
    }

    private void drawEdges(Graphics2D g) {
        LinkedHashSet<WorkflowModel.Reroute> visibleReroutes = new LinkedHashSet<WorkflowModel.Reroute>();
        for (WorkflowModel.Edge edge : this.model.edges()) {
            List<Point> points;
            WorkflowModel.Node source = this.model.byId(edge.source());
            WorkflowModel.Node target = this.model.byId(edge.target());
            if (!this.visibleNode(source) || !this.visibleNode(target) || (points = this.edgePoints(edge)).size() < 2) continue;
            visibleReroutes.addAll(edge.reroutes());
            Color color = edge == this.selectedEdge ? UiTheme.ACCENT : new Color(86, 156, 214);
            float width = edge == this.selectedEdge ? 3.0f : 2.0f;
            for (int i = 1; i < points.size(); ++i) {
                this.drawCurve(g, points.get(i - 1), points.get(i), color, width);
            }
        }
        for (WorkflowModel.Reroute point : visibleReroutes) {
            g.setColor(UiTheme.PANEL);
            g.fill(new Ellipse2D.Double(point.x - 6, point.y - 6, 12.0, 12.0));
            g.setColor(point == this.selectedReroute ? UiTheme.ACCENT : new Color(210, 170, 70));
            g.setStroke(new BasicStroke(2.0f));
            g.draw(new Ellipse2D.Double(point.x - 6, point.y - 6, 12.0, 12.0));
        }
    }

    private void drawCurve(Graphics2D g, Point p, Point q, Color color, float width) {
        g.setStroke(new BasicStroke((float)((double)width / this.zoom)));
        g.setColor(color);
        int handle = Math.max(35, Math.abs(q.x - p.x) / 2);
        g.draw(new CubicCurve2D.Float(p.x, p.y, p.x + handle, p.y, q.x - handle, q.y, q.x, q.y));
    }

    private void drawNode(Graphics2D g, WorkflowModel.Node n) {
        int width = this.nodeWidth(n);
        int height = this.nodeHeight(n);
        Color border = switch (n.status) {
            case FAILED -> new Color(244, 71, 71);
            case SUCCEEDED -> new Color(78, 201, 176);
            case QUEUED, PROCESSING -> new Color(220, 170, 70);
            default -> new Color(82, 82, 88);
        };
        Color bgColor = n.status == WorkflowModel.Status.SUCCEEDED ? new Color(55, 55, 60) : (CanvasPanel.isContainer(n) ? new Color(38, 38, 40, 150) : UiTheme.PANEL);
        RoundRectangle2D.Float box = new RoundRectangle2D.Float(n.x, n.y, width, height, 7.0f, 7.0f);
        g.setColor(bgColor);
        g.fill(box);
        Color header = n.status == WorkflowModel.Status.QUEUED || n.status == WorkflowModel.Status.PROCESSING ? new Color(138, 116, 64) : CanvasPanel.categoryColor(n);
        g.setColor(this.selectedNodes.contains(n) ? header.brighter() : header);
        g.fill(new RoundRectangle2D.Float(n.x + 1, n.y + 1, width - 2, 34.0f, 6.0f, 6.0f));
        g.setStroke(new BasicStroke((float)((n == this.primary ? 2.8 : (this.selectedNodes.contains(n) ? 2.1 : (n == this.hoveringScope ? 3.5 : 1.5))) / this.zoom)));
        g.setColor(n == this.hoveringScope ? UiTheme.ACCENT : (this.selectedNodes.contains(n) ? UiTheme.ACCENT : border));
        g.draw(box);
        if (n == this.hoveringScope) {
            g.setColor(new Color(0, 122, 204, 40));
            g.fill(box);
        }
        g.setColor(n.muted ? new Color(230, 160, 160) : Color.WHITE);
        g.setFont(this.getFont().deriveFont(1, 14.0f));
        g.drawString(CanvasPanel.trim(n.name, CanvasPanel.isContainer(n) ? 35 : (n.nodeKind == WorkflowModel.NodeKind.GROUP ? 30 : 17)), n.x + 13, n.y + 22);
        if (n.nodeKind == WorkflowModel.NodeKind.GROUP) {
            g.setFont(this.getFont().deriveFont(1, 9.0f));
            g.setColor(new Color(180, 170, 220));
            String grpLabel = "GRP";
            int grpW = g.getFontMetrics().stringWidth(grpLabel);
            g.drawString(grpLabel, n.x + width - 24 - grpW, n.y + 21);
        }
        String category = CanvasPanel.trim(n.category, 12);
        g.setFont(this.getFont().deriveFont(10.0f));
        g.setColor(new Color(225, 225, 225));
        g.drawString(category, n.x + width - 11 - g.getFontMetrics().stringWidth(category), n.y + 21);
        if (n.collapsed) {
            return;
        }
        if (n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) {
            BundleDataUtil.BundleView view = this.bundleView(n);
            g.setColor(new Color(120, 160, 220));
            g.setFont(this.getFont().deriveFont(1, 11.0f));
            g.drawString("成员 " + view.memberCount(), n.x + 13, n.y + 34 + 18);
            int bx = n.x + 13;
            int by = n.y + 34 + 28;
            for (Map.Entry<String, Integer> e : view.categoryStats().entrySet()) {
                String text = e.getKey() + " " + String.valueOf(e.getValue());
                int w = g.getFontMetrics().stringWidth(text) + 12;
                if (bx + w > n.x + this.nodeWidth(n) - 10) {
                    bx = n.x + 13;
                    by += 18;
                }
                g.setColor(new Color(70, 90, 120));
                g.fillRoundRect(bx, by - 12, w, 16, 5, 5);
                g.setColor(new Color(200, 215, 230));
                g.drawString(text, bx + 6, by);
                bx += w + 5;
            }
            if (!n.bundleCollapsed) {
                int py = by + 20;
                int shown = 0;
                for (BundleDataUtil.BundleMember m : view.members()) {
                    if (shown >= 8) break;
                    g.setColor(UiTheme.MUTED);
                    g.setFont(this.getFont().deriveFont(10.0f));
                    g.drawString(CanvasPanel.trim(m.relativePath(), 26), n.x + 16, py);
                    py += 14;
                    ++shown;
                }
                if (view.members().size() > 8) {
                    g.setColor(new Color(210, 200, 120));
                    g.drawString("… 共 " + view.members().size() + " 项", n.x + 16, py);
                }
                g.setColor(new Color(100, 100, 105));
                g.drawString("双击收起/展开预览", n.x + 16, py + 14);
            } else {
                g.setColor(new Color(100, 100, 105));
                g.drawString("双击展开成员预览", n.x + 13, by + 20);
            }
        }
        if (n.detailMode && !CanvasPanel.isContainer(n) && this.hasPrompt(n)) {
            FontMetrics fm = this.detailMetrics();
            List<String> lines = this.wrapPrompt(n.prompt, width - 24, fm);
            int portsArea = Math.max(n.inputs.size(), n.outputs.size()) * 22 + 28;
            int visible = Math.max(1, (height - 34 - 6 - portsArea - 4) / 17);
            int show = Math.min(visible, lines.size());
            g.setFont(this.getFont().deriveFont(12.0f));
            g.setColor(UiTheme.MUTED);
            int baseline = n.y + 34 + 6 + fm.getAscent();
            for (int i2 = 0; i2 < show; ++i2) {
                g.drawString(lines.get(i2), n.x + 12, baseline + i2 * 17);
            }
            if (lines.size() > visible) {
                g.drawString("…", n.x + 12 + fm.stringWidth(lines.get(visible - 1)), baseline + (visible - 1) * 17);
            }
        }
        g.setFont(this.getFont().deriveFont(12.0f));
        for (int i = 0; i < n.inputs.size(); ++i) {
            boolean isCondition;
            WorkflowModel.Port p = n.inputs.get(i);
            g.setColor(UiTheme.MUTED);
            g.drawString(CanvasPanel.trim(p.name + " : " + p.dataType, 17), n.x + 13, this.portY(n, i) + 4);
            g.setColor(CanvasPanel.portColor(p));
            boolean bl = isCondition = n.nodeKind == WorkflowModel.NodeKind.SCOPE && i == 0 && (p.dataType.contains("boolean") || p.dataType.contains("bool"));
            if (isCondition) {
                int cx = (int)this.inputPort(n, p).getCenterX();
                int cy = (int)this.inputPort(n, p).getCenterY();
                g.fill(new Polygon(new int[]{cx - 6, cx, cx + 6, cx}, new int[]{cy, cy - 6 - 2, cy, cy + 6 + 2}, 4));
                continue;
            }
            g.fill(this.inputPort(n, p));
        }
        for (int i = 0; i < n.outputs.size(); ++i) {
            WorkflowModel.Port p = n.outputs.get(i);
            String text = CanvasPanel.trim(p.name + " : " + p.dataType, 17);
            g.setColor(UiTheme.MUTED);
            g.drawString(text, n.x + width - 13 - g.getFontMetrics().stringWidth(text), this.portY(n, i) + 4);
            g.setColor(CanvasPanel.portColor(p));
            g.fill(this.outputPort(n, p));
        }
        g.setColor(UiTheme.MUTED);
        g.drawString(n.category + " · " + CanvasPanel.statusLabel(n.status), n.x + 13, n.y + height - 10);
        g.setColor(new Color(100, 100, 105));
        g.fillPolygon(new int[]{n.x + width - 10, n.x + width, n.x + width}, new int[]{n.y + height, n.y + height - 10, n.y + height}, 3);
        if (CanvasPanel.isContainer(n)) {
            g.setColor(new Color(190, 190, 195));
            g.setFont(this.getFont().deriveFont(1, 11.0f));
            if (n.name.startsWith("If")) {
                int middle = n.x + width / 2;
                g.drawLine(middle, n.y + 34 + 34, middle, n.y + height - 28);
                g.drawString("then", n.x + 14, n.y + 34 + 22);
                g.drawString("else", middle + 12, n.y + 34 + 22);
            } else {
                g.drawString("body", n.x + 14, n.y + 34 + 22);
            }
        }
    }

    private void drawOverlay(Graphics2D g) {
        if (this.boxStart != null && this.boxCurrent != null) {
            g.setColor(new Color(0, 122, 204, 45));
            g.fill(this.box());
            g.setColor(UiTheme.ACCENT);
            g.setStroke(new BasicStroke((float)(1.5 / this.zoom)));
            g.draw(this.box());
        }
        this.drawPath(g, this.cutPath, new Color(244, 71, 71));
        this.drawPath(g, this.reroutePath, new Color(210, 170, 70));
    }

    private void drawPath(Graphics2D g, List<Point> path, Color color) {
        if (path.size() < 2) {
            return;
        }
        g.setColor(color);
        g.setStroke(new BasicStroke((float)(2.5 / this.zoom)));
        for (int i = 1; i < path.size(); ++i) {
            g.drawLine(path.get((int)(i - 1)).x, path.get((int)(i - 1)).y, path.get((int)i).x, path.get((int)i).y);
        }
    }

    private EdgeHit hitEdge(Point point) {
        double limit = 9.0 / this.zoom;
        for (int i = this.model.edges().size() - 1; i >= 0; --i) {
            WorkflowModel.Edge edge = this.model.edges().get(i);
            List<Point> anchors = this.edgePoints(edge);
            for (int segment = 0; segment < anchors.size() - 1; ++segment) {
                List<Point> samples = CanvasPanel.curveSamples(anchors.get(segment), anchors.get(segment + 1));
                for (int j = 1; j < samples.size(); ++j) {
                    if (!(Line2D.ptSegDist(samples.get((int)(j - 1)).x, samples.get((int)(j - 1)).y, samples.get((int)j).x, samples.get((int)j).y, point.x, point.y) <= limit)) continue;
                    return new EdgeHit(edge, segment);
                }
            }
        }
        return null;
    }

    private EdgeHit intersectEdge(WorkflowModel.Edge edge, Point a, Point b) {
        List<Point> anchors = this.edgePoints(edge);
        for (int segment = 0; segment < anchors.size() - 1; ++segment) {
            List<Point> samples = CanvasPanel.curveSamples(anchors.get(segment), anchors.get(segment + 1));
            for (int i = 1; i < samples.size(); ++i) {
                if (!Line2D.linesIntersect(a.x, a.y, b.x, b.y, samples.get((int)(i - 1)).x, samples.get((int)(i - 1)).y, samples.get((int)i).x, samples.get((int)i).y)) continue;
                return new EdgeHit(edge, segment);
            }
        }
        return null;
    }

    private List<Point> edgePoints(WorkflowModel.Edge edge) {
        WorkflowModel.Node a = this.model.byId(edge.source());
        WorkflowModel.Node b = this.model.byId(edge.target());
        if (a == null || b == null || !this.visibleNode(a) || !this.visibleNode(b)) {
            return List.of();
        }
        WorkflowModel.Port out = this.model.output(a, edge.sourcePort());
        WorkflowModel.Port in = this.model.input(b, edge.targetPort());
        if (out == null || in == null) {
            return List.of();
        }
        ArrayList<Point> points = new ArrayList<Point>();
        points.add(CanvasPanel.portCenter(this.outputPort(a, out)));
        edge.reroutes().forEach(p -> points.add(new Point(p.x, p.y)));
        points.add(CanvasPanel.portCenter(this.inputPort(b, in)));
        return points;
    }

    private static List<Point> curveSamples(Point p, Point q) {
        int handle = Math.max(35, Math.abs(q.x - p.x) / 2);
        ArrayList<Point> points = new ArrayList<Point>();
        for (int step = 0; step <= 24; ++step) {
            double t = (double)step / 24.0;
            double u = 1.0 - t;
            points.add(new Point((int)(u * u * u * (double)p.x + 3.0 * u * u * t * (double)(p.x + handle) + 3.0 * u * t * t * (double)(q.x - handle) + t * t * t * (double)q.x), (int)(u * u * u * (double)p.y + 3.0 * u * u * t * (double)p.y + 3.0 * u * t * t * (double)q.y + t * t * t * (double)q.y)));
        }
        return points;
    }

    private RerouteHit hitReroute(Point p) {
        double radius = 9.0 / this.zoom;
        for (int i = this.model.edges().size() - 1; i >= 0; --i) {
            WorkflowModel.Edge edge = this.model.edges().get(i);
            for (WorkflowModel.Reroute point : edge.reroutes()) {
                if (!(Point2D.distance(p.x, p.y, point.x, point.y) <= radius)) continue;
                return new RerouteHit(edge, point);
            }
        }
        return null;
    }

    private PortHit hitPort(Point p) {
        double radius = 12.0 / this.zoom;
        for (int i = this.model.nodes().size() - 1; i >= 0; --i) {
            WorkflowModel.Node n = this.model.nodes().get(i);
            if (!this.visibleNode(n)) continue;
            for (WorkflowModel.Port port : n.outputs) {
                if (!(CanvasPanel.portCenter(this.outputPort(n, port)).distance(p) <= radius)) continue;
                return new PortHit(n, port, true);
            }
            for (WorkflowModel.Port port : n.inputs) {
                if (!(CanvasPanel.portCenter(this.inputPort(n, port)).distance(p) <= radius)) continue;
                return new PortHit(n, port, false);
            }
        }
        return null;
    }

    private WorkflowModel.Node hitNode(Point p) {
        for (int pass = 0; pass < 2; ++pass) {
            for (int i = this.model.nodes().size() - 1; i >= 0; --i) {
                WorkflowModel.Node n = this.model.nodes().get(i);
                if (!this.visibleNode(n) || pass == 0 == CanvasPanel.isContainer(n) || !new Rectangle(n.x, n.y, this.nodeWidth(n), this.nodeHeight(n)).contains(p)) continue;
                return n;
            }
        }
        return null;
    }

    private boolean visibleNode(WorkflowModel.Node node) {
        if (node == null) {
            return false;
        }
        if (!this.groupFocusId.isBlank() && !node.parentScopeId.equals(this.groupFocusId)) {
            return false;
        }
        return !this.hiddenByAncestor(node, new HashSet<String>());
    }

    private boolean hiddenByAncestor(WorkflowModel.Node node, Set<String> seen) {
        WorkflowModel.Node file;
        if (node == null || !seen.add(node.id)) {
            return false;
        }
        WorkflowModel.Node parent = node.parentScopeId.isBlank() ? null : this.model.byId(node.parentScopeId);
        WorkflowModel.Node node2 = file = node.fileNodeId.isBlank() ? null : this.model.byId(node.fileNodeId);
        if (parent != null && parent.nodeKind == WorkflowModel.NodeKind.GROUP && !node.parentScopeId.equals(this.groupFocusId)) {
            return true;
        }
        return parent != null && (parent.collapsed || this.hiddenByAncestor(parent, seen)) || file != null && (file.collapsed || this.hiddenByAncestor(file, seen));
    }

    private Rectangle box() {
        int x = Math.min(this.boxStart.x, this.boxCurrent.x);
        int y = Math.min(this.boxStart.y, this.boxCurrent.y);
        return new Rectangle(x, y, Math.abs(this.boxCurrent.x - this.boxStart.x), Math.abs(this.boxCurrent.y - this.boxStart.y));
    }

    private int nodeWidth(WorkflowModel.Node n) {
        if (!n.collapsed && !CanvasPanel.isContainer(n) && n.detailMode && this.hasPrompt(n)) {
            int w = this.detailPromptWidth(n);
            int maxPortLen = w < 160 ? w / 9 : 20;
            for (WorkflowModel.Port p : n.inputs) {
                maxPortLen = Math.max(maxPortLen, p.name.length() + p.dataType.length() + 4);
            }
            for (WorkflowModel.Port p : n.outputs) {
                maxPortLen = Math.max(maxPortLen, p.name.length() + p.dataType.length() + 4);
            }
            return Math.max(w, Math.max(140, 50 + maxPortLen * 7));
        }
        int w = !n.collapsed && CanvasPanel.isContainer(n) ? Math.max(320, n.containerWidth) : Math.max(140, n.nodeWidth);
        int maxPortLen = w < 160 ? w / 9 : 20;
        for (WorkflowModel.Port p : n.inputs) {
            maxPortLen = Math.max(maxPortLen, p.name.length() + p.dataType.length() + 4);
        }
        for (WorkflowModel.Port p : n.outputs) {
            maxPortLen = Math.max(maxPortLen, p.name.length() + p.dataType.length() + 4);
        }
        return Math.max(w, Math.max(140, 50 + maxPortLen * 7));
    }

    private int nodeHeight(WorkflowModel.Node n) {
        if (n.collapsed) {
            return 36;
        }
        if (n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE && !n.bundleCollapsed) {
            int body = 34 + this.bundlePreviewOffset(n) + Math.max(2, n.inputs.size()) * 22 + 28;
            return Math.max(240, Math.max(220, body));
        }
        if (CanvasPanel.isContainer(n)) {
            return Math.max(220, n.containerHeight);
        }
        if (n.detailMode && this.hasPrompt(n)) {
            return this.detailPromptHeight(n);
        }
        int base = Math.max(92, n.nodeHeight);
        int ports = Math.max(n.inputs.size(), n.outputs.size()) * 22 + 28;
        return Math.max(base, 34 + ports);
    }

    private int portY(WorkflowModel.Node n, int index) {
        int base = n.y + 34 + 14;
        if (n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE && !n.bundleCollapsed) {
            base += this.bundlePreviewOffset(n);
        }
        if (n.detailMode && !n.collapsed && !CanvasPanel.isContainer(n) && this.hasPrompt(n)) {
            base += this.promptAreaHeight(n) + 6;
        }
        return base + index * 22;
    }

    private boolean hasPrompt(WorkflowModel.Node n) {
        return n.prompt != null && !n.prompt.isBlank();
    }

    private BundleDataUtil.BundleView bundleView(WorkflowModel.Node n) {
        BundleDataUtil.BundleView parsed;
        String key = n.id + "|" + n.bundleData;
        BundleDataUtil.BundleView cached = this.bundleViewCache.get(key);
        if (cached != null) {
            return cached;
        }
        BundleDataUtil.BundleView view = n.bundleData == null || n.bundleData.isBlank() ? new BundleDataUtil.BundleView(1, 0, Map.of(), "", List.of()) : ((parsed = BundleDataUtil.parseV2(n.bundleData)).schemaVersion() != 2 ? BundleDataUtil.downgradeV1(n.bundleData) : parsed);
        this.bundleViewCache.put(key, view);
        return view;
    }

    private int bundlePreviewOffset(WorkflowModel.Node n) {
        if (n.nodeKind != WorkflowModel.NodeKind.ASSET_BUNDLE || n.bundleCollapsed) {
            return 0;
        }
        return Math.min(8, this.bundleView(n).members().size()) * 14 + 64;
    }

    private FontMetrics detailMetrics() {
        return this.getFontMetrics(this.getFont().deriveFont(12.0f));
    }

    private int detailPromptWidth(WorkflowModel.Node n) {
        FontMetrics fm = this.detailMetrics();
        List<String> lines = this.wrapPrompt(n.prompt, 0x3FFFFFFF, fm);
        int maxLine = 0;
        for (String line : lines) {
            maxLine = Math.max(maxLine, fm.stringWidth(line));
        }
        return Math.min(420, Math.max(215, maxLine + 24));
    }

    private int detailPromptHeight(WorkflowModel.Node n) {
        int w = this.nodeWidth(n);
        FontMetrics fm = this.detailMetrics();
        List<String> lines = this.wrapPrompt(n.prompt, w - 24, fm);
        int portsArea = Math.max(n.inputs.size(), n.outputs.size()) * 22 + 28;
        int maxTextArea = 280 - portsArea - 4;
        int visible = Math.max(1, maxTextArea / 17);
        int textArea = Math.min(visible, lines.size()) * 17;
        return Math.min(320, Math.max(130, 40 + textArea + portsArea + 4));
    }

    private int promptAreaHeight(WorkflowModel.Node n) {
        int w = this.nodeWidth(n);
        FontMetrics fm = this.detailMetrics();
        List<String> lines = this.wrapPrompt(n.prompt, w - 24, fm);
        int portsArea = Math.max(n.inputs.size(), n.outputs.size()) * 22 + 28;
        int maxTextArea = 280 - portsArea - 4;
        int visible = Math.max(1, maxTextArea / 17);
        return Math.min(visible, lines.size()) * 17;
    }

    private List<String> wrapPrompt(String text, int targetWidth, FontMetrics fm) {
        ArrayList<String> lines = new ArrayList<String>();
        String[] paragraphs = text.split("\n", -1);
        for (int p = 0; p < paragraphs.length; ++p) {
            StringBuilder current = new StringBuilder();
            for (String word : paragraphs[p].split(" ", -1)) {
                if (word.isEmpty()) {
                    if (current.length() <= 0) continue;
                    current.append(' ');
                    continue;
                }
                if (current.length() == 0) {
                    if (fm.stringWidth(word) <= targetWidth) {
                        current.append(word);
                        continue;
                    }
                    this.breakLongWord(current, word, targetWidth, fm, lines);
                    continue;
                }
                String candidate = String.valueOf(current) + " " + word;
                if (fm.stringWidth(candidate) <= targetWidth) {
                    current.setLength(0);
                    current.append(candidate);
                    continue;
                }
                lines.add(current.toString());
                current.setLength(0);
                if (fm.stringWidth(word) <= targetWidth) {
                    current.append(word);
                    continue;
                }
                this.breakLongWord(current, word, targetWidth, fm, lines);
            }
            lines.add(current.toString());
            if (p >= paragraphs.length - 1) continue;
            lines.add("");
        }
        return lines;
    }

    private void breakLongWord(StringBuilder current, String word, int targetWidth, FontMetrics fm, List<String> lines) {
        int idx = 0;
        while (idx < word.length()) {
            int end;
            for (end = idx + 1; end <= word.length() && fm.stringWidth(word.substring(idx, end)) <= targetWidth; ++end) {
            }
            if (--end < idx + 1) {
                end = idx + 1;
            }
            String piece = word.substring(idx, end);
            if (current.length() == 0) {
                current.append(piece);
            } else {
                lines.add(current.toString());
                current.setLength(0);
                current.append(piece);
            }
            idx = end;
        }
    }

    private Ellipse2D inputPort(WorkflowModel.Node n, WorkflowModel.Port p) {
        int i = Math.max(0, n.inputs.indexOf(p));
        int y = n.collapsed ? n.y + 17 : this.portY(n, i);
        return new Ellipse2D.Double(n.x - 6, y - 6, 12.0, 12.0);
    }

    private Ellipse2D outputPort(WorkflowModel.Node n, WorkflowModel.Port p) {
        int i = Math.max(0, n.outputs.indexOf(p));
        int y = n.collapsed ? n.y + 17 : this.portY(n, i);
        return new Ellipse2D.Double(n.x + this.nodeWidth(n) - 6, y - 6, 12.0, 12.0);
    }

    private Point world(Point screen) {
        return new Point((int)Math.round((double)(screen.x - this.panX) / this.zoom), (int)Math.round((double)(screen.y - this.panY) / this.zoom));
    }

    private static Point portCenter(Ellipse2D port) {
        return new Point((int)port.getCenterX(), (int)port.getCenterY());
    }

    private static Color portColor(WorkflowModel.Port p) {
        String type = p.dataType.toLowerCase(Locale.ROOT);
        if (type.startsWith("array") || type.contains("vector") || type.equals("normal") || type.equals("color")) {
            return new Color(142, 105, 205);
        }
        return switch (type) {
            case "int", "integer", "float", "double", "number" -> new Color(90, 145, 205);
            case "boolean", "bool" -> new Color(210, 100, 145);
            case "string" -> new Color(105, 160, 115);
            default -> new Color(150, 155, 165);
        };
    }

    private static Color categoryColor(WorkflowModel.Node node) {
        if (!node.nodeColor.isBlank()) {
            try {
                if (node.nodeColor.startsWith("#")) {
                    return Color.decode(node.nodeColor);
                }
            }
            catch (Exception exception) {
                // empty catch block
            }
        }
        if (node.composite) {
            return new Color(65, 65, 72);
        }
        if (node.classificationKey.startsWith("asset.")) {
            return switch (node.assetType) {
                case "image", "texture" -> new Color(140, 60, 100);
                case "model" -> new Color(50, 120, 140);
                case "animation" -> new Color(160, 80, 40);
                case "particle" -> new Color(120, 40, 160);
                case "language" -> new Color(40, 120, 85);
                case "audio" -> new Color(60, 80, 160);
                case "video" -> new Color(160, 40, 60);
                default -> new Color(90, 85, 80);
            };
        }
        return switch (node.classificationKey) {
            case "value.scalar", "calculation.scalar" -> new Color(63, 111, 168);
            case "value.vector", "value.array", "calculation.vector" -> new Color(118, 81, 168);
            case "value.boolean", "calculation.boolean" -> new Color(182, 78, 122);
            case "scope.flow" -> new Color(167, 101, 50);
            case "scope.group" -> new Color(100, 95, 140);
            case "file.source" -> new Color(40, 122, 120);
            case "text.string" -> new Color(79, 125, 87);
            case "io.input", "io.output", "io.group-output", "io.group-input" -> new Color(47, 125, 140);
            case "io.capture" -> new Color(160, 90, 45);
            case "agent.custom" -> new Color(138, 116, 64);
            default -> {
                switch (node.category.toLowerCase(Locale.ROOT)) {
                    case "java": {
                        yield new Color(125, 82, 42);
                    }
                    case "powershell": {
                        yield new Color(45, 82, 125);
                    }
                    case "go": {
                        yield new Color(38, 105, 118);
                    }
                    case "输入": 
                    case "输入与解析": {
                        yield new Color(55, 95, 105);
                    }
                }
                yield new Color(92, 99, 112);
            }
        };
    }

    private static String statusLabel(WorkflowModel.Status status) {
        return switch (status) {
            default -> throw new MatchException(null, null);
            case WorkflowModel.Status.IDLE -> "空闲";
            case WorkflowModel.Status.QUEUED -> "已排队";
            case WorkflowModel.Status.PROCESSING -> "制作中";
            case WorkflowModel.Status.REVIEW_READY -> "待审查";
            case WorkflowModel.Status.ACCEPTED -> "已接受";
            case WorkflowModel.Status.SUCCEEDED -> "成功";
            case WorkflowModel.Status.FAILED -> "失败";
            case WorkflowModel.Status.CANCELLED -> "已取消";
            case WorkflowModel.Status.REJECTED -> "已拒绝";
            case WorkflowModel.Status.CONFLICTED -> "版本冲突";
        };
    }

    private static double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }

    private static double mod(double value, double divisor) {
        double result = value % divisor;
        return result < 0.0 ? result + divisor : result;
    }

    private static String trim(String text, int max) {
        return text.length() <= max ? text : text.substring(0, max - 1) + "…";
    }

    private static enum SelectionMode {
        REPLACE,
        ADD,
        SUBTRACT;

    }

    private record EdgeHit(WorkflowModel.Edge edge, int segmentIndex) {
    }

    private record RerouteOrigin(WorkflowModel.Edge edge, WorkflowModel.Reroute anchor) {
    }

    private record RerouteHit(WorkflowModel.Edge edge, WorkflowModel.Reroute point) {
    }

    private record PortHit(WorkflowModel.Node node, WorkflowModel.Port port, boolean output) {
    }
}
