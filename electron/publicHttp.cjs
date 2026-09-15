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

async function resolveTarget(value, signal) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048)
    throw new Error('URL protocol, credentials or length rejected');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] :
    await abortable(dns.lookup(hostname, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
    throw new Error('SSRF: non-public destination rejected');
  return { url, address: addresses[0] };
}

function readResponse(url, address, signal, maxBytes) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    // The URL preserves Host and TLS servername. lookup always returns the validated IP.
    // agent:false prevents pooled sockets from bypassing per-request address validation.
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'GET', agent: false, signal,
      headers: { 'User-Agent': 'codenode-agent', 'Accept-Encoding': 'identity' },
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
      response.on('end', () => resolve({ status, bytes, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
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

module.exports = { fetchPublicText, isPublicAddress };
