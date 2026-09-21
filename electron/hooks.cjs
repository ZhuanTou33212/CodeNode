/**
 * hooks.cjs —— 钩子（对照 Claude Code 的 hooks：`PreToolUse`/`PostToolUse`/`SessionStart`/`Stop`）
 *
 * 为什么需要它：在此之前，harness 里「工具执行完之后要做什么」是**写死**的 —— 失败按类别发 nudge、
 * 大结果送压缩、到轮次注入进度。用户（项目作者）没有任何地方声明「改完代码自动跑一次 lint/测试」，
 * 于是「验证」只能靠模型自觉，或者靠人盯着。钩子把这件事实变成**配置**。
 *
 * 本轮实现的是最小可用但完整的一档（对照 Claude Code 的 PostToolUse + SessionStart/Stop）：
 *   `hooks.post_tool_use`  —— 匹配的工具执行完之后跑一条命令，输出作为**机器注入的 user 消息**回灌；
 *   `hooks.session_start`  —— run 开始前跑一条命令（fire-and-forget，输出进 run 事件）；
 *   `hooks.session_stop`   —— run 结束后跑一条命令（同上）。
 * **没有**做 PreToolUse：拦截型钩子要定义「钩子拒绝时算谁的错、怎么回灌、能不能改参数」，
 * 那是另一套语义（Claude Code 用 exit code 2 + stdout 表达），本轮不猜，如实记为未做。
 *
 * 安全约束（钩子命令是用户写的，但仍然跑在「Agent 能改的世界」里，所以不能比 execute_shell 松）：
 *   1. 跑之前过一遍 `shellGuard`：静态审计出**显式越界写**（写到 writeRoots 之外）→ 拒绝执行；
 *      `sandbox.network=deny` 时疑似联网 → 拒绝执行。理由与 execute_shell 完全一致：Windows 没有内核兜底。
 *   2. 走 `sandbox.guardedSpawn`（与 execute_shell 同一条通道：Job Object / bwrap / sandbox-exec）。
 *   3. 有超时（`hooks.timeout_ms`，默认 30s，超时**如实**报 timedOut，不假装成功）；输出有上限
 *      （`hooks.max_output_chars`）；每个 run 有执行次数上限（`hooks.max_runs`，默认 10）——
 *      否则「改文件 → 跑 lint → lint 又改文件」会自己转起来。
 *   4. 不配任何钩子 = 一个进程都不 spawn、一条消息都不注入（与没有这个模块时**逐字节一致**）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sandbox = require('./sandbox.cjs');
const shellGuard = require('./tools/shellGuard.cjs');
const { safeEnvironment } = require('./envPolicy.cjs');
const shellTool = require('./tools/impl/executeShellTool.cjs');

/** 注入消息的前缀：与 compaction 的 MACHINE_USER_PREFIXES 对齐（机器注入，不进摘要） */
const HOOK_NOTE_PREFIX = '【系统提示】钩子结果（';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_CHARS = 2000;
const DEFAULT_MAX_RUNS = 10;
/** 一条 hook 报告在注入消息里的最大字符数（超出截断并标注） */
const MAX_NOTE_CHARS = 6000;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 解析一条规则：`tool=write_file;command=npm run lint;on=success;timeout_ms=60000`
 * 或用 JSON 数组（推荐，见 config/agent.properties.example）。
 * @param {any} raw
 * @param {string} id
 * @returns {{id: string, tools?: string[], on?: string, command?: string, timeoutMs?: number|null, maxOutputChars?: number|null, error?: string}}
 */
