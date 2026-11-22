// Test-only deployment simulator around the production Next server.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import next from 'next';
import appPaths from '../src/routes.json' with { type: 'json' };

const originalWorker = await readFile('public/sw.js', 'utf8');
const version = /const CACHE_NAME = CACHE_PREFIX \+ '([^']+)'/.exec(originalWorker)?.[1];
if (!version) throw new Error('Build the app before running the service-worker update test.');

// Keep the compiled assets identical so the test can deploy a new document
// build marker and worker version without recompiling the app mid-test.
const nextVersion = `${version}-update-test-v2`;
const buildId = (await readFile('.next/BUILD_ID', 'utf8')).trim();
const nextBuild = buildId + '-v2';
const updatedWorker = originalWorker
  .replaceAll(`'${version}'`, `'${nextVersion}'`)
  .replace(
    `const BUILD_ID = ${JSON.stringify(buildId)};`,
    `const BUILD_ID = ${JSON.stringify(nextBuild)};`,
  );
let deployment = 1;
const app = next({ dev: false, hostname: '127.0.0.1', port: 4175 });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer(async (request, response) => {
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
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.setHeader('Service-Worker-Allowed', '/');
    response.end(deployment === 1 ? originalWorker : updatedWorker);
    return;
  }
  if (deployment === 2 && appPaths.includes(pathname)) {
    // Simulate a new SSR deployment while old clients still use their hashed
    // snapshots. Next itself provides the HTML, Flight payloads and assets.
    const setHeader = response.setHeader.bind(response);
    response.setHeader = (name, value) =>
      setHeader(name, name.toLowerCase() === 'x-arcana-build' ? nextBuild : value);
  }
  await handle(request, response);
});
server.listen(4175, '127.0.0.1', () => console.log('Update test server: http://127.0.0.1:4175'));
