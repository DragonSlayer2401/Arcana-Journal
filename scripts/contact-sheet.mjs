import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
const [kind, filename, ...ids] = process.argv.slice(2);
const width = 220,
  height = 350,
  columns = 4;
await mkdir('art/previews', { recursive: true });
const composites = [];
for (let i = 0; i < ids.length; i++) {
  const input =
    kind === 'source' ? `art/references/rws/${ids[i]}.jpg` : `public/cards/${ids[i]}.webp`;
  const tile = await sharp(input)
    .resize(width, height - 28, { fit: 'contain', background: '#171522' })
    .jpeg()
    .toBuffer();
  const label = Buffer.from(
    `<svg width="${width}" height="28"><rect width="100%" height="100%" fill="#171522"/><text x="10" y="20" fill="#ffffff" font-family="Arial" font-size="14">${ids[i]}</text></svg>`,
  );
  composites.push({
    input: tile,
    left: (i % columns) * width,
    top: Math.floor(i / columns) * height,
  });
  composites.push({
    input: label,
    left: (i % columns) * width,
    top: Math.floor(i / columns) * height + height - 28,
  });
}
const output = `art/previews/${filename}.jpg`;
await sharp({
  create: {
    width: columns * width,
    height: Math.ceil(ids.length / columns) * height,
    channels: 3,
    background: '#171522',
  },
})
  .composite(composites)
  .jpeg({ quality: 90 })
  .toFile(output);
console.log(output);
