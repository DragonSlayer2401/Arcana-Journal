import sharp from 'sharp';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [id, input, promptPath] = process.argv.slice(2);
if (!/^(major-\d{2}|minor-(wands|cups|swords|pentacles)-\d{2})$/.test(id ?? '') || !input) {
  throw new Error(
    'Usage: node scripts/import-art.mjs <stable-card-id> <generated-png> [prompt-file]',
  );
}
await mkdir(resolve('art/generated'), { recursive: true });
await mkdir(resolve('public/cards'), { recursive: true });
const original = resolve(`art/generated/${id}.png`);
if (resolve(input) !== original) await copyFile(input, original);
const image = sharp(original);
const metadata = await image.metadata();
if (Math.abs(metadata.width / metadata.height - 2 / 3) > 0.015) {
  throw new Error(
    `Unexpected artwork ratio for ${id}: ${metadata.width}x${metadata.height}. Preserve the composition; regenerate at 2:3.`,
  );
}
const output = resolve(`public/cards/${id}.webp`);
await image.resize(768, 1152, { fit: 'fill' }).webp({ quality: 83, effort: 5 }).toFile(output);
if (promptPath) await copyFile(resolve(promptPath), resolve(`art/generated/${id}.prompt.txt`));
console.log(
  JSON.stringify({ id, output, original, sourceSize: [metadata.width, metadata.height] }),
);
