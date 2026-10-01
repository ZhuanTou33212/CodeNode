import type { ToolRecord } from '../../types';
import { useProjectStore } from '../../store/projectStore';
import { useGraphStore } from '../../store/graphStore';
import { useUiStore } from '../../store/uiStore';

type AnyData = Record<string, unknown>;

function object(value: unknown): AnyData {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyData : {};
}

function argsOf(tool: ToolRecord): AnyData {
  if (typeof tool.args !== 'string') return object(tool.args);
  try { return object(JSON.parse(tool.args)); } catch { return {}; }
}

function text(value: unknown): string { return value == null ? '' : String(value); }
function list(value: unknown): AnyData[] { return Array.isArray(value) ? value.map(object) : []; }

function sourceMethod(source: AnyData): string {
  if (source.kind === 'scalar') return source.exact ? '标量精确键' : '标量内容匹配';
  if (source.graphOnly) return `代码关系${source.graphRelation ? ' · ' + source.graphRelation : ''}`;
  if (source.vectorOnly) return '向量独立召回';
  if (source.vectorScore != null) return '词法 + 向量融合';
  return 'BM25 词法';
}

export default function TaskTrace({ tools, status }: { tools: ToolRecord[]; status?: string }) {
  const root = useProjectStore((s) => s.root);
  const openFile = useProjectStore((s) => s.openFile);
  const retrievals = tools.filter((tool) => tool.name === 'retrieve_context');
  const writes = tools.filter((tool) => ['write_file', 'edit_file', 'workbench_edit'].includes(tool.name));
  const checks = tools.filter((tool) => ['execute_shell', 'run_tests'].includes(tool.name));
  const failures = tools.filter((tool) => tool.ok === false);
  const firstSources = retrievals.flatMap((tool) => list(object(tool.data).sources).map((source) => ({ source, tool })));
  const show = retrievals.length || writes.length || checks.length || failures.length;
  if (!show) return null;

  const openSource = (source: AnyData) => {
    if (source.kind === 'scalar') {
      const key = text(source.key);
      const nodeId = key.startsWith('node:') ? key.slice(5).split(':')[0] : '';
      if (nodeId && useGraphStore.getState().nodes.some((node) => node.id === nodeId)) {
        useGraphStore.getState().setSelectedId(nodeId);
        useUiStore.getState().setSideTab('node');
      }
      return;
    }
    const path = text(source.path);
    if (path && root) {
      void openFile(path);
      useUiStore.getState().openDock('editor');
    }
  };

  return (
    <section className="task-trace" aria-label="任务轨迹">
      <div className="task-trace-head">
        <strong>任务轨迹</strong>
        <span>{status === 'running' ? '执行中' : status === 'failed' ? '失败' : status === 'stopped' ? '已停止' : status === 'truncated' ? '已截断' : '本轮已结束'} · {tools.length} 次工具调用</span>
        <button type="button" onClick={() => useUiStore.getState().openDock('runs')}>运行与恢复</button>
      </div>
      {retrievals.length > 0 && <div className="task-trace-section">
        <strong>定位 · {firstSources.length} 条来源</strong>
        <p>匹配度表示检索相关性；结论仍需核对原文。</p>
        {retrievals.map((tool, i) => {
          const data = object(tool.data);
          const index = object(data.index);
          const vector = object(index.vector);
          const rerank = object(index.rerank);
          const quality = object(data.quality);
          const query = text(data.query || argsOf(tool).query);
          const scope = argsOf(tool);
          return <div className="task-trace-query" key={tool.id || i}>
            <div>查询：{query || '未记录'} · 范围：{text(scope.path || scope.filePattern || '整个项目')} · 匹配度：{text(quality.level || '未知')}</div>
            <div className="task-trace-meta">索引 {index.indexedFiles == null ? '文件数未知' : `${index.indexedFiles} 文件`}{index.indexedAt ? ` · 更新 ${new Date(text(index.indexedAt)).toLocaleString()}` : ''} · 向量 {text(vector.provider || 'none')}/{text(vector.backend || 'none')}</div>
            {vector.provider === 'local' && <div className="task-trace-meta">本地哈希向量主要匹配词项，不提供跨表达语义理解。</div>}
            {Boolean(vector.error) && <div className="task-trace-warning">向量服务降级：{text(vector.error)}；已保留 BM25 结果。</div>}
            {Boolean(rerank.error) && <div className="task-trace-warning">重排失败：{text(rerank.error)}；保留原排序。</div>}
          </div>;
        })}
        {firstSources.slice(0, 12).map(({ source }, i) => <button className="task-trace-source" type="button" key={`${text(source.citation)}-${i}`} onClick={() => openSource(source)}>
          <span>{text(source.citation || source.path || source.key)}</span>
          <small>{source.symbol ? `${text(source.symbol)} · ` : ''}{sourceMethod(source)}{Array.isArray(source.matchedTerms) && source.matchedTerms.length ? ` · 命中 ${source.matchedTerms.slice(0, 4).join('、')}` : ''}</small>
        </button>)}
        {firstSources.length > 12 && <div className="task-trace-meta">另有 {firstSources.length - 12} 条，见下方原始工具记录。</div>}
      </div>}
      {writes.length > 0 && <div className="task-trace-section">
        <strong>修改审查 · {writes.filter((tool) => tool.ok).length}/{writes.length} 次成功</strong>
        {writes.map((tool, i) => {
          const data = object(tool.data);
          const review = object(data.review);
          const path = text(data.path || argsOf(tool).path);
          const nodes = [...(Array.isArray(data.created) ? data.created : []), ...(Array.isArray(data.affected) ? data.affected : [])].map(text);
          return <div className="task-trace-change" key={tool.id || i}>
            <div className="task-trace-change-head"><span>{tool.ok === true ? '✓' : tool.ok === false ? '✕' : '…'} Agent · {tool.name} · {path || (nodes.length ? nodes.join('、') : '画布')}</span>{path && <button type="button" onClick={() => { void openFile(path); useUiStore.getState().openDock('editor'); }}>打开文件</button>}</div>
            {review.diff ? <details><summary>查看执行时的前后差异（+{text(review.addedLines)} / −{text(review.removedLines)} 行）{review.truncated ? ' · 摘要已截断' : ''}</summary><pre>{text(review.diff)}</pre></details> : <div className="task-trace-meta">{text(data.reviewUnavailable || (tool.ok === true ? '本次未记录内联差异，请查看运行记录或回滚计划。' : tool.ok === false ? tool.result || '操作失败' : '等待工具结果'))}</div>}
          </div>;
        })}
      </div>}
      {checks.length > 0 && <div className="task-trace-section"><strong>执行检查 · {checks.length} 次</strong>{checks.map((tool, i) => <div className="task-trace-meta" key={tool.id || i}>{tool.ok === true ? '✓' : tool.ok === false ? '✕' : '…'} {text(argsOf(tool).command || tool.name)}{tool.ok === false ? ` · ${text(tool.result).slice(0, 160)}` : ''}</div>)}</div>}
      {failures.length > 0 && <div className="task-trace-section"><strong>未完成 / 失败 · {failures.length} 次</strong>{failures.map((tool, i) => <div className="task-trace-warning" key={tool.id || i}>{tool.name}：{text(tool.result).slice(0, 240)}</div>)}</div>}
    </section>
  );
}
