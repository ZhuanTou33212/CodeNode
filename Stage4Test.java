import local.codenode.*;
import java.util.*;

public class Stage4Test {
    static int passed,failed;
    public static void main(String[] args) {
        System.out.println("=== Stage4 持久化兼容性自检 ===");
        
        // 1. 序列化含 fileSpaces 段
        testSerializeWithSpaces();
        // 2. 反序列化含 fileSpaces 段
        testDeserializeWithSpaces();
        // 3. 向后兼容：无 fileSpaces 段自动推断
        testDeserializeWithoutSpaces();
        // 4. 空 fileSpaces 列表应触发 refreshFileSpaces
        testEmptyFileSpaces();
        // 5. fileSpaces 与节点状态一致性
        testSpacesConsistency();
        
        System.out.printf("=== 结果: %d PASS, %d FAIL ===%n",passed,failed);
    }
    
    static void testSerializeWithSpaces() {
        WorkflowModel model=new WorkflowModel();
        WorkflowModel.Node f1=model.addFileNode(0,0,"文档A","docA.md");
        WorkflowModel.Node n1=model.addNode(100,100);n1.name="step1";n1.fileNodeId=f1.id;
        WorkflowModel.Node n2=model.addNode(150,150);n2.name="step2";n2.fileNodeId=f1.id;
        model.connect(n1,n2);
        WorkflowModel.Node go=model.addGroupOutput(200,100,"输出");
        go.fileNodeId=f1.id;
        model.connect(n2,n2.outputs.get(0),go,go.inputs.get(0));
        model.refreshFileSpaces();
        
        var graph=graph(model);
        List<?> spaces=(List<?>)graph.get("fileSpaces");
        check("graph 含 fileSpaces 段",spaces!=null);
        check("fileSpaces 非空",!spaces.isEmpty());
        boolean hasDefaultSpace=false,hasFileSpace=false;
        for(Object item:spaces){
            Map<?,?> s=(Map<?,?>)item;
            String sid=(String)s.get("id");
            if("space:default".equals(sid))check("不应有默认空间（有FILE节点时）",false);
            if(("space:"+f1.id).equals(sid))hasFileSpace=true;
        }
        check("含 FILE 节点对应空间",hasFileSpace);
        
        // 无文件节点场景
        WorkflowModel model2=new WorkflowModel();
        model2.addNode(0,0);
        model2.refreshFileSpaces();
        var graph2=graph(model2);
        List<?> spaces2=(List<?>)graph2.get("fileSpaces");
        check("无FILE节点 graph 含默认空间",spaces2.size()==1&&"space:default".equals(((Map<?,?>)spaces2.get(0)).get("id")));
    }
    
    static void testDeserializeWithSpaces() {
        WorkflowModel model=new WorkflowModel();
        WorkflowModel.Node f1=model.addFileNode(0,0,"文档A","docA.md");
        model.refreshFileSpaces();
        var graph=graph(model);
        
        // 模拟反序列化
        WorkflowModel loaded=new WorkflowModel();
        loaded.replaceContents(List.of(f1),List.of(),List.of(),0);
        try{
            var m=loadSpaces(loaded,graph);
            check("反序列化后空间数正确",m.fileSpaces().size()==1);
            check("反序列化后空间 id 匹配",m.fileSpace("space:"+f1.id)!=null);
        }catch(Exception e){
            check("反序列化异常: "+e.getMessage(),false);
        }
    }
    
