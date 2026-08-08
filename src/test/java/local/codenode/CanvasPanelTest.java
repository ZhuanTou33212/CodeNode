package local.codenode;

import org.junit.jupiter.api.Test;

import javax.swing.*;
import java.awt.event.*;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class CanvasPanelTest {
    @Test void clickShiftAltBoxAndSelectAllManageMultiSelection(){
        WorkflowModel model=new WorkflowModel();WorkflowModel.Node first=model.addNode(100,100),second=model.addNode(400,100);CanvasPanel canvas=canvas(model);
        click(canvas,120,120,0,MouseEvent.BUTTON1);assertEquals(1,canvas.selectedNodes().size());
        click(canvas,420,120,InputEvent.SHIFT_DOWN_MASK,MouseEvent.BUTTON1);assertEquals(2,canvas.selectedNodes().size());
        click(canvas,120,120,InputEvent.ALT_DOWN_MASK,MouseEvent.BUTTON1);assertEquals(1,canvas.selectedNodes().size());assertTrue(canvas.selectedNodes().contains(second));
        drag(canvas,50,50,650,300,0,MouseEvent.BUTTON1);assertEquals(2,canvas.selectedNodes().size());
        invoke(canvas,"control A");assertEquals(2,canvas.selectedNodes().size());
    }

    @Test void wheelZoomsAndZCentersView(){
        WorkflowModel model=new WorkflowModel();WorkflowModel.Node node=model.addNode(900,700);CanvasPanel canvas=canvas(model);click(canvas,920,720,0,MouseEvent.BUTTON1);double before=canvas.zoom();wheel(canvas,500,350,-2);assertTrue(canvas.zoom()>before);canvas.setView(0,0,.5);int oldPanX=canvas.panX(),oldPanY=canvas.panY();invoke(canvas,"Z");assertEquals(.5,canvas.zoom(),0.0001);assertNotEquals(oldPanX,canvas.panX());
    }

    @Test void altRightClickCreatesDraggableReroutePoint(){
        WorkflowModel model=connectedModel();CanvasPanel canvas=canvas(model);WorkflowModel.Edge edge=model.edges().getFirst();click(canvas,357,148,InputEvent.ALT_DOWN_MASK,MouseEvent.BUTTON3);assertEquals(1,edge.reroutes().size());WorkflowModel.Reroute point=edge.reroutes().getFirst();drag(canvas,point.x,point.y,360,205,InputEvent.ALT_DOWN_MASK,MouseEvent.BUTTON1);assertEquals(360,point.x);assertEquals(205,point.y);
    }

    @Test void ctrlShiftRightStrokeInsertsRerouteOnTouchedWire(){
        WorkflowModel model=connectedModel();CanvasPanel canvas=canvas(model);drag(canvas,357,110,357,185,InputEvent.CTRL_DOWN_MASK|InputEvent.SHIFT_DOWN_MASK,MouseEvent.BUTTON3);assertEquals(1,model.edges().getFirst().reroutes().size());
    }

    @Test void releasingRerouteWireOnEmptyCanvasDoesNotCreatePointsOrLinks(){
        WorkflowModel model=connectedModel();CanvasPanel canvas=canvas(model);click(canvas,357,148,InputEvent.ALT_DOWN_MASK,MouseEvent.BUTTON3);WorkflowModel.Reroute source=model.edges().getFirst().reroutes().getFirst();drag(canvas,source.x,source.y,520,240,0,MouseEvent.BUTTON1);assertEquals(1,model.edges().size());assertEquals(1,model.reroutes().size());
    }

    @Test void rerouteCanCreateARealBranchToAnotherNodeInput(){
        WorkflowModel model=connectedModel();WorkflowModel.Node firstBranch=model.addNode(430,300),secondBranch=model.addNode(430,500);CanvasPanel canvas=canvas(model);click(canvas,357,148,InputEvent.ALT_DOWN_MASK,MouseEvent.BUTTON3);WorkflowModel.Reroute point=model.edges().getFirst().reroutes().getFirst();drag(canvas,point.x,point.y,430,348,0,MouseEvent.BUTTON1);drag(canvas,point.x,point.y,430,548,0,MouseEvent.BUTTON1);assertEquals(3,model.edges().size());WorkflowModel.Edge first=model.edges().get(1),second=model.edges().get(2);assertEquals(firstBranch.id,first.target());assertEquals(secondBranch.id,second.target());assertSame(point,first.reroutes().getLast());assertSame(point,second.reroutes().getLast());point.y=220;assertTrue(model.edges().stream().allMatch(edge->edge.reroutes().getFirst().y==220));
    }

    @Test void inputPortCanDragBackToAnOutputPort(){
        WorkflowModel model=new WorkflowModel();WorkflowModel.Node source=model.addNode(100,100),target=model.addNode(400,100);CanvasPanel canvas=canvas(model);drag(canvas,400,148,315,148,0,MouseEvent.BUTTON1);assertEquals(1,model.edges().size());assertEquals(source.id,model.edges().getFirst().source());assertEquals(target.id,model.edges().getFirst().target());
    }

    @Test void incompatiblePortDragIsRejectedAndExplainsWhy(){
        WorkflowModel model=new WorkflowModel();WorkflowModel.Node source=model.addNode(100,100),target=model.addNode(400,100);source.outputs.getFirst().declaredType="string";source.outputs.getFirst().dataType="string";target.inputs.getFirst().declaredType="int";target.inputs.getFirst().dataType="int";CanvasPanel canvas=canvas(model);List<String> feedback=new ArrayList<>();canvas.onFeedback(feedback::add);drag(canvas,315,148,400,148,0,MouseEvent.BUTTON1);assertTrue(model.edges().isEmpty());assertEquals(1,feedback.size());assertTrue(feedback.getFirst().contains("类型不兼容"));
    }

    @Test void fiftyNodeSelectionMoveAndZoomCompletesWithinAcceptanceBudget(){
        assertTimeout(Duration.ofSeconds(2),()->{WorkflowModel model=new WorkflowModel();WorkflowModel.Node previous=null;for(int index=0;index<50;index++){WorkflowModel.Node node=model.addNode(40+(index%10)*240,40+(index/10)*130);if(previous!=null)model.connect(previous,node);previous=node;}CanvasPanel canvas=canvas(model);invoke(canvas,"control A");wheel(canvas,500,350,-2);invoke(canvas,"Z");invoke(canvas,"G");move(canvas,540,390);invoke(canvas,"ENTER");assertEquals(50,canvas.selectedNodes().size());assertEquals(49,model.edges().size());});
    }

    @Test void gMovesAllSelectedNodesAndLeftClickConfirms(){
        WorkflowModel model=new WorkflowModel();WorkflowModel.Node first=model.addNode(100,100),second=model.addNode(400,100);CanvasPanel canvas=canvas(model);invoke(canvas,"control A");invoke(canvas,"G");move(canvas,360,260);click(canvas,360,260,0,MouseEvent.BUTTON1);assertEquals(160,first.x);assertEquals(140,first.y);assertEquals(460,second.x);assertEquals(140,second.y);
    }

    @Test void gEscapeAndRightClickCancelWithoutMoving(){
        WorkflowModel model=new WorkflowModel();WorkflowModel.Node node=model.addNode(100,100);CanvasPanel canvas=canvas(model);click(canvas,120,120,0,MouseEvent.BUTTON1);invoke(canvas,"G");move(canvas,220,220);invoke(canvas,"ESCAPE");assertEquals(100,node.x);assertEquals(100,node.y);invoke(canvas,"G");move(canvas,240,240);click(canvas,240,240,0,MouseEvent.BUTTON3);assertEquals(100,node.x);assertEquals(100,node.y);
    }

    @Test void gMovesSharedRerouteAndEnterConfirms(){
        WorkflowModel model=connectedModel();WorkflowModel.Node branch=model.addNode(430,300);WorkflowModel.Reroute point=model.addReroute(model.edges().getFirst(),350,170);WorkflowModel.Node source=model.nodes().getFirst();model.connect(source,branch);model.edges().getLast().reroutes().add(point);CanvasPanel canvas=canvas(model);click(canvas,point.x,point.y,0,MouseEvent.BUTTON1);invoke(canvas,"G");move(canvas,400,230);invoke(canvas,"ENTER");assertEquals(400,point.x);assertEquals(230,point.y);assertSame(point,model.edges().getFirst().reroutes().getFirst());assertSame(point,model.edges().getLast().reroutes().getFirst());
    }

    @Test void copyPasteDeleteAndEscapeOperateOnTheSelection(){
        WorkflowModel model=connectedModel();CanvasPanel canvas=canvas(model);invoke(canvas,"control A");invoke(canvas,"control C");invoke(canvas,"control V");assertEquals(4,model.nodes().size());assertEquals(2,model.edges().size());assertEquals(2,canvas.selectedNodes().size());invoke(canvas,"DELETE");assertEquals(2,model.nodes().size());WorkflowModel.Node node=model.nodes().getFirst();int originalX=node.x,originalY=node.y;click(canvas,originalX+20,originalY+20,0,MouseEvent.BUTTON1);long now=System.currentTimeMillis();canvas.dispatchEvent(new MouseEvent(canvas,MouseEvent.MOUSE_PRESSED,now,InputEvent.BUTTON1_DOWN_MASK,originalX+20,originalY+20,1,false,MouseEvent.BUTTON1));canvas.dispatchEvent(new MouseEvent(canvas,MouseEvent.MOUSE_DRAGGED,now+1,InputEvent.BUTTON1_DOWN_MASK,originalX+120,originalY+80,0,false,MouseEvent.NOBUTTON));invoke(canvas,"ESCAPE");assertEquals(originalX,node.x);assertEquals(originalY,node.y);
    }

    private static WorkflowModel connectedModel(){WorkflowModel model=new WorkflowModel();WorkflowModel.Node source=model.addNode(100,100),target=model.addNode(400,100);model.connect(source,target);return model;}
    private static CanvasPanel canvas(WorkflowModel model){CanvasPanel canvas=new CanvasPanel(model);canvas.setSize(1000,700);return canvas;}
    private static void click(CanvasPanel canvas,int x,int y,int modifiers,int button){long now=System.currentTimeMillis();canvas.dispatchEvent(new MouseEvent(canvas,MouseEvent.MOUSE_PRESSED,now,modifiers,x,y,1,false,button));canvas.dispatchEvent(new MouseEvent(canvas,MouseEvent.MOUSE_RELEASED,now+1,modifiers,x,y,1,false,button));}
    private static void drag(CanvasPanel canvas,int x1,int y1,int x2,int y2,int modifiers,int button){long now=System.currentTimeMillis();int buttonMask=button==MouseEvent.BUTTON1?InputEvent.BUTTON1_DOWN_MASK:InputEvent.BUTTON3_DOWN_MASK;canvas.dispatchEvent(new MouseEvent(canvas,MouseEvent.MOUSE_PRESSED,now,modifiers|buttonMask,x1,y1,1,false,button));canvas.dispatchEvent(new MouseEvent(canvas,MouseEvent.MOUSE_DRAGGED,now+1,modifiers|buttonMask,x2,y2,0,false,MouseEvent.NOBUTTON));canvas.dispatchEvent(new MouseEvent(canvas,MouseEvent.MOUSE_RELEASED,now+2,modifiers,x2,y2,1,false,button));}
    private static void wheel(CanvasPanel canvas,int x,int y,int rotation){canvas.dispatchEvent(new MouseWheelEvent(canvas,MouseEvent.MOUSE_WHEEL,System.currentTimeMillis(),0,x,y,0,false,MouseWheelEvent.WHEEL_UNIT_SCROLL,1,rotation));}
    private static void move(CanvasPanel canvas,int x,int y){canvas.dispatchEvent(new MouseEvent(canvas,MouseEvent.MOUSE_MOVED,System.currentTimeMillis(),0,x,y,0,false,MouseEvent.NOBUTTON));}
    private static void invoke(CanvasPanel canvas,String stroke){Object key=canvas.getInputMap(JComponent.WHEN_FOCUSED).get(KeyStroke.getKeyStroke(stroke));assertNotNull(key);Action action=canvas.getActionMap().get(key);assertNotNull(action);action.actionPerformed(new ActionEvent(canvas,ActionEvent.ACTION_PERFORMED,stroke));}
}
