import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { AssetRecord, CanvasNode, RefMindProject } from '../../shared/types';

function isTextLike(node: CanvasNode) {
  return ['note', 'mindmap', 'document', 'table', 'pdf'].includes(node.type);
}

function nodeCenter(node?: CanvasNode) {
  if (!node) return { x: 0, y: 0 };
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function horizontalConnectionPoint(node: CanvasNode | undefined, toward: { x: number; y: number }) {
  if (!node) return { x: 0, y: 0 };
  const center = nodeCenter(node);
  return toward.x >= center.x
    ? { x: node.x + node.width, y: center.y }
    : { x: node.x, y: center.y };
}

function horizontalConnectionPoints(fromNode: CanvasNode | undefined, toNode: CanvasNode | undefined) {
  const fromCenter = nodeCenter(fromNode);
  const toCenter = nodeCenter(toNode);
  return {
    from: horizontalConnectionPoint(fromNode, toCenter),
    to: horizontalConnectionPoint(toNode, fromCenter)
  };
}

function drawConnectionPath(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  const direction = to.x >= from.x ? 1 : -1;
  const distance = Math.abs(to.x - from.x);
  const dx = Math.min(distance / 2, Math.max(24, distance * 0.45));
  ctx.bezierCurveTo(from.x + dx * direction, from.y, to.x - dx * direction, to.y, to.x, to.y);
}

function assetPath(asset?: AssetRecord) {
  if (!asset) return '';
  return asset.embeddedPreviewDataUrl || asset.embeddedDataUrl || asset.previewPath || asset.projectAssetPath || asset.originalPath;
}

function isRuntimeResourceUrl(path: string) {
  return path.startsWith('refmind3d://') || path.startsWith('http://refmind3d.localhost') || path.startsWith('https://refmind3d.localhost');
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxHeight: number) {
  const paragraphs = text.split(/\r?\n/);
  let cy = y;
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/(\s+)/).filter(Boolean);
    let line = '';
    for (const word of words.length ? words : ['']) {
      const next = line + word;
      if (ctx.measureText(next).width > maxWidth && line.trim()) {
        if (cy + lineHeight > y + maxHeight) return;
        ctx.fillText(line.trimEnd(), x, cy);
        line = word.trimStart();
        cy += lineHeight;
      } else {
        line = next;
      }
    }
    if (cy + lineHeight > y + maxHeight) return;
    ctx.fillText(line.trimEnd(), x, cy);
    cy += lineHeight;
  }
}

function boundsOf(nodes: CanvasNode[]) {
  if (nodes.length === 0) return { left: 0, top: 0, right: 1200, bottom: 800 };
  return {
    left: Math.min(...nodes.map((node) => node.x)),
    top: Math.min(...nodes.map((node) => node.y)),
    right: Math.max(...nodes.map((node) => node.x + node.width)),
    bottom: Math.max(...nodes.map((node) => node.y + node.height))
  };
}

function expandSelectedNodes(project: RefMindProject, nodeIds: string[]) {
  const wanted = new Set(nodeIds);
  for (const node of project.nodes) {
    if (node.groupId && wanted.has(node.groupId)) {
      wanted.add(node.id);
    }
  }
  return project.nodes
    .filter((node) => wanted.has(node.id))
    .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
}