    static void testDeserializeWithoutSpaces() {
        WorkflowModel model=new WorkflowModel();
        WorkflowModel.Node n1=model.addNode(0,0);n1.name="step";
        WorkflowModel.Node go=model.addGroupOutput(300,100,"输出");
        n1.fileNodeId="";go.fileNodeId="";
        // Connect n1 output[0] to group input[0]
        WorkflowModel.Port sp=n1.outputs.get(0);
        WorkflowModel.Port tp=go.inputs.get(0);
        model.connect(n1,sp,go,tp);
        model.refreshFileSpaces();
        
        // 移除 fileSpaces 段模拟旧工程
        var graphNoSpaces=new LinkedHashMap<>(graph(model));
        graphNoSpaces.remove("fileSpaces");
        
        WorkflowModel loaded=new WorkflowModel();
        loaded.replaceContents(new ArrayList<>(model.nodes()),model.edges(),new ArrayList<>(model.codeSlots()),0);
        try{
            var m=loadSpaces(loaded,graphNoSpaces);
            check("旧工程自动生成默认空间",m.fileSpace("space:default")!=null);
            check("旧工程默认空间为虚拟空间",m.fileSpace("space:default").isVirtual());
            check("旧工程默认空间含组输出",m.fileSpace("space:default").groupOutputNodeIds.contains(go.id));
        }catch(Exception e){
            check("旧工程加载异常: "+e.getMessage(),false);
        }
    }
    
    static void testEmptyFileSpaces() {
        WorkflowModel model=new WorkflowModel();
        model.addNode(0,0);
        model.refreshFileSpaces();
        var graphWithEmpty=graph(model);
        // 模拟空列表
        var m=new LinkedHashMap<>(graphWithEmpty);
        m.put("fileSpaces",List.of());
        
        WorkflowModel loaded=new WorkflowModel();
        loaded.replaceContents(new ArrayList<>(model.nodes()),model.edges(),new ArrayList<>(model.codeSlots()),0);
        try{
            var lm=loadSpaces(loaded,m);
            check("空列表触发自动推断",lm.fileSpace("space:default")!=null);
        }catch(Exception e){
            check("空列表加载异常: "+e.getMessage(),false);
        }
    }
    
    static void testSpacesConsistency() {
        WorkflowModel model=new WorkflowModel();
        WorkflowModel.Node f1=model.addFileNode(0,0,"文档A","docA.md");
        WorkflowModel.Node f2=model.addFileNode(500,0,"文档B","docB.md");
        WorkflowModel.Node n1=model.addNode(100,100);n1.name="s1";n1.fileNodeId=f1.id;
        WorkflowModel.Node n2=model.addNode(150,150);n2.name="s2";n2.fileNodeId=f1.id;
        model.connect(n1,n2);
        WorkflowModel.Node n3=model.addNode(600,100);n3.name="s3";n3.fileNodeId=f2.id;
        WorkflowModel.Node go1=model.addGroupOutput(200,100,"输出A");
        go1.fileNodeId=f1.id;
        model.connect(n2,n2.outputs.get(0),go1,go1.inputs.get(0));
        WorkflowModel.Node go2=model.addGroupOutput(700,100,"输出B");
        go2.fileNodeId=f2.id;
        model.connect(n3,n3.outputs.get(0),go2,go2.inputs.get(0));
        model.refreshFileSpaces();
        
        var graph=graph(model);
        WorkflowModel loaded=new WorkflowModel();
        loaded.replaceContents(new ArrayList<>(model.nodes()),model.edges(),new ArrayList<>(model.codeSlots()),0);
        try{
            var lm=loadSpaces(loaded,graph);
            check("多文件节点：空间数=2",lm.fileSpaces().size()==2);
            check("空间 A 存在",lm.fileSpace("space:"+f1.id)!=null);
            check("空间 B 存在",lm.fileSpace("space:"+f2.id)!=null);
            check("空间 A 含组输出 go1",lm.fileSpace("space:"+f1.id).groupOutputNodeIds.contains(go1.id));
            check("空间 B 含组输出 go2",lm.fileSpace("space:"+f2.id).groupOutputNodeIds.contains(go2.id));
            check("空间 A 不含 go2",!lm.fileSpace("space:"+f1.id).groupOutputNodeIds.contains(go2.id));
        }catch(Exception e){
            check("多文件空间加载异常: "+e.getMessage(),false);
        }
    }
    
