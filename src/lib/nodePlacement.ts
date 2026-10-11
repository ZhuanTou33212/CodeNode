/**
 * 节点放置与取景 —— 工具栏「✦ 画布节点」按钮与 Shift+A 添加菜单共用这一条路径。
 *
 * 背景：画布节点默认 1040×640，比多数视口还大。添加菜单的通用逻辑是「在光标位置创建」，
 * 光标常常落在对话栏 / 工具栏 / 视口边缘上，`screenToFlowPosition` 照样会把坐标映射出去，
 * 结果就是「节点建好了，但大半落在可视区外，看着像没反应」。
 * 工具栏按钮原本自带一套补丁：位置固定在可视区中心 + 建好后收一档 zoom
 * 保证整块可见。这里把那套逻辑抽出来，两个入口不再各写一遍。
 */
import type { ReactFlowInstance } from '@xyflow/react';
import { NODE_TEMPLATES } from '../nodes';
import { useGraphStore } from '../store/graphStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import type { VectorData } from '../types';

/** 只依赖 ReactFlow 的三个视口方法，避免把整个实例类型带进调用点 */
export type ViewportApi = Pick<ReactFlowInstance, 'screenToFlowPosition' | 'getViewport' | 'setViewport'>;

/** 画布节点默认尺寸（模板未声明时兜底） */
const DEFAULT_CANVAS_SIZE = { width: 1040, height: 640 };

/** 放置后自动取景的 zoom 上限：节点太大，超过这个倍率就收一档 */
const REVEAL_MAX_ZOOM = 0.55;

/** 画布可视区（.canvas-wrap = ReactFlow 容器）的屏幕矩形；未挂载时退化为整窗 */
export function canvasScreenRect(): DOMRect {
  const host = document.querySelector('.canvas-wrap');
  if (host) return host.getBoundingClientRect();
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } as DOMRect;
}

/** 节点 id：类型 + 时间戳 + 随机尾数，避免同一次点击内重号 */
export function newNodeId(type: string): string {
  return `${type}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

/**
 * 把节点放到可视区中心，返回 flow 坐标。
 * 注意 width/height 本身就是 flow 单位（ReactFlow 节点的尺寸不随 zoom 缩放），
 * 所以这里只做「中心点 − 半个节点」，不能再除以 zoom —— 除以 zoom 会让节点在任何
 * 非 100% 倍率下都偏离可视区中心（旧实现就是这么写的：zoom=0.65 时偏 150px 以上）。
 */
export function centeredFlowPosition(api: ViewportApi, width: number, height: number, rect: DOMRect): { x: number; y: number } {
  const center = api.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  return { x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2) };
}

/** 大节点建好后取景：以节点中心为锚点收一档 zoom，保证整块可见 */
export function revealPlacedNode(api: ViewportApi, width: number, height: number, rect: DOMRect, options: { maxZoom?: number; duration?: number } = {}): void {
  const viewportZoom = api.getViewport().zoom;
  const zoom = viewportZoom > 0 ? viewportZoom : 1;
  const targetZoom = Math.min(zoom, options.maxZoom ?? REVEAL_MAX_ZOOM);
  const center = api.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  api.setViewport({ x: rect.width / 2 - center.x * targetZoom, y: rect.height / 2 - center.y * targetZoom, zoom: targetZoom }, { duration: options.duration ?? 240 });
}

/**
 * 新增一个画布节点：可视区中心放置 → 选中（addNode 自带）→ 提示 → 自动取景。
 * 工具栏按钮与「Shift+A → 画布节点」共用；返回新节点 id。
 */
export function placeCanvasNode(api: ViewportApi, options: { rect?: DOMRect; focusDelay?: number } = {}): string {
  if (!useSessionStore.getState().current()) useSessionStore.getState().newCanvas();
  const template = NODE_TEMPLATES.vector;
  const data = template.data as VectorData;
  const width = data.width ?? DEFAULT_CANVAS_SIZE.width;
  const height = data.height ?? DEFAULT_CANVAS_SIZE.height;
  const rect = options.rect ?? canvasScreenRect();
  const id = newNodeId('vector');

  useGraphStore.getState().addNode({ id, type: 'vector', position: centeredFlowPosition(api, width, height, rect), data: { ...data } });
  useUiStore.getState().setToast('已添加画布节点');

  // 新增节点后 ReactFlow 才测得出尺寸，取景放到下一帧之后
  const focus = () => revealPlacedNode(api, width, height, rect);
  const delay = options.focusDelay ?? 90;
  if (delay > 0) window.setTimeout(focus, delay);
  else focus();
  return id;
}
