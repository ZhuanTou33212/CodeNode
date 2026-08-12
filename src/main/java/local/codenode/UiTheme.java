package local.codenode;

import javax.swing.*;
import javax.swing.border.*;
import javax.swing.text.JTextComponent;
import javax.swing.plaf.basic.BasicScrollBarUI;
import javax.swing.plaf.basic.BasicSplitPaneDivider;
import javax.swing.plaf.basic.BasicSplitPaneUI;
import java.awt.*;

public final class UiTheme {
    public static final Color BACKGROUND = new Color(20, 22, 26);
    public static final Color PANEL = new Color(29, 32, 38);
    public static final Color TOOLBAR = new Color(25, 28, 33);
    public static final Color INPUT = new Color(38, 42, 49);
    public static final Color BORDER = new Color(58, 64, 74);
    public static final Color TEXT = new Color(238, 237, 233);
    public static final Color MUTED = new Color(153, 160, 171);
    public static final Color ACCENT = new Color(224, 146, 78);
    public static final Color SELECTION = new Color(91, 66, 45);
    public static final Color CANVAS_GRID = new Color(31, 35, 42);
    public static final Color CANVAS_GRID_MAJOR = new Color(47, 53, 63);

    private UiTheme() {}

    public static void install() {
        UIManager.put("control", PANEL);
        UIManager.put("info", PANEL);
        UIManager.put("nimbusBase", new Color(55, 61, 70));
        UIManager.put("nimbusLightBackground", INPUT);
        UIManager.put("text", TEXT);
        UIManager.put("textText", TEXT);
        UIManager.put("Menu.background", TOOLBAR);UIManager.put("Menu.foreground", TEXT);UIManager.put("Menu.selectionBackground", SELECTION);UIManager.put("Menu.selectionForeground", TEXT);
        UIManager.put("MenuItem.background", PANEL);UIManager.put("MenuItem.foreground", TEXT);UIManager.put("MenuItem.selectionBackground", SELECTION);UIManager.put("MenuItem.selectionForeground", TEXT);
        UIManager.put("PopupMenu.background", PANEL);UIManager.put("PopupMenu.foreground", TEXT);UIManager.put("PopupMenu.border", new LineBorder(BORDER));
        UIManager.put("ToolTip.background", PANEL);
        UIManager.put("ToolTip.foreground", TEXT);
        UIManager.put("ToolTip.border", new LineBorder(BORDER));
        UIManager.put("ScrollBar.thumb", Color.WHITE);
        UIManager.put("ScrollBar.track", BACKGROUND);
        UIManager.put("ScrollBar.width", 8);
    }

