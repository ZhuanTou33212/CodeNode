import { useEffect, useState } from 'react';
import schedulingUi from '../../config/ui.scheduling.json';
import type { SchedulingSettings } from '../types';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';

const fields: { key: keyof SchedulingSettings; label: string }[] = [
  { key: 'concurrency', label: '子任务与模型请求并发上限' },
  { key: 'maxTasksPerRun', label: '每次运行子任务上限' },
  { key: 'maxBatchTasks', label: '单批子任务上限' },
  { key: 'warningPercent', label: '子任务配额预警百分比' },
  { key: 'maxAttemptsPerTask', label: '单任务尝试上限（含首次）' },
  { key: 'maxAttemptsPerRun', label: '每次运行尝试上限（含首次）' },
];

export default function SchedulingSettingsPanel() {
  const root = useProjectStore(state => state.root);
  const streaming = useSessionStore(state => state.streaming);
  const [settings, setSettings] = useState<SchedulingSettings>({ ...schedulingUi.defaults });
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    setBusy(true); setMessage('');
    if (!window.codenode?.agentConfig) { setBusy(false); return; }
    void window.codenode.agentConfig(root).then(config => {
      if (alive) setSettings(config.scheduling || { ...schedulingUi.defaults });
    }).catch(error => { if (alive) setMessage(String(error)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [root]);
  const save = async () => {
    if (busy || streaming || !window.codenode?.schedulingSave) return;
    setBusy(true); setMessage('');
    try {
      const result = await window.codenode.schedulingSave(settings);
      if (result.ok && result.settings) { setSettings(result.settings); setMessage('已保存，下次任务生效。'); }
      else setMessage(result.error || '保存失败');
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  return <div className="scheduling-settings">
    <h3>全局调度</h3>
    {fields.map(({ key, label }) => <label className="settings-row" key={key}><span>{label}</span><input aria-label={label} type="number" min={schedulingUi.limits[key].min} max={schedulingUi.limits[key].max} step="1" value={Number.isFinite(settings[key]) ? settings[key] : ''} disabled={busy || streaming} onChange={event => setSettings(previous => ({ ...previous, [key]: event.target.value === '' ? NaN : Number(event.target.value) }))} /></label>)}
    <p className="settings-scope">应用于所有项目，昼夜共用。并发值同时限制子任务和模型请求；共享工作区写任务仍独占执行。</p>
    <p className="settings-scope">已启动 {Math.ceil(settings.maxTasksPerRun * settings.warningPercent / 100) || 0}/{settings.maxTasksPerRun || 0} 个子任务时，提醒主 Agent 收敛计划、优先验证并汇总结果。失败或启动后取消仍计入额度。</p>
    <p className="settings-scope">同一任务重做保留任务 ID，每次启动计入尝试额度；重做前核对并补偿上一尝试的文件改动，后续修改或未知副作用会阻止重做。</p>
    <button disabled={busy || streaming} onClick={() => void save()}>保存调度设置</button>
    {message && <p className="settings-scope" role="status">{message}</p>}
  </div>;
}
