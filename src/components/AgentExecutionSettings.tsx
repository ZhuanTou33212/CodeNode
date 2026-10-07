import { useEffect, useState } from 'react';
import agentUi from '../../config/ui.agent.json';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';

export default function AgentExecutionSettings() {
  const root = useProjectStore(state => state.root);
  const streaming = useSessionStore(state => state.streaming);
  const [automatic, setAutomatic] = useState(agentUi.defaults.autoExecuteTools);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    setAutomatic(agentUi.defaults.autoExecuteTools); setMessage('');
    if (!root || !window.codenode?.agentConfig) return;
    setBusy(true);
    void window.codenode.agentConfig(root).then(config => {
      if (alive) setAutomatic(config.autoExecuteTools ?? agentUi.defaults.autoExecuteTools);
    }).catch(error => { if (alive) setMessage(String(error)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [root]);
  const save = async (value: boolean) => {
    if (!root || busy || !window.codenode?.executionSave) return;
    setBusy(true); setMessage('');
    try {
      const result = await window.codenode.executionSave(root, { autoExecuteTools: value });
      if (useProjectStore.getState().root !== root) return;
      if (result.ok) { setAutomatic(value); setMessage('已保存，下次任务生效。'); }
      else setMessage(result.error || '保存失败');
    } catch (error) { if (useProjectStore.getState().root === root) setMessage(String(error)); }
    finally { setBusy(false); }
  };
  return <div className="agent-execution-settings">
    <h3>Agent 执行</h3>
    <label className="settings-row"><span>普通工具自动执行</span><input aria-label="普通工具自动执行" type="checkbox" checked={automatic} disabled={!root || busy || streaming} onChange={event => void save(event.target.checked)} /></label>
    <p className="settings-scope">文件读写、创建和编辑画布无需逐次确认；高风险、工作树等操作保留审批。设置应用于当前项目，昼夜共用。</p>
    {message && <p className="settings-scope" role="status">{message}</p>}
  </div>;
}
