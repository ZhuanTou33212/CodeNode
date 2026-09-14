import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import { useUsageStore } from '../store/usageStore';
import { fileToAttachment } from '../lib/imageAttach';
import type { ImageData } from '../types';

const DEFAULT_W = 320;
const DEFAULT_H = 224;

/**
 * 图像节点：画布上的一块图片。图片来源两种：
 *   1) 项目内图片文件（imagePath，相对工程根目录）→ 「读出」按钮解析为可显示数据
 *   2) 直接粘贴 / 拖入 / 选择的图片（dataUrl 存进节点 data）
 * 点击图片可在新窗口放大查看。
 */
function ImageNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as ImageData;
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const setToast = useUiStore((s) => s.setToast);
  const projectRoot = useProjectStore((s) => s.root);
  const visionModel = useUsageStore((s) => {
    const m = s.models.find((x) => x.id === s.modelId) || s.models[0];
    return m?.vision === true;
  });

  const [src, setSrc] = useState<string>(d.dataUrl || '');
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** 记录当前 dataUrl 是从哪个路径读出来的，用于判断"换了路径需要重新读" */
  const loadedPathRef = useRef<string | undefined>(undefined);

  const accent = d.accent || '#14b8a6';
  const width = d.width || DEFAULT_W;
  const height = d.height || DEFAULT_H;
  const fileName = useMemo(() => {
    if (d.imagePath) return d.imagePath.split('/').pop() || d.imagePath;
    return d.label || '图像';
  }, [d.imagePath, d.label]);

  const readFromProject = useCallback(
    async (relPath?: string, silent = false) => {
      const target = relPath || d.imagePath;
      if (!target) {
        if (!silent) setToast('请先选择项目里的图片路径');
        return;
      }
      const root = projectRoot;
      if (!root || !window.codenode) {
        if (!silent) setToast('请先打开工程');
        return;
      }
      setLoading(true);
      try {
        const res = await window.codenode.readProjectFile(root, target, { binary: true });
        if (res.ok && res.dataUrl) {
          loadedPathRef.current = target;
          updateNodeData(id, { dataUrl: res.dataUrl });
          setSrc(res.dataUrl);
          if (!silent) setToast(`已读取图片：${target}（${Math.round((res.bytes || 0) / 1024)}KB）`);
        } else if (!silent) {
          setToast('读取图片失败：' + (res.error || '未知错误'));
        }
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d.imagePath, id, projectRoot],
  );

  /**
   * 解析"当前该显示什么"：
   *  - 有 imagePath 且（还没数据 / 数据不是这个路径读出来的）→ 读项目文件
   *  - 否则用 dataUrl（粘贴/拖入的图片）
   */
  useEffect(() => {
    const path = d.imagePath;
    if (!path) {
      loadedPathRef.current = undefined;
      setSrc(d.dataUrl || '');
      return;
    }
    if (loadedPathRef.current === path) return;
    if (d.dataUrl && !loadedPathRef.current) {
      // 粘贴进来的图（没有路径来源），先按它显示
      setSrc(d.dataUrl);
      return;
    }
    void readFromProject(path, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.imagePath, d.dataUrl, projectRoot]);

  const acceptFiles = async (files: File[]) => {
    const img = files.find((f) => String(f.type || '').startsWith('image/'));
    if (!img) return;
    const r = await fileToAttachment(img);
    if (!r.ok) {
      setToast(r.error);
      return;
    }
    // 换成粘贴/拖入的图后清掉原项目路径，避免又被路径解析覆盖
    loadedPathRef.current = undefined;
    updateNodeData(id, { dataUrl: r.attachment.dataUrl, imagePath: undefined });
    setSrc(r.attachment.dataUrl);
    setToast('已放入图片：' + (img.name || '剪贴板图片'));
  };

  return (
    <div
      className={`wf-node wf-image-node ${selected ? 'is-selected' : ''}${dragOver ? ' is-dragover' : ''}`}
      style={{ borderColor: `${accent}b8`, '--wf-accent': accent, width } as CSSProperties}
      onDragOver={(e) => {
        const has = Array.from(e.dataTransfer?.items || []).some(
          (it) => it.kind === 'file' && String(it.type).startsWith('image/'),
        );
        if (!has) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer?.files || []).filter((f) => String(f.type).startsWith('image/'));
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        void acceptFiles(files);
      }}
    >
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-title">
        <span className="wf-image-mark">图</span>
        <span className="wf-node-label" title={d.imagePath || fileName}>
          {fileName}
        </span>
        {visionModel ? (
          <span className="wf-vision-badge" title="当前模型支持看图，可直接在对话里引用这张图">
            视觉
          </span>
        ) : null}
        {d.memberBadge ? <span className="wf-member-badge" title="所属范围">{d.memberBadge}</span> : null}
      </div>

      <div
        className="wf-image-body nodrag"
        style={{ height: Math.max(80, height - 76) }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files || []).filter((f) => String(f.type).startsWith('image/'));
          if (!files.length) return;
          e.preventDefault();
          e.stopPropagation();
          void acceptFiles(files);
        }}
        title={src ? '点击放大查看 · 可直接拖入/粘贴图片替换' : '把图片拖进来，或按 Ctrl+V 粘贴，或在检查器里填项目路径'}
      >
        {src ? (
          <img src={src} alt={fileName} draggable={false} onClick={() => window.open(src, '_blank')} />
        ) : (
          <div className="wf-image-empty">
            <span className="wf-image-empty-icon">🖼</span>
            <span>{loading ? '读取中…' : '拖入图片 / Ctrl+V 粘贴 / 检查器填路径'}</span>
          </div>
        )}
      </div>

      <div className="wf-node-footer">
        <span className="wf-status-text">{d.status || 'pending'}</span>
        {d.imagePath ? (
          <span className="wf-image-src" title={d.imagePath}>
            {d.imagePath}
          </span>
        ) : null}
        {d.imagePath ? (
          <button
            className="wf-image-read"
            title="从工程目录重新读取该图片"
            onClick={(e) => {
              e.stopPropagation();
              void readFromProject();
            }}
          >
            读出
          </button>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

export default memo(ImageNode);
