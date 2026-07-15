package local.codenode;

import javax.swing.table.AbstractTableModel;
import java.util.*;

final class PortTableModel extends AbstractTableModel {
    private static final String[] COLUMNS={"方向","名称","类型","必需"};
    private WorkflowModel.Node node;
    void setNode(WorkflowModel.Node node){this.node=node;fireTableDataChanged();}
    WorkflowModel.Port portAt(int row){if(node==null||row<0||row>=getRowCount())return null;return row<node.inputs.size()?node.inputs.get(row):node.outputs.get(row-node.inputs.size());}
    boolean outputAt(int row){return node!=null&&row>=node.inputs.size();}
    @Override public int getRowCount(){return node==null?0:node.inputs.size()+node.outputs.size();}
    @Override public int getColumnCount(){return COLUMNS.length;}
    @Override public String getColumnName(int column){return COLUMNS[column];}
    @Override public Class<?> getColumnClass(int column){return column==3?Boolean.class:String.class;}
    @Override public boolean isCellEditable(int row,int column){return column>0;}
    @Override public Object getValueAt(int row,int column){WorkflowModel.Port port=portAt(row);return switch(column){case 0->outputAt(row)?"输出":"输入";case 1->port.name;case 2->port.dataType;case 3->port.required;default->"";};}
    @Override public void setValueAt(Object value,int row,int column){WorkflowModel.Port port=portAt(row);if(port==null)return;switch(column){case 1->port.name=String.valueOf(value).trim();case 2->port.dataType=String.valueOf(value).trim();case 3->port.required=Boolean.TRUE.equals(value);default->{}}fireTableRowsUpdated(row,row);}
}
