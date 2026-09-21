/**
 * intent-ui-test.cjs —— 在**真实渲染进程**里验收「意图识别标」
 *
 * 为什么必须有这一层：`scripts/intent-test.cjs` 只能证明主进程算得对、增量发得出去，
 * 证明不了：① 标真的渲染出来（DOM/样式/位置）；② 「高风险 → 收紧」这类**视觉语义**真的生效；
 * ③ 没有信号（unavailable）时不留空壳 —— 那是最容易被写成「显示一个 未判定」的地方。
 *
 * 跑法：`npm run test:intent-ui`（要先 vite build）。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-intent-ui-'));

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
        session.getState().reset();
        session.getState().startOnCurrent('');
        const out = {};

        // ① 没有判定 → 不留空壳（也不显示「未判定」这种假结论）
        step = 'empty';
        out.emptyBadge = document.querySelectorAll('.ap-intent').length;

        // ② 正常判定（低风险 + 已授权，不收紧）
        step = 'normal';
        session.getState().streamDelta({
          kind: 'intent',
          runId: 'run-intent-ui',
          intent: 'code',
          risk: 'low',
          authorization: 'high',
          confidence: 0.95,
          source: 'model',
          routeHint: null,
          tighten: false,
          reason: '用户明确要求改本地源码并跑测试',
        });
        const badge = await waitFor(() => document.querySelector('.ap-intent'), 3000);
        out.hasBadge = !!badge;
        out.valueText = badge ? (badge.querySelector('.ap-intent-value') || {}).textContent : '';
        out.chipTexts = badge ? Array.from(badge.querySelectorAll('.ap-intent-chip')).map((c) => c.textContent) : [];
        out.confText = badge ? (badge.querySelector('.ap-intent-conf') || {}).textContent : '';
        out.tightenClass = badge ? badge.classList.contains('is-tighten') : null;
        out.tightenText = badge ? (badge.querySelector('.ap-intent-tighten') || {}).textContent || '' : '';
        out.title = badge ? badge.getAttribute('title') : '';
        out.ariaLabel = badge ? badge.getAttribute('aria-label') : null;
        out.inAgentPane = !!document.querySelector('.sp-pane-agent .ap-intent');
        out.beforeBody = !!(badge && badge.nextElementSibling && badge.nextElementSibling.classList.contains('ap-body'));
        const style = badge ? getComputedStyle(badge) : null;
        out.hasBorder = style ? style.borderTopWidth !== '0px' && style.borderTopStyle === 'solid' : false;
        out.radius = style ? style.borderTopLeftRadius : '';
        out.fontSize = style ? style.fontSize : '';
        out.lowRiskColor = badge && badge.querySelector('.ap-intent-chip') ? getComputedStyle(badge.querySelector('.ap-intent-chip')).color : '';

        // ③ 高风险 + 收紧 → 视觉可辨（类名 + 文案 + 颜色与低风险不同）
        step = 'tighten';
        session.getState().streamDelta({
          kind: 'intent',
          runId: 'run-intent-ui',
          intent: 'ops',
          risk: 'high',
          authorization: 'unknown',
          confidence: 0.4,
          source: 'model',
          routeHint: null,
          tighten: true,
          reason: '找不到用户授权这件事的证据，且动作不可逆',
        });
        const tight = await waitFor(() => document.querySelector('.ap-intent.is-tighten'), 3000);
        out.tightenClass2 = !!tight;
        out.tightenText2 = tight ? (tight.querySelector('.ap-intent-tighten') || {}).textContent || '' : '';
        out.highRiskColor = tight && tight.querySelector('.ap-intent-chip') ? getComputedStyle(tight.querySelector('.ap-intent-chip')).color : '';
        out.valueText2 = tight ? (tight.querySelector('.ap-intent-value') || {}).textContent : '';
        out.title2 = tight ? tight.getAttribute('title') : '';

        // ④ 没有信号（unavailable）→ 标消失（负向判据：不显示假结论、不留空壳）
        step = 'unavailable';
        session.getState().streamDelta({
          kind: 'intent',
          runId: 'run-intent-ui',
          intent: 'unknown',
          risk: 'unknown',
          authorization: 'unknown',
          confidence: 0,
          source: 'unavailable',
          tighten: false,
        });
        await waitFor(() => document.querySelectorAll('.ap-intent').length === 0, 3000);
        out.afterUnavailable = document.querySelectorAll('.ap-intent').length;

        // ⑤ 残缺输出自救（partial）→ 显式标注「输出不完整」，但不谎称是完整判定
        step = 'partial';
        session.getState().streamDelta({
          kind: 'intent',
          runId: 'run-intent-ui',
          intent: 'canvas',
          risk: 'low',
          authorization: 'high',
          confidence: 0.6,
          source: 'partial',
          routeHint: null,
          tighten: false,
          reason: '（输出不完整，已按字段自救：intent,risk,authorization）',
        });
        const partial = await waitFor(() => document.querySelector('.ap-intent .is-partial'), 3000);
        out.hasPartial = !!partial;
        out.partialText = partial ? partial.textContent : '';
        out.partialIntent = (() => {
          const b = document.querySelector('.ap-intent');
          return b ? (b.querySelector('.ap-intent-value') || {}).textContent : '';
        })();
        out.partialTighten = !!document.querySelector('.ap-intent.is-tighten');

        // ⑥ reset 清空（不留上一轮的判定）
        step = 'reset';
        session.getState().reset();
        await waitFor(() => document.querySelectorAll('.ap-intent').length === 0, 3000);
        out.afterReset = document.querySelectorAll('.ap-intent').length;
        out.storeAfterReset = session.getState().intentVerdict;

        return out;
      } catch (error) {
        return { error: String((error && error.stack) || error), step };
      }
    })()`);

    if (result && result.error) {
      console.log('FAIL  [intent-ui] 渲染进程脚本异常（step=' + result.step + '）：' + result.error);
      console.log('\nINTENT UI TEST: FAIL');
      app.exit(1);
      return;
    }

    let failures = 0;
    const check = (label, ok, detail) => {
      if (!ok) failures++;
      console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
    };

    check('[UI] 没有判定时不渲染标的空壳', result.emptyBadge === 0, String(result.emptyBadge));
    check('[UI] 意图增量 → 标渲染出来', result.hasBadge === true, String(result.hasBadge));
    check('[UI] 意图文案为中文语义（code → 代码改动）', result.valueText === '代码改动', String(result.valueText));
    check('[UI] 风险/授权各自成徽标且可读', JSON.stringify(result.chipTexts) === JSON.stringify(['低风险', '已获授权']), JSON.stringify(result.chipTexts));
    check('[UI] 置信度按百分比显示', String(result.confText).indexOf('95%') >= 0, String(result.confText));
    check('[UI] 不收紧时不显示「审批收紧」', result.tightenClass === false && result.tightenText === '', JSON.stringify({ cls: result.tightenClass, text: result.tightenText }));
    check('[UI] 标在对话面板内、在消息列表之上', result.inAgentPane === true && result.beforeBody === true, JSON.stringify({ inPane: result.inAgentPane, beforeBody: result.beforeBody }));
    check('[UI] 样式真的生效（边框 + 圆角 + 11px 密度）', result.hasBorder === true && parseFloat(String(result.radius)) > 0 && String(result.fontSize) === '11px', JSON.stringify({ border: result.hasBorder, radius: result.radius, fontSize: result.fontSize }));
    check('[UI] 无障碍标注 + 判据进 tooltip（用户能追「凭什么这么判」）', result.ariaLabel === '意图识别' && String(result.title).indexOf('判据：用户明确要求改本地源码并跑测试') >= 0, String(result.title).slice(0, 60));

    check('[UI] 高风险/授权不明 → 收紧态（类名 + 文案）', result.tightenClass2 === true && result.tightenText2 === '审批收紧', JSON.stringify({ cls: result.tightenClass2, text: result.tightenText2 }));
    check('[UI] 意图文案跟着判定变（ops → 运维操作）', result.valueText2 === '运维操作', String(result.valueText2));
    check('[UI] 高风险与低风险不是同一个颜色（色阶真的生效）', result.highRiskColor && result.lowRiskColor && result.highRiskColor !== result.lowRiskColor, JSON.stringify({ low: result.lowRiskColor, high: result.highRiskColor }));
    check('[UI] 收紧原因也进 tooltip', String(result.title2).indexOf('本轮已收紧') >= 0, String(result.title2).slice(0, 80));

    check('[UI] 没有信号（unavailable）→ 不显示任何结论（不留空壳、不假装未判定）', result.afterUnavailable === 0, String(result.afterUnavailable));

    check('[UI] 残缺自救（partial）→ 显式标注「输出不完整」', result.hasPartial === true && result.partialText === '输出不完整', JSON.stringify({ has: result.hasPartial, text: result.partialText }));
    check('[UI] partial 仍然显示救回的意图（canvas → 画布建模）', result.partialIntent === '画布建模', String(result.partialIntent));
    check('[UI] partial 不谎称收紧（低风险+已授权 → 无收紧标）', result.partialTighten === false);

    check('[UI] reset 后标消失、store 也清空', result.afterReset === 0 && result.storeAfterReset === null, JSON.stringify({ afterReset: result.afterReset, store: result.storeAfterReset }));

    console.log('\n' + (failures === 0 ? 'INTENT UI TEST: PASS' : 'INTENT UI TEST: FAIL (' + failures + ')'));
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
    app.exit(failures === 0 ? 0 : 1);
  } catch (error) {
    console.error('INTENT UI TEST: FAIL');
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  }
});
