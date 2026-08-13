package local.codenode;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.zip.*;
import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentInfoSnapshot;
import local.codenode.agent.knowledge.KnowledgeGraph;

public final class CnodeProjectCodec {
    public static final String FORMAT_VERSION="1.1";
    public static final String MIME="application/vnd.codenode.project+zip";
    private static final int MAX_NODES=10_000,MAX_EDGES=50_000,MAX_ENTRY=20*1024*1024,MAX_TOTAL=100*1024*1024,MAX_PROMPT=1024*1024;
    private static final Set<String> REQUIRED=Set.of("mimetype","manifest.json","graph.json","workspace.json","output-profiles.json","integrity.json");
    private static final Set<String> OPTIONAL=Set.of("agent-context.json","agent-info.json","knowledge-graph.dsl","knowledge-meta.json");

    public record Settings(WorkflowModel.Mode mode,String language,String executablePath,String markdownPath,String entryNodeId,int panX,int panY,double zoom,String selectedNodeId,List<String> selectedNodeIds,String currentGroupId) {
        public Settings(WorkflowModel.Mode mode,String language,String executablePath,String markdownPath,String entryNodeId,int panX,int panY,double zoom,String selectedNodeId){this(mode,language,executablePath,markdownPath,entryNodeId,panX,panY,zoom,selectedNodeId,selectedNodeId==null?List.of():List.of(selectedNodeId),"");}
        public Settings(WorkflowModel.Mode mode,String language,String executablePath,String markdownPath,String entryNodeId,int panX,int panY,double zoom,String selectedNodeId,List<String> selectedNodeIds){this(mode,language,executablePath,markdownPath,entryNodeId,panX,panY,zoom,selectedNodeId,selectedNodeIds,"");}
        public Settings{selectedNodeIds=selectedNodeIds==null?List.of():List.copyOf(selectedNodeIds);if(selectedNodeId==null&&!selectedNodeIds.isEmpty())selectedNodeId=selectedNodeIds.getLast();currentGroupId=currentGroupId==null?"":currentGroupId;}
    }
    public record Metadata(String documentId,String name,Instant createdAt,Settings settings) {}
    public record Loaded(WorkflowModel model,Metadata metadata,boolean readOnly) {}

    public void save(Path target,WorkflowModel model,Metadata metadata) throws IOException {
        save(target, model, metadata, null, null, null);
    }

    public void save(Path target, WorkflowModel model, Metadata metadata, AgentContext agentContext, AgentInfoSnapshot agentInfo) throws IOException {
        save(target, model, metadata, agentContext, agentInfo, null);
    }

