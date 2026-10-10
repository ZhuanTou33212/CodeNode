'use strict';

// Render one stable Electron window, then resize the source image in a canvas before
// writing PNG-backed ICO entries. This avoids failures from repeatedly creating
// tiny offscreen BrowserWindows on Windows.
const { app, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, 'assets', 'branding', 'codenode-icon.png');
const OUTPUT_DIR = path.join(ROOT, 'build');
const OUTPUT = path.join(OUTPUT_DIR, 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
/** 只出 PNG、不进 ICO 的尺寸（ICO 规范上限 256）：electron-builder 的 Linux 目标要求 ≥256 的 PNG，
 *  512 是官方推荐值，源图 1254px 足够，不必放大。 */
const PNG_SIZES = [512];
/** 统一按 1024 渲染再下采样，保证 512 这类较大尺寸也清晰（DOM 里 <img> 的渲染尺寸即采样的源尺寸）。 */
const RENDER_SIZE = 1024;
// 源图 + 本脚本的指纹：图标渲染依赖平台（Windows/macOS/Linux 的缩放与抗锯齿不同），
// 因此"已提交的图标是否仍然有效"只能靠源指纹判断，不能靠每次重建（那会让每次
// npm run build 都改写 8 个已入库的二进制文件，把工作区弄脏）。
const MANIFEST = path.join(OUTPUT_DIR, '.icon-source.sha256');

function makeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(images.length * 16);
  const payloads = [];
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    const dimension = image.size === 256 ? 0 : image.size;
    directory.writeUInt8(dimension, entry);
    directory.writeUInt8(dimension, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    payloads.push(image.data);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...payloads]);
}

/**
 * 无头安全分支：Linux 上没有 DISPLAY/WAYLAND_DISPLAY 时 Electron 无法创建窗口，
 * 图标重建必然失败。此时显式跳过并说明原因（build/icon.ico 使用仓库已提交版本，打包不受影响），
 * 避免 CI 里出现「Electron 崩溃式的假失败」。需要强制在无头环境重建时用：
 *   xvfb-run -a npm run icons:build          （推荐，CI 里就是这样跑的）
 *   CODENODE_ICON_REQUIRE_HEADLESS=1 npm run icons:build
 */
function headlessLinuxWithoutDisplay() {
  if (process.platform !== 'linux') return false;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return false;
  return process.env.CODENODE_ICON_REQUIRE_HEADLESS !== '1';
}

/** 源图 + 脚本的指纹（见 MANIFEST 注释）。脚本内容按 LF 归一化后再入哈希：
 *  否则 Windows 工作区（CRLF）算出的指纹与 CI 检出（LF）不一致，每次 CI 都会去重渲染。 */
function sourceFingerprint() {
  const script = fs.readFileSync(__filename, 'utf8').replace(/\r\n/g, '\n');

  return crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).update(script).digest('hex');
}

function outputsPresent() {
  if (!fs.existsSync(OUTPUT)) return false;
  return SIZES.concat(PNG_SIZES).every((size) => fs.existsSync(path.join(OUTPUT_DIR, `icon-${size}.png`)));
}

/**
 * 结束进程。
 *
 * 为什么要有这个函数：`require('electron')` 在 **electron 宿主里** 才有 app 对象；这个脚本被
 * `npm run build` 的 postbuild 以 `electron` 拉起时正常，但一旦被非 electron 宿主（或宿主里
 * `app` 拿不到）执行，直接 `app.quit()` 会抛 `Cannot read properties of undefined (reading 'quit')`
 * —— 那是「跳过重建」这条**正常路径**上的崩溃，会把整个 `dist:win`（连 electron-builder 都没跑到）
 * 一起带红。所以：有 app 就让它退出，没有就让事件循环自然结束。
 */
function quitApp() {
  try {
    if (app && typeof app.quit === 'function') app.quit();
  } catch {}
}

async function main() {
  if (!fs.existsSync(SOURCE)) throw new Error(`找不到图标源文件：${SOURCE}`);
  const fingerprint = sourceFingerprint();
  let previous = '';
  try {
    previous = fs.readFileSync(MANIFEST, 'utf8').trim();
  } catch {}
  const force = process.argv.includes('--force') || process.env.CODENODE_ICON_FORCE === '1';
  /**
   * 渲染用的临时 HTML 在**渲染之前**就写好，所以它必须在这里就登记好清理责任：
   * 之前的清理只写在「窗口建好之后」的 finally 里，于是「走到渲染前就退出」的分支（下面两条）
   * 会把 build/.icon-render.html 留在工作区里（实测踩到：非 electron 宿主跑一次 build 就多一个未跟踪文件）。
   */
  const htmlPath = path.join(OUTPUT_DIR, '.icon-render.html');
  const cleanupHtml = () => { try { fs.unlinkSync(htmlPath); } catch {} };
  try {
    return await renderIcons({ previous, fingerprint, force, htmlPath });
  } finally {
    cleanupHtml();
  }
}

