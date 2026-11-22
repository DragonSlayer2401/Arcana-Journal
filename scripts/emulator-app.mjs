import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import next from 'next';

const run = promisify(execFile);
const nextCli = createRequire(import.meta.url).resolve('next/dist/bin/next');

export const startEmulatorApp = async () => {
  const emulators = await (await fetch('http://127.0.0.1:4400/emulators')).json();
  assert.equal(emulators.auth.port, 9099);
  assert.equal(emulators.firestore.port, 8080);
  const root = resolve(import.meta.dirname, '..');
  const dir = await mkdtemp(join(tmpdir(), 'arcana-emulator-'));
  let app;
  let server;
  const close = async () => {
    if (server?.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    await app?.close();
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('arcana-emulator-'));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    // Keep SDK inspection and the adapter-only page out of every deployable build.
    for (const file of [
      'src',
      'public',
      'next.config.mjs',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
    ])
      await cp(join(root, file), join(dir, file), { recursive: true });
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
    await mkdir(join(dir, 'scripts'));
    await cp(join(root, 'scripts/emulator-kit.js'), join(dir, 'scripts/emulator-kit.js'));
    await writeFile(
      join(dir, 'src/instrumentation-client.js'),
      "import * as kit from '../scripts/emulator-kit';\nwindow.kit = kit;\n",
    );
    await mkdir(join(dir, 'src/app/test'));
    await writeFile(
      join(dir, 'src/app/test/page.jsx'),
      'export default function AdapterFixture() { return null; }\n',
    );

    const options = {
      cwd: dir,
      env: { ...process.env, NEXT_PUBLIC_FIREBASE_EMULATORS: 'true', NEXT_TELEMETRY_DISABLED: '1' },
    };
    await run(process.execPath, [nextCli, 'build', '--webpack'], options);
    await run(process.execPath, [join(root, 'scripts/build-sw.mjs')], options);
    app = next({ dir, dev: false, hostname: '127.0.0.1' });
    await app.prepare();
    server = createServer(app.getRequestHandler()).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    return { base, close };
  } catch (error) {
    await close();
    throw error;
  }
};
