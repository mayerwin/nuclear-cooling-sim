/* tools/reqpage.mjs - build docs/requirements.html from docs/requirements.json.
 *
 * The register of every piece of review feedback, as a page that can be read
 * online: filter by area, status and text, sort by any column, and a proof
 * screenshot on every line that claims to be done. A claim without a picture
 * does not get marked DONE; that is the whole point of the page.
 *
 *   node tools/reqpage.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const items = JSON.parse(readFileSync('docs/requirements.json', 'utf8'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const counts = items.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Requirements register</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1418; --card:#161d23; --line:#263038; --ink:#dfe7ee; --dim:#8fa0ad;
          --done:#3ddc84; --open:#ff7a59; --watch:#ffc857; }
  @media (prefers-color-scheme: light) { :root { --bg:#f4f6f8; --card:#fff; --line:#dbe2e8; --ink:#141a1f; --dim:#5b6b78; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:22px 28px 10px; }
  h1 { margin:0 0 4px; font-size:22px; letter-spacing:.2px; }
  .sub { color:var(--dim); }
  .tally span { display:inline-block; margin-right:14px; font-weight:600; }
  .tally .DONE { color:var(--done); } .tally .OPEN { color:var(--open); } .tally .WATCH { color:var(--watch); }
  .bar { display:flex; gap:10px; flex-wrap:wrap; padding:10px 28px 16px; position:sticky; top:0; background:var(--bg); z-index:2; border-bottom:1px solid var(--line); }
  .bar input, .bar select { background:var(--card); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit; }
  .bar input { min-width:260px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; vertical-align:top; padding:12px 14px; border-bottom:1px solid var(--line); }
  th { position:sticky; top:58px; background:var(--bg); cursor:pointer; user-select:none; color:var(--dim); font-weight:600; font-size:12px; letter-spacing:.06em; text-transform:uppercase; }
  th.on::after { content:" \\25BE"; } th.on.asc::after { content:" \\25B4"; }
  td.id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; color:var(--dim); }
  .st { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:700; letter-spacing:.04em; }
  .st.DONE { background:rgba(61,220,132,.16); color:var(--done); } .st.OPEN { background:rgba(255,122,89,.16); color:var(--open); } .st.WATCH { background:rgba(255,200,87,.16); color:var(--watch); }
  .req { font-weight:600; } .check { color:var(--dim); margin-top:4px; }
  .proof { display:flex; gap:8px; flex-wrap:wrap; }
  .proof a { display:block; }
  .proof img { height:96px; border-radius:6px; border:1px solid var(--line); background:#000; display:block; }
  .proof small { display:block; color:var(--dim); font-size:11px; max-width:170px; }
  .none { color:var(--open); font-size:12px; }
  .txt { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; color:var(--dim); white-space:pre-wrap; max-width:340px; background:var(--card); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
  tr.hide { display:none; }
  td.date { white-space:nowrap; color:var(--dim); }
</style>
</head>
<body>
<header>
  <h1>Requirements register</h1>
  <div class="sub">Every piece of review feedback on the visualisation, with the check that closes it and a screenshot as proof. Built ${esc(new Date().toISOString().slice(0, 10))} from <code>docs/requirements.json</code>.</div>
  <div class="tally">${['DONE', 'WATCH', 'OPEN'].map((k) => `<span class="${k}">${counts[k] || 0} ${k}</span>`).join('')}</div>
</header>
<div class="bar">
  <input id="q" placeholder="Filter text (requirement, check, id)">
  <select id="area"><option value="">All areas</option>${[...new Set(items.map((r) => r.area))].map((a) => `<option>${esc(a)}</option>`).join('')}</select>
  <select id="status"><option value="">All statuses</option><option>DONE</option><option>WATCH</option><option>OPEN</option></select>
</div>
<table id="t">
<thead><tr>
  <th data-k="id">Id</th><th data-k="area">Area</th><th data-k="req">Requirement</th>
  <th data-k="status">Status</th><th data-k="raised">Raised</th><th data-k="verified">Verified</th><th>Proof</th>
</tr></thead>
<tbody>
${items.map((r) => `<tr data-id="${esc(r.id)}" data-area="${esc(r.area)}" data-req="${esc(r.req)}" data-status="${esc(r.status)}" data-raised="${esc(r.raised)}" data-verified="${esc(r.verified || '')}" data-text="${esc((r.id + ' ' + r.area + ' ' + r.req + ' ' + (r.check || '')).toLowerCase())}">
  <td class="id">${esc(r.id)}</td>
  <td>${esc(r.area)}</td>
  <td><div class="req">${esc(r.req)}</div>${r.check ? `<div class="check">${esc(r.check)}</div>` : ''}</td>
  <td><span class="st ${esc(r.status)}">${esc(r.status)}</span></td>
  <td class="date">${esc(r.raised)}</td>
  <td class="date">${esc(r.verified || '')}</td>
  <td><div class="proof">${(r.proof || []).length
    ? r.proof.map((p) => p.img
      ? `<a href="${esc(p.img)}" target="_blank"><img src="${esc(p.img)}" alt="" loading="lazy"><small>${esc(p.caption || '')}</small></a>`
      : `<div class="txt">${esc(p.text || '')}</div>`).join('')
    : '<span class="none">no proof yet</span>'}</div></td>
</tr>`).join('\n')}
</tbody>
</table>
<script>
(() => {
  const rows = [...document.querySelectorAll('tbody tr')];
  const q = document.getElementById('q'), area = document.getElementById('area'), st = document.getElementById('status');
  const apply = () => {
    const s = q.value.trim().toLowerCase(), a = area.value, k = st.value;
    for (const r of rows) {
      const ok = (!s || r.dataset.text.includes(s)) && (!a || r.dataset.area === a) && (!k || r.dataset.status === k);
      r.classList.toggle('hide', !ok);
    }
  };
  for (const el of [q, area, st]) el.addEventListener('input', apply);
  let key = 'raised', asc = false;
  const tb = document.querySelector('tbody');
  const sort = () => {
    const order = { OPEN: 0, WATCH: 1, DONE: 2 };
    rows.sort((x, y) => {
      let a = x.dataset[key] || '', b = y.dataset[key] || '';
      if (key === 'status') { a = order[a]; b = order[b]; }
      if (a < b) return asc ? -1 : 1;
      if (a > b) return asc ? 1 : -1;
      return x.dataset.id < y.dataset.id ? -1 : 1;
    });
    for (const r of rows) tb.appendChild(r);
    for (const th of document.querySelectorAll('th[data-k]')) {
      th.classList.toggle('on', th.dataset.k === key);
      th.classList.toggle('asc', th.dataset.k === key && asc);
    }
  };
  for (const th of document.querySelectorAll('th[data-k]')) th.addEventListener('click', () => {
    if (key === th.dataset.k) asc = !asc; else { key = th.dataset.k; asc = true; }
    sort();
  });
  sort();
})();
</script>
</body>
</html>
`;
writeFileSync('docs/requirements.html', html);
console.log(`docs/requirements.html: ${items.length} requirements, ${JSON.stringify(counts)}`);
