import { useRef } from 'react';
import { useProjectStore } from '../store/projectStore';
import { EditorPanel } from './WorkbenchDock';
import ProjectPanel from './side/ProjectPanel';
import PreviewPanel from './side/PreviewPanel';
export default function FileWorkspace() {
  const selected = useProjectStore(state => state.selected);
  const editable = selected && !selected.relPath.toLowerCase().endsWith('.cnode');
  const host = useRef<HTMLDivElement>(null);
  const focusFiles = () => host.current?.querySelector<HTMLInputElement>('.pm-search input')?.focus();
  return <section ref={host} className="files-workspace" aria-label="项目文件"><div className="files-layout">
    <div className="files-explorer"><header><strong>文件</strong></header><ProjectPanel embedded onOpen={() => {}} /></div>
    <div className="files-document">{editable ? <EditorPanel /> : <PreviewPanel embedded onBack={focusFiles} />}</div>
  </div></section>;
}
