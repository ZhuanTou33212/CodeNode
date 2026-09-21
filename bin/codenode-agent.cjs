#!/usr/bin/env node
/**
 * codenode-agent —— 非交互（headless）入口：把 Agent 循环跑成一条命令
 *
 * 短板（对照文档 §5 #7）：此前 CodeNode 的 Agent 只能从 Electron 界面驱动
 * （评测脚本是直接 require harness，属于测试基建，不是产品入口）。于是
 * 「在 CI 里跑一次 Agent」「用脚本批量处理」「接进别的工具链」都做不到 ——
 * 而 Codex 有 `codex exec`、Claude Code 有 `claude -p`。
 *
 * 用法：
 *   codenode-agent --project E:\myproj --prompt "把 README 里的安装步骤补全"
 *   codenode-agent --project . --prompt-file task.md --allow-writes --json > result.jsonl
 *   echo "帮我看看构建为什么失败" | codenode-agent --project . --prompt -
 *
 * 参数：
 *   --project <dir>      项目根（默认当前目录）；配置读 <dir>/.codenode/agent.properties 与全局 config/agent.properties
 *   --prompt <text|->    任务文本；`-` 表示从 stdin 读
 *   --prompt-file <file> 从文件读任务文本
 *   --allow-writes       自动批准 WRITE 级确认（写文件/改画布）；默认**拒绝**（fail-closed）
 *   --yes                自动批准全部确认，含 HIGH（破坏性命令）—— 慎重使用
 *   --json               输出 JSON Lines（每行一个事件），便于机器消费
 *   --quiet              只输出最终回答
 *   --timeout <sec>      单轮总时长上限（默认取配置 agent.turn_timeout_ms）
 *   --max-iterations <n> 覆盖 agent.max_tool_iterations
 *   --help
 *
 * 退出码：0 正常结束｜1 run 失败或撞上限｜2 配置/凭据问题（含未配置 API Key）｜3 被取消
 *
 * 环境变量覆盖（优先级最高，方便 CI 注入而不落盘）：CODENODE_API_KEY / CODENODE_BASE_URL /
 * CODENODE_MODEL / CODENODE_MAX_TOKENS。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const agent = require(path.join(ROOT, 'electron', 'agent.cjs'));
const toolkit = require(path.join(ROOT, 'electron', 'tools', 'toolkit.cjs'));
const sandbox = require(path.join(ROOT, 'electron', 'sandbox.cjs'));
const runStore = require(path.join(ROOT, 'electron', 'runStore.cjs'));
const { AgentToolContext, ConfirmationLevel } = require(path.join(ROOT, 'electron', 'tools', 'context.cjs'));
const { RequestBudget } = require(path.join(ROOT, 'electron', 'requestBudget.cjs'));

function parseArgs(argv) {
  const args = { project: process.cwd(), prompt: null, promptFile: null, allowWrites: false, yes: false, json: false, quiet: false, timeout: null, maxIterations: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i + 1];
    if (a === '--project' || a === '-C') { args.project = next(); i += 1; }
    else if (a === '--prompt' || a === '-p') { args.prompt = next(); i += 1; }
    else if (a === '--prompt-file') { args.promptFile = next(); i += 1; }
    else if (a === '--allow-writes') args.allowWrites = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--json') args.json = true;
    else if (a === '--quiet' || a === '-q') args.quiet = true;
    else if (a === '--timeout') { args.timeout = Number(next()); i += 1; }
    else if (a === '--max-iterations') { args.maxIterations = Number(next()); i += 1; }
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) { args.error = '未知参数：' + a; }
  }
  return args;
}

const USAGE = [
  '用法：codenode-agent --project <dir> (--prompt <text|-> | --prompt-file <file>) [选项]',
  '',
  '选项：--allow-writes  自动批准 WRITE 级确认（默认拒绝，fail-closed）',
  '      --yes          自动批准全部确认（含 HIGH/破坏性，慎重）',
  '      --json         输出 JSON Lines 事件流',
  '      --quiet        只输出最终回答',
  '      --timeout <sec> / --max-iterations <n>',
  '',
  '退出码：0 正常｜1 run 失败或撞上限｜2 配置/凭据问题｜3 被取消',
].join('\n');

function readPrompt(args) {
  if (args.promptFile) {
    return fs.readFileSync(path.resolve(args.promptFile), 'utf8');
  }
  if (args.prompt === '-') {
    try {
      return fs.readFileSync(0, 'utf8');
    } catch {
      return '';
    }
  }
  return String(args.prompt || '');
}

function emit(args, event) {
  if (args.json) {
    process.stdout.write(JSON.stringify(event) + '\n');
    return;
  }
  if (args.quiet) return;
  if (event.kind === 'delta' && typeof event.text === 'string') {
    process.stdout.write(event.text);
    return;
  }
  if (event.kind === 'tool') {
    process.stderr.write('[tool] ' + event.name + ' ok=' + event.ok + (event.failed ? ' failed' : '') + '\n');
    return;
  }
  if (event.kind === 'tool_call') {
    // 调用意图（参数还在流式累积）——只提示「准备调用谁」，不下结论
    return;
  }
  if (event.kind === 'note') process.stderr.write(event.text + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(args.error + '\n\n' + USAGE + '\n');
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const projectRoot = path.resolve(args.project);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    process.stderr.write('项目目录不存在：' + projectRoot + '\n');
    return 2;
  }
  const prompt = readPrompt(args).trim();
  if (!prompt) {
    process.stderr.write('缺少任务文本（--prompt / --prompt-file / stdin）\n\n' + USAGE + '\n');
    return 2;
  }

  const cfg = agent.loadConfig(projectRoot);
  // 环境变量覆盖：CI 里注入凭据，不落盘（与 eval runner 的 env 口径一致）
  if (process.env.CODENODE_API_KEY) cfg.apiKey = process.env.CODENODE_API_KEY;
  if (process.env.CODENODE_BASE_URL) cfg.apiBase = process.env.CODENODE_BASE_URL;
  if (process.env.CODENODE_MODEL) cfg.model = process.env.CODENODE_MODEL;
  if (process.env.CODENODE_MAX_TOKENS) cfg.maxTokens = Number(process.env.CODENODE_MAX_TOKENS) || cfg.maxTokens;
  if (args.maxIterations) {
    cfg.limits = Object.assign({}, cfg.limits, { maxToolIterations: Math.max(1, Math.floor(args.maxIterations)) });
  }
  if (!cfg.apiKey) {
    // fail-closed：没有凭据就直接报错退出，绝不「静默跑空」
    process.stderr.write(
      '未配置 API Key：请设 CODENODE_API_KEY 环境变量，或在 ' + path.join(projectRoot, '.codenode', 'agent.properties') + ' / 全局 config/agent.properties 里配置 api_key\n',
    );
    return 2;
  }

  const sandboxPolicy = sandbox.resolvePolicy(cfg.sandbox, { projectRoot, userDataDir: path.join(projectRoot, '.codenode') });
  sandbox.setDefaultPolicy(sandboxPolicy);
  cfg.requestBudget = new RequestBudget(cfg.limits && cfg.limits.maxTotalTokens);
  const runId = runStore.normalizeRunId('run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
  cfg.costRunId = runId;

  const denied = [];
  /**
   * headless 下的确认策略（**fail-closed**）：
   * 无人值守时「弹出确认」不存在，所以默认一律拒绝；只有显式给了 --allow-writes / --yes 才放行对应级别。
   * 每次拒绝都打印一行 —— 用户能据此判断要不要加参数，而不是看到「莫名其妙没写进去」。
   */
  const confirm = async (level, what, detail) => {
    const lv = String(level || '').toUpperCase();
    const approved = args.yes === true || (args.allowWrites === true && lv === 'WRITE');
    if (!approved) {
      denied.push({ level: lv, what, detail });
      emit(args, { kind: 'note', text: '[confirm-denied] ' + lv + ' ' + what + (args.allowWrites ? '（--allow-writes 只放开 WRITE，HIGH 仍需 --yes）' : '（如需自动批准请加 --allow-writes / --yes）') });
    }
    return approved;
  };

  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot, ragEnabled: !!cfg.rag && cfg.rag.enabled !== false });
  const memory = require(path.join(ROOT, 'electron', 'memory.cjs'));
  const extensions = require(path.join(ROOT, 'electron', 'tools', 'extensions.cjs'));
  const userMemory = require(path.join(ROOT, 'electron', 'userMemory.cjs'));
  const context = new AgentToolContext({
    projectRoot,
    runId,
    confirm,
    askUser: async () => {
      emit(args, { kind: 'note', text: '[ask-user] 无人值守模式：按空回答处理（headless 不支持交互提问）' });
      return '';
    },
    audit: (entry) => {
      try {
        runStore.appendEvent(projectRoot, runId, 'audit', { entry: String(entry || '').slice(0, 2000) });
      } catch {}
    },
    sandbox: sandboxPolicy,
    signal: undefined,
  });

  const memoryText = memory.buildMemoryText(memory.readMemory(projectRoot).entries, prompt, { limit: 30 });
  const userMemoryText = userMemory.buildUserMemoryText(prompt, { limit: 20 });
  const skills = extensions.readManifest(projectRoot).filter((item) => String(item.kind || '').toLowerCase() === 'skills');
  const skillsText = skills.map((item) => '- ' + item.name + ': ' + (item.instructions || item.description || '按项目扩展定义执行')).join('\n');
  const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));
  const systemContent = agent.buildSystemPrompt(soul, '', agent.buildToolGuide(registry.listTools()), memoryText, skillsText, {
    prompt,
    userMemoryText,
    canvasMode: cfg.prompt && cfg.prompt.canvasRules,
  });

  runStore.startRun(projectRoot, runId, { prompt: prompt.slice(0, 4000), model: cfg.model, headless: true, sandbox: sandbox.describe(sandboxPolicy) });
  if (!args.json && !args.quiet) process.stderr.write('[codenode-agent] run=' + runId + ' project=' + projectRoot + ' model=' + cfg.model + '\n');

  let content = '';
  let result = null;
  try {
    result = await agent.runAgentChat({
      cfg,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: prompt },
      ],
      onDelta: (delta) => {
        if (!delta || !delta.kind) return;
        if (delta.kind === 'content' && typeof delta.text === 'string') {
          content += delta.text;
          emit(args, { kind: 'delta', text: delta.text });
        } else if (delta.kind === 'tool_result') {
          // 只认 tool_result：`kind:'tool'` 是**流式累积中的调用片段**（ok 还是假的），
          // 混在一起会打出「ok=false」的假失败行（第一版就是这样）
          const calls = delta.toolCalls || [];
          for (const c of calls) emit(args, { kind: 'tool', name: c && c.name, ok: !!(c && c.ok), failed: !!(c && c.failed) });
        } else if (delta.kind === 'tool') {
          const calls = delta.toolCalls || [];
          for (const c of calls) emit(args, { kind: 'tool_call', name: c && c.name });
        }
        if (args.json) emit(args, { kind: 'event', delta: Object.assign({}, delta) });
      },
      tools: { registry, context },
      signal: null,
      timeoutMs: args.timeout ? Math.max(10, Math.floor(args.timeout)) * 1000 : null,
    });
  } catch (error) {
    const message = String((error && error.message) || error);
    runStore.finishRun(projectRoot, runId, 'error', { error: message, headless: true });
    emit(args, { kind: 'error', error: message });
    process.stderr.write('[codenode-agent] 运行异常：' + message + '\n');
    return 1;
  }

  const finalText = String((result && result.content) || content || '');
  const state = (result && result.state) || null;
  const failed = !!(result && result.error) || (state && state !== 'COMPLETED');
  const status = state === 'COMPLETED' ? 'completed' : state === 'CANCELLED' ? 'cancelled' : state === 'LIMIT_REACHED' ? 'limit' : failed ? 'error' : 'completed';
  runStore.finishRun(projectRoot, runId, status === 'completed' ? 'completed' : status === 'limit' ? 'error' : status, {
    state,
    stopReason: (result && result.stopReason) || null,
    headless: true,
    usage: (result && result.usage) || null,
    error: (result && result.error) || null,
    deniedCount: denied.length,
  });

  if (args.json) {
    emit(args, { kind: 'result', runId, state, status, content: finalText, usage: (result && result.usage) || null, denied });
  } else if (args.quiet) {
    process.stdout.write(finalText + '\n');
  } else {
    process.stdout.write('\n');
    process.stderr.write('[codenode-agent] state=' + state + ' stopReason=' + ((result && result.stopReason) || '-') + ' denied=' + denied.length + ' run=' + runId + '\n');
  }
  if (state === 'CANCELLED') return 3;
  if (state === 'LIMIT_REACHED') return 1;
  if ((result && result.error) || (state && state !== 'COMPLETED')) return 1;
  return 0;
}

/**
 * 退出姿势（Windows 实测踩到）：**不要**直接 `process.exit()` —— 当有异步句柄正在关闭时
 * 强制退出会触发 libuv 断言 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，
 * 进程以 3221226505（0xC0000409）结束：功能已经正确完成，退出码却是崩溃码，
 * 在 CI 里就会被当成失败。做法：先设 `process.exitCode` 让事件循环自然排空（正常路径干净退出），
 * 再挂一个 **unref** 的兜底定时器，防止残留句柄（子进程/维护连接）把进程挂住。
 */
function finish(code) {
  process.exitCode = code;
  const timer = setTimeout(() => process.exit(code), 1000);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

main()
  .then((code) => finish(code))
  .catch((error) => {
    process.stderr.write('codenode-agent 内部错误：' + String((error && error.stack) || error) + '\n');
    finish(1);
  });
