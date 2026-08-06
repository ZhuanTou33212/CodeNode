package local.codenode;

import java.util.*;

public final class WorkflowDslService {
    public record Document(String expression,Map<String,Object> ast){}

    public Document decode(WorkflowModel model,List<WorkflowModel.Node> included,WorkflowModel.Node target){
        if(included==null||included.isEmpty())throw new IllegalArgumentException("DSL 范围不能为空");
        Set<String> allowed=new LinkedHashSet<>();included.forEach(node->allowed.add(node.id));
        List<String> roots=new ArrayList<>();
        if(target!=null&&target.nodeKind==WorkflowModel.NodeKind.GROUP_OUTPUT){for(WorkflowModel.Edge edge:model.edges())if(edge.target().equals(target.id)&&allowed.contains(edge.source()))roots.add(edge.source());}
        else if(target!=null&&allowed.contains(target.id))roots.add(target.id);
        if(roots.isEmpty())roots.add(included.getLast().id);
        List<Map<String,Object>> bodies=new ArrayList<>();List<String> expressions=new ArrayList<>();
        for(String root:roots){Set<String> visiting=new HashSet<>();NodeExpression value=build(model,root,allowed,visiting);expressions.add(value.text);bodies.add(value.ast);}
        Map<String,Object> ast=roots.size()==1?bodies.getFirst():Map.of("type","sequence","body",bodies);
        return new Document(String.join(";",expressions),ast);
    }

    private NodeExpression build(WorkflowModel model,String nodeId,Set<String> allowed,Set<String> visiting){
        if(!visiting.add(nodeId))throw new IllegalArgumentException("DSL 检测到隐式循环："+nodeId);
        List<WorkflowModel.Edge> incoming=model.edges().stream().filter(edge->edge.target().equals(nodeId)&&allowed.contains(edge.source())).toList();
        List<NodeExpression> dependencies=new ArrayList<>();for(WorkflowModel.Edge edge:incoming)dependencies.add(build(model,edge.source(),allowed,visiting));visiting.remove(nodeId);
        String text=nodeId+(dependencies.isEmpty()?"":"("+String.join(",",dependencies.stream().map(value->value.text).toList())+")");
        Map<String,Object> ast=dependencies.isEmpty()?Map.of("type","reference","nodeId",nodeId):Map.of("type","call","nodeId",nodeId,"arguments",dependencies.stream().map(value->value.ast).toList());
        return new NodeExpression(text,ast);
    }

    private record NodeExpression(String text,Map<String,Object> ast){}
}
