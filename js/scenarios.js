// ---------------------------------------------------------------------------
// scenarios.js - historically grounded initiating events. Each one is applied
// to BOTH plants at the same instant; the only difference is how the two
// cooling philosophies answer it.
// ---------------------------------------------------------------------------

export const SCENARIOS = [
  {
    id: 'tsunami',
    name: 'Tsunami',
    icon: '🌊',
    ref: 'Fukushima Daiichi · 11 Mar 2011 · INES 7',
    lede: 'M9.0 quake knocks out all offsite power. 41 minutes later a 14–15 m wave overtops the 5.7 m seawall.',
    detail: `The reactors scrammed correctly and the emergency diesels started correctly.
      Then the wave drowned the diesels, the seawater intake pumps and the DC switchgear.
      all of them installed in basements at grade. Units 1–3 lost the ability to move heat
      to the sea. Cores uncovered, zirconium burned in steam, and hydrogen tore three
      reactor buildings apart.`,
    why: `Every active heat-removal path needs (a) electricity and (b) the sea as a heat sink.
      The wave took both in ninety seconds. A passive plant rejects decay heat to a tank of
      water sitting above the core and then to the air; there is no pump to drown, no diesel
      to flood, and no seawater intake in the loop for the first 72 hours.`,
    watch: `In the cutaway: POWER falls to the batteries and then to NONE, and the left
      pump stops. A steam-driven backup takes over there, and it runs on the reactor's own steam
      rather than the grid, for as long as the steam lasts. On the right the pool starts
      pouring in <em>because</em> the power died: those valves fail open.`,
    tsunami: { at: 2460, height: 14, speed: 3.2 },
    timeline: [
      { t: 0, msg: 'M9.0 earthquake: automatic scram, all four offsite lines lost', fn: (s, p) => { p.scram('seismic trip + loss of offsite power'); p.grid = false; p.quakeDamage = 0.15; } },
      { t: 8, msg: 'Emergency diesel generators start, buses re-energised', fn: (s, p) => { p.dieselsOk = true; } },
      { t: 2460, msg: '14 m tsunami overtops the 5.7 m seawall', fn: (s, p) => { p.flooded = 14; p.uhs = false; p.dieselsOk = false; p.pumpsOk = false; } },
      { t: 2480, msg: 'Seawater pumps, diesels and DC switchgear submerged. STATION BLACKOUT', fn: (s, p) => { p.battery = p.mode === 'passive' ? p.battery : 0.55; } },
      { t: 4000, msg: 'Seawater has receded; site is debris-strewn and inaccessible', fn: (s, p) => { p.operators = p.mode === 'passive'; } }
    ]
  },
  {
    id: 'sbo',
    name: 'Station Blackout',
    icon: '🔌',
    ref: 'Generic SBO · the dominant core-damage risk in every Gen-II PRA',
    lede: 'Grid collapse, then every emergency diesel fails to run. Nothing electrical is left but batteries.',
    detail: `Station blackout is the single largest contributor to core-damage frequency in
      Gen-II probabilistic risk assessments. Batteries buy 4–8 hours of instrumentation and
      steam-driven injection. After that, an active plant is on a countdown clock.`,
    why: `A passive plant's safety case does not contain the word "pump". Decay heat moves by
      density difference, gravity head and evaporation. These are physical processes that cannot be
      switched off, and that get *stronger* as the core gets hotter.`,
    watch: `In the cutaway: POWER reads NONE on both sides, and <em>both</em> loops keep
      creeping round on their own, because hot water rises, cool water sinks. The difference is where
      the heat goes next: the left boiler needs a pump to feed it, the right one hands the heat
      to the pool above the reactor.`,
    timeline: [
      { t: 0, msg: 'Grid disturbance: turbine trip and reactor scram', fn: (s, p) => { p.scram('turbine trip'); p.grid = false; } },
      { t: 30, msg: 'Diesel A fails to start (fuel-rack fault)', fn: (s, p) => { p.diesels = Math.max(0, p.diesels - 1); } },
      { t: 90, msg: 'Diesel B trips on high jacket temperature', fn: (s, p) => { p.diesels = Math.max(0, p.diesels - 1); } },
      { t: 240, msg: 'Last diesel fails. STATION BLACKOUT declared', fn: (s, p) => { p.diesels = 0; p.dieselsOk = false; p.pumpsOk = false; } }
    ]
  },
  {
    id: 'loca',
    name: 'Large-Break LOCA',
    icon: '💥',
    ref: 'Design-basis accident · double-ended guillotine break of a cold leg',
    lede: 'A main coolant pipe shears clean through. The primary system blows down to containment in 30 seconds.',
    detail: `The classic design-basis accident. Inventory is lost faster than any charging pump
      can replace it, so the answer has to be a large, fast, reliable flood of the core.`,
    why: `Gen-II answers with high-head safety-injection pumps on emergency diesels, of which three
      chained machines that all have to work. The passive answer is a valve that opens when
      power is <em>lost</em>, then 2,000 tonnes of borated water falling downhill into the vessel.`,
    watch: `In the cutaway: both reactors lose their water in seconds. Watch which one is
      still being refilled a minute later, and where that water is coming from.`,
    timeline: [
      { t: 0, msg: 'Double-ended guillotine break in a main coolant loop', fn: (s, p) => { p.scram('low pressuriser pressure'); p.leakRate = 260; p.pRPV = 1.2; } },
      { t: 40, msg: 'Blowdown complete: vessel at containment pressure', fn: (s, p) => { p.leakRate = 55; } },
      { t: 120, msg: 'Emergency diesel 2 fails to load (single-failure criterion)', fn: (s, p) => { p.diesels = Math.max(0, p.diesels - 1); if (p.mode === 'active') { p.grid = false; p.dieselsOk = p.diesels > 0; } } },
      { t: 300, msg: 'Remaining safety-injection train trips on cavitation', fn: (s, p) => { if (p.mode === 'active') p.pumpsOk = false; } }
    ]
  },
  {
    id: 'tmi',
    name: 'Stuck Valve + Operators',
    icon: '🎛️',
    ref: 'Three Mile Island Unit 2 · 28 Mar 1979 · INES 5',
    lede: 'A relief valve sticks open, the instrument says "closed", and the crew throttles back the emergency injection.',
    detail: `TMI-2 was not destroyed by a big pipe break. It was destroyed by a small one the
      crew could not see, plus a control room that told them the core was full while half of
      it was uncovering. Roughly 45% of the core melted in about 140 minutes.`,
    why: `Passive systems are actuated by physics, not by a diagnosis. The core makeup tanks and
      ADS respond to pressure and level directly, and, crucially, an operator cannot throttle
      gravity. The AP1000 licensing basis requires <em>no operator action for 72 hours</em>.`,
    watch: `In the cutaway: the left reactor keeps its water going round while the water
      itself is leaving through a valve nobody closed, so the loop looks healthy and the level
      falls anyway. That is the accident.`,
    timeline: [
      { t: 0, msg: 'Feedwater lost: turbine trip, reactor scram', fn: (s, p) => { p.scram('loss of feedwater'); } },
      { t: 15, msg: 'PORV lifts and sticks OPEN. Indication in the control room reads CLOSED', fn: (s, p) => { p.leakRate = 26; p.pRPV = 7; } },
      { t: 120, msg: 'Auxiliary feedwater valves found shut (left closed after maintenance)', fn: (s, p) => { if (p.mode === 'active') p.pumpsOk = false; } },
      { t: 300, msg: 'Crew misreads pressuriser level as "solid" and THROTTLES safety injection', fn: (s, p) => { if (p.mode === 'active') { p.operators = false; p.pumpsOk = false; } } },
      { t: 2400, msg: 'Coolant pumps tripped on vibration; the steam-driven backup is lost with them', fn: (s, p) => { if (p.mode === 'active') p.rcicOk = false; } }
    ]
  },
  {
    id: 'chernobyl',
    name: 'Power Excursion',
    icon: '☢️',
    ref: 'Chernobyl Unit 4 · 26 Apr 1986 · INES 7',
    lede: 'A low-power test in a reactor with a positive void coefficient. Inserting the shutdown rods adds reactivity.',
    detail: `Xenon-poisoned, running at 200 MWt with almost every rod withdrawn, cooling water
      flashing to steam in a graphite-moderated core whose reactivity <em>rises</em> when the
      water boils away. AZ-5 pushed graphite displacers in first. Power went to roughly 100×
      nominal in four seconds; two explosions removed the 1,000-tonne upper biological shield
      and the building had no containment at all.`,
    why: `Modern light-water cores are moderated by the same water that cools them: lose the
      water and the chain reaction <em>stops</em>. The void coefficient is strongly negative,
      the rods fall in under gravity, and everything sits inside a full pressure containment.
      The same insertion that destroyed Unit 4 is self-terminating here.`,
    watch: `In the cutaway: the left fuel goes from grey to red-hot in seconds. The right
      one drops its rods under gravity and stays grey.`,
    timeline: [
      { t: 0, msg: 'Coast-down test begins at 200 MWt with xenon poisoning', fn: (s, p) => { p.powerFrac = 0.06; p.pumpsOk = true; } },
      { t: 20, msg: 'Coolant flow drops, voids form in the core', fn: (s, p) => { p.excursion = 0.8; } },
      { t: 26, msg: 'AZ-5 pressed: graphite tips displace water, positive scram effect', fn: (s, p) => { p.excursion = 2.6; if (p.mode === 'passive') p.scram('rods fall in under gravity'); } }
    ]
  },
  {
    id: 'uhs',
    name: 'Loss of Heat Sink',
    icon: '🏜️',
    ref: 'European heatwaves 2003/2018/2022 · Fermi-1 flow blockage 1966',
    lede: 'The river runs too low and too hot, and the intake screens clog. The plant has nowhere to put its heat.',
    detail: `Every thermal plant is a heat engine that must dump ~2 GW into something. Drought,
      heatwaves, jellyfish blooms, frazil ice and debris have all forced reactors offline.
      and in 1966 a piece of loose zirconium blocked the coolant flow at Fermi-1 and melted fuel.`,
    why: `The passive answer of last resort is the atmosphere itself: an evaporating water film
      on a steel containment shell plus a natural air chimney. That heat sink cannot dry up,
      warm up, or be blocked by debris.`,
    watch: `In the cutaway: the 'heat out, to the sea' line goes grey on both plants. Only
      the right-hand one has somewhere else to put the heat, starting with the pool above the reactor,
      then the steel shell itself.`,
    timeline: [
      { t: 0, msg: 'River temperature exceeds the discharge limit. Power reduction ordered', fn: (s, p) => { p.powerFrac = 0.6; } },
      { t: 120, msg: 'Intake screens clog with debris and biofouling', fn: (s, p) => { p.scram('loss of circulating water'); p.uhs = false; } },
      { t: 300, msg: 'Service-water pumps trip on low suction; component cooling lost', fn: (s, p) => { if (p.mode === 'active') p.pumpsOk = false; } },
      { t: 900, msg: 'Diesels shut down: their jacket coolers use the same lost heat sink', fn: (s, p) => { if (p.mode === 'active') p.dieselsOk = false; } }
    ]
  },
  {
    id: 'quake',
    name: 'Beyond-Design Quake',
    icon: '🏚️',
    ref: 'Kashiwazaki-Kariwa · 16 Jul 2007 · ground motion 2.5× design',
    lede: 'Ground acceleration well beyond the design basis: transformer fire, distorted structures, grid gone.',
    detail: `The 2007 Chūetsu-oki quake shook the world's largest nuclear station at more than
      twice its design acceleration. A transformer burned for two hours, low-level water spilled,
      and all seven units stayed shut for years. Piping and pump alignment are the fragile parts.`,
    why: `Fewer moving parts is fewer things to shake out of alignment. Passive injection is
      driven by static heads inside the containment, so there is no rotating machinery whose
      bearings, alignment or power supply the earthquake can take away. But a tank is not
      immune either: at this shaking the pool above the reactor cracks, and it is worth
      watching what that does and does not cost.`,
    watch: `In the cutaway: the pool cracks in the first minute and drains, and the reactor
      stays full anyway, because the water lands on the containment floor and gravity feeds it
      straight back in. The left unit uncovers its fuel at 12 h and breaches at 15 h.`,
    timeline: [
      { t: 0, msg: 'Ground motion 2.5× design basis: scram, offsite power lost', fn: (s, p) => { p.scram('seismic'); p.grid = false; p.quakeDamage = 0.35; } },
      { t: 20, msg: 'Main transformer fire; onsite fire brigade overwhelmed', fn: (s, p) => { p.fire = 0.5; } },
      { t: 60, msg: 'Diesel day-tank line ruptured, taking two of three diesels lost', fn: (s, p) => { p.diesels = 1; } },
      { t: 400, msg: 'Service-water piping displaced at a building joint', fn: (s, p) => { if (p.mode === 'active') { p.uhs = false; p.pumpsOk = false; } } },
      { t: 900, msg: 'Last diesel starved of cooling water', fn: (s, p) => { if (p.mode === 'active') p.dieselsOk = false; } }
    ]
  },
  {
    id: 'fire',
    name: 'Cable-Room Fire',
    icon: '🔥',
    ref: 'Browns Ferry Units 1 & 2 · 22 Mar 1975',
    lede: 'A candle used to test an air seal sets fire to the cable spreading room. Control of the ECCS burns away.',
    detail: `A technician checking for air leaks with a candle ignited polyurethane foam. The
      fire ran along 1,600 cables and destroyed the emergency core-cooling controls for both
      units. Unit 1 was held up for hours by a single steam-driven pump controlled manually.`,
    why: `If the safe state is reached by valves that <em>open when they lose power</em> and by
      water that <em>falls when released</em>, then burning the control cables moves the plant
      toward safety instead of away from it. Fail-safe is a property of the physics, not of the wiring.`,
    watch: `In the cutaway: the backup pump loses its power with the cables and never starts.
      On the right, losing that same power <em>opens</em> the valves that matter.`,
    timeline: [
      { t: 0, msg: 'Fire in the cable spreading room beneath the control room', fn: (s, p) => { p.fire = 0.4; } },
      { t: 45, msg: 'Reactor scrammed manually as indications are lost', fn: (s, p) => { p.scram('manual, control room evacuating'); } },
      { t: 120, msg: 'ECCS control cables destroyed: injection valves lose their signal', fn: (s, p) => { if (p.mode === 'active') { p.pumpsOk = false; p.fire = 0.85; } } },
      { t: 400, msg: 'Emergency bus faults; diesels trip on spurious signals', fn: (s, p) => { if (p.mode === 'active') { p.dieselsOk = false; p.grid = false; } } },
      { t: 1500, msg: 'DC control power degraded by smoke and heat', fn: (s, p) => { if (p.mode === 'active') p.rcicOk = false; } }
    ]
  },
  {
    id: 'total',
    name: 'Everything At Once',
    icon: '💀',
    ref: 'Beyond-design stress test: quake + wave + fire + total loss of AC/DC',
    lede: 'The unfair test: seismic damage, flooding, fire, no grid, no diesels, no batteries, no operators.',
    detail: `A deliberately unsurvivable combination for any pumped system: the plant is on its
      own with no electricity of any kind and nobody on site.`,
    why: `This is the case that separates "defence in depth" from "defence by physics". The
      shaking here is hard enough to crack the pool <i>and</i> break the passive heat exchanger
      in it, so the passive plant loses its designed heat path in the first minute. It still
      does not melt down, because what is left is a closed loop: the core boils, the steam
      condenses on the cold steel shell, and the water runs back down to the floor and in
      again. That loop needs gravity and cold air, and neither has an off switch. Use the
      <b>disable passive systems</b> toggle to confirm it really is the passive equipment
      doing the work.`,
    watch: `In the cutaway: the left loop turns orange all the way round, still moving,
      nothing taking the heat away, and its fuel is uncovered before 3 h. On the right the pool is
      gone and the heat exchanger is broken, yet the reactor is still full at 80 h. Read the
      containment line: that closed loop is the one thing this plant cannot lose.`,
    tsunami: { at: 900, height: 18, speed: 3.6 },
    timeline: [
      { t: 0, msg: 'Extreme seismic event: scram, grid destroyed', fn: (s, p) => { p.scram('extreme seismic'); p.grid = false; p.quakeDamage = 0.6; } },
      { t: 60, msg: 'Fires in both switchgear rooms', fn: (s, p) => { p.fire = 0.9; } },
      { t: 900, msg: '18 m wave inundates the entire site', fn: (s, p) => { p.flooded = 18; p.uhs = false; p.dieselsOk = false; p.pumpsOk = false; } },
      { t: 960, msg: 'Total loss of AC and DC power; site evacuated', fn: (s, p) => { p.diesels = 0; p.battery = 0; p.rcicOk = false; p.operators = false; } }
    ]
  }
];

export const byId = (id) => SCENARIOS.find(s => s.id === id);
