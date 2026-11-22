import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { buildWorker } from './build-sw.mjs';
import appPaths from '../src/routes.json' with { type: 'json' };

// Exercise the generated production worker, with the network/cache lifecycle
// controlled by this harness. This does not replace real-browser PWA checks.
const buildId = 'fixture-build';
const chunk = '/_next/static/chunks/app/(journal)/page.js';
const html = (id, label) => `<!doctype html><html><body>${label} (build ${id})</body></html>`;
const bodies = new Map([
  [chunk, 'console.log("test fixture");'],
  ['/manifest.webmanifest', '{"name":"Stilllight fixture"}'],
]);
const snapshot = (path, ext = 'html') =>
  '/_next/static/' + buildId + '/offline/' + (path.slice(1) || 'index') + '.' + ext;
for (const path of appPaths) {
  bodies.set(snapshot(path), html(buildId, 'Offline ' + path));
  bodies.set(snapshot(path, 'rsc'), 'Full Flight tree for ' + path);
}
let testRoot;
let code;

before(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'stilllight-sw-test-'));
  for (const [url, body] of bodies) {
    const file = join(
      testRoot,
      url.startsWith('/_next/')
        ? decodeURIComponent(url).replace('/_next/', '.next/')
        : 'public' + url,
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  await writeFile(join(testRoot, 'public', '_headers'), '/sw.js\n  Cache-Control: no-cache');
  await buildWorker(testRoot, buildId);
  code = await readFile(join(testRoot, 'public', 'sw.js'), 'utf8');
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
  let liveBuild = buildId;
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
      if (appPaths.includes(path))
        return new Response(html(liveBuild, 'Live response for ' + request.url), {
          headers: { 'x-arcana-build': liveBuild },
        });
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
  const request = async (path, mode = 'navigate', headers = {}) => {
    let response;
    listeners.get('fetch')({
      request: {
        url: new URL(path, 'https://stilllight.test').href,
        method: 'GET',
        mode,
        headers: new Headers(headers),
      },
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
    deploy: (id) => {
      liveBuild = id;
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
  for (const path of appPaths) {
    assert.equal(
      await (await sw.request(path + '?reading=active')).text(),
      bodies.get(snapshot(path)),
    );
    const flight = await sw.request(path + '?_rsc=cachebust', 'cors', {
      rsc: '1',
      'next-router-state-tree': 'current-tree',
    });
    assert.equal(flight.headers.get('Content-Type'), 'text/x-component');
    assert.equal(await flight.text(), bodies.get(snapshot(path, 'rsc')));
  }
  const trailing = await sw.request('/deck/?view=all');
  assert.equal(trailing.status, 307);
  assert.equal(trailing.headers.get('Location'), 'https://stilllight.test/deck?view=all');
  const unknown = await sw.request('/some-old-bookmark');
  assert.equal(unknown.status, 307);
  assert.equal(unknown.headers.get('Location'), 'https://stilllight.test/');
  assert.equal(
    await (await sw.request(chunk.replace('(', '%28').replace(')', '%29'), 'cors')).text(),
    bodies.get(chunk),
  );
  assert.equal((await sw.status()).ready, true);
});

test('partial prefetch, action, and query-specific requests are never answered with an offline Flight payload', async () => {
  const sw = harness();
  await sw.dispatch('install');
  sw.setOnline(false);
  for (const header of ['next-router-prefetch', 'next-router-segment-prefetch', 'next-action']) {
    assert.equal(await sw.request('/deck', 'cors', { rsc: '1', [header]: '1' }), undefined);
  }
  assert.equal(await sw.request('/deck?q=private', 'cors', { rsc: '1' }), undefined);
  assert.equal(await sw.request('/deck', 'cors'), undefined);
});

test('online navigation returns fresh SSR while offline snapshots stay anonymous and match the active build', async () => {
  const sw = harness();
  await sw.dispatch('install');
  const path = '/journal?note=private';
  assert.match(await (await sw.request(path)).text(), /Live response.*note=private/);
  sw.deploy('different-build');
  assert.equal(await (await sw.request(path)).text(), bodies.get(snapshot('/journal')));
  const oldFlight = await sw.request('/journal?_rsc=new-deployment', 'cors', { rsc: '1' });
  assert.equal(await oldFlight.text(), bodies.get(snapshot('/journal', 'rsc')));
  sw.setOnline(false);
  assert.equal(await (await sw.request(path)).text(), bodies.get(snapshot('/journal')));
  assert.equal(sw.ownCache.has(path), false);
});

test('a missing required entry cannot report ready offline and can be repaired online', async () => {
  const sw = harness();
  await sw.dispatch('install');
  sw.ownCache.delete(chunk);
  sw.setOnline(false);
  assert.equal((await sw.status()).ready, false);
  sw.setOnline(true);
  assert.equal((await sw.status()).ready, true);
  assert.equal(await sw.ownCache.get(chunk).text(), bodies.get(chunk));
});

test('an HTTP 200 response with substituted bytes fails installation before cache writes', async () => {
  const sw = harness();
  sw.substitute(chunk);
  await assert.rejects(sw.dispatch('install'), /Unable to cache required asset/);
  assert.equal(sw.ownCache.size, 0);
  assert.equal((await sw.status()).ready, false);
});

test('a failed installation never erases an existing same-version cache', async () => {
  const sw = harness();
  await sw.dispatch('install');
  sw.substitute(chunk);
  await assert.rejects(sw.dispatch('install'), /Unable to cache required asset/);
  assert.equal((await sw.status()).ready, true);
  assert.equal(await sw.ownCache.get(chunk).text(), bodies.get(chunk));
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
  await writeFile(
    join(testRoot, '.next/static/chunks/app/(journal)/page.js'),
    'console.log("new build");',
  );
  await buildWorker(testRoot, buildId);
  const changed = await readFile(join(testRoot, 'public', 'sw.js'), 'utf8');
  const afterVersion = changed.match(/const CACHE_NAME = CACHE_PREFIX \+ '([^']+)'/)[1];
  assert.notEqual(beforeVersion, afterVersion);
});
