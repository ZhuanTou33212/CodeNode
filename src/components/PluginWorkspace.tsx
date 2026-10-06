import { useState, type CSSProperties } from 'react';
import { useUiStore } from '../store/uiStore';
import ExtensionsPanel from './ExtensionsPanel';
export default function PluginWorkspace() {
  const {navigationOpen,navigationWidth,pluginView,setPluginView}=useUiStore();
  const [items,setItems]=useState<ProjectExtensionDto[]>([]);
  const [selected,setSelected]=useState('');
  const installed=items.filter(item=>item.kind!=='内置工具');
  return <section className="plugin-workspace" aria-label="插件工作区">
    {navigationOpen&&<aside className="plugin-navigation" aria-label="自定义导航" style={{'--navigation-width':navigationWidth+'px'} as CSSProperties}>
      <h2>自定义</h2>
      <nav aria-label="自定义分类"><button aria-pressed={pluginView==='plugins'} onClick={()=>{setSelected('');setPluginView('plugins')}}><span aria-hidden="true">⊞</span>插件</button><button aria-pressed={pluginView==='skills'} onClick={()=>{setSelected('');setPluginView('skills')}}><span aria-hidden="true">◇</span>技能</button></nav>
      <h3>已接入</h3>
      <div className="plugin-installed-navigation">{installed.length?installed.map(item=><button key={item.kind+'-'+item.name} aria-current={selected===item.name?'true':undefined} title={item.name} onClick={()=>{setPluginView(/^(skill|skills)$/i.test(item.kind)?'skills':'plugins');setSelected(item.name)}}><span aria-hidden="true">◇</span><span>{item.name}</span></button>):<p>暂无项目扩展</p>}</div>
    </aside>}
    <main className="plugin-page" aria-label={pluginView==='skills'?'技能页面':'插件页面'}><div className="plugin-page-content"><ExtensionsPanel view={pluginView} selectedName={selected} onItemsChange={setItems}/></div></main>
  </section>;
}
