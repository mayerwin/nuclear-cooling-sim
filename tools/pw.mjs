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
 *   PW_LOCK=<file> where the one-browser-at-a-time lock lives (default: the
 *                 system temp dir, fluidsim-browser.lock). The library's tree on
 *                 this machine uses the same default; both must agree.
 *   PW_NOLOCK=1   do not take that lock (for a tool that knows it is alone)
 *   PW_LABEL=<s>  what to write in the lock, so a waiter can name who has it
 */
import { existsSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, statSync } from 'node:fs';
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
// ---------------------------------------------------------------------------
// ONE HEADED BROWSER ON THIS MACHINE AT A TIME (the library's lock, its
// b8844f7, same default path). A headed, GPU-accelerated Chrome is SHARED
// STATE: this tree's ten-minute proof run died twice with "Target page,
// context or browser has been closed" while the library's session ran its own
// gate beside it. Not a shared profile (every launch makes its own
// playwright_chromiumdev_profile) and not one process killing another: the
// GPU. Two browsers rendering WebGL with the frame limiter off on one Intel Arc,
// and when its GPU process falls over it takes renderers with it. So the
// browser is taken under an advisory lock: a file with a pid and a timestamp,
// a wait for whoever holds it, a steal (said aloud) if the holder has been gone
// longer than the longest run either tree has. PW_NOLOCK=1 opts out.
// The lock below is the library's b163fd0 verbatim (label default apart):
// an absent lock is not a stale lock, every lock carries a token and nothing
// is unlinked without checking it, a steal re-reads before it unlinks, and a
// log beside the lock records every take, wait, steal and release. The
// b8844f7 copy read a MISSING lock as infinitely old and stole it, which is
// how a launch took the browser out from under a running gate at 20:28:54Z.
const LOCK = (process.env.PW_LOCK || (tmpdir().replace(/\\/g, '/') + '/fluidsim-browser.lock'));
const LOCK_STALE_MS = 20 * 60 * 1000;   // longer than the longest gate either tree runs

// AN ABSENT LOCK IS NOT A STALE LOCK. Returning Infinity for a file that is
// not there routed a MISSING lock into the steal branch below, and the steal
// branch then unlinked whatever was at the path: if another process had
// created its lock in the meantime, this one deleted it and took the browser
// out from under a run that was holding it properly. That is the defect that
// cost the consumer a gate at 20:28:54Z. Absent reads as -1 and means "try to
// create it again", which is the only correct response to a lock that is gone.
const lockAge = () => { try { return Date.now() - statSync(LOCK).mtimeMs; } catch (e) { return -1; } };
const lockText = () => { try { return readFileSync(LOCK, 'utf8').trim(); } catch (e) { return ''; } };

// EVERY LOCK CARRIES A TOKEN, and nothing is ever unlinked without checking
// that the token is still ours. Releasing by path alone means a process whose
// release runs late deletes the NEXT holder's lock, which is the same failure
// as the one above by a different route.
const TOKEN = 'pw-' + process.pid + '-' + Date.now().toString(36);
let held = false;

// A durable line per event, beside the lock, so two sessions on one machine
// can lay their logs side by side instead of comparing file mtimes after the
// fact. Appending cannot fail the run: a lock that cannot be logged is still a
// lock.
function note(what, extra) {
  const line = new Date().toISOString() + ' ' + what + ' ' + LABEL + (extra ? ' ' + extra : '') + '\n';
  try { const fd = openSync(LOCK + '.log', 'a'); writeSync(fd, line); closeSync(fd); } catch (e) { /* not fatal */ }
  return line.trim();
}

const LABEL = (process.env.PW_LABEL || 'sim') + ' pid ' + process.pid;

export async function takeLock() {
  if (process.env.PW_NOLOCK === '1') return;
  let announced = false;
  for (;;) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeSync(fd, LABEL + ' at ' + new Date().toISOString() + ' token ' + TOKEN + '\n');
      closeSync(fd);
      held = true;
      console.error('pw: browser taken by ' + LABEL);
      note('take', 'token ' + TOKEN);
      return;
    } catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
      const age = lockAge();
      // Gone between the create and the stat: not stale, just absent. Go
      // straight round and try to create it again.
      if (age < 0) continue;
      // A HOLDER THAT IS DEAD IS NOT COMING BACK, however young its lock: a
      // tool killed from outside (a stopped background task) never runs its
      // exit handler, and the next launch waited twenty minutes on a ghost.
      // The pid is in the lock; a signal of 0 asks the OS whether it exists.
      { const who0 = lockText(); const m = /pid (\d+)/.exec(who0); const pid = m ? Number(m[1]) : 0;
        let alive = true; if (pid && pid !== process.pid) { try { process.kill(pid, 0); } catch (e2) { alive = e2 && e2.code === 'EPERM'; } }
        if (pid && !alive && lockText() === who0) { console.error('pw: removing the lock of a dead holder (' + who0 + ')'); note('steal-dead', 'from ' + who0); try { unlinkSync(LOCK); } catch (e2) { /* gone */ } continue; } }
      if (age > LOCK_STALE_MS) {
        // Whoever had it is not coming back. Say so, because silently stealing
        // a lock is how a lock stops meaning anything, and unlink only the
        // EXACT file we judged stale: re-read it and check it has not been
        // replaced by a live one while we were deciding.
        const who = lockText();
        if (lockAge() > LOCK_STALE_MS && lockText() === who && who !== '') {
          console.error('pw: stealing a browser lock ' + Math.round(age / 1000) + ' s old (' + who + ')');
          note('steal', 'from ' + who);
          try { unlinkSync(LOCK); } catch (e2) { /* someone else got there first */ }
        }
        continue;
      }
      if (!announced) {
        announced = true;
        const who = lockText();
        console.error('pw: waiting for the browser, held by ' + (who || 'someone'));
        note('wait', 'for ' + (who || 'someone'));
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export function releaseLock() {
  if (!held) return;
  held = false;
  // ONLY IF IT IS STILL OURS. A release that runs late, after another process
  // has taken the lock, must not delete that process's lock.
  const who = lockText();
  if (who && who.indexOf(TOKEN) < 0) { note('release-skipped', 'lock now held by ' + who); return; }
  try { unlinkSync(LOCK); note('release'); } catch (e) { /* already gone */ }
}
// Whatever happens to this process, the next one should not wait twenty
// minutes for it.
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(sig, (arg) => {
    releaseLock();
    if (sig === 'uncaughtException') { console.error(arg); process.exit(1); }
    if (sig !== 'exit') process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

export const launch = async () => {
  await takeLock();
  const browser = await chromium.launch(launchOptions());
  // Release when the browser goes, however it goes, so a tool that forgets to
  // close still hands the machine back when it exits.
  browser.on('disconnected', releaseLock);
  const close = browser.close.bind(browser);
  browser.close = async (...a) => { try { return await close(...a); } finally { releaseLock(); } };
  return browser;
};
