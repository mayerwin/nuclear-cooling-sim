"""tools/blender/plant.py - the station, built in Blender from assets/layout.json.

Run inside a live Blender through tools/bl.py (so the result can be looked at):

    py -3 tools/bl.py run tools/blender/plant.py --shot out.png

or headless for the export the app loads:

    ~/Apps/blender-5.2.1-windows-x64/blender.exe -b -P tools/blender/plant.py -- --export assets/plant.glb

Everything static is built here, whole: vessels, casings, pipes, pumps, tanks,
the building. The water, the steam, the tracers and the temperature colours
stay in the app, which draws them from the same layout file into the hollows
this geometry leaves. The half cut is done in the app at render time by one
clipping plane, so nothing here is cut.

Coordinates are the layout's: x across the picture, y up, z depth (the far
half, z < 0, is what the app keeps). Blender is z-up, so the scene is built in
a root empty rotated by +90 degrees about x: layout (x, y, z) -> Blender
(x, -z, y). The glTF exporter turns that back into y-up.
"""
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')) \
    if '__file__' in globals() else r'C:\Users\erwin\Dropbox\Projects\GitHub\nuclear-cooling-sim'
LAYOUT = json.load(open(os.path.join(ROOT, 'assets', 'layout.json'), encoding='utf-8'))
L = LAYOUT

# ---------------------------------------------------------------------------
# scene and materials
# ---------------------------------------------------------------------------
_root = None
_col = None


def V(x, y, z=0.0):
    """Layout (x, y, z) to Blender (x, -z, y)."""
    return Vector((x, -z, y))


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.collections):
        for d in list(block):
            if d.users == 0:
                block.remove(d)


def collection(name):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(col)
    return col


MATS = {}


