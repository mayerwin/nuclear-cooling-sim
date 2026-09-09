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
    # weld the seam: a boolean solver needs a closed solid, not a crack
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    # and its normals must point OUT: built inside-out, a lathe reads to the
    # boolean solver as the whole world minus the vessel
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
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


def offset_profile(profile, t):
    """The profile moved t inward along its outward normal (the mean of its
    two segments' normals at each point); t negative moves it outward. A
    point on the axis stays on the axis and moves along it."""
    n = len(profile)
    out = []
    for i in range(n):
        r, h = profile[i]
        nx = ny = 0.0
        for a, b in ((i - 1, i), (i, i + 1)):
            if a < 0 or b >= n:
                continue
            dr, dh = profile[b][0] - profile[a][0], profile[b][1] - profile[a][1]
            L = math.hypot(dr, dh) or 1.0
            # the outward normal of a segment running up the profile (r, h)
            nx += dh / L
            ny += -dr / L
        L = math.hypot(nx, ny) or 1.0
        nx, ny = nx / L, ny / L
        if r < 1e-6:
            out.append([0.0, h - t * ny])
        else:
            out.append([max(0.0, r - t * nx), h - t * ny])
    return out


def hollow(name, profile, t, material, x, y, z=0.0, segments=64):
    """A vessel with a WALL: the outer lathe less the inner one, so a cut
    through it shows a band of steel the thickness of the wall, and a nozzle
    can be bored through it. The layout's profile is the CAVITY (it is what
    the network's volume and the app's water are built from) and the wall
    stands outside it. Keeps two hidden solids for cutting other things:
    _cut_<name>_outer (the whole vessel) and _cut_<name>_inner (its cavity),
    which is what a pipe casing is cut by, so it passes through the wall and
    ends open at the inner surface."""
    outer_profile = offset_profile(profile, -t)
    ob = lathe(name, outer_profile, material, x, y, z, segments=segments)
    outer = proxy(lathe(name + '_outer', outer_profile, material, x, y, z, segments=segments))
    inner = proxy(lathe(name + '_inner', profile, material, x, y, z, segments=segments))
    mod = ob.modifiers.new('hollow', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = inner
    return ob, outer, inner


def bore_at(shell, name, r, x, y, z, axis, length):
    """A round hole through a solid: a cylinder cutter of radius r centred at
    (x, y, z) along axis, taken out of the shell."""
    cutter = proxy(cylinder('_cut_bore_' + name + '_' + shell.name, r, r, length, 'deck', x, y, z, segments=32, axis=axis))
    mod = shell.modifiers.new('bore_' + name, 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = cutter
    return cutter


def bore(shell, pipe_name, spec, end, t, in_len=0.5, out_len=None):
    """A nozzle: the bore of a pipe through a vessel's wall where the pipe
    meets it. The cutter is a cylinder of the pipe's radius along the pipe's
    end segment, from outside the wall (as far back as the previous point of
    the line, so it passes the wall however deep inside it the layout's end
    sits, but never further than the wall and three metres) to in_len inside
    the end point, into the cavity and never as far as the far wall."""
    pts = spec['pts']
    a = pts[0] if end == 0 else pts[-1]
    b = pts[1] if end == 0 else pts[-2]
    d = [a[i] - b[i] for i in range(3)]
    n = math.sqrt(sum(v * v for v in d)) or 1.0
    d = [v / n for v in d]   # along the pipe, INTO the body
    if out_len is None:
        out_len = max(t + 0.3, min(n, t + 3.0))
    length = out_len + in_len
    axis = 'x' if abs(d[0]) >= max(abs(d[1]), abs(d[2])) else ('z' if abs(d[2]) > abs(d[1]) else 'y')
    k = (in_len - out_len) / 2
    return bore_at(shell, pipe_name, spec['dia'] / 2, a[0] + d[0] * k, a[1] + d[1] * k, a[2] + d[2] * k, axis, length)


def drum(name, r0, r1, h, t, material, x, y, z=0.0, segments=48, axis='y', open_ends=False):
    """A can with a WALL: a cylinder (or cone) less a smaller one inside it,
    closed at both ends unless open_ends, when it is a thick tube. As with
    hollow(), the radii and height given are the CAVITY's and the wall stands
    outside them. Keeps the two hidden solids hollow() does: _cut_<name>_outer
    and _cut_<name>_inner, the second being what a pipe's casing is cut by."""
    ho = h if open_ends else h + 2 * t
    ob = cylinder(name, r0 + t, r1 + t, ho, material, x, y, z, segments=segments, axis=axis)
    outer = proxy(cylinder(name + '_outer', r0 + t, r1 + t, ho, material, x, y, z, segments=segments, axis=axis))
    if open_ends:
        inner = proxy(cylinder(name + '_inner', r0, r1, h + 1.0, material, x, y, z, segments=segments, axis=axis))
    else:
        inner = proxy(cylinder(name + '_inner', r0, r1, h, material, x, y, z, segments=segments, axis=axis))
    mod = ob.modifiers.new('hollow', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = inner
    return ob, outer, inner


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
    pts = rounded([tuple(p) for p in reached(spec['pts'], spec.get('reach'))], spec.get('bend', 1.0))
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = radius if radius else spec['dia'] / 2
    # a thin rod (a blade, a vane, a busbar) needs eight sides, not eighteen
    thin = cu.bevel_depth < 0.2
    cu.bevel_resolution = 3 if thin else 8
    cu.resolution_u = 3 if thin else 6
    # closed at both ends: the cuts (boolean differences) need a solid, and an
    # open tube has no inside for the solver to remove
    cu.use_fill_caps = True
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


def reached(pts, reach):
    """Extend a polyline past each end by reach[0] / reach[1] along its end
    segments: the casing runs on into the body it enters, and the cut then
    ends it at the wall with a full saddle."""
    if not reach:
        return pts
    pts = [list(p) for p in pts]
    for end, k in ((0, 1), (1, -2)):
        r = float(reach[end]) if len(reach) > end else 0.0
        if r <= 0 or len(pts) < 2:
            continue
        a = pts[0] if end == 0 else pts[-1]
        b = pts[1] if end == 0 else pts[-2]
        d = [a[i] - b[i] for i in range(3)]
        n = math.sqrt(sum(x * x for x in d)) or 1.0
        moved = [a[i] + d[i] / n * r for i in range(3)]
        if end == 0:
            pts[0] = moved
        else:
            pts[-1] = moved
    return pts


def trimmed(pts, trim):
    """Shorten a polyline by trim[0] at its start and trim[1] at its end, so a
    casing stops at the wall it enters while the water inside runs on."""
    if not trim:
        return pts
    pts = list(pts)
    for end in (0, 1):
        t = float(trim[end]) if len(trim) > end else 0.0
        while t > 1e-6 and len(pts) > 1:
            a, b = (pts[0], pts[1]) if end == 0 else (pts[-1], pts[-2])
            seg = (b - a).length
            if seg <= t:
                t -= seg
                pts.pop(0 if end == 0 else -1)
            else:
                moved = a + (b - a).normalized() * t
                if end == 0:
                    pts[0] = moved
                else:
                    pts[-1] = moved
                t = 0.0
    return pts


def half_cylinder(name, r, h, material, x, y, z0=-0.02, segments=32):
    """A solid half cylinder on the kept side of the cut (layout z <= z0) with
    a flat face at z0: a support the plane would otherwise slice open and show
    hollow. Built whole in its half, so the cutaway shows solid concrete."""
    bm = bmesh.new()
    bot, top = [], []
    for k in range(segments + 1):
        a = math.pi * k / segments
        px, pz = x + r * math.cos(a), z0 - r * math.sin(a)
        bot.append(bm.verts.new(V(px, y, pz)))
        top.append(bm.verts.new(V(px, y + h, pz)))
    sides = []
    for k in range(segments):
        sides.append(bm.faces.new((bot[k], bot[k + 1], top[k + 1], top[k])))
    bm.faces.new(bot[::-1])
    bm.faces.new(top)
    bm.faces.new((bot[0], top[0], top[-1], bot[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in sides:
        f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return add_obj(name, me, material)


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
    # the vessel: a WALL, not a surface. The outer lathe less an inner one
    # (WALL_T thick), with a nozzle bored through it for every pipe that
    # meets it: the hot leg, the cold leg, the pool loop's two ends and the
    # fill line. A pipe's casing is then cut by the cavity, so it passes
    # through the wall and ends open inside; the water runs on through.
    shell, _, _ = hollow('rpv_shell', P['profile'], P.get('wall', 0.22), 'shell', x, base, 0, segments=64)
    t = P.get('wall', 0.22)
    for pipe_name, spec, end in (('pipe_hot', L['pipes']['hot'], 0), ('pipe_coldB', L['pipes']['coldB'], 1),
                                 ('pipe_prhr_up', L['passive']['prhr_up'], 0), ('pipe_prhr_down', L['passive']['prhr_down'], 1),
                                 ('pipe_fill', L['passive']['fill'], 1)):
        bore(shell, pipe_name, spec, end, t)
    # No flange ring, no studs, no mark: every ring round the vessel read as
    # an unexplained object. The vessel stands on a plain pedestal that lives
    # in the kept half with a flat face at the cut, so it shows as solid.
    Pd = P['pedestal']
    half_cylinder('rpv_skirt', Pd['r'], Pd['h'], 'deck', x, 0, Pd.get('z0', -0.02))
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


# ---------------------------------------------------------------------------
# the boiler
# ---------------------------------------------------------------------------
def build_boiler():
    global _col
    _col = collection('boiler')
    S = L['sg']
    x, base = S['x'], S['base']
    # the shell as a WALL (see build_reactor), with a nozzle bored for each
    # of the four lines that meet it: the two primary legs into the channel
    # head, the feed into the shell, the steam out of the top
    t = S.get('wall', 0.15)
    shell, _, _ = hollow('sg_shell', S['profile'], t, 'shell', x, base, 0, segments=64)
    for pipe_name, spec, end in (('pipe_hot', L['pipes']['hot'], 1), ('pipe_cold', L['pipes']['cold'], 0),
                                 ('pipe_feed', L['pipes']['feed'], 1), ('pipe_steam', L['pipes']['steam'], 0)):
        bore(shell, pipe_name, spec, end, t)
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
    # two columns in the kept half, up into the underside of the head
    C = S['columns']
    for i, dx in enumerate((-1, 1)):
        cylinder('sg_col_%d' % i, C['r'], C['r'], C['top'], 'painted', x + dx * C['dx'], C['top'] / 2, C['z'], segments=16)


# ---------------------------------------------------------------------------
# a pump: volute, impeller, motor, lamp
# ---------------------------------------------------------------------------
def build_pump(prefix, x, y, z, sc, noz=(), can=0.0):
    """noz: the lines that meet this volute, as (pipe name, layout spec, which
    end), each bored through the drum's wall where it does. can: metres from
    the impeller down to a suction bowl, for a vertical can pump: the drum
    runs on down that far (and a little more) below its floor, through the
    hall floor into the ground, and the lines meet it where they always did."""
    P = L['pump']
    t = max(0.04, P.get('wall', 0.08) * sc)
    h = P['casing_h'] * sc
    ext = max(0.0, can + 0.2 - h / 2) if can else 0.0
    casing, _, _ = drum(prefix + '_casing', P['casing_r'] * sc, P['casing_r'] * sc, h + ext, t, 'painted', x, y - ext / 2, z, segments=48)
    for pipe_name, spec, end in noz:
        # a line that comes up into a can pump from below crosses the CAN's
        # floor, ext further down than the drum's: bore that far
        pts = spec['pts']
        a = pts[0] if end == 0 else pts[-1]
        b = pts[1] if end == 0 else pts[-2]
        from_below = ext > 0 and abs(a[1] - b[1]) > max(abs(a[0] - b[0]), abs(a[2] - b[2])) and a[1] > b[1]
        bore(casing, pipe_name, spec, end, t, out_len=(ext + 2 * t + 0.5) if from_below else None)
    # the shaft passes through the top of the drum
    bore_at(casing, prefix + '_shaft', 0.28 * sc + 0.02, x, y + P['casing_h'] * sc / 2 + t / 2, z, 'y', 4 * t + 0.2)
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
    build_pump('rcp', R['x'], R['y'], R['z'], R['scale'],
               noz=(('pipe_cold', L['pipes']['cold'], 1), ('pipe_coldB', L['pipes']['coldB'], 0)))
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
    # the casing: a cone along x with a WALL, closed at both ends, dark
    # inside; the steam bored in through its top near the narrow end, the
    # exhaust out through its floor near the wide one, the shaft through
    # both ends
    t = T.get('wall', 0.12)
    casing, _, _ = drum('turb_casing', T['r0'], T['r1'], x1 - x0, t, 'casing_dark', (x0 + x1) / 2, ax, 0, segments=48, axis='x')
    bore(casing, 'pipe_steam', L['pipes']['steam'], 1, t)
    bore(casing, 'pipe_exhaust', L['pipes']['exhaust'], 0, t)
    S = T['shaft']
    bore_at(casing, 'turb_shaft', S['r'] + 0.02, S['x'], ax, 0, 'x', S['len'] + 1.0)
    # The table: a beam behind the cut on two columns to the ground, a block
    # under each bearing up to its housing, a block under the generator.
    Tb = T['table']
    beam_y = Tb['top'] - Tb['h']
    box('tg_beam', Tb['x1'] - Tb['x0'], Tb['h'], Tb['d'], 'deck', (Tb['x0'] + Tb['x1']) / 2, beam_y + Tb['h'] / 2, Tb['z'])
    for i, cx in enumerate(Tb['columns']['x']):
        box('tg_col_%d' % i, Tb['columns']['w'], beam_y, Tb['d'], 'deck', cx, beam_y / 2, Tb['z'])
    B = T['bearings']
    for i, px in enumerate(B['x']):
        bh = (ax - B['cap']['r']) - Tb['top']
        box('turb_bearing_%d' % i, B['block']['w'], bh, B['block']['d'], 'deck', px, Tb['top'] + bh / 2, B['block']['z'])
        cylinder('turb_bearing_cap_%d' % i, B['cap']['r'], B['cap']['r'], B['cap']['len'], 'painted', px, ax, 0, segments=24, axis='x')
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
    gb = Tb['gen_block']
    gh = (ax - G['h'] / 2) - Tb['top']
    box('gen_block', gb['w'], gh, gb['d'], 'deck', G['x'], Tb['top'] + gh / 2, gb['z'])
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
    t = C.get('wall', 0.06)
    shell, _, _ = drum('cond_shell', r, r, ln, t, 'painted', x, y, 0, segments=48, axis='x', open_ends=True)
    bore(shell, 'pipe_exhaust', L['pipes']['exhaust'], 1, t)
    # the two end plates, a quarter of a metre thick: the condensate leaves
    # through the pump-side one, the sea comes and goes through the other
    plates = []
    for i, px in enumerate((x - ln / 2 - C['plate_t'] / 2, x + ln / 2 + C['plate_t'] / 2)):
        plates.append(cylinder('cond_plate_%d' % i, r + t + 0.04, r + t + 0.04, C['plate_t'], 'plate', px, y, 0, segments=48, axis='x'))
    bore(plates[0], 'pipe_cond_suct', L['pipes']['cond_suct'], 0, C['plate_t'])
    bore(plates[1], 'pipe_cw_disch', L['pipes']['cw_disch'], 1, C['plate_t'])
    bore(plates[1], 'pipe_cw_out', L['pipes']['cw_out'], 0, C['plate_t'])
    # the three nested runs of the bank: in low, round, out high
    for k in range(3):
        lo, hi, xl = C['rows_lo'][k], C['rows_hi'][k], C['turn_x'][k]
        z = C['tube_z']
        pts = [[C['plate_r'], lo, z], [xl, lo, z], [xl, hi, z], [C['plate_r'], hi, z]]
        fluid_rod('cond_tube_%d' % k, pts, C['tube_r'], (hi - lo) * 0.45, material='steel')
    # the exhaust duct from the casing floor into the shell top, and a flange where it lands
    pipe('pipe_exhaust', L['pipes']['exhaust'], material='pipe_steam')
    # the saddles the shell rests on
    for i, px in enumerate((x - ln * 0.32, x + ln * 0.32)):
        sd = C['saddle']
        box('cond_saddle_%d' % i, sd['w'], y - r + 0.4, sd['d'], 'deck', px, (y - r + 0.4) / 2, sd['z'])


# ---------------------------------------------------------------------------
# the condensate pump, the sea, the circulating pump, the two sea lines
# ---------------------------------------------------------------------------
def build_sea():
    global _col
    _col = collection('sea')
    Cp = L['cond_pump']
    build_pump('cpump', Cp['x'], Cp['y'], 0, Cp['scale'],
               noz=(('pipe_cond_suct', L['pipes']['cond_suct'], 1), ('pipe_feed', L['pipes']['feed'], 0)), can=Cp.get('can', 0.0))
    pipe('pipe_cond_suct', L['pipes']['cond_suct'], material='pipe')
    pipe('pipe_feed', L['pipes']['feed'], material='pipe')
    pipe('pipe_steam', L['pipes']['steam'], material='pipe_steam')
    S = L['sea']
    Wl = S['wall']
    box('bay_wall', Wl['w'], Wl['h'], Wl['d'], 'deck', S['bay_x'], S['y'] - Wl['h'] / 2, S['bay']['z'])
    Pm = S['pump']
    build_pump('cwpump', Pm['x'], Pm['y'], 0, Pm['scale'],
               noz=(('pipe_cw_suct', L['pipes']['cw_suct'], 1), ('pipe_cw_disch', L['pipes']['cw_disch'], 0)), can=Pm.get('can', 0.0))
    half_cylinder('cwpump_plinth', 1.3, 0.4, 'deck', Pm['x'], 0)
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
    floor = box('pool_floor', pool['w'], 0.5, pool['d'], 'painted', pool['x'], pool['y'] + 0.25, 0)
    # the loop's two legs and the gravity line pass through the floor, each
    # in a bore of its own radius; their casings run on through
    for pipe_name, spec, end in (('pipe_prhr_up', P['prhr_up'], 1), ('pipe_prhr_down', P['prhr_down'], 0), ('pipe_gravity', P['gravity'], 0)):
        bore(floor, pipe_name, spec, end, 0.5)
    for i, (ax_, az) in enumerate(((1, 0), (-1, 0), (0, 1), (0, -1))):
        w = t if ax_ else pool['w'] + t
        d = t if az else pool['d'] + t
        box('pool_wall_%d' % i, w, pool['h'], d, 'tank', pool['x'] + ax_ * (pool['w'] / 2),
            pool['y'] + pool['h'] / 2, az * (pool['d'] / 2))
    for i, (dx, dz) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        c = pool['columns']
        cylinder('pool_col_%d' % i, c['r'], c['r'], pool['y'], 'painted',
                 pool['x'] + dx * (pool['w'] / 2 - c['inset']), pool['y'] / 2, dz * (pool['d'] / 2 - c['inset']), segments=12)
    # The residual heat loop: up out of the vessel, one hairpin dipping into
    # the pool (the app draws its water; the model only carries the two
    # casings through the pool floor), and back into the vessel lower down.
    pipe('pipe_prhr_up', P['prhr_up'], material='pipe')
    hp = P['hairpin']
    fluid_rod('coil', hp['pts'], hp['r'], hp['bend'], material='steel')
    pipe('pipe_prhr_down', P['prhr_down'], material='pipe')
    # One straight line from the pool floor down into the vessel head, with
    # the valve on it. The valve's stem lies along -x so the wheel clears the
    # pool above it.
    pipe('pipe_gravity', P['gravity'], material='pipe')
    pipe('pipe_fill', P['fill'], material='pipe')
    Vv = P['valve']
    sphere('grav_valve', Vv['r'], 'painted', Vv['x'], Vv['y'], 0)
    sx = Vv['x'] - Vv['r'] - Vv['stem_h'] / 2 + 0.2
    cylinder('grav_stem', 0.11, 0.11, Vv['stem_h'], 'steel', sx, Vv['y'], 0, segments=10, axis='x')
    torus('grav_wheel', Vv['wheel_r'], 0.09, 'rail', Vv['x'] - Vv['r'] - Vv['stem_h'] + 0.2, Vv['y'], 0, axis='x')


def build_active():
    global _col
    _col = collection('active')
    A = L['active']
    T = A['tank']
    tz = T.get('z', 0.0)
    box('tank_floor', T['w'], 0.4, T['d'], 'painted', T['x'], 0.2, tz)
    walls = []
    for i, (ax_, az) in enumerate(((1, 0), (-1, 0), (0, 1), (0, -1))):
        w = T['lip'] if ax_ else T['w'] + T['lip'] * 2
        d = T['lip'] if az else T['d'] + T['lip'] * 2
        walls.append(box('tank_wall_%d' % i, w, T['h'], d, 'tank', T['x'] + ax_ * (T['w'] / 2 + T['lip'] / 2), T['h'] / 2, tz + az * (T['d'] / 2 + T['lip'] / 2)))
    # the suction leaves through the wall nearest the pump, in a bore
    bore(walls[0], 'pipe_suction', A['suction'], 0, T['lip'])
    E = A['eccs']
    build_pump('eccs', E['x'], E['y'], 0, E['scale'],
               noz=(('pipe_suction', A['suction'], 1), ('pipe_injection', A['injection'], 0)))
    pipe('pipe_suction', A['suction'], material='pipe')
    pipe('pipe_injection', A['injection'], material='pipe')


ALL_PARTS = ['building', 'reactor', 'boiler', 'rcp', 'loop', 'turbine', 'condenser', 'sea', 'vent']


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# the cuts: every casing ends exactly where it meets the thing it enters
# ---------------------------------------------------------------------------
# Which closed solids each pipe's casing is cut by (boolean difference). A
# casing is built along the full centreline, into the water it serves, and
# then everything of it inside these solids is removed, so the steel stops at
# the surface with a true saddle and nothing shows inside a cut-open vessel.
# Names starting _cut_ are proxies built here (a closed cylinder standing in
# for an open pump volute, a block for the wall where a line goes through it)
# and are never exported.
CUTS = {
    'pipe_hot': ['_cut_rpv_shell_inner', '_cut_sg_shell_inner'],
    'pipe_cold': ['_cut_sg_shell_inner', '_cut_rcp_casing_inner'],
    'pipe_coldB': ['_cut_rcp_casing_inner', '_cut_rpv_shell_inner'],
    'pipe_steam': ['_cut_sg_shell_inner', '_cut_turb_casing_inner'],
    'pipe_feed': ['_cut_cpump_casing_inner', '_cut_sg_shell_inner'],
    'pipe_exhaust': ['_cut_turb_casing_inner', '_cut_cond_shell_inner'],
    'pipe_cond_suct': ['_cut_cond_shell_inner', '_cut_cpump_casing_inner'],
    'pipe_cw_suct': ['_cut_cwpump_casing_inner'],
    'pipe_cw_disch': ['_cut_cwpump_casing_inner', '_cut_cond_shell_inner'],
    'pipe_cw_out': ['_cut_cond_shell_inner'],
    'pipe_vent': [],
    'pipe_prhr_up': ['_cut_rpv_shell_inner'],
    'pipe_prhr_down': ['_cut_rpv_shell_inner'],
    'pipe_gravity': ['grav_valve'],
    'pipe_fill': ['grav_valve', '_cut_rpv_shell_inner'],
    'pipe_suction': ['_cut_tank_inner', '_cut_eccs_casing_inner'],
    'pipe_injection': ['_cut_eccs_casing_inner', '_cut_coldB'],
    'sg_col_0': ['_cut_sg_shell_outer'],
    'sg_col_1': ['_cut_sg_shell_outer'],
    # the pedestal is cut by the vessel, so it cradles the bottom head
    'rpv_skirt': ['_cut_rpv_shell_outer'],
    # the boiler's columns end at the underside of its head, not inside it
    'sg_col_0': ['sg_shell'],
    'sg_col_1': ['sg_shell'],
}


def curve_to_mesh(ob):
    """Replace a bevelled curve object by the mesh it evaluates to (same name,
    parent, collection, material), so modifiers can be put on it."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    mats = list(ob.data.materials)
    new = bpy.data.objects.new(ob.name + '_mesh', me)
    for c in ob.users_collection:
        c.objects.link(new)
    new.parent = ob.parent
    new.matrix_world = ob.matrix_world.copy()
    if not me.materials:
        for m in mats:
            me.materials.append(m)
    name = ob.name
    bpy.data.objects.remove(ob)
    new.name = name
    for poly in me.polygons:
        poly.use_smooth = True
    return new


def proxy(ob):
    ob.name = '_cut_' + ob.name if not ob.name.startswith('_cut_') else ob.name
    ob.hide_viewport = True
    ob.hide_render = True
    return ob


def cut_pipes():
    global _col
    _col = collection('cuts')
    # The vessels, drums and plates keep their own cavities (_cut_<name>_inner,
    # from hollow() and drum()). The tank's is built here: above its floor,
    # inside its walls.
    T = L['active']['tank']
    proxy(box('_cut_tank_inner', T['w'], T['h'] - 0.4, T['d'], 'deck', T['x'], 0.4 + (T['h'] - 0.4) / 2, T.get('z', 0.0)))
    cb = L['pipes']['coldB']['pts']
    proxy(cylinder('_cut_coldB', L['pipes']['coldB']['dia'] / 2, L['pipes']['coldB']['dia'] / 2, abs(cb[1][0] - cb[0][0]) + 1.0, 'deck',
                   (cb[0][0] + cb[1][0]) / 2, cb[0][1], 0, segments=32, axis='x'))
    # The containment wall is the app's (it draws the cut face through a
    # stencil), and where a line passes through it the app draws the sleeve;
    # the casing runs on through, whole.
    n = 0
    for name, targets in CUTS.items():
        ob = bpy.data.objects.get(name)
        if ob is None:
            continue
        if ob.type == 'CURVE':
            ob = curve_to_mesh(ob)
        for tn in targets:
            tgt = bpy.data.objects.get(tn)
            if tgt is None:
                continue
            mod = ob.modifiers.new('cut_' + tn, 'BOOLEAN')
            mod.operation = 'DIFFERENCE'
            mod.solver = 'EXACT'
            mod.object = tgt
            # the faces the cut makes take the cutter's material, which is
            # how they are told apart below
            mod.material_mode = 'TRANSFER'
            n += 1
        if name.startswith('pipe_'):
            open_ends(ob)
    print('cuts:', n)


def open_ends(ob):
    """Apply a pipe's cuts and throw away the faces the cutter left on it:
    those are the closed caps where the casing meets a wall, and a pipe that
    meets a vessel is OPEN into it, not blanked off. From inside the cut
    trough a cap read as a plate blocking the pipe. The casing's own faces
    carry its own material; the cap faces carry the cutter's."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    own = ob.data.materials[0] if ob.data.materials else None
    keep = [i for i, m in enumerate(me.materials) if m == own]
    bm = bmesh.new()
    bm.from_mesh(me)
    gone = [f for f in bm.faces if f.material_index not in keep]
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    if own is not None and (not me.materials or me.materials[0] != own):
        me.materials.clear()
        me.materials.append(own)
    bpy.data.meshes.remove(old)


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
    cut_pipes()
    print('built', parts)


def export(path):
    bpy.ops.object.select_all(action='SELECT')
    for ob in bpy.data.objects:
        if ob.name.startswith('_cut_'):
            ob.select_set(False)
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
