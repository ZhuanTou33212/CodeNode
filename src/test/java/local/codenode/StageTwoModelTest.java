package local.codenode;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class StageTwoModelTest {
    @Test void acceptedCodeCanRollbackOneVersionWithoutBreakingRevisionMonotonicity(){
        WorkflowModel model=new WorkflowModel();
        var node=model.addNode(0,0);
        var slot=model.ensureNodeSlot(node);
        slot.activeCode="v1";slot.activeRevision=1;
        CodeSlotService service=new CodeSlotService();
        service.propose(model,slot.id,"request-2",1,"v2","agent.custom");service.accept(model,slot.id);
        service.propose(model,slot.id,"request-3",2,"v3","agent.custom");service.accept(model,slot.id);
        service.rollback(model,slot.id);
        assertEquals("v2",slot.activeCode);
        assertEquals("v3",slot.previousCode);
        assertEquals(4,slot.activeRevision);
        assertEquals(WorkflowModel.Status.ACCEPTED,node.status);
    }

    @Test void groupOutputDoesNotTraverseIntoAnotherFile(){
        WorkflowModel model=new WorkflowModel();
        var fileA=model.addFileNode(0,0,"A","src/A.java");
        var fileB=model.addFileNode(0,0,"B","src/B.java");
        var a=model.addNode(0,0);var b=model.addNode(0,0);var output=model.addGroupOutput(0,0,"A 输出");
        a.fileNodeId=fileA.id;b.fileNodeId=fileB.id;output.fileNodeId=fileA.id;
        model.connect(b,a);model.connect(a,a.outputs.getFirst(),output,output.inputs.getFirst());
        assertEquals(List.of(a.id),model.upstreamOf(output).stream().map(node->node.id).toList());
    }

    @Test void changingDynamicOperationRemovesNowIncompatibleLinks(){
        WorkflowModel model=new WorkflowModel();
        var calculation=model.addNode(0,0);var target=model.addNode(0,0);
        calculation.nodeKind=WorkflowModel.NodeKind.CALCULATION;calculation.valueType="vector3";
        target.inputs.getFirst().declaredType="number";target.inputs.getFirst().dataType="number";
        NodeRegistry.applyOperation(model,calculation,"dot");
        assertTrue(model.connect(calculation,target));
        int removed=NodeRegistry.applyOperation(model,calculation,"add");
        assertEquals(1,removed);
        assertTrue(model.edges().isEmpty());
        assertEquals("vector3",calculation.outputs.getFirst().dataType);
    }

    @Test void arrayAndConditionOperationsExposeSemanticPorts(){
        WorkflowModel model=new WorkflowModel();
        var array=model.addNode(0,0);array.nodeKind=WorkflowModel.NodeKind.CALCULATION;array.valueType="array<any>";
        NodeRegistry.applyOperation(model,array,"slice");
        assertEquals(List.of("array<any>","integer","integer"),array.inputs.stream().map(port->port.dataType).toList());
        var condition=model.addNode(0,0);condition.nodeKind=WorkflowModel.NodeKind.CONDITION;condition.valueType="boolean";
        NodeRegistry.applyOperation(model,condition,"inside");
        assertEquals(3,condition.inputs.size());
        assertEquals("boolean",condition.outputs.getFirst().dataType);
    }
}
