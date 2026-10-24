// Headless screenshot harness: node tools/shot.js <url> <out.png> [timeoutMs]
// Drives system Chrome, waits for window.__SHOT_READY, captures 1920x1080,
// and reports console/page errors as JSON on stdout.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [url, out, timeoutArg] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/shot.js <url> <out.png> [timeoutMs]');
  process.exit(2);
}
const timeout = parseInt(timeoutArg || '45000', 10);

const errors = [];
const warnings = [];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--hide-scrollbars',
    '--mute-audio',
    '--enable-unsafe-swiftshader',
    '--window-size=1920,1080',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
    else if (msg.type() === 'warning') warnings.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(url, { waitUntil: 'networkidle0', timeout });
  let ready = true;
  try {
    await page.waitForFunction('window.__SHOT_READY === true', { timeout });
  } catch {
    ready = false;
  }
  const pageErrors = await page.evaluate('window.__PAGE_ERRORS || []');
  await page.screenshot({ path: out });
  console.log(JSON.stringify({ out, ready, errors: [...errors, ...pageErrors], warnings: warnings.slice(0, 5) }, null, 2));
  process.exitCode = errors.length || pageErrors.length || !ready ? 1 : 0;
} finally {
  await browser.close();
}
