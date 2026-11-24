import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelayRequest } from './src/tsa.mjs';
import { readLimited } from './src/hash.mjs';
import { tsa } from './src/providers.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(root, 'dist');
const dev = process.argv.includes('--dev');
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);
if (dev && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('开发模式只允许监听回环地址');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.pem': 'text/plain; charset=utf-8' };
const requests = new Map();
let active = 0;
const limit = setInterval(() => requests.clear(), 60_000);
limit.unref();
const send = (res, code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };

async function relay(req, res, id) {
  if (!Object.hasOwn(tsa, id)) return send(res, 404, 'Unknown TSA');
  if (req.method !== 'POST') return send(res, 405, 'POST required');
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return send(res, 403, 'Same-origin only');
  if (req.headers['content-type'] !== 'application/timestamp-query') return send(res, 415, 'Expected application/timestamp-query');
  const ip = req.socket.remoteAddress;
  if ((requests.get(ip) ?? 0) >= 30 || active >= 16) return send(res, 429, 'Too many timestamp requests');
  requests.set(ip, (requests.get(ip) ?? 0) + 1);
  active++;
  try {
    if (Number(req.headers['content-length']) > 256) return send(res, 413, 'Request too large');
    const chunks = []; let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 256) { req.resume(); return send(res, 413, 'Request too large'); }
      chunks.push(chunk);
    }
    const query = Buffer.concat(chunks);
    try { checkRelayRequest(query); } catch { return send(res, 400, 'Invalid timestamp query'); }
    const response = await fetch(tsa[id].url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' }, body: query });
    const data = Buffer.from(await (await readLimited(response, 256 * 1024)).arrayBuffer());
    res.writeHead(200, { 'Content-Type': 'application/timestamp-reply', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { if (!res.headersSent) send(res, 502, 'Timestamp authority unavailable'); }
  finally { active--; }
}

const vite = dev ? await (await import('vite')).createServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'spa' }) : null;
if (!dev) await stat(resolve(dist, 'index.html')).catch(() => { throw new Error('请先执行 npm run build'); });

const server = createServer({ requestTimeout: 25_000, headersTimeout: 10_000 }, async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!dev) res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; manifest-src 'self'; worker-src 'self'; connect-src 'self' https://a.pool.opentimestamps.org https://b.pool.opentimestamps.org https://ots.btc.catallaxy.com https://a.pool.eternitywall.com https://alice.btc.calendar.opentimestamps.org https://bob.btc.calendar.opentimestamps.org https://finney.calendar.eternitywall.com https://blockstream.info https://mempool.space; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const match = /^\/api\/tsa\/([a-z]+)$/.exec(url.pathname);
      if (match) return await relay(req, res, match[1]);
      return send(res, 404, 'Not found');
    }
    if (vite) return vite.middlewares(req, res, () => send(res, 404, 'Not found'));
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'GET or HEAD required');
    const path = resolve(dist, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!path.startsWith(dist + sep)) return send(res, 404, 'Not found');
    const file = await stat(path).catch(() => null);
    if (!file?.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Content-Length': file.size, 'Cache-Control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(path).on('error', () => res.destroy()).pipe(res);
  } catch { if (!res.headersSent) send(res, 400, 'Bad request'); }
});
server.listen(port, host, () => console.log(`Sign of Time: http://${host}:${server.address().port}`));
