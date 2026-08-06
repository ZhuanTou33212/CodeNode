package local.codenode;
import java.nio.file.*;
import java.time.Instant;

public class CreateCatProject {
    public static void main(String[] args) throws Exception {
        var model = new WorkflowModel();
        
        var n1 = model.addNode(100, 100);
        n1.name = "新建文件夹";
        n1.prompt = "在桌面上创建一个名为\"小猫文件夹\"的新文件夹";
        n1.artifact = "output/ps_create_folder.ps1";
        n1.category = "PowerShell";
        n1.classificationKey = "agent.custom";
        
        var n2 = model.addNode(400, 100);
        n2.name = "新建文本文档";
        n2.prompt = "在\"小猫文件夹\"中创建一个名为\"小猫.txt\"的空文本文档";
        n2.artifact = "output/ps_create_txt.ps1";
        n2.category = "PowerShell";
        n2.classificationKey = "agent.custom";
        n2.inputs.getFirst().declaredType = "object";
        n2.inputs.getFirst().dataType = "object";
        n2.inputs.getFirst().name = "新建文件夹";
        n2.outputs.getFirst().declaredType = "txt";
        n2.outputs.getFirst().dataType = "txt";
        n2.outputs.getFirst().name = "文本文档";
        
        var n3 = model.addNode(700, 100);
        n3.name = "画小猫";
        n3.prompt = "在\"小猫.txt\"文件中用ASCII字符画一只小猫，小猫要有耳朵、眼睛、胡须和尾巴";
        n3.artifact = "output/ps_draw_cat.ps1";
        n3.category = "PowerShell";
        n3.classificationKey = "agent.custom";
        n3.inputs.getFirst().declaredType = "txt";
        n3.inputs.getFirst().dataType = "txt";
        n3.inputs.getFirst().name = "文本文档";
        n3.outputs.getFirst().declaredType = "txt";
        n3.outputs.getFirst().dataType = "txt";
        n3.outputs.getFirst().name = "文本文档";
        
        n1.outputs.getFirst().name = "文件夹";
        n1.outputs.getFirst().declaredType = "object";
        n1.outputs.getFirst().dataType = "object";
        
        model.connect(n1, n1.outputs.getFirst(), n2, n2.inputs.getFirst());
        model.connect(n2, n2.outputs.getFirst(), n3, n3.inputs.getFirst());
        
        var settings = new CnodeProjectCodec.Settings(
            WorkflowModel.Mode.MARKDOWN, "powershell",
            "output/program", "output/agent",
            n3.id, 31, -22, 1.25, n3.id
        );
        var metadata = new CnodeProjectCodec.Metadata(
            "desktop-cat-test-001", "桌面画小猫测试", Instant.now(), settings
        );
        
        var codec = new CnodeProjectCodec();
        Path output = Path.of(args[0]);
        codec.save(output, model, metadata);
        
        System.out.println("Created: " + output);
        System.out.println("Nodes: " + model.nodes().size() + " Edges: " + model.edges().size());
        model.nodes().forEach(n ->
            System.out.println("  [" + n.id + "] " + n.name +
                " in:" + n.inputs.getFirst().dataType + " out:" + n.outputs.getFirst().dataType));
    }
}
