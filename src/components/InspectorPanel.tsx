import { useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import type { CanvasNode, ImportedModel } from '../shared/types';

function numberValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function proportionalSize(width: number, height: number, next: number, axis: 'width' | 'height') {
  const ratio = height > 0 ? width / height : 1;
  if (axis === 'width') {
    const safeWidth = Math.max(20, next);
    return { width: safeWidth, height: Math.max(20, Math.round(safeWidth / ratio)) };
  }
  const safeHeight = Math.max(20, next);
  return { width: Math.max(20, Math.round(safeHeight * ratio)), height: safeHeight };
}

function centerOf(node: CanvasNode) {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

const fontFamilies = [
  'Segoe UI',
  'Microsoft YaHei',
  'SimHei',
  'SimSun',
  'Arial',
  'Calibri',
  'Times New Roman',
  'Consolas',
  'Cascadia Mono'
];

function toHexColor(value?: string, fallback = '#666666') {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  const short = trimmed.match(/^#([0-9a-fA-F]{3})$/);
  if (short) {
    return `#${short[1].split('').map((char) => char + char).join('')}`;
  }
  const rgba = trimmed.match(/rgba?\(([^)]+)\)/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => Number(part.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) {
      return `#${parts.slice(0, 3).map((part) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return fallback;
}

function ColorField({
  label,
  value,
  fallback,
  swatches,
  onChange
}: {
  label: string;
  value?: string;
  fallback: string;
  swatches: string[];
  onChange: (value: string) => void;
}) {
  const colorValue = toHexColor(value, fallback);
  return (
    <label>{label}
      <div className="color-editor-row">
        <input
          type="color"
          value={colorValue}
          title="点击选择颜色"
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <input
          value={value || ''}
          placeholder={fallback}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </div>
      <div className="color-swatches">
        {swatches.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            style={{ background: color }}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
    </label>
  );
}

const groupFillSwatches = ['#4f6fa8', '#6e8f6b', '#a87b4f', '#8f5fa8', '#9a6a6a', '#5f8fa8', '#3a3a3a', '#202020'];
const groupStrokeSwatches = ['#9ab7ff', '#a9d89c', '#ffca8c', '#d89cff', '#ff9c9c', '#9ce0ff', '#d0d0d0', '#6b6b6b'];
const textFillSwatches = ['#2a2a2a', '#ffffff', '#fff3c4', '#dff2ff', '#e9ffe4', '#f5e3ff', '#ffe5e5', '#101010'];
const textColorSwatches = ['#e8e8e8', '#111111', '#ffffff', '#ffd166', '#8ab4ff', '#7ee787', '#ff9c9c', '#c792ea'];

export function InspectorPanel() {
  const { project, selectedNodeIds, updateNode, updateNodes } = useProjectStore();
  const selected = useMemo(() => project.nodes.find((node) => node.id === selectedNodeIds[0]), [project.nodes, selectedNodeIds]);
  const asset = useMemo(() => selected?.assetId ? project.assets.find((item) => item.id === selected.assetId) : undefined, [project.assets, selected]);

  const updateSize = (node: CanvasNode, next: number, axis: 'width' | 'height') => {
    const size = proportionalSize(node.width, node.height, next, axis);
    if (node.type !== 'group') {
      updateNode(node.id, size, true);
      return;
    }
    const center = centerOf(node);
    const scale = axis === 'width'
      ? size.width / Math.max(1, node.width)
      : size.height / Math.max(1, node.height);
    const updates = [
      {
        id: node.id,
        patch: {
          x: Math.round(center.x - size.width / 2),
          y: Math.round(center.y - size.height / 2),
          width: size.width,
          height: size.height
        }
      },
      ...project.nodes
        .filter((child) => child.groupId === node.id)
        .map((child) => ({
          id: child.id,
          patch: {
            x: Math.round(center.x + (child.x - center.x) * scale),
            y: Math.round(center.y + (child.y - center.y) * scale),
            width: Math.max(18, Math.round(child.width * scale)),
            height: Math.max(18, Math.round(child.height * scale))
          }
        }))
    ];
    updateNodes(updates, true);
  };

  return (
    <aside className="inspector-panel">
      <h2>属性</h2>
      {!selected && <p className="muted">未选择节点</p>}
      {selected && (
        <div className="property-list">
          <label>名称
            <input value={selected.title} onChange={(event) => updateNode(selected.id, { title: event.currentTarget.value }, true)} />
          </label>
          <label>X
            <input type="number" value={Math.round(selected.x)} onChange={(event) => updateNode(selected.id, { x: numberValue(event.currentTarget.value, selected.x) }, true)} />
          </label>
          <label>Y
            <input type="number" value={Math.round(selected.y)} onChange={(event) => updateNode(selected.id, { y: numberValue(event.currentTarget.value, selected.y) }, true)} />
          </label>
          <label>宽（等比）
            <input
              type="number"
              value={Math.round(selected.width)}
              onChange={(event) => updateSize(selected, numberValue(event.currentTarget.value, selected.width), 'width')}
            />
          </label>
          <label>高（等比）
            <input
              type="number"
              value={Math.round(selected.height)}
              onChange={(event) => updateSize(selected, numberValue(event.currentTarget.value, selected.height), 'height')}
            />
          </label>
          <label>旋转
            <input type="number" value={Math.round(selected.rotation)} onChange={(event) => updateNode(selected.id, { rotation: numberValue(event.currentTarget.value, selected.rotation) }, true)} />
          </label>
          {(selected.type === 'group' || ['note','mindmap','document','table','pdf'].includes(selected.type)) && (
            <>
              <ColorField
                label={selected.type === 'group' ? '组背景颜色' : (['document','table','pdf'].includes(selected.type) ? '内容背景颜色' : '文本背景颜色')}
                value={selected.fillColor}
                fallback={selected.type === 'group' ? '#4f6fa8' : (['document','table','pdf'].includes(selected.type) ? '#ffffff' : '#2a2a2a')}
                swatches={selected.type === 'group' ? groupFillSwatches : textFillSwatches}
                onChange={(value) => updateNode(selected.id, { fillColor: value }, true)}
              />
              <ColorField
                label={selected.type === 'group' ? '组边框颜色' : (['document','table','pdf'].includes(selected.type) ? '内容边框颜色' : '文本边框颜色')}
                value={selected.strokeColor}
                fallback={selected.type === 'group' ? '#9ab7ff' : '#747474'}
                swatches={selected.type === 'group' ? groupStrokeSwatches : groupStrokeSwatches}
                onChange={(value) => updateNode(selected.id, { strokeColor: value }, true)}
              />
            </>
          )}
          {(['note','mindmap','document','table','pdf'].includes(selected.type)) && (
            <>
              <label>字体
                <select value={selected.fontFamily || 'Segoe UI'} onChange={(event) => updateNode(selected.id, { fontFamily: event.currentTarget.value }, true)}>
                  {fontFamilies.map((font) => <option key={font} value={font}>{font}</option>)}
                </select>
              </label>
              <label>字号
                <input
                  type="number"
                  min={6}
                  max={240}
                  value={selected.fontSize || 16}
                  onChange={(event) => updateNode(selected.id, { fontSize: numberValue(event.currentTarget.value, selected.fontSize || 16) }, true)}
                />
              </label>
              <ColorField
                label="文字颜色"
                value={selected.textColor}
                fallback="#e8e8e8"
                swatches={textColorSwatches}
                onChange={(value) => updateNode(selected.id, { textColor: value }, true)}
              />
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={(selected.fontWeight || 'normal') === 'bold'}
                  onChange={(event) => updateNode(selected.id, { fontWeight: event.currentTarget.checked ? 'bold' : 'normal' }, true)}
                />
                加粗
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={(selected.fontStyle || 'normal') === 'italic'}
                  onChange={(event) => updateNode(selected.id, { fontStyle: event.currentTarget.checked ? 'italic' : 'normal' }, true)}
                />
                倾斜
              </label>
              <label>{['document','table','pdf'].includes(selected.type) ? '可编辑内容' : '文本内容'}
                <textarea value={selected.text || ''} onChange={(event) => updateNode(selected.id, { text: event.currentTarget.value }, true)} />
              </label>
            </>
          )}
          {selected.type === 'group' && (
            <p className="muted">这是组节点。单击组会移动整个组；双击组后才可选择组内物体。组外物体的中心点进入组范围后会自动归组，组边缘会按组内物体最外侧自动扩展。</p>
          )}
        </div>
      )}
      {asset && (
        <div className="asset-detail">
          <h3>资源信息</h3>
          <p>格式：{asset.format}</p>
          <p>大小：{(asset.fileSize / 1024 / 1024).toFixed(2)} MB</p>
          <p className="path-text">{asset.projectAssetPath}</p>
          {asset.kind === 'model' && (
            <div className="model-stats">
              <h3>模型统计</h3>
              <p>顶点：{(asset as ImportedModel).stats.vertices ?? '未知'}</p>
              <p>面数：{(asset as ImportedModel).stats.faces ?? '未知'}</p>
              <p>警告：{(asset as ImportedModel).stats.warningLevel}</p>
              {(asset as ImportedModel).stats.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
