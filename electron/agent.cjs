/**
 * CodeNode Agent 核心（参考 DeepSeek Harness 配置分层 + 原项目 Agent 工具）
 * - 配置：工程 .codenode/agent.properties 覆盖全局 config/agent.properties
 * - 灵魂：soul.md（初次注入语言风格/称呼/名字/问候）
 * - 对话：OpenAI 兼容 /chat/completions（默认 DeepSeek）
 * - 会话：追加式 JSONL 记录（时间/角色/内容）
 */
'use strict';

const fs = require('fs');
const path = require('path');

function loadProperties(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function loadConfig(projectRoot) {
  const globalCfg = loadProperties(path.join(__dirname, '..', 'config', 'agent.properties'));
  const projectCfg = projectRoot
    ? loadProperties(path.join(projectRoot, '.codenode', 'agent.properties'))
    : {};
  const cfg = { ...globalCfg, ...projectCfg };
  return {
    apiBase: (cfg.api_base || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: cfg.api_key || '',
    model: cfg.model || 'deepseek-chat',
    maxTokens: Number(cfg.max_tokens) || 2048,
    soulFile: cfg.soul_file || 'config/soul.md',
  };
}

function resolveSoulPath(cfg, projectRoot) {
  if (path.isAbsolute(cfg.soulFile)) return cfg.soulFile;
  if (projectRoot && fs.existsSync(path.join(projectRoot, cfg.soulFile))) {
    return path.join(projectRoot, cfg.soulFile);
  }
  return path.join(__dirname, '..', 'config', 'soul.md');
}

function loadSoul(cfg, projectRoot) {
  const p = resolveSoulPath(cfg, projectRoot);
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

function parseSoul(text) {
  const get = (key) => {
    const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  return {
    name: get('name') || 'CodeNode',
    greeting: get('初次问候') || get('greeting') || '你好，我能为你做什么',
    style: get('语言风格') || '',
    raw: text,
  };
}

function buildSystemPrompt(soul, canvasSummary) {
  const lines = [];
  if (soul.raw) lines.push('【灵魂设定】\n' + soul.raw);
  if (canvasSummary) lines.push('\n【当前画布节点清单（JSON）】\n' + canvasSummary);
  lines.push(
    '\n【运行规则】\n1. 严格按照画布节点执行；\n2. 需要改变画布时用节点表达；\n3. 复杂任务先拆分子代理。'
  );
  return lines.join('\n\n');
}

async function chatCompletion(cfg, messages, { signal, timeoutMs = 120000 } = {}) {
  const url = cfg.apiBase + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal && signal.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: false,
        max_tokens: cfg.maxTokens,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message : null;
    return {
      content: (msg && msg.content) || '',
      reasoning: (msg && msg.reasoning_content) || '',
      toolCalls: (msg && msg.tool_calls) || null,
      usage: data.usage || null,
    };
  } finally {
    clearTimeout(timer);
    signal && signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 流式对话（SSE）：实时回调推理/内容/工具调用增量
 */
async function chatCompletionStream(cfg, messages, onEvent, { signal, timeoutMs = 180000 } = {}) {
  const url = cfg.apiBase + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal && signal.addEventListener('abort', onAbort);
  let usage = null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: true,
        max_tokens: cfg.maxTokens,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning = '';
    const toolMap = new Map();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.usage) usage = j.usage;
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onEvent && onEvent({ kind: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.content) {
          content += delta.content;
          onEvent && onEvent({ kind: 'content', text: delta.content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index != null ? tc.index : 0;
            let acc = toolMap.get(idx);
            if (!acc) {
              acc = { name: '', args: '' };
              toolMap.set(idx, acc);
            }
            if (tc.function) {
              if (tc.function.name) acc.name += tc.function.name;
              if (tc.function.arguments) acc.args += tc.function.arguments;
            }
          }
          onEvent &&
            onEvent({
              kind: 'tool',
              toolCalls: [...toolMap.values()].map((v) => ({ name: v.name, args: v.args })),
            });
        }
      }
    }
    const toolCalls = [...toolMap.values()].map((v) => ({ name: v.name, args: v.args }));
    return { content, reasoning, toolCalls, usage };
  } finally {
    clearTimeout(timer);
    signal && signal.removeEventListener('abort', onAbort);
  }
}

function logConversation(projectRoot, entry) {
  if (!projectRoot) return;
  try {
    const dir = path.join(projectRoot, '.codenode');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'conversation.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
  } catch {}
}

module.exports = {
  loadConfig,
  loadSoul,
  parseSoul,
  buildSystemPrompt,
  chatCompletion,
  chatCompletionStream,
  logConversation,
  resolveSoulPath,
};
