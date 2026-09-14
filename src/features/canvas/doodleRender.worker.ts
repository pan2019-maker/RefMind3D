/// <reference lib="webworker" />
import type { DoodleStroke } from '../../shared/types';

type View = { x: number; y: number; scale: number };
type RenderMessage = { canvas?: OffscreenCanvas; strokes: DoodleStroke[]; view: View; width: number; height: number; ratio: number };
let target: OffscreenCanvas | undefined;

function draw(ctx: OffscreenCanvasRenderingContext2D, stroke: DoodleStroke, view: View) {
  const points = stroke.points;
  if (!points.length) return;
  const screen = (p: { x: number; y: number }) => ({ x: p.x * view.scale + view.x, y: p.y * view.scale + view.y });
  ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if ((stroke.tool || 'brush') === 'brush') {
    for (let i = 1; i < points.length; i += 1) {
      const a = screen(points[i - 1]); const b = screen(points[i]);
      ctx.lineWidth = Math.max(.5, stroke.width * (.2 + ((points[i - 1].pressure + points[i].pressure) / 2) * .8) * view.scale);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    return;
  }
  if (points.length < 2) return;
  const a = screen(points[0]); const b = screen(points[points.length - 1]);
  ctx.lineWidth = Math.max(.75, stroke.width * view.scale);
  if (stroke.tool === 'arrow') {
    const dx = b.x - a.x; const dy = b.y - a.y; const length = Math.hypot(dx, dy);
    if (length < .5) return;
    const ux = dx / length; const uy = dy / length;
    const head = Math.min(length * .6, Math.max(12, stroke.width * 3.5 * view.scale));
    const half = Math.min(length * .35, Math.max(5, stroke.width * 1.75 * view.scale));
    const bx = b.x - ux * head; const by = b.y - uy * head;
    ctx.lineWidth = Math.max(1, stroke.width * .35 * view.scale);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bx + ux, by + uy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(bx - uy * half, by + ux * half); ctx.lineTo(bx + uy * half, by - ux * half); ctx.closePath(); ctx.fill();
    return;
  }
  const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y); const w = Math.abs(b.x - a.x); const h = Math.abs(b.y - a.y);
  ctx.beginPath();
  if (stroke.tool === 'rectangle') ctx.rect(x, y, w, h); else ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
}

self.onmessage = (event: MessageEvent<RenderMessage>) => {
  const message = event.data;
  if (message.canvas) target = message.canvas;
  if (!target) return;
  target.width = Math.max(1, Math.round(message.width * message.ratio));
  target.height = Math.max(1, Math.round(message.height * message.ratio));
  const ctx = target.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(message.ratio, 0, 0, message.ratio, 0, 0);
  ctx.clearRect(0, 0, message.width, message.height);
  for (const stroke of message.strokes) draw(ctx, stroke, message.view);
};
