import { useEffect, useMemo, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';

const typeLabels: Record<string, string> = { image: '图', model: '3D', video: '视频', note: '文', mindmap: '脑图', group: '组', document: '档', table: '表', pdf: 'PDF' };

export function HierarchyPanel() {
  const { project, selectedNodeIds, selectNode, updateNode, updateNodes } = useProjectStore();
  const [filter, setFilter] = useState('');
  const [draggedId, setDraggedId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const assets = useMemo(() => new Map(project.assets.map((asset) => [asset.id, asset])), [project.assets]);
  const nodes = useMemo(() => project.nodes.slice().sort((a, b) => b.zIndex - a.zIndex).filter((node) => !filter || node.title.toLowerCase().includes(filter.toLowerCase()) || node.type.includes(filter.toLowerCase())), [filter, project.nodes]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F2' && selectedNodeIds.length === 1) { event.preventDefault(); setEditingId(selectedNodeIds[0]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNodeIds]);

  const moveLayer = (id: string, direction: -1 | 1) => {
    const ordered = project.nodes.slice().sort((a, b) => a.zIndex - b.zIndex);
    const index = ordered.findIndex((node) => node.id === id);
    const swap = index + direction;
    if (index < 0 || swap < 0 || swap >= ordered.length) return;
    updateNodes([{ id: ordered[index].id, patch: { zIndex: ordered[swap].zIndex } }, { id: ordered[swap].id, patch: { zIndex: ordered[index].zIndex } }], true, false);
  };

  const dropOn = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    const dragged = project.nodes.find((node) => node.id === draggedId);
    const target = project.nodes.find((node) => node.id === targetId);
    if (!dragged || !target) return;
    if (target.type === 'group' && dragged.type !== 'group') {
      updateNode(dragged.id, { groupId: target.id, zIndex: target.zIndex + 1 }, true, true);
    } else {
      updateNodes([{ id: dragged.id, patch: { zIndex: target.zIndex } }, { id: target.id, patch: { zIndex: dragged.zIndex } }], true, false);
    }
    setDraggedId(undefined);
  };

  return <section className="hierarchy-panel">
    <div className="hierarchy-heading"><strong>节点层级</strong><span>{project.nodes.length}</span></div>
    <input className="hierarchy-filter" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="筛选名称或类型" />
    <div className="hierarchy-list">
      {nodes.map((node) => {
        const asset = node.assetId ? assets.get(node.assetId) : undefined;
        return <div key={node.id} draggable={!editingId} className={`hierarchy-row ${selectedNodeIds.includes(node.id) ? 'selected' : ''} ${draggedId === node.id ? 'dragging' : ''}`} style={{ paddingLeft: node.groupId ? 20 : 6 }} onDragStart={() => setDraggedId(node.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropOn(node.id)} onClick={() => selectNode(node.id)} onDoubleClick={() => window.dispatchEvent(new CustomEvent('refmind3d-focus-node-ids', { detail: { ids: [node.id] } }))}>
          <span className="hierarchy-type">{typeLabels[node.type] || node.type}</span>
          {editingId === node.id ? <input className="hierarchy-name-input" autoFocus defaultValue={node.title} onFocus={(event) => event.currentTarget.select()} onBlur={(event) => { updateNode(node.id, { title: event.currentTarget.value.trim() || node.title }, true, false); setEditingId(undefined); }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditingId(undefined); }} /> : <span className="hierarchy-name" title={node.title}>{node.title || '未命名'}</span>}
          <span className="hierarchy-status" title={asset?.storageMode === 'linked' ? '链接资源' : '嵌入资源'}>{asset ? (asset.storageMode === 'linked' ? '链' : '嵌') : ''}</span>
          <button title={node.hidden ? '显示' : '隐藏'} onClick={(event) => { event.stopPropagation(); updateNode(node.id, { hidden: !node.hidden }, true, false); }}>{node.hidden ? '○' : '●'}</button>
          <button title={node.locked ? '解锁' : '锁定'} onClick={(event) => { event.stopPropagation(); updateNode(node.id, { locked: !node.locked }, true, false); }}>{node.locked ? '◆' : '◇'}</button>
          <button title="上移一层" onClick={(event) => { event.stopPropagation(); moveLayer(node.id, 1); }}>↑</button><button title="下移一层" onClick={(event) => { event.stopPropagation(); moveLayer(node.id, -1); }}>↓</button>
        </div>;
      })}
      {nodes.length === 0 && <p className="muted">没有匹配节点</p>}
    </div>
    <span className="muted">拖动可排序，拖到组上可归组；F2 重命名，双击定位。</span>
  </section>;
}