def mat(name, color, rough=0.5, metal=0.0, alpha=1.0, emit=None):
    """A Principled material, made once. Colours are sRGB hex like the app's."""
    m = MATS.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    r, g, b = ((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    bsdf.inputs['Base Color'].default_value = (lin(r), lin(g), lin(b), 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        m.blend_method = 'BLEND'
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*[lin(c) for c in emit[:3]], 1.0)
        bsdf.inputs['Emission Strength'].default_value = emit[3]
    MATS[name] = m
    return m


def materials():
    mat('concrete', 0x9aa0a6, rough=0.96, metal=0.02)
    mat('liner', 0xb9c6d0, rough=0.62, metal=0.28)
    mat('deck', 0x4d545b, rough=0.92, metal=0.05)
    mat('floor', 0x5c666f, rough=0.95, metal=0.05)
    mat('steel', 0xaeb9c4, rough=0.42, metal=0.8)
    mat('shell', 0x9aa6b0, rough=0.56, metal=0.45)
    mat('painted', 0x5d6b78, rough=0.58, metal=0.35)
    mat('casing_dark', 0x39434e, rough=0.7, metal=0.2)
    mat('pipe', 0x9fb0bf, rough=0.52, metal=0.25)
    mat('pipe_steam', 0x6f7b87, rough=0.5, metal=0.3)
    mat('copper', 0xb87333, rough=0.4, metal=0.95)
    mat('rail', 0xd6dee6, rough=0.4, metal=0.7)
    mat('dark', 0x3a444d, rough=0.8, metal=0.2)
    mat('plate', 0x7f8b96, rough=0.5, metal=0.7)
    mat('tank', 0x4e5a66, rough=0.9, metal=0.1)
    mat('vane', 0x9fb3c2, rough=0.35, metal=0.9)
    mat('bulb', 0x2a2a26, rough=0.25)
    mat('glass', 0xdfeaf4, rough=0.12, metal=0.1, alpha=0.22)


# ---------------------------------------------------------------------------
# geometry helpers: every mesh is parented to the root and put in a collection
# ---------------------------------------------------------------------------
def empty(name, x, y, z=0.0, parent=None):
    ob = bpy.data.objects.new(name, None)
    _col.objects.link(ob)
    ob.parent = parent or _root
    ob.location = V(x, y, z)
    return ob


_parent = None   # when set, new objects are parented here instead of the root


def add_obj(name, mesh, material=None, col=None):
    ob = bpy.data.objects.new(name, mesh)
    (col or _col).objects.link(ob)
    ob.parent = _parent or _root
    if material:
        ob.data.materials.append(MATS[material])
    return ob


def lathe(name, profile, material, x, y, z=0.0, segments=64, angle=math.tau, start=0.0, closed_ends=False):
    """A solid of revolution about the layout's y axis from [[r, h], ...]."""
    bm = bmesh.new()
    ring0 = None
    first = None
    steps = segments
    for i in range(len(profile)):
        r, h = profile[i]
        ring = []
        if r < 1e-6:
            v = bm.verts.new((0.0, h, 0.0))
            ring = [v] * (steps + 1)
        else:
            for k in range(steps + 1):
                a = start + angle * k / steps
                ring.append(bm.verts.new((r * math.cos(a), h, r * math.sin(a))))
        if ring0 is not None:
            for k in range(steps):
                quad = [ring0[k], ring0[k + 1], ring[k + 1], ring[k]]
                uniq = []
                for v in quad:
                    if v not in uniq:
                        uniq.append(v)
                if len(uniq) >= 3:
                    try:
                        bm.faces.new(uniq)
                    except ValueError:
                        pass
        ring0 = ring
    bm.verts.ensure_lookup_table()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    # the profile is in (r, h) with h along y: rotate into Blender's z-up
    me.transform(_rot_x90())
    for p in me.polygons:
        p.use_smooth = True
    ob = add_obj(name, me, material)
    ob.location = V(x, y, z)
    return ob


def _rot_x90():
    from mathutils import Matrix
    return Matrix.Rotation(math.radians(90), 4, 'X')


def cylinder(name, r0, r1, h, material, x, y, z=0.0, segments=48, axis='y', caps=True):
    """A cylinder (or cone) whose axis is the layout's y, centred at (x, y, z)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segments,
                          radius1=r0, radius2=r1, depth=h)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = len(p.vertices) == 4
    ob = add_obj(name, me, material)
    ob.location = V(x, y, z)
    if axis == 'x':
        ob.rotation_euler = (0, math.radians(90), 0)
    elif axis == 'z':
        ob.rotation_euler = (math.radians(90), 0, 0)
    return ob


def box(name, w, h, d, material, x, y, z=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(w, d, h), verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = add_obj(name, me, material)
    ob.location = V(x, y, z)
    return ob


def sphere(name, r, material, x, y, z=0.0, segments=20, rings=10):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=r)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = add_obj(name, me, material)
    ob.location = V(x, y, z)
    return ob


def torus(name, R, r, material, x, y, z=0.0, axis='y'):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=48, minor_segments=12)
    ob = bpy.context.object
    me = ob.data
    bpy.data.objects.remove(ob)
    ob = add_obj(name, me, material)
    ob.location = V(x, y, z)
    if axis == 'y':
        ob.rotation_euler = (math.radians(90), 0, 0)
    elif axis == 'x':
        ob.rotation_euler = (0, math.radians(90), 0)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def rounded(pts, bend):
    """The app's roundedPath: straights between corners, an arc through each."""
    out = []
    pts = [Vector(p) for p in pts]
    if len(pts) < 2:
        return pts
    cur = pts[0]
    out.append(cur.copy())
    for i in range(1, len(pts) - 1):
        c, nxt = pts[i], pts[i + 1]
        d_in = (c - cur).normalized()
        d_out = (nxt - c).normalized()
        rr = min(bend, (c - cur).length * 0.45, (nxt - c).length * 0.45)
        a = c - d_in * rr
        b = c + d_out * rr
        out.append(a)
        # quadratic bezier a -> c -> b sampled
        for k in range(1, 8):
            t = k / 8
            p = (1 - t) ** 2 * a + 2 * (1 - t) * t * c + t * t * b
            out.append(p)
        out.append(b)
        cur = b
    out.append(pts[-1].copy())
    return out


def pipe(name, spec, material='pipe', radius=None):
    """A pipe casing along the layout polyline, with real elbows: a poly curve
    with a round bevel, which the glTF exporter turns into a mesh."""
    pts = rounded([tuple(p) for p in spec['pts']], spec.get('bend', 1.0))
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = radius if radius else spec['dia'] / 2
    # a thin rod (a blade, a vane, a busbar) needs eight sides, not eighteen
    thin = cu.bevel_depth < 0.2
    cu.bevel_resolution = 3 if thin else 8
    cu.resolution_u = 3 if thin else 6
    cu.use_fill_caps = False
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        v = V(p.x, p.y, p.z)
        sp.points[i].co = (v.x, v.y, v.z, 1.0)
    ob = bpy.data.objects.new(name, cu)
    _col.objects.link(ob)
    ob.parent = _parent or _root
    cu.materials.append(MATS[material])
    return ob


def fluid_rod(name, pts, r, bend, material='pipe'):
    return pipe(name, {'pts': pts, 'bend': bend, 'dia': r * 2}, material=material)


# ---------------------------------------------------------------------------
# the building
# ---------------------------------------------------------------------------
def build_building():
    global _col
    _col = collection('building')
    C = L['containment']
    R, W, H, DR = C['r_in'], C['wall'], C['shell_h'], C['dome_r']
    # the slab and the floor
    cylinder('slab', C['slab_r'], C['slab_r'], C['slab_h'], 'deck', 0, -C['slab_h'] / 2, 0, segments=96)
    cylinder('floor', R, R, 0.04, 'floor', 0, 0.02, 0, segments=96)
    # the wall, as one solid ring with thickness (outer skin, inner skin, foot and top)
    wall_prof = [[R, 0.01], [R + W, 0.01], [R + W, H], [R, H], [R, 0.01]]
    ob = lathe('wall', wall_prof, 'concrete', 0, 0, 0, segments=96)
    # the dome, solid: outer hemisphere over inner hemisphere
    prof = []
    n = 24
    for i in range(n + 1):
        a = math.pi / 2 * i / n
        prof.append([DR * math.cos(a), H + DR * math.sin(a)])
    for i in range(n, -1, -1):
        a = math.pi / 2 * i / n
        prof.append([R * math.cos(a), H + R * math.sin(a)])
    lathe('dome', prof, 'concrete', 0, 0, 0, segments=96)
    # the liner: the inside face reads pale so the machines stand against it
    lathe('liner', [[R - 0.02, 0.05], [R - 0.02, H]], 'liner', 0, 0, 0, segments=96)
    lathe('liner_dome', [[(R - 0.02) * math.cos(math.pi / 2 * i / n), H + (R - 0.02) * math.sin(math.pi / 2 * i / n)]
                         for i in range(n + 1)], 'liner', 0, 0, 0, segments=96)


# ---------------------------------------------------------------------------
# the reactor
# ---------------------------------------------------------------------------
def build_reactor():
    global _col
    _col = collection('reactor')
    P = L['rpv']
    x, base = P['x'], P['base']
    # the vessel: a lathe of the profile, one steel body (the app cuts it)
    lathe('rpv_shell', P['profile'], 'shell', x, base, 0, segments=64)
    # the flange between barrel and head
    hf = P['profile'][P['head_from']][1]
    torus('rpv_flange', P['r'] + 0.05, 0.28, 'steel', x, base + hf, 0)
    # a ring of studs round it
    for i in range(24):
        a = math.tau * i / 24
        cylinder('rpv_stud_%d' % i, 0.09, 0.09, 0.9, 'rail', x + (P['r'] + 0.05) * math.cos(a),
                 base + hf, (P['r'] + 0.05) * math.sin(a), segments=8)
    # the support skirt into the concrete cradle
    S = P['skirt']
    cylinder('rpv_skirt', S['r0'], S['r1'], S['h'], 'deck', x, S['h'] / 2, 0, segments=48)
    # the legs meet the barrel with no collar: their casings end inside the wall
    # the fuel: rods on a square pitch inside the barrel
    n = 0
    pitch, fr = P['fuel_pitch'], P['fuel_r']
    fh = P['fuel_y1'] - P['fuel_y0']
    for i in range(-4, 5):
        for j in range(-4, 5):
            px, pz = i * pitch, j * pitch
            if math.hypot(px, pz) > fr:
                continue
            cylinder('fuel_rod_%d' % n, P['fuel_rod_r'], P['fuel_rod_r'], fh, 'painted',
                     x + px, P['fuel_y0'] + fh / 2, pz, segments=10)
            n += 1
    # the fuel-top mark
    torus('rpv_fuel_mark', 3.02, 0.1, 'copper', x, P['fuel_y1'], 0)


# ---------------------------------------------------------------------------
# the boiler
# ---------------------------------------------------------------------------
def build_boiler():
    global _col
    _col = collection('boiler')
    S = L['sg']
    x, base = S['x'], S['base']
    lathe('sg_shell', S['profile'], 'shell', x, base, 0, segments=64)
    # the tube sheet
    cylinder('sg_tubesheet', S['sheet_r'], S['sheet_r'], S['sheet_t'], 'plate', x, S['tubesheet'], 0, segments=48)
    # the divider plate across the channel head
    box('sg_divider', 0.16, 2.2, 3.4, 'plate', x, S['tubesheet'] - 1.0, S['tubes']['z'])
    # the U-tubes in the plane of the cut
    T = S['tubes']
    for k in range(T['n']):
        w = T['w0'] + k * T['dw']
        top = S['tubesheet'] + T['top_over_sheet'] + w * T['top_k']
        z = T['z']
        pts = [[x + w, S['tubesheet'] + T['foot'], z], [x + w, top, z], [x - w, top, z], [x - w, S['tubesheet'] + T['foot'], z]]
        fluid_rod('sg_tube_%d' % k, pts, T['r'], w * 0.9, material='steel')
    # the pedestal behind the cut
    Pd = S['pedestal']
    box('sg_pedestal', Pd['w'], Pd['h'], Pd['d'], 'deck', x, Pd['h'] / 2, Pd['z'])


# ---------------------------------------------------------------------------
# a pump: volute, impeller, motor, lamp
# ---------------------------------------------------------------------------
def build_pump(prefix, x, y, z, sc):
    P = L['pump']
    cylinder(prefix + '_casing', P['casing_r'] * sc, P['casing_r'] * sc, P['casing_h'] * sc, 'painted', x, y, z, segments=48, caps=False)
    cylinder(prefix + '_shaft', 0.28 * sc, 0.28 * sc, 2.4 * sc, 'steel', x, y + 1.4 * sc, z, segments=12)
    cylinder(prefix + '_motor', P['motor_r'] * sc, P['motor_r'] * sc, P['motor_h'] * sc, 'painted', x, y + P['motor_dy'] * sc, z, segments=32)
    sphere(prefix + '_lamp', P['lamp_r'] * sc, 'bulb', x, y + P['lamp_dy'] * sc, z)
    # impeller: a hub and seven backward-curved vanes, under one empty the app turns
    global _parent
    _parent = empty(prefix + '_rotor', x, y, z)
    cylinder(prefix + '_hub', 0.5 * sc, 0.5 * sc, 1.4 * sc, 'vane', 0, 0, 0, segments=18)
    for i in range(7):
        a = math.tau * i / 7
        pts = [[math.cos(a) * 0.45 * sc, 0, math.sin(a) * 0.45 * sc],
               [math.cos(a - 0.5) * 1.05 * sc, 0, math.sin(a - 0.5) * 1.05 * sc],
               [math.cos(a - 1.0) * 1.6 * sc, 0, math.sin(a - 1.0) * 1.6 * sc]]
        fluid_rod(prefix + '_vane_%d' % i, pts, 0.17 * sc, 0.4 * sc, material='vane')
    _parent = None


def build_rcp():
    global _col
    _col = collection('rcp')
    R = L['rcp']
    build_pump('rcp', R['x'], R['y'], R['z'], R['scale'])
    for i, a in enumerate(R['legs']['angles']):
        h = L['cold_y'] - 1.1
        cylinder('rcp_leg_%d' % i, R['legs']['r'], R['legs']['r'], h, 'steel',
                 R['x'] + math.cos(a) * R['legs']['at'], h / 2, R['z'] + math.sin(a) * R['legs']['at'], segments=8)


# ---------------------------------------------------------------------------
# the primary loop
# ---------------------------------------------------------------------------
def build_loop():
    global _col
    _col = collection('loop')
    for name in ('hot', 'cold', 'coldB'):
        pipe('pipe_' + name, L['pipes'][name], material='pipe')



# ---------------------------------------------------------------------------
# the turbine, the generator, the lamp
# ---------------------------------------------------------------------------
def build_turbine():
    global _col
    _col = collection('turbine')
    T = L['turbine']
    ax, x0, x1 = T['ax'], T['x0'], T['x1']
    # the casing: a cone along x, closed at both ends, dark inside
    cylinder('turb_casing', T['r0'], T['r1'], x1 - x0, 'casing_dark', (x0 + x1) / 2, ax, 0, segments=48, axis='x')
    # bearing pedestals under each end of the shaft, set back into the kept half
    for i, px in enumerate((x0 - 0.9, x1 + 0.9)):
        box('turb_bearing_%d' % i, 1.0, 1.4, 1.2, 'deck', px, ax - 3.9 + 0.7, -0.6)
        cylinder('turb_bearing_cap_%d' % i, 0.7, 0.7, 0.9, 'painted', px, ax, 0, segments=24, axis='x')
    S = T['shaft']
    cylinder('turb_shaft', S['r'], S['r'], S['len'], 'steel', S['x'], ax, 0, segments=20, axis='x')
    # the wheel: hub, a ring of curved buckets, a translucent disc and the shroud
    W = T['wheel']
    wx = (x0 + x1) / 2
    global _parent
    _parent = empty('turb_rotor', wx, ax, 0)
    cylinder('turb_hub', W['hub_r'], W['hub_r'], W['hub_len'], 'vane', 0, 0, 0, segments=24, axis='x')
    for i in range(W['blades']):
        a = math.tau * i / W['blades']
        r_in, r_out = 0.9, W['r'] - 0.1
        pts = [[-0.42, math.cos(a) * r_in, math.sin(a) * r_in],
               [0, math.cos(a + 0.12) * (W['r'] * 0.6), math.sin(a + 0.12) * (W['r'] * 0.6)],
               [0.42, math.cos(a + 0.34) * r_out, math.sin(a + 0.34) * r_out]]
        fluid_rod('turb_blade_%d' % i, pts, 0.1, 0.3, material='vane')
    cylinder('turb_disc', 1.25, 1.25, 0.34, 'vane', 0, 0, 0, segments=44, axis='x')
    torus('turb_shroud', W['r'], 0.1, 'vane', 0, 0, 0, axis='x')
    _parent = None
    # the generator, with its copper band, and the pedestal under it
    G = T['gen']
    box('gen_body', G['w'], G['h'], G['d'], 'painted', G['x'], ax, 0)
    box('gen_band', 0.45, G['h'] + 0.15, G['d'] + 0.15, 'copper', G['x'], ax, 0)
    for i, dx in enumerate((-1.0, 1.0)):
        cylinder('gen_endshield_%d' % i, 1.15, 1.15, 0.25, 'steel', G['x'] + dx * (G['w'] / 2 + 0.12), ax, 0, segments=32, axis='x')
    P = T['pedestal']
    box('gen_pedestal', P['w'], P['h'], P['d'], 'deck', P['x'], P['h'] / 2, P['z'])
    # the lamp on its pole, straight up out of the generator
    Lm = T['lamp']
    cylinder('lamp_pole', 0.13, 0.16, Lm['pole_h'], 'rail', Lm['x'], ax + G['h'] / 2 + Lm['pole_h'] / 2, 0, segments=10)
    sphere('lamp_bulb', 0.55, 'bulb', Lm['x'], Lm['y'], 0)
    cylinder('lamp_shade', 0.85, 0.55, 0.55, 'painted', Lm['x'], Lm['y'] + 0.55, 0, segments=20, caps=False)
    for i, dz in enumerate((-0.34, 0.34)):
        fluid_rod('lamp_bus_%d' % i, [[Lm['x'] + dz, ax + 1.3, 0], [Lm['x'] + dz, Lm['y'] - 0.5, 0]], 0.1, 0.3, material='copper')


# ---------------------------------------------------------------------------
# the condenser: shell, thin plates, tube bank, the exhaust duct
# ---------------------------------------------------------------------------
def build_condenser():
    global _col
    _col = collection('condenser')
    C = L['condenser']
    x, y, r, ln = C['x'], C['y'], C['r'], C['len']
    cylinder('cond_shell', r, r, ln, 'painted', x, y, 0, segments=48, axis='x', caps=False)
    # the two end plates, a quarter of a metre thick
    for i, px in enumerate((x - ln / 2 - C['plate_t'] / 2, x + ln / 2 + C['plate_t'] / 2)):
        cylinder('cond_plate_%d' % i, r + 0.04, r + 0.04, C['plate_t'], 'plate', px, y, 0, segments=48, axis='x')
    # the three nested runs of the bank: in low, round, out high
    for k in range(3):
        lo, hi, xl = C['rows_lo'][k], C['rows_hi'][k], C['turn_x'][k]
        z = C['tube_z']
        pts = [[C['plate_r'], lo, z], [xl, lo, z], [xl, hi, z], [C['plate_r'], hi, z]]
        fluid_rod('cond_tube_%d' % k, pts, C['tube_r'], (hi - lo) * 0.45, material='steel')
    # the exhaust duct from the casing floor into the shell top, and a flange where it lands
    pipe('pipe_exhaust', L['pipes']['exhaust'], material='pipe_steam')
    cylinder('cond_neck_flange', 0.85, 0.85, 0.16, 'plate', L['pipes']['exhaust']['pts'][0][0], y + r + 0.02, 0, segments=32)
    # the saddles the shell rests on
    for i, px in enumerate((x - ln * 0.32, x + ln * 0.32)):
        box('cond_saddle_%d' % i, 0.6, y - r + 0.4, 2.2, 'deck', px, (y - r + 0.4) / 2, -0.4)


# ---------------------------------------------------------------------------
# the condensate pump, the sea, the circulating pump, the two sea lines
# ---------------------------------------------------------------------------
def build_sea():
    global _col
    _col = collection('sea')
    Cp = L['cond_pump']
    build_pump('cpump', Cp['x'], Cp['y'], 0, Cp['scale'])
    pipe('pipe_cond_suct', L['pipes']['cond_suct'], material='pipe')
    pipe('pipe_feed', L['pipes']['feed'], material='pipe')
    pipe('pipe_steam', L['pipes']['steam'], material='pipe_steam')
    S = L['sea']
    Wl = S['wall']
    box('bay_wall', Wl['w'], Wl['h'], Wl['d'], 'deck', S['bay_x'], S['y'] - Wl['h'] / 2, S['bay']['z'])
    Pm = S['pump']
    build_pump('cwpump', Pm['x'], Pm['y'], 0, Pm['scale'])
    cylinder('cwpump_plinth', 1.3, 1.3, 0.4, 'deck', Pm['x'], 0.2, 0, segments=32)
    for name in ('cw_suct', 'cw_disch', 'cw_out'):
        pipe('pipe_' + name, L['pipes'][name], material='pipe')


# ---------------------------------------------------------------------------
# the vent
# ---------------------------------------------------------------------------
def build_vent():
    global _col
    _col = collection('vent')
    pipe('pipe_vent', L['pipes']['vent'], material='pipe_steam')
    M = L['vent_mouth']
    cylinder('vent_mouth', M['r0'], M['r1'], M['h'], 'painted', M['x'], M['y'], 0, segments=20, caps=False)


# ---------------------------------------------------------------------------
# what the two designs do differently
# ---------------------------------------------------------------------------
def build_passive():
    global _col
    _col = collection('passive')
    P = L['passive']
    pool = P['pool']
    t = pool['wall_t']
    box('pool_floor', pool['w'], 0.5, pool['d'], 'painted', pool['x'], pool['y'] + 0.25, 0)
    for i, (ax_, az) in enumerate(((1, 0), (-1, 0), (0, 1), (0, -1))):
        w = t if ax_ else pool['w'] + t
        d = t if az else pool['d'] + t
        box('pool_wall_%d' % i, w, pool['h'], d, 'tank', pool['x'] + ax_ * (pool['w'] / 2),
            pool['y'] + pool['h'] / 2, az * (pool['d'] / 2))
    for i, (dx, dz) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        c = pool['columns']
        cylinder('pool_col_%d' % i, c['r'], c['r'], pool['y'], 'painted',
                 pool['x'] + dx * (pool['w'] / 2 - c['inset']), pool['y'] / 2, dz * (pool['d'] / 2 - c['inset']), segments=12)
    pipe('pipe_prhr_up', P['prhr_up'], material='pipe')
    co = P['coil']
    pts, cx, side = [], co['x0'], 1
    while cx < co['x1'] + 1e-6:
        pts.append([cx, co['y'], side * co['half_z']]); pts.append([cx, co['y'], -side * co['half_z']])
        cx += co['step']; side *= -1
    fluid_rod('coil', pts, co['r'], co['bend'], material='steel')
    pipe('pipe_prhr_down', P['prhr_down'], material='pipe')
    pipe('pipe_gravity', P['gravity'], material='pipe')
    pipe('pipe_recirc', P['recirc'], material='pipe')
    pipe('pipe_fill', P['fill'], material='pipe')
    Vv = P['valve']
    sphere('grav_valve', Vv['r'], 'painted', Vv['x'], Vv['y'], 0)
    cylinder('grav_stem', 0.11, 0.11, Vv['stem_h'], 'steel', Vv['x'], Vv['y'] + Vv['r'] + Vv['stem_h'] / 2 - 0.2, 0, segments=10)
    torus('grav_wheel', Vv['wheel_r'], 0.09, 'rail', Vv['x'], Vv['y'] + Vv['r'] + Vv['stem_h'] - 0.2, 0)
    B = P['boss']
    cylinder('grav_boss', B['r'], B['r'], B['h'], 'steel', B['x'], B['y'] + B['h'] / 2, 0, segments=16)


def build_active():
    global _col
    _col = collection('active')
    A = L['active']
    T = A['tank']
    box('tank_floor', T['w'], 0.4, T['d'], 'painted', T['x'], 0.2, 0)
    for i, (ax_, az) in enumerate(((1, 0), (-1, 0), (0, 1), (0, -1))):
        w = T['lip'] if ax_ else T['w'] + T['lip'] * 2
        d = T['lip'] if az else T['d'] + T['lip'] * 2
        box('tank_wall_%d' % i, w, T['h'], d, 'tank', T['x'] + ax_ * (T['w'] / 2 + T['lip'] / 2), T['h'] / 2, az * (T['d'] / 2 + T['lip'] / 2))
    E = A['eccs']
    build_pump('eccs', E['x'], E['y'], 0, E['scale'])
    pipe('pipe_suction', A['suction'], material='pipe')
    pipe('pipe_injection', A['injection'], material='pipe')


ALL_PARTS = ['building', 'reactor', 'boiler', 'rcp', 'loop', 'turbine', 'condenser', 'sea', 'vent']


# ---------------------------------------------------------------------------
def build(parts=None):
    global _root, _col
    clear_scene()
    materials()
    _root = bpy.data.objects.new('station', None)
    bpy.context.scene.collection.objects.link(_root)
    _root.rotation_euler = (0, 0, 0)
    parts = parts or ALL_PARTS + ['passive', 'active']
    for p in parts:
        globals()['build_' + p]()
    print('built', parts)


def export(path):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_apply=True, export_yup=True)
    print('exported', path, os.path.getsize(path), 'bytes')


if __name__ == '__main__' or True:
    argv = sys.argv
    if '--export' in argv:
        build()
        export(os.path.join(ROOT, argv[argv.index('--export') + 1]))
    elif 'PLANT_PARTS' in globals():
        build(PLANT_PARTS)
    else:
        build()
