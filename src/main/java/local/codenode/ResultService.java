package local.codenode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public final class ResultService {
    private final Path stateRoot;
    private final Path resultsRoot;
    private final Set<Path> seen=new HashSet<>();
    private final CodeSlotService slots=new CodeSlotService();
    public ResultService(Path stateRoot){this.stateRoot=stateRoot;this.resultsRoot=stateRoot.resolve("results");}

    @SuppressWarnings("unchecked")
    public List<String> poll(WorkflowModel model) throws IOException {
        List<String> notices=new ArrayList<>();if(!Files.isDirectory(resultsRoot))return notices;
        try(var dirs=Files.list(resultsRoot)){for(Path dir:dirs.filter(Files::isDirectory).toList()){
            Path file=dir.resolve("result.json");if(!Files.isRegularFile(file)||seen.contains(file))continue;
            Map<String,Object> result=Json.object(Files.readString(file,StandardCharsets.UTF_8));String requestId=String.valueOf(result.getOrDefault("requestId",dir.getFileName().toString()));String status=String.valueOf(result.getOrDefault("status","failed"));
            String mode=String.valueOf(result.getOrDefault("mode",""));
            if("analysis".equals(mode)){
                try{
                    applyAnalysisNodes(model,result,requestId);
                    settleRequest(requestId,"completed");notices.add(requestId+" → completed: "+result.getOrDefault("summary","项目分析结点已回写"));
                }catch(RuntimeException failure){settleRequest(requestId,"rejected");notices.add(requestId+" → rejected: "+failure.getMessage());}
                seen.add(file);continue;
            }
            Map<String,Object> request=findRequest(requestId);Map<String,Object> target=map(request.get("target"));Set<String> allowed=new LinkedHashSet<>();for(Object value:list(target.get("codeSlotIds")))allowed.add(String.valueOf(value));Map<String,Object> baseRevisions=map(target.get("baseSlotRevisions"));WorkflowModel candidate=model.deepCopy();boolean conflicted=false;
            try{
                for(Object item:list(result.get("codeSlotResults")))if(item instanceof Map<?,?> raw)conflicted|=applyDraft(candidate,requestId,raw,allowed,baseRevisions,null);
                for(Object item:list(result.get("nodeResults")))if(item instanceof Map<?,?> raw){String nodeId=String.valueOf(raw.get("nodeId"));WorkflowModel.Node node=candidate.byId(nodeId);String itemStatus=String.valueOf(raw.containsKey("status")?raw.get("status"):"pending");if("failed".equals(itemStatus)&&node!=null)node.status=WorkflowModel.Status.FAILED;else if(raw.get("code")!=null)conflicted|=applyDraft(candidate,requestId,raw,allowed,baseRevisions,node);else if("succeeded".equals(itemStatus)&&node!=null)node.status=WorkflowModel.Status.SUCCEEDED;}
                for(Object item:list(result.get("diagnostics")))if(item instanceof Map<?,?> raw&&"error".equals(raw.get("severity"))){WorkflowModel.Node node=candidate.byId(String.valueOf(raw.get("nodeId")));if(node!=null){node.status=WorkflowModel.Status.FAILED;node.diagnostic=formatDiagnostic(raw);}}
                if(!allowed.isEmpty()&&allowed.stream().allMatch(slotId->{WorkflowModel.CodeSlot slot=model.codeSlot(slotId);return slot!=null&&requestId.equals(slot.lastAppliedRequestId);})){seen.add(file);continue;}
                model.applyRuntimeFrom(candidate);if(conflicted)status="conflicted";settleRequest(requestId,status);notices.add(requestId+" → "+status+": "+result.getOrDefault("summary","结果已回写"));
            }catch(RuntimeException failure){settleRequest(requestId,"rejected");notices.add(requestId+" → rejected: "+failure.getMessage());}
            seen.add(file);
        }}return notices;
    }

    @SuppressWarnings("unchecked")
    private void applyAnalysisNodes(WorkflowModel model,Map<String,Object> result,String requestId){
        Object nodesRaw=result.get("analysisNodes");
        if(!(nodesRaw instanceof List<?> nodeList))return;
        for(Object item:nodeList){
            if(!(item instanceof Map))continue;
            Map raw=(Map)item;
            String nodeId=String.valueOf(raw.get("nodeId"));
            String name=String.valueOf(raw.get("name"));
            if(name==null||"null".equals(name))name="未命名";
            String nodeKind=String.valueOf(raw.get("nodeKind"));
            if(nodeKind==null||"null".equals(nodeKind))nodeKind="CALCULATION";
            String category=String.valueOf(raw.get("category"));
            if(category==null||"null".equals(category))category="项目分析";
            String classificationKey=String.valueOf(raw.get("classificationKey"));
            if(classificationKey==null||"null".equals(classificationKey))classificationKey="analysis.default";
            String prompt=String.valueOf(raw.get("prompt"));
            if(prompt==null||"null".equals(prompt))prompt="";
            String artifact=String.valueOf(raw.get("artifact"));
            if(artifact==null||"null".equals(artifact))artifact="";
            String relativePath=String.valueOf(raw.get("relativePath"));
            if(relativePath==null||"null".equals(relativePath))relativePath="";
            String language=String.valueOf(raw.get("language"));
            if(language==null||"null".equals(language))language="java";
            boolean readOnly=raw.get("readOnly") instanceof Boolean b&&b;
            int x=getInt(raw.get("x"),150);
            int y=getInt(raw.get("y"),100);

            WorkflowModel.Node existing=model.byId(nodeId);
            if(existing!=null){
                existing.name=name;existing.prompt=prompt;existing.artifact=artifact;
                existing.category=category;existing.classificationKey=classificationKey;
                existing.relativePath=relativePath;existing.readOnly=readOnly;
                if(readOnly)existing.status=WorkflowModel.Status.SUCCEEDED;
                try{WorkflowModel.NodeKind k=WorkflowModel.NodeKind.valueOf(nodeKind);existing.nodeKind=k;}catch(IllegalArgumentException ignored){}
                updatePorts(existing,raw);
                continue;
            }

            WorkflowModel.NodeKind kind;
            try{kind=WorkflowModel.NodeKind.valueOf(nodeKind);}catch(IllegalArgumentException e){kind=WorkflowModel.NodeKind.CALCULATION;}
            model.forceAddNode(nodeId,name,x,y);
            WorkflowModel.Node node=model.byId(nodeId);
            if(node==null)continue;
            node.nodeKind=kind;node.category=category;node.classificationKey=classificationKey;
            node.prompt=prompt;node.artifact=artifact;node.relativePath=relativePath;
            node.readOnly=readOnly;
            if(readOnly)node.status=WorkflowModel.Status.SUCCEEDED;
            updatePorts(node,raw);
        }
        model.touch();
    }

    @SuppressWarnings("unchecked")
    private static void updatePorts(WorkflowModel.Node node, Map raw){
        Object inputsRaw=raw.get("inputs");
        if(inputsRaw instanceof List inputs){
            node.inputs.clear();
            for(Object pi:inputs){
                if(!(pi instanceof Map pm))continue;
                String pid=String.valueOf(pm.get("id"));
                if(pid==null||"null".equals(pid))pid="in";
                String pname=String.valueOf(pm.get("name"));
                if(pname==null||"null".equals(pname))pname="输入";
                String dtype=String.valueOf(pm.get("dataType"));
                if(dtype==null||"null".equals(dtype))dtype="any";
                boolean req=pm.get("required") instanceof Boolean b&&b;
                node.inputs.add(new WorkflowModel.Port(pid,pname,dtype,req));
            }
        }
        Object outputsRaw=raw.get("outputs");
        if(outputsRaw instanceof List outputs){
            node.outputs.clear();
            for(Object po:outputs){
                if(!(po instanceof Map pm))continue;
                String pid=String.valueOf(pm.get("id"));
                if(pid==null||"null".equals(pid))pid="out";
                String pname=String.valueOf(pm.get("name"));
                if(pname==null||"null".equals(pname))pname="输出";
                String dtype=String.valueOf(pm.get("dataType"));
                if(dtype==null||"null".equals(dtype))dtype="any";
                boolean req=pm.get("required") instanceof Boolean b&&b;
                node.outputs.add(new WorkflowModel.Port(pid,pname,dtype,req));
            }
        }
    }

    private void settleRequest(String requestId,String resultStatus) throws IOException {
        String destination=switch(resultStatus){case "failed"->"failed";case "cancelled"->"cancelled";case "rejected"->"rejected";case "conflicted"->"conflicted";default->"completed";};
        Path target=stateRoot.resolve("queue").resolve(destination).resolve(requestId);if(Files.isDirectory(target))return;
        for(String sourceState:List.of("processing","inbox")){Path source=stateRoot.resolve("queue").resolve(sourceState).resolve(requestId);if(!Files.isDirectory(source))continue;Files.createDirectories(target.getParent());try{Files.move(source,target,StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException e){Files.move(source,target);}return;}
    }

    private boolean applyDraft(WorkflowModel model,String requestId,Map<?,?> raw,Set<String> allowed,Map<String,Object> baseRevisions,WorkflowModel.Node node){
        String slotId=raw.get("slotId")==null&&node!=null?"node:"+node.id:String.valueOf(raw.get("slotId"));if(slotId.equals("null")||slotId.isBlank())throw new IllegalArgumentException("Agent 结果缺少 slotId");if(!allowed.isEmpty()&&!allowed.contains(slotId))throw new IllegalArgumentException("Agent 试图写入申请范围外代码槽："+slotId);
        long base=number(raw.get("baseRevision"),number(baseRevisions.get(slotId),model.codeSlot(slotId)==null?0:model.codeSlot(slotId).activeRevision));String classification=String.valueOf(raw.containsKey("classificationKey")?raw.get("classificationKey"):"agent.custom");String code=String.valueOf(raw.get("code"));CodeSlotService.ProposalResult proposal=slots.propose(model,slotId,requestId,base,code,classification);if(proposal.status()==CodeSlotService.ProposalStatus.CONFLICTED){slots.markConflicted(model,slotId,proposal.reason());return true;}return false;
    }

    private Map<String,Object> findRequest(String requestId) throws IOException {for(String status:List.of("inbox","processing","completed","failed","cancelled","rejected","conflicted")){Path file=stateRoot.resolve("queue").resolve(status).resolve(requestId).resolve("request.json");if(Files.isRegularFile(file))return Json.object(Files.readString(file,StandardCharsets.UTF_8));}return Map.of();}
    private static String formatDiagnostic(Map<?,?> diagnostic){Object line=diagnostic.containsKey("line")?diagnostic.get("line"):"?",column=diagnostic.containsKey("column")?diagnostic.get("column"):"?",message=diagnostic.containsKey("message")?diagnostic.get("message"):"未知错误";String location=diagnostic.get("file")==null?"":diagnostic.get("file")+":"+line+":"+column+" ";return location+message;}
    private static long number(Object value,long fallback){return value instanceof Number number?number.longValue():fallback;}
    private static String str(Object value){return value==null?"":String.valueOf(value);}
    private static int getInt(Object value,int fallback){return value instanceof Number n?n.intValue():fallback;}
    private static List<?> list(Object value){return value instanceof List<?> list?list:List.of();}
    @SuppressWarnings("unchecked") private static Map<String,Object> map(Object value){return value instanceof Map<?,?> map?(Map<String,Object>)map:Map.of();}
}