async function renderNodesToPng(project: RefMindProject, outputPath: string, sourceNodes: CanvasNode[], background = 'transparent') {
  const nodes = sourceNodes.filter((node) => !node.hidden).slice().sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  if (nodes.length === 0) throw new Error('没有可导出的节点');

  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const bounds = boundsOf(nodes);
  const padding = nodes.length === project.nodes.length ? 80 : 24;
  const width = Math.max(64, Math.ceil(bounds.right - bounds.left + padding * 2));
  const height = Math.max(64, Math.ceil(bounds.bottom - bounds.top + padding * 2));
  const offsetX = padding - bounds.left;
  const offsetY = padding - bounds.top;

  const canvas = document.createElement('canvas');
  canvas.width = Math.min(16000, width);
  canvas.height = Math.min(16000, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建图片导出上下文');

  if (background !== 'transparent') {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  ctx.save();
  ctx.translate(offsetX, offsetY);

  // 只导出选中范围内的思维导图连线，避免选中单个对象时把整张画布的线也导出。
  for (const link of project.links) {
    if (!nodeIds.has(link.fromNodeId) || !nodeIds.has(link.toNodeId)) continue;
    const fromNode = nodesById.get(link.fromNodeId);
    const toNode = nodesById.get(link.toNodeId);
    if (!fromNode || !toNode) continue;
    const { from, to } = horizontalConnectionPoints(fromNode, toNode);
    ctx.strokeStyle = link.color || '#8a8a8a';
    ctx.lineWidth = link.width || 2;
    drawConnectionPath(ctx, from, to);
    ctx.stroke();
  }

  for (const node of nodes) {
    ctx.save();
    ctx.globalAlpha = node.opacity ?? 1;
    ctx.filter = project.canvasGrayscale || node.grayscale ? 'grayscale(1)' : 'none';
    ctx.translate(node.x + node.width / 2, node.y + node.height / 2);
    ctx.rotate((node.rotation || 0) * Math.PI / 180);
    ctx.translate(-node.width / 2, -node.height / 2);

    if (node.type === 'group') {
      ctx.fillStyle = node.fillColor || 'rgba(79,111,168,0.26)';
      ctx.strokeStyle = node.strokeColor || '#9ab7ff';
      ctx.lineWidth = 2;
      ctx.fillRect(0, 0, node.width, node.height);
      ctx.strokeRect(0, 0, node.width, node.height);
    } else if (node.type === 'image') {
      const asset = node.assetId ? assetsById.get(node.assetId) : undefined;
      const path = assetPath(asset);
      try {
        const img = await loadImage(path.startsWith('data:') || path.startsWith('blob:') || isRuntimeResourceUrl(path) ? path : convertFileSrc(path));
        ctx.fillStyle = '#2e2e2e';
        ctx.fillRect(0, 0, node.width, node.height);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, node.width, node.height);
        ctx.clip();
        const baseScale = node.cropEnabled
          ? Math.max(node.width / img.naturalWidth, node.height / img.naturalHeight)
          : Math.min(node.width / img.naturalWidth, node.height / img.naturalHeight);
        const scale = baseScale * (node.imageScale || 1);
        ctx.translate(node.width / 2 + (node.imagePanX || 0) * node.width / 100, node.height / 2 + (node.imagePanY || 0) * node.height / 100);
        ctx.scale(node.flipX ? -scale : scale, node.flipY ? -scale : scale);
        ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
        ctx.restore();
      } catch {
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, node.width, node.height);
        ctx.fillStyle = '#ddd';
        ctx.fillText('图片预览导出失败', 12, 24);
      }
    } else if (node.type === 'model') {
      ctx.fillStyle = '#1f232b';
      ctx.fillRect(0, 0, node.width, node.height);
      ctx.strokeStyle = '#596276';
      ctx.strokeRect(0, 0, node.width, node.height);
      ctx.fillStyle = '#e5e7eb';
      ctx.font = 'bold 18px Segoe UI';
      ctx.fillText('3D 模型', 16, 34);
      ctx.font = '13px Segoe UI';
      ctx.fillText(node.title, 16, 58);
    } else if (isTextLike(node)) {
      ctx.fillStyle = node.fillColor || '#ffffff';
      ctx.strokeStyle = node.strokeColor || '#7a7a7a';
      ctx.lineWidth = 1.5;
      ctx.fillRect(0, 0, node.width, node.height);
      ctx.strokeRect(0, 0, node.width, node.height);
      ctx.fillStyle = node.textColor || '#111111';
      const fontSize = node.fontSize || 16;
      ctx.font = `${node.fontStyle || 'normal'} ${node.fontWeight || 'normal'} ${fontSize}px ${node.fontFamily || 'Segoe UI'}`;
      wrapText(ctx, node.text || node.title, 14, 22, Math.max(20, node.width - 28), fontSize * 1.45, Math.max(20, node.height - 28));
    }
    ctx.restore();
  }
  ctx.restore();

  const dataUrl = canvas.toDataURL('image/png');
  await invoke('save_png_data_url', { path: outputPath, dataUrl });
}

export async function exportProjectToPng(project: RefMindProject, outputPath: string) {
  await renderNodesToPng(project, outputPath, project.nodes, '#242424');
}

export async function exportSelectedNodesToPng(project: RefMindProject, nodeIds: string[], outputPath: string) {
  const nodes = expandSelectedNodes(project, nodeIds);
  await renderNodesToPng(project, outputPath, nodes, 'transparent');
}
