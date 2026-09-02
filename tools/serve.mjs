/* serve.mjs - static server with correct module MIME types (python's on
 * Windows serves .mjs as text/plain, which the browser refuses for modules). */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, extname } from 'node:path';
const ROOT = process.argv[2] || '.';
const PORT = +(process.argv[3] || 8099);
const T = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.txt': 'text/plain', '.md': 'text/markdown' };
createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = join(ROOT, p);
  let st; try { st = statSync(f); } catch (e) { res.writeHead(404); res.end(); return; }
  if (st.isDirectory()) { res.writeHead(301, { Location: p + '/' }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': T[extname(f).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  createReadStream(f).pipe(res);
}).listen(PORT, '0.0.0.0', () => console.log('serving', ROOT, 'on', PORT));