function parseRule(raw, id) {
  if (raw == null) return { id, error: '规则为空' };
  if (typeof raw === 'string') {
    const spec = {};
    for (const part of raw.split(';')) {
      const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*)$/.exec(part);
      if (m) spec[m[1]] = m[2].trim();
    }
    raw = spec;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { id, error: '规则必须是对象或 key=value 字符串' };
  const command = String(raw.command || '').trim();
  if (!command) return { id, error: '规则缺少 command' };
  const on = String(raw.on || raw.when || 'success').trim().toLowerCase();
  if (!['success', 'failure', 'always'].includes(on)) return { id, error: 'on 只能是 success|failure|always' };
  const rawTools = raw.tools == null ? raw.tool : raw.tools;
  const tools = Array.isArray(rawTools)
    ? rawTools.map((t) => String(t).trim()).filter(Boolean)
    : String(rawTools == null ? '*' : rawTools)
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
  return {
    id: String(raw.id || id),
    tools: tools.length ? tools : ['*'],
    on,
    command,
    timeoutMs: raw.timeoutMs == null && raw.timeout_ms == null ? null : clampInt(raw.timeoutMs != null ? raw.timeoutMs : raw.timeout_ms, 1000, 600000, DEFAULT_TIMEOUT_MS),
    maxOutputChars:
      raw.maxOutputChars == null && raw.max_output_chars == null
        ? null
        : clampInt(raw.maxOutputChars != null ? raw.maxOutputChars : raw.max_output_chars, 200, 20000, DEFAULT_MAX_OUTPUT_CHARS),
  };
}

/**
 * 解析配置（纯函数，可单测）。坏规则**不静默丢弃**：写进 `problems` 供审计/告警。
 * @param {any} cfg loadConfig 的产物
 */
function parseHooksConfig(cfg) {
  const c = cfg || {};
  const enabled = /^(1|true|yes|on)$/i.test(String(c['hooks.enabled'] || ''));
  /** @type {Array<any>} */
  const rules = [];
  /** @type {string[]} */
  const problems = [];
  const rawPost = c['hooks.post_tool_use'];
  let list = [];
  if (rawPost != null && String(rawPost).trim()) {
    const text = String(rawPost).trim();
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) list = parsed;
        else problems.push('hooks.post_tool_use 的 JSON 不是数组');
      } catch (error) {
        problems.push('hooks.post_tool_use 不是合法 JSON：' + String((error && error.message) || error));
      }
    } else {
      list = [text];
    }
  }
  list.forEach((item, i) => {
    const parsed = parseRule(item, 'rule-' + (i + 1));
    if (parsed.error) {
      problems.push('第 ' + (i + 1) + ' 条规则无效（' + parsed.error + '）');
      return;
    }
    rules.push(parsed);
  });
  const sessionStart = String(c['hooks.session_start'] || '').trim();
  const sessionStop = String(c['hooks.session_stop'] || '').trim();
  return {
    enabled: enabled && (rules.length > 0 || !!sessionStart || !!sessionStop),
    configured: enabled,
    rules,
    sessionStart,
    sessionStop,
    problems,
    timeoutMs: clampInt(c['hooks.timeout_ms'], 1000, 600000, DEFAULT_TIMEOUT_MS),
    maxOutputChars: clampInt(c['hooks.max_output_chars'], 200, 20000, DEFAULT_MAX_OUTPUT_CHARS),
    maxRuns: clampInt(c['hooks.max_runs'], 0, 100, DEFAULT_MAX_RUNS),
  };
}

/**
 * 匹配规则（纯函数）。`on` 是**结果导向**的：success 只在工具成功时跑、failure 只在失败时跑。
 * @param {Array<any>} rules
 * @param {{tool?: string, ok?: boolean}} call
 */
function matchRules(rules, call) {
  const tool = String((call && call.tool) || '');
  const ok = !!(call && call.ok);
  return (Array.isArray(rules) ? rules : []).filter((rule) => {
    if (!rule || !rule.command) return false;
    const hit = rule.tools.includes('*') || rule.tools.includes(tool);
    if (!hit) return false;
    if (rule.on === 'success') return ok;
    if (rule.on === 'failure') return !ok;
    return true;
  });
}