    public static void apply(Component component) {
        Font systemFont = UIManager.getFont("Label.font");
        component.setFont((systemFont == null ? component.getFont() : systemFont).deriveFont(Font.PLAIN, 13f));
        component.setForeground(TEXT);
        if (component instanceof JMenuBar bar) { bar.setBackground(TOOLBAR); bar.setOpaque(true); }
        else if (component instanceof JMenuItem item) { item.setBackground(TOOLBAR); item.setForeground(TEXT); item.setOpaque(true); }
        else if (component instanceof JPopupMenu popup) { popup.setBackground(PANEL); popup.setBorder(new LineBorder(BORDER)); }
        else if (component instanceof JPanel panel && !(component instanceof CanvasPanel)) panel.setBackground(PANEL);
        if (component instanceof JTextComponent text) {
            text.setBackground(INPUT); text.setForeground(TEXT); text.setCaretColor(TEXT);
            text.setSelectionColor(SELECTION); text.setSelectedTextColor(TEXT);
            text.setBorder(new CompoundBorder(new LineBorder(BORDER, 1, true), new EmptyBorder(6, 9, 6, 9)));
        } else if (component instanceof JButton button) {
            button.setBackground(TOOLBAR); button.setForeground(TEXT); button.setFocusPainted(false); button.setOpaque(false); button.setContentAreaFilled(false);
            button.setRolloverEnabled(true);
            button.setBorder(new EmptyBorder(7, 11, 7, 11));
            button.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            if (button.getClientProperty("apple-feedback-installed") == null) {
                button.putClientProperty("apple-feedback-installed", Boolean.TRUE);
                button.addChangeListener(event -> {
                    ButtonModel model = button.getModel();
                    boolean active = model.isPressed() || model.isRollover(); button.setOpaque(active); button.setContentAreaFilled(active); button.setBackground(model.isPressed() ? SELECTION : INPUT); button.setForeground(model.isPressed() ? ACCENT : TEXT);
                });
            }
        } else if (component instanceof JComboBox<?> combo) {
            combo.setBackground(INPUT); combo.setForeground(TEXT); combo.setBorder(new LineBorder(BORDER));
        } else if (component instanceof JTable table) {
            table.setBackground(INPUT);table.setForeground(TEXT);table.setGridColor(BORDER);table.setSelectionBackground(SELECTION);table.setSelectionForeground(TEXT);table.getTableHeader().setBackground(TOOLBAR);table.getTableHeader().setForeground(TEXT);
        } else if (component instanceof JList<?> list) {
            list.setBackground(INPUT);list.setForeground(TEXT);list.setSelectionBackground(SELECTION);list.setSelectionForeground(TEXT);list.setBorder(new EmptyBorder(4,6,4,6));
        } else if (component instanceof JScrollPane scroll) {
            scroll.getViewport().setBackground(PANEL); scroll.setBorder(null);
        } else if (component instanceof JSplitPane split) {
            styleSplit(split);
        } else if (component instanceof JTabbedPane tabs) {
            tabs.setBackground(PANEL); tabs.setForeground(TEXT); tabs.setBorder(null); tabs.setOpaque(true);
        } else if (component instanceof JScrollBar bar) {
            bar.setUI(new BasicScrollBarUI(){
                @Override protected void configureScrollBarColors(){thumbColor=Color.WHITE;thumbHighlightColor=Color.WHITE;thumbDarkShadowColor=Color.WHITE;trackColor=BACKGROUND;trackHighlightColor=BACKGROUND;}
                @Override protected JButton createDecreaseButton(int orientation){return zeroButton();}
                @Override protected JButton createIncreaseButton(int orientation){return zeroButton();}
                private JButton zeroButton(){JButton button=new JButton();button.setPreferredSize(new Dimension(0,0));button.setMinimumSize(new Dimension(0,0));button.setMaximumSize(new Dimension(0,0));return button;}
            });
            bar.setPreferredSize(new Dimension(10,10));
        }
        if (component instanceof Container container) for (Component child : container.getComponents()) apply(child);
        if (component instanceof JMenu menu) apply(menu.getPopupMenu());
    }

    public static Border panelBorder() { return new LineBorder(BORDER, 1, true); }
    public static Border sectionBorder() { return new CompoundBorder(new MatteBorder(0, 0, 1, 0, BORDER), new EmptyBorder(9, 12, 9, 12)); }
    /** 统一样式并确保 divider 可拖拽：自定义 MouseAdapter 手动更新 divider 位置，
     *  用 consume() 阻止默认 divider 拖拽干扰（避免双重更新导致回弹）。 */
    public static void styleSplit(JSplitPane split){
        split.setBackground(BORDER);
        split.setBorder(null);
        split.setDividerSize(8);
        split.setContinuousLayout(false);
        final boolean horizontal = split.getOrientation() == JSplitPane.HORIZONTAL_SPLIT;
        final int[] press = {-1};
        java.awt.event.MouseAdapter drag = new java.awt.event.MouseAdapter() {
            @Override public void mousePressed(java.awt.event.MouseEvent e) {
                if (e.getButton() == java.awt.event.MouseEvent.BUTTON1) {
                    press[0] = horizontal ? e.getXOnScreen() : e.getYOnScreen();
                }
            }
            @Override public void mouseDragged(java.awt.event.MouseEvent e) {
                if (press[0] < 0) return;
                Point splitLoc = split.getLocationOnScreen();
                int current = horizontal ? e.getXOnScreen() - splitLoc.x : e.getYOnScreen() - splitLoc.y;
                int max = horizontal ? split.getWidth() : split.getHeight();
                split.setDividerLocation(Math.max(20, Math.min(max - 20, current)));
                split.revalidate();
                split.repaint();
            }
            @Override public void mouseReleased(java.awt.event.MouseEvent e) {
                press[0] = -1;
            }
        };
        Component div = dividerOf(split);
        if (div != null) {
            bindCustomDrag(split, div, drag);
        } else {
            SwingUtilities.invokeLater(() -> {
                Component d = dividerOf(split);
                if (d != null) bindCustomDrag(split, d, drag);
            });
        }
    }

