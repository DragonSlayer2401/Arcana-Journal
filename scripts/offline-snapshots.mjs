import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import next from 'next';
import appPaths from '../src/routes.json' with { type: 'json' };

// Render only anonymous, canonical URLs against the finished production build.
// User navigations (and their cookies or query strings) never populate this cache.
export async function writeOfflineSnapshots(buildDir, buildId) {
  const directory = join(buildDir, 'static', buildId, 'offline');
  await mkdir(directory, { recursive: true });
  const app = next({ dev: false, hostname: '127.0.0.1' });
  const server = createServer(app.getRequestHandler());
  try {
    await app.prepare();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    let deploymentId;
    for (const path of appPaths) {
      const name = path.slice(1) || 'index';
      // With no router-state or prefetch headers, Next renders the whole route
      // tree. Partial responses from a user's current navigation are never saved.
      for (const [extension, mime, headers] of [
        ['html', 'text/html', {}],
        ['rsc', 'text/x-component', { RSC: '1' }],
      ]) {
        const url = origin + path + (extension === 'rsc' ? '?_rsc' : '');
        const response = await fetch(url, { headers, redirect: 'error' });
        if (
          !response.ok ||
          response.headers.get('x-arcana-build') !== buildId ||
          !response.headers.get('content-type')?.startsWith(mime)
        ) {
          throw new Error('Could not render offline ' + extension + ' for ' + path);
        }
        if (extension === 'rsc') deploymentId = response.headers.get('x-nextjs-deployment-id');
        await writeFile(
          join(directory, name + '.' + extension),
          Buffer.from(await response.arrayBuffer()),
        );
      }
    }
    return deploymentId;
  } finally {
    if (server.listening) await new Promise((done) => server.close(done));
    await app.close();
  }
}
