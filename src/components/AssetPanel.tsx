import { useProjectStore } from '../stores/projectStore';

function kindLabel(kind: string) {
  if (kind === 'image') return 'IMG';
  if (kind === 'model') return '3D';
  if (kind === 'video') return 'VID';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'table') return '表';
  if (kind === 'document') return '文';
  return kind.toUpperCase();
}

export function AssetPanel() {
  const { project } = useProjectStore();
  return (
    <aside className="asset-panel">
      <h2>资源</h2>
      <div className="asset-count">{project.assets.length} 个资源</div>
      <div className="asset-list">
        {project.assets.map((asset) => (
          <div className="asset-item" key={asset.id}>
            <div className="asset-kind">{kindLabel(asset.kind)}</div>
            <div className="asset-meta">
              <strong>{asset.name}</strong>
              <span>{asset.format.toUpperCase()} · {(asset.fileSize / 1024 / 1024).toFixed(2)} MB</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
