import { useEffect, useState } from 'react';
import defaults from '../../config/ui.costs.json';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import type { CostSettings, TaskCosts } from '../types';

const initial = (): CostSettings => ({ delegationGate: defaults.defaults.delegationGate, roleModels: { ...defaults.defaults.roleModels } });
const money = (value: number | null) => value == null ? '未知' : '$' + value.toFixed(6);
const statuses: Record<string, string> = { completed: '已完成', failed: '失败', error: '失败', cancelled: '已取消', blocked: '受阻', limit_reached: '达到上限', unknown: '未记录结果' };
export default function CostSettingsPanel() {
  const root = useProjectStore(state => state.root);
  const streaming = useSessionStore(state => state.streaming);
  const [settings, setSettings] = useState<CostSettings>(initial);
  const [models, setModels] = useState<ModelSpecDto[]>([]);
  const [roles, setRoles] = useState<{ name: string; label: string }[]>([]);
  const [costs, setCosts] = useState<TaskCosts | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    setSettings(initial()); setMessage(''); setCosts(null); setModels([]); setRoles([]);
    if (!root || !window.codenode) return;
    setBusy(true);
    void Promise.all([window.codenode.agentConfig(root), window.codenode.agentMetrics(root)]).then(([config, metrics]) => {
      if (!alive) return;
      setSettings(config.costSettings || initial()); setModels(config.models || []); setRoles(config.subagentRoles || []);
      setCosts(metrics.taskCosts || null);
    }).catch(error => { if (alive) setMessage(String(error)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [root]);
  const save = async () => {
    if (!root || busy || streaming || !window.codenode) return;
    setBusy(true); setMessage('');
    try {
      const result = await window.codenode.costSettingsSave(root, settings);
      if (useProjectStore.getState().root !== root) return;
      setMessage(result.ok ? '已保存，下次任务生效。' : result.error || '保存失败');
    } catch (error) { if (useProjectStore.getState().root === root) setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const disabled = !root || busy || streaming;
  return <div className="cost-settings">
    <p className="settings-scope">应用于当前项目，昼夜共用。主 Agent 使用对话输入框选择的模型；角色默认跟随主 Agent，可从已接入模型中单独选择。</p>
    <label className="settings-row"><span>小任务由主 Agent 直接完成</span><input aria-label="小任务直接执行" type="checkbox" checked={settings.delegationGate} disabled={disabled} onChange={event => setSettings({ ...settings, delegationGate: event.target.checked })} /></label>
    <p className="settings-scope">已声明的单步操作和明确的单文件读取不会启动子 Agent；独立审查、验证、阶段及依赖任务仍可委派。判断过程不调用模型。</p>
    {roles.map(role => <label className="settings-row" key={role.name}><span>{role.label}</span><select aria-label={role.label + '模型'} disabled={disabled} value={settings.roleModels[role.name] || ''} onChange={event => setSettings({ ...settings, roleModels: { ...settings.roleModels, [role.name]: event.target.value } })}>
      <option value="">跟随主 Agent</option>
      {settings.roleModels[role.name] && !models.some(model => model.id === settings.roleModels[role.name]) && <option value={settings.roleModels[role.name]}>模型已移除，请重新选择</option>}
      {models.filter(model => model.enabled !== false).map(model => <option key={model.id} value={model.id}>{model.label || model.model}</option>)}
    </select></label>)}
    <button disabled={disabled} onClick={() => void save()}>保存成本与模型设置</button>
    {message && <p role="status" className="settings-scope">{message}</p>}
    <h3>任务成本</h3>
    <p className="settings-scope">记录范围内共 {costs?.runCount || 0} 次运行，完成 {costs?.completedRuns || 0} 次，通过局部校验 {costs?.verifiedRuns || 0} 次。局部校验不代表完整任务正确率。</p>
    <p className="settings-scope">总成本 {money(costs?.totalCostUsd ?? null)} · 每次完成成本 {money(costs?.costPerCompletedRun ?? null)} · 每次通过局部校验成本 {money(costs?.costPerVerifiedRun ?? null)}。分子包含失败和取消的运行；缺失价格时显示未知。</p>
    <div className="task-cost-list">{costs?.tasks.length ? costs.tasks.slice(0, 20).map(task => <details key={task.runId + ':' + task.taskId + ':' + task.executionId}>
      <summary>{roles.find(role => role.name === task.role)?.label || (task.role === 'main' ? '主 Agent' : task.role)} · {statuses[task.status] || task.status} · {task.totalTokens.toLocaleString()} token · {money(task.costKnown ? task.costUsd : null)}</summary>
      <p className="settings-scope">{task.runId} / {task.taskId} · 模型：{task.models.join('、') || '未调用'} · 请求 {task.requests} · 重试 {task.retries} · {task.verified ? '局部校验通过' : '未记录通过的局部校验'}</p>
      <p className="settings-scope">输入 {task.promptTokens} · 输出 {task.completionTokens} · 缓存命中 {task.promptCachedTokens} · 估算请求 {task.estimated} · 调用分类 {Object.entries(task.kinds).map(([kind, count]) => kind + ' ' + count).join('、')}</p>
    </details>) : <p className="settings-scope">尚无任务成本记录</p>}</div>
  </div>;
}
