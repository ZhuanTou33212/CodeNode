import { useEffect, useMemo, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import ExtensionConnectForm from './ExtensionConnectForm';
import viewConfig from '../../config/ui.extensions.json';

function categoryOf(item: ProjectExtensionDto): string {
  return viewConfig.categories.find(category => category.kinds.some(kind => kind.toLowerCase() === item.kind.toLowerCase()))?.id || 'project';
}
function summaryOf(text: string): string {
  const first = text.split(/[。；\n]/)[0].trim();
  return first.length > viewConfig.summaryLength ? first.slice(0,viewConfig.summaryLength) + '…' : first;
}
export default function ExtensionsPanel({view='all',selectedName='',onItemsChange}:{view?:'all'|'plugins'|'skills';selectedName?:string;onItemsChange?:(items:ProjectExtensionDto[])=>void}) {
  const root = useProjectStore(state => state.root);
  const [items,setItems] = useState<ProjectExtensionDto[]>([]);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [revision,setRevision] = useState(0);
  const [query,setQuery] = useState('');
  const [category,setCategory] = useState('all');
  const [connecting,setConnecting]=useState(false);
  const [connectKind,setConnectKind]=useState('command');
  const [notice,setNotice]=useState('');
  useEffect(()=>{setConnecting(false);setNotice('');setQuery('');setCategory(view==='skills'?'skill':'all')},[root,view]);
  useEffect(()=>{onItemsChange?.(items)},[items,onItemsChange]);
  useEffect(()=>{setQuery(selectedName);if(selectedName)setCategory('all')},[selectedName]);
  useEffect(() => {
    let alive = true;
    setLoading(true);setError('');setItems([]);
    const load = async () => {
      try {
        if (!window.codenode?.listExtensions) throw new Error('当前环境无法读取项目扩展');
        const result = await window.codenode.listExtensions(root);
        if (!result.ok) throw new Error(result.error || '读取扩展失败');
        if (alive) setItems(result.extensions || []);
      } catch (error) { if (alive) setError(error instanceof Error ? error.message : String(error)); }
      finally { if (alive) setLoading(false); }
    };
    void load(); return () => { alive = false; };
  }, [root,revision]);
  const catalogItems=useMemo(()=>items.filter(item=>view==='skills'?categoryOf(item)==='skill':view==='plugins'?categoryOf(item)!=='skill':true),[items,view]);
  const filtered = useMemo(() => catalogItems.filter(item => (category === 'all' || categoryOf(item) === category) &&
    [item.name,item.description,item.kind,item.source].some(value => (value || '').toLowerCase().includes(query.trim().toLowerCase()))), [catalogItems,category,query]);
  return <section className="extensions-panel" aria-label="插件与工具">
    <header className="extensions-heading"><div><h2>{view==='skills'?'技能':'插件'}</h2><p>{view==='skills'?'为 Agent 添加可复用的工作指令':'连接项目工具，让 Agent 在你的工作流程中协同工作'}</p></div><div className="extensions-heading-actions">
      {!connecting && <div className="extensions-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input type="search" aria-label="搜索扩展与工具" placeholder="搜索插件与工具" value={query} onChange={event=>setQuery(event.target.value)}/></div>}
      <button type="button" className="extensions-refresh" title="刷新插件与工具" aria-label="刷新插件与工具" disabled={loading} onClick={()=>setRevision(value=>value+1)}>↻</button>
      <button type="button" className="extensions-add" disabled={!root || connecting} onClick={()=>{setConnectKind(view==='skills'?'skills':'command');setConnecting(true);setNotice('')}}>添加 ＋</button>
    </div></header>
    {notice && <p className="extensions-notice" role="status">{notice}</p>}
    {connecting && root ? <ExtensionConnectForm root={root} initialKind={connectKind} onCancel={()=>setConnecting(false)} onSaved={message=>{setConnecting(false);setNotice(message);setCategory('all');setQuery('');setRevision(value=>value+1)}}/> : <>
    <nav className="extensions-filters" aria-label="扩展分类">{viewConfig.categories.filter(group=>view==='skills'?['all','skill'].includes(group.id):view==='plugins'?group.id!=='skill':true).map(group => {
      const count = group.id === 'all' ? catalogItems.length : catalogItems.filter(item => categoryOf(item) === group.id).length;
      return <button type="button" key={group.id} data-category={group.id} aria-pressed={category === group.id} onClick={() => setCategory(group.id)}>{group.label}<span>{count}</span></button>;
    })}</nav>
    {(category === 'all'||view==='skills') && !query.trim() && <section className="extensions-connect-section"><h3>接入工具</h3><div className="extensions-connect-grid">{viewConfig.connectors.filter(connector=>view==='skills'?connector.kind==='skills':view==='plugins'?connector.kind!=='skills':true).map(connector=><button type="button" className="extension-connector" key={connector.kind} onClick={()=>{setConnectKind(connector.kind);setConnecting(true)}}><span className="extension-item-icon" aria-hidden="true">{connector.symbol}</span><span><strong>{connector.name}</strong><small>{connector.description}</small></span><span className="connector-add" aria-hidden="true">＋</span></button>)}</div></section>}
    <div className="extensions-result-count" aria-live="polite">{loading ? '正在读取…' : error ? '读取失败' : '共 ' + filtered.length + ' 项'}</div>
    {error ? <div className="extensions-empty" role="alert"><strong>无法读取扩展</strong><p>{error}</p><button type="button" onClick={() => setRevision(value => value+1)}>重试</button></div> : !loading && !filtered.length ?
      <div className="extensions-empty"><strong>{query.trim() ? '没有匹配的工具或扩展' : category === 'all' ? '当前项目还没有登记工具或扩展' : '当前项目尚未接入这类扩展'}</strong><p>{query.trim() ? '试试其他关键词，或切换分类。' : '接入后会显示在这里。'}</p>{(query || category !== 'all') && <button type="button" onClick={() => {setQuery('');setCategory('all');}}>查看全部</button>}</div> :
      <div className="extensions-catalog">{[{id:'installed',title:'已接入',groupItems:filtered.filter(item=>categoryOf(item)!=='builtin')},{id:'builtin',title:'内置工具',groupItems:filtered.filter(item=>categoryOf(item)==='builtin')}].map(({id,title,groupItems})=> {
        if(!groupItems.length)return null;
        const grid=<div className="extensions-list extensions-grid">{groupItems.map(item => <details className="extension-entry" open={item.name===selectedName||undefined} key={item.kind+'-'+item.source+'-'+item.name}>
        <summary><span className="extension-item-icon" aria-hidden="true">{categoryOf(item) === 'builtin' ? '⌘' : '＋'}</span><span className="extension-item-copy"><strong>{(viewConfig.displayNames as Record<string,string>)[item.name] || item.name}</strong><span className="extension-summary">{(viewConfig.summaries as Record<string,string>)[item.name] || summaryOf(item.description || '暂无用途说明')}</span></span><span className="extension-item-meta"><span className="extension-kind">{item.kind}</span><span className="extension-state">{item.enabled === false ? '已停用' : categoryOf(item) === 'builtin' ? '内置' : '已登记'}</span></span><span className="extension-chevron" aria-hidden="true">⌄</span></summary>
        <div className="extension-detail"><h3>用途与说明</h3><code className="extension-tool-id">{item.name}</code><p>{item.description || '暂无说明'}</p><dl><div><dt>来源</dt><dd>{item.source || '未提供'}</dd></div>{item.contract && <><div><dt>文件权限</dt><dd>{item.contract.readOnly ? '只读' : '可写'}</dd></div><div><dt>输出格式</dt><dd>{item.contract.outputSchema ? '已声明输出契约' : '未声明输出契约'}</dd></div>{item.contract.timeoutMs != null && <div><dt>超时时间</dt><dd>{item.contract.timeoutMs === 0 ? '未设置限制' : item.contract.timeoutMs + ' ms'}</dd></div>}</>}</dl></div>
      </details>)}</div>;
        return id==='builtin' ? <details className="extensions-builtin-group" key={id} open={category==='builtin'||!!query.trim()}><summary>{title}<span>{groupItems.length}</span><span aria-hidden="true">⌄</span></summary>{grid}</details> : <section className="extensions-installed" key={id}><h3>{title}<span>{groupItems.length}</span></h3>{grid}</section>;
      })}{category==='all'&&!query.trim()&&!filtered.some(item=>categoryOf(item)!=='builtin')&&<p className="extensions-install-empty">还没有接入项目插件。选择上方的接入方式，或点击“添加”。</p>}</div>}
    <details className="extensions-help"><summary>如何接入项目扩展</summary><p>点击“接入扩展”填写信息，或导入现成配置。MCP 会自动发现工具；接入后可用于后续 Agent 请求。</p></details></> }
  </section>;
}
