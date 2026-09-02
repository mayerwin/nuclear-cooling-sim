// ---------------------------------------------------------------------------
// state.js - what the picture is showing, read straight off the model.
// ---------------------------------------------------------------------------
import { MODE, FUEL_TOP } from '../plant.js?v=a4a7aae0b1';
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function state(p) {
  const s = p.sys || {};
  const P = p.mode === MODE.PASSIVE;
  const sink = s.sink || 'none';
  const lvl = clamp(p.level, 0, 1);
  const flow = Math.max(s.rcp || 0, s.natCirc || 0);
  const live = !!(s.grid || s.diesel);
  const steamOnly = !P && !!s.rcic && !s.aux;
  const injecting = P ? !!(s.cmt || s.gravity || s.accum) : !!(s.aux || s.rcic);
  const poolFrac = p.irwst / 2.1e6;
  const floorFrac = (p.ctmtSump || 0) / 2.1e6;
  const onFloor = P && p.irwst < 1.6e5 && floorFrac > 0.05;
  const uncovered = lvl < FUEL_TOP;
  const headline =
    p.vesselBreach || /DESTROYED/.test(p.state) ? 'Meltdown'
      : uncovered ? 'Fuel is uncovered'
        : p.coreDamage > 0.01 ? 'Fuel is damaged'
          : lvl < 0.97 ? 'Losing water'
            : (P && !p.ctmtIntact) ? 'The water is escaping'
              : (P && !p.prhrOk && sink === 'none') ? 'Passive heat path broken'
                : sink === 'none' ? 'Heat is not getting out'
                  : s.rcic ? 'On the last resort pump'
                    : sink === 'pool' ? 'The pool is taking the heat'
                      : sink === 'shell' ? 'The shell is taking the heat'
                        : (flow > 0 && !s.rcp) ? 'Cooling itself, no pump'
                          : !live ? 'Running on batteries'
                            : P ? 'Safe' : 'Normal';
  return {
    s, P, sink, lvl, flow, live, steamOnly, injecting, poolFrac, onFloor,
    carried: sink !== 'none', uncovered, headline,
    T: p.Tclad - 273,
    cracked: P && p.irwstCracked,
    lost: P && onFloor && !p.ctmtIntact,
    poolLoop: P && sink === 'pool',
    good: !(p.vesselBreach || uncovered || p.coreDamage > 0.01 || sink === 'none'
      || lvl < 0.97 || (P && !p.ctmtIntact))
  };
}