async function renderIcons({ previous, fingerprint, force, htmlPath }) {
  if (!force && previous === fingerprint && outputsPresent()) {
    console.log(
      `[icons] 图标与源文件一致（指纹 ${fingerprint.slice(0, 12)}），跳过重建；` +
        '源图已改动或需要强制重建时用：npm run icons:build -- --force'
    );
    // 必须显式退出：Electron 主进程在加载后不会自行结束，否则 npm run build 会挂住。
    quitApp();
    return;
  }
  /**
   * 没有 app 对象 = **不是 electron 宿主**（例如设置了 ELECTRON_RUN_AS_NODE=1，或有人直接用
   * `node scripts/build-icon-v3.cjs` 跑）。此时渲染图标根本不可能：既没有 whenReady 也没有窗口。
   * 口径与「渲染失败」一致 —— 图标已存在就沿用已提交版本并如实提示，不把 npm run build / dist:win 带红。
   */
  if (!app || typeof app.whenReady !== 'function') {
    if (!outputsPresent()) throw new Error('没有可用的 electron 宿主，且仓库里也没有已提交的图标产物');
    console.warn('[icons] 跳过图标重建：当前不是 electron 宿主（app 不可用）。build/icon.ico 沿用仓库已提交版本；' +
      '需要重建时请用 `npm run icons:build`（electron 宿主），不要带 ELECTRON_RUN_AS_NODE=1。');
    return;
  }
  if (headlessLinuxWithoutDisplay()) {
    console.log(
      '[icons] 跳过图标重建：当前是无显示环境的 Linux（DISPLAY/WAYLAND_DISPLAY 均未设置），' +
        'Electron 无法创建渲染窗口。build/icon.ico 沿用仓库已提交版本；' +
        '如需重建请用 xvfb-run -a npm run icons:build，或设置 CODENODE_ICON_REQUIRE_HEADLESS=1 强制尝试。'
    );
    quitApp();
    return;
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const sourceUrl = pathToFileURL(SOURCE).href;
  fs.writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;width:${RENDER_SIZE}px;height:${RENDER_SIZE}px;overflow:hidden;background:transparent"><img id="icon" src="${sourceUrl}" width="${RENDER_SIZE}" height="${RENDER_SIZE}" style="display:block;width:${RENDER_SIZE}px;height:${RENDER_SIZE}px"></body></html>`, 'utf8');

  // Linux 容器里没有 setuid chrome-sandbox：Electron **进程启动阶段**就会 FATAL 退出，
  // 真正兜住它的是调用方的 ELECTRON_DISABLE_SANDBOX=1（CI 已配）；这里的开关只是同进程内的补充，
  // 万一走到这一步说明外层没设环境变量，本地无显示环境请显式带上。
  if (process.platform === 'linux' && (process.env.CI || process.env.ELECTRON_DISABLE_SANDBOX === '1')) {
    app.commandLine.appendSwitch('no-sandbox');
  }

  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    frame: false,
    resizable: false,
    transparent: true,
    width: RENDER_SIZE,
    height: RENDER_SIZE,
    useContentSize: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: false },
  });

  try {
    await window.loadFile(htmlPath);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const image = document.querySelector('#icon'); if (!image) return reject(new Error('图标图片元素不存在')); if (image.complete) resolve(); else image.addEventListener('load', resolve, { once: true }); })`);

    const images = [];
    for (const size of SIZES.concat(PNG_SIZES)) {
      const dataUrl = await window.webContents.executeJavaScript(`(() => {
        const image = document.querySelector('#icon');
        const canvas = document.createElement('canvas');
        canvas.width = ${size};
        canvas.height = ${size};
        const context = canvas.getContext('2d');
        context.clearRect(0, 0, ${size}, ${size});
        context.drawImage(image, 0, 0, ${size}, ${size});
        return canvas.toDataURL('image/png');
      })()`);
      const data = Buffer.from(String(dataUrl).split(',')[1], 'base64');
      fs.writeFileSync(path.join(OUTPUT_DIR, `icon-${size}.png`), data);
      images.push({ size, data });
    }

    fs.writeFileSync(OUTPUT, makeIco(images.filter((item) => item.size <= 256)));
    fs.writeFileSync(MANIFEST, fingerprint + '\n', 'utf8');
    console.log(`icon -> ${OUTPUT} (ICO: ${images.filter((item) => item.size <= 256).map((item) => item.size).join(', ')} px；PNG: ${PNG_SIZES.join(', ')} px)`);
  } catch (error) {
    // 渲染失败（如无显示环境 / 容器里 Electron 起不来）不该让整个 npm run build 挂掉：
    // 图标已存在就沿用已提交版本，源图变更后需要在有显示环境的机器上重建并提交。
    if (!outputsPresent()) throw error;
    console.warn('[icons] 重建失败，沿用已提交的图标：' + (error && error.message ? error.message : error));
  } finally {
    window.destroy();
    // 临时 HTML 由 main() 的外层 finally 统一清理（这里不再重复，避免两处清理责任重叠）
    quitApp();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  quitApp();
  process.exitCode = 1;
});
