package local.codenode;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class WorkflowModelTest {
    @Test void connectsNamedPortsAndReplacesSingleInputLink(){WorkflowModel model=new WorkflowModel();var a=model.addNode(0,0);var b=model.addNode(0,0);var c=model.addNode(0,0);var extra=model.addPort(b,false);assertTrue(model.connect(a,a.outputs.getFirst(),b,extra));assertTrue(model.connect(c,c.outputs.getFirst(),b,extra));assertEquals(1,model.edges().size());assertEquals(c.id,model.edges().getFirst().source());assertEquals(extra.id,model.edges().getFirst().targetPort());}
    @Test void removingPortAlsoRemovesItsLinks(){WorkflowModel model=new WorkflowModel();var a=model.addNode(0,0);var b=model.addNode(0,0);var output=model.addPort(a,true);model.connect(a,output,b,b.inputs.getFirst());model.removePort(a,output,true);assertTrue(model.edges().isEmpty());}
    @Test void duplicatePreservesEditablePortDefinitions(){WorkflowModel model=new WorkflowModel();var source=model.addNode(0,0);source.inputs.getFirst().dataType="int";var copy=model.duplicate(source,20,20);assertEquals("int",copy.inputs.getFirst().dataType);assertNotSame(source.inputs.getFirst(),copy.inputs.getFirst());}
    @Test void anyInputAdoptsConnectedOutputType(){WorkflowModel model=new WorkflowModel();var source=model.addNode(0,0);var target=model.addNode(0,0);source.outputs.getFirst().dataType="文件夹";model.connect(source,target);assertEquals("文件夹",target.inputs.getFirst().dataType);}
}
