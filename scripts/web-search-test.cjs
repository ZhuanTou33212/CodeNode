/**
 * web-search-test.cjs —— 联网搜索 `web_search`（对照文档 §5 #7）
 *
 * 短板：此前只有 `fetch_url`（已知 URL 才能抓），没有「先搜再读」。
 * 设计：可配置后端（searxng / custom）+ **出厂关闭**（不配就不注册工具 → 零上下文成本）。
 *
 * 判据（用进程内 mock 后端记请求取证）：
 *   A 配置解析：默认关；启用但缺/写错 endpoint → 记 problems；backend 非法值回落；maxResults 钳制
 *   B 注册与零痕迹：未启用**不注册**（schema 不进 prompt）；启用后能力是 network.request
 *   C 正常搜索：searxng 形状 → 结构化结果 + 文本可读；查询被 URL 编码（mock 侧取证）
 *   D 后端变体：custom 的 `{items}` / 裸数组；api_key → Authorization 头真的发出去
 *   E 不编造：空结果 → 如实「没有结果」；HTTP 500 / 非 JSON / 形状不对 → 各自如实报错
 *   F 出网策略：network=deny（出厂默认）→ 拒绝并说明怎么放开，且**一个请求都不发**
 *   G 条数：maxResults 参数覆盖配置值，且真的截断
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const webSearch = require('../electron/tools/impl/webSearchTool.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-web-search-'));
const policyAllow = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: root, userDataDir: os.tmpdir() });
const policyDeny = sandbox.resolvePolicy({ mode: 'off', network: 'deny' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policyAllow);

/** mock 搜索后端 */
function startBackend(mode) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push({ path: url.pathname, q: url.searchParams.get('q'), format: url.searchParams.get('format'), auth: req.headers.authorization || null });
    const json = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (mode === 'error500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    if (mode === 'notjson') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>不是 JSON</html>');
      return;
    }
    if (mode === 'empty') return json({ results: [] });
    if (mode === 'weird') return json({ data: { hits: [] } });
    if (mode === 'items') return json({ items: [{ title: 'T1', link: 'https://a.example/1', description: 'D1' }] });
    if (mode === 'array') return json([{ name: 'A1', href: 'https://b.example/1', snippet: 'S1' }]);
    if (mode === 'many') {
      return json({ results: Array.from({ length: 9 }, (_, i) => ({ title: 'R' + i, url: 'https://c.example/' + i, content: 'C' + i })) });
    }
    return json({
      results: [
        { title: 'Electron 文档', url: 'https://electronjs.org/docs', content: 'Electron 官方文档：进程模型与 IPC。' },
        { title: '另一个结果', url: 'https://example.com/x', content: '不含关键词的内容' },
      ],
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {any} */ (server.address());
      resolve({ port: addr.port, seen, stop: () => new Promise((done) => server.close(done)) });
    });
  });
}

function contextFor(config, policy) {
  return new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy || policyAllow,
    webSearchConfig: config,
    signal: new AbortController().signal,
  });
}
function registry(enabled, config) {
  return toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, webSearchEnabled: enabled === true, defaultConfig: config });
}

