import { useRef } from 'react';
import ProjectPanel from './side/ProjectPanel';
import PreviewPanel from './side/PreviewPanel';
export default function FileWorkspace() {
  const host = useRef<HTMLDivElement>(null);
  const focusFiles = () => host.current?.querySelector<HTMLInputElement>('.pm-search input')?.focus();
  return <section ref={host} className="files-workspace" aria-label="项目文件"><div className="files-layout">
    <div className="files-explorer"><header><strong>文件</strong></header><ProjectPanel embedded onOpen={() => {}} /></div>
    <div className="files-document"><PreviewPanel embedded onBack={focusFiles} /></div>
  </div></section>;
}
