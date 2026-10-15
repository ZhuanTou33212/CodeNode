import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { newProject, openProject, openProjectFile, openRecentProject } from '../lib/projectActions';
import {
  clearRecentProjects,
  forgetRecentProject,
  readRecentProjects,
  relativeTime,
  type RecentProject,
} from '../lib/recentProjects';

/**
 * 启动门禁页。
 *
 * 没有打开任何工程时只显示这一页：必须先「打开工程」「新建工程」或「从最近列表进入」，
 * 才能进工作台，避免在没有工程根目录的情况下直接进画布/Agent。
 *
 * 布局：主操作居中，两个次操作等宽排列；有历史记录时在下方显示最近项目。
 */
export default function ProjectGate() {
  const error = useProjectStore((s) => s.error);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [activePath, setActivePath] = useState('');
  const hasApi = typeof window !== 'undefined' && Boolean(window.codenode);

  useEffect(() => {
    setRecent(readRecentProjects());
  }, []);

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      if (busy) return;
      if (!hasApi) {
        setStatus('未检测到 Electron 环境');
        return;
      }
      setBusy(true);
      setActivePath('');
      setStatus(label + '…');
      try {
        await action();
        // 成功时 root 会被设置，App 会立刻切到工作台；能走到这里说明是取消或失败
        if (!useProjectStore.getState().root) setStatus(useProjectStore.getState().error ? '' : label + '已取消');
        else setStatus('');
      } catch (e) {
        setStatus(label + '失败：' + String(e));
      } finally {
        setBusy(false);
        setRecent(readRecentProjects());
      }
    },
    [busy, hasApi],
  );

  const openRecent = async (entry: RecentProject) => {
    setActivePath(entry.file || entry.root);
    await run('打开最近工程', () => openRecentProject(entry));
  };

  return (
    <div className="gate">
      <div className={`gate-card${recent.length ? ' has-recent' : ''}`}>
        <div className="gate-main">
          <header className="gate-head">
            <div className="gate-logo" aria-hidden="true">CN</div>
            <div className="gate-head-text">
              <h1>CodeNode</h1>
              <p className="gate-sub">打开一个项目，开始与 Agent 协作。</p>
            </div>
          </header>

          <div className="gate-actions">
            <button
              type="button"
              className="gate-btn primary"
              disabled={busy || !hasApi}
              onClick={() => void run('打开工程', openProject)}
            >
              <span className="gate-btn-title">打开工程</span>
            </button>
            <button
              type="button"
              className="gate-btn"
              disabled={busy || !hasApi}
              onClick={() => void run('新建工程', newProject)}
            >
              <span className="gate-btn-title">新建工程</span>
            </button>
            <button
              type="button"
              className="gate-btn"
              disabled={busy || !hasApi}
              onClick={() => void run('打开工程文件', openProjectFile)}
            >
              <span className="gate-btn-title">打开工程文件</span>
            </button>
          </div>

          <div className="gate-hint">项目、会话与检查点保存在本机。</div>

          {status ? <div className="gate-status">{status}</div> : null}
          {error ? <div className="gate-status err">{error}</div> : null}
          {!hasApi ? (
            <div className="gate-status err">
              未检测到 Electron 环境，请通过桌面快捷方式或 <code>npm run dev</code> 启动。
            </div>
          ) : null}
        </div>

        {recent.length > 0 && <aside className="gate-recent">
          <div className="gate-recent-head">
            <span className="gate-recent-title">最近打开</span>
            <button
              className="gate-recent-clear"
              title="清空最近打开列表（不会删除工程文件）"
              disabled={busy}
              onClick={() => {
                clearRecentProjects();
                setRecent([]);
                setStatus('已清空最近打开列表');
              }}
            >
              清空
            </button>
          </div>

          <ul className="gate-recent-list">
            {recent.map((item) => {
              const key = item.file || item.root;
              const isActive = activePath === key;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={`gate-recent-item${isActive ? ' is-active' : ''}`}
                    disabled={busy}
                    title={item.file ? `${item.name}\n${item.file}` : `${item.name}\n${item.root}`}
                    onClick={() => void openRecent(item)}
                  >
                    <span className="gate-recent-name">{item.name}</span>
                    <span className="gate-recent-path">{item.file || item.root}</span>
                    <span className="gate-recent-meta">
                      {item.file ? '工程文件' : '工程目录'}
                      {item.openedAt ? ' · ' + relativeTime(item.openedAt) : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="gate-recent-del"
                    title="从最近列表移除"
                    disabled={busy}
                    onClick={() => {
                      setRecent(forgetRecentProject({ root: item.root, file: item.file }));
                    }}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>}
      </div>
    </div>
  );
}
