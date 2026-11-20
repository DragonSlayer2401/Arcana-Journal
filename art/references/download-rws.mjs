// Reproducible reference collection only; never called by the browser application.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const directory = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(directory, 'rws');
await mkdir(destination, { recursive: true });
const majorNames = [
  'Fool',
  'Magician',
  'High Priestess',
  'Empress',
  'Emperor',
  'Hierophant',
  'Lovers',
  'Chariot',
  'Strength',
  'Hermit',
  'Wheel of Fortune',
  'Justice',
  'Hanged Man',
  'Death',
  'Temperance',
  'Devil',
  'Tower',
  'Star',
  'Moon',
  'Sun',
  'Judgement',
  'World',
];
const requests = majorNames.map((name, index) => ({
  id: `major-${String(index).padStart(2, '0')}`,
  title: `File:RWS Tarot ${String(index).padStart(2, '0')} ${name}.jpg`,
}));
for (const [suit, prefix] of [
  ['wands', 'Wands'],
  ['cups', 'Cups'],
  ['swords', 'Swords'],
  ['pentacles', 'Pents'],
]) {
  for (let rank = 1; rank <= 14; rank++)
    requests.push({
      id: `minor-${suit}-${String(rank).padStart(2, '0')}`,
      title: `File:${prefix}${String(rank).padStart(2, '0')}.jpg`,
    });
}

const headers = {
  'User-Agent': 'StilllightTarotReferenceCollector/1.0 (public-domain reference collection)',
};
const get = async (url) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers });
    if (response.ok) return response;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3)
      throw new Error(`${response.status}: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 5000));
  }
};
const pages = [];
for (let start = 0; start < requests.length; start += 40) {
  const parameters = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata|timestamp|sha1',
    iiurlwidth: '500',
    titles: requests
      .slice(start, start + 40)
      .map((item) => item.title)
      .join('|'),
  });
  const data = await (await get(`https://commons.wikimedia.org/w/api.php?${parameters}`)).json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  pages.push(...data.query.pages);
}
const stripHtml = (value = '') => value.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
const sources = {};
const errors = [];
for (const request of requests) {
  const page = pages.find((item) => item.title === request.title);
  const info = page?.imageinfo?.[0];
  if (!info) {
    errors.push(`Missing ${request.title}`);
    continue;
  }
  const metadata = info.extmetadata;
  if (
    metadata.LicenseShortName?.value !== 'Public domain' ||
    metadata.Copyrighted?.value?.toLowerCase() !== 'false'
  ) {
    errors.push(`Unverified public-domain status: ${request.title}`);
    continue;
  }
  sources[request.id] = {
    title: request.title,
    sourcePage: info.descriptionurl,
    fileUrl: info.url.split('?')[0],
    thumbnailUrl: info.thumburl.split('?')[0],
    localPath: `art/references/rws/${request.id}.jpg`,
    artist: stripHtml(metadata.Artist?.value),
    originalDate: stripHtml(metadata.DateTimeOriginal?.value),
    description: stripHtml(metadata.ImageDescription?.value),
    sourceCredit: stripHtml(metadata.Credit?.value),
    width: info.width,
    height: info.height,
    bytes: info.size,
    commonsUploadTimestamp: info.timestamp,
    commonsSha1: info.sha1,
    license: {
      name: metadata.LicenseShortName.value,
      code: metadata.License?.value,
      marker: 'https://creativecommons.org/publicdomain/mark/1.0/',
      copyrighted: false,
      attributionRequired: metadata.AttributionRequired?.value !== 'false',
      categories: metadata.Categories?.value?.split('|') ?? [],
    },
    retrievedAt: new Date().toISOString(),
  };
}
await writeFile(path.join(directory, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
console.log(`Verified metadata for ${Object.keys(sources).length} public-domain cards.`);
let position = 0;
const entries = Object.entries(sources);
// Respect Wikimedia's request to use standard thumbnails and limit concurrency.
await Promise.all(
  Array.from({ length: 1 }, async () => {
    while (position < entries.length) {
      const [id, source] = entries[position++];
      try {
        const filename = path.join(destination, `${id}.jpg`);
        let bytes;
        try {
          bytes = await readFile(filename);
        } catch {
          /* Download missing references. */
        }
        if (!bytes || bytes[0] !== 255 || bytes[1] !== 216) {
          bytes = Buffer.from(await (await get(source.thumbnailUrl)).arrayBuffer());
          if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Unexpected image contents');
          await writeFile(filename, bytes);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const fullOriginal = bytes.length === source.bytes;
        if (fullOriginal && createHash('sha1').update(bytes).digest('hex') !== source.commonsSha1)
          throw new Error('Original SHA-1 did not match Commons metadata');
        source.downloadedUrl = fullOriginal ? source.fileUrl : source.thumbnailUrl;
        const dimensions = await sharp(bytes).metadata();
        source.referenceWidth = dimensions.width;
        source.referenceHeight = dimensions.height;
        source.referenceBytes = bytes.length;
        source.sha256 = createHash('sha256').update(bytes).digest('hex');
        console.log(`${id}: ${bytes.length} bytes`);
      } catch (error) {
        const message = `${id}: ${error.message}`;
        errors.push(message);
        console.error(message);
      }
    }
  }),
);
await writeFile(path.join(directory, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`All ${entries.length} reference images downloaded and verified.`);
