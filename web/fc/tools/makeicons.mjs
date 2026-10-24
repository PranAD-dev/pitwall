// Rasterises icon.svg to the PNG sizes Android/Chrome want for a home-screen
// shortcut. Uses headless Chrome as the renderer, so there is no image-library
// dependency and the PNGs are byte-identical to what the browser would draw.
//
//   node tools/makeicons.mjs
//
// Produces: icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png,
//           icons/apple-touch-icon.png, favicon-32.png
//
// The maskable variant re-renders the art at 78% inside a full-bleed plate:
// Android crops icons to a circle/squircle, and anything outside the central
// safe zone gets sliced off.
import puppeteer from 'puppeteer-core';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(ROOT, 'icon.svg'), 'utf8');
mkdirSync(join(ROOT, 'icons'), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

async function render(size, { maskable = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  const inner = maskable
    ? `<div style="position:absolute;inset:0;background:#0a1120"></div>
       <div style="position:absolute;inset:11%">${svg}</div>`
    : svg;
  await page.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;background:transparent}
     body{width:${size}px;height:${size}px;position:relative;overflow:hidden}
     svg{width:100%;height:100%;display:block}</style>${inner}`,
    { waitUntil: 'load' }
  );
  const buf = await page.screenshot({ omitBackground: !maskable, type: 'png' });
  await page.close();
  return buf;
}

const jobs = [
  ['icons/icon-192.png', 192, {}],
  ['icons/icon-512.png', 512, {}],
  ['icons/icon-maskable-512.png', 512, { maskable: true }],
  ['icons/apple-touch-icon.png', 180, { maskable: true }],
  ['favicon-32.png', 32, {}],
];

for (const [out, size, opts] of jobs) {
  const buf = await render(size, opts);
  writeFileSync(join(ROOT, out), buf);
  console.log(`${out}  ${size}x${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}

await browser.close();
