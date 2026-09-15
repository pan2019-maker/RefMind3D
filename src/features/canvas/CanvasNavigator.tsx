import { memo, useMemo, useState } from 'react';
import type { CanvasNode } from '../../shared/types';

interface WorldRect { x: number; y: number; width: number; height: number }
interface NamedView { id: string; name: string; center: { x: number; y: number } }

export const CanvasNavigator = memo(function CanvasNavigator({ nodes, viewport, storageKey, onNavigate }: {
  nodes: CanvasNode[];
  viewport: WorldRect;
  storageKey: string;
  onNavigate: (center: { x: number; y: number }) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [namedViews, setNamedViews] = useState<NamedView[]>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '[]') as NamedView[]; } catch { return []; }
  });
  const bounds = useMemo(() => {
    if (nodes.length === 0) return { x: viewport.x, y: viewport.y, width: Math.max(1, viewport.width), height: Math.max(1, viewport.height) };
    const left = Math.min(viewport.x, ...nodes.map((node) => node.x));
    const top = Math.min(viewport.y, ...nodes.map((node) => node.y));
    const right = Math.max(viewport.x + viewport.width, ...nodes.map((node) => node.x + node.width));
    const bottom = Math.max(viewport.y + viewport.height, ...nodes.map((node) => node.y + node.height));
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }, [nodes, viewport]);
  const width = 188;
  const height = 118;
  const sx = width / bounds.width;
  const sy = height / bounds.height;
  const scale = Math.min(sx, sy);
  const offsetX = (width - bounds.width * scale) / 2;
  const offsetY = (height - bounds.height * scale) / 2;
  const persist = (next: NamedView[]) => { setNamedViews(next); localStorage.setItem(storageKey, JSON.stringify(next)); };
  const saveCurrent = () => persist([...namedViews.slice(-7), {
    id: crypto.randomUUID(), name: `视图 ${namedViews.length + 1}`,
    center: { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 }
  }]);

  return (
    <aside className={`canvas-navigator ${collapsed ? 'collapsed' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>导航</strong><button onClick={() => setCollapsed((value) => !value)}>{collapsed ? '展开' : '收起'}</button></header>
      {!collapsed && <>
        <svg viewBox={`0 0 ${width} ${height}`} onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - rect.left) / rect.width * width;
          const y = (event.clientY - rect.top) / rect.height * height;
          onNavigate({ x: (x - offsetX) / scale + bounds.x, y: (y - offsetY) / scale + bounds.y });
        }}>
          {nodes.filter((node) => !node.hidden).map((node) => <rect key={node.id}
            x={(node.x - bounds.x) * scale + offsetX} y={(node.y - bounds.y) * scale + offsetY}
            width={Math.max(1, node.width * scale)} height={Math.max(1, node.height * scale)} className={`nav-node nav-${node.type}`} />)}
          <rect className="nav-viewport" x={(viewport.x - bounds.x) * scale + offsetX} y={(viewport.y - bounds.y) * scale + offsetY}
            width={Math.max(2, viewport.width * scale)} height={Math.max(2, viewport.height * scale)} />
        </svg>
        <div className="canvas-navigator-actions"><button onClick={saveCurrent}>保存位置</button>{namedViews.map((item) => <button key={item.id} title={item.name} onClick={() => onNavigate(item.center)}>{item.name}</button>)}</div>
      </>}
    </aside>
  );
});
