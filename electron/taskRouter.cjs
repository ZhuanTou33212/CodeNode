'use strict';
/**
 * taskRouter.cjs —— 确定性任务路由（审计 P0-3 的「默认用确定性 TaskRouter」）。
 *
 * 它只回答两件事：
 *   1. `task`：这一轮大概是什么活（chat / code / canvas / research / orchestration / ops / unknown）；
 *   2. `ambiguous`：**确定性信号判不出来**（这时才值得花一次意图模型调用，见 `intent.shouldClassify`）。
 *
 * 职责边界（很关键，别扩）：
 *   - **工具面（profile）的权威仍是 `tools/profiles.cjs`**：本模块的 `task` 是**从它的结论派生**的
 *     （canvas/research/orchestration 三类直接读 `resolveToolProfiles()` 的结果），所以两个"路由器"
 *     不可能给出互相矛盾的结论 —— 这也是有意的：同一份知识只写一遍。
 *   - 本模块**不决定放行**（风险/授权一律走 descriptor + 静态分析 + 审批层）；
 *     也不产生任何副作用，纯函数、无 IO。
 *
 * 为什么 `ambiguous` 是这套设计的关键：分类模型唯一不可替代的价值是**处理歧义**
 * （画布层该不该救回来、这句话到底算什么活）。确定性信号能判的，就不要花钱再问一遍 ——
 * 审计的验收线是「普通代码 run 的 intent 调用平均 < 0.5 次」，靠的就是这里。
 */

const { resolveToolProfiles } = require('./tools/profiles.cjs');

/** 运维/环境类动作（core 面已含 execute_shell，所以这里只用于**观测**，不额外加面） */
const OPS_RE = /部署|发布|打包|构建|编译|安装|依赖|环境变量|进程|端口|服务|日志|定时|cron|docker|k8s|nginx|npm\s|pnpm\s|git\s|CI|流水线/i;
/**
 * 代码类信号（决定"这是代码活"而不是"闲聊"）。
 *
 * 口径要**宽**：判成 code 的代价只是"少问一次模型"（确定性通道本来就能决定工具面），
 * 而漏判的代价是每轮多花一次分类调用、还平白多一次超时可选项。所以文件后缀（含 .txt/.log 这类
 * 数据文件）、路径、camelCase/snake_case 标识符、以及"改/加/删/读/跑/测"这类动作词都算信号。
 * 注意 `\.\w` 只认**字母开头**的后缀：`0.5` 这种小数点不会被误判成文件（数字开头不算）。
 */
const CODE_RE =
  /代码|函数|类|方法|模块|文件|目录|报错|异常|堆栈|测试|用例|重构|实现|修复|改成|加个|新增|删掉|去掉|读取|写个|跑一下|执行|解释|审查|接口|字段|类型|变量|逻辑|依赖|版本|仓库|分支|提交|合并|冲突|配置|\b(bug|error|log|api|json|yaml|ini|env|function|class|method|variable|import|export|async|await|req|res|args|patch|build|deploy|test|refactor|fix|add|remove|rename|update)\b|\.[A-Za-z]\w{0,6}\b|[A-Za-z]:[\\/]|[\w.-]+\/[\w./-]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|_[a-z]/i;
/** 纯寒暄 / 极短输入：连"活"都算不上，不必分类 */
const CHAT_RE = /^(你好|您好|hi|hello|hey|谢谢|多谢|thanks?|thank you|在吗|嗨|早|晚安|ok|好的|收到)[!！。.~、\s]*$/i;

/** 任务类型枚举（进 run 事件 / 归因，便于事后回答"这次是什么活"） */
const TASKS = Object.freeze(['chat', 'code', 'canvas', 'research', 'orchestration', 'ops', 'unknown']);

/**
 * @param {{prompt?: string, canvas?: boolean, canvasSummary?: string, mode?: string}} [input]
 *   prompt        —— 用户这一轮的提问（判断信号只读它，外加画布层结论）
 *   canvas        —— `agent.resolvePromptLayers().canvas` 的结论（唯一来源，本模块不重判）
 *   canvasSummary —— 画布节点清单（用于区分"画布词命中"与"画布层被救回")
 * @returns {{task: string, ambiguous: boolean, profiles: string[], reason: string}}
 */
function routeTask(input = {}) {
  const i = input || {};
  const text = String(i.prompt == null ? '' : i.prompt).trim();
  // 工具面判定是**唯一来源**：本模块的 task 从它派生，保证两者不打架
  const face = resolveToolProfiles({ canvas: i.canvas === true, prompt: text });
  const profiles = Array.isArray(face.profiles) ? face.profiles : [];
  const summary = String(i.canvasSummary == null ? '' : i.canvasSummary).trim();
  const canvasEmpty = !summary || summary === '[]';

  if (profiles.includes('canvas')) {
    return { task: 'canvas', ambiguous: false, profiles, reason: i.canvas === true ? 'canvas-layer' : 'canvas-words' };
  }
  if (profiles.includes('research')) return { task: 'research', ambiguous: false, profiles, reason: 'research-words' };
  if (profiles.includes('orchestration')) return { task: 'orchestration', ambiguous: false, profiles, reason: 'orchestration-words' };
  if (!text || CHAT_RE.test(text)) return { task: 'chat', ambiguous: false, profiles, reason: 'small-talk' };
  if (OPS_RE.test(text)) return { task: 'ops', ambiguous: false, profiles, reason: 'ops-words' };
  if (CODE_RE.test(text)) return { task: 'code', ambiguous: false, profiles, reason: 'code-words' };
  /**
   * 什么信号都没有，而且不是寒暄（有实质长度）→ **歧义**：这才是"该不该救回画布层 / 到底算什么活"
   * 真的判不出来的场景，值得花一次小请求问模型。短而无信号的输入按 chat 处理（问了也是浪费）。
   */
  // 短且无信号（"继续" / "好的" / "帮我看看"）按寒暄处理：问了也改不了什么，纯浪费一次调用
  if (text.length >= 5) return { task: 'unknown', ambiguous: true, profiles, reason: 'no-signal' };
  return { task: 'chat', ambiguous: false, profiles, reason: 'small-talk' };
}

module.exports = { TASKS, OPS_RE, CODE_RE, CHAT_RE, routeTask };
