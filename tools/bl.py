"""tools/bl.py - run Python in the live Blender and look at the result.

    py -3 tools/bl.py run  <file.py|-> [--shot out.png] [--window] [--out path]
    py -3 tools/bl.py shot out.png [--window]
    py -3 tools/bl.py objects

Talks to the official Blender MCP server (Blender Lab, blender-mcp) over
stdio, which relays to the add-on's TCP socket in the running Blender. The
server and add-on live outside the repo:

    ~/Apps/blender-5.2.1-windows-x64/blender.exe   Blender 5.2.1 LTS, add-on "mcp" enabled
    ~/Apps/blender-mcp/.venv/Scripts/blender-mcp.exe  the MCP server (mcp<2 pinned)

The add-on listens on BLENDER_MCP_HOST:BLENDER_MCP_PORT. On the owner's
laptop loopback is dead (a VPN), so both sides use the LAN address.

`--out path` replaces the token __OUT__ in the script with that absolute path
(tools/blender/glshot.py uses it to render the viewport offscreen, which works
when the window screenshot comes back black because something covers Blender).

`shot` saves a PNG of the 3D viewport (or the whole window with --window):
that is the visual feedback. Read the PNG before believing anything.
"""
import asyncio
import base64
import os
import sys

HOST = os.environ.get('BLENDER_MCP_HOST', '192.168.1.38')
PORT = os.environ.get('BLENDER_MCP_PORT', '9876')
SERVER = os.path.expanduser('~/Apps/blender-mcp/.venv/Scripts/blender-mcp.exe')
VENV_PY = os.path.expanduser('~/Apps/blender-mcp/.venv/Scripts/python.exe')

# The mcp client package lives in the server's venv; re-exec there if needed.
if os.path.normcase(sys.executable) != os.path.normcase(VENV_PY) and os.path.exists(VENV_PY):
    os.execv(VENV_PY, [VENV_PY] + sys.argv)

from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402


async def session(fn):
    env = dict(os.environ, BLENDER_MCP_HOST=HOST, BLENDER_MCP_PORT=PORT)
    params = StdioServerParameters(command=SERVER, args=[], env=env)
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            return await fn(s)


def text_of(res):
    return '\n'.join(getattr(c, 'text', '') for c in res.content if getattr(c, 'type', '') == 'text')


async def save_shot(s, path, window):
    res = await s.call_tool('get_screenshot_of_window_as_image' if window else 'get_screenshot_of_area_as_image',
                            {} if window else {'area_ui_type': 'VIEW_3D'})
    for c in res.content:
        if getattr(c, 'type', '') == 'image':
            with open(path, 'wb') as f:
                f.write(base64.b64decode(c.data))
            return path
    raise SystemExit('no image in response: ' + text_of(res)[:300])


def main(argv):
    cmd = argv[1] if len(argv) > 1 else 'objects'
    window = '--window' in argv
    if cmd == 'run':
        src = argv[2]
        code = sys.stdin.read() if src == '-' else open(src, encoding='utf-8').read()
        if '--out' in argv:
            code = code.replace('__OUT__', os.path.abspath(argv[argv.index('--out') + 1]).replace(os.sep, '/'))
        shot = argv[argv.index('--shot') + 1] if '--shot' in argv else None

        async def go(s):
            res = await s.call_tool('execute_blender_code', {'code': code})
            print(text_of(res)[:4000])
            if shot:
                print('shot', await save_shot(s, shot, window))
        asyncio.run(session(go))
    elif cmd == 'shot':
        path = argv[2]

        async def go(s):
            print('shot', await save_shot(s, path, window))
        asyncio.run(session(go))
    elif cmd == 'objects':
        async def go(s):
            print(text_of(await s.call_tool('get_objects_summary', {}))[:4000])
        asyncio.run(session(go))
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
