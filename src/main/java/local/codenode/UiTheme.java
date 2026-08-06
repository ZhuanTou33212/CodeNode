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
    public static void styleSplit(JSplitPane split){
        split.setUI(new BasicSplitPaneUI(){@Override public BasicSplitPaneDivider createDefaultDivider(){BasicSplitPaneDivider divider=super.createDefaultDivider();divider.setBackground(BORDER);divider.setBorder(null);return divider;}});
        split.setBackground(BORDER);split.setBorder(null);split.setDividerSize(3);split.setContinuousLayout(true);
    }
}
