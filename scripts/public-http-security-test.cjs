'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { fetchPublicText, isPublicAddress } = require('../electron/publicHttp.cjs');

async function main() {
  for (const ip of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '::1',
    '::ffff:7f00:1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00::1', 'fe80::1'])
    assert.strictEqual(isPublicAddress(ip), false, ip);
  assert.strictEqual(isPublicAddress('8.8.8.8'), true);
  assert.strictEqual(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(fetchPublicText('http://127.0.0.1/'), /SSRF/);
  await assert.rejects(fetchPublicText('http://[::ffff:127.0.0.1]/'), /SSRF/);
  const preAborted = new AbortController();
  preAborted.abort(new Error('pre-cancel'));
  await assert.rejects(fetchPublicText('https://example.test', { signal: preAborted.signal }), /pre-cancel/);

  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); }
    else if (req.url === '/large') { res.writeHead(200); res.write('x'.repeat(200)); res.end(); }
    else if (req.url === '/slow') { res.writeHead(200); res.flushHeaders(); }
    else { res.end('fixture-ok'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
  const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
  let resolutions = 0;
  let requests = 0;
  const module = { exports: {} };
  // Test-only transport maps a validated public IP to a controlled local server.
  // Production exposes no switch to permit private destinations.
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/publicHttp.cjs'), 'utf8'), {
    module, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require: name => {
      if (name === 'node:dns') return { promises: { lookup: async () => {
        resolutions++;
        return [{ address: '8.8.8.8', family: 4 }];
      } } };
      if (name === 'node:http') return { request: (url, options, cb) => {
        requests++;
        options.lookup('changed.example', {}, (error, ip, family) => {
          assert.ifError(error);
          assert.strictEqual(ip, '8.8.8.8');
          assert.strictEqual(family, 4);
        });
        assert.strictEqual(options.agent, false);
        return http.request({ hostname: '127.0.0.1', port, path: url.pathname,
          method: 'GET', signal: options.signal, headers: options.headers }, cb);
      } };
      return require(name);
    },
  });
  const fetch = module.exports.fetchPublicText;
  try {
    assert.strictEqual((await fetch('http://example.test/')).text, 'fixture-ok');
    assert.strictEqual(resolutions, 1, 'one resolution, pinned transport');
    await assert.rejects(fetch('http://example.test/large', { maxBytes: 100 }), /byte limit/);
    const before = requests;
    await assert.rejects(fetch('http://example.test/redirect'), /SSRF/);
    assert.strictEqual(requests, before + 1, 'private redirect must not connect');
    await assert.rejects(fetch('http://example.test/slow', { timeoutMs: 50 }));
    const controller = new AbortController();
    const pending = fetch('http://example.test/slow', { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('PUBLIC HTTP SECURITY: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

