// Run once all 78 illustrations are present: node scripts/check-art.mjs [--built]
// Metadata checks complement actual browser decoding and human composition review.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const project = resolve('.');
const args = process.argv.slice(2);
if (args.some((argument) => argument !== '--built')) {
  throw new Error('Usage: node scripts/check-art.mjs [--built]');
}
const checkBuiltAssets = args.includes('--built');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Read the actual stable IDs without depending on Node's optional TS loader.
// deck.ts is a self-contained data module whose only import is a type import.
const deckSource = await readFile(resolve(project, 'src/data/deck.ts'), 'utf8');
const { outputText } = ts.transpileModule(deckSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { DECK } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
if (DECK.length !== 78 || new Set(DECK.map((card) => card.id)).size !== 78) {
  throw new Error('The source deck must contain exactly 78 unique card IDs.');
}

// Header layouts: https://developers.google.com/speed/webp/docs/riff_container
// Lossless dimensions: https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification
const webpSize = (bytes) => {
  if (
    bytes.length < 20 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('Not a WebP image');
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length)
    throw new Error('Truncated WebP or unexpected trailing data');
  let dimensions;
  let hasImage = false;
  for (let offset = 12; offset < bytes.length; ) {
    if (offset + 8 > bytes.length) throw new Error('Truncated WebP chunk header');
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length + (length % 2) > bytes.length) throw new Error('Truncated WebP chunk');
    const payload = bytes.subarray(start, start + length);
    if (type === 'ANIM' || type === 'ANMF') throw new Error('Card illustrations must be static');
    if (type === 'VP8X') {
      if (length < 10) throw new Error('Invalid extended WebP header');
      if ((payload[0] & 2) !== 0) throw new Error('Card illustrations must be static');
      dimensions = { width: payload.readUIntLE(4, 3) + 1, height: payload.readUIntLE(7, 3) + 1 };
    }
    if (type === 'VP8 ') {
      if (length < 10 || payload.subarray(3, 6).toString('hex') !== '9d012a')
        throw new Error('Invalid VP8 image header');
      hasImage = true;
      dimensions ??= {
        width: payload.readUInt16LE(6) % 16384,
        height: payload.readUInt16LE(8) % 16384,
      };
    }
    if (type === 'VP8L') {
      if (length < 5 || payload[0] !== 0x2f) throw new Error('Invalid lossless WebP header');
      hasImage = true;
      const packed = payload.readUInt32LE(1);
      dimensions ??= {
        width: (packed % 16384) + 1,
        height: (Math.floor(packed / 16384) % 16384) + 1,
      };
    }
    offset = start + length + (length % 2);
  }
  if (!hasImage || !dimensions?.width || !dimensions?.height)
    throw new Error('No static WebP image data');
  return dimensions;
};

const errors = [];
const warnings = [];
const expected = new Set(DECK.map((card) => `${card.id}.webp`));
const directory = resolve(project, 'public/cards');
const present = await readdir(directory).catch(() => []);
for (const name of present) {
  if (!expected.has(name))
    errors.push(
      `Unexpected public/cards asset: ${name}. Keep source sheets and review exports outside public.`,
    );
}
let cachedAssets;
if (checkBuiltAssets) {
  const worker = await readFile(resolve(project, 'public/sw.js'), 'utf8');
  const buildId = (await readFile(resolve(project, '.next/BUILD_ID'), 'utf8')).trim();
  if (!worker.includes(`const BUILD_ID = ${JSON.stringify(buildId)};`)) {
    throw new Error('The service worker does not match the current Next.js production build.');
  }
  const manifest = /const ASSETS = (\[[\s\S]*?\]);/.exec(worker)?.[1];
  if (!manifest)
    throw new Error(
      'Cannot find the generated service-worker asset manifest. Run npm run build first.',
    );
  cachedAssets = new Map(JSON.parse(manifest).map((asset) => [asset.url, asset.sha256]));
}
const hashes = new Map();
const sizes = [];
const resolutions = new Set();
for (const card of DECK) {
  const name = `${card.id}.webp`;
  try {
    const bytes = await readFile(resolve(directory, name));
    const { width, height } = webpSize(bytes);
    if (width * 3 !== height * 2)
      errors.push(`${name}: ${width}×${height}; expected an exact 2:3 portrait ratio.`);
    if (width < 512)
      warnings.push(`${name}: ${width}×${height} may appear soft in the enlarged details view.`);
    const hash = digest(bytes);
    if (hashes.has(hash))
      errors.push(
        `${name}: identical bytes to ${hashes.get(hash)}; each card needs its own illustration.`,
      );
    hashes.set(hash, name);
    sizes.push({ name, bytes: bytes.length });
    resolutions.add(`${width}×${height}`);
    if (bytes.length > 512 * 1024)
      warnings.push(
        `${name}: ${(bytes.length / 1024).toFixed(0)} KiB; consider optimizing for the first offline download.`,
      );
    if (checkBuiltAssets) {
      if (cachedAssets.get(`/cards/${name}`) !== hash)
        errors.push(`${name}: missing or stale in the required offline cache manifest.`);
    }
  } catch (cause) {
    errors.push(`${name}: ${cause.code === 'ENOENT' ? 'missing asset' : cause.message}`);
  }
}
const total = sizes.reduce((sum, file) => sum + file.bytes, 0);
if (total > 20 * 1024 * 1024)
  warnings.push(
    `The deck is ${(total / 1024 / 1024).toFixed(2)} MiB; first-time offline setup needs a larger download.`,
  );
console.log(
  `Illustrations: ${sizes.length}/78; ${(total / 1024 / 1024).toFixed(2)} MiB total; dimensions: ${[...resolutions].join(', ') || 'none'}.`,
);
if (sizes.length) {
  const largest = sizes.reduce((a, b) => (a.bytes > b.bytes ? a : b));
  console.log(`Largest asset: ${largest.name}, ${(largest.bytes / 1024).toFixed(1)} KiB.`);
}
for (const warning of warnings) console.warn(`Warning: ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`Error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `All 78 illustrations passed structural checks${checkBuiltAssets ? ' and required offline-cache coverage' : ''}.`,
  );
  console.log(
    'Browser decoding and visual review are still required; headers do not prove image content or composition.',
  );
}
