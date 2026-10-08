import { useEffect, useState } from 'react';
import backendConfig from '../../config/agent.backends.json';
import type { AgentBackendSettings } from '../types';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';

export default function BackendSettingsPanel() {
  const root = useProjectStore(s => s.root);
  const streaming = useSessionStore(s => s.streaming);
  const [settings, setSettings] = useState(backendConfig.defaults as AgentBackendSettings);
  const [scope, setScope] = useState<'machine' | 'project'>('machine');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    setBusy(true); setMessage('');
    void window.codenode?.agentConfig(root).then(result => {
      if (!alive) return;
      setSettings(result.backend?.settings || backendConfig.defaults as AgentBackendSettings);
      setScope(result.backend?.scope || 'machine');
    }).catch(error => { if (alive) setMessage(String(error)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [root]);
  const save = async (inherit = false) => {
    if (busy || streaming || !window.codenode) return;
    setBusy(true); setMessage('');
    try {
      const result = await window.codenode.backendSave(root, inherit ? 'project' : scope, inherit ? null : settings);
      if (useProjectStore.getState().root !== root) return;
      if (!result.ok) { setMessage(result.error || '保存失败'); return; }
      if (result.settings) setSettings(result.settings);
      if (result.scope) setScope(result.scope);
      window.dispatchEvent(new Event('codenode-backend-settings'));
      setMessage('已保存，下次任务生效。已有后端会话只通过原后端恢复。');
    } catch (error) { if (useProjectStore.getState().root === root) setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const check = async () => {
    if (busy || !window.codenode) return;
    setBusy(true); setMessage('');
    try {
      const result = await window.codenode.backendStatus(root);
      if (useProjectStore.getState().root !== root) return;
      const c = result.capabilities;
      setMessage(!result.ok || !c?.available ? result.error || c?.error || '后端不可用' : c.backend === 'builtin' ? '内置后端可用。' :
        `Codex ${c.protocolVersion} 协议可用；${c.authenticated ? '已检测到登录账户' : '未检测到登录账户，请先在本机 codex login；自定义 provider 以实际执行结果为准'}。支持对话、事件、审批、中断、恢复；费用未知，无逐请求硬费用上限。`);
    } catch (error) { if (useProjectStore.getState().root === root) setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const disabled = busy || streaming;
  return <div className="agent-execution-settings backend-settings-panel" data-testid="backend-settings">
    <h3>Agent 后端</h3>
    <label className="settings-row"><span>配置范围</span><select aria-label="后端配置范围" value={scope} disabled={disabled} onChange={e => setScope(e.target.value as 'machine' | 'project')}><option value="machine">本机默认</option><option value="project" disabled={!root}>当前项目覆盖</option></select></label>
    <label className="settings-row"><span>执行后端</span><select aria-label="执行后端" value={settings.backend} disabled={disabled} onChange={e => setSettings(s => ({ ...s, backend: e.target.value as AgentBackendSettings['backend'] }))}><option value="builtin">CodeNode 内置</option><option value="codex">Codex app-server</option></select></label>
    {settings.backend === 'codex' && <>
      <label className="settings-row"><span>Codex 可执行文件</span><input aria-label="Codex 可执行文件" value={settings.executable} disabled={disabled} onChange={e => setSettings(s => ({ ...s, executable: e.target.value }))} /></label>
      <label className="settings-row"><span>Codex 模型（留空跟随 Codex）</span><input aria-label="Codex 模型" value={settings.model} disabled={disabled} onChange={e => setSettings(s => ({ ...s, model: e.target.value }))} /></label>
      <label className="settings-row"><span>项目文件权限</span><select aria-label="Codex 项目文件权限" value={settings.sandbox} disabled={disabled} onChange={e => setSettings(s => ({ ...s, sandbox: e.target.value as AgentBackendSettings['sandbox'] }))}><option value="read-only">只读</option><option value="workspace-write">允许修改项目文件</option></select></label>
      <p className="settings-scope">支持本机 Codex {backendConfig.supportedProtocolVersions.join(' / ')} 及其登录或 provider 配置。自动查找原生程序，也支持桌面版自带运行时。工作目录固定为当前项目，审批由 Codex 请求并逐次交给用户；网络默认关闭。首版支持文件任务，画布提供上下文；画布修改、CodeNode 子 Agent、图片及 /compact 使用内置后端。费用未知，CodeNode 的硬费用预算不覆盖外部执行。</p>
    </>}
    <div className="settings-row"><button onClick={() => void save()} disabled={disabled || scope === 'project' && !root}>保存后端</button><button onClick={() => void check()} disabled={disabled}>检测已保存后端</button>{root && <button onClick={() => void save(true)} disabled={disabled}>项目跟随本机默认</button>}</div>
    {message && <p className="settings-scope" role="status">{message}</p>}
  </div>;
}
