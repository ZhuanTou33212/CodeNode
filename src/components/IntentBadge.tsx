import { useSessionStore } from '../store/sessionStore';

/**
 * IntentBadge —— 意图识别标（照 Codex guardian 分类器的轮级判定）
 *
 * 为什么要有它：`electron/intent.cjs` 每轮给出的判定此前**只存在于 run 事件与审计里** ——
 * 用户看不到「这一轮被当成什么任务、风险多大、授权到哪」，也看不到「为什么刚才那个操作
 * 明明有免打扰规则却还是要我确认」。数据早就有了（`kind:'intent'` 增量），缺的就是消费端。
 *
 * 设计取舍（与 PlanCard 一致，避免抢视觉重量）：
 *   - **一行**紧凑标，不是卡片：它每轮都会变，做成卡片会让对话区反复跳动；
 *   - 只有**有信号**的判定才显示（`unavailable` = 没跑/超时/关闭 → 返回 null，不留空壳）；
 *   - 亮度分层：标签弱 → 判定值强 → 置信度最弱；风险/授权用语义色，不额外引 accent；
 *   - 判据摘要（`reason`）不铺在界面上，只进 tooltip —— 用户想追责时能看到「凭什么这么判」。
 */

const INTENT_LABELS: Record<string, string> = {
  chat: '闲聊',
  code: '代码改动',
  canvas: '画布建模',
  research: '调研检索',
  ops: '运维操作',
  unknown: '未判定',
};

const RISK_LABELS: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '严重风险',
  unknown: '风险未定',
};

const AUTH_LABELS: Record<string, string> = {
  unknown: '授权不明',
  low: '授权较弱',
  medium: '授权一般',
  high: '已获授权',
};

/** 判定来源说明（tooltip 用）：让「模型判的」与「截断后自救的」在界面上可区分 */
const SOURCE_NOTES: Record<string, string> = {
  model: '模型完整判定',
  partial: '模型输出被截断，已按字段自救',
  invalid: '模型输出不可用，按保守口径处理',
};

export function IntentBadge() {
  const verdict = useSessionStore((s) => s.intentVerdict);
  // 没有信号就不显示（不留空壳、也不假装有结论）
  if (!verdict || verdict.source === 'unavailable') return null;

  const intentLabel = INTENT_LABELS[verdict.intent] || verdict.intent;
  const riskLabel = RISK_LABELS[verdict.risk] || verdict.risk;
  const authLabel = AUTH_LABELS[verdict.authorization] || verdict.authorization;
  const confidence = Math.round((Number(verdict.confidence) || 0) * 100);
  const title = [
    '意图识别：' + intentLabel,
    riskLabel + '／' + authLabel + '（置信度 ' + confidence + '%）',
    SOURCE_NOTES[verdict.source] || verdict.source,
    verdict.reason ? '判据：' + verdict.reason : '',
    verdict.tighten ? '本轮已收紧：命中免打扰规则的审批也会再问一次' : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      className={'ap-intent r-' + verdict.risk + (verdict.tighten ? ' is-tighten' : '')}
      aria-label="意图识别"
      title={title}
    >
      <span className="ap-intent-title">意图</span>
      <span className="ap-intent-value">{intentLabel}</span>
      <span className={'ap-intent-chip r-' + verdict.risk}>{riskLabel}</span>
      <span className={'ap-intent-chip a-' + verdict.authorization}>{authLabel}</span>
      {verdict.source === 'partial' ? (
        <span className="ap-intent-chip is-partial" title="模型输出被截断，只有完整出现的字段被采用">
          输出不完整
        </span>
      ) : null}
      {verdict.tighten ? (
        <span className="ap-intent-tighten" title="高风险／授权不明／低置信 → 本轮免打扰规则不生效">
          审批收紧
        </span>
      ) : null}
      <span className="ap-intent-conf" title="模型对本次判定的把握">
        {confidence}%
      </span>
    </div>
  );
}
