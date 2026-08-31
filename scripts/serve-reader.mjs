import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const host = process.env.READEST_READER_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.READEST_READER_PORT || '3001', 10);
const root = resolve(process.env.READEST_READER_DIST || 'out');

if (!existsSync(join(root, 'readest', 'reader.html'))) {
  console.error('Reader build not found. Run `pnpm build` first.');
  process.exit(1);
}

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/readest' || pathname === '/readest/' || pathname === '/readest/reader') {
    pathname = '/readest/reader.html';
  }
  const candidate = normalize(join(root, pathname));
  if (!candidate.startsWith(`${root}/`) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': mime[extname(candidate)] || 'application/octet-stream',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  createReadStream(candidate).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Readest Reader listening on http://${host}:${port}/readest/reader`);
});