    // Helper: simulate decodeGraph's decodeFileSpaces logic
    @SuppressWarnings("unchecked")
    static WorkflowModel loadSpaces(WorkflowModel model,Map<String,Object> graph) throws Exception {
        Object rawSpaces=graph.get("fileSpaces");
        if(rawSpaces instanceof List<?> values&&!values.isEmpty()){
            for(Object item:values){
                Map<String,Object> raw=(Map<String,Object>)item;
                String id=(String)raw.get("id");
                String name=(String)raw.getOrDefault("name",id);
                String fileNodeId=(String)raw.getOrDefault("fileNodeId","");
                if(fileNodeId.isEmpty())fileNodeId=null;
                WorkflowModel.VirtualFileSpace space=new WorkflowModel.VirtualFileSpace(id,name,fileNodeId);
                String rel=(String)raw.getOrDefault("relation","PARALLEL");
                try{space.relation=WorkflowModel.SpaceRelation.valueOf(rel.toUpperCase());}
                catch(IllegalArgumentException e){space.relation=WorkflowModel.SpaceRelation.PARALLEL;}
                String sId=(String)raw.getOrDefault("slotId","");if(!sId.isEmpty())space.slotId=sId;
                Object inc=raw.get("includedNodeIds");
                if(inc instanceof List<?> l)for(Object i:l)if(i instanceof String s&&model.byId(s)!=null)space.includedNodeIds.add(s);
                Object rels=raw.get("relatedSpaceIds");
                if(rels instanceof List<?> l)for(Object r:l)if(r instanceof String s)space.relatedSpaceIds.add(s);
                Object gos=raw.get("groupOutputNodeIds");
                if(gos instanceof List<?> l)for(Object g:l)if(g instanceof String s&&model.byId(s)!=null)space.groupOutputNodeIds.add(s);
                model.putFileSpace(space);
            }
        }else{
            model.refreshFileSpaces();
        }
        return model;
    }
    
    @SuppressWarnings("unchecked")
    static Map<String,Object> graph(WorkflowModel model) {
        List<Map<String,Object>> nodes=new ArrayList<>();
        for(WorkflowModel.Node node:model.nodes()){
            LinkedHashMap<String,Object> v=new LinkedHashMap<>();
            v.put("id",node.id);v.put("name",node.name);v.put("nodeKind",node.nodeKind.name().toLowerCase());
            v.put("file",Map.of("ownerId",node.fileNodeId));
            nodes.add(v);
        }
        List<Map<String,Object>> edges=new ArrayList<>();
        for(WorkflowModel.Edge edge:model.edges()){
            edges.add(Map.of("id",edge.id(),"source",Map.of("nodeId",edge.source(),"portId",edge.sourcePort()),"target",Map.of("nodeId",edge.target(),"portId",edge.targetPort())));
        }
        List<Map<String,Object>> spaces=new ArrayList<>();
        for(WorkflowModel.VirtualFileSpace space:model.fileSpaces()){
            LinkedHashMap<String,Object> s=new LinkedHashMap<>();
            s.put("id",space.id);s.put("name",space.name);
            s.put("fileNodeId",space.fileNodeId==null?"":space.fileNodeId);
            s.put("slotId",space.slotId==null?"":space.slotId);
            s.put("includedNodeIds",List.copyOf(space.includedNodeIds));
            s.put("relation",space.relation.name());
            s.put("relatedSpaceIds",List.copyOf(space.relatedSpaceIds));
            s.put("groupOutputNodeIds",List.copyOf(space.groupOutputNodeIds));
            spaces.add(s);
        }
        return Map.of("revision",model.revision(),"nodes",nodes,"edges",edges,"fileSpaces",spaces);
    }
    
    static void check(String desc,boolean cond) {
        if(cond){System.out.println("  PASS: "+desc);passed++;}
        else{System.out.println("  FAIL: "+desc);failed++;}
    }
}
