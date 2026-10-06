/**
 * mcpHttpTransport.cjs —— MCP 的 streamable HTTP transport（对照文档 §5 #5 的剩余项）
 *
 * 短板：MCP 此前只支持 stdio（spawn 一个本地进程）。远端/容器化的 MCP server
 * （官方 streamable HTTP：`POST /mcp`，应答可能是 `application/json` 或 `text/event-stream`，
 * 会话由 `mcp-session-id` 头维系）一个都接不上。
 *
 * 本模块只做「一次 JSON-RPC 往返」这一件事，会话/握手/缓存仍归 mcpClient 管：
 *   - POST JSON-RPC；应答按 content-type 分流：JSON 直接解析，event-stream 逐帧找**同 id** 的应答；
 *   - 应答头里的 `mcp-session-id` 记住，后续请求带上（streamable HTTP 的会话维系方式）；
 *   - 走 `publicHttp.request`：地址解析 + 地址固定（防 DNS rebinding）+ 响应字节上限；
 *     本地/内网 MCP server 是**用户自己配置的**端点，所以显式允许私有地址（allowPrivateHosts），
 *     而这与「能不能联网」是两回事 —— 联网仍受 sandbox.network 约束（由调用方在之前拦下）；
 *   - 非 2xx / 找不到同 id 应答 / 超出字节上限，一律如实报错，绝不假装成功。
 */
'use strict';

const { request: httpRequest } = require('../publicHttp.cjs');

const DEFAULT_MAX_BYTES = 1024 * 1024;

/** 解析 SSE 帧，找出 id 匹配的那条 JSON-RPC 应答 */
function pickFromSse(text, id) {
  const frames = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {}
  }
  const hit = frames.find((f) => f && f.id === id);
  if (hit) return hit;
  // 没有同 id：把「收到了什么」如实说出去（这是排查远端 server 行为差异的唯一线索）
  return { __unmatched: frames.length ? frames : null };
}

/**
 * 建一条 HTTP transport。
 * @param {{ url: string, headers?: Record<string,string>, timeoutMs?: number, maxBytes?: number }} options
 */
function createHttpTransport(options) {
  const url = String((options && options.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('MCP http transport 需要合法的 url（http:// 或 https://）');
  const extraHeaders = (options && options.headers) || {};
  for (const key of Object.keys(extraHeaders)) {
    // 头里塞换行 = 请求头注入，直接拒（配置也可能被别的进程写坏）
    if (/[\r\n]/.test(String(extraHeaders[key]))) throw new Error('MCP 请求头含非法字符：' + key);
  }
  const timeoutMs = Math.max(1000, Number(options && options.timeoutMs) || 120000);
  const maxBytes = Math.max(4096, Number(options && options.maxBytes) || DEFAULT_MAX_BYTES);
  let sessionId = null;
  let closed = false;

  return {
    kind: 'http',
    url,
    get sessionId() {
      return sessionId;
    },
    isClosed() {
      return closed;
    },
    close() {
      closed = true;
    },
    /** 发一条请求并等应答（id 由调用方给，这里只负责把应答取回来） */
    async request(id, method, params, signal) {
      if (closed) throw new Error('MCP http 会话已关闭');
      const headers = Object.assign(
        {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'user-agent': 'codenode-agent',
        },
        extraHeaders
      );
      if (sessionId) headers['mcp-session-id'] = sessionId;
      const controller = new AbortController();
      const onAbort = () => controller.abort(new Error('MCP 调用已取消'));
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      const timer = setTimeout(() => controller.abort(new Error('MCP 调用超时（' + method + '）')), timeoutMs);
      try {
        const response = await httpRequest(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
          signal: controller.signal,
          maxBytes,
          allowPrivateHosts: true,
        });
        const header = response.headers && (response.headers['mcp-session-id'] || response.headers['Mcp-Session-Id']);
        if (header) sessionId = String(header);
        if (response.status < 200 || response.status >= 300) {
          throw new Error('MCP http 返回 HTTP ' + response.status + (response.text ? '：' + String(response.text).slice(0, 200) : ''));
        }
        const contentType = String((response.headers && response.headers['content-type']) || '');
        const text = String(response.text || '');
        if (contentType.includes('text/event-stream')) {
          const picked = pickFromSse(text, id);
          if (picked && picked.__unmatched) {
            throw new Error('MCP http SSE 应答里没有 id=' + id + ' 的消息（收到 ' + (picked.__unmatched.length || 0) + ' 帧）');
          }
          if (!picked) throw new Error('MCP http SSE 应答为空');
          if (picked.error) throw new Error(JSON.stringify(picked.error));
          return picked.result;
        }
        if (!text.trim()) throw new Error('MCP http 应答为空（HTTP ' + response.status + '）');
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error('MCP http 应答不是 JSON：' + text.slice(0, 120));
        }
        const message = Array.isArray(parsed) ? parsed.find((m) => m && m.id === id) : parsed;
        if (!message) throw new Error('MCP http 应答里没有 id=' + id + ' 的消息');
        if (message.error) throw new Error(JSON.stringify(message.error));
        return message.result;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    },
    /** 通知（无 id，不等应答；失败只记录不抛——通知本来就允许被忽略） */
    async notify(method, params, signal) {
      if (closed) return false;
      const headers = Object.assign({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'codenode-agent' }, extraHeaders);
      if (sessionId) headers['mcp-session-id'] = sessionId;
      try {
        const response = await httpRequest(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }),
          signal,
          maxBytes,
          allowPrivateHosts: true,
        });
        const header = response.headers && response.headers['mcp-session-id'];
        if (header) sessionId = String(header);
        return response.status >= 200 && response.status < 300;
      } catch {
        return false;
      }
    },
  };
}

module.exports = { createHttpTransport, pickFromSse };
