import { useEffect, useState } from 'react';
import editingUi from '../../config/ui.editing.json';
import type { EditingSettings } from '../types';
import { useProjectStore } from '../store/projectStore';

export default function EditingSettingsPanel() {
  const root = useProjectStore(state => state.root);
  const [settings, setSettings] = useState<EditingSettings>(editingUi.defaults);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true; setSettings(editingUi.defaults); setMessage('');
    if (root && window.codenode?.agentConfig) void window.codenode.agentConfig(root).then(result => {
      if (alive) setSettings({ ...editingUi.defaults, ...result.editing });
    }).catch(error => { if (alive) setMessage(String(error)); });
    return () => { alive = false; };
  }, [root]);
  const change = (patch: Partial<EditingSettings>) => { setSettings(current => ({ ...current, ...patch })); setMessage(''); };
  const save = async () => {
    if (!root || !window.codenode?.editingSave || busy) return;
    setBusy(true);
    try {
      const result = await window.codenode.editingSave(root, settings);
      if (useProjectStore.getState().root === root) setMessage(result.ok ? '已保存，下次任务生效。' : result.error || '保存失败');
    } catch (error) { if (useProjectStore.getState().root === root) setMessage(String(error)); }
    finally { setBusy(false); }
  };
  if (!root) return <div className="dock-empty">先选择项目，再设置安全编辑与自动校验。</div>;
  return <div className="dock-rag-settings editing-settings">
    <p className="settings-scope">当前项目设置，日间与夜间共用。</p>
    <h3>安全编辑</h3>
    {([['checkSyntax','写入前检查 TS/JS/JSON 语法'],['protectLongFiles','保护已有长文件']] as const).map(([key,label]) => <label className="editing-toggle" key={key}>{label}<input aria-label={label} type="checkbox" checked={settings[key]} disabled={busy} onChange={event=>change({[key]:event.target.checked})}/></label>)}
    <label>长文件起始行数<input aria-label="长文件起始行数" type="number" min={editingUi.limits.longFileLines[0]} max={editingUi.limits.longFileLines[1]} value={settings.longFileLines} disabled={busy} onChange={event=>change({longFileLines:Number(event.target.value)})}/></label>
    <label>单次最多删除比例<input aria-label="单次最多删除比例" type="number" min={editingUi.limits.maxDeletedRatio[0]} max={editingUi.limits.maxDeletedRatio[1]} step={0.05} value={settings.maxDeletedRatio} disabled={busy} onChange={event=>change({maxDeletedRatio:Number(event.target.value)})}/></label>
    <p className="dock-rag-note">保护开启时，已有长文件使用局部替换；整批替换会在完成后统一检查语法。</p>
    <h3>修改后自动校验</h3>
    {([['autoVerify','自动执行局部校验'],['blockOnFailure','失败或结果失效时阻止完成']] as const).map(([key,label]) => <label className="editing-toggle" key={key}>{label}<input aria-label={label} type="checkbox" checked={settings[key]} disabled={busy} onChange={event=>change({[key]:event.target.checked})}/></label>)}
    <label>lint 命令<input aria-label="lint 命令" value={settings.lintCommand} disabled={busy} placeholder="留空检测本地 ESLint" onChange={event=>change({lintCommand:event.target.value})}/></label>
    <label>测试命令<input aria-label="测试命令" value={settings.testCommand} disabled={busy} placeholder="留空检测本地运行器与相关测试" onChange={event=>change({testCommand:event.target.value})}/></label>
    <p className="dock-rag-note">命令在项目内执行，可用 {'{files}'} 传入本轮修改路径。不会下载运行器；未找到检查项会显示未执行。</p>
    <label>单项超时（秒）<input aria-label="单项校验超时" type="number" min={editingUi.limits.timeoutSeconds[0]} max={editingUi.limits.timeoutSeconds[1]} value={settings.timeoutSeconds} disabled={busy} onChange={event=>change({timeoutSeconds:Number(event.target.value)})}/></label>
    <label>每次任务最多校验轮数<input aria-label="最多校验轮数" type="number" min={editingUi.limits.maxVerificationRuns[0]} max={editingUi.limits.maxVerificationRuns[1]} value={settings.maxVerificationRuns} disabled={busy} onChange={event=>change({maxVerificationRuns:Number(event.target.value)})}/></label>
    <button disabled={busy} onClick={()=>void save()}>{busy?'保存中…':'保存项目设置'}</button>
    {message && <div className="dock-rag-note" role="status">{message}</div>}
  </div>;
}