    public void save(Path target, WorkflowModel model, Metadata metadata, AgentContext agentContext,
                     AgentInfoSnapshot agentInfo, KnowledgeGraph knowledgeGraph) throws IOException {
        Objects.requireNonNull(target);Objects.requireNonNull(model);Objects.requireNonNull(metadata);validateModel(model);
        Path absolute=target.toAbsolutePath().normalize();Path parent=absolute.getParent();if(parent==null)throw new IOException("工程文件缺少父目录");Files.createDirectories(parent);
        Path temporary=parent.resolve(absolute.getFileName()+".tmp-"+UUID.randomUUID());
        try{
            writeArchive(temporary,model,metadata,agentContext,agentInfo,knowledgeGraph);
            try(FileChannel channel=FileChannel.open(temporary,StandardOpenOption.WRITE)){channel.force(true);}
            load(temporary);
            if(Files.exists(absolute))Files.copy(absolute,backupPath(absolute),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.COPY_ATTRIBUTES);
            try{Files.move(temporary,absolute,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
            catch(AtomicMoveNotSupportedException e){Files.move(temporary,absolute,StandardCopyOption.REPLACE_EXISTING);}
        }finally{Files.deleteIfExists(temporary);}
    }

    public Loaded load(Path source) throws IOException {
        Path absolute=source.toAbsolutePath().normalize();Map<String,byte[]> entries=readArchive(absolute);
        if(!entries.keySet().containsAll(REQUIRED))throw new IOException(".cnode 缺少必需条目："+missing(entries.keySet()));
        if(!MIME.equals(text(entries,"mimetype")))throw new IOException("不是有效的 CodeNode 工程文件");
        verifyIntegrity(entries);
        Map<String,Object> manifest=Json.object(text(entries,"manifest.json"));
        if(!"codenode-project".equals(manifest.get("format")))throw new IOException("不支持的工程格式");
        String version=string(manifest,"formatVersion");int major=parseMajor(version);if(major<1)throw new IOException("不支持的旧工程版本："+version);boolean readOnly=major>1;
        Map<String,Object> graph=Json.object(text(entries,"graph.json"));Map<String,Object> workspace=Json.object(text(entries,"workspace.json"));Map<String,Object> profiles=Json.object(text(entries,"output-profiles.json"));
        WorkflowModel model=decodeGraph(graph,workspace);
        String documentId=requiredId(string(manifest,"documentId"),"documentId");String name=string(manifest,"name");Instant created=parseInstant(string(manifest,"createdAt"));
        Settings settings=decodeSettings(workspace,profiles);if(!settings.currentGroupId().isBlank()){WorkflowModel.Node currentGroup=model.byId(settings.currentGroupId());if(currentGroup==null||currentGroup.nodeKind!=WorkflowModel.NodeKind.GROUP)settings=new Settings(settings.mode(),settings.language(),settings.executablePath(),settings.markdownPath(),settings.entryNodeId(),settings.panX(),settings.panY(),settings.zoom(),settings.selectedNodeId(),settings.selectedNodeIds(),"");}for(String selectedNodeId:settings.selectedNodeIds())if(model.byId(selectedNodeId)==null)throw new IOException("选择状态引用不存在的节点");if(settings.entryNodeId()!=null&&model.byId(settings.entryNodeId())==null)throw new IOException("入口配置引用不存在的节点");return new Loaded(model,new Metadata(documentId,name,created,settings),readOnly);
    }

    public static Path backupPath(Path project){return project.resolveSibling(project.getFileName()+".bak");}

    public Optional<AgentContext> loadAgentContext(Path source) throws IOException {
        Map<String,byte[]> entries=readVerifiedArchive(source); byte[] data=entries.get("agent-context.json");
        if(data==null)return Optional.empty();
        try{return Optional.of(AgentContext.fromMap(Json.object(new String(data,StandardCharsets.UTF_8))));}
        catch(RuntimeException e){throw new IOException("agent-context.json 无效",e);}
    }
    public Optional<AgentInfoSnapshot> loadAgentInfo(Path source) throws IOException {
        Map<String,byte[]> entries=readVerifiedArchive(source); byte[] data=entries.get("agent-info.json");
        if(data==null)return Optional.empty();
        try{return Optional.of(AgentInfoSnapshot.fromJson(Json.object(new String(data,StandardCharsets.UTF_8))));}
        catch(RuntimeException e){throw new IOException("agent-info.json 无效",e);}
    }
    public KnowledgeGraph loadKnowledgeGraph(Path source) throws IOException {
        Map<String,byte[]> entries=readArchive(source); byte[] data=entries.get("knowledge-graph.dsl");
        return data==null ? new KnowledgeGraph() : KnowledgeGraph.parse(new String(data, StandardCharsets.UTF_8));
    }
    public static byte[] encodeAgentContext(AgentContext context) { return context == null ? new byte[0] : context.toJsonBytes(); }
    public static AgentContext decodeAgentContext(byte[] bytes) throws IOException { if (bytes == null) throw new IOException("agent-context 为空"); try{return AgentContext.fromMap(Json.object(new String(bytes,StandardCharsets.UTF_8)));}catch(RuntimeException e){throw new IOException("agent-context 无效",e);} }

    private void writeArchive(Path target,WorkflowModel model,Metadata metadata,AgentContext agentContext,
                              AgentInfoSnapshot agentInfo, KnowledgeGraph knowledgeGraph) throws IOException {
        Settings settings=metadata.settings();Instant now=Instant.now();
        LinkedHashMap<String,byte[]> files=new LinkedHashMap<>();
        files.put("manifest.json",bytes(Json.stringify(manifest(metadata,now))));
        files.put("graph.json",bytes(Json.stringify(graph(model))));
        files.put("workspace.json",bytes(Json.stringify(workspace(model,settings))));
        files.put("output-profiles.json",bytes(Json.stringify(profiles(settings))));
        if (agentContext != null) files.put("agent-context.json", agentContext.toJsonBytes());
        if (agentInfo != null) files.put("agent-info.json", agentInfo.toJsonBytes());
        if (knowledgeGraph != null && !knowledgeGraph.isEmpty()) {
            files.put("knowledge-graph.dsl", bytes(knowledgeGraph.toDsl()));
            files.put("knowledge-meta.json", bytes(Json.stringify(Map.of(
                    "schemaVersion", 1,
                    "cache", true,
                    "generatedAt", now.toString(),
                    "elementCount", knowledgeGraph.size(),
                    "roots", knowledgeGraph.roots()))));
        }
        files.put("integrity.json",bytes(Json.stringify(integrity(files))));
        try(OutputStream raw=Files.newOutputStream(target,StandardOpenOption.CREATE_NEW);ZipOutputStream zip=new ZipOutputStream(raw,StandardCharsets.UTF_8)){
            byte[] mime=bytes(MIME);CRC32 crc=new CRC32();crc.update(mime);ZipEntry marker=new ZipEntry("mimetype");marker.setMethod(ZipEntry.STORED);marker.setSize(mime.length);marker.setCompressedSize(mime.length);marker.setCrc(crc.getValue());zip.putNextEntry(marker);zip.write(mime);zip.closeEntry();
            for(var file:files.entrySet()){ZipEntry entry=new ZipEntry(file.getKey());zip.putNextEntry(entry);zip.write(file.getValue());zip.closeEntry();}
        }
    }

    private static Map<String,Object> manifest(Metadata metadata,Instant modified) throws IOException {
        LinkedHashMap<String,Object> value=new LinkedHashMap<>();value.put("format","codenode-project");value.put("formatVersion",FORMAT_VERSION);value.put("documentId",requiredId(metadata.documentId(),"documentId"));value.put("name",metadata.name());value.put("createdAt",metadata.createdAt().toString());value.put("modifiedAt",modified.toString());value.put("generator",Map.of("application","CodeNode Desktop","version","0.5.0"));value.put("minimumReaderVersion","0.4.0");return value;
    }

    private static Map<String,Object> graph(WorkflowModel model){
        List<Map<String,Object>> nodes=new ArrayList<>();for(WorkflowModel.Node node:model.nodes()){
            LinkedHashMap<String,Object> value=new LinkedHashMap<>();value.put("id",node.id);value.put("name",node.name);value.put("category",node.category);value.put("prompt",node.prompt);value.put("artifact",node.artifact);
            value.put("nodeKind",node.nodeKind.name().toLowerCase(Locale.ROOT));value.put("valueType",node.valueType);value.put("operation",node.operation);value.put("classificationKey",node.classificationKey);value.put("codeBearing",node.codeBearing);
            value.put("scope",Map.of("parentId",node.parentScopeId,"region",node.scopeRegion,"width",node.containerWidth,"height",node.containerHeight));value.put("file",Map.of("ownerId",node.fileNodeId,"relativePath",node.relativePath,"role",node.role));
            value.put("template",Map.of("library",node.templateLibrary,"id",node.templateId,"version",node.templateVersion,"language",node.templateLanguage));value.put("flags",Map.of("muted",node.muted,"collapsed",node.collapsed,"detailMode",node.detailMode));value.put("inputs",node.inputs.stream().map(port->port(port,"single")).toList());value.put("outputs",node.outputs.stream().map(port->port(port,"multiple")).toList());
            value.put("nodeColor",node.nodeColor);value.put("rangeMode",node.rangeMode);value.put("assetType",node.assetType);value.put("bundleData",node.bundleData);value.put("groupInputNodeId",node.groupInputNodeId);
            if(!node.bundleCollapsed)value.put("bundleCollapsed",false);
            value.put("nodeWidth",node.nodeWidth);value.put("nodeHeight",node.nodeHeight);
            nodes.add(value);
        }
        List<Map<String,Object>> edges=model.edges().stream().map(edge->Map.<String,Object>of("id",edge.id(),"source",Map.of("nodeId",edge.source(),"portId",edge.sourcePort()),"target",Map.of("nodeId",edge.target(),"portId",edge.targetPort()),"kind","data","reroutes",edge.reroutes().stream().map(CnodeProjectCodec::reroute).toList())).toList();
        List<Map<String,Object>> slots=model.codeSlots().stream().map(CnodeProjectCodec::slot).toList();
        model.refreshFileSpaces();
        List<Map<String,Object>> spaces=fileSpacesSection(model);
        return Map.of("revision",model.revision(),"nodes",nodes,"edges",edges,"codeSlots",slots,"fileSpaces",spaces);
    }
    private static Map<String,Object> slot(WorkflowModel.CodeSlot slot){LinkedHashMap<String,Object> value=new LinkedHashMap<>();value.put("id",slot.id);value.put("ownerKind",slot.ownerKind);value.put("ownerId",slot.ownerId);value.put("language",slot.language);value.put("activeRevision",slot.activeRevision);value.put("activeCode",slot.activeCode);value.put("previousCode",slot.previousCode);value.put("previousSourceRevision",slot.previousSourceRevision);value.put("lastAppliedRequestId",slot.lastAppliedRequestId);if(slot.draft!=null)value.put("draft",Map.of("requestId",slot.draft.requestId,"baseRevision",slot.draft.baseRevision,"code",slot.draft.code,"classificationKey",slot.draft.classificationKey));return value;}
    private static Map<String,Object> reroute(WorkflowModel.Reroute point){return Map.of("id",point.id,"x",point.x,"y",point.y);}
    private static List<Map<String,Object>> fileSpacesSection(WorkflowModel model){
        List<Map<String,Object>> list=new ArrayList<>();
        for(WorkflowModel.VirtualFileSpace space:model.fileSpaces()){
            LinkedHashMap<String,Object> s=new LinkedHashMap<>();
            s.put("id",space.id);s.put("name",space.name);
            s.put("fileNodeId",space.fileNodeId==null?"":space.fileNodeId);
            s.put("slotId",space.slotId==null?"":space.slotId);
            s.put("includedNodeIds",List.copyOf(space.includedNodeIds));
            s.put("relation",space.relation==null?"PARALLEL":space.relation.name());
            s.put("relatedSpaceIds",List.copyOf(space.relatedSpaceIds));
            s.put("groupOutputNodeIds",List.copyOf(space.groupOutputNodeIds));
            list.add(s);
        }
        return list;
    }
    private static Map<String,Object> port(WorkflowModel.Port port,String cardinality){return Map.of("id",port.id,"name",port.name,"declaredType",normalized(port.declaredType),"required",port.required,"cardinality",cardinality);}

    private static Map<String,Object> workspace(WorkflowModel model,Settings settings){
        LinkedHashMap<String,Object> views=new LinkedHashMap<>();for(WorkflowModel.Node node:model.nodes())views.put(node.id,Map.of("x",node.x,"y",node.y));
        return Map.of("viewport",Map.of("x",settings.panX(),"y",settings.panY(),"zoom",settings.zoom()),"nodeViews",views,"selection",Map.of("nodeIds",settings.selectedNodeIds(),"edgeIds",List.of()),"activeMode",settings.mode().wireName,"activeLanguage",settings.language(),"currentGroupId",settings.currentGroupId());
    }
    private static Map<String,Object> profiles(Settings settings){
        return Map.of("executableWorkflow",Map.of("entryNodeId",settings.entryNodeId()==null?"":settings.entryNodeId(),"relativePath",settings.executablePath(),"language",settings.language(),"compile",false,"run",false),"markdownBlueprint",Map.of("scope","project","targetNodeId","","relativePath",settings.markdownPath(),"language",settings.language(),"includeGraphSummary",true,"includeNodePrompts",true));
    }
    private static Map<String,Object> integrity(Map<String,byte[]> files){LinkedHashMap<String,Object> hashes=new LinkedHashMap<>();files.forEach((name,data)->hashes.put(name,sha256(data)));return Map.of("algorithm","SHA-256","files",hashes);}

    private static WorkflowModel decodeGraph(Map<String,Object> graph,Map<String,Object> workspace) throws IOException {
        List<?> rawNodes=list(graph,"nodes");List<?> rawEdges=list(graph,"edges");if(rawNodes.size()>MAX_NODES)throw new IOException("节点数量超过限制");if(rawEdges.size()>MAX_EDGES)throw new IOException("连线数量超过限制");
        Map<String,Object> views=object(workspace,"nodeViews");List<WorkflowModel.Node> nodes=new ArrayList<>();Set<String> ids=new HashSet<>();
        for(Object item:rawNodes){Map<String,Object> raw=object(item,"node");String id=requiredId(string(raw,"id"),"node.id");if(!ids.add(id))throw new IOException("重复节点 ID："+id);Map<String,Object> view=object(views.get(id),"nodeViews."+id);WorkflowModel.Node node=new WorkflowModel.Node(id,string(raw,"name"),integer(view,"x"),integer(view,"y"));node.category=string(raw,"category");node.prompt=string(raw,"prompt");if(bytes(node.prompt).length>MAX_PROMPT)throw new IOException("节点 Prompt 超过 1 MiB："+id);node.artifact=relative(string(raw,"artifact"),"artifact");
            node.nodeKind=parseNodeKind(optionalString(raw,"nodeKind","regular"));node.valueType=optionalString(raw,"valueType","any");node.operation=optionalString(raw,"operation","");node.classificationKey=optionalString(raw,"classificationKey",classificationForLegacy(node.category));node.codeBearing=optionalBoolean(raw,"codeBearing",node.nodeKind==WorkflowModel.NodeKind.REGULAR||node.nodeKind==WorkflowModel.NodeKind.CONDITION||node.nodeKind==WorkflowModel.NodeKind.CALCULATION);
            Map<String,Object> scope=optionalObject(raw,"scope");node.parentScopeId=optionalString(scope,"parentId","");node.scopeRegion=optionalString(scope,"region","body");node.containerWidth=(int)optionalLong(scope,"width",520);node.containerHeight=(int)optionalLong(scope,"height",320);Map<String,Object> file=optionalObject(raw,"file");node.fileNodeId=optionalString(file,"ownerId","");node.relativePath=optionalString(file,"relativePath","");node.role=optionalString(file,"role","");
            Map<String,Object> template=object(raw,"template");node.templateLibrary=string(template,"library");node.templateId=string(template,"id");node.templateVersion=string(template,"version");node.templateLanguage=string(template,"language");            Map<String,Object> flags=object(raw,"flags");node.muted=bool(flags,"muted");node.collapsed=bool(flags,"collapsed");node.detailMode=optionalBoolean(flags,"detailMode",false);node.inputs.clear();node.outputs.clear();decodePorts(list(raw,"inputs"),node.inputs,id);decodePorts(list(raw,"outputs"),node.outputs,id);
            node.nodeColor=optionalString(raw,"nodeColor","");node.rangeMode=optionalBoolean(raw,"rangeMode",false);node.assetType=optionalString(raw,"assetType","");node.bundleData=optionalString(raw,"bundleData","");node.groupInputNodeId=optionalString(raw,"groupInputNodeId","");node.bundleCollapsed=optionalBoolean(raw,"bundleCollapsed",true);
            node.nodeWidth=(int)optionalLong(raw,"nodeWidth",215);node.nodeHeight=(int)optionalLong(raw,"nodeHeight",92);
            nodes.add(node);
        }
        Map<String,WorkflowModel.Node> nodeById=new HashMap<>();nodes.forEach(n->nodeById.put(n.id,n));List<WorkflowModel.Edge> edges=new ArrayList<>();Set<String> edgeIds=new HashSet<>();Map<String,WorkflowModel.Reroute> reroutesById=new HashMap<>();
        for(Object item:rawEdges){Map<String,Object> raw=object(item,"edge");String id=requiredId(string(raw,"id"),"edge.id");if(!edgeIds.add(id))throw new IOException("重复连线 ID："+id);Map<String,Object> source=object(raw,"source"),target=object(raw,"target");String sourceNode=string(source,"nodeId"),sourcePort=string(source,"portId"),targetNode=string(target,"nodeId"),targetPort=string(target,"portId");WorkflowModel.Node from=nodeById.get(sourceNode),to=nodeById.get(targetNode);if(from==null||to==null||from.outputs.stream().noneMatch(p->p.id.equals(sourcePort))||to.inputs.stream().noneMatch(p->p.id.equals(targetPort)))throw new IOException("连线引用不存在的节点或端口："+id);List<WorkflowModel.Reroute> reroutes=new ArrayList<>();Object rawReroutes=raw.get("reroutes");if(rawReroutes instanceof List<?> points){if(points.size()>10_000)throw new IOException("整理点数量超过限制："+id);for(Object point:points){Map<String,Object> position=object(point,"reroute");String pointId=position.containsKey("id")?requiredId(string(position,"id"),"reroute.id"):"reroute-"+UUID.randomUUID();int x=integer(position,"x"),y=integer(position,"y");WorkflowModel.Reroute reroute=reroutesById.get(pointId);if(reroute!=null&&(reroute.x!=x||reroute.y!=y))throw new IOException("共享整理点坐标不一致："+pointId);if(reroute==null){reroute=new WorkflowModel.Reroute(pointId,x,y);reroutesById.put(pointId,reroute);}reroutes.add(reroute);}}edges.add(new WorkflowModel.Edge(id,sourceNode,sourcePort,targetNode,targetPort,reroutes));}
        List<WorkflowModel.CodeSlot> slots=new ArrayList<>();Object rawSlots=graph.get("codeSlots");if(rawSlots instanceof List<?> values)for(Object item:values){Map<String,Object> raw=object(item,"codeSlot");String id=requiredId(string(raw,"id"),"codeSlot.id");WorkflowModel.CodeSlot slot=new WorkflowModel.CodeSlot(id,string(raw,"ownerKind"),string(raw,"ownerId"));slot.language=optionalString(raw,"language","java");slot.activeRevision=optionalLong(raw,"activeRevision",0);slot.activeCode=optionalString(raw,"activeCode","");slot.previousCode=optionalString(raw,"previousCode","");slot.previousSourceRevision=optionalLong(raw,"previousSourceRevision",-1);slot.lastAppliedRequestId=optionalString(raw,"lastAppliedRequestId","");Map<String,Object> draft=optionalObject(raw,"draft");if(!draft.isEmpty())slot.draft=new WorkflowModel.CodeDraft(string(draft,"requestId"),optionalLong(draft,"baseRevision",slot.activeRevision),string(draft,"code"),string(draft,"classificationKey"));slots.add(slot);}
        WorkflowModel model=new WorkflowModel();model.replaceContents(nodes,edges,slots,optionalLong(graph,"revision",0));decodeFileSpaces(model,graph);validateModel(model);return model;
    }
    private static void decodePorts(List<?> values,List<WorkflowModel.Port> target,String nodeId) throws IOException {Set<String> ids=new HashSet<>();for(Object item:values){Map<String,Object> raw=object(item,"port");String id=requiredId(string(raw,"id"),"port.id");if(!ids.add(id))throw new IOException("节点端口 ID 重复："+nodeId+"/"+id);String type=normalized(string(raw,"declaredType"));target.add(new WorkflowModel.Port(id,string(raw,"name"),type,type,bool(raw,"required")));}}
    private static void decodeFileSpaces(WorkflowModel model,Map<String,Object> graph) throws IOException {
        Object rawSpaces=graph.get("fileSpaces");
        if(rawSpaces instanceof List<?> values&&!values.isEmpty()){
            for(Object item:values){
                Map<String,Object> raw=object(item,"fileSpace");
                String id=requiredId(string(raw,"id"),"fileSpace.id");
                String name=optionalString(raw,"name",id);
                String fileNodeId=optionalString(raw,"fileNodeId","");
                if(fileNodeId.isBlank())fileNodeId=null;
                WorkflowModel.SpaceRelation relation=parseSpaceRelation(raw);
                WorkflowModel.VirtualFileSpace space=new WorkflowModel.VirtualFileSpace(id,name,fileNodeId);
                space.relation=relation;
                space.slotId=optionalString(raw,"slotId","");if(space.slotId.isBlank())space.slotId=null;
                Object rawIncluded=raw.get("includedNodeIds");
                if(rawIncluded instanceof List<?> inc){for(Object i:inc){if(i instanceof String s){if(model.byId(s)!=null)space.includedNodeIds.add(s);}else throw new IOException("fileSpace.includedNodeIds 元素必须是字符串");}}
                else if(rawIncluded!=null)throw new IOException("fileSpace.includedNodeIds 必须是数组");
                Object rawRelated=raw.get("relatedSpaceIds");
                if(rawRelated instanceof List<?> rel){for(Object r:rel){if(r instanceof String s)space.relatedSpaceIds.add(s);else throw new IOException("fileSpace.relatedSpaceIds 元素必须是字符串");}}
                else if(rawRelated!=null)throw new IOException("fileSpace.relatedSpaceIds 必须是数组");
                Object rawGroupOuts=raw.get("groupOutputNodeIds");
                if(rawGroupOuts instanceof List<?> gouts){for(Object g:gouts){if(g instanceof String s){if(model.byId(s)!=null)space.groupOutputNodeIds.add(s);}else throw new IOException("fileSpace.groupOutputNodeIds 元素必须是字符串");}}
                else if(rawGroupOuts!=null)throw new IOException("fileSpace.groupOutputNodeIds 必须是数组");
                model.putFileSpace(space);
            }
        }else{
            model.refreshFileSpaces();
        }
    }
    private static WorkflowModel.SpaceRelation parseSpaceRelation(Map<String,Object> raw) throws IOException {
        String value=optionalString(raw,"relation","PARALLEL");
        try{return WorkflowModel.SpaceRelation.valueOf(value.toUpperCase(Locale.ROOT));}
        catch(IllegalArgumentException e){return WorkflowModel.SpaceRelation.PARALLEL;}
    }

    private static Settings decodeSettings(Map<String,Object> workspace,Map<String,Object> profiles) throws IOException {
        String modeName=string(workspace,"activeMode");WorkflowModel.Mode mode=null;for(WorkflowModel.Mode candidate:WorkflowModel.Mode.values())if(candidate.wireName.equals(modeName))mode=candidate;if(mode==null)throw new IOException("未知工作模式");String language=language(string(workspace,"activeLanguage"));Map<String,Object> viewport=object(workspace,"viewport"),selection=object(workspace,"selection"),executable=object(profiles,"executableWorkflow"),markdown=object(profiles,"markdownBlueprint");List<String> selectedIds=list(selection,"nodeIds").stream().map(String::valueOf).toList();String selectedId=selectedIds.isEmpty()?null:selectedIds.getLast();String entry=string(executable,"entryNodeId");if(entry.isBlank())entry=null;double zoom=number(viewport,"zoom");if(zoom<.25||zoom>2.5)throw new IOException("画布缩放超出范围");return new Settings(mode,language,relative(string(executable,"relativePath"),"executable output"),relative(string(markdown,"relativePath"),"markdown output"),entry,integer(viewport,"x"),integer(viewport,"y"),zoom,selectedId,selectedIds,optionalString(workspace,"currentGroupId",""));
    }

    private static Map<String,byte[]> readArchive(Path source) throws IOException {
        if(!Files.isRegularFile(source))throw new IOException("工程文件不存在："+source);LinkedHashMap<String,byte[]> entries=new LinkedHashMap<>();int total=0;boolean first=true;
        try(InputStream raw=Files.newInputStream(source);ZipInputStream zip=new ZipInputStream(raw,StandardCharsets.UTF_8)){for(ZipEntry entry;(entry=zip.getNextEntry())!=null;){String name=entry.getName();if(first&&!"mimetype".equals(name))throw new IOException("mimetype 必须是第一个条目");first=false;safeEntry(name);if(entry.isDirectory())continue;if(entries.containsKey(name))throw new IOException("ZIP 包含重复条目："+name);ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int size=0;for(int read;(read=zip.read(buffer))>=0;){size+=read;total+=read;if(size>MAX_ENTRY||total>MAX_TOTAL)throw new IOException(".cnode 内容超过大小限制");out.write(buffer,0,read);}entries.put(name,out.toByteArray());}}
        return entries;
    }
    private static void safeEntry(String name) throws IOException {if(name.isBlank()||name.startsWith("/")||name.startsWith("\\")||name.contains("..")||name.contains(":")||name.contains("\\"))throw new IOException("非法 ZIP 路径："+name);if(!REQUIRED.contains(name)&&!OPTIONAL.contains(name)&&!name.startsWith("assets/")&&!name.startsWith("extensions/"))throw new IOException("未知的工程条目："+name);}
    private static Map<String,byte[]> readVerifiedArchive(Path source) throws IOException {
        Map<String,byte[]> entries=readArchive(source);
        if(!entries.keySet().containsAll(REQUIRED))throw new IOException(".cnode missing required entries: "+missing(entries.keySet()));
        if(!MIME.equals(text(entries,"mimetype")))throw new IOException("Invalid CodeNode project file");
        verifyIntegrity(entries);
        return entries;
    }
    private static void verifyIntegrity(Map<String,byte[]> entries) throws IOException {Map<String,Object> integrity=Json.object(text(entries,"integrity.json"));if(!"SHA-256".equals(integrity.get("algorithm")))throw new IOException("不支持的摘要算法");Map<String,Object> hashes=object(integrity,"files");for(var entry:entries.entrySet()){String name=entry.getKey();if(name.equals("mimetype")||name.equals("integrity.json"))continue;if(!sha256(entry.getValue()).equals(hashes.get(name)))throw new IOException("工程文件摘要校验失败："+name);}for(String name:hashes.keySet())if(!entries.containsKey(name))throw new IOException("摘要引用不存在的工程条目："+name);}
    private static void validateModel(WorkflowModel model) throws IOException {if(model.nodes().size()>MAX_NODES||model.edges().size()>MAX_EDGES||model.reroutes().size()>50_000)throw new IOException("工程规模超过限制");Set<String> ids=new HashSet<>();for(WorkflowModel.Node node:model.nodes()){requiredId(node.id,"node.id");if(!ids.add(node.id))throw new IOException("重复节点 ID："+node.id);if(bytes(node.prompt).length>MAX_PROMPT)throw new IOException("节点 Prompt 超过 1 MiB："+node.id);relative(node.artifact,"artifact");if(node.nodeKind==WorkflowModel.NodeKind.FILE&&!node.rangeMode||node.nodeKind==WorkflowModel.NodeKind.ASSET)relative(node.relativePath,"relativePath");if(!NodeRegistry.isKnown(node.classificationKey))throw new IOException("未知节点分类："+node.classificationKey);Set<String> ports=new HashSet<>();for(WorkflowModel.Port port:node.inputs)if(!ports.add(requiredId(port.id,"port.id")))throw new IOException("重复端口 ID："+node.id+"/"+port.id);ports.clear();for(WorkflowModel.Port port:node.outputs)if(!ports.add(requiredId(port.id,"port.id")))throw new IOException("重复端口 ID："+node.id+"/"+port.id);}for(WorkflowModel.Node node:model.nodes()){if(!node.parentScopeId.isBlank()){WorkflowModel.Node parent=model.byId(node.parentScopeId);if(parent==null||(parent.nodeKind!=WorkflowModel.NodeKind.SCOPE&&parent.nodeKind!=WorkflowModel.NodeKind.GROUP))throw new IOException("父范围不存在："+node.id);validateScopeChain(model,node);}if(!node.fileNodeId.isBlank()){WorkflowModel.Node file=model.byId(node.fileNodeId);if(file==null||(file.nodeKind!=WorkflowModel.NodeKind.FILE&&file.nodeKind!=WorkflowModel.NodeKind.ASSET&&file.nodeKind!=WorkflowModel.NodeKind.ASSET_BUNDLE&&file.nodeKind!=WorkflowModel.NodeKind.GROUP)||file==node)throw new IOException("文件归属不存在："+node.id);}}for(WorkflowModel.Edge edge:model.edges()){WorkflowModel.Node from=model.byId(edge.source()),to=model.byId(edge.target());if(from==null||to==null||model.output(from,edge.sourcePort())==null||model.input(to,edge.targetPort())==null)throw new IOException("连线引用不存在的节点或端口："+edge.id());}for(WorkflowModel.Reroute point:model.reroutes())requiredId(point.id,"reroute.id");}
    private static void validateScopeChain(WorkflowModel model,WorkflowModel.Node node) throws IOException {Set<String> seen=new HashSet<>();WorkflowModel.Node current=node;while(current!=null&&!current.parentScopeId.isBlank()){if(!seen.add(current.id))throw new IOException("范围包含形成循环："+node.id);current=model.byId(current.parentScopeId);}if(current!=null&&!seen.add(current.id))throw new IOException("范围包含形成循环："+node.id);}

    private static String language(String value) throws IOException {if(!Set.of("java","powershell","go").contains(value))throw new IOException("不支持的语言："+value);return value;}
    private static String relative(String value,String field) throws IOException {if(value==null||value.isBlank())throw new IOException(field+" 不能为空");Path path;try{path=Path.of(value).normalize();}catch(InvalidPathException e){throw new IOException(field+" 路径无效",e);}if(path.isAbsolute()||path.startsWith(".."))throw new IOException(field+" 必须是工程内相对路径");return path.toString().replace('\\','/');}
    private static String requiredId(String value,String field) throws IOException {if(value==null||!value.matches("[A-Za-z0-9._:-]{1,200}"))throw new IOException(field+" 无效");return value;}
    private static int parseMajor(String version) throws IOException {try{return Integer.parseInt(version.split("\\.")[0]);}catch(Exception e){throw new IOException("无效格式版本："+version,e);}}
    private static Instant parseInstant(String value) throws IOException {try{return Instant.parse(value);}catch(Exception e){throw new IOException("无效时间："+value,e);}}
    private static String missing(Set<String> present){return REQUIRED.stream().filter(name->!present.contains(name)).toList().toString();}
    private static String normalized(String value){return value==null||value.isBlank()?"any":value;}
    private static WorkflowModel.NodeKind parseNodeKind(String value) throws IOException {try{return WorkflowModel.NodeKind.valueOf(value.toUpperCase(Locale.ROOT));}catch(Exception e){throw new IOException("未知节点类型："+value,e);}}
    private static String classificationForLegacy(String category){String value=category==null?"":category.toLowerCase(Locale.ROOT);if(value.contains("数值"))return "value.scalar";if(value.contains("输出")||value.contains("输入"))return "io.input";return "foundation.object";}
    private static byte[] bytes(String value){return value.getBytes(StandardCharsets.UTF_8);}
    private static String text(Map<String,byte[]> entries,String name) throws IOException {byte[] data=entries.get(name);if(data==null)throw new IOException("缺少 "+name);return new String(data,StandardCharsets.UTF_8).stripTrailing();}
    private static String sha256(byte[] data){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));}catch(Exception e){throw new IllegalStateException(e);}}
    private static String string(Map<String,Object> map,String key) throws IOException {Object value=map.get(key);if(!(value instanceof String text))throw new IOException("字段 "+key+" 必须是字符串");return text;}
    private static boolean bool(Map<String,Object> map,String key) throws IOException {Object value=map.get(key);if(!(value instanceof Boolean flag))throw new IOException("字段 "+key+" 必须是布尔值");return flag;}
    private static int integer(Map<String,Object> map,String key) throws IOException {Object value=map.get(key);if(!(value instanceof Number number))throw new IOException("字段 "+key+" 必须是数字");return number.intValue();}
    private static double number(Map<String,Object> map,String key) throws IOException {Object value=map.get(key);if(!(value instanceof Number number))throw new IOException("字段 "+key+" 必须是数字");return number.doubleValue();}
    private static long optionalLong(Map<String,Object> map,String key,long fallback) throws IOException {Object value=map.get(key);if(value==null)return fallback;if(!(value instanceof Number number))throw new IOException("字段 "+key+" 必须是数字");return number.longValue();}
    private static String optionalString(Map<String,Object> map,String key,String fallback) throws IOException {Object value=map.get(key);if(value==null)return fallback;if(!(value instanceof String text))throw new IOException("字段 "+key+" 必须是字符串");return text;}
    private static boolean optionalBoolean(Map<String,Object> map,String key,boolean fallback) throws IOException {Object value=map.get(key);if(value==null)return fallback;if(!(value instanceof Boolean flag))throw new IOException("字段 "+key+" 必须是布尔值");return flag;}
    @SuppressWarnings("unchecked") private static Map<String,Object> optionalObject(Map<String,Object> map,String key) throws IOException {Object value=map.get(key);if(value==null)return Map.of();if(!(value instanceof Map<?,?> object))throw new IOException("字段 "+key+" 必须是对象");return (Map<String,Object>)object;}
    private static List<?> list(Map<String,Object> map,String key) throws IOException {Object value=map.get(key);if(!(value instanceof List<?> list))throw new IOException("字段 "+key+" 必须是数组");return list;}
    @SuppressWarnings("unchecked") private static Map<String,Object> object(Map<String,Object> map,String key) throws IOException {return object(map.get(key),key);}
    @SuppressWarnings("unchecked") private static Map<String,Object> object(Object value,String field) throws IOException {if(!(value instanceof Map<?,?> map))throw new IOException("字段 "+field+" 必须是对象");return (Map<String,Object>)map;}
}
