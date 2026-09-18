/**
 * merge.cjs —— **确定性合并**与**冲突裁决**（多 Agent 信息完整性 P5）
 *
 * 问题：多个子代理各自报告「我对世界做了什么」。这些报告**到达顺序不确定**（并行、重试、取消都可能
 * 打乱）。如果合并逻辑依赖到达顺序（典型写法：`for (r of results) apply(r)`），那么同一批工作在两次
 * 运行里会得到不同的结果 —— 这种不确定性在「谁覆盖谁」上尤其危险：**先到的和后到的写法不同，结果就不同**。
 *
 * 两条硬规则：
 *   1. **合并结果只依赖贡献项自身**（资源键 / 内容 / 完成时刻 / 来源），不依赖到达顺序 —— 所以先把
 *      贡献集规范排序再合并；同一个集再怎么打乱，结果**逐字节相同**（digest 相同）。
 *   2. **不猜**。内容不同的两个贡献，若**有可判定的先后**（完成时刻不同）→ 明确记为「后者覆盖前者」
 *      （两份都留痕，谁覆盖谁都记下来）；若**没有可判定的先后**（时间戳相同或缺失）→ 如实标成 `conflict`
 *      并列入 `requiresArbitration`，**绝不默认取胜者**（那等于用到达顺序决定事实）。裁决只能来自显式决定。
 *
 * 判定四档：
 *   `agreed`      所有贡献内容一致（幂等：重复贡献会被去掉，不影响结果）
 *   `superseded`  内容不同但有明确先后 → 后者生效，前者留痕（supersedes 里记谁覆盖谁）
 *   `conflict`    内容不同且无法判定先后 → 必须裁决（requiresArbitration = true）
 *   `arbitrated`  冲突已由**显式决定**消解（decisions），记录决定者与依据
 */
'use strict';

const crypto = require('crypto');

const MERGE_VERSION = 1;

/** 稳定的 JSON 字符串化：对象键按字典序，数组保持原序 —— digest 的字节稳定性全靠它 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function sha256OfText(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 贡献项的规范排序键：全部取自贡献项自身，与到达顺序无关 */
function sortKeyOf(contribution) {
  return [
    String(contribution.resourceKey || ''),
    String(contribution.finishedAt || ''),
    String(contribution.actor || ''),
    String(contribution.value === undefined ? '' : contribution.value),
    String(contribution.kind || ''),
  ];
}

function normalizeContribution(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    resourceKey: String(c.resourceKey || ''),
    kind: String(c.kind || 'unknown'),
    actor: String(c.actor || ''),
    role: String(c.role || ''),
    value: c.value === undefined ? null : String(c.value),
    startedAt: String(c.startedAt || ''),
    finishedAt: String(c.finishedAt || ''),
    source: String(c.source || ''),
  };
}

/**
 * 规范排序 + 去重（幂等）。**这是确定性的来源**：同一组贡献项无论以什么顺序进来，出去都是同一个序列。
 * @param {Array<any>} contributions
 * @returns {{contributions: Array<any>, duplicatesRemoved: number}}
 */
