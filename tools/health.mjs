// The solver's health through every scenario, as the app plays it: boots the
// app fresh per scenario, runs it at 1000x for WALL seconds, and prints per
// unit the steps taken, the steps that did not converge, the steps with a
// node at a bound, the worst iteration count, the mass adrift, and where
// the vessels stand. Usage: WALL=45 [DUMP=n] node health.mjs [scenario ...]
// DUMP=n prints the last n entries of each unit's trace ring (every 8th step).
// FAILS=n prints the reports of each unit's last n steps that did not
// converge, each with the report of the step before it.
// A scenario written as sbo:np runs with the passive systems disabled.
import { launch, URL } from './pw.mjs';
const WALL = Number(process.env.WALL || 45);
const DUMP = Number(process.env.DUMP || 0);
const FAILS = Number(process.env.FAILS || 0);
const TRACE = Number(process.env.TRACE || 8);
const ALL = ['normal', 'tsunami', 'sbo', 'loca', 'tmi', 'chernobyl', 'uhs', 'quake', 'fire', 'total'];
const scen = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const browser = await launch();
for (const id of scen) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(URL + (DUMP ? (URL.includes('?') ? '&' : '?') + 'trace=' + TRACE : ''), { waitUntil: 'load' });
  await page.waitForSelector('#startBtn', { timeout: 60000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('#startBtn')?.click());
  await page.evaluate(() => document.querySelector('[data-view=plant]').click());
  await page.evaluate(() => document.querySelector('#helpOk')?.click());
  await page.waitForFunction(() => window.__units && window.__units.length > 0 && window.__units[0].hydro && window.__units[0].hydro.steps > 0, null, { timeout: 60000 });
  await page.evaluate(() => document.querySelector('[data-focus=both]').click());
  await page.waitForTimeout(1500);
  // a scenario named with :np runs with the passive systems DISABLED (the
  // what-if checkbox), which is where the passive unit's vessel drains under
  // its own pool loop: the loop severed at the top, open at the bottom
  const np = id.endsWith(':np'), base = np ? id.slice(0, -3) : id;
  if (np) await page.evaluate(() => { const c = document.getElementById('tgSabotage'); if (c && !c.checked) c.click(); });
  await page.evaluate((x) => { const s = window.__sim; if (x !== 'normal') s.run(x); s.speedIdx = 4; }, base);
  await page.waitForTimeout(WALL * 1000);
  const r = await page.evaluate(([dump, fails]) => {
    const s = window.__sim;
    const f = (p) => `${p.state} lvl${(p.level * 100) | 0}% T${(p.Tclad - 273) | 0}C dmg${(p.coreDamage * 100) | 0}%`;
    s.speedIdx = 0;
    return { t: Math.round(s.t), plant: [f(s.active), f(s.passive)], units: window.__units.map((u) => {
      const h = u.hydro; if (!h || !h.solver) return { ok: false, failed: h && h.failed && h.failed.message };
      const S = h.solver, rep = h.report || {};
      const lv = (id) => { const v = S.volumes.find((x) => x.id === id); return v ? +v.level.toFixed(2) : null; };
      const fl = (id) => { const e = S.edge(id); return e ? Math.round(e.mdot) : null; };
      const fv = S.device('feed_valve');
      return { ok: h.ok, steps: h.steps, unconv: h.unconv || 0, bound: h.bound || 0, itMax: h.itMax || 0, adrift: Math.round(rep.massAdrift || 0),
        lastIt: rep.iters, lastConv: rep.converged, lastAb: rep.atBoundNode || '', shut: rep.shutEdge || '', isolated: !!h.isolated, fv: fv && +(+fv.open).toFixed(3), boundNodes: h.boundNodes || {}, trapped: rep.trapped || 0, trappedNode: rep.trappedNode || '', trappedSteps: h.trappedSteps || 0, trappedNodes: h.trappedNodes || {}, trappedNew: h.trappedNew || 0, subWantedMax: h.subWantedMax || 0, subCapped: h.subCapped || 0,
        lvl: { rpv: lv('rpv'), sg: lv('sg'), cond: lv('cond'), pool: lv('pool'), tank: lv('tank'), sump: lv('sump') },
        flow: { hot: fl('hot'), steam: fl('steam'), feed: fl('feed'), prhr: fl('prhr_up'), grav: fl('gravity'), inj: fl('injection'), vent: fl('vent'), fill: fl('fill'), cw: fl('cw_disch') },
        fails: fails ? (h.fails || []).slice(-fails) : [],
        dump: dump ? (h.trace || []).slice(-dump).map((x) => [x.k, x.c, x.it, x.sh || '-', x.ab || '-', x.sgm, x.sdm, x.cdm, x.cdl, x.stm, x.fd, x.fo, x.mk, x.rL, x.rM, x.hot]) : [] };
    }) };
  }, [DUMP, FAILS]);
  console.log(`== ${id}  t=${r.t}s  A: ${r.plant[0]}  B: ${r.plant[1]}${errs.length ? '  ERRORS ' + errs.slice(0, 3).join(' | ') : ''}`);
  r.units.forEach((u, i) => console.log(`   ${i ? 'B' : 'A'} ` + (u.ok ? `steps ${u.steps} unconv ${u.unconv} bound ${u.bound} itMax ${u.itMax} adrift ${u.adrift} kg | last it ${u.lastIt} conv ${u.lastConv} ab ${u.lastAb || '-'} shut ${u.shut || '-'} iso ${u.isolated ? 1 : 0} fv ${u.fv} bounds ${JSON.stringify(u.boundNodes)} trapped ${u.trappedSteps} ${JSON.stringify(u.trappedNodes)} new ${u.trappedNew} sub wanted ${u.subWantedMax} capped ${u.subCapped} | lvl ${JSON.stringify(u.lvl)} | flow ${JSON.stringify(u.flow)}` : `NOT OK ${u.failed}`)));
  if (FAILS) r.units.forEach((u, i) => (u.fails || []).forEach((f) => { console.log(`      ${i ? 'B' : 'A'} before: ${JSON.stringify(f.prev)}`); console.log(`      ${i ? 'B' : 'A'} FAILED: ${JSON.stringify(f.fail)}`); }));
  if (DUMP) r.units.forEach((u, i) => (u.dump || []).forEach((x) => console.log(`      ${i ? 'B' : 'A'} k ${x[0]} c ${x[1]} it ${x[2]} sh ${x[3]} ab ${x[4]} | sg ${x[5]} sgd ${x[6]} cond ${x[7]} lvl ${x[8]} | stm ${x[9]} fd ${x[10]} fo ${x[11]} mk ${x[12]} | rpv ${x[13]} ${x[14]} hot ${x[15]}`)));
  await page.close();
}
await browser.close();
