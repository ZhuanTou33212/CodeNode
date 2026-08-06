package local.codenode;

import java.util.*;

public final class CodeSlotService {
    public enum ProposalStatus { READY, CONFLICTED }
    public record ProposalResult(ProposalStatus status,String reason){}

    public ProposalResult propose(WorkflowModel model,String slotId,String requestId,long baseRevision,String code,String classificationKey){
        Objects.requireNonNull(model);WorkflowModel.CodeSlot slot=model.codeSlot(slotId);
        if(slot==null)throw new IllegalArgumentException("申请引用了不存在的代码槽："+slotId);
        if(requestId==null||requestId.isBlank())throw new IllegalArgumentException("申请 ID 不能为空");
        if(code==null||code.isBlank())throw new IllegalArgumentException("Agent 返回的代码不能为空");
        if(code.length()>4*1024*1024)throw new IllegalArgumentException("Agent 返回的代码超过 4 MiB");
        if(!NodeRegistry.isKnown(classificationKey))throw new IllegalArgumentException("未知代码分类："+classificationKey);
        if(slot.draft!=null&&!slot.draft.requestId.equals(requestId))return new ProposalResult(ProposalStatus.CONFLICTED,"代码槽已有其他待审查草稿");
        if(slot.activeRevision!=baseRevision)return new ProposalResult(ProposalStatus.CONFLICTED,"活动版本已从 "+baseRevision+" 变为 "+slot.activeRevision);
        slot.draft=new WorkflowModel.CodeDraft(requestId,baseRevision,code,classificationKey);slot.lastAppliedRequestId=requestId;model.touch();
        updateOwners(model,slot,WorkflowModel.Status.REVIEW_READY,classificationKey,"");
        return new ProposalResult(ProposalStatus.READY,"草稿已进入代码审查");
    }

    public void accept(WorkflowModel model,String slotId){
        WorkflowModel.CodeSlot slot=required(model,slotId);if(slot.draft==null)throw new IllegalStateException("代码槽没有待审查草稿");
        slot.previousCode=slot.activeCode;slot.previousSourceRevision=slot.activeRevision;slot.activeCode=slot.draft.code;slot.activeRevision++;String classification=slot.draft.classificationKey;slot.draft=null;model.touch();updateOwners(model,slot,WorkflowModel.Status.ACCEPTED,classification,"");
    }

    public void rollback(WorkflowModel model,String slotId){WorkflowModel.CodeSlot slot=required(model,slotId);if(slot.previousSourceRevision<0)throw new IllegalStateException("代码槽没有可回滚版本");String current=slot.activeCode;long currentSource=slot.activeRevision;slot.activeCode=slot.previousCode;slot.previousCode=current;slot.previousSourceRevision=currentSource;slot.activeRevision++;slot.draft=null;model.touch();updateOwners(model,slot,WorkflowModel.Status.ACCEPTED,null,"");}

    public void reject(WorkflowModel model,String slotId){WorkflowModel.CodeSlot slot=required(model,slotId);if(slot.draft==null)return;slot.draft=null;model.touch();updateOwners(model,slot,WorkflowModel.Status.REJECTED,null,"");}

    public void markConflicted(WorkflowModel model,String slotId,String reason){WorkflowModel.CodeSlot slot=required(model,slotId);updateOwners(model,slot,WorkflowModel.Status.CONFLICTED,null,reason);}

    public List<WorkflowModel.Node> owners(WorkflowModel model,String slotId){
        WorkflowModel.CodeSlot slot=required(model,slotId);
        if("node".equals(slot.ownerKind)){WorkflowModel.Node node=model.byId(slot.ownerId);return node==null?List.of():List.of(node);}
        if("default".equals(slot.ownerId))return model.nodes().stream().filter(n->n.nodeKind!=WorkflowModel.NodeKind.FILE).toList();
        return model.nodes().stream().filter(n->n.id.equals(slot.ownerId)||n.fileNodeId.equals(slot.ownerId)).toList();
    }

    private static WorkflowModel.CodeSlot required(WorkflowModel model,String id){WorkflowModel.CodeSlot slot=model.codeSlot(id);if(slot==null)throw new IllegalArgumentException("代码槽不存在："+id);return slot;}
    private void updateOwners(WorkflowModel model,WorkflowModel.CodeSlot slot,WorkflowModel.Status status,String classification,String diagnostic){for(WorkflowModel.Node node:owners(model,slot.id)){node.status=status;if(classification!=null){node.classificationKey=classification;node.category=NodeRegistry.category(classification);}node.diagnostic=diagnostic==null?"":diagnostic;}}
}
