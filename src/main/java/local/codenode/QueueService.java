package local.codenode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.*;

public final class QueueService {
    public enum TargetKind { SELECTED_NODE, GROUP_OUTPUT }
    public record SubmitTarget(TargetKind kind,WorkflowModel.Node node,List<WorkflowModel.Node> allSelected) {
        public static SubmitTarget selected(WorkflowModel.Node node){return new SubmitTarget(TargetKind.SELECTED_NODE,node,List.of(node));}
        public static SubmitTarget group(WorkflowModel.Node node){return new SubmitTarget(TargetKind.GROUP_OUTPUT,node,List.of());}
        public static SubmitTarget multi(List<WorkflowModel.Node> nodes,WorkflowModel.Node primary){return new SubmitTarget(TargetKind.SELECTED_NODE,primary,nodes);}
    }

    private final Path projectRoot;
    private final Path stateRoot;
    private final WorkflowDslService dsl=new WorkflowDslService();

    public QueueService(Path projectRoot) throws IOException {
        this.projectRoot=projectRoot.toAbsolutePath().normalize();this.stateRoot=this.projectRoot.resolve(".codenode");
        for(String dir:List.of("queue/staging","queue/inbox","queue/processing","queue/completed","queue/failed","queue/cancelled","queue/rejected","queue/conflicted","results"))Files.createDirectories(stateRoot.resolve(dir));
        Path descriptor=stateRoot.resolve("project.json");
        if(!Files.exists(descriptor))Files.writeString(descriptor,Json.stringify(Map.of("schemaVersion","4.0","projectRoot",this.projectRoot.toString(),"transport","local-file-queue")),StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW);
    }

    public Path projectRoot(){return projectRoot;}
    public Path stateRoot(){return stateRoot;}

