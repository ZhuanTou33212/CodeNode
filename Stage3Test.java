import local.codenode.*;

public class Stage3Test {
    private static int pass=0,fail=0;
    static void check(String name,boolean cond){
        if(cond){pass++;System.out.println("  PASS: "+name);}
        else{fail++;System.err.println("  FAIL: "+name);}
    }

    public static void main(String[] args){
        System.out.println("=== Stage3 UI 逻辑自检 ===\n");

        // 1) isMarkdownNoFile 判断
        System.out.println("--- 1. isMarkdownNoFile 判断逻辑 ---");
        {
            WorkflowModel model=new WorkflowModel();
            // 无 FILE 节点
            boolean isMarkdownNoFile=model.nodes().stream().noneMatch(n->n.nodeKind==WorkflowModel.NodeKind.FILE);
            check("无 FILE 节点时 isMarkdownNoFile=true",isMarkdownNoFile);

            // 添加 FILE 节点
            model.addFileNode(100,100,"readme","readme.md");
            boolean hasFile=model.nodes().stream().anyMatch(n->n.nodeKind==WorkflowModel.NodeKind.FILE);
            check("有 FILE 节点时 anyMatch=true",hasFile);
            boolean isMarkdownNoFile2=model.nodes().stream().noneMatch(n->n.nodeKind==WorkflowModel.NodeKind.FILE);
            check("有 FILE 节点时 isMarkdownNoFile=false",!isMarkdownNoFile2);
        }

        // 2) MARKDOWN 无文件节点 → 单节点提交被 QueueService 拒绝
        System.out.println("\n--- 2. QueueService 守卫: MARKDOWN 无文件节点单节点禁止 ---");
        {
            WorkflowModel model=new WorkflowModel();
            WorkflowModel.Node n1=model.addNode(100,100);n1.name="步骤1";
            WorkflowModel.Node n2=model.addNode(200,200);n2.name="步骤2";
            model.connect(n1,n2);

            QueueService qs;
            try{qs=new QueueService(java.nio.file.Path.of(System.getProperty("java.io.tmpdir"),"st3test_"+System.currentTimeMillis()));}catch(Exception e){System.err.println("Setup failed: "+e);return;}

            // 单节点提交应被拒绝
            boolean rejectedSingle=false;
            try{qs.submit(model,WorkflowModel.Mode.MARKDOWN,QueueService.SubmitTarget.selected(n1),"java","output");}
            catch(IllegalArgumentException e){rejectedSingle=e.getMessage().contains("组输出")||e.getMessage().contains("虚拟");}
            catch(Exception e){rejectedSingle=false;}
            check("MARKDOWN 无 FILE 节点: 单节点提交应被拒绝",rejectedSingle);

            // 组输出提交应被允许
            WorkflowModel.Node go=model.addGroupOutput(300,150,"文档输出");
            model.connect(n2,n2.outputs.get(0),go,go.inputs.get(0));
            boolean groupOk=false;
            try{QueueService.Submission sub=qs.submit(model,WorkflowModel.Mode.MARKDOWN,QueueService.SubmitTarget.group(go),"java","output");groupOk=sub!=null&&sub.requestId()!=null&&!sub.requestId().isBlank();}
            catch(Exception e){System.err.println("组输出提交异常: "+e);}
            check("MARKDOWN 无 FILE 节点: 组输出提交应成功",groupOk);

            // 多组输出提交应被拒绝
            WorkflowModel.Node go2=model.addGroupOutput(400,150,"文档输出2");
            model.connect(n2,n2.outputs.get(0),go2,go2.inputs.get(0));
            boolean rejectedMulti=false;
            try{qs.submit(model,WorkflowModel.Mode.MARKDOWN,QueueService.SubmitTarget.multi(java.util.List.of(go,go2),go),"java","output");}
            catch(IllegalArgumentException e){rejectedMulti=e.getMessage().contains("只能有一个组输出")||e.getMessage().contains("组输出");}
            catch(Exception e){rejectedMulti=false;}
            check("MARKDOWN 多组输出同时提交应被拒绝",rejectedMulti);
        }

        // 3) MARKDOWN 有文件节点 → 单节点提交应被允许
        System.out.println("\n--- 3. 有文件节点时单节点提交允许 ---");
        {
            WorkflowModel model=new WorkflowModel();
            WorkflowModel.Node fileNode=model.addFileNode(50,50,"文档1","doc1.md");
            WorkflowModel.Node n1=model.addNode(100,100);n1.name="分析";n1.fileNodeId=fileNode.id;
            WorkflowModel.Node n2=model.addNode(200,200);n2.name="总结";n2.fileNodeId=fileNode.id;
            model.connect(n1,n2);

            QueueService qs;
            try{qs=new QueueService(java.nio.file.Path.of(System.getProperty("java.io.tmpdir"),"st3testb_"+System.currentTimeMillis()));}catch(Exception e){System.err.println("Setup failed: "+e);return;}

            // 单体提交应通过
            boolean singleOk=false;
            try{QueueService.Submission sub=qs.submit(model,WorkflowModel.Mode.MARKDOWN,QueueService.SubmitTarget.selected(n2),"java","output");singleOk=sub!=null&&sub.requestId()!=null;}
            catch(Exception e){System.err.println("有文件节点单节点提交异常: "+e);}
            check("MARKDOWN 有 FILE 节点: 单节点提交应成功",singleOk);
        }

        // 4) VirtualFileSpace 中的 groupOutputNodeIds
        System.out.println("\n--- 4. fileSpaces 中 groupOutputNodeIds 关联 ---");
        {
            WorkflowModel model=new WorkflowModel();
            model.refreshFileSpaces();
            var defaultSpace=model.fileSpace("space:default");
            check("无 FILE 节点时 space:default 存在",defaultSpace!=null);
            check("space:default 是虚拟空间",defaultSpace.isVirtual());

            // 添加 FILE + 组输出
            WorkflowModel.Node fileNode=model.addFileNode(50,50,"doc","doc.md");
            WorkflowModel.Node n1=model.addNode(100,100);n1.name="step";n1.fileNodeId=fileNode.id;
            WorkflowModel.Node n2=model.addNode(150,150);n2.name="step2";n2.fileNodeId=fileNode.id;
            model.connect(n1,n2);
            WorkflowModel.Node go=model.addGroupOutput(200,100,"输出");
            go.fileNodeId=fileNode.id;
            model.connect(n2,n2.outputs.get(0),go,go.inputs.get(0));
            model.refreshFileSpaces();
            var fileSpace=model.fileSpace("space:"+fileNode.id);
            check("FILE 节点空间存在",fileSpace!=null);
            check("FILE 空间非虚拟",!fileSpace.isVirtual());
            check("组输出被归入 FILE 空间",fileSpace.groupOutputNodeIds.contains(go.id));
        }

        // 5) EXECUTABLE 模式不受影响
        System.out.println("\n--- 5. EXECUTABLE 模式不受限制 ---");
        {
            WorkflowModel model=new WorkflowModel();
            WorkflowModel.Node n1=model.addNode(100,100);n1.name="step";
            WorkflowModel.Node n2=model.addNode(200,200);n2.name="step2";
            model.connect(n1,n2);

            QueueService qs;
            try{qs=new QueueService(java.nio.file.Path.of(System.getProperty("java.io.tmpdir"),"st3testc_"+System.currentTimeMillis()));}catch(Exception e){System.err.println("Setup failed: "+e);return;}

            boolean execOk=false;
            try{QueueService.Submission sub=qs.submit(model,WorkflowModel.Mode.EXECUTABLE,QueueService.SubmitTarget.selected(n2),"java","output");execOk=sub!=null&&sub.requestId()!=null;}
            catch(Exception e){System.err.println("EXECUTABLE 提交异常: "+e);}
            check("EXECUTABLE 模式单节点提交不受限",execOk);
        }

        System.out.println("\n=== 结果: "+pass+" PASS, "+fail+" FAIL ===");
        if(fail>0)System.exit(1);
    }
}
