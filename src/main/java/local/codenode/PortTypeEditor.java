package local.codenode;

import javax.swing.*;
import javax.swing.table.TableCellEditor;
import java.awt.*;
import java.util.List;

public class PortTypeEditor extends AbstractCellEditor implements TableCellEditor {
    private static final List<Group> GROUPS = List.of(
        new Group("数值", List.of("integer","float","number","double","decimal")),
        new Group("文本", List.of("string","markdown","text","char")),
        new Group("数组", List.of("array","vector","map","set","list")),
        new Group("对象", List.of("any","object","json")),
        new Group("文件", List.of("image","audio","video","model","texture","pdf","word","excel","txt")),
        new Group("其他", List.of())
    );

    private final JComboBox<String> combo = new JComboBox<>();
    private String value = "any";

    public PortTypeEditor() {
        DefaultComboBoxModel<String> model = new DefaultComboBoxModel<>();
        for (Group g : GROUPS) {
            model.addElement("▸ " + g.name);
            for (String t : g.types) model.addElement("  " + t);
        }
        combo.setModel(model);
        combo.setRenderer(new DefaultListCellRenderer() {
            @Override
            public Component getListCellRendererComponent(JList<?> list, Object val, int index,
                    boolean isSelected, boolean cellHasFocus) {
                String text = String.valueOf(val);
                if (text.startsWith("▸")) {
                    JLabel lb = (JLabel) super.getListCellRendererComponent(list, text, index, isSelected, cellHasFocus);
                    lb.setFont(lb.getFont().deriveFont(Font.BOLD));
                    lb.setForeground(isSelected ? Color.WHITE : new Color(86, 156, 214));
                    return lb;
                }
                return super.getListCellRendererComponent(list, text.trim(), index, isSelected, cellHasFocus);
            }
        });
        combo.addActionListener(e -> {
            String sel = (String) combo.getSelectedItem();
            if (sel == null) return;
            if (sel.startsWith("▸")) {
                if (sel.contains("其他")) {
                    String input = JOptionPane.showInputDialog(null, "请输入自定义端口类型名称:", value);
                    if (input != null && !input.trim().isBlank()) {
                        value = input.trim().toLowerCase();
                    } else {
                        combo.setSelectedIndex(-1);
                        return;
                    }
                } else {
                    combo.setSelectedIndex(-1);
                    return;
                }
            } else {
                value = sel.trim();
            }
            fireEditingStopped();
        });
    }

    @Override
    public Component getTableCellEditorComponent(JTable table, Object val, boolean isSelected, int row, int col) {
        value = String.valueOf(val);
        combo.setSelectedIndex(-1);
        return combo;
    }

    @Override
    public Object getCellEditorValue() { return value; }

    private record Group(String name, List<String> types) {}
}
