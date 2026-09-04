/* tools/proof.mjs - capture the proof screenshots the requirements register
 * points at, from the build as it stands right now.
 *
 *   node tools/proof.mjs            # everything
 *   node tools/proof.mjs cameras    # only the look.mjs cameras + crops
 *   node tools/proof.mjs specials   # only the welcome / settings / WASD / break shots
 *
 * Writes docs/proof/*.png. Every image the register shows comes from here, so
 * the register can only ever claim what the current build actually draws.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { launch, TMP, GPU, PYTHON, URL } from './pw.mjs';

const what = process.argv[2] || 'all';
const OUT = 'docs/proof';
mkdirSync(OUT, { recursive: true });


// camera -> [outfile, crop box] (crop boxes are in the 1500x950 frame look.mjs makes)
const CAMS = {
  head:    [['F1_tracers', [400, 250, 1150, 800]], ['F6_junction', [400, 250, 1150, 800]], ['G4_no_rings', [400, 250, 1150, 800]]],
  turbine: [['F2_gradient', [560, 380, 1220, 830]], ['F10_outfall', [560, 380, 1220, 830]], ['F11_intake', [560, 380, 1220, 830]],
            ['G6_G7_condenser', [560, 380, 1220, 830]], ['G15_G16_turbine', [290, 60, 1220, 830]],
            ['G18_exhaust_condenser', [290, 60, 1220, 830]]],
  sump:    [['F3_condensate', [300, 150, 1250, 720]]],
  rpv:     [['F4_reactor', [450, 150, 1050, 850]]],
  dome:    [['F5_speeds', [330, 60, 1210, 830]], ['F7_feed', [330, 60, 1210, 830]], ['F8_feed_tank', [330, 60, 1210, 830]], ['G8_boiler_inlet', [330, 60, 1210, 830]]],
  pump:    [['F9_fluid_pump', [450, 300, 1100, 780]], ['G5_pump', [450, 300, 1100, 780]]],
  bay:     [['F12_sea', [300, 100, 1250, 850]]],
  back:    [['G1_G2_containment', [290, 60, 1220, 830]]],
  focusA:  [['G3_floor', [500, 560, 950, 830]], ['G13_no_bar', [290, 60, 1220, 830]], ['F9_fluid_unit', [290, 60, 1220, 830]]],
  tank:    [['G9_G10_tank', [290, 330, 1210, 790]]],
  outside: [['G11_vent', [300, 80, 700, 830]], ['G12_wall', [300, 80, 700, 830]],
            ['F13_engine_loop', [290, 60, 1220, 830]]],
  side:    [['G14_bubbles', [290, 60, 1220, 830]]],
  focusB:  [['U1_desktop_passive', [0, 0, 1500, 950]]],
  // A key may carry a scenario and a time in plant minutes, as look.mjs takes
  // them; the screenshot is then named camera-scenario.
  // from outside and above: the tank camera stands under the flood at this
  // hour and sees nothing but water
  'outside tsunami 55':  [['S1_flood', [290, 380, 1000, 830]]],
  'breachsky chernobyl 12': [['S2_breach', [290, 60, 1220, 830]]]
};
CAMS.turbine.push(['F13_engine_turbine', [560, 380, 1220, 830]]);
// The second review: boiler, reactor, turbine exhaust, condenser, sea water.
CAMS.sg = [['G19_boiler_steam', [480, 60, 1100, 560]]];
CAMS.unit = (CAMS.unit || []).concat([['G20_feed_route', [290, 60, 1220, 830]]]);
CAMS.head.push(['G21_head_nozzles', [300, 200, 1250, 830]]);
CAMS.rpv.push(['G22_reactor_interior', [450, 150, 1050, 850]]);
CAMS.turbine.push(['G23_funnel', [290, 60, 1220, 830]]);
CAMS.cond = [['G24_condenser', [290, 60, 1220, 830]]];
CAMS.bay = [['G25_sea_circuit', [200, 200, 1300, 830]]];
// The third review: the exhaust pipe, the plates, the drops, glass fronts, seamless joins, captions.
CAMS.turbine.push(['G26_exhaust_pipe', [290, 60, 1220, 830]]);
CAMS.cond.push(['G27_plates_nozzles', [290, 60, 1220, 830]], ['G28_drops_in_shell', [290, 60, 1220, 830]]);
CAMS.focusAB = (CAMS.focusAB || []).concat([['G29_glass_fronts', [0, 0, 1500, 950]], ['U16_captions_both', [0, 0, 1500, 950]]]);
CAMS.head.push(['G30_seamless_head', [300, 200, 1250, 830]]);
CAMS.outside.push(['F14_primary_span', [290, 60, 1220, 830]]);

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: Object.assign({}, process.env, env || {}) });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}
// '/tmp/look/<camera>.png', or '<camera>-<scenario>.png' for a scenario shot
const shotOf = (spec) => {
  const [cam, scen] = spec.split(' ');
  return `${TMP}/look/${cam}${scen ? '-' + scen : ''}.png`;
};

async function page(browser, vp = { width: 1500, height: 950 }, opts = {}) {
  const p = await browser.newPage(Object.assign({ viewport: vp, deviceScaleFactor: 1 }, opts));
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4000);
  return p;
}

async function specials() {
  const browser = await launch();
  // U2: the welcome card, exactly as a visitor sees it
  let p = await page(browser);
  await p.screenshot({ path: `${OUT}/U2_welcome.png` });
  // U7: nothing built before Start
  const before = await p.evaluate(() => ({ stage: !!window.__stage, units: (window.__units || []).length }));
  await p.evaluate(() => document.querySelector('#startBtn').click());
  await p.waitForTimeout(5000);
  const after = await p.evaluate(() => ({ stage: !!window.__stage, units: (window.__units || []).length }));
  writeFileSync(`${OUT}/U7_lazy.txt`, `before Start: ${JSON.stringify(before)}\nafter Start:  ${JSON.stringify(after)}\n`);
  // U4: W A S D on the Site view - two frames with the keys held between them
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${OUT}/U4_wasd_before.png` });
  const cam0 = await p.evaluate(() => ({ x: window.__sim.cam.x, y: window.__sim.cam.y }));
  await p.keyboard.down('a'); await p.waitForTimeout(1200); await p.keyboard.up('a');
  await p.keyboard.down('w'); await p.waitForTimeout(1200); await p.keyboard.up('w');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/U4_wasd_after.png` });
  const cam1 = await p.evaluate(() => ({ x: window.__sim.cam.x, y: window.__sim.cam.y }));
  writeFileSync(`${OUT}/U4_wasd.txt`, `camera before: ${JSON.stringify(cam0)}\ncamera after A then W: ${JSON.stringify(cam1)}\n`);
  // U3: the settings panel
  await p.evaluate(() => document.querySelector('[data-view=plant]').click());
  await p.evaluate(() => document.querySelector('#helpOk')?.click());
  await p.waitForTimeout(6000);
  await p.evaluate(() => document.querySelector('#btnCfg').click());
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/U3_settings.png` });
  await p.evaluate(() => document.querySelector('#cfgOk').click());
  // G17: break the hot leg and look at the wound
  await p.evaluate(() => document.querySelector('[data-focus=active]').click());
  await p.waitForTimeout(14000);
  await p.evaluate(() => {
    const u = window.__units[0];
    const q = u.pipes.find((x) => x.kindBreak === 'primary');
    u.root.updateMatrixWorld(true);
    u.rupture(q, u.root.localToWorld(q.path.getPointAt(0.5).clone()));
    const s = window.__sim; s.speedIdx = 3; for (let i = 0; i < 200; i++) s.update(0.05);
  });
  await p.waitForTimeout(9000);
  await p.screenshot({ path: `${OUT}/G17_break_full.png` });
  await p.close();
  // U1: a phone, inside view
  p = await page(browser, { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await p.evaluate(() => document.querySelector('#startBtn').click());
  await p.waitForTimeout(4000);
  await p.evaluate(() => document.querySelector('[data-view=plant]').click());
  await p.evaluate(() => document.querySelector('#helpOk')?.click());
  await p.waitForTimeout(16000);
  await p.screenshot({ path: `${OUT}/U1_phone_inside.png` });
  await p.close();
  // D1: the help card as it first opens, with the link to this page on it
  p = await page(browser);
  await p.evaluate(() => document.querySelector('#startBtn').click());
  await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-view=plant]').click());
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${OUT}/D1_help_link.png`, clip: { x: 430, y: 180, width: 640, height: 300 } });
  // U12: every graphics option on, timed, on this build
  await p.evaluate(() => document.querySelector('#helpOk')?.click());
  await p.evaluate(() => { const s = window.__stage;
    for (const k of Object.keys(s.q)) s.setQuality(k, true); });
  await p.waitForTimeout(3000);
  // Timed by the gaps between animation frames, which is what a person sees.
  // Calling render() in a loop and timing it measures how fast the calls are
  // submitted, and on a GPU that is not the frame at all.
  const timing = async (label, secs) => {
    const r = await p.evaluate(async (secs) => {
      await new Promise((r) => requestAnimationFrame(r));
      const dts = []; let last = performance.now(); const t0 = last;
      await new Promise((res) => { const f = (t) => { dts.push(t - last); last = t;
        if (t - t0 < secs * 1000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
      const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
      const st = window.__stage.stats();
      return { ms: mean, calls: st.calls, px: st.px };
    }, secs);
    return `${label}: ${r.ms.toFixed(1)} ms/frame (${(1000 / r.ms).toFixed(0)} fps, ${r.calls} draws, ${r.px.toFixed(2)}x pixels)`;
  };
  const gpu = await p.evaluate(() => { const gl = window.__stage.renderer.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
  const secs = GPU ? 3 : 1;
  const allOn = await timing('every option on', secs);
  await p.evaluate(() => { const s = window.__stage; for (const k of ['refraction', 'bloom', 'shadows', 'hidpi']) s.setQuality(k, false); });
  await p.waitForTimeout(1500);
  const defaults = await timing('defaults', secs);
  await p.evaluate(() => { const s = window.__stage; for (const k of ['shadows', 'hidpi']) s.setQuality(k, true); });
  await p.waitForTimeout(1500);
  const desk = await timing('desktop defaults', secs);
  writeFileSync(`${OUT}/U12_allon.txt`,
    `${GPU ? 'GPU' : 'Software renderer (SwiftShader)'}: ${gpu}\n1500x950, vsync off, this build, ${new Date().toISOString().slice(0, 10)}.\n${allOn}\n${desk}\n${defaults}\n`);
  await browser.close();
}

function cameras() {
  // Captions off for the machine close-ups; on for the framed views, which
  // are partly about the captions.
  for (const spec of Object.keys(CAMS)) {
    run('node', ['tools/look.mjs', ...spec.split(' ')], { LABELS: spec.startsWith('focus') ? '1' : '0' });
  }
  // The plain pump shot is kept aside: the refraction shot below reuses its
  // camera and would otherwise overwrite it before the crops are cut.
  copyFileSync(`${TMP}/look/pump.png`, `${TMP}/look/pump-plain.png`);
  const plan = [];
  for (const [spec, outs] of Object.entries(CAMS)) {
    const src = spec === 'pump' ? `${TMP}/look/pump-plain.png` : shotOf(spec);
    for (const [name, box] of outs) plan.push({ src, out: `${OUT}/${name}.png`, box });
  }
  plan.push({ src: `${OUT}/G17_break_full.png`, out: `${OUT}/G17_break.png`, box: [440, 420, 860, 800] });
  // U10: the same pump with real refraction switched on. Taken last, because
  // it overwrites the plain pump shot the F9 and G5 crops were cut from.
  run('node', ['tools/look.mjs', 'pump'], { REFRACT: '1', LABELS: '0' });
  plan.push({ src: `${TMP}/look/pump.png`, out: `${OUT}/U10_refraction.png`, box: [450, 300, 1100, 780] });
  writeFileSync(`${TMP}/proof-plan.json`, JSON.stringify(plan));
  run(PYTHON[0], [...PYTHON.slice(1), '-c', `
import json
from PIL import Image
for j in json.load(open(r'${TMP}/proof-plan.json')):
    try:
        Image.open(j['src']).crop(tuple(j['box'])).save(j['out'])
    except Exception as e:
        print('skip', j['out'], e)
`]);
}

if (what === 'all' || what === 'specials') await specials();
if (what === 'all' || what === 'cameras') cameras();
if (existsSync(`${TMP}/check/phone-inside.png`)) copyFileSync(`${TMP}/check/phone-inside.png`, `${OUT}/U1_phone_inside_gate.png`);
console.log('proof written to', OUT);
