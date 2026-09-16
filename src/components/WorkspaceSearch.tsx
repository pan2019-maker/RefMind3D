import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetRecord, CanvasNode, RefMindProject } from '../shared/types';

export interface SearchableCanvas { id: string; name: string; project: RefMindProject }

interface SearchRow { canvasId: string; canvasName: string; nodeId: string; nodeType: CanvasNode['type']; title: string; tags: string[]; text: string }

function searchableText(canvas: SearchableCanvas, node: CanvasNode, asset?: AssetRecord) {
  return [canvas.name, node.title, node.text, ...(node.tags || []), asset?.name, asset?.originalPath, asset?.extractedText, ...(asset?.tags || [])]
    .filter(Boolean).join(' ').toLocaleLowerCase();
}

export function WorkspaceSearch({ canvases, storageKey, onClose, onOpenHit }: { canvases: SearchableCanvas[]; storageKey: string; onClose: () => void; onOpenHit: (hit: { canvasId: string; nodeId: string }) => void }) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRevisionKey = canvases.map((canvas) => `${canvas.id}:${canvas.project.updatedAt}`).join('|');
  const [rows, setRows] = useState<SearchRow[]>(() => { try { return JSON.parse(localStorage.getItem(storageKey) || '[]') as SearchRow[]; } catch { return []; } });
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const build = () => {
      const next = canvases.flatMap((canvas) => {
        const assets = new Map(canvas.project.assets.map((asset) => [asset.id, asset]));
        return canvas.project.nodes.map((node) => { const asset = node.assetId ? assets.get(node.assetId) : undefined; const tags = [...(node.tags || []), ...(asset?.tags || [])]; return { canvasId: canvas.id, canvasName: canvas.name, nodeId: node.id, nodeType: node.type, title: node.title || asset?.name || '未命名节点', tags, text: searchableText(canvas, node, asset) }; });
      });
      setRows(next); try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Large indexes remain available for this session. */ }
    };
    const idle = window.requestIdleCallback?.(build, { timeout: 800 }) ?? window.setTimeout(build, 120);
    return () => { if (window.cancelIdleCallback) window.cancelIdleCallback(idle); else window.clearTimeout(idle); };
  }, [canvasRevisionKey, storageKey]);
  const results = useMemo(() => {
    const terms = deferredQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return rows.filter((row) => terms.every((term) => row.text.includes(term))).map((row) => ({ ...row, score: [row.title, ...row.tags].some((value) => value.toLocaleLowerCase() === deferredQuery.trim().toLocaleLowerCase()) ? 2 : 1 })).sort((a, b) => b.score - a.score || a.canvasName.localeCompare(b.canvasName)).slice(0, 100);
  }, [deferredQuery, rows]);

  return <div className="workspace-search-backdrop" onMouseDown={onClose}>
    <section className="workspace-search" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
      <header><input ref={inputRef} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索名称、文本、路径或标签…" /><kbd>Esc</kbd></header>
      <div className="workspace-search-results">
        {!query.trim() && <p className="muted">输入关键词，可跨全部画布检索节点、正文、文件名和标签。</p>}
        {query.trim() && !results.length && <p className="muted">没有匹配结果。</p>}
        {results.map((hit) => <button key={`${hit.canvasId}:${hit.nodeId}`} onClick={() => onOpenHit({ canvasId: hit.canvasId, nodeId: hit.nodeId })}>
          <span className="search-hit-icon">{hit.nodeType === 'image' ? '▧' : hit.nodeType === 'model' ? '◇' : 'T'}</span>
          <span><strong>{hit.title}</strong><small>{hit.canvasName} · {hit.tags.join(' · ') || hit.nodeType}</small></span>
        </button>)}
      </div>
    </section>
  </div>;
}
