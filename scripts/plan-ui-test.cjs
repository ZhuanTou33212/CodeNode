/**
 * plan-ui-test.cjs —— 在**真实渲染进程**里验收「任务清单卡片」
 *
 * 为什么必须有这一层：主进程侧的用例（scripts/agent-plan-test.cjs 的 E 段）只能证明
 * 「kind:'plan' 增量发出去了」，证明不了：
 *   ① 卡片真的渲染出来了（DOM 存在、样式生效、位置在对话面板顶部）；
 *   ② 状态色阶/进度条/完成态这些**视觉语义**真的按计划走（不是只在 state 里存着）；
 *   ③ 没有计划时不留空壳（返回 null），未知状态不会渲染成空白步骤。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-plan-ui-'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await sleep(600);
    const result = await win.webContents.executeJavaScript(`(async () => {
      let step = 'start';
      try {
        const session = window.__codenodeSession;
        const project = window.__codenodeProject;
        const ui = window.__codenodeUi;
        if (!session || !project) return { error: 'stores unavailable' };
        const waitFor = async (fn, ms) => {
          const deadline = Date.now() + (ms || 3000);
          while (Date.now() < deadline) {
            const v = fn();
            if (v) return v;
            await new Promise((r) => setTimeout(r, 50));
          }
          return null;
        };

        step = 'loadRoot';
        await project.getState().loadRoot(${JSON.stringify(projectRoot)});
        await waitFor(() => document.querySelector('.side-panel'), 5000);
        if (ui) {
          ui.getState().setSideOpen(true);
          ui.getState().setSideTab('agent');
        }

        const out = {};

        // ① 没有计划：不留空壳
        step = 'empty';
        session.getState().reset();
        session.getState().startOnCurrent('');
        out.emptyCard = document.querySelectorAll('.ap-plan').length;

        // ② 走真实的增量分支（主进程发的就是这一条）
        step = 'planDelta';
        session.getState().streamDelta({
          kind: 'plan',
          runId: 'run-ui-1',
          updatedAt: new Date().toISOString(),
          items: [
            { id: 'read', step: '读 a.txt 并统计行数', acceptanceCriteria: '读取内容已核实', status: 'completed' },
            { id: 'write', step: '写 b.txt 的结论', acceptanceCriteria: '文件内容符合目标', status: 'in_progress' },
            { id: 'verify', step: '跑一次 npm run verify', acceptanceCriteria: '命令成功且无失败用例', status: 'pending', dependsOn: ['write'], ownerTaskId: 'verify-task-1' },
          ],
        });
        const card = await waitFor(() => document.querySelector('.ap-plan'), 3000);
        out.hasCard = !!card;
        out.items = card ? card.querySelectorAll('.ap-plan-item').length : 0;
        out.countText = card ? (card.querySelector('.ap-plan-count') || {}).textContent : '';
        out.states = card ? Array.from(card.querySelectorAll('.ap-plan-item')).map((li) => li.className) : [];
        out.statusTexts = card ? Array.from(card.querySelectorAll('.ap-plan-status')).map((s) => s.textContent) : [];
        out.dependencies = card ? Array.from(card.querySelectorAll('.ap-plan-dependencies')).map((s) => s.textContent) : [];
        out.owners = card ? Array.from(card.querySelectorAll('.ap-plan-owner')).map((s) => s.textContent) : [];
        out.barWidth = card && card.querySelector('.ap-plan-progress-bar') ? card.querySelector('.ap-plan-progress-bar').style.width : '';
        out.inAgentPane = !!document.querySelector('.sp-pane-agent .ap-plan');
        out.beforeBody = !!(card && card.nextElementSibling && card.nextElementSibling.classList.contains('ap-body'));
        const style = card ? getComputedStyle(card) : null;
        out.hasBorder = style ? style.borderTopWidth !== '0px' && style.borderTopStyle === 'solid' : false;
        out.radius = style ? style.borderTopLeftRadius : '';
        out.ariaLabel = card ? card.getAttribute('aria-label') : null;
        out.completedLineThrough = (() => {
          const done = card && card.querySelector('.ap-plan-item.st-completed .ap-plan-step');
          return done ? getComputedStyle(done).textDecorationLine : '';
        })();

        // ③ 全部完成 → is-done 态（进度条变成完成色）
        step = 'allDone';
        session.getState().streamDelta({
          kind: 'plan',
          runId: 'run-ui-1',
          updatedAt: new Date().toISOString(),
          items: [
            { step: '读 a.txt 并统计行数', status: 'completed' },
            { step: '写 b.txt 的结论', status: 'completed' },
          ],
        });
        const done = await waitFor(() => document.querySelector('.ap-plan.is-done'), 3000);
        out.doneClass = !!done;
        out.doneBarColor = done && done.querySelector('.ap-plan-progress-bar') ? getComputedStyle(done.querySelector('.ap-plan-progress-bar')).backgroundColor : '';
        // 注意：改完 store 要**等一次渲染**再读 DOM —— React 提交是异步的，
        // 同步读会读到上一版（第一次跑就是这样，三个断言全栽在时序上）
        session.getState().streamDelta({ kind: 'plan', runId: 'run-ui-1', updatedAt: new Date().toISOString(), items: [{ step: '未开始的一步', status: 'pending' }] });
        await waitFor(() => document.querySelector('.ap-plan') && !document.querySelector('.ap-plan.is-done'), 3000);
        out.pendingBarColor = (() => {
          const c = document.querySelector('.ap-plan');
          return c && c.querySelector('.ap-plan-progress-bar') ? getComputedStyle(c.querySelector('.ap-plan-progress-bar')).backgroundColor : '';
        })();
        out.pendingIsDone = !!document.querySelector('.ap-plan.is-done');

        // ④ 未知状态归一成 pending（不渲染空白步骤）；上游字段脏了也不炸
        step = 'dirty';
        session.getState().streamDelta({
          kind: 'plan',
          runId: 'run-ui-1',
          updatedAt: new Date().toISOString(),
          items: [{ step: '诡异状态', status: '乱写' }, null, { status: 'completed' }],
        });
        await waitFor(() => document.querySelectorAll('.ap-plan-item').length === 3, 3000);
        const dirty = document.querySelector('.ap-plan');
        out.dirtyStates = dirty ? Array.from(dirty.querySelectorAll('.ap-plan-item')).map((li) => li.className) : [];
        out.dirtySteps = dirty ? Array.from(dirty.querySelectorAll('.ap-plan-step')).map((s) => s.textContent) : [];
        out.storeStatuses = session.getState().plan.map((i) => i.status);

        step = 'stalledStatuses';
        session.getState().streamDelta({
          kind: 'plan', runId: 'run-ui-1', updatedAt: new Date().toISOString(),
          items: [
            { id: 'blocked', step: '等待接口权限', acceptanceCriteria: '接口调用成功', status: 'blocked', reason: '缺少测试凭据' },
            { id: 'cancelled', step: '已取消的优化', acceptanceCriteria: '不再执行', status: 'cancelled', reason: '用户改了方向' },
          ],
        });
        await waitFor(() => document.querySelectorAll('.ap-plan-item').length === 2, 3000);
        const stalled = document.querySelector('.ap-plan');
        out.stalledStatuses = stalled ? Array.from(stalled.querySelectorAll('.ap-plan-status')).map((s) => s.textContent) : [];
        out.stalledReasons = stalled ? Array.from(stalled.querySelectorAll('.ap-plan-reason')).map((s) => s.textContent) : [];

        // ⑤ 计划按画布会话隔离，非活动会话的增量不能覆盖当前卡片
        step = 'sessionIsolation';
        const firstSessionId = session.getState().activeId;
        session.getState().beginWorkSession('第二个会话');
        const secondSessionId = session.getState().activeId;
        out.secondSessionInitiallyEmpty = session.getState().plan === null;
        session.getState().streamDelta({
          kind: 'plan', sessionId: firstSessionId, runId: 'run-ui-first', updatedAt: new Date().toISOString(),
          items: [{ id: 'first', step: '第一个会话的任务', acceptanceCriteria: '结果已检查', status: 'pending' }],
        });
        out.inactivePlanHidden = session.getState().plan === null && !!session.getState().plansBySessionId[firstSessionId];
        session.getState().switchSession(firstSessionId);
        out.sessionPlanRestored = session.getState().plan?.[0]?.id === 'first';
        session.getState().beginPlanRun(secondSessionId);
        out.newRunClearsVisiblePlan = session.getState().plan === null;

        // ⑥ reset 清空计划（不留上一轮的清单）
        step = 'reset';
        session.getState().reset();
        await waitFor(() => document.querySelectorAll('.ap-plan').length === 0, 3000);
        out.afterReset = document.querySelectorAll('.ap-plan').length;
        out.storePlanAfterReset = session.getState().plan;

        return out;
      } catch (error) {
        return { error: String((error && error.stack) || error), step };
      }
    })()`);

    if (result && result.error) {
      console.log('FAIL  [plan-ui] 渲染进程脚本异常（step=' + result.step + '）：' + result.error);
      console.log('\nPLAN UI TEST: FAIL');
      app.exit(1);
      return;
    }

    let failures = 0;
    const check = (label, ok, detail) => {
      if (!ok) failures++;
      console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
    };

    check('[UI] 没有计划时不渲染卡片（不留空壳）', result.emptyCard === 0, String(result.emptyCard));
    check('[UI] 计划增量 → 卡片渲染出 3 步', result.hasCard === true && result.items === 3, JSON.stringify({ has: result.hasCard, items: result.items }));
    check('[UI] 头部显示完成进度与进行中项', String(result.countText).includes('1/3') && String(result.countText).includes('写 b.txt'), String(result.countText));
    check('[UI] 三种状态各自带类名（色阶靠它）', result.states.join('|') === 'ap-plan-item st-completed|ap-plan-item st-in_progress|ap-plan-item st-pending', JSON.stringify(result.states));
    check('[UI] 状态文案可读（已完成/进行中/待办）', result.statusTexts.join(',') === '已完成,进行中,待办', JSON.stringify(result.statusTexts));
    check('[UI] 显示步骤依赖关系', result.dependencies.join(',') === '前置步骤：write', JSON.stringify(result.dependencies));
    check('[UI] 显示负责该步骤的子代理任务', result.owners.join(',') === '子代理：verify-task-1', JSON.stringify(result.owners));
    check('[UI] 进度条按 1/3 计算宽度（33%）', String(result.barWidth).startsWith('33'), String(result.barWidth));
    check('[UI] 卡片在对话面板内、且在消息列表之上', result.inAgentPane === true && result.beforeBody === true, JSON.stringify({ inPane: result.inAgentPane, beforeBody: result.beforeBody }));
    check('[UI] 样式真的生效（边框 + 圆角）', result.hasBorder === true && parseFloat(String(result.radius)) > 0, JSON.stringify({ hasBorder: result.hasBorder, radius: result.radius }));
    check('[UI] 无障碍标注', result.ariaLabel === '任务清单', String(result.ariaLabel));
    check('[UI] 已完成项划掉（视觉语义，不只是数据）', String(result.completedLineThrough).includes('line-through'), String(result.completedLineThrough));

    check('[UI] 全部完成 → is-done 态', result.doneClass === true);
    check('[UI] 未完成态的进度条不是完成色（换色阶，不是同一色）', result.pendingIsDone === false && result.doneBarColor && result.pendingBarColor && result.doneBarColor !== result.pendingBarColor, JSON.stringify({ done: result.doneBarColor, pending: result.pendingBarColor, pendingIsDone: result.pendingIsDone }));

    check('[UI] 未知状态归一成 pending（不渲染空白步骤）', result.storeStatuses.join(',') === 'pending,pending,completed', JSON.stringify(result.storeStatuses));
    check('[UI] 脏输入不炸：3 条都渲染出来（null/缺 step 也被容错）', result.dirtySteps.length === 3 && result.dirtyStates.join('|') === 'ap-plan-item st-pending|ap-plan-item st-pending|ap-plan-item st-completed', JSON.stringify(result.dirtySteps));
    check('[UI] 受阻/取消状态和原因都清楚展示', result.stalledStatuses.join(',') === '受阻,已取消' && result.stalledReasons.length === 2, JSON.stringify({ statuses: result.stalledStatuses, reasons: result.stalledReasons }));

    check('[UI] 新会话没有旧计划卡', result.secondSessionInitiallyEmpty === true);
    check('[UI] 后台旧会话计划只更新归属会话，不覆盖当前卡片', result.inactivePlanHidden === true);
    check('[UI] 切回画布会话能恢复它自己的计划', result.sessionPlanRestored === true);
    check('[UI] 新 Run 开始时先清掉当前卡片的旧任务计划', result.newRunClearsVisiblePlan === true);

    check('[UI] reset 后卡片消失、store 里的计划也清空', result.afterReset === 0 && result.afterReset === 0 && result.storePlanAfterReset === null, JSON.stringify({ afterReset: result.afterReset, plan: result.storePlanAfterReset }));

    console.log('\n' + (failures === 0 ? 'PLAN UI TEST: PASS' : 'PLAN UI TEST: FAIL (' + failures + ')'));
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
    app.exit(failures === 0 ? 0 : 1);
  } catch (error) {
    console.error('PLAN UI TEST: FAIL');
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  }
});