    /** 移除默认 divider 拖拽监听（避免与自定义冲突回弹），再绑定自定义拖拽。 */
    private static void bindCustomDrag(JSplitPane split, Component div, java.awt.event.MouseAdapter drag) {
        for (java.awt.event.MouseListener l : div.getMouseListeners()) {
            div.removeMouseListener(l);
        }
        for (java.awt.event.MouseMotionListener l : div.getMouseMotionListeners()) {
            div.removeMouseMotionListener(l);
        }
        div.addMouseListener(drag);
        div.addMouseMotionListener(drag);
        div.setBackground(new Color(197, 179, 143));
        div.setForeground(new Color(197, 179, 143));
    }

    /** 获取 JSplitPane 的 divider（通过 BasicSplitPaneUI）。 */
    private static Component dividerOf(JSplitPane split) {
        javax.swing.plaf.SplitPaneUI ui = split.getUI();
        if (ui instanceof BasicSplitPaneUI basic) {
            return basic.getDivider();
        }
        return null;
    }

    /** Vertical content that always adopts the viewport width instead of clipping off-screen. */
    public static final class VerticalScrollPanel extends JPanel implements Scrollable {
        @Override public Dimension getPreferredScrollableViewportSize() { return getPreferredSize(); }
        @Override public int getScrollableUnitIncrement(Rectangle visibleRect, int orientation, int direction) { return 24; }
        @Override public int getScrollableBlockIncrement(Rectangle visibleRect, int orientation, int direction) { return Math.max(48, visibleRect.height - 32); }
        @Override public boolean getScrollableTracksViewportWidth() { return true; }
        @Override public boolean getScrollableTracksViewportHeight() { return false; }
    }

    /** A wrap panel that updates its own height whenever its assigned width changes. */
    public static final class ResponsiveWrapPanel extends JPanel {
        private int responsiveHeight = -1;
        private int lastWidth = -1;
        private boolean updatePending;

        public ResponsiveWrapPanel(int align, int hgap, int vgap) {
            super(new WrapLayout(align, hgap, vgap));
        }

        @Override public void setBounds(int x, int y, int width, int height) {
            super.setBounds(x, y, width, height);
            if (width <= 0 || width == lastWidth || updatePending) return;
            lastWidth = width;
            updatePending = true;
            SwingUtilities.invokeLater(() -> {
                updatePending = false;
                Dimension measured = getLayout().preferredLayoutSize(this);
                if (measured.height != responsiveHeight) {
                    responsiveHeight = measured.height;
                    revalidate();
                    if (getParent() != null) getParent().revalidate();
                }
            });
        }

        @Override public Dimension getPreferredSize() {
            Dimension size = super.getPreferredSize();
            if (responsiveHeight > 0) size.height = responsiveHeight;
            size.width = 0;
            return size;
        }

        @Override public Dimension getMinimumSize() {
            Dimension size = getPreferredSize();
            size.width = 0;
            return size;
        }
    }

    /** Flow layout that wraps controls instead of forcing a toolbar wider than the window. */
    public static final class WrapLayout extends FlowLayout {
        public WrapLayout(int align, int hgap, int vgap) { super(align, hgap, vgap); }
        @Override public Dimension preferredLayoutSize(Container target) { return layoutSize(target, true); }
        @Override public Dimension minimumLayoutSize(Container target) {
            Dimension size = layoutSize(target, false);
            size.width = Math.max(0, size.width - getHgap() - 1);
            return size;
        }
        private Dimension layoutSize(Container target, boolean preferred) {
            synchronized (target.getTreeLock()) {
                Insets insets = target.getInsets();
                int width = target.getWidth() > 0 ? target.getWidth() : Integer.MAX_VALUE;
                int maxWidth = Math.max(0, width - insets.left - insets.right - getHgap() * 2);
                int rowWidth = 0, rowHeight = 0, totalWidth = 0;
                int totalHeight = insets.top + insets.bottom + getVgap() * 2;
                for (Component component : target.getComponents()) {
                    if (!component.isVisible()) continue;
                    Dimension size = preferred ? component.getPreferredSize() : component.getMinimumSize();
                    if (rowWidth > 0 && rowWidth + getHgap() + size.width > maxWidth) {
                        totalWidth = Math.max(totalWidth, rowWidth);
                        totalHeight += rowHeight + getVgap();
                        rowWidth = 0; rowHeight = 0;
                    }
                    rowWidth += (rowWidth == 0 ? 0 : getHgap()) + size.width;
                    rowHeight = Math.max(rowHeight, size.height);
                }
                totalWidth = Math.max(totalWidth, rowWidth);
                totalHeight += rowHeight;
                return new Dimension(totalWidth + insets.left + insets.right + getHgap() * 2, totalHeight);
            }
        }
    }
}
