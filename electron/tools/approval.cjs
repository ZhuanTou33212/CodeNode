/**
 * approval.cjs —— ApprovalService：令牌化审批（S7，2026-09-16）
 *
 * 审查 P0-3 / S7：确认类工具此前只有一句 `context.confirm()` 布尔问答，没有任何**凭据**概念 ——
 * 于是「谁批的、批了什么范围、什么时候过期、能不能复用」全都无处安放；更要命的是，
 * 只要工具参数里能塞一个 `confirmed: true`，模型就有机会**自己把审批给批了**。
 *
 * 本模块把审批变成**服务端签发的令牌**：
 *   - `request()`：调用注入的 confirm 处理器（界面弹窗 → 用户点批准），**只有批准**才签发令牌；
 *     令牌带 `capability` / `scope` / `issuedAt` / `expiresAt` / `toolCallId` / `attemptId`；
 *   - `verify()`：校验「令牌存在、未过期、未消费、能力匹配、调用匹配、scope 覆盖本次目标」，
 *     通过后**立即消费**（单次有效）—— 一次批准只够一次调用；
 *   - 令牌表只活在内存里（不落盘、不进上下文），模型无论如何自填都拿不到有效令牌。
 *
 * 失败原因（写入 trace / 审计，便于事后归因）：`UNKNOWN_TOKEN` / `ALREADY_CONSUMED` /
 * `EXPIRED` / `CAPABILITY_MISMATCH` / `TOOL_CALL_MISMATCH` / `SCOPE_MISMATCH` / `NO_CONFIRM_CHANNEL`。
 */
'use strict';

const crypto = require('crypto');

/** 令牌默认有效期（5 分钟：足够用户点一次确认，也不至于长期悬挂） */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** 归一 scope：字符串或数组 → 非空字符串数组 */
function normalizeScope(scope) {
  if (scope == null) return [];
  const list = Array.isArray(scope) ? scope : [scope];
  return list.map((item) => String(item)).filter(Boolean);
}

/**
 * 授予范围是否覆盖本次要求：逐项相等，或授予项以 `*` 结尾做前缀覆盖
 * （例如 `workspace.write:src/*` 覆盖 `workspace.write:src/a.ts`）。
 * @returns {string[]} 未被覆盖的项（空数组 = 全覆盖）
 */
function scopeMissing(granted, required) {
  const need = normalizeScope(required);
  if (!need.length) return [];
  const have = normalizeScope(granted);
  return need.filter((item) => !have.some((g) => g === item || (g.endsWith('*') && item.startsWith(g.slice(0, -1)))));
}

function newTokenId() {
  return 'apv_' + crypto.randomBytes(9).toString('hex');
}

class ApprovalService {
  /**
   * @param {{confirm?: Function|null, trace?: Function|null, now?: () => number, ttlMs?: number, runId?: string, taskId?: string, role?: string}} [options]
   */
  constructor(options) {
    const o = options || {};
    this.confirmHandler = typeof o.confirm === 'function' ? o.confirm : null;
    this.trace = typeof o.trace === 'function' ? o.trace : null;
    this.now = typeof o.now === 'function' ? o.now : () => Date.now();
    this.ttlMs = Number.isFinite(Number(o.ttlMs)) && Number(o.ttlMs) > 0 ? Math.floor(Number(o.ttlMs)) : DEFAULT_TTL_MS;
    this.runId = o.runId || '';
    this.taskId = o.taskId || '';
    this.role = o.role || '';
    /** @type {Map<string, any>} 令牌表（仅内存：重启即失效，不落盘、不进上下文） */
    this.tokens = new Map();
  }

  /** 内部：落一条审批事件（trace + 内存事件流，供测试与审计读取） */
  _emit(event, data) {
    const payload = Object.assign({ kind: 'approval', event, runId: this.runId, taskId: this.taskId, role: this.role, toolCallId: (data && data.toolCallId) || null, at: new Date(this.now()).toISOString() }, data || {});
    if (!this.events) this.events = [];
    this.events.push(payload);
    if (this.trace) {
      try {
        this.trace(payload);
      } catch {}
    }
    return payload;
  }

