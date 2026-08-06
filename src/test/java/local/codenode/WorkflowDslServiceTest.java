package local.codenode;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class WorkflowDslServiceTest {
    @Test void decodesGraphToPortableExpressionAndAst(){WorkflowModel model=new WorkflowModel();var a=model.addNode(0,0);var b=model.addNode(0,0);var c=model.addNode(0,0);model.connect(a,c);model.connect(b,model.addPort(b,true),c,model.addPort(c,false));var document=new WorkflowDslService().decode(model,List.of(a,b,c),c);assertTrue(document.expression().startsWith(c.id+"("));assertEquals("call",document.ast().get("type"));assertEquals(c.id,document.ast().get("nodeId"));}
    @Test void rejectsImplicitCycles(){WorkflowModel model=new WorkflowModel();var a=model.addNode(0,0);var b=model.addNode(0,0);model.connect(a,b);model.connect(b,b.outputs.getFirst(),a,a.inputs.getFirst());assertThrows(IllegalArgumentException.class,()->new WorkflowDslService().decode(model,List.of(a,b),b));}
}
