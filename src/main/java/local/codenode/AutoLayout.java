package local.codenode;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 项目全量解析自动布局：基于跨包依赖（import 连线）对 GROUP 做 Kahn 拓扑分层，
 * 层间从左到右排布；组内 FILE 子节点按网格纵向排布；孤立节点（无 package 的 FILE、
 * ASSET_BUNDLE）统一放入最右列。完成后调用 canvas.frameAll() 适配视野。
 */
public final class AutoLayout {

    /** 层间距（相邻两层的 X 间隔）。 */
    private static final int LAYER_X_GAP = 160;
    /** 组内网格列宽。 */
    private static final int COL_WIDTH = 120;
    /** 组内网格行高。 */
    private static final int NODE_ROW_HEIGHT = 60;
    /** 组内相邻行之间的行距。 */
    private static final int GROUP_INNER_ROW_GAP = 70;
    /** GROUP 节点渲染头部高度。 */
    private static final int GROUP_HEADER = 34;
    /** GROUP 节点端口区步进高度。 */
    private static final int GROUP_PORT_STEP = 22;
    /** GROUP 容器默认宽度。 */
    private static final int GROUP_WIDTH = 640;
    /** 组内网格列数。 */
    private static final int GRID_COLS = 2;
    /** 组内左内边距（FILE 区起始，端口列占 150）。 */
    private static final int GROUP_PAD_LEFT = 174;
    /** 组内端口节点宽度估算。 */
    private static final int PORT_NODE_WIDTH = 140;
    /** 组顶部预留头部 + 端口区高度。 */
    private static final int GROUP_TOP_OFFSET = GROUP_HEADER + GROUP_PORT_STEP * 2;
    /** 组底部内边距。 */
    private static final int GROUP_PAD_BOTTOM = 40;
    /** 同层多个组之间的纵向间隔。 */
    private static final int GROUP_V_GAP = 60;
    /** 最右列孤立节点的横向间距。 */
    private static final int ISOLATED_X_GAP = 60;
    /** 最右列孤立节点的纵向间距。 */
    private static final int ISOLATED_Y_GAP = 30;

    private AutoLayout() {}

    /**
     * 对 model 中的 GROUP / FILE / ASSET_BUNDLE 节点执行拓扑分层布局。
     * 布局完成后调用 canvas.frameAll() 缩放视野；canvas 为 null 时跳过视野适配。
     */
    public static void layout(WorkflowModel model, CanvasPanel canvas) {
        if (model == null) return;

        List<WorkflowModel.Node> groups = new ArrayList<>();
        for (WorkflowModel.Node node : model.nodes()) {
            if (node.nodeKind == WorkflowModel.NodeKind.GROUP) groups.add(node);
        }

        // ---------- Kahn 拓扑分层：依赖方在右，被依赖方在左 ----------
        Map<String, Integer> layers = new HashMap<>();
        Map<String, Set<String>> dependents = new LinkedHashMap<>(); // 依赖方 -> 被依赖方集合
        Map<String, Set<String>> predecessors = new LinkedHashMap<>(); // 被依赖方 -> 依赖它的组集合
        for (WorkflowModel.Node group : groups) {
            dependents.put(group.id, new LinkedHashSet<>());
            predecessors.put(group.id, new LinkedHashSet<>());
        }
        for (WorkflowModel.Edge edge : model.edges()) {
            WorkflowModel.Node source = model.byId(edge.source());
            WorkflowModel.Node target = model.byId(edge.target());
            if (source == null || target == null) continue;
            String sourceGroupId = source.parentScopeId;
            String targetGroupId = target.parentScopeId;
            // 仅统计 GROUP 之间的跨包依赖边（组输入 -> 组输出）
            if (!dependents.containsKey(targetGroupId)) continue;
            if (sourceGroupId.isBlank() || sourceGroupId.equals(targetGroupId)) continue;
            if (!dependents.containsKey(sourceGroupId)) continue;
            dependents.get(targetGroupId).add(sourceGroupId);
            predecessors.get(sourceGroupId).add(targetGroupId);
        }

        // Kahn：入度=被依赖组数，从无被依赖（入度 0）的组开始分层
        Map<String, Integer> indegree = new HashMap<>();
        for (Map.Entry<String, Set<String>> entry : dependents.entrySet()) {
            indegree.put(entry.getKey(), entry.getValue().size());
        }
        Deque<String> queue = new ArrayDeque<>();
        for (String groupId : indegree.keySet()) {
            if (indegree.get(groupId) == 0) queue.add(groupId);
        }
        List<String> order = new ArrayList<>();
        while (!queue.isEmpty()) {
            String current = queue.poll();
            order.add(current);
            int layer = layers.getOrDefault(current, 0);
            for (String successor : predecessors.getOrDefault(current, Set.of())) {
                int next = indegree.merge(successor, -1, Integer::sum);
                if (next == 0) queue.add(successor);
                layers.put(successor, Math.max(layers.getOrDefault(successor, 0), layer + 1));
            }
        }
        // 成环保护：剩余未入序的组全部放到最后一层之后
        if (order.size() < groups.size()) {
            int fallbackLayer = layers.values().stream().mapToInt(Integer::intValue).max().orElse(-1) + 1;
            for (WorkflowModel.Node group : groups) {
                if (!order.contains(group.id)) {
                    layers.put(group.id, fallbackLayer);
                    order.add(group.id);
                }
            }
        }

        // ---------- 按层排布：层内组纵向堆叠 ----------
        Map<Integer, List<WorkflowModel.Node>> layerGroups = new LinkedHashMap<>();
        for (WorkflowModel.Node group : groups) {
            int layer = layers.getOrDefault(group.id, 0);
            layerGroups.computeIfAbsent(layer, key -> new ArrayList<>()).add(group);
        }
        int maxLayer = layerGroups.keySet().stream().mapToInt(Integer::intValue).max().orElse(0);
        Map<String, Integer> groupLayer = new HashMap<>();
        for (Map.Entry<Integer, List<WorkflowModel.Node>> entry : layerGroups.entrySet()) {
            int layer = entry.getKey();
            List<WorkflowModel.Node> sameLayer = entry.getValue();
            sameLayer.sort(Comparator.comparing(n -> n.name));
            int y = 40;
            for (WorkflowModel.Node group : sameLayer) {
                int x = 40 + layer * (GROUP_WIDTH + LAYER_X_GAP);
                placeGroup(model, group, x, y);
                groupLayer.put(group.id, layer);
                y += group.containerHeight + GROUP_V_GAP;
            }
        }

        // ---------- 孤立节点（无 package 独立 FILE、ASSET_BUNDLE）最右列 ----------
        List<WorkflowModel.Node> isolated = new ArrayList<>();
        for (WorkflowModel.Node node : model.nodes()) {
            if (node.nodeKind == WorkflowModel.NodeKind.FILE || node.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) {
                if (node.parentScopeId == null || node.parentScopeId.isBlank()) isolated.add(node);
            }
        }
        if (!isolated.isEmpty()) {
            int maxX = 40 + (maxLayer + 1) * (GROUP_WIDTH + LAYER_X_GAP);
            isolated.sort(Comparator.comparing(n -> n.name));
            int y = 40;
            for (WorkflowModel.Node node : isolated) {
                node.x = maxX;
                node.y = y;
                y += nodeHeight(node) + ISOLATED_Y_GAP;
            }
        }

        // ---------- 视野适配 ----------
        if (canvas != null) {
            canvas.frameAll();
        }
    }

