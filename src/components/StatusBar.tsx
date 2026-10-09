import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';

export default function StatusBar() {
  const nodeCount=useGraphStore(s=>s.nodes.length);
  const edgeCount=useGraphStore(s=>s.edges.length);
  const selectedCount=useGraphStore(s=>s.selectedIds.length);
  const toast=useUiStore(s=>s.toast);
  const [focus,setFocus]=useState<'text'|'vector'|'canvas'|'panel'>('canvas');
  const viewport=useReactFlow().getViewport();
  useEffect(()=>{
    const update=()=>{const e=document.activeElement as HTMLElement|null;setFocus(e?.matches('input,textarea,select,[contenteditable="true"]')?'text':e?.closest('.vs-scope')?'vector':e&&e!==document.body&&!e.closest('.canvas-wrap')?'panel':'canvas');};
    update();document.addEventListener('focusin',update);document.addEventListener('focusout',update);return()=>{document.removeEventListener('focusin',update);document.removeEventListener('focusout',update);};
  },[]);
  const hint=focus==='text'?'文字编辑中 · Delete / Backspace 删除文字':focus==='vector'?(selectedCount?'画布节点已选中 · 有选中图形时删图形，否则 Delete 删除节点':'节点内编辑 · 点击图形或节点后按 Delete 删除'):focus==='panel'?'点击节点标题或边框后，可用 Delete 删除节点':selectedCount?`已选中 ${selectedCount} 个节点 · Delete / X 删除 · Ctrl+Z 撤销`:'点击节点标题或边框选中 · 中键拖动画布 · Shift+A 添加节点';
  return <footer className="status-bar"><span>节点 {nodeCount}</span><span>连线 {edgeCount}</span><span>选中 {selectedCount}</span><span>缩放 {Math.round(viewport.zoom*100)}%</span><span className="status-toast" role="status" aria-live="polite" aria-atomic="true">{toast||''}</span><span className="status-hint">{hint}</span></footer>;
}
