/// <reference lib="webworker" />
import type { GpuImageItem } from './GpuImageLayer';

type RenderMessage = { canvas?: OffscreenCanvas; items: GpuImageItem[]; width: number; height: number; pixelWidth: number; pixelHeight: number };
let target: OffscreenCanvas | undefined;
const bitmaps = new Map<string, ImageBitmap>();
const pending = new Map<string, Promise<ImageBitmap | null>>();

async function bitmap(src: string) {
  if (bitmaps.has(src)) return bitmaps.get(src)!;
  if (pending.has(src)) return pending.get(src)!;
  const task = fetch(src).then((response) => response.blob()).then(createImageBitmap).then((value) => {
    bitmaps.set(src, value); pending.delete(src); return value;
  }).catch(() => { pending.delete(src); return null; });
  pending.set(src, task);
  return task;
}

async function render(message: RenderMessage) {
  if (message.canvas) target = message.canvas;
  if (!target) return;
  target.width = message.pixelWidth; target.height = message.pixelHeight;
  const context = target.getContext('2d', { alpha: true });
  if (!context) return;
  const sources = [...new Set(message.items.map((item) => item.src))];
  await Promise.all(sources.map(bitmap));
  const active = new Set(sources);
  for (const [src, value] of bitmaps) if (!active.has(src)) { value.close(); bitmaps.delete(src); }
  context.setTransform(message.pixelWidth / Math.max(1, message.width), 0, 0, message.pixelHeight / Math.max(1, message.height), 0, 0);
  context.clearRect(0, 0, message.width, message.height);
  const ready: string[] = [];
  for (const item of message.items) {
    const image = bitmaps.get(item.src); if (!image) continue;
    context.save(); context.globalAlpha = item.opacity; context.filter = item.grayscale ? 'grayscale(1)' : 'none';
    context.translate(item.x + item.width / 2, item.y + item.height / 2); context.rotate(item.rotation * Math.PI / 180);
    context.scale(item.flipX ? -1 : 1, item.flipY ? -1 : 1);
    const sx = item.u0 * image.width; const sy = item.v0 * image.height;
    const sw = Math.max(1, (item.u1 - item.u0) * image.width); const sh = Math.max(1, (item.v1 - item.v0) * image.height);
    context.drawImage(image, sx, sy, sw, sh, -item.width / 2, -item.height / 2, item.width, item.height);
    context.restore(); ready.push(item.id);
  }
  self.postMessage({ type: 'ready', ids: ready });
}

self.onmessage = (event: MessageEvent<RenderMessage>) => { void render(event.data); };
