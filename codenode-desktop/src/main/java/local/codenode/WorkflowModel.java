package local.codenode;

import java.util.*;

public final class WorkflowModel {
    public enum Mode {
        EXECUTABLE("executable-workflow", "节点程序模式"),
        MARKDOWN("markdown-blueprint", "Markdown 请求模式");
        public final String wireName;
        public final String label;
        Mode(String wireName, String label) { this.wireName = wireName; this.label = label; }
        @Override public String toString() { return label; }
    }

    public enum Status { IDLE, QUEUED, PROCESSING, SUCCEEDED, FAILED }

    public static final class Port {
        public final String id;
        public String name;
        public String dataType;
        public boolean required;
        public Port(String id, String name, String dataType, boolean required) { this.id=id; this.name=name; this.dataType=dataType; this.required=required; }
    }

    public static final class Node {
        public final String id;
        public String name;
        public String prompt;
        public String artifact;
        public String category = "基础";
        public int x;
        public int y;
        public boolean collapsed;
        public boolean muted;
        public Status status = Status.IDLE;
        public String diagnostic = "";
        public final List<Port> inputs = new ArrayList<>();
        public final List<Port> outputs = new ArrayList<>();

        public Node(String id, String name, int x, int y) {
            this.id = id; this.name = name; this.x = x; this.y = y;
            this.prompt = "说明这个节点应完成的工作";
            this.artifact = "output/" + id + ".java";
            inputs.add(new Port("in", "输入", "any", false));
            outputs.add(new Port("out", "输出", "any", false));
        }
    }

    public record Edge(String id, String source, String sourcePort, String target, String targetPort) {}

    private final List<Node> nodes = new ArrayList<>();
    private final List<Edge> edges = new ArrayList<>();
    private int sequence = 1;

    public List<Node> nodes() { return Collections.unmodifiableList(nodes); }
    public List<Edge> edges() { return Collections.unmodifiableList(edges); }
    public Node addNode(int x, int y) {
        String id = "node-" + sequence++;
        Node node = new Node(id, "节点 " + (sequence - 1), x, y);
        nodes.add(node);
        return node;
    }
    public boolean connect(Node source, Node target) {
        return connect(source, source.outputs.getFirst(), target, target.inputs.getFirst());
    }
    public boolean connect(Node source, Port sourcePort, Node target, Port targetPort) {
        if (source == target || edges.stream().anyMatch(e -> e.source.equals(source.id) && e.sourcePort.equals(sourcePort.id) && e.target.equals(target.id) && e.targetPort.equals(targetPort.id))) return false;
        edges.removeIf(e -> e.target.equals(target.id) && e.targetPort.equals(targetPort.id));
        if ((targetPort.dataType.isBlank() || targetPort.dataType.equalsIgnoreCase("any")) && !sourcePort.dataType.isBlank()) targetPort.dataType=sourcePort.dataType;
        edges.add(new Edge("edge-" + source.id + "-" + sourcePort.id + "-" + target.id + "-" + targetPort.id, source.id, sourcePort.id, target.id, targetPort.id));
        return true;
    }
    public void removeEdges(Collection<Edge> removed) { edges.removeAll(removed); }
    public void removeNode(Node node) { nodes.remove(node); edges.removeIf(e -> e.source.equals(node.id) || e.target.equals(node.id)); }
    public void removePort(Node node, Port port, boolean output) { (output ? node.outputs : node.inputs).remove(port); edges.removeIf(e -> output ? e.source.equals(node.id)&&e.sourcePort.equals(port.id) : e.target.equals(node.id)&&e.targetPort.equals(port.id)); }
    public Port addPort(Node node, boolean output) { List<Port> ports=output?node.outputs:node.inputs; String prefix=output?"out":"in"; int index=1; while(hasPort(ports,prefix+index)) index++; Port port=new Port(prefix+index,output?"输出 "+index:"输入 "+index,"any",false); ports.add(port); return port; }
    private static boolean hasPort(List<Port> ports,String id){return ports.stream().anyMatch(p->p.id.equals(id));}
    public Node duplicate(Node source,int x,int y){Node copy=addNode(x,y);copy.name=source.name+" 副本";copy.prompt=source.prompt;copy.artifact=source.artifact;copy.category=source.category;copy.inputs.clear();copy.outputs.clear();source.inputs.forEach(p->copy.inputs.add(new Port(p.id,p.name,p.dataType,p.required)));source.outputs.forEach(p->copy.outputs.add(new Port(p.id,p.name,p.dataType,p.required)));return copy;}
    public Node byId(String id) { return nodes.stream().filter(n -> n.id.equals(id)).findFirst().orElse(null); }
    public Port input(Node node,String id){return node.inputs.stream().filter(p->p.id.equals(id)).findFirst().orElse(null);}
    public Port output(Node node,String id){return node.outputs.stream().filter(p->p.id.equals(id)).findFirst().orElse(null);}
    public void clearStatuses() { nodes.forEach(n -> { n.status = Status.IDLE; n.diagnostic = ""; }); }
}
