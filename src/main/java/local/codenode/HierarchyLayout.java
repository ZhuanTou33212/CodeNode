/*
 * Decompiled with CFR 0.152.
 */
package local.codenode;

import java.util.ArrayList;
import local.codenode.WorkflowModel;

public final class HierarchyLayout {
    private HierarchyLayout() {
    }

    public static void layout(WorkflowModel model) {
        if (model == null) {
            return;
        }
        ArrayList<WorkflowModel.Node> roots = new ArrayList<WorkflowModel.Node>();
        for (WorkflowModel.Node node : model.nodes()) {
            boolean topLevel;
            if (node.nodeKind != WorkflowModel.NodeKind.GROUP) continue;
            boolean isFolder = node.role != null && node.role.equals("folder");
            boolean bl = topLevel = node.parentScopeId == null || node.parentScopeId.isBlank();
            if (!isFolder || !topLevel) continue;
            roots.add(node);
        }
        if (roots.isEmpty()) {
            for (WorkflowModel.Node node : model.nodes()) {
                if (node.nodeKind != WorkflowModel.NodeKind.GROUP || node.parentScopeId != null && !node.parentScopeId.isBlank()) continue;
                roots.add(node);
            }
        }
        int y = 40;
        for (WorkflowModel.Node root : roots) {
            HierarchyLayout.placeGroup(model, root, 40, y);
            y += root.containerHeight + 80;
        }
    }

    private static void placeGroup(WorkflowModel model, WorkflowModel.Node group, int x, int y) {
        group.x = x;
        group.y = y;
        ArrayList<WorkflowModel.Node> children = new ArrayList<WorkflowModel.Node>();
        for (WorkflowModel.Node node : model.nodes()) {
            if (node.id.equals(group.id) || !node.parentScopeId.equals(group.id)) continue;
            if (node.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT || node.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT) {
                if (node.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT) {
                    node.x = x + 30;
                    node.y = y + 40;
                    continue;
                }
                node.x = x + 320;
                node.y = y + 40;
                continue;
            }
            children.add(node);
        }
        int cy = y + 140;
        for (WorkflowModel.Node child : children) {
            if (child.nodeKind == WorkflowModel.NodeKind.GROUP) {
                HierarchyLayout.placeGroup(model, child, x + 60, cy);
                cy += Math.max(420, child.containerHeight);
                continue;
            }
            child.x = x + 60;
            child.y = cy;
            cy += 110;
        }
        group.containerHeight = Math.max(400, cy - y + 60);
    }
}
