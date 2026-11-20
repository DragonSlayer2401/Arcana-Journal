import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createContext, runInContext } from 'node:vm';

// Exercise the generated production worker, with the network/cache lifecycle
// controlled by this harness. This does not replace real-browser PWA checks.
const execute = promisify(execFile);
const generator = fileURLToPath(new URL('./build-sw.mjs', import.meta.url));
const bodies = new Map([
  ['/index.html', '<!doctype html><html><body>Stilllight test</body></html>'],
  ['/assets/app.js', 'console.log("test fixture");'],
  ['/manifest.webmanifest', '{"name":"Stilllight fixture"}'],
]);
let testRoot;
let code;

before(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'stilllight-sw-test-'));
  await mkdir(join(testRoot, 'dist', 'assets'), { recursive: true });
  for (const [url, body] of bodies) await writeFile(join(testRoot, 'dist', url.slice(1)), body);
  await writeFile(join(testRoot, 'dist', '_headers'), '/sw.js\n  Cache-Control: no-cache');
  await execute(process.execPath, [generator], { cwd: testRoot });
  code = await readFile(join(testRoot, 'dist', 'sw.js'), 'utf8');
});

after(async () => {
  if (!testRoot) return;
  // Verify the absolute recursive-delete target is the exact temp child we made.
  const resolved = resolve(testRoot);
  const withinTemp = relative(resolve(tmpdir()), resolved);
  assert.equal(withinTemp, basename(resolved));
  assert.ok(basename(resolved).startsWith('stilllight-sw-test-'));
  await rm(resolved, { recursive: true, force: true });
});

const harness = () => {
  const stores = new Map();
  const listeners = new Map();
  const fetches = [];
  let online = true;
  let substitutePath = null;
  let claimed = false;
  let skipWaitingCalls = 0;
  const context = createContext({
    crypto: webcrypto,
    URL,
    Uint8Array,
    Response,
    Request: class extends Request {
      constructor(url, options) {
        super(new URL(url, 'https://stilllight.test'), options);
      }
    },
    fetch: async (request) => {
      if (!online) throw new Error('Offline fixture');
      const path = new URL(request.url).pathname;
      fetches.push(path);
      return new Response(
        substitutePath === path ? '<html>Unexpected fallback</html>' : bodies.get(path),
        {
          status: bodies.has(path) ? 200 : 404,
        },
      );
    },
    caches: {
      open: async (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name);
        return {
          match: async (url) => store.get(url)?.clone(),
          put: async (url, response) => {
            store.set(url, response.clone());
          },
        };
      },
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
    },
    self: {
      location: { origin: 'https://stilllight.test' },
      clients: {
        claim: async () => {
          claimed = true;
        },
      },
      skipWaiting: async () => {
        skipWaitingCalls += 1;
      },
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
  });
  runInContext(code, context);
  const dispatch = async (type, details = {}) => {
    let pending;
    listeners.get(type)({
      ...details,
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;
  };
  const status = async () => {
    let value;
    await dispatch('message', {
      data: { type: 'CHECK_OFFLINE' },
      ports: [
        {
          postMessage: (data) => {
            value = data;
          },
        },
      ],
    });
    return value;
  };
  const request = async (path, mode = 'navigate') => {
    let response;
    listeners.get('fetch')({
      request: { url: new URL(path, 'https://stilllight.test').href, method: 'GET', mode },
      respondWith: (promise) => {
        response = promise;
      },
    });
    return response;
  };
  return {
    stores,
    fetches,
    dispatch,
    status,
    request,
    setOnline: (value) => {
      online = value;
    },
    substitute: (path) => {
      substitutePath = path;
    },
    get claimed() {
      return claimed;
    },
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
    get ownCache() {
      return [...stores.entries()].find(([key]) => key.startsWith('stilllight-assets-'))?.[1];
    },
  };
};

test('the generated precache includes all runtime assets and excludes hosting instructions', async () => {
  const sw = harness();
  await sw.dispatch('install');
  assert.deepEqual([...sw.ownCache.keys()].sort(), [...bodies.keys()].sort());
  assert.equal(sw.fetches.includes('/_headers'), false);
  assert.equal((await sw.status()).ready, true);
});

test('offline navigation and assets are served from the installed version', async () => {
  const sw = harness();
  await sw.dispatch('install');
  sw.setOnline(false);
  assert.equal(await (await sw.request('/?reading=active')).text(), bodies.get('/index.html'));
  assert.equal(
    await (await sw.request('/assets/app.js', 'cors')).text(),
    bodies.get('/assets/app.js'),
  );
  assert.equal((await sw.status()).ready, true);
});

test('a missing required entry cannot report ready offline and can be repaired online', async () => {
  const sw = harness();
  await sw.dispatch('install');
  sw.ownCache.delete('/assets/app.js');
  sw.setOnline(false);
  assert.equal((await sw.status()).ready, false);
  sw.setOnline(true);
  assert.equal((await sw.status()).ready, true);
  assert.equal(await sw.ownCache.get('/assets/app.js').text(), bodies.get('/assets/app.js'));
});

test('an HTTP 200 response with substituted bytes fails installation before cache writes', async () => {
  const sw = harness();
  sw.substitute('/assets/app.js');
  await assert.rejects(sw.dispatch('install'), /Unable to cache required asset/);
  assert.equal(sw.ownCache.size, 0);
  assert.equal((await sw.status()).ready, false);
});

test('a failed installation never erases an existing same-version cache', async () => {
  const sw = harness();
  await sw.dispatch('install');
  sw.substitute('/assets/app.js');
  await assert.rejects(sw.dispatch('install'), /Unable to cache required asset/);
  assert.equal((await sw.status()).ready, true);
  assert.equal(await sw.ownCache.get('/assets/app.js').text(), bodies.get('/assets/app.js'));
});

test('updates never skip waiting; obsolete caches are removed only at activation', async () => {
  const sw = harness();
  sw.stores.set(
    'stilllight-assets-previous-version',
    new Map([['/index.html', new Response('old')]]),
  );
  sw.stores.set('another-application-cache', new Map());
  await sw.dispatch('install');
  assert.equal(sw.skipWaitingCalls, 0);
  assert.equal(sw.stores.has('stilllight-assets-previous-version'), true);
  assert.equal(sw.claimed, false);
  await sw.dispatch('activate');
  assert.equal(sw.stores.has('stilllight-assets-previous-version'), false);
  assert.equal(sw.stores.has('another-application-cache'), true);
  assert.equal(sw.claimed, true);
  assert.equal((await sw.status()).ready, true);
});

test('asset content changes produce a different cache version', async () => {
  const beforeVersion = code.match(/const CACHE_NAME = CACHE_PREFIX \+ '([^']+)'/)[1];
  await writeFile(join(testRoot, 'dist', 'assets', 'app.js'), 'console.log("new build");');
  await execute(process.execPath, [generator], { cwd: testRoot });
  const changed = await readFile(join(testRoot, 'dist', 'sw.js'), 'utf8');
  const afterVersion = changed.match(/const CACHE_NAME = CACHE_PREFIX \+ '([^']+)'/)[1];
  assert.notEqual(beforeVersion, afterVersion);
});
