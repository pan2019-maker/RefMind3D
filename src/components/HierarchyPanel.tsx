import { useMemo, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';

const typeLabels: Record<string, string> = { image: '图', model: '3D', video: '视频', note: '文', mindmap: '脑图', group: '组', document: '档', table: '表', pdf: 'PDF' };

export function HierarchyPanel() {
  const { project, selectedNodeIds, selectNode, updateNode, updateNodes } = useProjectStore();
  const [filter, setFilter] = useState('');
  const nodes = useMemo(() => project.nodes.slice().sort((a, b) => b.zIndex - a.zIndex).filter((node) => !filter || node.title.toLowerCase().includes(filter.toLowerCase()) || node.type.includes(filter.toLowerCase())), [filter, project.nodes]);
  const moveLayer = (id: string, direction: -1 | 1) => {
    const ordered = project.nodes.slice().sort((a, b) => a.zIndex - b.zIndex);
    const index = ordered.findIndex((node) => node.id === id);
    const swap = index + direction;
    if (index < 0 || swap < 0 || swap >= ordered.length) return;
    updateNodes([{ id: ordered[index].id, patch: { zIndex: ordered[swap].zIndex } }, { id: ordered[swap].id, patch: { zIndex: ordered[index].zIndex } }], true, false);
  };
  return <section className="hierarchy-panel">
    <div className="hierarchy-heading"><strong>节点层级</strong><span>{project.nodes.length}</span></div>
    <input className="hierarchy-filter" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="筛选名称或类型" />
    <div className="hierarchy-list">
      {nodes.map((node) => <div key={node.id} className={`hierarchy-row ${selectedNodeIds.includes(node.id) ? 'selected' : ''}`} style={{ paddingLeft: node.groupId ? 20 : 6 }} onClick={() => selectNode(node.id)} onDoubleClick={() => window.dispatchEvent(new CustomEvent('refmind3d-focus-node-ids', { detail: { ids: [node.id] } }))}>
        <span className="hierarchy-type">{typeLabels[node.type] || node.type}</span><span className="hierarchy-name" title={node.title}>{node.title || '未命名'}</span>
        <button title={node.hidden ? '显示' : '隐藏'} onClick={(event) => { event.stopPropagation(); updateNode(node.id, { hidden: !node.hidden }, true, false); }}>{node.hidden ? '○' : '●'}</button>
        <button title={node.locked ? '解锁' : '锁定'} onClick={(event) => { event.stopPropagation(); updateNode(node.id, { locked: !node.locked }, true, false); }}>{node.locked ? '◆' : '◇'}</button>
        <button title="上移一层" onClick={(event) => { event.stopPropagation(); moveLayer(node.id, 1); }}>↑</button><button title="下移一层" onClick={(event) => { event.stopPropagation(); moveLayer(node.id, -1); }}>↓</button>
      </div>)}
      {nodes.length === 0 && <p className="muted">没有匹配节点</p>}
    </div>
    <span className="muted">单击选择，双击定位；显示、锁定和层级均保存到工程。</span>
  </section>;
}