  /**
   * 申请审批：只有 confirm 处理器明确返回 true 才签发令牌。
   * @param {{capability?: string|null, level?: string, what?: string, detail?: string, scope?: any, toolCallId?: string|null, attemptId?: string|null}} req
   * @returns {Promise<any|null>} 令牌或 null（未批准 / 无审批通道）
   */
  async request(req) {
    const r = req || {};
    const scope = normalizeScope(r.scope);
    if (!this.confirmHandler) {
      this._emit('approval_unavailable', { reason: 'NO_CONFIRM_CHANNEL', tool: r.what || null });
      return null;
    }
    let approved = false;
    try {
      approved = (await this.confirmHandler(r.level || 'WRITE', r.what || '', r.detail || '')) === true;
    } catch (error) {
      approved = false;
      this._emit('approval_error', { tool: r.what || null, message: String((error && error.message) || error || '') });
    }
    if (approved !== true) {
      this._emit('approval_denied', { tool: r.what || null, level: r.level || 'WRITE', capability: r.capability || null, scope });
      return null;
    }
    const issuedAtMs = this.now();
    const token = {
      id: newTokenId(),
      capability: r.capability || null,
      scope,
      level: r.level || 'WRITE',
      toolCallId: r.toolCallId || null,
      attemptId: r.attemptId || null,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + this.ttlMs).toISOString(),
      singleUse: true,
      consumed: false,
    };
    this.tokens.set(token.id, token);
    this._emit('approval_issued', { tokenId: token.id, tool: r.what || null, capability: token.capability, scope, toolCallId: token.toolCallId, expiresAt: token.expiresAt });
    return token;
  }

  /**
   * 校验令牌是否仍有效且覆盖本次调用；通过即消费（单次有效）。
   * @param {string|any} tokenOrId
   * @param {{capability?: string|null, scope?: any, toolCallId?: string|null}} [req]
   * @returns {{valid: boolean, reason: string, token?: any}}
   */
  verify(tokenOrId, req) {
    const r = req || {};
    const id = typeof tokenOrId === 'string' ? tokenOrId : tokenOrId && tokenOrId.id;
    const reject = (reason, data) => {
      this._emit('approval_rejected', Object.assign({ tokenId: id || null, reason }, data || {}));
      return { valid: false, reason };
    };
    if (!id) return reject('UNKNOWN_TOKEN');
    const token = this.tokens.get(id);
    if (!token) return reject('UNKNOWN_TOKEN');
    if (token.consumed) return reject('ALREADY_CONSUMED');
    if (this.now() > Date.parse(token.expiresAt)) {
      this.tokens.delete(token.id);
      return reject('EXPIRED');
    }
    if (r.capability && token.capability && String(r.capability) !== String(token.capability)) {
      return reject('CAPABILITY_MISMATCH', { expected: token.capability, got: r.capability });
    }
    if (r.toolCallId && token.toolCallId && String(r.toolCallId) !== String(token.toolCallId)) {
      return reject('TOOL_CALL_MISMATCH', { expected: token.toolCallId, got: r.toolCallId });
    }
    const missing = scopeMissing(token.scope, r.scope);
    if (missing.length) return reject('SCOPE_MISMATCH', { missing });
    token.consumed = true;
    this._emit('approval_consumed', { tokenId: token.id, capability: token.capability, scope: token.scope, toolCallId: token.toolCallId });
    return { valid: true, reason: '', token };
  }

  /** 是否具备审批通道（没有通道时注册表按 APPROVAL_REQUIRED 处理，而不是「用户拒绝」） */
  available() {
    return !!this.confirmHandler;
  }

  /** 撤销单个令牌；返回是否撤销成功 */
  revoke(id) {
    const token = this.tokens.get(String(id || ''));
    if (!token) return false;
    this.tokens.delete(token.id);
    this._emit('approval_revoked', { tokenId: token.id });
    return true;
  }

  /** 撤销全部（run 结束 / 用户中断时调用） */
  revokeAll(reason) {
    const count = this.tokens.size;
    this.tokens.clear();
    if (count) this._emit('approval_revoked_all', { count, reason: reason || '' });
    return count;
  }

  /** 未消费且未过期的令牌（诊断用） */
  pending() {
    const nowMs = this.now();
    return [...this.tokens.values()].filter((token) => !token.consumed && nowMs <= Date.parse(token.expiresAt));
  }
}

/** 工厂：与其它模块保持同一种「create*」风格 */
function createApprovalService(options) {
  return new ApprovalService(options);
}

module.exports = {
  ApprovalService,
  createApprovalService,
  normalizeScope,
  scopeMissing,
  DEFAULT_TTL_MS,
};
