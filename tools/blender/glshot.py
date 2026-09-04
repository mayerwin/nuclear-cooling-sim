# Render the 3D viewport as it stands (view, shading, hidden collections) to a
# PNG, offscreen: unlike a window screenshot it does not care what covers the
# window. Run with:  py -3 tools/bl.py run tools/blender/glshot.py --out x.png
import bpy
out = r'__OUT__'
sc = bpy.context.scene
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1600, 1000, 100
sc.render.image_settings.file_format = 'PNG'
sc.render.filepath = out
win = bpy.context.window_manager.windows[0]
area = next(a for a in win.screen.areas if a.type == 'VIEW_3D')
region = next(r for r in area.regions if r.type == 'WINDOW')
with bpy.context.temp_override(window=win, screen=win.screen, area=area, region=region):
    bpy.ops.render.opengl(view_context=True, write_still=True)
print('viewport rendered to', out)
