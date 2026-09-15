import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetRecord, CanvasNode, RefMindProject } from '../shared/types';

export interface SearchableCanvas { id: string; name: string; project: RefMindProject }

interface SearchHit { canvasId: string; canvasName: string; node: CanvasNode; asset?: AssetRecord; score: number }

function searchableText(canvas: SearchableCanvas, node: CanvasNode, asset?: AssetRecord) {
  return [canvas.name, node.title, node.text, ...(node.tags || []), asset?.name, asset?.originalPath, asset?.extractedText, ...(asset?.tags || [])]
    .filter(Boolean).join(' ').toLocaleLowerCase();
}

export function WorkspaceSearch({ canvases, onClose, onOpenHit }: { canvases: SearchableCanvas[]; onClose: () => void; onOpenHit: (hit: { canvasId: string; nodeId: string }) => void }) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const results = useMemo(() => {
    const terms = deferredQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [] as SearchHit[];
    const hits: SearchHit[] = [];
    for (const canvas of canvases) {
      const assets = new Map(canvas.project.assets.map((asset) => [asset.id, asset]));
      for (const node of canvas.project.nodes) {
        const asset = node.assetId ? assets.get(node.assetId) : undefined;
        const text = searchableText(canvas, node, asset);
        if (!terms.every((term) => text.includes(term))) continue;
        const exact = [node.title, asset?.name, ...(node.tags || []), ...(asset?.tags || [])].some((value) => value?.toLocaleLowerCase() === deferredQuery.trim().toLocaleLowerCase());
        hits.push({ canvasId: canvas.id, canvasName: canvas.name, node, asset, score: exact ? 2 : 1 });
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.canvasName.localeCompare(b.canvasName)).slice(0, 100);
  }, [canvases, deferredQuery]);

  return <div className="workspace-search-backdrop" onMouseDown={onClose}>
    <section className="workspace-search" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
      <header><input ref={inputRef} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索名称、文本、路径或标签…" /><kbd>Esc</kbd></header>
      <div className="workspace-search-results">
        {!query.trim() && <p className="muted">输入关键词，可跨全部画布检索节点、正文、文件名和标签。</p>}
        {query.trim() && !results.length && <p className="muted">没有匹配结果。</p>}
        {results.map((hit) => <button key={`${hit.canvasId}:${hit.node.id}`} onClick={() => onOpenHit({ canvasId: hit.canvasId, nodeId: hit.node.id })}>
          <span className="search-hit-icon">{hit.node.type === 'image' ? '▧' : hit.node.type === 'model' ? '◇' : 'T'}</span>
          <span><strong>{hit.node.title || hit.asset?.name || '未命名节点'}</strong><small>{hit.canvasName} · {[...(hit.node.tags || []), ...(hit.asset?.tags || [])].join(' · ') || hit.node.type}</small></span>
        </button>)}
      </div>
    </section>
  </div>;
}
