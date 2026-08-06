package local.codenode;
import java.nio.file.*;

public class QuickVerify {
    public static void main(String[] args) throws Exception {
        var codec = new CnodeProjectCodec();
        var loaded = codec.load(Path.of(args[0]));
        System.out.println("Nodes: " + loaded.model().nodes().size());
        System.out.println("Edges: " + loaded.model().edges().size());
        loaded.model().nodes().forEach(n ->
            System.out.println("  [" + n.id + "] " + n.name +
                "  in:" + n.inputs.getFirst().dataType +
                "  out:" + n.outputs.getFirst().dataType +
                "  status:" + n.status));
        System.out.println("Valid: OK");
    }
}
