#!/usr/bin/env node
/**
 * Serves the exported web build of the driver app and forwards /api to a LOCAL NeWay API, so the
 * browser can use the app without CORS (README › Web). Local demos only; never production.
 *
 *   MSYS_NO_PATHCONV=1 EXPO_PUBLIC_API_URL=/api/v1 npx expo export --platform web --output-dir dist-web
 *   node scripts/web-demo-server.mjs [dist-web] [port]       # API_TARGET=http://localhost:3000
 *
 * http://localhost:<port> is a secure context, so the browser lets Ask NeWay use the microphone.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist-web');
const port = Number(process.argv[3] ?? process.env.PORT ?? 8093);
const target = new URL(process.env.API_TARGET ?? 'http://localhost:3000');
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname)) {
  console.error(`API_TARGET must be a local API, not ${target.hostname}.`);
  process.exit(1);
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };

http
  .createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/')) {
      const upstream = http.request(
        { hostname: target.hostname, port: target.port || 80, path: url, method: req.method, headers: { ...req.headers, host: target.host } },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502, { 'content-type': 'application/problem+json' });
        res.end(JSON.stringify({ title: 'Bad Gateway', detail: `No API at ${target.origin}` }));
      });
      req.pipe(upstream);
      return;
    }
    // Static files; every unknown path is the single-page app.
    const path = normalize(decodeURIComponent(url.split('?')[0] ?? '/')).replace(/^([/\\])+/, '');
    let file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      const html = `${file}.html`;
      file = file.startsWith(root) && existsSync(html) ? html : join(root, 'index.html');
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`Driver app (web) on http://localhost:${port} → API ${target.origin}`));
