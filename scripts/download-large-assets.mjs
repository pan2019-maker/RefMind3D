import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const [, , url, outFile, sizeText, partsText = '16'] = process.argv;

if (!url || !outFile || !sizeText) {
  console.error('Usage: node scripts/download-large-assets.mjs <url> <outFile> <size> [parts]');
  process.exit(2);
}

const totalSize = Number(sizeText);
const partCount = Number(partsText);
if (!Number.isFinite(totalSize) || totalSize <= 0 || !Number.isFinite(partCount) || partCount <= 0) {
  throw new Error('Invalid size or part count.');
}

const chunkDir = `${outFile}.parts`;
await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
await fs.promises.mkdir(chunkDir, { recursive: true });

function partPath(index) {
  return path.join(chunkDir, `part${String(index).padStart(3, '0')}.bin`);
}

async function fileSize(file) {
  try {
    return (await fs.promises.stat(file)).size;
  } catch {
    return -1;
  }
}

async function downloadPart(index, start, end) {
  const target = partPath(index);
  const expected = end - start + 1;
  if ((await fileSize(target)) === expected) return;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await fs.promises.rm(target, { force: true }).catch(() => {});
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          Range: `bytes=${start}-${end}`,
          'User-Agent': 'RefMind3D-offline-asset-downloader/1.0'
        }
      });
      if (!(response.status === 206 || response.status === 200) || !response.body) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
        continue;
      }
      await pipeline(response.body, fs.createWriteStream(target));
      if ((await fileSize(target)) === expected) return;
    } catch (error) {
      console.warn(`part ${index} attempt ${attempt} failed: ${error.message || error}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  throw new Error(`Failed to download part ${index}: ${start}-${end}`);
}

const chunkSize = Math.ceil(totalSize / partCount);
const ranges = [];
for (let index = 0; index < partCount; index += 1) {
  const start = index * chunkSize;
  const end = Math.min(totalSize - 1, (index + 1) * chunkSize - 1);
  if (start <= end) ranges.push({ index, start, end });
}

let cursor = 0;
let completed = 0;
async function worker() {
  while (cursor < ranges.length) {
    const range = ranges[cursor];
    cursor += 1;
    await downloadPart(range.index, range.start, range.end);
    completed += 1;
    const bytes = await fs.promises.readdir(chunkDir).then(async (items) => {
      let sum = 0;
      for (const item of items) sum += Math.max(0, await fileSize(path.join(chunkDir, item)));
      return sum;
    });
    console.log(`progress ${completed}/${ranges.length} parts ${bytes}/${totalSize} bytes`);
  }
}

const concurrency = Math.min(8, ranges.length);
await Promise.all(Array.from({ length: concurrency }, () => worker()));

await fs.promises.rm(outFile, { force: true }).catch(() => {});
const output = fs.createWriteStream(outFile, { flags: 'wx' });
try {
  for (const range of ranges) {
    const source = partPath(range.index);
    const expected = range.end - range.start + 1;
    if ((await fileSize(source)) !== expected) throw new Error(`Missing or incomplete ${source}`);
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(source);
      input.on('error', reject);
      output.on('error', reject);
      input.on('end', resolve);
      input.pipe(output, { end: false });
    });
  }
} finally {
  await new Promise((resolve) => output.end(resolve));
}

const actual = await fileSize(outFile);
if (actual !== totalSize) throw new Error(`Merged size mismatch: expected ${totalSize}, got ${actual}`);
await fs.promises.rm(chunkDir, { recursive: true, force: true });
console.log(`done ${outFile} ${actual}`);
