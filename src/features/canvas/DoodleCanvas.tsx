import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react';
import type { DoodleStroke } from '../../shared/types';

interface ViewState {
  x: number;
  y: number;
  scale: number;
}

const strokeBoundsCache = new WeakMap<DoodleStroke, { left: number; top: number; right: number; bottom: number }>();

function strokeIsVisible(stroke: DoodleStroke, view: ViewState, width: number, height: number) {
  let bounds = strokeBoundsCache.get(stroke);
  if (!bounds) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    const margin = stroke.width * 4;
    bounds = {
      left: minX - margin,
      top: minY - margin,
      right: maxX + margin,
      bottom: maxY + margin
    };
    strokeBoundsCache.set(stroke, bounds);
  }
  const left = -view.x / view.scale;
  const top = -view.y / view.scale;
  const right = left + width / view.scale;
  const bottom = top + height / view.scale;
  return bounds.right >= left && bounds.left <= right && bounds.bottom >= top && bounds.top <= bottom;
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: DoodleStroke, view: ViewState) {
  const points = stroke.points;
  if (points.length === 0) return;
  const screen = (point: { x: number; y: number }) => ({
    x: point.x * view.scale + view.x,
    y: point.y * view.scale + view.y
  });
  const tool = stroke.tool || 'brush';
  ctx.fillStyle = stroke.color;
  ctx.strokeStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (tool === 'brush') {
    if (points.length === 1) {
      const point = screen(points[0]);
      const width = stroke.width * (0.2 + points[0].pressure * 0.8) * view.scale;
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(0.5, width / 2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let index = 1; index < points.length; index += 1) {
      const previous = screen(points[index - 1]);
      const point = screen(points[index]);
      const pressure = (points[index - 1].pressure + points[index].pressure) / 2;
      ctx.lineWidth = Math.max(0.5, stroke.width * (0.2 + pressure * 0.8) * view.scale);
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    return;
  }

  if (points.length < 2) return;
  const from = screen(points[0]);
  const to = screen(points[points.length - 1]);
  ctx.lineWidth = Math.max(0.75, stroke.width * view.scale);

  if (tool === 'arrow') {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.5) return;
    const ux = dx / length;
    const uy = dy / length;
    const headLength = Math.min(length * 0.6, Math.max(12, stroke.width * 3.5 * view.scale));
    const headHalfWidth = Math.min(length * 0.35, Math.max(5, stroke.width * 1.75 * view.scale));
    const baseX = to.x - ux * headLength;
    const baseY = to.y - uy * headLength;
    const px = -uy;
    const py = ux;
    ctx.lineWidth = Math.max(1, stroke.width * 0.35 * view.scale);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(baseX + ux, baseY + uy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(baseX + px * headHalfWidth, baseY + py * headHalfWidth);
    ctx.lineTo(baseX - px * headHalfWidth, baseY - py * headHalfWidth);
    ctx.closePath();
    ctx.fill();
    return;
  }

  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const width = Math.abs(to.x - from.x);
  const height = Math.abs(to.y - from.y);
  ctx.beginPath();
  if (tool === 'rectangle') ctx.rect(x, y, width, height);
  else ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
}

export interface DoodleCanvasHandle {
  drawActiveStroke: (stroke: DoodleStroke) => void;
  clearActiveStroke: () => void;
}

export const DoodleCanvas = memo(forwardRef<DoodleCanvasHandle, {
  strokes: DoodleStroke[];
  view: ViewState;
  width: number;
  height: number;
}>(function DoodleCanvas({ strokes, view, width, height }, ref) {
  const staticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderStateRef = useRef({ view, width, height });
  const workerRef = useRef<Worker | null>(null);
  const offscreenRef = useRef(false);
  renderStateRef.current = { view, width, height };

  useEffect(() => {
    const canvas = staticCanvasRef.current;
    if (!canvas) return;
    if ('transferControlToOffscreen' in canvas) {
      try {
        if (!workerRef.current) workerRef.current = new Worker(new URL('./doodleRender.worker.ts', import.meta.url), { type: 'module' });
        const message: { canvas?: OffscreenCanvas; strokes: DoodleStroke[]; view: ViewState; width: number; height: number; ratio: number } = {
          strokes, view, width, height, ratio: Math.min(2, Math.max(1, window.devicePixelRatio || 1))
        };
        if (!offscreenRef.current) {
          message.canvas = canvas.transferControlToOffscreen();
          offscreenRef.current = true;
          workerRef.current.postMessage(message, [message.canvas]);
        } else workerRef.current.postMessage(message);
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
        return;
      } catch {
        workerRef.current?.terminate(); workerRef.current = null;
      }
    }
    const ctx = prepareCanvas(canvas, width, height);
    if (!ctx) return;
    for (const stroke of strokes) {
      if (strokeIsVisible(stroke, view, width, height)) drawStroke(ctx, stroke, view);
    }
  }, [height, strokes, view, width]);

  const clearActiveCanvas = () => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return;
    const state = renderStateRef.current;
    prepareCanvas(canvas, state.width, state.height);
  };

  useImperativeHandle(ref, () => ({
    drawActiveStroke: (stroke) => {
      const canvas = activeCanvasRef.current;
      if (!canvas) return;
      const state = renderStateRef.current;
      const ctx = prepareCanvas(canvas, state.width, state.height);
      if (ctx && strokeIsVisible(stroke, state.view, state.width, state.height)) {
        drawStroke(ctx, stroke, state.view);
      }
    },
    clearActiveStroke: clearActiveCanvas
  }), []);

  useEffect(clearActiveCanvas, [height, view, width]);

  return (
    <>
      <canvas ref={staticCanvasRef} className="doodle-layer doodle-layer-static" aria-hidden="true" />
      <canvas ref={activeCanvasRef} className="doodle-layer doodle-layer-active" aria-hidden="true" />
    </>
  );
}));

function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const pixelWidth = Math.max(1, Math.round(width * ratio));
  const pixelHeight = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}
