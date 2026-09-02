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
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const what = process.argv[2] || 'all';
const OUT = 'docs/proof';
mkdirSync(OUT, { recursive: true });

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'];
const URL = 'http://127.0.0.1:8099/index.html';

// camera -> [outfile, crop box] (crop boxes are in the 1500x950 frame look.mjs makes)
const CAMS = {
  head:    [['F1_tracers', [400, 250, 1150, 800]], ['F6_junction', [400, 250, 1150, 800]], ['G4_no_rings', [400, 250, 1150, 800]]],
  turbine: [['F2_gradient', [380, 520, 1250, 800]], ['F10_outfall', [380, 520, 1250, 800]], ['F11_intake', [380, 520, 1250, 800]],
            ['G6_G7_condenser', [330, 380, 1250, 830]], ['G15_G16_turbine', [330, 60, 1150, 620]]],
  sump:    [['F3_condensate', [300, 150, 1250, 720]]],
  rpv:     [['F4_reactor', [450, 150, 1050, 850]]],
  dome:    [['F5_speeds', [330, 60, 1210, 830]], ['F7_feed', [330, 60, 1210, 830]], ['F8_feed_tank', [330, 60, 1210, 830]], ['G8_boiler_inlet', [330, 60, 1210, 830]]],
  pump:    [['F9_fluid_pump', [450, 300, 1100, 780]], ['G5_pump', [450, 300, 1100, 780]]],
  bay:     [['F12_sea', [300, 100, 1250, 850]]],
  back:    [['G1_G2_containment', [290, 60, 1220, 830]]],
  focusA:  [['G3_floor', [500, 560, 950, 830]], ['G13_no_bar', [290, 60, 1220, 830]], ['F9_fluid_unit', [290, 60, 1220, 830]]],
  tank:    [['G9_G10_tank', [290, 330, 1210, 790]]],
  outside: [['G11_vent', [300, 80, 700, 830]], ['G12_wall', [300, 80, 700, 830]]],
  side:    [['G14_bubbles', [290, 60, 1220, 830]]],
  focusB:  [['U1_desktop_passive', [0, 0, 1500, 950]]]
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

async function page(browser, vp = { width: 1500, height: 950 }, opts = {}) {
  const p = await browser.newPage(Object.assign({ viewport: vp, deviceScaleFactor: 1 }, opts));
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4000);
  return p;
}

async function specials() {
  const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
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
  await browser.close();
}

function cameras() {
  for (const cam of Object.keys(CAMS)) run('node', ['tools/look.mjs', cam]);
  const plan = [];
  for (const [cam, outs] of Object.entries(CAMS)) {
    for (const [name, box] of outs) plan.push({ src: `/tmp/look/${cam}.png`, out: `${OUT}/${name}.png`, box });
  }
  plan.push({ src: `${OUT}/G17_break_full.png`, out: `${OUT}/G17_break.png`, box: [440, 420, 860, 800] });
  writeFileSync('/tmp/proof-plan.json', JSON.stringify(plan));
  run('python3', ['-c', `
import json
from PIL import Image
for j in json.load(open('/tmp/proof-plan.json')):
    try:
        Image.open(j['src']).crop(tuple(j['box'])).save(j['out'])
    except Exception as e:
        print('skip', j['out'], e)
`]);
}

if (what === 'all' || what === 'specials') await specials();
if (what === 'all' || what === 'cameras') cameras();
if (existsSync('/tmp/check/phone-inside.png')) copyFileSync('/tmp/check/phone-inside.png', `${OUT}/U1_phone_inside_gate.png`);
console.log('proof written to', OUT);
