/* tools/stamp.mjs - cache busting for a site with no build step.
 *
 * GitHub Pages serves js/*.js with a long max-age, so a returning visitor can
 * run last week's audio.js against this week's index.html and see no change at
 * all. Every internal module specifier gets ?v=<hash of all sources>, so one
 * changed byte changes every URL that could have been cached, and nothing
 * changes when nothing changed.
 *
 * THREE IS LEFT ALONE AND vendor/fluidsim IS NOT. Three is pinned by version
 * and never edited here; the fluid library is this project's own physics, kept
 * next door and copied in, and it changes whenever that library does. Left out
 * of the hash it was the one part of the app a returning visitor could keep a
 * stale copy of, and it is the part that decides what every circuit does.
 *
 *   node tools/stamp.mjs        stamp
 *   node tools/stamp.mjs --check  exit 1 if stamping would change anything
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');

function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}
const sources = walk('js').concat(walk('vendor/fluidsim'), ['css/app.css']);

// The hash is over the UNSTAMPED text, so re-running is idempotent, and over
// LF line endings, so a checkout with autocrlf on Windows stamps the same
// value as the Linux box.
const strip = (t) => t.replace(/\r\n/g, '\n').replace(/(\.(?:js|mjs|css))\?v=[0-9a-f]+/g, '$1');
const eol = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const h = createHash('sha256');
for (const f of sources.slice().sort()) h.update(strip(readFileSync(join(ROOT, f), 'utf8')));
const V = h.digest('hex').slice(0, 10);

let changed = [];
const put = (rel, text) => {
  const cur = readFileSync(join(ROOT, rel), 'utf8');
  // Written back with the line endings the file had.
  text = text.replace(/\n/g, eol(cur));
  if (cur === text) return;
  changed.push(rel);
  if (!check) writeFileSync(join(ROOT, rel), text);
};

// Relative module specifiers inside the app's own code.
for (const f of sources.filter((x) => /\.(js|mjs)$/.test(x))) {
  const t = strip(readFileSync(join(ROOT, f), 'utf8'));
  put(f, t.replace(/(from\s+|import\s*\()(['"])(\.[^'"]*?\.(?:js|mjs))\2/g,
    (m, a, q, spec) => (spec.includes('/vendor/') && !spec.includes('/vendor/fluidsim/')
      ? m : `${a}${q}${spec}?v=${V}${q}`)));
}

// The entry point, the stylesheet and the one exact import-map entry. The
// "three/addons/" prefix is left alone: a query on a prefix would land in the
// middle of the resolved URL.
let html = strip(readFileSync(join(ROOT, 'index.html'), 'utf8'));
html = html
  .replace(/(src=")(js\/main\.js)"/, `$1$2?v=${V}"`)
  .replace(/(href=")(css\/app\.css)"/, `$1$2?v=${V}"`);
put('index.html', html);

if (check && changed.length) {
  console.error('stamp out of date:', changed.join(', '));
  process.exit(1);
}
console.log(check ? `stamp ok (v=${V})` : `stamped v=${V} (${changed.length} files)`);
