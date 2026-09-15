import { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { exists, stat } from '@tauri-apps/plugin-fs';
import { useProjectStore } from '../stores/projectStore';
import type { CanvasNode, ImportedModel } from '../shared/types';

function numberValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function proportionalSize(node: CanvasNode, next: number, axis: 'width' | 'height') {
  const ratio = node.height > 0 ? node.width / node.height : 1;
  if (node.cropEnabled) return axis === 'width' ? { width: Math.max(20, next) } : { height: Math.max(20, next) };
  if (axis === 'width') {
    const width = Math.max(20, next);
    return { width, height: Math.max(20, Math.round(width / ratio)) };
  }
  const height = Math.max(20, next);
  return { width: Math.max(20, Math.round(height * ratio)), height };
}

function toHexColor(value?: string, fallback = '#666666') {
  if (!value) return fallback;
  return /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : fallback;
}

const fonts = ['Segoe UI', 'Microsoft YaHei', 'SimHei', 'SimSun', 'Arial', 'Calibri', 'Times New Roman', 'Consolas', 'Cascadia Mono'];

export function InspectorPanel() {
  const { project, selectedNodeIds, updateNode, updateNodes, updateAsset } = useProjectStore();
  const selectedNodes = useMemo(() => project.nodes.filter((node) => selectedNodeIds.includes(node.id)), [project.nodes, selectedNodeIds]);
  const selected = selectedNodes[0];
  const asset = useMemo(() => selected?.assetId ? project.assets.find((item) => item.id === selected.assetId) : undefined, [project.assets, selected]);
  const [linkedMissing, setLinkedMissing] = useState(false);
  const patchSelected = (patch: Partial<CanvasNode>) => updateNodes(selectedNodes.map((node) => ({ id: node.id, patch })), true, false);

  useEffect(() => {
    let active = true;
    if (!asset || asset.storageMode !== 'linked' || !asset.originalPath) { setLinkedMissing(false); return; }
    void exists(asset.originalPath).then((value) => { if (active) setLinkedMissing(!value); }).catch(() => { if (active) setLinkedMissing(true); });
    return () => { active = false; };
  }, [asset]);

  const relinkAsset = async () => {
    if (!asset) return;
    const path = await open({ multiple: false, title: `重新定位 ${asset.name}` });
    if (!path || Array.isArray(path)) return;
    const info = await stat(path);
    updateAsset(asset.id, { originalPath: path, projectAssetPath: path, previewPath: asset.kind === 'image' ? path : asset.previewPath, fileSize: info.size, storageMode: 'linked' });
    setLinkedMissing(false);
    window.dispatchEvent(new Event('refmind3d-image-cache-reset'));
  };

  const batchRelink = async () => {
    const paths = await open({ multiple: true, title: '选择需要匹配的原始文件' });
    if (!paths) return;
    const candidates = Array.isArray(paths) ? paths : [paths];
    for (const path of candidates) {
      const name = path.split(/[\\/]/).pop()?.toLowerCase();
      const target = project.assets.find((item) => item.storageMode === 'linked' && item.name.toLowerCase() === name);
      if (!target) continue;
      const info = await stat(path);
      updateAsset(target.id, { originalPath: path, projectAssetPath: path, previewPath: target.kind === 'image' ? path : target.previewPath, fileSize: info.size });
    }
    window.dispatchEvent(new Event('refmind3d-image-cache-reset'));
  };

  if (!selected) return <aside className="inspector-panel"><h2>属性</h2><p className="muted">选择一个或多个节点后可编辑属性。</p></aside>;

  return (
    <aside className="inspector-panel">
      <div className="panel-heading"><h2>属性</h2><span>{selectedNodes.length > 1 ? `${selectedNodes.length} 个节点` : selected.type}</span></div>
      <div className="property-list">
        {selectedNodes.length === 1 && <label>名称<input value={selected.title} onChange={(event) => updateNode(selected.id, { title: event.currentTarget.value }, true)} /></label>}
        <div className="property-two-column">
          <label>X<input type="number" value={Math.round(selected.x)} onChange={(event) => updateNode(selected.id, { x: numberValue(event.currentTarget.value, selected.x) }, true)} /></label>
          <label>Y<input type="number" value={Math.round(selected.y)} onChange={(event) => updateNode(selected.id, { y: numberValue(event.currentTarget.value, selected.y) }, true)} /></label>
          <label>宽<input type="number" value={Math.round(selected.width)} onChange={(event) => updateNode(selected.id, proportionalSize(selected, numberValue(event.currentTarget.value, selected.width), 'width'), true)} /></label>
          <label>高<input type="number" value={Math.round(selected.height)} onChange={(event) => updateNode(selected.id, proportionalSize(selected, numberValue(event.currentTarget.value, selected.height), 'height'), true)} /></label>
        </div>
        <label>旋转<input type="number" value={Math.round(selected.rotation)} onChange={(event) => patchSelected({ rotation: numberValue(event.currentTarget.value, selected.rotation) })} /></label>
        <label>透明度 <output>{Math.round((selected.opacity ?? 1) * 100)}%</output><input type="range" min="5" max="100" value={Math.round((selected.opacity ?? 1) * 100)} onChange={(event) => patchSelected({ opacity: Number(event.currentTarget.value) / 100 })} /></label>
        <div className="property-action-grid">
          <button className={selected.locked ? 'active' : ''} onClick={() => patchSelected({ locked: !selected.locked })}>{selected.locked ? '解除锁定' : '锁定节点'}</button>
          <button onClick={() => patchSelected({ hidden: true })}>隐藏节点</button>
          <button className={selected.grayscale ? 'active' : ''} onClick={() => patchSelected({ grayscale: !selected.grayscale })}>灰度</button>
        </div>

        {selected.type === 'image' && <section className="property-section">
          <h3>图片无损编辑</h3>
          <div className="property-action-grid">
            <button className={selected.cropEnabled ? 'active' : ''} onClick={() => patchSelected({ cropEnabled: !selected.cropEnabled })}>裁切画框</button>
            <button onClick={() => patchSelected({ flipX: !selected.flipX })}>水平镜像</button>
            <button onClick={() => patchSelected({ flipY: !selected.flipY })}>垂直镜像</button>
            <button onClick={() => patchSelected({ cropEnabled: false, imageScale: 1, imagePanX: 0, imagePanY: 0, flipX: false, flipY: false })}>重置图片</button>
          </div>
          <label>画面缩放 <output>{Math.round((selected.imageScale ?? 1) * 100)}%</output><input type="range" min="10" max="800" value={Math.round((selected.imageScale ?? 1) * 100)} onChange={(event) => patchSelected({ imageScale: Number(event.currentTarget.value) / 100 })} /></label>
          <label>水平取景 <output>{selected.imagePanX ?? 0}%</output><input type="range" min="-100" max="100" value={selected.imagePanX ?? 0} onChange={(event) => patchSelected({ imagePanX: Number(event.currentTarget.value) })} /></label>
          <label>垂直取景 <output>{selected.imagePanY ?? 0}%</output><input type="range" min="-100" max="100" value={selected.imagePanY ?? 0} onChange={(event) => patchSelected({ imagePanY: Number(event.currentTarget.value) })} /></label>
          <p className="muted">开启“裁切画框”后可自由修改节点宽高，再用缩放和取景滑块调整画面；原始图片不会被改写。</p>
        </section>}

        {['note', 'mindmap', 'document', 'table', 'pdf'].includes(selected.type) && <section className="property-section">
          <h3>文本</h3>
          <label>字体<select value={selected.fontFamily || 'Segoe UI'} onChange={(event) => updateNode(selected.id, { fontFamily: event.currentTarget.value }, true)}>{fonts.map((font) => <option key={font}>{font}</option>)}</select></label>
          <div className="property-two-column">
            <label>字号<input type="number" min="6" max="240" value={selected.fontSize || 16} onChange={(event) => updateNode(selected.id, { fontSize: numberValue(event.currentTarget.value, 16) }, true)} /></label>
            <label>文字颜色<input type="color" value={toHexColor(selected.textColor, '#e8e8e8')} onChange={(event) => updateNode(selected.id, { textColor: event.currentTarget.value }, true)} /></label>
          </div>
          <div className="property-action-grid"><button className={selected.fontWeight === 'bold' ? 'active' : ''} onClick={() => updateNode(selected.id, { fontWeight: selected.fontWeight === 'bold' ? 'normal' : 'bold' }, true)}>粗体</button><button className={selected.fontStyle === 'italic' ? 'active' : ''} onClick={() => updateNode(selected.id, { fontStyle: selected.fontStyle === 'italic' ? 'normal' : 'italic' }, true)}>斜体</button></div>
          <label>内容<textarea value={selected.text || ''} onChange={(event) => updateNode(selected.id, { text: event.currentTarget.value }, true)} /></label>
        </section>}
      </div>

      {asset && <div className="asset-detail">
        <div className="panel-heading"><h3>资源</h3><span>{asset.format.toUpperCase()}</span></div>
        <p>{(asset.fileSize / 1024 / 1024).toFixed(2)} MB</p>
        <p className="path-text">{asset.originalPath || asset.projectAssetPath}</p>
        {linkedMissing && <p className="asset-missing-warning">链接文件已失联，请重新定位。</p>}
        <div className="segmented-control">
          <button className={(asset.storageMode || 'embedded') === 'embedded' ? 'active' : ''} onClick={() => updateAsset(asset.id, { storageMode: 'embedded' })}>嵌入工程</button>
          <button className={asset.storageMode === 'linked' ? 'active' : ''} onClick={() => updateAsset(asset.id, { storageMode: 'linked' })}>链接原文件</button>
        </div>
        {asset.storageMode === 'linked' && (
          <label className="inline-check">
            <input type="checkbox" checked={asset.autoRefresh !== false} onChange={(event) => updateAsset(asset.id, { autoRefresh: event.currentTarget.checked })} />
            源文件变化后自动刷新
          </label>
        )}
        <div className="property-action-grid"><button onClick={() => void relinkAsset()}>重新定位当前资源</button><button onClick={() => void batchRelink()}>批量按文件名匹配</button></div>
        <p className="muted">嵌入便于携带；链接可减小工程体积，但移动原文件后需要重新定位。</p>
        {asset.kind === 'model' && <div className="model-stats"><p>顶点：{(asset as ImportedModel).stats.vertices ?? '未知'}</p><p>面数：{(asset as ImportedModel).stats.faces ?? '未知'}</p></div>}
      </div>}
    </aside>
  );
}