(async () => {
  // ==================== A. 配置解析 ====================
  console.log('\n== A. 配置解析 ==');
  {
    const off = webSearch.parseWebSearchConfig({});
    check('[A] 默认关闭（不配就不注册，零上下文成本）', off.enabled === false && off.backend === 'searxng' && off.problems.length === 0, JSON.stringify(off));
    const bad = webSearch.parseWebSearchConfig({ 'web_search.enabled': 'true' });
    check('[A] 启用但没配 endpoint → 记下 problems（当作未启用处理，且写明原因）', bad.enabled === true && bad.problems.length === 1 && /没有配 web_search\.endpoint/.test(bad.problems[0]), JSON.stringify(bad.problems));
    const badProto = webSearch.parseWebSearchConfig({ 'web_search.enabled': 'true', 'web_search.endpoint': '127.0.0.1:8888/search' });
    check('[A] endpoint 缺协议头 → 记 problems', badProto.problems.some((p) => /http:\/\/ 或 https:\/\//.test(p)), JSON.stringify(badProto.problems));
    const weird = webSearch.parseWebSearchConfig({ 'web_search.enabled': 'true', 'web_search.endpoint': 'http://x/s', 'web_search.backend': '不存在的后端' });
    check('[A] backend 非法值 → 回落 searxng（不静默跑一个不存在的后端）', weird.backend === 'searxng', weird.backend);
    const clamped = webSearch.parseWebSearchConfig({ 'web_search.enabled': 'true', 'web_search.endpoint': 'http://x/s', 'web_search.max_results': '999' });
    check('[A] maxResults 钳制到 20', clamped.maxResults === 20, String(clamped.maxResults));
  }

  // ==================== B. 注册与零痕迹 ====================
  console.log('\n== B. 注册 ==');
  {
    const off = registry(false);
    check('[B] 未启用 → web_search **不注册**（schema 不进 prompt）', off.contains('web_search') === false);
    check('[B] 未启用 → 描述符也拿不到（没有半个空壳工具）', off.descriptorOf('web_search') == null);
    const on = registry(true);
    check('[B] 启用 → 注册且能力是 network.request', on.contains('web_search') === true && on.descriptorOf('web_search').requiredCapability === 'network.request', String(on.descriptorOf('web_search') && on.descriptorOf('web_search').requiredCapability));
    const noCfg = await on.execute('web_search', { query: 'x' }, contextFor(null));
    check('[B] 没拿到配置时如实报「未启用或未配置」', noCfg.ok === false && /未启用或未配置/.test(String(noCfg.text)), String(noCfg.text).slice(0, 60));
  }

  // ==================== C. 正常搜索 ====================
  console.log('\n== C. 正常搜索 ==');
  {
    const mock = await startBackend('searxng');
    const config = { enabled: true, backend: 'searxng', endpoint: 'http://127.0.0.1:' + mock.port + '/search', apiKey: '', maxResults: 5, timeoutMs: 10000, problems: [] };
    const reg = registry(true);
    const res = await reg.execute('web_search', { query: 'electron 进程模型' }, contextFor(config));
    check('[C] 搜索成功并给出可读结果（标题+链接+摘要）', res.ok === true && /Electron 文档/.test(String(res.text)) && /electronjs\.org\/docs/.test(String(res.text)), String(res.text).slice(0, 70));
    check('[C] data 里是结构化结果（便于 UI/审计）', res.data.count === 2 && res.data.results[0].url === 'https://electronjs.org/docs', JSON.stringify(res.data.results && res.data.results.length));
    check('[C] 查询被 URL 编码后发出（中文不乱码）', mock.seen[0].q === 'electron 进程模型', JSON.stringify(mock.seen[0]));
    check('[C] searxng 后端自动带上 format=json', mock.seen[0].format === 'json', String(mock.seen[0].format));
    check('[C] 只发一次请求（不重试出重复结果）', mock.seen.length === 1, 'seen=' + mock.seen.length);
    await mock.stop();
  }

  // ==================== D. 后端变体 ====================
  console.log('\n== D. 后端变体 ==');
  {
    const mockItems = await startBackend('items');
    const reg = registry(true);
    const cfgItems = { enabled: true, backend: 'custom', endpoint: 'http://127.0.0.1:' + mockItems.port + '/search', apiKey: 'sk-test', maxResults: 5, timeoutMs: 10000, problems: [] };
    const resItems = await reg.execute('web_search', { query: 'q1' }, contextFor(cfgItems));
    check('[D] custom 后端：{items:[…]} 形状能归一化', resItems.ok === true && resItems.data.results[0].url === 'https://a.example/1' && /D1/.test(String(resItems.text)), JSON.stringify(resItems.data.results));
    check('[D] api_key 以 Authorization: Bearer 发出（mock 侧取证）', mockItems.seen[0].auth === 'Bearer sk-test', String(mockItems.seen[0].auth));
    await mockItems.stop();

    const mockArr = await startBackend('array');
    // {query} 的语义是「URL 编码后的查询词」，参数名由配置作者写（q={query}）
    const cfgArr = { enabled: true, backend: 'custom', endpoint: 'http://127.0.0.1:' + mockArr.port + '/search?q={query}&n=3', apiKey: '', maxResults: 5, timeoutMs: 10000, problems: [] };
    const resArr = await reg.execute('web_search', { query: 'q2' }, contextFor(cfgArr));
    check('[D] 端点模板里的 {query} 被替换（自定义查询串）', resArr.ok === true && resArr.data.results[0].title === 'A1' && mockArr.seen[0].q === 'q2', JSON.stringify(mockArr.seen[0]));
    check('[D] 裸数组形状也能归一化', resArr.data.results[0].url === 'https://b.example/1', JSON.stringify(resArr.data.results));
    await mockArr.stop();
  }

  // ==================== E. 不编造 ====================
  console.log('\n== E. 空与错误 ==');
  {
    const reg = registry(true);
    /** @type {Array<[string, RegExp, string]>} */
    const cases = [
      ['empty', /没有返回结果/, '空结果 → 如实说「没有结果」'],
      ['error500', /HTTP 500/, 'HTTP 500 → 报出状态码'],
      ['notjson', /不是 JSON/, '非 JSON → 如实报不是 JSON'],
      ['weird', /没有 results 数组/, '形状不对 → 如实报形状不对'],
    ];
    for (const [mode, pattern, label] of cases) {
      const mock = await startBackend(mode);
      const config = { enabled: true, backend: 'searxng', endpoint: 'http://127.0.0.1:' + mock.port + '/search', apiKey: '', maxResults: 5, timeoutMs: 10000, problems: [] };
      const res = await reg.execute('web_search', { query: 'x' }, contextFor(config));
      const ok = mode === 'empty' ? res.ok === true && pattern.test(String(res.text)) && res.data.count === 0 : res.ok === false && pattern.test(String(res.text));
      check('[E] ' + label, ok, String(res.text).slice(0, 70));
      await mock.stop();
    }
  }

  // ==================== F. 出网策略 ====================
  console.log('\n== F. 出网策略 ==');
  {
    const mock = await startBackend('searxng');
    const config = { enabled: true, backend: 'searxng', endpoint: 'http://127.0.0.1:' + mock.port + '/search', apiKey: '', maxResults: 5, timeoutMs: 10000, problems: [] };
    const reg = registry(true);
    const res = await reg.execute('web_search', { query: 'x' }, contextFor(config, policyDeny));
    // 拒绝可能来自工具自身的联网判据，也可能来自更外层的执行隔离门禁 —— 两者都算「如实拒绝」，
    // 但都必须点名 sandbox.network=deny 与 web_search（否则用户不知道是谁拦的）
    check('[F] network=deny → 拒绝且点名原因与工具', res.ok === false && /sandbox\.network=deny/.test(String(res.text)) && /web_search/.test(String(res.text)), String(res.text).slice(0, 90));
    check('[F] 拒绝时不发任何请求（mock 一条都没收到）', mock.seen.length === 0, 'seen=' + mock.seen.length);

    /**
     * 纵深防御：注册表层还有一道「联网门禁」，平时会在工具执行前就拒掉 ——
     * 于是工具**自身**的判据永远不会被触发，判据也就锁不住它（变异测试当场抓出：把这条
     * 内层判据删掉，用例照样绿）。这里绕过注册表直接调 handler，专门验内层那道。
     */
    /** @type {any} */
    let handler = null;
    webSearch.register({ register: (_name, _desc, _schema, fn) => { handler = fn; } });
    assert(typeof handler === 'function', '未能从 register 捕获 handler');
    const inner = await handler(contextFor(config, policyDeny), { query: 'x' });
    check('[F] 工具自身也拦（纵深防御：注册表门禁之外的第二道）', inner.ok === false && /sandbox\.network=deny/.test(String(inner.text)), String(inner.text).slice(0, 80));
    check('[F] 内层拒绝同样不发请求', mock.seen.length === 0, 'seen=' + mock.seen.length);

    // 反向：放开策略后 handler 真的会发请求（证明上面不是「无论如何都拒」）
    const allowed = await handler(contextFor(config, policyAllow), { query: 'electron' });
    check('[F] 同一 handler 在允许出网时正常发请求（不是一律拒绝）', allowed.ok === true && mock.seen.length === 1, JSON.stringify({ ok: allowed.ok, seen: mock.seen.length }));
    await mock.stop();
  }

  // ==================== G. 条数 ====================
  console.log('\n== G. 条数 ==');
  {
    const mock = await startBackend('many');
    const config = { enabled: true, backend: 'searxng', endpoint: 'http://127.0.0.1:' + mock.port + '/search', apiKey: '', maxResults: 5, timeoutMs: 10000, problems: [] };
    const reg = registry(true);
    const def = await reg.execute('web_search', { query: 'x' }, contextFor(config));
    check('[G] 默认按配置的 maxResults=5 截断', def.data.count === 5, String(def.data.count));
    const over = await reg.execute('web_search', { query: 'x', maxResults: 2 }, contextFor(config));
    check('[G] 参数 maxResults=2 → 真的只回 2 条', over.data.count === 2, String(over.data.count));
    const capOver = await reg.execute('web_search', { query: 'x', maxResults: 500 }, contextFor(config));
    check('[G] maxResults=500 被 schema 拦下（上界 20 的第一道防线）', capOver.ok === false, JSON.stringify({ ok: capOver.ok, code: capOver.data && capOver.data.code, count: capOver.data && capOver.data.count }));
    await mock.stop();
  }

  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'WEB SEARCH TEST: PASS' : 'WEB SEARCH TEST: FAIL (' + failures + ')'));
  // 必须显式 exit：mock server 还开着时事件循环不会自己结束，失败的用例会把进程挂死（实测）
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('WEB SEARCH TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
