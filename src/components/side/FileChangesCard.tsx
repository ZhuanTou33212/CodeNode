import { useState } from 'react';
import type { SessionMsg } from '../../types';
import { summarizeFileChanges } from '../../lib/fileChanges';
import { useProjectStore } from '../../store/projectStore';
import { useUiStore } from '../../store/uiStore';
import CodeVerificationCard from './CodeVerificationCard';

export default function FileChangesCard({ message }: { message: SessionMsg }) {
  const [expanded, setExpanded] = useState(false);
  const openFile = useProjectStore(state => state.openFile);
  const files = summarizeFileChanges(message.tools || [], [...(message.editedFiles || []), ...(message.codeVerification?.files || [])]);
  if (!files.length) return null;
  const open = async (path: string) => { await openFile(path); if (useProjectStore.getState().selected?.relPath === path) useUiStore.getState().openDock('editor'); };
  return <section className="file-changes-card" aria-label="文件变更">
    <button className="file-changes-summary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>
      <strong>已编辑 {files.length} 个文件</strong><span>查看变更 {expanded ? '▾' : '▸'}</span>
    </button>
    {message.codeVerification && <CodeVerificationCard report={message.codeVerification} compact />}
    {expanded && <div className="file-changes-list">{files.map(file => <div className="file-changes-item" key={file.path}>
      <div className="file-changes-path"><button onClick={() => void open(file.path)} title="打开文件">{file.path}</button>
        {file.reviews.length === 1 && <small>+{file.reviews[0].added ?? '?'} −{file.reviews[0].removed ?? '?'}</small>}
      </div>
      {file.reviews.length ? file.reviews.map((review, index) => <details key={index}><summary>{file.reviews.length > 1 ? `第 ${index + 1} 次修改` : '查看差异'}{review.truncated ? ' · 已截断' : ''}</summary><pre>{review.diff.split('\n').map((line, number) => <span className={line.startsWith('+') ? 'is-add' : line.startsWith('-') ? 'is-remove' : ''} key={number}>{line}{'\n'}</span>)}</pre></details>) : <small>未记录差异，可打开文件查看。</small>}
    </div>)}</div>}
  </section>;
}
