/** 矢量设计工作室 —— 数据模型（与 Agent 工作台完全隔离，自成一套） */

export type VecMode = 'design' | 'logic';

export type VecTool = 'select' | 'hand' | 'pen' | 'rectangle' | 'rounded' | 'ellipse' | 'arrow' | 'text';

export type VecShapeKind = 'bezier' | 'rectangle' | 'rounded' | 'ellipse' | 'arrow' | 'text';

export type VecStrokeStyle = 'solid' | 'dashed' | 'dotted';

export type VecHAlign = 'left' | 'center' | 'right';

export type VecArrowStyle = 'filled' | 'open' | 'barbed';

export type LogicOp = 'union' | 'intersection' | 'difference' | 'xor' | 'complement';

/** 贝塞尔锚点：坐标位于对象本地坐标系（未旋转），控制柄为锚点旁的手柄点（绝对坐标） */
export type Anchor = {
  x: number;
  y: number;
  /** 入柄：曲线进入该锚点时使用的控制点（本地绝对坐标），缺省时退化为直线段 */
  hIn?: { x: number; y: number };
  /** 出柄：曲线离开该锚点时的控制点（本地绝对坐标） */
  hOut?: { x: number; y: number };
  /** 平滑锚点：拖动一侧手柄时另一侧自动镜像；关闭后两侧独立（角点） */
  smooth?: boolean;
};

export type VecObject = {
  id: string;
  type: VecShapeKind;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // 度
  /** '#rrggbb' 或 'none'（透明填充） */
  fill: string;
  stroke: string; // 'none' 表示无描边
  strokeWidth: number;
  strokeStyle: VecStrokeStyle;
  /** 0-100 */
  opacity: number;
  /** 圆角半径（矩形/圆角矩形） */
  radius: number;
  shadow: boolean;
  /** 文字（矩形/圆角/椭圆/贝塞尔为居中标签；文本对象为正文） */
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  textColor: string;
  textAlign: VecHAlign;
  lineHeight: number;
  arrowStyle: VecArrowStyle;
  anchors?: Anchor[];
  closed: boolean;
  visible: boolean;
  locked: boolean;
  groupId: string | null;
};

export type VecGroup = {
  id: string;
  name: string;
  memberIds: string[];
  collapsed?: boolean;
  visible: boolean;
  locked: boolean;
};

export type Snapshot = {
  objects: VecObject[];
  groups: VecGroup[];
  selectedIds: string[];
};

/** 钢笔草稿点：h = 从该点拉出的出柄（世界坐标） */
export type DraftPoint = { x: number; y: number; h?: { x: number; y: number } };

export type ProjectFile = {
  kind: 'codenode-vector-project';
  version: 2;
  objects: VecObject[];
  groups: VecGroup[];
  zoom: number;
  pan: { x: number; y: number };
  mode: VecMode;
  dark: boolean;
  gridOn: boolean;
  guidesOn: boolean;
  snapOn: boolean;
  guides: { v: number[]; h: number[] };
  savedAt: number;
};

export type LogicRelationKind = '分离' | '相交' | '包含' | '被包含';

export type RegionStat = {
  /** 位掩码标记（如 A=1, B=2, C=4 …） */
  mask: number;
  label: string;
  area: number;
};

export type LogicAnalysis = {
  ready: boolean;
  sets: { id: string; name: string; color: string; area: number }[];
  relations: { a: string; b: string; kind: LogicRelationKind }[];
  stats: RegionStat[];
  /** 结果区域掩码图（与纸张同尺寸比例，0.5 分辨率），null 表示不可见（如空集） */
  resultUrl: string | null;
  resultArea: number;
  expression: string;
};

/** 纸张尺寸（世界坐标单位 = 未缩放时的 CSS px） */
export const PAPER_W = 1100;
export const PAPER_H = 680;
/** 纸张在画布视口坐标系中的固定偏移 */
export const PAPER_ORIGIN = { x: 96, y: 64 };
export const VIEW_W = 1360;
export const VIEW_H = 820;

export const GRID_STEP = 20;

export const LOGIC_OP_META: { op: LogicOp; symbol: string; label: string; desc: string }[] = [
  { op: 'union', symbol: '∪', label: '并集', desc: '属于任一集合的全部区域' },
  { op: 'intersection', symbol: '∩', label: '交集', desc: '所有参与集合的共同区域' },
  { op: 'difference', symbol: '−', label: '差集', desc: '集合 A 减去其余集合' },
  { op: 'xor', symbol: '⊕', label: '异或', desc: '属于奇数个集合的区域（A⊕B）' },
  { op: 'complement', symbol: 'ᶜ', label: '补集', desc: '纸张全集中 A 以外的区域' },
];

export const LOGIC_HIGHLIGHT = '#ffd34d';
