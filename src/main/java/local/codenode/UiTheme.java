package local.codenode;

import javax.swing.*;
import javax.swing.border.*;
import javax.swing.text.JTextComponent;
import javax.swing.plaf.basic.BasicScrollBarUI;
import javax.swing.plaf.basic.BasicSplitPaneDivider;
import javax.swing.plaf.basic.BasicSplitPaneUI;
import java.awt.*;

public final class UiTheme {
    public static final Color BACKGROUND = new Color(30, 30, 30);
    public static final Color PANEL = new Color(37, 37, 38);
    public static final Color TOOLBAR = new Color(42, 45, 50);
    public static final Color INPUT = new Color(51, 51, 55);
    public static final Color BORDER = new Color(63, 63, 70);
    public static final Color TEXT = new Color(220, 220, 220);
    public static final Color MUTED = new Color(155, 164, 175);
    public static final Color ACCENT = new Color(0, 122, 204);
    public static final Color SELECTION = new Color(9, 71, 113);

    private UiTheme() {}

    public static void install() {
        UIManager.put("control", PANEL);
        UIManager.put("info", PANEL);
        UIManager.put("nimbusBase", TOOLBAR);
        UIManager.put("nimbusLightBackground", INPUT);
        UIManager.put("text", TEXT);
        UIManager.put("textText", TEXT);
        UIManager.put("Menu.background", TOOLBAR);UIManager.put("Menu.foreground", TEXT);UIManager.put("Menu.selectionBackground", SELECTION);UIManager.put("Menu.selectionForeground", Color.WHITE);
        UIManager.put("MenuItem.background", PANEL);UIManager.put("MenuItem.foreground", TEXT);UIManager.put("MenuItem.selectionBackground", SELECTION);UIManager.put("MenuItem.selectionForeground", Color.WHITE);
        UIManager.put("PopupMenu.background", PANEL);UIManager.put("PopupMenu.foreground", TEXT);UIManager.put("PopupMenu.border", new LineBorder(BORDER));
        UIManager.put("ToolTip.background", INPUT);
        UIManager.put("ToolTip.foreground", TEXT);
        UIManager.put("ToolTip.border", new LineBorder(BORDER));
        UIManager.put("ScrollBar.thumb", new Color(92, 92, 96));
        UIManager.put("ScrollBar.track", PANEL);
    }

    public static void apply(Component component) {
        component.setFont(new Font("Microsoft YaHei UI", Font.PLAIN, 13));
        component.setForeground(TEXT);
        if (component instanceof JMenuBar bar) { bar.setBackground(TOOLBAR); bar.setOpaque(true); }
        else if (component instanceof JMenuItem item) { item.setBackground(TOOLBAR); item.setForeground(TEXT); item.setOpaque(true); }
        else if (component instanceof JPopupMenu popup) { popup.setBackground(PANEL); popup.setBorder(new LineBorder(BORDER)); }
        else if (component instanceof JPanel panel && !(component instanceof CanvasPanel)) panel.setBackground(PANEL);
        if (component instanceof JTextComponent text) {
            text.setBackground(INPUT); text.setForeground(TEXT); text.setCaretColor(TEXT);
            text.setSelectionColor(SELECTION); text.setSelectedTextColor(Color.WHITE);
            text.setBorder(new CompoundBorder(new LineBorder(BORDER), new EmptyBorder(5, 7, 5, 7)));
        } else if (component instanceof JButton button) {
            button.setBackground(TOOLBAR); button.setForeground(TEXT); button.setFocusPainted(false); button.setOpaque(true);
            button.setBorder(new CompoundBorder(new LineBorder(BORDER), new EmptyBorder(5, 10, 5, 10)));
        } else if (component instanceof JComboBox<?> combo) {
            combo.setBackground(INPUT); combo.setForeground(TEXT); combo.setBorder(new LineBorder(BORDER));
        } else if (component instanceof JTable table) {
            table.setBackground(INPUT);table.setForeground(TEXT);table.setGridColor(BORDER);table.setSelectionBackground(SELECTION);table.setSelectionForeground(Color.WHITE);table.getTableHeader().setBackground(TOOLBAR);table.getTableHeader().setForeground(TEXT);
        } else if (component instanceof JList<?> list) {
            list.setBackground(INPUT);list.setForeground(TEXT);list.setSelectionBackground(SELECTION);list.setSelectionForeground(Color.WHITE);list.setBorder(new EmptyBorder(4,6,4,6));
        } else if (component instanceof JScrollPane scroll) {
            scroll.getViewport().setBackground(BACKGROUND); scroll.setBorder(new LineBorder(BORDER));
        } else if (component instanceof JSplitPane split) {
            styleSplit(split);
        } else if (component instanceof JTabbedPane tabs) {
            tabs.setBackground(PANEL); tabs.setForeground(TEXT); tabs.setBorder(new LineBorder(BORDER));
        } else if (component instanceof JScrollBar bar) {
            bar.setUI(new BasicScrollBarUI(){
                @Override protected void configureScrollBarColors(){thumbColor=new Color(82,82,86);trackColor=PANEL;}
                @Override protected JButton createDecreaseButton(int orientation){return zeroButton();}
                @Override protected JButton createIncreaseButton(int orientation){return zeroButton();}
                private JButton zeroButton(){JButton button=new JButton();button.setPreferredSize(new Dimension(0,0));button.setMinimumSize(new Dimension(0,0));button.setMaximumSize(new Dimension(0,0));return button;}
            });
            bar.setPreferredSize(new Dimension(10,10));
        }
        if (component instanceof Container container) for (Component child : container.getComponents()) apply(child);
        if (component instanceof JMenu menu) apply(menu.getPopupMenu());
    }

    public static Border panelBorder() { return new LineBorder(BORDER); }
    public static Border sectionBorder() { return new CompoundBorder(new MatteBorder(0, 0, 1, 0, BORDER), new EmptyBorder(7, 10, 7, 10)); }
    /** 统一样式并确保 divider 可拖拽：自定义 MouseAdapter 手动更新 divider 位置，
     *  用 consume() 阻止默认 divider 拖拽干扰（避免双重更新导致回弹）。 */
    public static void styleSplit(JSplitPane split){
        split.setBackground(BORDER);
        split.setBorder(null);
        split.setDividerSize(12);
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
        div.setBackground(BORDER);
        div.setForeground(BORDER);
    }

    /** 获取 JSplitPane 的 divider（通过 BasicSplitPaneUI）。 */
    private static Component dividerOf(JSplitPane split) {
        javax.swing.plaf.SplitPaneUI ui = split.getUI();
        if (ui instanceof BasicSplitPaneUI basic) {
            return basic.getDivider();
        }
        return null;
    }
}
