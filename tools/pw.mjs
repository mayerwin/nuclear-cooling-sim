/* tools/pw.mjs - the one place that knows where the browser is.
 *
 * The Linux box has playwright under /opt/node22 and a chromium under
 * /opt/pw-browsers, and renders on SwiftShader. Anywhere else, say where
 * things are:
 *
 *   PW_MODULE=<path to playwright's index.mjs>   (or any playwright the import can find)
 *   PW_CHROME=chrome | msedge | <path to a chrome binary>   (unset: the bundled chromium)
 *   PW_GPU=1      use the GPU instead of SwiftShader, with vsync off so frames are timed honestly
 *   PW_HEADED=1   show the window (a GPU on Windows needs it for some drivers)
 *   PW_TMP=<dir>  where /tmp/check and /tmp/look go (default: the system temp dir)
 *   PW_URL=<url>  the page (default http://127.0.0.1:8099/index.html)
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const LINUX_PW = '/opt/node22/lib/node_modules/playwright/index.mjs';
const LINUX_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export const TMP = process.env.PW_TMP || (process.platform === 'win32' ? tmpdir().replace(/\\/g, '/') : '/tmp');
export const GPU = process.env.PW_GPU === '1';
export const URL = process.env.PW_URL || 'http://127.0.0.1:8099/index.html';
// The interpreter that has PIL: python3 on the Linux box, the py launcher on Windows.
export const PYTHON = process.platform === 'win32' ? ['py', '-3'] : ['python3'];

async function load() {
  const tries = [];
  if (process.env.PW_MODULE) tries.push(process.env.PW_MODULE);
  if (existsSync(LINUX_PW)) tries.push(LINUX_PW);
  tries.push('playwright');
  let err = null;
  for (const t of tries) {
    try { return await import(/^([a-zA-Z]:)?[\\/]/.test(t) ? pathToFileURL(t).href : t); }
    catch (e) { err = e; }
  }
  throw new Error('playwright not found: set PW_MODULE to its index.mjs\n' + err);
}
export const { chromium } = await load();

// The launch options the tools share: SwiftShader by default, the GPU on request.
export function launchOptions() {
  const opts = { headless: process.env.PW_HEADED !== '1' };
  const c = process.env.PW_CHROME || (existsSync(LINUX_CHROME) ? LINUX_CHROME : '');
  if (/^(chrome|msedge|chromium)$/.test(c)) opts.channel = c;
  else if (c) opts.executablePath = c;
  opts.args = GPU
    ? ['--no-sandbox', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--enable-gpu-rasterization']
    : ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'];
  return opts;
}
export const launch = () => chromium.launch(launchOptions());
