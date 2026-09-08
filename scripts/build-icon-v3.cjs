'use strict';

// Render one stable Electron window, then resize the source image in a canvas before
// writing PNG-backed ICO entries. This avoids failures from repeatedly creating
// tiny offscreen BrowserWindows on Windows.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'codenode-icon.png');
const OUTPUT_DIR = path.join(ROOT, 'build');
const OUTPUT = path.join(OUTPUT_DIR, 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

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

async function main() {
  if (!fs.existsSync(SOURCE)) throw new Error(`找不到图标源文件：${SOURCE}`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const htmlPath = path.join(OUTPUT_DIR, '.icon-render.html');
  const sourceUrl = pathToFileURL(SOURCE).href;
  fs.writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;width:256px;height:256px;overflow:hidden;background:transparent"><img id="icon" src="${sourceUrl}" width="256" height="256" style="display:block;width:256px;height:256px"></body></html>`, 'utf8');

  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    frame: false,
    resizable: false,
    transparent: true,
    width: 256,
    height: 256,
    useContentSize: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: false },
  });

  try {
    await window.loadFile(htmlPath);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const image = document.querySelector('#icon'); if (!image) return reject(new Error('图标图片元素不存在')); if (image.complete) resolve(); else image.addEventListener('load', resolve, { once: true }); })`);

    const images = [];
    for (const size of SIZES) {
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

    fs.writeFileSync(OUTPUT, makeIco(images));
    console.log(`icon -> ${OUTPUT} (${images.map((item) => item.size).join(', ')} px)`);
  } finally {
    window.destroy();
    try { fs.unlinkSync(htmlPath); } catch {}
    app.quit();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  try { app.quit(); } catch {}
  process.exitCode = 1;
});
