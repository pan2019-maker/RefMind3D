import { memo, useEffect, useRef } from 'react';
import type { GpuImageItem } from './GpuImageLayer';

/** A deliberately low-resolution canvas atlas for extreme zoom levels. */
export const OverviewImageLayer = memo(function OverviewImageLayer({ items, width, height, onCompositedIdsChange }: {
  items: GpuImageItem[];
  width: number;
  height: number;
  onCompositedIdsChange: (ids: ReadonlySet<string>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imagesRef = useRef(new Map<string, HTMLImageElement>());
  const itemsRef = useRef(items);
  const redrawRef = useRef<() => void>(() => undefined);
  const workerRef = useRef<Worker | null>(null);
  const offscreenRef = useRef(false);

  useEffect(() => {
    itemsRef.current = items;
    const canvas = canvasRef.current;
    const renderScale = Math.min(1, 1024 / Math.max(1, width), 768 / Math.max(1, height));
    if (canvas && 'transferControlToOffscreen' in canvas) {
      try {
        if (!workerRef.current) {
          workerRef.current = new Worker(new URL('./overviewRender.worker.ts', import.meta.url), { type: 'module' });
          workerRef.current.onmessage = (event: MessageEvent<{ type: string; ids: string[] }>) => {
            if (event.data.type === 'ready') onCompositedIdsChange(new Set(event.data.ids));
          };
        }
        const message: { canvas?: OffscreenCanvas; items: GpuImageItem[]; width: number; height: number; pixelWidth: number; pixelHeight: number } = {
          items, width, height, pixelWidth: Math.max(1, Math.round(width * renderScale)), pixelHeight: Math.max(1, Math.round(height * renderScale))
        };
        if (!offscreenRef.current) {
          message.canvas = canvas.transferControlToOffscreen(); offscreenRef.current = true;
          workerRef.current.postMessage(message, [message.canvas]);
        } else workerRef.current.postMessage(message);
        return;
      } catch { workerRef.current?.terminate(); workerRef.current = null; }
    }
    const context = canvas?.getContext('2d', { alpha: true });
    if (!canvas || !context) { onCompositedIdsChange(new Set()); return; }
    const cssScaleX = canvas.width / Math.max(1, width); const cssScaleY = canvas.height / Math.max(1, height);
    redrawRef.current = () => {
      context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height);
      context.setTransform(cssScaleX, 0, 0, cssScaleY, 0, 0);
      const ready = new Set<string>();
      for (const item of itemsRef.current) {
        const image = imagesRef.current.get(item.src); if (!image?.complete || !image.naturalWidth) continue;
        context.save(); context.globalAlpha = item.opacity; context.filter = item.grayscale ? 'grayscale(1)' : 'none';
        context.translate(item.x + item.width / 2, item.y + item.height / 2); context.rotate(item.rotation * Math.PI / 180);
        context.scale(item.flipX ? -1 : 1, item.flipY ? -1 : 1);
        const sx = item.u0 * image.naturalWidth; const sy = item.v0 * image.naturalHeight;
        const sw = Math.max(1, (item.u1 - item.u0) * image.naturalWidth); const sh = Math.max(1, (item.v1 - item.v0) * image.naturalHeight);
        context.drawImage(image, sx, sy, sw, sh, -item.width / 2, -item.height / 2, item.width, item.height);
        context.restore(); ready.add(item.id);
      }
      onCompositedIdsChange(ready);
    };
    const activeSources = new Set(items.map((item) => item.src));
    for (const key of [...imagesRef.current.keys()]) if (!activeSources.has(key)) imagesRef.current.delete(key);
    for (const item of items) {
      if (imagesRef.current.has(item.src)) continue;
      const image = new Image(); image.decoding = 'async';
      image.onload = () => redrawRef.current(); image.onerror = () => redrawRef.current(); image.src = item.src;
      imagesRef.current.set(item.src, image);
    }
    redrawRef.current();
  }, [height, items, onCompositedIdsChange, width]);

  useEffect(() => () => onCompositedIdsChange(new Set()), [onCompositedIdsChange]);
  useEffect(() => () => { workerRef.current?.terminate(); workerRef.current = null; }, []);
  const renderScale = Math.min(1, 1024 / Math.max(1, width), 768 / Math.max(1, height));
  return <canvas ref={canvasRef} className="overview-image-layer" style={{ width, height }} width={Math.max(1, Math.round(width * renderScale))} height={Math.max(1, Math.round(height * renderScale))} aria-hidden="true" />;
});
