import { useEffect, useState } from 'react';
import backendConfig from '../../config/agent.backends.json';
import type { AgentBackendSettings } from '../types';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';

const backendArgs = backendConfig.defaultArgs as Partial<Record<AgentBackendSettings['backend'], string[]>>;
const backendCommands = backendConfig.commands as Record<AgentBackendSettings['backend'], string>;

export default function BackendSettingsPanel() {
  const root = useProjectStore(s => s.root);
  const streaming = useSessionStore(s => s.streaming);
  const [settings, setSettings] = useState(backendConfig.defaults as AgentBackendSettings);
  const [scope, setScope] = useState<'machine' | 'project'>('machine');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [argsText, setArgsText] = useState('');
  const [acpText, setAcpText] = useState('{}');
  const [agentInfo, setAgentInfo] = useState<any>(null);
  const isAcp = ['hermes', 'opencode', 'openclaw'].includes(settings.backend);
  useEffect(() => {
    let alive = true;
    setBusy(true); setMessage('');
    void window.codenode?.agentConfig(root).then(result => {
      if (!alive) return;
      setSettings(result.backend?.settings || backendConfig.defaults as AgentBackendSettings);
      setArgsText(JSON.stringify(result.backend?.settings.args || [], null, 2));
      setAcpText(JSON.stringify(result.backend?.settings.acp || {}, null, 2)); setAgentInfo(null);
      setScope(result.backend?.scope || 'machine');
    }).catch(error => { if (alive) setMessage(String(error)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [root]);
  const save = async (inherit = false) => {
    if (busy || streaming || !window.codenode) return;
    setBusy(true); setMessage('');
    try {
      let next = settings;
      if (!inherit) {
        let args: unknown;
        try { args = JSON.parse(argsText || '[]'); } catch { setMessage('启动参数必须是 JSON 字符串数组'); setBusy(false); return; }
        if (!Array.isArray(args) || args.some(item => typeof item !== 'string')) { setMessage('启动参数必须是 JSON 字符串数组'); setBusy(false); return; }
        next = { ...settings, args, ...(isAcp ? { acp: JSON.parse(acpText) } : {}) };
      }
      const result = await window.codenode.backendSave(root, inherit ? 'project' : scope, inherit ? null : next);
      if (useProjectStore.getState().root !== root) return;
      if (!result.ok) { setMessage(result.error || '保存失败'); return; }
      if (result.settings) { setSettings(result.settings); setArgsText(JSON.stringify(result.settings.args || [], null, 2)); setAcpText(JSON.stringify(result.settings.acp || {}, null, 2)); }
      if (result.scope) setScope(result.scope);
      window.dispatchEvent(new Event('codenode-backend-settings'));
      setMessage('已保存，下次任务生效。已有后端会话只通过原后端恢复。');
    } catch (error) { if (useProjectStore.getState().root === root) setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const check = async () => {
    if (busy || streaming || !window.codenode) return;
    setBusy(true); setMessage('');
    try {
      let args: unknown;
      try { args = JSON.parse(argsText || '[]'); } catch { setMessage('启动参数必须是 JSON 字符串数组'); return; }
      if (!Array.isArray(args) || args.some(item => typeof item !== 'string')) { setMessage('启动参数必须是 JSON 字符串数组'); return; }
      const result = await window.codenode.backendStatus(root, { ...settings, args, ...(isAcp ? { acp: JSON.parse(acpText) } : {}) });
      if (useProjectStore.getState().root !== root) return;
      const c = result.capabilities;
      setMessage(!result.ok || !c?.available ? result.error || c?.error || '后端不可用' : c.backend === 'builtin' ? '内置后端可用。' : c.backend==='codex'
        ? `Codex ${c.protocolVersion} 协议可用；${c.authenticated ? '已检测到登录账户' : '未检测到登录账户，请先在本机 codex login'}。${c.proxySource === 'windows-system' ? '模型连接跟随 Windows 手动系统代理。' : ''}${c.commandSandbox?.lastSetupError ? '最近的 Windows 沙箱初始化错误：' + c.commandSandbox.lastSetupError.code + '。' : ''}费用未知，无逐请求硬费用上限。`
        : `${c.backend}${c.version ? ' ' + c.version : ''} ${c.protocol||'agent protocol'} 握手成功；${c.resume?'可恢复会话。':'不支持恢复会话。'}检测不会保存配置，认证由本机 Agent 管理。`);
    } catch (error) { if (useProjectStore.getState().root === root) setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const control = async (method: string) => {
    if (busy || streaming || !window.codenode) return;
    setBusy(true); setMessage('');
    try {
      const next = { ...settings, args: JSON.parse(argsText), acp: JSON.parse(acpText) };
      const result = await window.codenode.backendControl(root, next, method, method === 'authenticate' ? { methodId: next.acp.authMethodId } : {});
      if (useProjectStore.getState().root !== root) return;
      if (!result.ok) setMessage(result.error || 'ACP 请求失败');
      else if (method === 'inspect') { setAgentInfo(result.value); setMessage('已读取 Agent 提供的模式、模型、配置项和认证方式。'); }
      else setMessage('ACP 认证请求已完成。');
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  };
  const disabled = busy || streaming;
  return <div className="agent-execution-settings backend-settings-panel" data-testid="backend-settings">
    <h3>Agent 后端</h3>
    <label className="settings-row"><span>配置范围</span><select aria-label="后端配置范围" value={scope} disabled={disabled} onChange={e => setScope(e.target.value as 'machine' | 'project')}><option value="machine">本机默认</option><option value="project" disabled={!root}>当前项目覆盖</option></select></label>
    <label className="settings-row"><span>执行后端</span><select aria-label="执行后端" value={settings.backend} disabled={disabled} onChange={e => { const backend=e.target.value as AgentBackendSettings['backend']; setSettings(s=>({...s,backend,executable:backendCommands[backend]||'',args:backendArgs[backend]||[]})); setArgsText(JSON.stringify(backendArgs[backend]||[],null,2)); }}>{backendConfig.backends.map(backend => <option value={backend} key={backend}>{backendConfig.labels[backend as keyof typeof backendConfig.labels]}</option>)}</select></label>
    {settings.backend !== 'builtin' && <>
      <label className="settings-row"><span>启动命令或可执行文件</span><input aria-label="后端启动命令" value={settings.executable} disabled={disabled} onChange={e => setSettings(s => ({ ...s, executable: e.target.value }))} /></label>
      {settings.backend !== 'codex' && <label className="settings-row"><span>启动参数（JSON 数组）</span><textarea aria-label="后端启动参数" value={argsText} disabled={disabled} rows={3} onChange={e => setArgsText(e.target.value)} /></label>}
      {['codex', 'deepseek-harness'].includes(settings.backend) && <>
        <label className="settings-row"><span>{settings.backend === 'deepseek-harness' ? 'Harness profile home' : 'Codex 模型（留空跟随 Codex）'}</span><input aria-label={settings.backend === 'deepseek-harness' ? 'Harness home' : 'Codex 模型'} value={settings.backend === 'deepseek-harness' ? settings.home : settings.model} disabled={disabled} onChange={e => setSettings(s => settings.backend === 'deepseek-harness' ? ({ ...s, home: e.target.value }) : ({ ...s, model: e.target.value }))} /></label>
        {settings.backend === 'deepseek-harness' && <><label className="settings-row"><span>Provider</span><input aria-label="Harness provider" value={settings.provider} disabled={disabled} onChange={e => setSettings(s => ({ ...s, provider: e.target.value }))} /></label><label className="settings-row"><span>Model</span><input aria-label="Harness model" value={settings.model} disabled={disabled} onChange={e => setSettings(s => ({ ...s, model: e.target.value }))} /></label></>}
      </>}
      {['codex', 'hermes', 'opencode', 'openclaw'].includes(settings.backend) && <label className="settings-row"><span>{settings.backend === 'codex' ? '项目文件权限（Codex 沙箱）' : 'ACP 权限请求策略'}</span><select aria-label={settings.backend === 'codex' ? 'Codex 项目文件权限' : 'ACP 权限请求策略'} value={settings.sandbox} disabled={disabled} onChange={e => setSettings(s => ({ ...s, sandbox: e.target.value as AgentBackendSettings['sandbox'] }))}><option value="read-only">只读／拒绝扩权请求</option><option value="workspace-write">允许项目修改／逐次审批</option></select></label>}
      {isAcp && <>
        <label className="settings-row"><span>ACP 模型（留空跟随 Agent）</span><input aria-label="ACP 模型" value={settings.model} disabled={disabled} onChange={e => setSettings(s => ({ ...s, model: e.target.value }))} /></label>
        <label className="settings-row"><span>ACP 会话配置（JSON）</span><textarea aria-label="ACP 会话配置" rows={6} value={acpText} disabled={disabled} onChange={e => setAcpText(e.target.value)} /></label>
        <div className="settings-row"><button disabled={disabled} onClick={() => { try { const value = JSON.parse(acpText); setAcpText(JSON.stringify({ ...value, codeNodeTools: value.codeNodeTools !== true }, null, 2)); } catch { setMessage('请先修正 ACP 配置 JSON'); } }}>切换 CodeNode 工具接入</button></div>
        <p className="settings-scope">authMethodId：认证方式；modeId：模式；configValues：Agent 配置项与值；mcpServers：额外工具服务器；codeNodeTools：是否接入 CodeNode 工具。配置会随本机或项目设置保存，下一轮执行前校验 Agent 能力。需要交互终端的登录方式请在 Agent 自身终端完成。</p>
        <div className="settings-row"><button disabled={disabled} onClick={() => void control('inspect')}>读取 ACP 可选项</button><button disabled={disabled} onClick={() => void control('authenticate')}>执行 ACP 认证</button></div>
        {agentInfo && <details><summary>Agent 提供的可选项</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ authMethods: agentInfo.authMethods, modes: agentInfo.modes, models: agentInfo.models, configOptions: agentInfo.configOptions }, null, 2)}</pre></details>}
      </>}
      <p className="settings-scope">{settings.backend === 'codex' ? `Codex 支持协议 ${backendConfig.supportedProtocolVersions.join(' / ')}。` : settings.backend === 'hermes' || settings.backend === 'opencode' || settings.backend === 'openclaw' ? '通过 ACP stdio 接入本机 CLI 和它自己的登录配置；OpenClaw 需 Gateway 可用。只读策略拒绝 ACP 权限请求，写入策略逐次询问；ACP 声明不能替代操作系统沙箱。' : 'DeepSeek Harness SDK 使用独立 DSH_HOME、sdk profile 与 provider/model；需要安装 dsh SDK runtime。执行权限由该 Harness profile 管理，SDK 不提供逐会话取消接口，停止会结束专属 runtime 进程。'} {settings.backend === 'deepseek-harness' ? 'CodeNode 不会把通用项目权限选项伪装成 Harness 沙箱。' : '外部 Agent 的原生工具由对应 runtime 管理；CodeNode 会核对运行前后的项目文件差异。'} 费用与外部 token 用量不一定可得，CodeNode 硬费用预算不覆盖外部执行。画布提供上下文，不接管 Agent 的原生会话工具。</p>
    </>}
    <div className="settings-row"><button onClick={() => void save()} disabled={disabled || scope === 'project' && !root}>保存后端</button><button onClick={() => void check()} disabled={disabled}>检测当前配置</button>{root && <button onClick={() => void save(true)} disabled={disabled}>项目跟随本机默认</button>}</div>
    {message && <p className="settings-scope" role="status">{message}</p>}
  </div>;
}
