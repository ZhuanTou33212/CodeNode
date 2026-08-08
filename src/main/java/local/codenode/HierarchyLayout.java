package local.codenode;

import java.util.ArrayList;
import java.util.List;

/**
 * Stage4.5 全量扫描的嵌套组布局（Blender 节点组风格）：
 * 顶层组在画布上保持紧凑尺寸（只含标题与组输入/组输出端口列），
 * 组内子内容（子组/文件/资产）在组坐标区域内相对布局、互不重叠；
 * 进入组视图时即可看到内部内容。组容器尺寸固定，不因内部内容多少而膨胀，
 * 避免大量节点导致画布渲染到巨幅尺寸。
 */
public final class HierarchyLayout {

    /** 组节点在画布上的固定尺寸。 */
    private static final int GROUP_WIDTH = 280;
    private static final int GROUP_HEIGHT = 150;

    private HierarchyLayout() {}

    public static void layout(WorkflowModel model) {
        if (model == null) return;
        List<WorkflowModel.Node> roots = new ArrayList<>();
        for (WorkflowModel.Node node : model.nodes()) {
            if (node.nodeKind != WorkflowModel.NodeKind.GROUP) continue;
            boolean isFolder = node.role != null && node.role.equals("folder");
            boolean topLevel = node.parentScopeId == null || node.parentScopeId.isBlank();
            if (isFolder && topLevel) roots.add(node);
        }
        if (roots.isEmpty()) {
            for (WorkflowModel.Node node : model.nodes())
                if (node.nodeKind == WorkflowModel.NodeKind.GROUP && (node.parentScopeId == null || node.parentScopeId.isBlank()))
                    roots.add(node);
        }
        int y = 40;
        for (WorkflowModel.Node root : roots) {
            placeGroup(model, root, 40, y);
            y += GROUP_HEIGHT + 60;
        }
    }

    private static void placeGroup(WorkflowModel model, WorkflowModel.Node group, int x, int y) {
        group.x = x;
        group.y = y;
        group.containerWidth = GROUP_WIDTH;
        group.containerHeight = GROUP_HEIGHT;
        List<WorkflowModel.Node> children = new ArrayList<>();
        for (WorkflowModel.Node node : model.nodes()) {
            if (node.id.equals(group.id) || !group.id.equals(node.parentScopeId)) continue;
            if (node.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT) {
                node.x = x + 20;
                node.y = y + 40;
                continue;
            }
            if (node.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT) {
                node.x = x + GROUP_WIDTH - 80;
                node.y = y + 40;
                continue;
            }
            children.add(node);
        }
        int cy = y + 60;
        for (WorkflowModel.Node child : children) {
            if (child.nodeKind == WorkflowModel.NodeKind.GROUP) {
                placeGroup(model, child, x + 50, cy);
                cy += GROUP_HEIGHT + 40;
                continue;
            }
            child.x = x + 50;
            child.y = cy;
            cy += 90;
        }
    }
}
