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

    public enum Status { IDLE, QUEUED, PROCESSING, REVIEW_READY, ACCEPTED, SUCCEEDED, FAILED, CANCELLED, REJECTED, CONFLICTED }
    public enum NodeKind { REGULAR, SCOPE, CONDITION, CALCULATION, FILE, GROUP_OUTPUT, ASSET, ASSET_BUNDLE, GROUP, CAPTURE, GROUP_INPUT }

    public enum SpaceRelation { PARALLEL, CONTAIN, REFERENCE }

    public static final class VirtualFileSpace {
        public String id;
        public String name;
        public String fileNodeId;          // "" = virtual(default) space; non-empty = bound to FILE node
        public String slotId;               // associated code slot id, e.g. "file:default" or "file:<nodeId>"
        public final List<String> includedNodeIds = new ArrayList<>();
        public SpaceRelation relation = SpaceRelation.PARALLEL;
        public final List<String> relatedSpaceIds = new ArrayList<>();
        public final List<String> groupOutputNodeIds = new ArrayList<>();

        public VirtualFileSpace() {}
        public VirtualFileSpace(String id, String name, String fileNodeId) {
            this.id = id; this.name = name; this.fileNodeId = fileNodeId;
        }
        public boolean isVirtual() { return fileNodeId == null || fileNodeId.isBlank(); }
    }

    public static final class CodeDraft {
        public String requestId;
        public long baseRevision;
        public String code;
        public String classificationKey;
        public CodeDraft(String requestId,long baseRevision,String code,String classificationKey){this.requestId=requestId;this.baseRevision=baseRevision;this.code=code;this.classificationKey=classificationKey;}
    }

    public static final class CodeSlot {
        public final String id;
        public final String ownerKind;
        public final String ownerId;
        public String language="java";
        public long activeRevision;
        public String activeCode="";
        public String previousCode="";
        public long previousSourceRevision=-1;
        public String lastAppliedRequestId="";
        public CodeDraft draft;
        public CodeSlot(String id,String ownerKind,String ownerId){this.id=id;this.ownerKind=ownerKind;this.ownerId=ownerId;}
    }

    public static final class Port {
        public final String id;
        public String name;
        public String declaredType;
        public String dataType;
        public boolean required;
        public Port(String id, String name, String dataType, boolean required) { this(id,name,dataType,dataType,required); }
        public Port(String id, String name, String declaredType, String dataType, boolean required) { this.id=id; this.name=name; this.declaredType=declaredType; this.dataType=dataType; this.required=required; }
    }

    public static final class Node {
        public final String id;
        public String name;
        public String prompt;
        public String artifact;
        public String category = "基础";
        public String templateLibrary = "custom";
        public String templateId = "blank";
        public String templateVersion = "1.0";
        public String templateLanguage = "neutral";
        public NodeKind nodeKind = NodeKind.REGULAR;
        public String valueType = "any";
        public String operation = "";
        public String classificationKey = "foundation.object";
        public boolean codeBearing = true;
        public String parentScopeId = "";
        public String scopeRegion = "body";
        public String fileNodeId = "";
        public String relativePath = "";
        public String role = "";
        public int containerWidth = 520;
        public int containerHeight = 320;
        public int x;
        public int y;
        public boolean collapsed;
        public boolean muted;
        public boolean detailMode;
        public boolean rangeMode;
        public boolean readOnly;
        public String nodeColor = "";
        public String assetType = "";
        public String bundleData = "";
        public String groupInputNodeId = "";
        public boolean bundleCollapsed = true;
        public String memberBinding;
        public int nodeWidth = 215;
        public int nodeHeight = 92;
        public Status status = Status.IDLE;
        public String diagnostic = "";
        public boolean composite;
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

    public static final class Reroute {
        public final String id;
        public int x,y;
        public Reroute(int x,int y){this("reroute-"+UUID.randomUUID(),x,y);}
        public Reroute(String id,int x,int y){this.id=id;this.x=x;this.y=y;}
    }
    public record Edge(String id, String source, String sourcePort, String target, String targetPort, List<Reroute> reroutes) {
        public Edge(String id,String source,String sourcePort,String target,String targetPort){this(id,source,sourcePort,target,targetPort,new ArrayList<>());}
    }
    public record ConnectionResult(boolean connected,String reason) {}

    private final List<Node> nodes = new ArrayList<>();
    private final List<Edge> edges = new ArrayList<>();
    private final LinkedHashMap<String,CodeSlot> codeSlots = new LinkedHashMap<>();
    private final LinkedHashMap<String,VirtualFileSpace> fileSpaces = new LinkedHashMap<>();
    private int sequence = 1;
    private long revision;

    public List<Node> nodes() { return Collections.unmodifiableList(nodes); }
    public List<Edge> edges() { return Collections.unmodifiableList(edges); }
    public Collection<CodeSlot> codeSlots(){return Collections.unmodifiableCollection(codeSlots.values());}
    public CodeSlot codeSlot(String id){return codeSlots.get(id);}
    public long revision(){return revision;}
    public void touch(){revision++;}
    public List<Reroute> reroutes(){LinkedHashMap<String,Reroute> points=new LinkedHashMap<>();edges.forEach(e->e.reroutes.forEach(p->points.putIfAbsent(p.id,p)));return List.copyOf(points.values());}
    public Reroute rerouteById(String id){return reroutes().stream().filter(point->point.id.equals(id)).findFirst().orElse(null);}
    public Node addNode(int x, int y) {
        String id = "node-" + UUID.randomUUID(); sequence++;
        Node node = new Node(id, "节点 " + (sequence - 1), x, y);
        nodes.add(node);
        ensureNodeSlot(node);
        touch();
        return node;
    }
    public Node forceAddNode(String id, String name, int x, int y) {
        Node node = new Node(id, name, x, y);
        nodes.add(node);
        ensureNodeSlot(node);
        touch();
        return node;
    }
    public Node addGroupOutput(int x,int y,String name){
        Node node=addNode(x,y);node.name=name==null||name.isBlank()?"组输出":name;node.nodeKind=NodeKind.GROUP_OUTPUT;node.category="输入与输出";node.classificationKey="io.group-output";node.codeBearing=false;node.inputs.clear();node.inputs.add(new Port("group","代码组","flow",true));node.outputs.clear();codeSlots.remove("node:"+node.id);touch();return node;
    }
    public Node addFileNode(int x,int y,String name,String relativePath){
        Node node=addNode(x,y);node.name=name==null||name.isBlank()?"文件":name;node.nodeKind=NodeKind.FILE;node.category="文件";node.classificationKey="file.source";node.codeBearing=false;node.relativePath=relativePath==null?"":relativePath;node.inputs.clear();node.inputs.add(new Port("imports","导入","module",false));node.outputs.clear();node.outputs.add(new Port("exports","导出","module",false));codeSlots.remove("node:"+node.id);ensureFileSlot(node);touch();return node;
    }
    public Node addAssetNode(int x,int y,String name,String relativePath,String assetType){
        Node node=addNode(x,y);node.name=name==null||name.isBlank()?"资源":name;node.nodeKind=NodeKind.ASSET;node.category="资产";node.classificationKey="asset."+assetType;node.codeBearing=false;node.relativePath=relativePath==null?"":relativePath;node.assetType=assetType;node.inputs.clear();node.inputs.add(new Port("reference","引用","string",false));node.outputs.clear();node.outputs.add(new Port("resource","资源","module",false));codeSlots.remove("node:"+node.id);touch();return node;
    }
    public Node addAssetBundleNode(int x,int y,String name,String bundleData,String assetType){
        Node node=addNode(x,y);node.name=name==null||name.isBlank()?"资源组":name;node.nodeKind=NodeKind.ASSET_BUNDLE;node.category="资产组";node.classificationKey="asset."+assetType;node.codeBearing=false;node.bundleData=bundleData==null?"":bundleData;node.assetType=assetType;node.inputs.clear();node.inputs.add(new Port("reference","引用","string",false));node.outputs.clear();node.outputs.add(new Port("resources","资源组","module",false));codeSlots.remove("node:"+node.id);touch();return node;
    }
    public Node addGroupNode(int x,int y,String name){
        Node node=addNode(x,y);node.name=name==null||name.isBlank()?"节点组":name;node.nodeKind=NodeKind.GROUP;node.category="节点组";node.classificationKey="scope.group";node.codeBearing=false;node.containerWidth=640;node.containerHeight=400;node.inputs.clear();node.outputs.clear();codeSlots.remove("node:"+node.id);touch();return node;
    }
    public Node addCaptureNode(int x,int y,String name){
        Node node=addNode(x,y);node.name=name==null||name.isBlank()?"捕获":name;node.nodeKind=NodeKind.CAPTURE;node.category="捕获";node.classificationKey="io.capture";node.codeBearing=false;node.inputs.clear();node.inputs.add(new Port("capture","捕获","any",false));node.outputs.clear();node.outputs.add(new Port("value","值","any",false));codeSlots.remove("node:"+node.id);touch();return node;
    }
    public Node addGroupInputNode(int x,int y,String name){
        Node node=addNode(x,y);node.name=name==null||name.isBlank()?"节点组输入":name;node.nodeKind=NodeKind.GROUP_INPUT;node.category="节点组";node.classificationKey="io.node-group-input";node.codeBearing=false;node.inputs.clear();node.outputs.clear();node.outputs.add(new Port("value","值","any",false));codeSlots.remove("node:"+node.id);touch();return node;
    }
    public Node addNodeGroupOutput(int x,int y,String name){
        Node node=addNode(x,y);node.name=name==null||name.isBlank()?"节点组输出":name;node.nodeKind=NodeKind.GROUP_OUTPUT;node.category="节点组";node.classificationKey="io.node-group-output";node.codeBearing=false;node.inputs.clear();node.inputs.add(new Port("value","值","any",true));node.outputs.clear();codeSlots.remove("node:"+node.id);touch();return node;
    }
    public List<Node> expandAssetBundle(Node bundleNode){
        if(bundleNode.nodeKind!=NodeKind.ASSET_BUNDLE||bundleNode.bundleData.isBlank())return List.of();
        List<Node> created=new ArrayList<>();
        Map<String,String> memberIdToNewNodeId=new HashMap<>();
        try{
            Map<String,Object> manifest=Json.object(bundleNode.bundleData);
            Object membersRaw=manifest.get("members");
            if(membersRaw instanceof List<?> members){
                int index=0;
                for(Object item:members){
                    if(!(item instanceof Map<?,?> member))continue;
                    Object relObj=member.get("relativePath");
                    String rel=relObj==null?"":String.valueOf(relObj);
                    if(rel.isBlank()||"null".equals(rel))continue;
                    Object catObj=member.get("category");
                    String category=catObj==null?"other":String.valueOf(catObj);
                    if("null".equals(category))category="other";
                    Object idObj=member.get("id");
                    String memberId=idObj==null?"":String.valueOf(idObj);
                    if("null".equals(memberId))memberId="";
                    Object nameObj=member.get("name");
                    String name=nameObj==null||"null".equals(String.valueOf(nameObj))?bundleFileName(rel):String.valueOf(nameObj);
                    String assetType=local.codenode.util.BundleDataUtil.assetTypeForCategory(category);
                    Node asset=addAssetNode(bundleNode.x+40+index*40,bundleNode.y+60,name,rel,assetType);
                    asset.fileNodeId=bundleNode.id;
                    created.add(asset);
                    if(!memberId.isBlank())memberIdToNewNodeId.put(memberId,asset.id);
                    index++;
                }
            }else{
                Object files=manifest.get("files");
                if(files instanceof List<?> list){
                    for(Object item:list){
                        if(item instanceof Map<?,?> fileMap){
                            Object relObj=fileMap.get("path");
                            Object typeObj=fileMap.get("type");
                            String rel=relObj==null?"":String.valueOf(relObj);
                            String type=typeObj==null?"":String.valueOf(typeObj);
                            if(rel.isBlank()||"null".equals(rel)||type.isBlank()||"null".equals(type))continue;
                            Node asset=addAssetNode(bundleNode.x+40+created.size()*40,bundleNode.y+60,bundleFileName(rel),rel,type);
                            asset.fileNodeId=bundleNode.id;
                            created.add(asset);
                        }
                    }
                }
            }
            migrateConnectionsOnExpand(bundleNode,memberIdToNewNodeId);
            nodes.remove(bundleNode);codeSlots.remove("file:"+bundleNode.id);
        }catch(Exception ignored){}
        touch();
        return created;
    }
    private static String bundleFileName(String relativePath){
        if(relativePath==null)return "";
        int slash=relativePath.lastIndexOf('/');
        return slash<0?relativePath:relativePath.substring(slash+1);
    }
    /** 资源组展开后的连接迁移：输入侧 memberBinding 记录随 bundle 销毁；输出侧按 members[].id 更新下游 groupInputNodeId，无法匹配置空并告警。 */
    public void migrateConnectionsOnExpand(Node bundleNode,Map<String,String> memberIdToNewNodeId){
        if(bundleNode==null||memberIdToNewNodeId==null)return;
        for(Node node:nodes){
            if(!bundleNode.id.equals(node.groupInputNodeId))continue;
            node.memberBinding=null;
            String target=memberIdToNewNodeId.values().stream().findFirst().orElse("");
            node.groupInputNodeId=target;
            if(target.isEmpty())System.out.println("[expandAssetBundle] 下游 groupInputNodeId 无法匹配成员，已置空: node="+node.id);
        }
    }
    public void toggleFileNodeMode(Node node){
        if(node.nodeKind!=NodeKind.FILE)return;
        boolean wasRange=node.rangeMode;
        node.rangeMode=!node.rangeMode;
        if(wasRange&&!node.rangeMode){
            List<Node> children=nodes.stream().filter(n->n.fileNodeId.equals(node.id)).toList();
            for(Node child:children)child.fileNodeId="";
        }
        touch();
    }
    public boolean connect(Node source, Node target) {
        return connect(source, source.outputs.getFirst(), target, target.inputs.getFirst());
    }
    public boolean connect(Node source, Port sourcePort, Node target, Port targetPort) {
        return connectChecked(source,sourcePort,target,targetPort).connected();
    }
    public ConnectionResult connectChecked(Node source,Port sourcePort,Node target,Port targetPort) {
        if(source==null||sourcePort==null||target==null||targetPort==null)return rejected("节点或端口不存在");
        if(!nodes.contains(source)||!nodes.contains(target)||!source.outputs.contains(sourcePort)||!target.inputs.contains(targetPort))return rejected("只能从输出端口连接到输入端口");
        if(source==target)return rejected("不能连接节点自身");
        if(edges.stream().anyMatch(e->e.source.equals(source.id)&&e.sourcePort.equals(sourcePort.id)&&e.target.equals(target.id)&&e.targetPort.equals(targetPort.id)))return rejected("该连线已经存在");
        String outputType=normalizedType(sourcePort.dataType),inputType=normalizedType(targetPort.declaredType);
        if(!compatible(outputType,inputType))return rejected("类型不兼容（"+outputType+" → "+inputType+"）");
        edges.removeIf(e -> e.target.equals(target.id) && e.targetPort.equals(targetPort.id));
        edges.add(new Edge("edge-" + source.id + "-" + sourcePort.id + "-" + target.id + "-" + targetPort.id, source.id, sourcePort.id, target.id, targetPort.id));
        recomputeTypes();
        touch();
        return new ConnectionResult(true,"连接成功");
    }
    public void removeEdges(Collection<Edge> removed) { if(edges.removeAll(removed)){recomputeTypes();touch();} }
    public void removeNode(Node node) { if(nodes.remove(node)){edges.removeIf(e -> e.source.equals(node.id) || e.target.equals(node.id));codeSlots.remove("node:"+node.id);codeSlots.remove("file:"+node.id);nodes.forEach(n->{if(n.fileNodeId.equals(node.id))n.fileNodeId="";if(n.parentScopeId.equals(node.id))n.parentScopeId="";});recomputeTypes();touch();} }
    public void removePort(Node node, Port port, boolean output) { if((output ? node.outputs : node.inputs).remove(port)){edges.removeIf(e -> output ? e.source.equals(node.id)&&e.sourcePort.equals(port.id) : e.target.equals(node.id)&&e.targetPort.equals(port.id));recomputeTypes();touch();} }
    public int replacePorts(Node node,List<Port> inputs,List<Port> outputs){Set<String> inputIds=inputs.stream().map(p->p.id).collect(java.util.stream.Collectors.toSet()),outputIds=outputs.stream().map(p->p.id).collect(java.util.stream.Collectors.toSet());int before=edges.size();node.inputs.clear();node.inputs.addAll(inputs);node.outputs.clear();node.outputs.addAll(outputs);edges.removeIf(edge->edge.target.equals(node.id)&&!inputIds.contains(edge.targetPort)||edge.source.equals(node.id)&&!outputIds.contains(edge.sourcePort));edges.removeIf(edge->{Node source=byId(edge.source),target=byId(edge.target);Port from=source==null?null:output(source,edge.sourcePort),to=target==null?null:input(target,edge.targetPort);return from==null||to==null||!compatible(normalizedType(from.dataType),normalizedType(to.declaredType));});recomputeTypes();touch();return before-edges.size();}
    public Port addPort(Node node, boolean output) { List<Port> ports=output?node.outputs:node.inputs; String prefix=output?"out":"in"; int index=1; while(hasPort(ports,prefix+index)) index++; Port port=new Port(prefix+index,output?"输出 "+index:"输入 "+index,"any",false); ports.add(port);touch(); return port; }
    private static boolean hasPort(List<Port> ports,String id){return ports.stream().anyMatch(p->p.id.equals(id));}
    public Node duplicate(Node source,int x,int y){Node copy=addNode(x,y);copyNodeFields(source,copy);copy.name=source.name+" 副本";copy.parentScopeId="";copy.fileNodeId="";if(!copy.codeBearing)codeSlots.remove("node:"+copy.id);if(copy.nodeKind==NodeKind.FILE)ensureFileSlot(copy);touch();return copy;}
    public Node byId(String id) { return nodes.stream().filter(n -> n.id.equals(id)).findFirst().orElse(null); }
    public Port input(Node node,String id){return node.inputs.stream().filter(p->p.id.equals(id)).findFirst().orElse(null);}
    public Port output(Node node,String id){return node.outputs.stream().filter(p->p.id.equals(id)).findFirst().orElse(null);}
    public void replaceContents(Collection<Node> replacementNodes, Collection<Edge> replacementEdges) {
        replaceContents(replacementNodes,replacementEdges,List.of(),0);
    }
    public void replaceContents(Collection<Node> replacementNodes,Collection<Edge> replacementEdges,Collection<CodeSlot> replacementSlots,long graphRevision){nodes.clear();edges.clear();codeSlots.clear();fileSpaces.clear();nodes.addAll(replacementNodes);edges.addAll(replacementEdges);replacementSlots.forEach(slot->codeSlots.put(slot.id,slot));nodes.stream().filter(n->n.codeBearing).forEach(this::ensureNodeSlot);nodes.stream().filter(n->n.nodeKind==NodeKind.FILE).forEach(this::ensureFileSlot);sequence=nodes.size()+1;revision=graphRevision;recomputeTypes();refreshFileSpaces();}
    public WorkflowModel deepCopy(){WorkflowModel copy=new WorkflowModel();List<Node> copiedNodes=nodes.stream().map(WorkflowModel::copyNode).toList();Map<String,Reroute> points=new HashMap<>();List<Edge> copiedEdges=new ArrayList<>();for(Edge edge:edges){List<Reroute> copiedPoints=new ArrayList<>();for(Reroute point:edge.reroutes)copiedPoints.add(points.computeIfAbsent(point.id,id->new Reroute(id,point.x,point.y)));copiedEdges.add(new Edge(edge.id,edge.source,edge.sourcePort,edge.target,edge.targetPort,copiedPoints));}List<CodeSlot> copiedSlots=codeSlots.values().stream().map(WorkflowModel::copySlot).toList();copy.replaceContents(copiedNodes,copiedEdges,copiedSlots,revision);return copy;}
    public void replaceFrom(WorkflowModel source){WorkflowModel copy=source.deepCopy();replaceContents(copy.nodes,copy.edges,copy.codeSlots.values(),copy.revision);}
    public void applyRuntimeFrom(WorkflowModel source){for(Node node:nodes){Node other=source.byId(node.id);if(other==null)continue;node.status=other.status;node.diagnostic=other.diagnostic;node.classificationKey=other.classificationKey;node.category=other.category;}for(CodeSlot slot:codeSlots.values()){CodeSlot other=source.codeSlot(slot.id);if(other==null)continue;slot.language=other.language;slot.activeRevision=other.activeRevision;slot.activeCode=other.activeCode;slot.previousCode=other.previousCode;slot.previousSourceRevision=other.previousSourceRevision;slot.lastAppliedRequestId=other.lastAppliedRequestId;slot.draft=other.draft==null?null:new CodeDraft(other.draft.requestId,other.draft.baseRevision,other.draft.code,other.draft.classificationKey);}revision=source.revision;}
    private static Node copyNode(Node source){Node copy=new Node(source.id,source.name,source.x,source.y);copyNodeFields(source,copy);return copy;}
    private static void copyNodeFields(Node source,Node copy){copy.prompt=source.prompt;copy.artifact=source.artifact;copy.category=source.category;copy.templateLibrary=source.templateLibrary;copy.templateId=source.templateId;copy.templateVersion=source.templateVersion;copy.templateLanguage=source.templateLanguage;copy.nodeKind=source.nodeKind;copy.valueType=source.valueType;copy.operation=source.operation;copy.classificationKey=source.classificationKey;copy.codeBearing=source.codeBearing;copy.parentScopeId=source.parentScopeId;copy.scopeRegion=source.scopeRegion;copy.fileNodeId=source.fileNodeId;copy.relativePath=source.relativePath;copy.role=source.role;copy.containerWidth=source.containerWidth;copy.containerHeight=source.containerHeight;copy.collapsed=source.collapsed;copy.muted=source.muted;copy.detailMode=source.detailMode;copy.rangeMode=source.rangeMode;copy.nodeColor=source.nodeColor;copy.assetType=source.assetType;copy.bundleData=source.bundleData;copy.groupInputNodeId=source.groupInputNodeId;copy.bundleCollapsed=source.bundleCollapsed;copy.memberBinding=source.memberBinding;copy.nodeWidth=source.nodeWidth;copy.nodeHeight=source.nodeHeight;copy.status=source.status;copy.diagnostic=source.diagnostic;copy.inputs.clear();copy.outputs.clear();source.inputs.forEach(p->copy.inputs.add(new Port(p.id,p.name,p.declaredType,p.dataType,p.required)));source.outputs.forEach(p->copy.outputs.add(new Port(p.id,p.name,p.declaredType,p.dataType,p.required)));}
    private static CodeSlot copySlot(CodeSlot source){CodeSlot copy=new CodeSlot(source.id,source.ownerKind,source.ownerId);copy.language=source.language;copy.activeRevision=source.activeRevision;copy.activeCode=source.activeCode;copy.previousCode=source.previousCode;copy.previousSourceRevision=source.previousSourceRevision;copy.lastAppliedRequestId=source.lastAppliedRequestId;copy.draft=source.draft==null?null:new CodeDraft(source.draft.requestId,source.draft.baseRevision,source.draft.code,source.draft.classificationKey);return copy;}
    public Reroute addReroute(Edge edge,int x,int y){Reroute point=new Reroute(x,y);edge.reroutes.add(point);return point;}
    public void removeReroute(Edge edge,Reroute point){edge.reroutes.remove(point);}
    public void removeReroute(Reroute point){edges.forEach(edge->edge.reroutes.removeIf(candidate->candidate.id.equals(point.id)));}
    public void clear() { nodes.clear(); edges.clear();codeSlots.clear();fileSpaces.clear(); sequence=1;revision=0; }
    public CodeSlot ensureNodeSlot(Node node){if(!node.codeBearing)return null;return codeSlots.computeIfAbsent("node:"+node.id,id->new CodeSlot(id,"node",node.id));}
    public void setCodeBearing(Node node,boolean value){node.codeBearing=value;if(value)ensureNodeSlot(node);else codeSlots.remove("node:"+node.id);touch();}
    public CodeSlot ensureFileSlot(Node node){if(node.nodeKind!=NodeKind.FILE)throw new IllegalArgumentException("不是文件节点");return codeSlots.computeIfAbsent("file:"+node.id,id->new CodeSlot(id,"file",node.id));}
    public CodeSlot ensureDefaultFileSlot(){return codeSlots.computeIfAbsent("file:default",id->new CodeSlot(id,"file","default"));}
    public String codeSlotId(Node node,Mode mode){if(mode==Mode.EXECUTABLE)return node.codeBearing?"node:"+node.id:"";if(node.nodeKind==NodeKind.FILE)return "file:"+node.id;if(!node.fileNodeId.isBlank())return "file:"+node.fileNodeId;if(nodes.stream().noneMatch(n->n.nodeKind==NodeKind.FILE))return "file:default";return "";}
    public List<Node> groupOutputs(){return nodes.stream().filter(n->n.nodeKind==NodeKind.GROUP_OUTPUT).toList();}
    public Collection<VirtualFileSpace> fileSpaces(){return Collections.unmodifiableCollection(fileSpaces.values());}
    public VirtualFileSpace fileSpace(String id){return fileSpaces.get(id);}
    public void putFileSpace(VirtualFileSpace space){fileSpaces.put(space.id,space);}

    public void refreshFileSpaces() {
        Map<String, VirtualFileSpace> previous = new HashMap<>();
        for (VirtualFileSpace existing : fileSpaces.values()) {
            VirtualFileSpace keep = new VirtualFileSpace(existing.id, existing.name, existing.fileNodeId);
            keep.relation = existing.relation;
            keep.relatedSpaceIds.addAll(existing.relatedSpaceIds);
            previous.put(existing.id, keep);
        }
        fileSpaces.clear();
        boolean hasFileNode = nodes.stream().anyMatch(n -> n.nodeKind == NodeKind.FILE);
        if (!hasFileNode) {
            VirtualFileSpace defaultSpace = new VirtualFileSpace("space:default", "默认文件空间", "");
            defaultSpace.relation = SpaceRelation.PARALLEL;
            defaultSpace.slotId = "file:default";
            for (Node node : nodes) {
                if (node.nodeKind == NodeKind.FILE) continue;
                defaultSpace.includedNodeIds.add(node.id);
            }
            for (Node group : groupOutputs()) {
                if (isValidGroupOutput(group) && !upstreamOf(group).isEmpty())
                    defaultSpace.groupOutputNodeIds.add(group.id);
            }
            fileSpaces.put(defaultSpace.id, defaultSpace);
        } else {
            for (Node fileNode : nodes) {
                if (fileNode.nodeKind != NodeKind.FILE) continue;
                VirtualFileSpace space = new VirtualFileSpace("space:" + fileNode.id, fileNode.name, fileNode.id);
                space.relation = SpaceRelation.PARALLEL;
                space.slotId = "file:" + fileNode.id;
                for (Node node : nodes) {
                    if (node.id.equals(fileNode.id)) continue;
                    if (node.fileNodeId.equals(fileNode.id))
                        space.includedNodeIds.add(node.id);
                }
                for (Node group : groupOutputs()) {
                    if (!isValidGroupOutput(group)) continue;
                    if (upstreamIncludingMuted(group).stream().anyMatch(n -> n.fileNodeId.equals(fileNode.id) || n.id.equals(fileNode.id)))
                        space.groupOutputNodeIds.add(group.id);
                }
                fileSpaces.put(space.id, space);
            }
        }
        for (VirtualFileSpace space : fileSpaces.values()) {
            VirtualFileSpace prior = previous.get(space.id);
            if (prior != null) {
                space.relation = prior.relation;
                space.relatedSpaceIds.clear();
                space.relatedSpaceIds.addAll(prior.relatedSpaceIds);
            }
        }
    }

    public List<Node> upstreamOf(Node output){return upstreamIncludingMuted(output).stream().filter(node->!node.muted).toList();}
    public List<Node> upstreamIncludingMuted(Node output){if(output==null||output.nodeKind!=NodeKind.GROUP_OUTPUT)return List.of();boolean linked=edges.stream().anyMatch(e->e.target.equals(output.id));if(!linked)return List.of();String fileBoundary=output.fileNodeId;LinkedHashSet<String> ids=new LinkedHashSet<>();ArrayDeque<String> todo=new ArrayDeque<>();todo.add(output.id);while(!todo.isEmpty()){String id=todo.removeFirst();for(Edge edge:edges)if(edge.target.equals(id)){Node source=byId(edge.source);if(source==null||!insideFileBoundary(source,fileBoundary)||!ids.add(edge.source))continue;todo.add(edge.source);}}return ids.stream().map(this::byId).filter(Objects::nonNull).filter(node->node.nodeKind!=NodeKind.GROUP_OUTPUT).toList();}
    public boolean isValidGroupOutput(Node node){return node!=null&&node.nodeKind==NodeKind.GROUP_OUTPUT&&!upstreamOf(node).isEmpty()&&node.inputs.stream().filter(p->p.required).allMatch(p->edges.stream().anyMatch(e->e.target.equals(node.id)&&e.targetPort.equals(p.id)));}
    private static boolean insideFileBoundary(Node node,String fileBoundary){return fileBoundary==null||fileBoundary.isBlank()||node.id.equals(fileBoundary)||node.fileNodeId.equals(fileBoundary);}
    public void recomputeTypes() {
        nodes.forEach(n->n.inputs.forEach(p->p.dataType=normalizedType(p.declaredType)));
        for(Edge edge:edges){Node source=byId(edge.source),target=byId(edge.target);if(source==null||target==null)continue;Port from=output(source,edge.sourcePort),to=input(target,edge.targetPort);if(from!=null&&to!=null&&isAny(to.declaredType)&&!from.dataType.isBlank())to.dataType=from.dataType;}
    }
    private static String normalizedType(String type){return type==null||type.isBlank()?"any":type;}
    private static boolean isAny(String type){return type==null||type.isBlank()||type.equalsIgnoreCase("any");}
    private static ConnectionResult rejected(String reason){return new ConnectionResult(false,"连接失败："+reason);}
    private static boolean compatible(String outputType,String inputType){
        if(isAny(outputType)||isAny(inputType))return true;
        String output=canonicalType(outputType),input=canonicalType(inputType);
        return output.equals(input)||output.equals("integer")&&input.equals("number");
    }
    private static String canonicalType(String type){return switch(type.trim().toLowerCase(Locale.ROOT)){case "int","integer"->"integer";case "float","double","number","decimal"->"number";case "bool","boolean"->"boolean";default->type.trim().toLowerCase(Locale.ROOT);};}
    public void clearStatuses() { nodes.forEach(n -> { n.status = Status.IDLE; n.diagnostic = ""; }); }
}
