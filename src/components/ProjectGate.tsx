import { useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { newProject, openProject, openProjectFile } from '../lib/projectActions';

/**
 * 启动门禁页（参考 svgVideoMaker 的 ProjectGate）。
 *
 * 没有打开任何工程时只显示这一页：必须先「打开工程」或「新建工程」
 * 才能进入工作台，避免在没有工程根目录的情况下直接进画布/Agent。
 */
export default function ProjectGate() {
  const error = useProjectStore((s) => s.error);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const hasApi = typeof window !== 'undefined' && Boolean(window.codenode);

  const run = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    if (!hasApi) {
      setStatus('未检测到 Electron 环境');
      return;
    }
    setBusy(true);
    setStatus(label + '…');
    try {
      await action();
      // 成功时 root 会被设置，App 会立刻切到工作台；能走到这里说明是取消或失败
      if (!useProjectStore.getState().root) setStatus(label + '已取消');
      else setStatus('');
    } catch (e) {
      setStatus(label + '失败：' + String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-logo">CN</div>
        <h1>CodeNode</h1>
        <p className="gate-sub">
          节点画布 + 内嵌 Agent 的桌面工作台：把项目解析成节点图，用连线编排流程，并让 Agent 按图执行。
        </p>

        <div className="gate-actions">
          <button
            type="button"
            className="gate-btn primary"
            disabled={busy || !hasApi}
            onClick={() => void run('打开工程', openProject)}
          >
            <span className="gate-btn-title">打开工程</span>
            <span className="gate-btn-desc">选择一个已有的工程目录</span>
          </button>
          <button
            type="button"
            className="gate-btn"
            disabled={busy || !hasApi}
            onClick={() => void run('新建工程', newProject)}
          >
            <span className="gate-btn-title">新建工程</span>
            <span className="gate-btn-desc">创建一个新的 .cnode 工程</span>
          </button>
          <button
            type="button"
            className="gate-btn"
            disabled={busy || !hasApi}
            onClick={() => void run('打开工程文件', openProjectFile)}
          >
            <span className="gate-btn-title">打开工程文件</span>
            <span className="gate-btn-desc">直接指定一个 .cnode 文件</span>
          </button>
        </div>

        <div className="gate-hint">
          必须打开或新建工程才能进入工作台；画布、会话与检查点都保存在该工程目录的 <code>.cnode</code> 文件中。
        </div>

        {status ? <div className="gate-status">{status}</div> : null}
        {error ? <div className="gate-status err">{error}</div> : null}
        {!hasApi ? (
          <div className="gate-status err">
            未检测到 Electron 环境，请通过桌面快捷方式或 <code>npm run dev</code> 启动。
          </div>
        ) : null}
      </div>
    </div>
  );
}
