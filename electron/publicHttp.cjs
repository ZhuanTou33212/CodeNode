'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

// Fail closed for non-global and transition address ranges.
function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  const first = parseInt(address.split(':')[0], 16);
  // Reject mapped IPv4, NAT64, local, multicast, 6to4, Teredo and documentation.
  return first >= 0x2000 && first <= 0x3fff &&
    first !== 0x2001 && first !== 0x2002 && first !== 0x3fff;
}

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('Request cancelled');
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

async function resolveTarget(value, signal, allowPrivateHosts) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048)
    throw new Error('URL protocol, credentials or length rejected');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] :
    await abortable(dns.lookup(hostname, { all: true, verbatim: true }), signal);
  // allowPrivateHosts：**用户自己配置的**端点（如本地/内网的 MCP server）显式放行私有地址。
  // 仍然照常解析并把连接固定到解析结果（防 DNS rebinding）——「允许私有」不等于「不做校验」。
  if (!allowPrivateHosts && (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))))
    throw new Error('SSRF: non-public destination rejected');
  if (!addresses.length) throw new Error('无法解析主机名');
  return { url, address: addresses[0] };
}

function readResponse(url, address, signal, maxBytes, options) {
  const opts = options || {};
  const body = opts.body === undefined || opts.body === null ? null : String(opts.body);
  const headers = Object.assign({ 'User-Agent': 'codenode-agent', 'Accept-Encoding': 'identity' }, opts.headers || {});
  if (body !== null && headers['content-length'] === undefined) headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    // The URL preserves Host and TLS servername. lookup always returns the validated IP.
    // agent:false prevents pooled sockets from bypassing per-request address validation.
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: opts.method || 'GET', agent: false, signal,
      headers,
      lookup: (_hostname, options, callback) => {
        if (options && options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy();
        resolve({ status, location });
        return;
      }
      if (status < 200 || status >= 300) {
        response.destroy(); reject(new Error('HTTP ' + status)); return;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.destroy(); reject(new Error('Compressed response rejected')); return;
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        response.destroy(); reject(new Error('Response exceeds byte limit')); return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          const error = new Error('Response exceeds byte limit');
          reject(error);
          response.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Response interrupted')));
      const flatHeaders = {};
      for (const [key, value] of Object.entries(response.headers || {})) {
        if (typeof value === 'string') flatHeaders[key.toLowerCase()] = value;
        else if (Array.isArray(value)) flatHeaders[key.toLowerCase()] = value.join(', ');
      }
      response.on('end', () => resolve({ status, bytes, headers: flatHeaders, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    // body 必须真的发出去：只设 content-length 不写 body，服务端会一直等那些字节 →
    // 客户端直到超时才 abort（症状是「The operation was aborted」且服务端一条请求都没收到，
    // 2026-09-21 实测踩到，排查方向全错）
    request.end(body === null ? undefined : body);
  });
}

/**
 * @param {string} value
 * @param {{ signal?: AbortSignal, timeoutMs?: number, maxBytes?: number }} [options]
 */
async function fetchPublicText(value, { signal, timeoutMs = 30000, maxBytes = 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }
  const timer = setTimeout(() => controller.abort(new Error('Request deadline exceeded')), timeoutMs);
  try {
    let current = value;
    for (let hop = 0; hop <= 3; hop++) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      const { url, address } = await resolveTarget(current, controller.signal);
      const result = await readResponse(url, address, controller.signal, maxBytes);
      if (result.location) {
        if (hop === 3) throw new Error('Redirect limit exceeded');
        current = new URL(result.location, url).href;
        continue;
      }
      if (result.text == null) throw new Error('Redirect missing Location');
      return { ...result, url: url.href };
    }
    throw new Error('Redirect limit exceeded');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 通用出站请求（GET/POST 等），供 MCP http transport 这类「用户配置的端点」使用。
 * 与 fetchPublicText 的差别：① 支持 method/headers/body；② allowPrivateHosts 可显式放行私有地址；
 * ③ **不自动跟随重定向**（POST 重定向语义各家不同，静默跟随容易把请求发到没预期的地址 —— 如实报错）。
 * @param {string} value
 * @param {{method?: string, headers?: Record<string,string>, body?: string|null, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, allowPrivateHosts?: boolean}} [options]
 */
async function request(value, options = {}) {
  const signal = options.signal;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }
  const timer = setTimeout(() => controller.abort(new Error('Request deadline exceeded')), options.timeoutMs || 30000);
  try {
    if (controller.signal.aborted) throw abortError(controller.signal);
    const { url, address } = await resolveTarget(value, controller.signal, options.allowPrivateHosts === true);
    const result = await readResponse(url, address, controller.signal, options.maxBytes || 1024 * 1024, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    if (result.location) throw new Error('不允许的响应：重定向到 ' + result.location + '（出站请求不自动跟随重定向）');
    return { ...result, url: url.href };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { fetchPublicText, request, isPublicAddress };