function canonicalize(contributions) {
  const list = (Array.isArray(contributions) ? contributions : []).map(normalizeContribution);
  list.sort((a, b) => {
    const ka = sortKeyOf(a);
    const kb = sortKeyOf(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
  const seen = new Set();
  const unique = [];
  let duplicatesRemoved = 0;
  for (const c of list) {
    const key = stableStringify([c.resourceKey, c.actor, c.startedAt, c.finishedAt, c.value, c.kind]);
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    unique.push(c);
  }
  return { contributions: unique, duplicatesRemoved };
}

/**
 * 从一份子代理信封抽出它「对世界声称了什么」。
 * 只读信封自身的字段（含 `at.startedAt/finishedAt`），**不看**任何到达时间 —— 否则确定性就没了。
 * @param {any} envelope
 * @returns {Array<any>}
 */
function contributionsFromEnvelope(envelope) {
  const list = [];
  if (!envelope || typeof envelope !== 'object') return list;
  const from = envelope.from || {};
  const at = envelope.at || {};
  const base = {
    actor: String(from.taskId || ''),
    role: String(from.role || ''),
    startedAt: String(at.startedAt || ''),
    finishedAt: String(at.finishedAt || ''),
    source: 'envelope:' + String(envelope.msgId || from.taskId || 'unknown'),
  };
  const files = (envelope.evidence && envelope.evidence.files) || [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || !f.path) continue;
    list.push({
      ...base,
      resourceKey: 'file:' + String(f.path),
      kind: 'file',
      // 声称「不存在」也是一个有效的贡献项（早期窗口里它还没被建出来）
      value: f.exists === false ? 'absent' : String(f.sha256 || 'unknown'),
    });
  }
  const snapshot = envelope.snapshot || {};
  if (snapshot.hash) {
    list.push({ ...base, resourceKey: 'resource:canvas', kind: 'snapshot', value: 'snapshot:' + String(snapshot.hash) });
  }
  return list;
}

function briefOf(c) {
  return { actor: c.actor, role: c.role, value: c.value, kind: c.kind, finishedAt: c.finishedAt || null };
}

/**
 * 合并一组贡献项。
 * @param {{contributions?: Array<any>, decisions?: Array<{resourceKey: string, winnerTaskId: string, decidedBy?: string, note?: string}>}} input
 * @returns {{v: number, digest: string, counts: any, resources: Array<any>, conflicts: Array<any>, rejectedDecisions: Array<any>, requiresArbitration: boolean}}
 */
function merge(input = {}) {
  const { contributions: canon, duplicatesRemoved } = canonicalize(input.contributions);
  const decisions = Array.isArray(input.decisions) ? input.decisions.filter(Boolean) : [];
  const decisionByKey = new Map();
  for (const d of decisions) {
    if (d && d.resourceKey) decisionByKey.set(String(d.resourceKey), d);
  }

  const byKey = new Map();
  for (const c of canon) {
    if (!byKey.has(c.resourceKey)) byKey.set(c.resourceKey, []);
    byKey.get(c.resourceKey).push(c);
  }

  const resources = [];
  const conflicts = [];
  const rejectedDecisions = [];

  for (const resourceKey of [...byKey.keys()].sort()) {
    const list = byKey.get(resourceKey);
    const values = [...new Set(list.map((c) => c.value))];
    /** @type {any} */
    const entry = {
      resourceKey,
      kind: list[0].kind,
      contributions: list.map(briefOf),
      value: values[0],
      winner: null,
      supersedes: null,
    };
    if (values.length === 1) {
      entry.status = 'agreed';
      entry.winner = list[list.length - 1].actor; // 内容一致时谁「赢」不重要，取规范序最后一个，稳定就好
    } else {
      const times = list.map((c) => c.finishedAt);
      // 「有明确先后」= 每个贡献项都有完成时刻，且互不相同。字面相同的时间戳无法判定先后 —— 那是冲突。
      const ordered = times.every((t) => !!t) && new Set(times).size === list.length;
      if (ordered) {
        const winner = list[list.length - 1];
        entry.status = 'superseded';
        entry.value = winner.value;
        entry.winner = winner.actor;
        entry.supersedes = list.slice(0, -1).map((c) => ({
          actor: c.actor,
          value: c.value,
          finishedAt: c.finishedAt,
          supersededBy: winner.actor,
        }));
      } else {
        const decision = decisionByKey.get(resourceKey);
        if (decision) {
          const chosen = list.find((c) => c.actor === String(decision.winnerTaskId || ''));
          if (chosen) {
            entry.status = 'arbitrated';
            entry.value = chosen.value;
            entry.winner = chosen.actor;
            entry.decidedBy = String(decision.decidedBy || 'supervisor');
            if (decision.note) entry.decisionNote = String(decision.note);
          } else {
            entry.status = 'conflict';
            rejectedDecisions.push({
              resourceKey,
              winnerTaskId: String(decision.winnerTaskId || ''),
              reason: '该 taskId 不是这个资源的候选来源（候选：' + list.map((c) => c.actor).join('/') + '）',
            });
          }
        } else {
          entry.status = 'conflict';
        }
        if (entry.status === 'conflict') entry.value = null;
      }
    }
    if (entry.status === 'conflict') {
      conflicts.push({
        resourceKey,
        kind: entry.kind,
        candidates: entry.contributions,
        reason: '两个来源对这个资源给出了不同内容，且没有可判定的先后（完成时刻相同或缺失）—— 不得默认取胜者，必须裁决',
      });
    }
    resources.push(entry);
  }

  // 裁决了「不存在的资源」同样无效：静默忽略等于悄悄吞掉一个决定
  for (const [key, d] of decisionByKey) {
    if (!byKey.has(key)) {
      rejectedDecisions.push({ resourceKey: key, winnerTaskId: String(d.winnerTaskId || ''), reason: '没有任何来源对这个资源做出贡献' });
    }
  }

  const counts = {
    resources: resources.length,
    agreed: resources.filter((r) => r.status === 'agreed').length,
    superseded: resources.filter((r) => r.status === 'superseded').length,
    arbitrated: resources.filter((r) => r.status === 'arbitrated').length,
    conflicts: conflicts.length,
    duplicatesRemoved,
    rejectedDecisions: rejectedDecisions.length,
  };
  /**
   * digest = **合并视图**的稳定指纹：只覆盖 `resources`（每一档判定与生效值都在里面）。
   * 刻意不把 `duplicatesRemoved` / `rejectedDecisions` 算进去 —— 它们是**输入侧**的元数据，
   * 不属于「我们对世界的共同认识」。否则同一份视图只因为多收了一次重复报告（或有人提了个无效裁决）
   * 就会得到不同的 digest，幂等性和「同一批消息 → 同一指纹」都不成立了。
   * 这两项仍然照常出现在 counts / 报告里，供审计。
   */
  const digest = sha256OfText(stableStringify({ v: MERGE_VERSION, resources }));
  return {
    v: MERGE_VERSION,
    digest,
    counts,
    resources,
    conflicts,
    rejectedDecisions,
    requiresArbitration: conflicts.length > 0,
  };
}

/**
 * 把合并报告渲染成给模型/人看的文本。**确定性**：只按 resourceKey 的规范顺序输出。
 */
function renderMergeReport(merged, options = {}) {
  const m = merged || { resources: [], counts: {}, conflicts: [] };
  // 默认 compact：只有在**需要动作**时（被覆盖/待裁决/裁决被拒）才逐条展开 ——
  // 全一致时只留一行摘要，别让一批干净的结果平白多几百 token
  const actionable = (m.counts.superseded || 0) + (m.counts.conflicts || 0) + (m.rejectedDecisions || []).length;
  const detail = options.compact === false || actionable > 0;
  const lines = [
    '[合并报告] v' + MERGE_VERSION + ' digest ' + String(m.digest || '').slice(0, 24) + '…' +
      '（资源 ' + (m.counts.resources || 0) + '：一致 ' + (m.counts.agreed || 0) +
      '｜被覆盖 ' + (m.counts.superseded || 0) + '｜已裁决 ' + (m.counts.arbitrated || 0) +
      '｜**待裁决 ' + (m.counts.conflicts || 0) + '**）',
  ];
  for (const r of detail ? m.resources || [] : []) {
    if (r.status === 'superseded') {
      lines.push(
        '- [被覆盖] ' + r.resourceKey + '：' +
          (r.supersedes || []).map((s) => s.actor + ' → ' + s.supersededBy).join('、') +
          '（两份都留痕；当前生效值 ' + String(r.value) + '，来源 ' + String(r.winner) + '）'
      );
    } else if (r.status === 'conflict') {
      lines.push(
        '- [待裁决] ' + r.resourceKey + '：' +
          (r.contributions || []).map((c) => c.actor + ' 声称 ' + String(c.value)).join('；') +
          ' —— 不得默认取胜者，请先裁决（决定了再合并，或用 merge_subagent_results 带 decisions）'
      );
    } else if (r.status === 'arbitrated') {
      lines.push('- [已裁决] ' + r.resourceKey + '：按 ' + String(r.decidedBy || 'supervisor') + ' 的决定取 ' + String(r.winner) + ' 的值');
    }
  }
  for (const rej of detail ? m.rejectedDecisions || [] : []) {
    lines.push('- [裁决被拒] ' + rej.resourceKey + '（指定 ' + rej.winnerTaskId + '）：' + rej.reason);
  }
  return lines.join('\n');
}

module.exports = {
  MERGE_VERSION,
  stableStringify,
  sha256OfText,
  canonicalize,
  contributionsFromEnvelope,
  merge,
  renderMergeReport,
};