/**
 * 平台 shell 包装：钩子命令是给人写的（`npm run lint`），必须过 shell 才能跑。
 *
 * **为什么把命令写进临时脚本再执行**（实测踩到：这是唯一可行的写法）：
 * 直接把 `cmd /d /s /c "<整条命令>"` 当 argv 交给 spawn，Windows 下 Node 会把内层引号转义成 `\"`，
 * cmd 收到后既不执行也不报错 —— 表现是「退出码 0、零输出」，最坏的一种失败（看起来像跑过了）。
 * 写进 `.cmd` / `.sh` 文件再由 shell 执行时，argv 里只有一个无空格路径，引号这一类问题整体消失，
 * 命令原文（含引号、重定向、管道）也逐字保留。脚本落在 os.tmpdir()（默认 writeRoots 之内），完事即删。
 */
function shellSpec(command, dir) {
  const unique = 'hook-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  if (process.platform === 'win32') {
    const file = path.join(dir, unique + '.cmd');
    fs.writeFileSync(file, '@echo off' + '\r\n' + command + '\r\n', 'utf8');
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', file], script: file };
  }
  const file = path.join(dir, unique + '.sh');
  fs.writeFileSync(file, '#!/bin/sh\n' + command + '\n', { mode: 0o700 });
  return { file: '/bin/sh', args: [file], script: file };
}

/**
 * 跑一条钩子命令。
 * @param {{id?: string, command?: string, timeoutMs?: number|null, maxOutputChars?: number|null, tools?: string[], on?: string}} rule
 * @param {{projectRoot?: string|null, policy?: any, context?: any, signal?: any, defaults?: any}} deps
 * @returns {Promise<{ok: boolean, skipped: boolean, reason?: string, exitCode: number|null, output: string, timedOut: boolean, elapsedMs: number, truncated: boolean, command: string}>}
 */