    public Path beginProcessing(String requestId) throws IOException {
        if(requestId==null||!requestId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}"))throw new IllegalArgumentException("非法 requestId");
        Path inbox=stateRoot.resolve("queue/inbox").resolve(requestId),processing=stateRoot.resolve("queue/processing").resolve(requestId);
        if(Files.isDirectory(processing))return processing;
        if(!Files.isDirectory(inbox))throw new NoSuchFileException("申请不在 inbox："+requestId);
        try{Files.move(inbox,processing,StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException e){Files.move(inbox,processing);}
        return processing;
    }

    public Path returnToInbox(String requestId) throws IOException {
        Path processing=stateRoot.resolve("queue/processing").resolve(requestId),inbox=stateRoot.resolve("queue/inbox").resolve(requestId);
        if(Files.isDirectory(inbox))return inbox;
        if(!Files.isDirectory(processing))throw new NoSuchFileException("申请不在 processing："+requestId);
        try{Files.move(processing,inbox,StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException e){Files.move(processing,inbox);}
        return inbox;
    }

    public List<QueueEntry> entries() throws IOException {
        List<QueueEntry> entries=new ArrayList<>();
        for(String status:List.of("inbox","processing","completed","failed","cancelled","rejected","conflicted")){Path directory=stateRoot.resolve("queue").resolve(status);try(var children=Files.list(directory)){children.filter(Files::isDirectory).forEach(path->entries.add(new QueueEntry(path.getFileName().toString(),status,path)));}}
        entries.sort(Comparator.comparing(QueueEntry::requestId).reversed());return entries;
    }

    public int restoreActiveStatuses(WorkflowModel model) throws IOException {
        LinkedHashSet<String> restored=new LinkedHashSet<>();
        for(String state:List.of("inbox","processing")){WorkflowModel.Status status=state.equals("processing")?WorkflowModel.Status.PROCESSING:WorkflowModel.Status.QUEUED;Path root=stateRoot.resolve("queue").resolve(state);try(var dirs=Files.list(root)){for(Path dir:dirs.filter(Files::isDirectory).toList()){Path file=dir.resolve("request.json");if(!Files.isRegularFile(file))continue;Map<String,Object> request=Json.object(Files.readString(file));Map<?,?> target=request.get("target") instanceof Map<?,?> value?value:Map.of();Object values=target.get("codeSlotIds");if(!(values instanceof List<?> slotIds))continue;for(Object raw:slotIds){String slotId=String.valueOf(raw);WorkflowModel.CodeSlot slot=model.codeSlot(slotId);if(slot==null)continue;for(WorkflowModel.Node node:owners(model,slot)){node.status=status;restored.add(node.id);}}}}}
        return restored.size();
    }

    private static List<WorkflowModel.Node> owners(WorkflowModel model,WorkflowModel.CodeSlot slot){if("node".equals(slot.ownerKind)){WorkflowModel.Node node=model.byId(slot.ownerId);return node==null?List.of():List.of(node);}if("default".equals(slot.ownerId))return model.nodes().stream().filter(node->node.nodeKind!=WorkflowModel.NodeKind.FILE).toList();return model.nodes().stream().filter(node->node.id.equals(slot.ownerId)||node.fileNodeId.equals(slot.ownerId)).toList();}

    public static boolean isSingleNodeSubmissionAllowed(WorkflowModel model,WorkflowModel.Mode mode) {
        if (mode == WorkflowModel.Mode.MARKDOWN) {
            boolean hasFileNode = model.nodes().stream().anyMatch(n -> n.nodeKind == WorkflowModel.NodeKind.FILE);
            if (!hasFileNode) return false;
        }
        return true;
    }

    public static void validateMultiGroupOutput(List<WorkflowModel.Node> groupOutputNodes) {
        if (groupOutputNodes == null || groupOutputNodes.size() <= 1) return;
        throw new IllegalArgumentException("禁止同时选择多个组输出（已选择 " + groupOutputNodes.size() + " 个组输出），请只选择一个组输出作为请求输出");
    }

    public Submission submit(WorkflowModel model,WorkflowModel.Mode mode,WorkflowModel.Node selected,boolean selectedOnly,String language,String outputPath) throws IOException {
        if(!selectedOnly&&selected!=null&&selected.nodeKind!=WorkflowModel.NodeKind.GROUP_OUTPUT)throw new IllegalArgumentException("组提交必须选择有效的组输出节点");
        if(selectedOnly&&!isSingleNodeSubmissionAllowed(model,mode))throw new IllegalArgumentException("当前为虚拟文件空间（无文件节点），仅支持提交连接了组输出的节点流，单个节点禁止发送请求");
        return submit(model,mode,selectedOnly?SubmitTarget.selected(selected):SubmitTarget.group(selected),language,outputPath);
    }

    public Submission submit(WorkflowModel model,WorkflowModel.Mode mode,SubmitTarget target,String language,String outputPath) throws IOException {
        Objects.requireNonNull(model);if(target==null||target.node()==null)throw new IllegalArgumentException("请先选择提交目标");WorkflowModel.Node selected=target.node();
        if(target.kind()==TargetKind.SELECTED_NODE&&!isSingleNodeSubmissionAllowed(model,mode))throw new IllegalArgumentException("当前为虚拟文件空间（无文件节点），仅支持提交连接了组输出的节点流，单个节点禁止发送请求");
        if(target.kind()==TargetKind.SELECTED_NODE&&target.allSelected()!=null&&target.allSelected().size()>1){
            List<WorkflowModel.Node> selectedGroups=target.allSelected().stream().filter(n->n!=null&&n.nodeKind==WorkflowModel.NodeKind.GROUP_OUTPUT).toList();
            if(selectedGroups.size()>1)validateMultiGroupOutput(selectedGroups);
        }
        if(target.kind()==TargetKind.GROUP_OUTPUT&&!model.isValidGroupOutput(selected))throw new IllegalArgumentException("组输出没有有效输入或不包含可提交节点");
        if(target.kind()==TargetKind.SELECTED_NODE&&selected.nodeKind==WorkflowModel.NodeKind.GROUP_OUTPUT)throw new IllegalArgumentException("组输出节点请使用组输出提交项");
        List<WorkflowModel.Node> reachable;
        if(target.kind()==TargetKind.SELECTED_NODE){
            List<WorkflowModel.Node> sel=target.allSelected();
            reachable=sel.size()>1?sel:List.of(selected);
        }else{
            reachable=model.upstreamIncludingMuted(selected);
        }
        List<WorkflowModel.Node> included=reachable.stream().filter(node->!node.muted).toList();
        List<String> slotIds=codeSlots(model,mode,target,included);for(String slotId:slotIds)model.codeSlot(slotId).language=language;ensureSlotsAvailable(slotIds);
        String stamp=DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS").withZone(java.time.ZoneOffset.UTC).format(Instant.now());String requestId="request-"+stamp;
        Set<String> ids=new LinkedHashSet<>();included.forEach(node->ids.add(node.id));
        List<Map<String,Object>> nodes=included.stream().map(QueueService::nodeMap).toList();
        List<Map<String,Object>> edges=model.edges().stream().filter(edge->ids.contains(edge.source())&&ids.contains(edge.target())).map(QueueService::edgeMap).toList();
        WorkflowDslService.Document document=dsl.decode(model,included,selected);String action=action(mode,target.kind());
        LinkedHashMap<String,Object> request=new LinkedHashMap<>();request.put("schemaVersion","4.0");request.put("requestId",requestId);request.put("transport","local-file-queue");request.put("createdAt",Instant.now().toString());request.put("mode",mode.wireName);request.put("action",action);
        LinkedHashMap<String,Object> targetMap=new LinkedHashMap<>();targetMap.put("kind",target.kind()==TargetKind.SELECTED_NODE?"selected-node":"group-output");if(target.kind()==TargetKind.SELECTED_NODE)targetMap.put("nodeId",selected.id);else targetMap.put("groupOutputNodeId",selected.id);targetMap.put("codeSlotIds",slotIds);LinkedHashMap<String,Object> baseRevisions=new LinkedHashMap<>();for(String slotId:slotIds)baseRevisions.put(slotId,model.codeSlot(slotId).activeRevision);targetMap.put("baseSlotRevisions",baseRevisions);request.put("target",targetMap);
        request.put("graphRevision",model.revision());request.put("language",language);request.put("entry",selected.id);request.put("expression",document.expression());request.put("dsl",Map.of("ast",document.ast()));request.put("prompt",selected.prompt);request.put("excludedNodes",reachable.stream().filter(node->node.muted).map(node->Map.of("nodeId",node.id,"reason","muted")).toList());
        request.put("output",Map.of("workspaceRoot",projectRoot.toString(),"relativePath",validateRelative(outputPath),"artifactPolicy","code-slot-draft"));request.put("execution",Map.of("compile",false,"run",false));request.put("nodes",nodes);request.put("edges",edges);request.put("requiresReview",true);request.put("requiresConfirmation",true);
        request.put("snapshotHash","sha256:"+sha256(Json.stringify(request)));

        Path staging=stateRoot.resolve("queue/staging").resolve(requestId),inbox=stateRoot.resolve("queue/inbox").resolve(requestId);Files.createDirectory(staging);Files.writeString(staging.resolve("request.json"),Json.stringify(request),StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW);Files.writeString(staging.resolve("request.md"),markdown(request,selected,included,document),StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW);try{Files.move(staging,inbox,StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException e){Files.move(staging,inbox);}
        included.forEach(node->node.status=WorkflowModel.Status.QUEUED);selected.status=WorkflowModel.Status.QUEUED;return new Submission(requestId,inbox,"处理 CodeNode 本地申请 "+requestId,slotIds);
    }

    private List<String> codeSlots(WorkflowModel model,WorkflowModel.Mode mode,SubmitTarget target,List<WorkflowModel.Node> included){
        if(mode==WorkflowModel.Mode.EXECUTABLE){List<String> ids=included.stream().filter(node->node.codeBearing).map(node->model.ensureNodeSlot(node).id).toList();if(ids.isEmpty())throw new IllegalArgumentException("提交范围没有可生成代码的节点");return ids;}
        String slotId=model.codeSlotId(target.node(),mode);
        if(slotId.isBlank()&&(target.kind()==TargetKind.GROUP_OUTPUT||target.allSelected().size()>1)){Set<String> owners=new LinkedHashSet<>();for(WorkflowModel.Node node:included){String value=model.codeSlotId(node,mode);if(!value.isBlank())owners.add(value);}if(owners.size()==1)slotId=owners.iterator().next();}
        if(slotId.isBlank())throw new IllegalArgumentException("画布已有文件节点，请先把提交目标归入一个文件节点");WorkflowModel.CodeSlot slot=slotId.equals("file:default")?model.ensureDefaultFileSlot():model.codeSlot(slotId);if(slot==null){WorkflowModel.Node file=model.byId(slotId.substring("file:".length()));slot=model.ensureFileSlot(file);}return List.of(slot.id);
    }

    @SuppressWarnings("unchecked") private void ensureSlotsAvailable(List<String> slotIds) throws IOException {for(String status:List.of("inbox","processing")){Path root=stateRoot.resolve("queue").resolve(status);try(var dirs=Files.list(root)){for(Path dir:dirs.filter(Files::isDirectory).toList()){Path file=dir.resolve("request.json");if(!Files.isRegularFile(file))continue;Map<String,Object> request=Json.object(Files.readString(file));Object raw=request.get("target");if(!(raw instanceof Map<?,?> target))continue;Object values=target.get("codeSlotIds");if(values instanceof List<?> active&&active.stream().map(String::valueOf).anyMatch(slotIds::contains))throw new IllegalStateException("目标代码槽已有排队中或制作中的申请："+dir.getFileName());}}}}

    private static String action(WorkflowModel.Mode mode,TargetKind kind){if(mode==WorkflowModel.Mode.EXECUTABLE)return kind==TargetKind.SELECTED_NODE?"build-node":"build-node-group";return kind==TargetKind.SELECTED_NODE?"build-markdown":"build-markdown-group";}
    private String validateRelative(String value){if(value==null||value.isBlank())throw new IllegalArgumentException("输出位置不能为空");Path path=Path.of(value.trim()).normalize();if(path.isAbsolute()||path.startsWith(".."))throw new IllegalArgumentException("输出位置必须是项目内的相对路径");return path.toString().replace('\\','/');}

    private static Map<String,Object> nodeMap(WorkflowModel.Node node){LinkedHashMap<String,Object> value=new LinkedHashMap<>();value.put("id",node.id);value.put("name",node.name);value.put("type",node.nodeKind.name().toLowerCase(Locale.ROOT));value.put("category",node.category);value.put("classificationKey",node.classificationKey);value.put("valueType",node.valueType);value.put("operation",node.operation);value.put("prompt",node.prompt);value.put("artifact",node.artifact);value.put("fileNodeId",node.fileNodeId);value.put("parentScopeId",node.parentScopeId);value.put("scopeRegion",node.scopeRegion);value.put("containerWidth",node.containerWidth);value.put("containerHeight",node.containerHeight);value.put("inputs",node.inputs.stream().map(QueueService::portMap).toList());value.put("outputs",node.outputs.stream().map(QueueService::portMap).toList());return value;}
    private static Map<String,Object> portMap(WorkflowModel.Port port){return Map.of("id",port.id,"name",port.name,"dataType",port.dataType,"required",port.required);}
    private static Map<String,Object> edgeMap(WorkflowModel.Edge edge){return Map.of("id",edge.id(),"source",List.of(edge.source(),edge.sourcePort()),"target",List.of(edge.target(),edge.targetPort()),"kind","data");}

    private static String markdown(Map<String,Object> request,WorkflowModel.Node target,List<WorkflowModel.Node> nodes,WorkflowDslService.Document document){
        StringBuilder text=new StringBuilder("# CodeNode Agent 制作申请 ").append(request.get("requestId")).append("\n\n- 模式：`").append(request.get("mode")).append("`\n- 动作：`").append(request.get("action")).append("`\n- 目标语言：`").append(request.get("language")).append("`\n- 目标：`").append(target.name).append("` (`").append(target.id).append("`)\n- 图修订：`").append(request.get("graphRevision")).append("`\n- 代码槽：`").append(((Map<?,?>)request.get("target")).get("codeSlotIds")).append("`\n\n## 规范化 DSL\n\n```text\n").append(document.expression()).append("\n```\n\n## 规范化 AST\n\n```json\n").append(Json.stringify(document.ast())).append("```\n\n## 节点职责\n");
        for(WorkflowModel.Node node:nodes)text.append("\n### ").append(node.name).append(" (`").append(node.id).append("`)\n\n- 类型：`").append(node.nodeKind.name().toLowerCase(Locale.ROOT)).append("`\n- 分类：`").append(node.classificationKey).append("`\n- 文件：`").append(node.fileNodeId.isBlank()?"默认/未指定":node.fileNodeId).append("`\n\n").append(node.prompt==null||node.prompt.isBlank()?"_未填写 Prompt_":node.prompt).append("\n");
        Map<?,?> targetMap=(Map<?,?>)request.get("target");Map<?,?> revisions=(Map<?,?>)targetMap.get("baseSlotRevisions");List<Object> resultSlots=new ArrayList<>();for(Object slotId:(List<?>)targetMap.get("codeSlotIds"))resultSlots.add(Map.of("slotId",slotId,"baseRevision",revisions.get(slotId),"code","<在此放入完整源代码>","classificationKey","agent.custom","language",request.get("language")));
        Map<String,Object> result=Map.of("schemaVersion","4.0","requestId",request.get("requestId"),"mode",request.get("mode"),"action",request.get("action"),"status","succeeded","summary","<制作摘要>","codeSlotResults",resultSlots,"diagnostics",List.of(),"processedAt","<ISO-8601 时间>");
        return text.append("\n## 结果约束\n\n只返回申请声明代码槽的结构化草稿；不得编译、运行、覆盖活动代码或写入项目外路径。结果必须符合：\n\n```json\n").append(Json.stringify(result)).append("```\n").toString();
    }

    private static String sha256(String value){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));}catch(Exception e){throw new IllegalStateException(e);}}
    public record Submission(String requestId,Path inboxPath,String codexPrompt,List<String> codeSlotIds){}
    public record QueueEntry(String requestId,String status,Path path){@Override public String toString(){return requestId+"   ["+status+"]";}}

    public void cancel(String requestId) throws IOException {
        if(requestId==null||requestId.isBlank())throw new IllegalArgumentException("requestId 不能为空");
        Path inbox=stateRoot.resolve("queue/inbox").resolve(requestId);
        Path processing=stateRoot.resolve("queue/processing").resolve(requestId);
        Path cancelled=stateRoot.resolve("queue/cancelled").resolve(requestId);
        if(Files.isDirectory(cancelled))return;
        if(Files.isDirectory(inbox)){
            try{Files.move(inbox,cancelled,StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException e){Files.move(inbox,cancelled);}
            return;
        }
        if(Files.isDirectory(processing)){
            try{Files.move(processing,cancelled,StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException e){Files.move(processing,cancelled);}
            return;
        }
        throw new NoSuchFileException("申请不在 inbox 或 processing："+requestId);
    }
}
