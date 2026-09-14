import type { AgentAttachment } from '../types';

/** 与 electron/attachments.cjs 保持一致的限制 */
export const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_IMAGES_PER_MESSAGE = 6;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 压缩目标：最长边 1280px（视觉识别足够，且能显著减小 base64 体积） */
const TARGET_MAX_EDGE = 1280;
const JPEG_QUALITY = 0.85;

export function dataUrlBytes(dataUrl: string): number {
  const m = /^data:[^;]+;base64,(.*)$/.exec(dataUrl);
  if (!m) return 0;
  const b64 = m[1];
  const pad = /=+$/.exec(b64)?.[0].length ?? 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

/** 把 File 读成 data URL */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('读取图片失败'));
    fr.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

/**
 * 把任意图片 File 规范化为可发送的附件：
 *  - 校验类型
 *  - 超过目标尺寸则等比缩放（单张上限 4MB，并尽量压到 1MB 以内）
 *  - 返回 data URL 附件
 */
export async function fileToAttachment(file: File): Promise<{ ok: true; attachment: AgentAttachment } | { ok: false; error: string }> {
  const mime = String(file.type || '').toLowerCase();
  if (!ALLOWED_IMAGE_MIME.includes(mime)) {
    return { ok: false, error: `不支持的图片格式：${mime || file.name || '未知'}（支持 png/jpeg/webp/gif）` };
  }
  try {
    const original = await readAsDataUrl(file);
    // GIF 可能带动画，缩放会丢动画，保持原样（仅做体积校验）
    if (mime === 'image/gif') {
      const bytes = dataUrlBytes(original);
      if (bytes > MAX_IMAGE_BYTES) return { ok: false, error: `GIF 过大（${fmtBytes(bytes)}，上限 4MB）` };
      return { ok: true, attachment: { mime, dataUrl: original, name: file.name, bytes } };
    }

    const img = await loadImage(original);
    const longest = Math.max(img.width, img.height) || 1;
    const scale = longest > TARGET_MAX_EDGE ? TARGET_MAX_EDGE / longest : 1;

    let quality = JPEG_QUALITY;
    let dataUrl = original;
    if (scale < 1 || dataUrlBytes(original) > 1024 * 1024) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return { ok: false, error: '当前环境不支持图片压缩' };
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      // 统一转 JPEG（PNG 截图体积大；透明背景会变黑，故选白色底）
      ctx.fillStyle = '#ffffff';
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL('image/jpeg', quality);
      // 仍偏大则降质重编码
      let guard = 0;
      while (dataUrlBytes(dataUrl) > 1024 * 1024 && quality > 0.45 && guard < 4) {
        quality -= 0.15;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
        guard += 1;
      }
    }

    const bytes = dataUrlBytes(dataUrl);
    if (bytes > MAX_IMAGE_BYTES) {
      return { ok: false, error: `图片压缩后仍过大（${fmtBytes(bytes)}，上限 4MB）` };
    }
    const outMime = /^data:([^;]+);/.exec(dataUrl)?.[1] || mime;
    return { ok: true, attachment: { mime: outMime, dataUrl, name: file.name, bytes } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '图片处理失败' };
  }
}

/** 从粘贴/拖拽事件里挑出图片文件 */
export function imagesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files && dt.files.length) {
    for (const f of Array.from(dt.files)) {
      if (String(f.type || '').toLowerCase().startsWith('image/')) out.push(f);
    }
  }
  if (!out.length && dt.items) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === 'file' && String(it.type || '').toLowerCase().startsWith('image/')) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}