async function runHook(rule, deps) {
  const d = deps || {};
  const defaults = d.defaults || {};
  const command = String((rule && rule.command) || '');
  const startedAt = Date.now();
  const base = {
    ok: false,
    skipped: false,
    exitCode: null,
    output: '',
    timedOut: false,
    elapsedMs: 0,
    truncated: false,
    command,
  };
  if (!command) return Object.assign(base, { skipped: true, reason: 'EMPTY_COMMAND' });
  const inRoot = path.resolve(d.projectRoot || '.');
  const policy = d.policy || null;
  // 1) 静态审计：与 execute_shell 同一套判据（越界写硬拒；断网时疑似联网硬拒）
  let guard = { outsideWrites: [], unresolvedWrites: [], network: [], reasons: [] };
  try {
    guard = shellGuard.analyzeShellCommand(command, {
      projectRoot: inRoot,
      writeRoots: policy && Array.isArray(policy.writeRoots) && policy.writeRoots.length ? policy.writeRoots : undefined,
    });
  } catch {
    guard = { outsideWrites: [], unresolvedWrites: [], network: [], reasons: [] };
  }
  if (guard.outsideWrites.length) {
    return Object.assign(base, { skipped: true, reason: 'OUT_OF_ROOT: ' + guard.outsideWrites.join(', '), elapsedMs: Date.now() - startedAt });
  }
  if (policy && policy.network === 'deny' && guard.network.length) {
    return Object.assign(base, { skipped: true, reason: 'NETWORK_DENIED: ' + guard.network.join('、'), elapsedMs: Date.now() - startedAt });
  }
  // 未解析写目标不拒绝（钩子命令是用户写的、静默信任级别与 execute_shell 的确认不同）—— 但如实带进结果里
  if (guard.unresolvedWrites.length) base.truncated = false;

  // 2) 真正的执行：与 execute_shell 同一条隔离通道 + 输出收集器（复用它，避免两套截断口径）
  const timeoutMs = clampInt(rule && rule.timeoutMs, 1000, 600000, clampInt(defaults.timeoutMs, 1000, 600000, DEFAULT_TIMEOUT_MS));
  const maxChars = clampInt(rule && rule.maxOutputChars, 200, 20000, clampInt(defaults.maxOutputChars, 200, 20000, DEFAULT_MAX_OUTPUT_CHARS));
  const env = safeEnvironment({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  const collected = shellTool.makeOutputCollector();
  let child = null;
  let timedOut = false;
  /** @type {any} */
  let spawnError = null;
  /** @type {any} */
  let spec = null;
  try {
    spec = shellSpec(command, os.tmpdir());
    child = sandbox.guardedSpawn({ file: spec.file, args: spec.args }, shellTool.foregroundSpawnOptions(inRoot, env, policy, d.context));
  } catch (error) {
    if (spec && spec.script) {
      try {
        fs.unlinkSync(spec.script);
      } catch {}
    }
    return Object.assign(base, { reason: 'SPAWN_FAILED: ' + String((error && error.message) || error), elapsedMs: Date.now() - startedAt });
  }
  const exitCode = await new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      // 超时后**不是**立刻返回：给被杀的子进程一点时间把已有的输出吐完（否则会丢日志）
      setTimeout(() => finish(null), 200);
    }, timeoutMs);
    child.stdout.on('data', (data) => shellTool.pushCollected(collected, String(data)));
    child.stderr.on('data', (data) => shellTool.pushCollected(collected, String(data)));
    child.on('error', (error) => {
      spawnError = error;
      finish(null);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : null));
    const signal = d.signal;
    if (signal && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        try {
          child.kill('SIGKILL');
        } catch {}
        finish(null);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  const text = shellTool.collectedText(collected);
  const truncated = text.length > maxChars;
  const output = truncated ? text.slice(0, maxChars) + '\n…（输出已截断，共 ' + text.length + ' 字符）' : text;
  if (spec && spec.script) {
    try {
      fs.unlinkSync(spec.script);
    } catch {}
  }
  return Object.assign(base, {
    ok: !timedOut && !spawnError && exitCode === 0,
    exitCode,
    output,
    truncated,
    timedOut,
    elapsedMs: Date.now() - startedAt,
    reason: spawnError ? 'SPAWN_FAILED: ' + String((spawnError && spawnError.message) || spawnError) : timedOut ? 'TIMEOUT' : undefined,
  });
}

/**
 * 渲染要注入的钩子消息（每条一段：命令 / 退出码 / 输出摘要）。
 * 单独成函数是为了让「发多少字出去」可单测（注入是**花上下文**的动作）。
 * @param {Array<{tool?: string, rule?: any, outcome?: any}>} results
 */
function renderHookNote(results) {
  const list = Array.isArray(results) ? results.filter((r) => r && r.outcome) : [];
  if (!list.length) return '';
  const parts = list.map((r) => {
    const o = r.outcome;
    const head = '· ' + (r.rule && r.rule.id ? r.rule.id : 'hook') + '（工具 ' + (r.tool || '?') + '）' + '：' + o.command;
    const state = o.skipped
      ? '未执行（' + (o.reason || 'SKIPPED') + '）'
      : o.timedOut
        ? '超时被杀（' + o.elapsedMs + 'ms）'
        : '退出码 ' + (o.exitCode == null ? 'null' : o.exitCode) + '，' + o.elapsedMs + 'ms';
    const body = String(o.output || '').trim();
    return head + '\n  ' + state + (body ? '\n  ' + body.replace(/\n/g, '\n  ') : '');
  });
  let text = HOOK_NOTE_PREFIX + list.length + ' 条）：\n' + parts.join('\n');
  if (text.length > MAX_NOTE_CHARS) text = text.slice(0, MAX_NOTE_CHARS) + '\n…（钩子报告已截断）';
  return text;
}

module.exports = {
  HOOK_NOTE_PREFIX,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_RUNS,
  MAX_NOTE_CHARS,
  parseRule,
  parseHooksConfig,
  matchRules,
  runHook,
  renderHookNote,
};
