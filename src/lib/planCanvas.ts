import type { Node, Edge } from '@xyflow/react';
import type { PlanItem } from '../store/sessionStore';
import { useGraphStore } from '../store/graphStore';
import { useSessionStore } from '../store/sessionStore';

type Step = { key:string; title:string; objective:string; acceptance:string; dependsOn:string[]; writeScope?:string[] };

/** Add one planning proposal as editable canvas nodes in a single undo step. */
export function addPlanToCanvas(steps:Step[],sourceId:string): number {
  if(!steps.length)return 0;
  const store=useGraphStore.getState(),existing=new Set(store.nodes.map(node=>node.id));
  if(store.nodes.some(node=>node.data.planSourceId===sourceId))return 0;
  const prefix=`plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
  const ids=new Map(steps.map((step,index)=>[step.key,`${prefix}-${index+1}`]));
  const positions=new Map<string,number>();const byKey=new Map(steps.map(step=>[step.key,step]));
  const level=(key:string,seen=new Set<string>()):number=>{if(seen.has(key))return 0;seen.add(key);const deps=byKey.get(key)?.dependsOn||[];return deps.length?1+Math.max(...deps.filter(dep=>ids.has(dep)).map(dep=>level(dep,new Set(seen)))):0;};
  const nodes:Node[]=steps.map((step,index)=>{const x=level(step.key),row=positions.get(String(x))||0;positions.set(String(x),row+1);return{id:ids.get(step.key)!,type:'task',position:{x:60+x*304,y:100+row*178},data:{label:step.title||`步骤 ${index+1}`,prompt:step.objective,completionCondition:step.acceptance,writeScope:(step.writeScope||[]).join(', '),status:'pending',accent:'#3b82f6',planSourceId:sourceId}};});
  const edges:Edge[]=[];
  steps.forEach((step,index)=>{
    const deps=step.dependsOn.length?step.dependsOn:(index>0?[steps[index-1].key]:[]);
    for(const dep of deps){const source=ids.get(dep),target=ids.get(step.key);if(source&&target&&source!==target)edges.push({id:`${source}:${target}`,source,target,type:'waypoint'});}
  });
  if(nodes.some(node=>existing.has(node.id)))throw new Error('画布节点编号发生冲突，请重试');
  store.commit();
  useGraphStore.setState(state=>({nodes:[...state.nodes,...nodes],edges:[...state.edges,...edges],selectedId:nodes[0].id,selectedIds:[nodes[0].id]}));
  useGraphStore.getState().runFlow();
  useSessionStore.getState().syncActiveGraph();
  return nodes.length;
}

export function planItemsToSteps(items:PlanItem[]):Step[] {
  const included=items.filter(item=>item.status!=='cancelled');
  const known=new Set(included.map(item=>item.id));
  return included.map(item=>({key:item.id,title:item.step.slice(0,80),objective:item.step,acceptance:item.acceptanceCriteria||'完成本步骤并说明验证结果',dependsOn:(item.dependsOn||[]).filter(id=>known.has(id))}));
}
