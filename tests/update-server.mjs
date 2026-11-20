// Test-only deployment simulator. Never import this into the app or put it in dist.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const root = resolve('dist');
const originalWorker = await readFile(resolve(root, 'sw.js'), 'utf8');
const version = /const CACHE_NAME = CACHE_PREFIX \+ '([^']+)'/.exec(originalWorker)?.[1];
if (!version) throw new Error('Build the app before running the service-worker update test.');

// Assets remain byte-for-byte identical; only the generated worker version changes.
// Keeping CACHE_PREFIX unchanged exercises the real activation cleanup of old caches.
const nextVersion = `${version}-update-test-v2`;
const updatedWorker = originalWorker.replaceAll(`'${version}'`, `'${nextVersion}'`);
let deployment = 1;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1:4175').pathname;
  if (pathname === '/__test__/ready') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ready: true, deployment, version, nextVersion }));
    return;
  }
  if (pathname === '/__test__/deploy/1' || pathname === '/__test__/deploy/2') {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    deployment = pathname.endsWith('/2') ? 2 : 1;
    response.writeHead(204).end();
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  if (pathname === '/sw.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.setHeader('Service-Worker-Allowed', '/');
    response.end(deployment === 1 ? originalWorker : updatedWorker);
    return;
  }
  try {
    const file = resolve(
      root,
      `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`,
    );
    if (!file.startsWith(`${root}${sep}`) || !(await stat(file)).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.setHeader('Content-Type', contentTypes[extname(file)] ?? 'application/octet-stream');
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  } catch {
    response.writeHead(404).end('Not found');
  }
});
server.listen(4175, '127.0.0.1', () => console.log('Update test server: http://127.0.0.1:4175'));