    /** 放置一个 GROUP 及其组内 FILE 子节点、组输入/输出节点。 */
    private static void placeGroup(WorkflowModel model, WorkflowModel.Node group, int x, int y) {
        group.x = x;
        group.y = y;

        List<WorkflowModel.Node> children = new ArrayList<>();
        for (WorkflowModel.Node node : model.nodes()) {
            if (node.nodeKind == WorkflowModel.NodeKind.FILE && node.parentScopeId.equals(group.id)) {
                children.add(node);
            }
        }
        children.sort(Comparator.comparing(n -> n.name));

        int rows = Math.max(1, (children.size() + GRID_COLS - 1) / GRID_COLS);
        int rowStep = NODE_ROW_HEIGHT + GROUP_INNER_ROW_GAP;
        int innerHeight = rows * rowStep;
        int containerHeight = GROUP_TOP_OFFSET + innerHeight + GROUP_PAD_BOTTOM;
        group.containerHeight = Math.max(320, containerHeight);

        for (int i = 0; i < children.size(); i++) {
            WorkflowModel.Node child = children.get(i);
            int row = i / GRID_COLS;
            int col = i % GRID_COLS;
            child.x = x + GROUP_PAD_LEFT + col * (COL_WIDTH + 20);
            child.y = y + GROUP_TOP_OFFSET + row * rowStep;
        }

        // 组输入/输出端口节点位于容器内左右端口列，避免与 FILE 子节点及相邻层冲突
        for (WorkflowModel.Node node : model.nodes()) {
            if (node.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT && node.parentScopeId.equals(group.id)) {
                node.x = x + 8;
                node.y = y + GROUP_TOP_OFFSET;
            } else if (node.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT && node.parentScopeId.equals(group.id)) {
                node.x = x + group.containerWidth - PORT_NODE_WIDTH - 8;
                node.y = y + GROUP_TOP_OFFSET;
            }
        }
    }

    private static int nodeHeight(WorkflowModel.Node node) {
        if (node.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) return 120;
        if (node.nodeKind == WorkflowModel.NodeKind.FILE) return 92;
        return node.nodeHeight > 0 ? node.nodeHeight : 92;
    }
}
