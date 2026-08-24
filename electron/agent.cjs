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
    maxTokens: Number(cfg.max_tokens) || 8192,
    soulFile: cfg.soul_file || 'config/soul.md',
    tools: parseToolsConfig(cfg),
  };
}

/** 解析 tools.* 配置：tools.enabled / tools.allowed(逗号分隔) / tools.deny(逗号分隔) */
function parseToolsConfig(cfg) {
  const split = (v) =>
    String(v || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    toolsEnabled: cfg['tools.enabled'] == null ? true : String(cfg['tools.enabled']).toLowerCase() !== 'false',
    toolsAllowed: split(cfg['tools.allowed']),
    toolsDeny: split(cfg['tools.deny']),
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

/** 工具名称 → 一句话用途（用于系统提示词引导 Agent 调用工具） */
const TOOL_GUIDE = {
  get_workbench_model: '读取画布全部节点/连线/状态',
  workbench_edit: '统一节点工具：创建/编辑/连线/成组（用 operations 批量一次完成）',
  scan_project: '扫描项目目录结构与统计',
  analyze_project: '分析项目工程信息与源码结构',
  project_info: '识别项目构建系统/入口/语言',
  read_file: '读取项目内文本文件（含 PDF 文字层提取）',
  write_file: '写入项目内文件',
  edit_file: '精确替换文件中的某段文本',
  find_files: '按 glob 模式查找文件',
  search_files: '按正则搜索文件内容',
  list_directory: '列出项目目录',
  execute_shell: '在项目目录执行白名单命令',
  code_review: '本地规则引擎静态代码审查',
  ask_user: '向用户提问并等待回答',
  fetch_url: '抓取指定网页文本',
  save_project: '保存当前工程到磁盘',
  bulk_edit: '大批量创建/删除节点或写入文件',
  ui_control: '操控软件界面（聚焦/缩放/平移等）',
  write_analysis_md: '把分析结果写成 Markdown 分析节点',
};

/** 由注册表生成工具引导列表（名称 + 一句用途）。 */
function buildToolGuide(toolSpecs) {
  if (!Array.isArray(toolSpecs) || toolSpecs.length === 0) return [];
  return toolSpecs
    .map((spec) => ({ name: spec.name, desc: TOOL_GUIDE[spec.name] || (spec.description || '').slice(0, 40) }))
    .filter((t) => t.name);
}

function buildSystemPrompt(soul, canvasSummary, toolGuide) {
  const lines = [];
  if (soul.raw) lines.push('【灵魂设定】\n' + soul.raw);
  if (canvasSummary) lines.push('\n【当前画布节点清单（JSON）】\n' + canvasSummary);
  if (toolGuide && toolGuide.length) {
    lines.push(
      '\n【可用工具（通过 function calling 调用）】\n' +
        toolGuide.map((t) => `- ${t.name}：${t.desc}`).join('\n')
    );
  }
  lines.push(
    '\n【运行规则】（硬性要求）\n' +
      '1. 你是一个工具型 Agent：所有对画布/文件的实际操作都必须通过「函数调用（function calling）」完成。\n' +
      '2. 需要读取画布时调用 get_workbench_model；创建/编辑/连线/成组节点统一调用 workbench_edit（用 operations 数组一次提交全部节点变更）。\n' +
      '3. 禁止在回复中声称“已创建/已修改/已完成”某操作——除非你真的通过工具调用完成了它。你只能基于工具返回的结果来描述实际发生的变更。\n' +
      '4. 读写文件用 read_file / write_file / edit_file；查找文件用 find_files / search_files / list_directory；执行命令用 execute_shell。read_file 可直接读取 PDF（自动提取文字层）；若返回「扫描版/文字层不可用」说明该 PDF 无法提取文字，此时不要用 execute_shell 去安装 Python 库（PyPDF2/pypdf/pymupdf）或手工解析 PDF——那样读不了，直接向用户说明并请其提供文本/Word 版。\n' +
      '5. 每轮工具调用的结果会作为新的消息返回给你，请据此继续推进，直到用户请求真正完成（可能需要连续多轮工具调用）。若工具调用失败（返回失败/报错），不要直接结束对话：先分析失败原因（参数错误/节点或文件不存在/路径越界/超时等），修正后重新调用，或换一种工具/调整方案重试，直到成功或确实无可行办法再向用户说明。\n' +
      '6. 画布节点之间的连线表示执行顺序（DAG）。当需要制作/实现程序时，严格按画布节点的顺序组织逻辑，先完成前置节点再处理后续节点。\n' +
      '7. 工作台节点（创建/编辑/连线/成组）统一用 workbench_edit，把一次任务需要的所有节点变更放进 operations 数组一次调用完成，避免逐个多次调用。工具返回的 [data] 中已包含节点 id、label 等结构化信息，直接使用返回结果，不要重复调用 get_workbench_model 反复确认。大文件/大目录用 read_file 的 offset、list_directory/find_files/search_files 的 offset 参数分段续读，不要重复调用同一工具相同参数（相同调用会直接复用上次结果）。\n' +
      '8. 全部完成后，用文字简要总结你实际调用过的工具与最终结果。'
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
 * 流式对话（SSE）：实时回调推理/内容/工具调用增量。tools 为 OpenAI tools 参数（可选）。
 */
async function chatCompletionStream(cfg, messages, onEvent, { signal, timeoutMs = 180000, tools } = {}) {
  const url = cfg.apiBase + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal && signal.addEventListener('abort', onAbort);
  let usage = null;
  try {
    const body = {
      model: cfg.model,
      messages,
      stream: true,
      max_tokens: cfg.maxTokens,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length) body.tools = tools;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
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
              acc = { id: '', name: '', args: '' };
              toolMap.set(idx, acc);
            }
            if (tc.id && !acc.id) acc.id += tc.id;
            if (tc.function) {
              if (tc.function.name) acc.name += tc.function.name;
              if (tc.function.arguments) acc.args += tc.function.arguments;
            }
          }
          onEvent &&
            onEvent({
              kind: 'tool',
              toolCalls: [...toolMap.values()].map((v) => ({ id: v.id, name: v.name, args: v.args })),
            });
        }
      }
    }
    const toolCalls = [...toolMap.values()].map((v) => ({ id: v.id, name: v.name, args: v.args }));
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

const MAX_TOOL_ITERATIONS = 12;
const MAX_TOTAL_TOOL_CALLS = 100;
const DATA_TRUNCATE_CAP = 120000;

/** 只读/分析类工具：相同参数重复调用直接复用上次结果，避免模型空转 */
const CACHEABLE_TOOLS = new Set([
  'get_workbench_model',
  'scan_project',
  'analyze_project',
  'project_info',
  'read_file',
  'find_files',
  'search_files',
  'list_directory',
  'code_review',
  'ask_user',
]);

/** 参数归一化：JSON 解析后按键排序重序列化，使语义相同的调用共享缓存键（消除引号转义/键顺序差异） */
function canonicalArgs(raw) {
  try {
    const obj = JSON.parse(raw);
    const sort = (o) => {
      if (Array.isArray(o)) return o.map(sort);
      if (o && typeof o === 'object') {
        return Object.keys(o)
          .sort()
          .reduce((acc, k) => {
            acc[k] = sort(o[k]);
            return acc;
          }, {});
      }
      return o;
    };
    return JSON.stringify(sort(obj));
  } catch {
    return String(raw || '').trim();
  }
}

function parseToolArgs(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/** 追踪工具调用（时间/命中缓存/耗时/是否重复），追加到项目 .codenode/tools_trace.jsonl */
function logToolTrace(projectRoot, entry) {
  if (!projectRoot) return;
  try {
    const dir = path.join(projectRoot, '.codenode');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'tools_trace.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch {}
}

/** 终端日志转义：非 ASCII 转成 \\uXXXX，避免 Windows 终端（GBK）把中文显示成乱码 */
function safeLog(s) {
  return String(s || '').replace(/[^\x20-\x7E]/g, (c) => {
    const cp = c.codePointAt(0);
    return cp <= 0xffff ? '\\u' + cp.toString(16).padStart(4, '0') : '\\u{' + cp.toString(16) + '}';
  });
}

/**
 * 带工具循环的 Agent 对话（ReAct）。
 * @param {object} opts
 *   cfg          loadConfig 返回值
 *   messages     已含 system 的完整消息数组（会被原地追加）
 *   onDelta       增量回调 {kind:'start'|'reasoning'|'content'|'tool'|'tool_result'|'done'|'error', ...}
 *   tools         { registry, context } 或 null（禁用工具）
 *   signal        AbortSignal（可选）
 *   timeoutMs     单轮超时（默认 180s）
 * @returns {Promise<{content,reasoning,toolCalls,usage,error?}>}
 */
async function runAgentChat({ cfg, messages, onDelta, tools, signal, timeoutMs = 180000 }) {
  onDelta && onDelta({ kind: 'start' });
  let content = '';
  let reasoning = '';
  let usage = null;
  const allToolCalls = [];
  const toolResultCache = new Map();
  let totalToolCalls = 0;
  let loopIterations = 0;
  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      loopIterations = iter + 1;
      const payload = {
        model: cfg.model,
        messages,
        stream: true,
        max_tokens: cfg.maxTokens,
        stream_options: { include_usage: true },
      };
      if (tools && tools.registry) {
        payload.tools = tools.registry.toOpenAiTools();
      }
      const onEvent = (ev) => {
        if (ev.kind === 'reasoning') {
          reasoning += ev.text;
          onDelta && onDelta({ kind: 'reasoning', text: ev.text });
        } else if (ev.kind === 'content') {
          content += ev.text;
          onDelta && onDelta({ kind: 'content', text: ev.text });
        } else if (ev.kind === 'tool') {
          onDelta && onDelta({ kind: 'tool', toolCalls: ev.toolCalls });
        }
      };
      const res = await chatCompletionStream(cfg, messages, onEvent, {
        signal,
        timeoutMs,
        tools: payload.tools,
      });
      if (res.usage) usage = res.usage;

      const toolCalls = res.toolCalls || [];
      if (tools && tools.registry && toolCalls.length) {
        // 注意：content 已在 onEvent 流式累加，此处不能重复累加（否则每轮带内容的工具调用会重复叠加）
        messages.push({
          role: 'assistant',
          content: res.content || '',
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id || ('call_' + iter + '_' + Math.random().toString(36).slice(2, 8)),
            type: 'function',
            function: { name: tc.name, arguments: tc.args || '{}' },
          })),
        });
        let capped = false;
        let failedAny = false;
        for (const tc of toolCalls) {
          if (totalToolCalls >= MAX_TOTAL_TOOL_CALLS) {
            capped = true;
            break;
          }
          totalToolCalls++;
          const t0 = Date.now();
          const args = parseToolArgs(tc.args);
          const rawArgs = (tc.args || '').trim();
          // 检测参数 JSON 损坏：模型可能把引号转义错误，导致工具拿到空参而失败、反复重试
          const malformed = rawArgs !== '' && rawArgs !== '{}' && Object.keys(args).length === 0;
          let result;
          let repeated = false;
          const cacheKey = CACHEABLE_TOOLS.has(tc.name) ? tc.name + '\u0000' + canonicalArgs(tc.args) : null;
          if (cacheKey) {
            const cached = toolResultCache.get(cacheKey);
            if (cached) {
              result = cached;
              repeated = true;
            } else {
              result = await tools.registry.execute(tc.name, args, tools.context);
              // 只缓存成功结果：失败不缓存（文件/节点可能随后被创建，需允许重试时重新执行）
              if (result.ok) toolResultCache.set(cacheKey, result);
            }
          } else {
            result = await tools.registry.execute(tc.name, args, tools.context);
          }
          const elapsed = Date.now() - t0;
          const record = {
            name: tc.name,
            args: tc.args || '',
            ok: result.ok,
            result: result.text,
            data: result.data,
          };
          if (repeated) record.repeated = true;
          if (!result.ok) failedAny = true;
          allToolCalls.push(record);
          let toolContent = repeated
            ? '（相同参数已重复调用，直接复用上次结果，请勿再次重复）' + (result.text || '')
            : result.text || (result.ok ? '（空）' : '（失败）');
          if (malformed) {
            toolContent = '【参数格式错误】传给 ' + tc.name + ' 的 arguments 不是合法 JSON（引号未转义等），解析后为空。请修正转义后重新调用，不要重复相同调用。\n' + toolContent;
          }
          // 把结构化 data 一并回传给模型，避免模型因看不到细节而反复读取/猜测
          if (result.data && typeof result.data === 'object' && Object.keys(result.data).length) {
            try {
              const dataJson = JSON.stringify(result.data);
              toolContent +=
                '\n[data] ' +
                (dataJson.length > DATA_TRUNCATE_CAP
                  ? dataJson.slice(0, DATA_TRUNCATE_CAP) + '…（已截断，可用 offset/更小范围参数获取剩余）'
                  : dataJson);
            } catch {}
          }
          messages.push({
            role: 'tool',
            tool_call_id: tc.id || '',
            content: toolContent,
          });
          onDelta && onDelta({ kind: 'tool_result', toolCalls: [record] });
          logToolTrace(tools.context && tools.context.projectRoot ? tools.context.projectRoot() : null, {
            kind: 'tool',
            iter,
            name: tc.name,
            repeated,
            malformed,
            ok: result.ok,
            elapsedMs: elapsed,
            args: tc.args || '',
          });
          try {
            const clean = JSON.stringify(args || {}).slice(0, 100);
            console.log(
              '[tool] iter=' + iter + ' ' + tc.name + (repeated ? ' (repeated, cached)' : '') +
                (malformed ? ' (MALFORMED ARGS)' : '') + ' ok=' + result.ok + ' ' + elapsed + 'ms' +
                (clean && clean !== '{}' ? ' args=' + safeLog(clean) : '')
            );
          } catch {}
        }
        // 工具调用失败时，提示模型重新思考解决方案而不是直接结束
        if (failedAny && !capped) {
          const failedTools = [...new Set(allToolCalls.slice(-toolCalls.length).filter((t) => t.ok === false).map((t) => t.name))];
          messages.push({
            role: 'user',
            content:
              '【系统提示】上述工具调用失败：' + (failedTools.join('、') || '未知') + '。' +
              '任务尚未完成，请先分析失败原因（参数错误/节点或文件不存在/路径越界/重复操作/超时等），' +
              '修正参数后重新调用，或改用更合适的方式继续推进；除非确认任务确实无法完成，否则不要直接结束对话。',
          });
        }
        logToolTrace(tools.context && tools.context.projectRoot ? tools.context.projectRoot() : null, {
          kind: 'round_end',
          iter,
          toolCount: toolCalls.length,
          executed: totalToolCalls,
          capped,
        });
        if (capped) {
          if (!content) content = '已达单次任务工具调用上限（' + MAX_TOTAL_TOOL_CALLS + ' 次），已停止继续调用工具，请基于已获取的信息作答。';
          break;
        }
        continue;
      }
      content = content || res.content || '';
      if (!content && reasoning) {
        onDelta && onDelta({ kind: 'content', text: '' });
      }
      break;
    }
    onDelta && onDelta({ kind: 'done' });
    logToolTrace(tools && tools.context && tools.context.projectRoot ? tools.context.projectRoot() : null, {
      kind: 'turn_end',
      totalToolCalls,
      executedUnique: allToolCalls.filter((t) => !t.repeated).length,
      repeated: allToolCalls.filter((t) => t.repeated).length,
      iterations: loopIterations,
      resultLen: content.length,
    });
    return { content, reasoning, toolCalls: allToolCalls, usage };
  } catch (e) {
    onDelta && onDelta({ kind: 'error', error: String((e && e.message) || e) });
    return { content, reasoning, toolCalls: allToolCalls, usage, error: String((e && e.message) || e) };
  }
}

module.exports = {
  loadConfig,
  loadSoul,
  parseSoul,
  buildSystemPrompt,
  buildToolGuide,
  chatCompletion,
  chatCompletionStream,
  logConversation,
  resolveSoulPath,
  parseToolsConfig,
  runAgentChat,
  logToolTrace,
};
