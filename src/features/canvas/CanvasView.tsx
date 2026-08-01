import { MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useProjectStore } from '../../stores/projectStore';
import type { AssetRecord, CanvasNode, ImportedModel, SpreadsheetCell, SpreadsheetCellStyle, SpreadsheetMerge, SpreadsheetSheet, SpreadsheetWorkbook } from '../../shared/types';
import { ModelViewer } from '../model-viewer/ModelViewer';
import { FREE_TEXT_FONT_FAMILY, FREE_TEXT_PLACEHOLDER, freeTextNodeSize } from '../../shared/freeText';

interface ViewState {
  x: number;
  y: number;
  scale: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type SelectionMode = 'replace' | 'add' | 'subtract';

const DIRECT_IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'ico', 'avif', 'svg']);

function isRuntimeResourceUrl(path: string) {
  return path.startsWith('refmind3d://') || path.startsWith('http://refmind3d.localhost') || path.startsWith('https://refmind3d.localhost');
}

function displayAssetPath(path: string) {
  return path.startsWith('data:') || path.startsWith('blob:') || isRuntimeResourceUrl(path) ? path : convertFileSrc(path);
}

function assetUrl(asset?: AssetRecord, preferThumbnail = false) {
  if (!asset) return '';
  if (preferThumbnail && asset.embeddedThumbnailDataUrl) return asset.embeddedThumbnailDataUrl;
  if (preferThumbnail && asset.thumbnailPath) return displayAssetPath(asset.thumbnailPath);
  if (asset.embeddedPreviewDataUrl) return asset.embeddedPreviewDataUrl;
  if (asset.previewPath) return displayAssetPath(asset.previewPath);
  if (asset.embeddedDataUrl) return asset.embeddedDataUrl;
  const format = (asset.format || '').toLowerCase();
  const path = DIRECT_IMAGE_FORMATS.has(format)
    ? (asset.projectAssetPath || asset.originalPath || asset.previewPath || '')
    : (asset.previewPath || asset.projectAssetPath || asset.originalPath);
  return displayAssetPath(path);
}

function assetModelSource(asset?: AssetRecord) {
  if (!asset) return '';
  return asset.embeddedDataUrl || asset.projectAssetPath || asset.originalPath || '';
}

function isLockedContainerGroup(node?: CanvasNode) {
  return Boolean(node && node.type === 'group' && node.isGroupContainer !== false && node.groupLocked !== false);
}

function normalizeRect(startX: number, startY: number, endX: number, endY: number): Rect {
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  return { x, y, width: Math.abs(endX - startX), height: Math.abs(endY - startY) };
}

function rectIntersects(first: Rect, second: Rect) {
  const epsilon = 0.01;
  return first.x < second.x + second.width - epsilon
    && first.x + first.width > second.x + epsilon
    && first.y < second.y + second.height - epsilon
    && first.y + first.height > second.y + epsilon;
}

function selectionBoundsForNode(node: CanvasNode): Rect {
  const rotation = Number.isFinite(node.rotation) ? node.rotation : 0;
  if (Math.abs(rotation % 180) < 0.01) {
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  }
  const radians = rotation * Math.PI / 180;
  const width = Math.abs(node.width * Math.cos(radians)) + Math.abs(node.height * Math.sin(radians));
  const height = Math.abs(node.width * Math.sin(radians)) + Math.abs(node.height * Math.cos(radians));
  return {
    x: node.x + (node.width - width) / 2,
    y: node.y + (node.height - height) / 2,
    width,
    height
  };
}

function nodeCenter(node?: CanvasNode): Point {
  if (!node) return { x: 0, y: 0 };
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function horizontalConnectionPoint(node: CanvasNode | undefined, toward: Point): Point {
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

function connectionPath(fromScreen: Point, toScreen: Point, scale = 1) {
  // Keep both endpoint tangents horizontal. Choosing a vertical curve when the
  // vertical offset becomes larger was the source of the visible "reversal".
  const direction = toScreen.x >= fromScreen.x ? 1 : -1;
  const distance = Math.abs(toScreen.x - fromScreen.x);
  const dx = Math.min(distance / 2, Math.max(24 * scale, distance * 0.45));
  return `M ${fromScreen.x} ${fromScreen.y} C ${fromScreen.x + dx * direction} ${fromScreen.y}, ${toScreen.x - dx * direction} ${toScreen.y}, ${toScreen.x} ${toScreen.y}`;
}

function colorInputValue(value: string | undefined, fallback: string) {
  const text = (value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text;
  if (/^#[0-9a-fA-F]{3}$/.test(text)) {
    const [, r, g, b] = text.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/) || [];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
}


function isConnectableNode(node: CanvasNode | undefined) {
  return Boolean(node && node.type !== 'group');
}

function nodeContainsPoint(node: CanvasNode, point: Point) {
  return point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height;
}

function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)));
}

function boundsForNodes(nodes: CanvasNode[]) {
  if (nodes.length === 0) return null;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return { left, top, right, bottom, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function mouseButtonFromShortcut(shortcut: string) {
  const normalized = shortcut.toLowerCase().replace(/\s+/g, '');
  if (normalized.includes('leftmouse') || normalized.includes('左键')) return 0;
  if (normalized.includes('middlemouse') || normalized.includes('中键')) return 1;
  return 2;
}

function mouseShortcutMatches(event: ReactMouseEvent, shortcut: string) {
  const normalized = shortcut.toLowerCase().replace(/\s+/g, '');
  if (event.button !== mouseButtonFromShortcut(shortcut)) return false;
  if (normalized.includes('alt') && !event.altKey) return false;
  if (normalized.includes('ctrl') && !event.ctrlKey) return false;
  if (normalized.includes('shift') && !event.shiftKey) return false;
  if (normalized.includes('meta') && !event.metaKey) return false;
  return true;
}

function resizeMetric(point: Point, center: Point, handle: ResizeHandle) {
  const dx = Math.abs(point.x - center.x);
  const dy = Math.abs(point.y - center.y);
  if (handle === 'e' || handle === 'w') return dx;
  if (handle === 'n' || handle === 's') return dy;
  return Math.max(dx, dy);
}

const resizeHandles: ResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function isTextNode(node: CanvasNode) {
  return ['note', 'mindmap', 'document', 'table', 'pdf'].includes(node.type);
}

function documentLabel(node: CanvasNode) {
  if (node.type === 'pdf') return 'PDF';
  if (node.type === 'table') return '表格';
  if (node.type === 'document') return '文档';
  return '';
}


function tableRowsFromText(text?: string) {
  if (!text?.trim()) return [] as string[][];
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 160)
    .map((line) => line.includes('\t') ? line.split('\t') : [line]);
}


function imageTagPath(value: string) {
  const match = value.trim().match(/^\[\[image:(.+)\]\]$/);
  return match ? match[1] : null;
}

function renderTableCell(cell: string) {
  const path = imageTagPath(cell);
  if (path) {
    return <img className="embedded-document-image" src={displayAssetPath(path)} draggable={false} alt="表格内图片" />;
  }
  return cell || ' ';
}

const RICH_TEXT_TAGS = new Set(['ARTICLE', 'P', 'BR', 'H1', 'H2', 'H3', 'STRONG', 'B', 'EM', 'I', 'U', 'SPAN', 'UL', 'OL', 'LI', 'TABLE', 'TBODY', 'TR', 'TD', 'TH', 'IMG']);
const RICH_TEXT_ATTRS = new Set(['style', 'src', 'alt', 'data-refmind-src', 'colspan', 'rowspan']);

function sanitizeRichHtml(html?: string) {
  if (!html?.trim() || typeof document === 'undefined') return '';
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('*').forEach((element) => {
    if (!RICH_TEXT_TAGS.has(element.tagName)) {
      element.replaceWith(document.createTextNode(element.textContent || ''));
      return;
    }
    Array.from(element.attributes).forEach((attr) => {
      if (!RICH_TEXT_ATTRS.has(attr.name.toLowerCase())) {
        element.removeAttribute(attr.name);
      }
    });
    if (element instanceof HTMLImageElement) {
      const raw = element.getAttribute('data-refmind-src') || element.getAttribute('src') || '';
      if (raw && !raw.startsWith('data:') && !raw.startsWith('http://') && !raw.startsWith('https://') && !raw.startsWith('blob:')) {
        element.setAttribute('data-refmind-src', raw);
        element.setAttribute('src', displayAssetPath(raw));
      }
      element.setAttribute('draggable', 'false');
    }
  });
  return template.innerHTML;
}

function richHtmlToText(html?: string) {
  if (!html?.trim() || typeof document === 'undefined') return '';
  const container = document.createElement('div');
  container.innerHTML = html
    .replace(/<\/(p|h1|h2|h3|li|tr)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<br\s*\/?>/gi, '\n');
  return (container.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function renderRichDocument(node: CanvasNode) {
  const html = sanitizeRichHtml(node.richTextHtml);
  if (!html) return null;
  return <div className="rich-document-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}


function freeTextPatch(node: CanvasNode, text: string): Partial<CanvasNode> {
  if (!['note', 'mindmap'].includes(node.type)) return { text };
  return { text, ...freeTextNodeSize(text, node) };
}

function renderSpreadsheetPreview(
  node: CanvasNode,
  activeSheetIndex = 0,
  onSheetChange?: (index: number) => void
) {
  const workbook = node.spreadsheetData;
  const active = activeSpreadsheetSheet(workbook, activeSheetIndex);
  if (!workbook || !active) return null;
  const { sheet, index } = active;
  const cellMap = spreadsheetCellMap(sheet);
  const { maxRow, maxCol } = spreadsheetBounds(sheet);
  return (
    <div className="spreadsheet-workbook" onMouseDown={(event) => event.stopPropagation()}>
      {workbook.sheets.length > 1 && (
        <div className="spreadsheet-tabs">
          {workbook.sheets.map((item, sheetIndex) => (
            <button
              key={item.id || item.name || sheetIndex}
              className={sheetIndex === index ? 'active' : ''}
              onClick={(event) => {
                event.stopPropagation();
                onSheetChange?.(sheetIndex);
              }}
            >
              {item.name || `Sheet${sheetIndex + 1}`}
            </button>
          ))}
        </div>
      )}
      <div className="spreadsheet-scroll">
        <table className="spreadsheet-grid">
          <tbody>
            {Array.from({ length: maxRow }, (_, rowOffset) => {
              const rowNumber = rowOffset + 1;
              return (
                <tr key={rowNumber}>
                  {Array.from({ length: maxCol }, (_, colOffset) => {
                    const colNumber = colOffset + 1;
                    if (isCoveredMergedCell(sheet.merges, rowNumber, colNumber)) return null;
                    const merge = mergeForCell(sheet.merges, rowNumber, colNumber);
                    const cell = cellMap.get(sheetCellKey(rowNumber, colNumber));
                    return (
                      <td
                        key={colNumber}
                        colSpan={merge ? merge.endCol - merge.startCol + 1 : 1}
                        rowSpan={merge ? merge.endRow - merge.startRow + 1 : 1}
                        style={{ width: columnWidth(sheet, colNumber), ...spreadsheetCellCss(cell?.style) }}
                      >
                        {cell?.value || ' '}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderTextPreview(
  node: CanvasNode,
  activeSheetIndex = 0,
  onSheetChange?: (index: number) => void
) {
  if (node.type === 'document' && node.richTextHtml?.trim()) {
    return renderRichDocument(node);
  }
  if (node.type === 'table' && node.spreadsheetData) {
    return renderSpreadsheetPreview(node, activeSheetIndex, onSheetChange);
  }
  if (!node.text?.trim()) return <span className="note-placeholder">{FREE_TEXT_PLACEHOLDER}</span>;
  if (node.type === 'table') {
    const rows = tableRowsFromText(node.text);
    const hasCells = rows.some((row) => row.length > 1);
    if (hasCells) {
      return (
        <div className="table-preview-scroll">
          <table className="table-node-preview">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`${rowIndex}-${row.join('|')}`} className={row.length === 1 ? 'table-section-row' : undefined}>
                  {row.map((cell, cellIndex) => {
                    const embeddedImage = imageTagPath(cell);
                    return (
                      <td key={cellIndex} colSpan={row.length === 1 ? 99 : 1} className={embeddedImage ? 'embedded-image-cell' : undefined}>
                        {renderTableCell(cell)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
  return node.text;
}

function tableRowsForEdit(text?: string) {
  const lines = text?.length ? text.split(/\r?\n/) : [''];
  const rows = lines.map((line) => line.split('\t'));
  const maxCols = Math.max(1, ...rows.map((row) => row.length));
  return rows.map((row) => {
    const next = [...row];
    while (next.length < maxCols) next.push('');
    return next;
  });
}

function serializeTableRows(rows: string[][]) {
  return rows.map((row) => row.join('\t')).join('\n');
}

function sheetCellKey(row: number, col: number) {
  return `${row}:${col}`;
}

function activeSpreadsheetSheet(workbook?: SpreadsheetWorkbook, preferredIndex = 0) {
  if (!workbook?.sheets?.length) return null;
  const index = Math.min(Math.max(0, preferredIndex), workbook.sheets.length - 1);
  return { sheet: workbook.sheets[index], index };
}

function spreadsheetBounds(sheet: SpreadsheetSheet) {
  let maxRow = 1;
  let maxCol = 1;
  sheet.rows.forEach((row) => {
    maxRow = Math.max(maxRow, row.index);
    row.cells.forEach((cell) => {
      maxRow = Math.max(maxRow, cell.row || row.index);
      maxCol = Math.max(maxCol, cell.col);
    });
  });
  sheet.merges?.forEach((merge) => {
    maxRow = Math.max(maxRow, merge.endRow);
    maxCol = Math.max(maxCol, merge.endCol);
  });
  return { maxRow: Math.min(maxRow, 240), maxCol: Math.min(maxCol, 80) };
}

function spreadsheetCellMap(sheet: SpreadsheetSheet) {
  const map = new Map<string, SpreadsheetCell>();
  sheet.rows.forEach((row) => {
    row.cells.forEach((cell) => {
      map.set(sheetCellKey(cell.row || row.index, cell.col), cell);
    });
  });
  return map;
}

function mergeForCell(merges: SpreadsheetMerge[] | undefined, row: number, col: number) {
  return merges?.find((merge) => row >= merge.startRow && row <= merge.endRow && col >= merge.startCol && col <= merge.endCol);
}

function isCoveredMergedCell(merges: SpreadsheetMerge[] | undefined, row: number, col: number) {
  const merge = mergeForCell(merges, row, col);
  return Boolean(merge && (merge.startRow !== row || merge.startCol !== col));
}

function columnWidth(sheet: SpreadsheetSheet, col: number) {
  const width = sheet.columns?.find((item) => item.index === col)?.width;
  return width ? Math.max(48, Math.round(width * 7)) : 96;
}

function spreadsheetCellCss(style?: SpreadsheetCellStyle): CSSProperties {
  return {
    fontWeight: style?.bold ? 700 : undefined,
    fontStyle: style?.italic ? 'italic' : undefined,
    textDecoration: style?.underline ? 'underline' : undefined,
    fontSize: style?.fontSize ? `${style.fontSize}px` : undefined,
    fontFamily: style?.fontFamily,
    color: style?.color,
    backgroundColor: style?.backgroundColor,
    textAlign: style?.align,
    verticalAlign: style?.verticalAlign === 'middle' ? 'middle' : style?.verticalAlign
  };
}

function workbookToText(workbook?: SpreadsheetWorkbook) {
  if (!workbook?.sheets?.length) return '';
  return workbook.sheets.map((sheet) => {
    const cellMap = spreadsheetCellMap(sheet);
    const { maxRow, maxCol } = spreadsheetBounds(sheet);
    const lines = [`Sheet: ${sheet.name}`];
    for (let row = 1; row <= maxRow; row += 1) {
      const values: string[] = [];
      for (let col = 1; col <= maxCol; col += 1) {
        values.push(cellMap.get(sheetCellKey(row, col))?.value || '');
      }
      if (values.some((value) => value.trim())) lines.push(values.join('\t').replace(/\t+$/g, ''));
    }
    return lines.join('\n');
  }).join('\n\n');
}

function cloneWorkbook(workbook: SpreadsheetWorkbook): SpreadsheetWorkbook {
  return JSON.parse(JSON.stringify(workbook)) as SpreadsheetWorkbook;
}

const CanvasImage = ({ asset, lowZoom, alt, selected, title }: {
  asset: AssetRecord;
  lowZoom: boolean;
  alt?: string;
  selected: boolean;
  title?: string;
}) => {
  const [highResLoaded, setHighResLoaded] = useState(false);
  
  useEffect(() => {
    if (!lowZoom) {
      setHighResLoaded(true);
    }
  }, [lowZoom]);

  const useThumbnail = lowZoom && !highResLoaded;
  const src = assetUrl(asset, useThumbnail);

  return (
    <>
      <span className="image-node-fallback">{title || '图片预览'}</span>
      <img
        className="image-node"
        src={src}
        draggable={false}
        loading="lazy"
        decoding="async"
        fetchPriority={selected ? 'high' : 'low'}
        alt={alt}
        onLoad={(event) => {
          event.currentTarget.style.opacity = '1';
        }}
        onError={(event) => {
          const image = event.currentTarget;
          image.style.objectFit = 'contain';
          image.style.padding = '16px';
          image.style.opacity = '0';
          image.alt = `图片预览加载失败：${asset.previewPath || asset.projectAssetPath}`;
        }}
      />
    </>
  );
};

export function CanvasView({
  focusContentKey,
  showGrid = true,
  drawMode = false,
  mindChildShortcut = 'Alt+RightMouse',
  onOpenModel,
  onPointerWorldChange
}: {
  focusContentKey?: string;
  showGrid?: boolean;
  drawMode?: boolean;
  mindChildShortcut?: string;
  onOpenModel?: (asset: ImportedModel) => void;
  onPointerWorldChange?: (point: Point) => void;
}) {
  const {
    project,
    selectedNodeIds,
    selectNode,
    selectNodes,
    clearSelection,
    updateNode,
    updateNodes,
    beginHistory,
    bringNodesToFront,
    createDrawBox,
    createMindChild,
    createMindLink,
    deleteMindLink,
    completeGroupDrop,
    normalizeGroups
  } = useProjectStore();
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, scale: 1 });
  const [drag, setDrag] = useState<{
    ids?: string[];
    startX: number;
    startY: number;
    origins?: Record<string, { x: number; y: number }>;
    originX: number;
    originY: number;
    pan?: boolean;
  } | null>(null);
  const [selection, setSelection] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    mode: SelectionMode;
    initialNodeIds: string[];
    scopeGroupId?: string;
  } | null>(null);
  const [drawRect, setDrawRect] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [activeSheetByNode, setActiveSheetByNode] = useState<Record<string, number>>({});
  const [selectedSheetCellByNode, setSelectedSheetCellByNode] = useState<Record<string, { row: number; col: number }>>({});
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [mindDrag, setMindDrag] = useState<{ sourceId: string; start: Point; current: Point } | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [resize, setResize] = useState<{
    nodeId: string;
    handle: ResizeHandle;
    startMetric: number;
    center: Point;
    origin: CanvasNode;
    childOrigins: CanvasNode[];
  } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const editingRef = useRef<HTMLTextAreaElement | HTMLDivElement | null>(null);
  const interactionHistoryRecordedRef = useRef(false);
  const textEditHistoryRecordedRef = useRef(false);
  const deferredUpdatesRef = useRef<Array<{ id: string; patch: Partial<CanvasNode> }> | null>(null);
  const deferredUpdateFrameRef = useRef<number | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const panPreviewRef = useRef({ x: 0, y: 0 });
  const panGestureRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const zoomRef = useRef<ViewState | null>(null);
  const wheelTimeoutRef = useRef<number | null>(null);

  const flushZoom = () => {
    if (wheelTimeoutRef.current !== null) {
      window.clearTimeout(wheelTimeoutRef.current);
      wheelTimeoutRef.current = null;
    }
    if (viewportRef.current) {
      viewportRef.current.classList.remove('is-zooming');
    }
    worldRef.current?.style.setProperty('transform', 'none', 'important');
    if (zoomRef.current) {
      const targetView = zoomRef.current;
      zoomRef.current = null;
      setView(targetView);
    }
  };

  const flushDeferredNodeUpdates = () => {
    if (deferredUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(deferredUpdateFrameRef.current);
      deferredUpdateFrameRef.current = null;
    }
    const updates = deferredUpdatesRef.current;
    deferredUpdatesRef.current = null;
    if (updates?.length) updateNodes(updates, false, false);
  };

  const scheduleNodeUpdates = (updates: Array<{ id: string; patch: Partial<CanvasNode> }>) => {
    deferredUpdatesRef.current = updates;
    if (deferredUpdateFrameRef.current !== null) return;
    deferredUpdateFrameRef.current = window.requestAnimationFrame(() => {
      deferredUpdateFrameRef.current = null;
      const pending = deferredUpdatesRef.current;
      deferredUpdatesRef.current = null;
      if (pending?.length) updateNodes(pending, false, false);
    });
  };

  const recordInteractionHistory = () => {
    if (interactionHistoryRecordedRef.current) return;
    interactionHistoryRecordedRef.current = true;
    beginHistory();
  };

  const recordTextEditHistory = () => {
    if (textEditHistoryRecordedRef.current) return;
    textEditHistoryRecordedRef.current = true;
    beginHistory();
  };

  useEffect(() => () => {
    if (deferredUpdateFrameRef.current !== null) window.cancelAnimationFrame(deferredUpdateFrameRef.current);
    if (wheelTimeoutRef.current !== null) window.clearTimeout(wheelTimeoutRef.current);
  }, []);

  const assetsById = useMemo(() => {
    const map = new Map<string, AssetRecord>();
    project.assets.forEach((asset) => map.set(asset.id, asset));
    return map;
  }, [project.assets]);

  const nodesById = useMemo(() => {
    const map = new Map<string, CanvasNode>();
    project.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [project.nodes]);

  const groupVisualZIndexes = useMemo(() => {
    const minimumChildZ = new Map<string, number>();
    project.nodes.forEach((node) => {
      if (!node.groupId) return;
      const current = minimumChildZ.get(node.groupId);
      minimumChildZ.set(node.groupId, Math.min(current ?? Number.POSITIVE_INFINITY, node.zIndex || 0));
    });
    return new Map(project.nodes
      .filter((node) => node.type === 'group' && node.isGroupContainer !== false)
      .map((group) => [group.id, Math.min(group.zIndex || 0, (minimumChildZ.get(group.id) ?? 0) - 1)]));
  }, [project.nodes]);

  const visualZIndex = (node: CanvasNode) => groupVisualZIndexes.get(node.id) ?? node.zIndex;

  const renderedNodes = useMemo(() => {
    // Keep a generous pre-render margin so normal pans never reveal an empty
    // edge, while excluding distant high-resolution images from WebView decode,
    // layout, paint and GPU texture work.
    const overscanX = Math.max(1200, viewportSize.width * 1.5);
    const overscanY = Math.max(900, viewportSize.height * 1.5);
    return project.nodes.filter((node) => {
      if (node.id === editingNodeId || node.id === activeGroupId) return true;
      const left = node.x * view.scale + view.x;
      const top = node.y * view.scale + view.y;
      const right = left + node.width * view.scale;
      const bottom = top + node.height * view.scale;
      return right >= -overscanX
        && left <= viewportSize.width + overscanX
        && bottom >= -overscanY
        && top <= viewportSize.height + overscanY;
    });
  }, [project.nodes, view, viewportSize, editingNodeId, activeGroupId]);

  useEffect(() => {
    if (selectedLinkId && !project.links.some((link) => link.id === selectedLinkId)) {
      setSelectedLinkId(null);
    }
  }, [project.links, selectedLinkId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editable = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (editable) return;
      if (!selectedLinkId) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      event.preventDefault();
      event.stopPropagation();
      deleteMindLink(selectedLinkId);
      setSelectedLinkId(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [selectedLinkId, deleteMindLink]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({ width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    window.addEventListener('resize', updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  const toScreenPoint = (point: Point): Point => ({
    x: point.x * view.scale + view.x,
    y: point.y * view.scale + view.y
  });

  const toScreenRect = (rect: Rect): Rect => ({
    x: rect.x * view.scale + view.x,
    y: rect.y * view.scale + view.y,
    width: rect.width * view.scale,
    height: rect.height * view.scale
  });

  const screenNodeRect = (node: CanvasNode): Rect => ({
    x: node.x * view.scale + view.x,
    y: node.y * view.scale + view.y,
    width: Math.max(1, node.width * view.scale),
    height: Math.max(1, node.height * view.scale)
  });

  const renderedNodeRect = (node: CanvasNode): Rect => {
    const viewport = viewportRef.current;
    const element = viewport?.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
    if (viewport && element) {
      const viewportRect = viewport.getBoundingClientRect();
      const nodeRect = element.getBoundingClientRect();
      return {
        x: nodeRect.left - viewportRect.left,
        y: nodeRect.top - viewportRect.top,
        width: nodeRect.width,
        height: nodeRect.height
      };
    }
    return toScreenRect(selectionBoundsForNode(node));
  };

  const focusNodes = (nodesToFocus: CanvasNode[], maxScale = 2.6) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const bounds = boundsForNodes(nodesToFocus);
    if (!rect || !bounds) return;
    const margin = 140;
    const fitScale = Math.min(
      rect.width / Math.max(1, bounds.width + margin),
      rect.height / Math.max(1, bounds.height + margin)
    );
    const nextScale = Math.max(0.02, Math.min(maxScale, fitScale));
    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    setView({
      x: rect.width / 2 - centerX * nextScale,
      y: rect.height / 2 - centerY * nextScale,
      scale: nextScale
    });
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (project.nodes.length > 0) {
        focusNodes(project.nodes, 1.5);
      } else {
        setView({ x: 0, y: 0, scale: 1 });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusContentKey]);

  useEffect(() => {
    const resetView = () => setView({ x: 0, y: 0, scale: 1 });
    window.addEventListener('refmind3d-reset-view', resetView);
    return () => window.removeEventListener('refmind3d-reset-view', resetView);
  }, []);

  useEffect(() => {
    const focusSelection = () => {
      const selected = project.nodes.filter((node) => selectedNodeIds.includes(node.id));
      const nodesToFocus = selected.length > 0 ? selected : project.nodes;
      focusNodes(nodesToFocus);
    };
    const focusNodeIds = (event: Event) => {
      const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids || [];
      const targetNodes = project.nodes.filter((node) => ids.includes(node.id));
      if (targetNodes.length > 0) {
        selectNodes(ids);
        focusNodes(targetNodes);
      }
    };
    window.addEventListener('refmind3d-focus-selection', focusSelection);
    window.addEventListener('refmind3d-focus-node-ids', focusNodeIds);
    return () => {
      window.removeEventListener('refmind3d-focus-selection', focusSelection);
      window.removeEventListener('refmind3d-focus-node-ids', focusNodeIds);
    };
  }, [project.nodes, selectedNodeIds]);

  useEffect(() => {
    const onEditNode = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      if (id) setEditingNodeId(id);
    };
    window.addEventListener('refmind3d-edit-node', onEditNode);
    return () => window.removeEventListener('refmind3d-edit-node', onEditNode);
  }, []);

  useEffect(() => {
    if (editingNodeId && editingRef.current) {
      editingRef.current.focus();
      if (editingRef.current instanceof HTMLTextAreaElement) {
        editingRef.current.select();
      }
    }
  }, [editingNodeId]);

  useEffect(() => {
    if (!editingNodeId) textEditHistoryRecordedRef.current = false;
  }, [editingNodeId]);

  const worldPoint = (clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const left = rect?.left || 0;
    const top = rect?.top || 0;
    const current = zoomRef.current || view;
    return {
      x: (clientX - left - current.x) / current.scale,
      y: (clientY - top - current.y) / current.scale
    };
  };

  const rememberPointer = (clientX: number, clientY: number) => {
    const point = worldPoint(clientX, clientY);
    onPointerWorldChange?.(point);
    return point;
  };

  useEffect(() => {
    const bridge = window as unknown as { __refmind3dClientToWorld?: (clientX: number, clientY: number) => Point };
    bridge.__refmind3dClientToWorld = (clientX: number, clientY: number) => worldPoint(clientX, clientY);
    return () => {
      if (bridge.__refmind3dClientToWorld) delete bridge.__refmind3dClientToWorld;
    };
  }, [view]);

  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const applyPanPreview = (clientX: number, clientY: number) => {
      const gesture = panGestureRef.current;
      if (!gesture?.active) return;
      const offset = {
        x: clientX - gesture.startX,
        y: clientY - gesture.startY
      };
      panPreviewRef.current = offset;
      worldRef.current?.style.setProperty(
        'transform',
        `translate3d(${offset.x}px, ${offset.y}px, 0)`,
        'important'
      );
    };

    const finishPan = (clientX?: number, clientY?: number) => {
      const gesture = panGestureRef.current;
      if (!gesture?.active) return;

      // The mouseup position is authoritative. WebView2 can omit the final
      // mousemove (especially near the viewport edge), which previously left
      // a stale preview offset and made the committed camera appear to jump.
      if (clientX !== undefined && clientY !== undefined) {
        applyPanPreview(clientX, clientY);
      }
      const offset = panPreviewRef.current;
      panGestureRef.current = null;
      worldRef.current?.style.setProperty('transform', 'none', 'important');
      worldRef.current?.style.removeProperty('will-change');
      setView((current) => ({
        ...current,
        x: gesture.originX + offset.x,
        y: gesture.originY + offset.y
      }));
      panPreviewRef.current = { x: 0, y: 0 };
      setDrag(null);
    };

    const handleMousedown = (event: MouseEvent) => {
      const isMiddle = event.button === 1;
      const isAltLeft = event.altKey && event.button === 0;
      if (!isMiddle && !isAltLeft) return;

      const viewport = viewportRef.current;
      const target = event.target as Node | null;
      if (!viewport || (target && !viewport.contains(target))) return;

      event.preventDefault();
      event.stopPropagation();

      // Capture the pending zoom camera before flushing it. React state is
      // asynchronous, so reading viewRef after flushZoom used to occasionally
      // start a pan from the older camera and snap back on release.
      const originView = zoomRef.current || viewRef.current;
      flushZoom();
      panPreviewRef.current = { x: 0, y: 0 };
      panGestureRef.current = {
        active: true,
        startX: event.clientX,
        startY: event.clientY,
        originX: originView.x,
        originY: originView.y
      };
      setDrag({
        startX: event.clientX,
        startY: event.clientY,
        originX: originView.x,
        originY: originView.y,
        pan: true
      });
    };

    const handleMousemove = (event: MouseEvent) => {
      if (!panGestureRef.current?.active) return;
      event.preventDefault();
      event.stopPropagation();
      applyPanPreview(event.clientX, event.clientY);
    };

    const handleMouseup = (event: MouseEvent) => {
      if (!panGestureRef.current?.active) return;
      event.preventDefault();
      event.stopPropagation();
      finishPan(event.clientX, event.clientY);
    };

    const handleBlur = () => finishPan();
    const preventAuxClick = (event: MouseEvent) => {
      if (event.button !== 1 || !viewportRef.current?.contains(event.target as Node | null)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('mousedown', handleMousedown, true);
    window.addEventListener('mousemove', handleMousemove, true);
    window.addEventListener('mouseup', handleMouseup, true);
    window.addEventListener('auxclick', preventAuxClick, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      panGestureRef.current = null;
      panPreviewRef.current = { x: 0, y: 0 };
      worldRef.current?.style.setProperty('transform', 'none', 'important');
      window.removeEventListener('mousedown', handleMousedown, true);
      window.removeEventListener('mousemove', handleMousemove, true);
      window.removeEventListener('mouseup', handleMouseup, true);
      window.removeEventListener('auxclick', preventAuxClick, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    
    // Smooth zoom factor based on deltaY magnitude, clamped between 0.5 and 2.0 to prevent extreme steps
    const factor = Math.max(0.5, Math.min(2.0, Math.exp(-event.deltaY * 0.0015)));
    
    const current = zoomRef.current || view;

    const nextScale = Math.max(0.001, current.scale * factor);
    const worldX = (mouseX - current.x) / current.scale;
    const worldY = (mouseY - current.y) / current.scale;
    const nextView = {
      x: mouseX - worldX * nextScale,
      y: mouseY - worldY * nextScale,
      scale: nextScale
    };

    zoomRef.current = nextView;

    // Apply CSS-only zoom transform preview
    const s = nextView.scale / view.scale;
    const tx = nextView.x - view.x * s;
    const ty = nextView.y - view.y * s;

    if (worldRef.current) {
      worldRef.current.style.setProperty('transform', `translate3d(${tx}px, ${ty}px, 0) scale(${s})`, 'important');
    }

    if (viewportRef.current) {
      viewportRef.current.classList.add('is-zooming');
    }

    if (wheelTimeoutRef.current !== null) {
      window.clearTimeout(wheelTimeoutRef.current);
    }
    wheelTimeoutRef.current = window.setTimeout(() => {
      wheelTimeoutRef.current = null;
      flushZoom();
    }, 150);
  };

  const onCanvasMouseDown = (event: ReactMouseEvent) => {
    flushZoom();
    if (mouseShortcutMatches(event, mindChildShortcut)) return;
    setSelectedLinkId(null);
    if (event.button === 2) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const point = rememberPointer(event.clientX, event.clientY);

    if (drawMode) {
      clearSelection();
      setEditingNodeId(null);
      setActiveGroupId(null);
      setDrawRect({ startX: point.x, startY: point.y, endX: point.x, endY: point.y });
      return;
    }

    setEditingNodeId(null);
    setActiveGroupId(null);
    const mode: SelectionMode = event.shiftKey ? 'add' : ((event.ctrlKey || event.metaKey) ? 'subtract' : 'replace');
    if (mode === 'replace') clearSelection();
    setSelection({
      startX: point.x,
      startY: point.y,
      endX: point.x,
      endY: point.y,
      mode,
      initialNodeIds: mode === 'replace' ? [] : selectedNodeIds
    });
  };

  const beginMindChildDrag = (event: ReactMouseEvent, node: CanvasNode) => {
    flushZoom();
    event.preventDefault();
    event.stopPropagation();
    const parent = node.groupId ? nodesById.get(node.groupId) : undefined;
    const activeNode = isLockedContainerGroup(parent) && activeGroupId !== node.groupId ? parent || node : node;
    if (!isConnectableNode(activeNode)) return;
    if (!selectedNodeIds.includes(activeNode.id)) selectNode(activeNode.id);
    const current = rememberPointer(event.clientX, event.clientY);
    const start = horizontalConnectionPoint(activeNode, current);
    setMindDrag({ sourceId: activeNode.id, start, current });
  };

  const findConnectableNodeAtPoint = (point: Point, excludeId?: string) => {
    return project.nodes
      .filter((node) => node.id !== excludeId && isConnectableNode(node) && nodeContainsPoint(node, point))
      .sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0))[0];
  };


  const expandGroupMoveIds = (ids: string[]) => {
    const base = uniqueIds(ids);
    const groupIds = new Set(base.filter((id) => {
      const node = nodesById.get(id);
      return Boolean(node?.type === 'group' && node.isGroupContainer !== false);
    }));
    if (groupIds.size === 0) return base;
    const children = project.nodes
      .filter((item) => item.groupId && groupIds.has(item.groupId))
      .map((item) => item.id);
    return uniqueIds([...base, ...children]);
  };

  const beginUniformResize = (event: ReactMouseEvent, node: CanvasNode, handle: ResizeHandle) => {
    flushZoom();
    event.preventDefault();
    event.stopPropagation();
    const parent = node.groupId ? nodesById.get(node.groupId) : undefined;
    const target = isLockedContainerGroup(parent) && activeGroupId !== node.groupId ? parent || node : node;
    if (!selectedNodeIds.includes(target.id)) {
      selectNode(target.id);
    }
    const center = nodeCenter(target);
    const startPoint = rememberPointer(event.clientX, event.clientY);
    const startMetric = Math.max(1, resizeMetric(startPoint, center, handle));
    const childOrigins = target.type === 'group'
      ? project.nodes.filter((item) => item.groupId === target.id).map((item) => ({ ...item }))
      : [];
    interactionHistoryRecordedRef.current = false;
    setResize({ nodeId: target.id, handle, startMetric, center, origin: { ...target }, childOrigins });
  };

  const resolveInteractiveNode = (node: CanvasNode) => {
    const parent = node.groupId ? nodesById.get(node.groupId) : undefined;
    if (isLockedContainerGroup(parent) && activeGroupId !== node.groupId) {
      return parent || node;
    }
    return node;
  };

  const onNodeMouseDown = (event: ReactMouseEvent, node: CanvasNode) => {
    flushZoom();
    setSelectedLinkId(null);
    if (mouseShortcutMatches(event, mindChildShortcut)) {
      beginMindChildDrag(event, node);
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    event.stopPropagation();

    // PureRef's continuous selection is Shift + left-drag. On a locked group's
    // background this enters that group for this one marquee operation.
    if (event.shiftKey) {
      event.preventDefault();
      const parent = node.groupId ? nodesById.get(node.groupId) : undefined;
      const scopeGroupId = isLockedContainerGroup(parent)
        ? parent?.id
        : (node.type === 'group' && node.isGroupContainer !== false ? node.id : activeGroupId || undefined);
      const point = rememberPointer(event.clientX, event.clientY);
      setSelection({
        startX: point.x,
        startY: point.y,
        endX: point.x,
        endY: point.y,
        mode: 'add',
        initialNodeIds: selectedNodeIds,
        scopeGroupId
      });
      return;
    }

    const target = resolveInteractiveNode(node);
    if (target.id !== node.id) {
      setEditingNodeId(null);
    }
    const alreadySelected = selectedNodeIds.includes(target.id);
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const baseActiveIds = additive
      ? (alreadySelected ? selectedNodeIds.filter((id) => id !== target.id) : [...selectedNodeIds, target.id])
      : (alreadySelected && selectedNodeIds.length > 1 ? selectedNodeIds : [target.id]);
    const activeIds = expandGroupMoveIds(baseActiveIds);

    selectNode(target.id, additive);
    if (target.type !== 'group') {
      bringNodesToFront(baseActiveIds);
    }

    const origins = Object.fromEntries(
      project.nodes
        .filter((item) => activeIds.includes(item.id))
        .map((item) => [item.id, { x: item.x, y: item.y }])
    );
    interactionHistoryRecordedRef.current = false;
    setDrag({ ids: activeIds, startX: event.clientX, startY: event.clientY, origins, originX: target.x, originY: target.y });
  };

  const onMouseMove = (event: ReactMouseEvent) => {
    if (drag?.pan) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      panPreviewRef.current = { x: dx, y: dy };
      // A pan is a single compositor translation. React receives the final
      // camera position on mouse-up instead of relaying every pointer event
      // through every image node.
      worldRef.current?.style.setProperty('transform', `translate3d(${dx}px, ${dy}px, 0)`, 'important');
      return;
    }
    const pointer = rememberPointer(event.clientX, event.clientY);
    if (mindDrag) {
      setMindDrag((current) => {
        if (!current) return null;
        const sourceNode = nodesById.get(current.sourceId);
        return { ...current, start: horizontalConnectionPoint(sourceNode, pointer), current: pointer };
      });
      return;
    }
    if (selection) {
      const point = pointer;
      setSelection((current) => current ? { ...current, endX: point.x, endY: point.y } : null);
      return;
    }
    if (drawRect) {
      const point = pointer;
      setDrawRect((current) => current ? { ...current, endX: point.x, endY: point.y } : null);
      return;
    }
    if (resize) {
      const current = pointer;
      const currentMetric = Math.max(1, resizeMetric(current, resize.center, resize.handle));
      const scale = Math.max(0.08, Math.min(20, currentMetric / resize.startMetric));
      const scaledFreeTextPatch = (origin: CanvasNode, center: Point) => {
        if (['note', 'mindmap'].includes(origin.type)) {
          // 自由文本的缩放逻辑对标 PureRef：拖动外框时缩放字号，外框继续贴合文字边缘，避免出现一个很大的空白文本框。
          const fontSize = Math.max(4, Math.round((origin.fontSize || 22) * scale));
          const size = freeTextNodeSize(origin.text || origin.title || '文本', { ...origin, fontSize });
          return {
            x: Math.round(center.x - size.width / 2),
            y: Math.round(center.y - size.height / 2),
            width: size.width,
            height: size.height,
            fontSize
          };
        }
        const nextWidth = Math.max(24, Math.round(origin.width * scale));
        const nextHeight = Math.max(24, Math.round(origin.height * scale));
        return {
          x: Math.round(center.x - nextWidth / 2),
          y: Math.round(center.y - nextHeight / 2),
          width: nextWidth,
          height: nextHeight
        };
      };
      const targetCenter = {
        x: resize.center.x + (nodeCenter(resize.origin).x - resize.center.x) * scale,
        y: resize.center.y + (nodeCenter(resize.origin).y - resize.center.y) * scale
      };
      const updates = [
        {
          id: resize.nodeId,
          patch: scaledFreeTextPatch(resize.origin, targetCenter)
        },
        ...resize.childOrigins.map((child) => {
          const childCenter = nodeCenter(child);
          const scaledChildCenter = {
            x: resize.center.x + (childCenter.x - resize.center.x) * scale,
            y: resize.center.y + (childCenter.y - resize.center.y) * scale
          };
          return {
            id: child.id,
            patch: scaledFreeTextPatch(child, scaledChildCenter)
          };
        })
      ];
      recordInteractionHistory();
      scheduleNodeUpdates(updates);
      return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.ids && drag.origins) {
      recordInteractionHistory();
      scheduleNodeUpdates(drag.ids.map((id) => ({
        id,
        patch: {
          x: (drag.origins?.[id]?.x ?? 0) + dx / view.scale,
          y: (drag.origins?.[id]?.y ?? 0) + dy / view.scale
        }
      })));
    }
  };

  const onMouseUp = (event?: ReactMouseEvent) => {
    flushZoom();
    flushDeferredNodeUpdates();
    // Window-capture listeners own the complete pan lifecycle. Keeping pan
    // finalization out of React mouseleave/mouseup prevents double commits.
    if (mindDrag) {
      const end = event ? rememberPointer(event.clientX, event.clientY) : mindDrag.current;
      const distance = Math.hypot(end.x - mindDrag.start.x, end.y - mindDrag.start.y);
      if (distance > 36) {
        const targetNode = findConnectableNodeAtPoint(end, mindDrag.sourceId);
        if (targetNode) {
          const linkId = createMindLink(mindDrag.sourceId, targetNode.id);
          if (linkId) {
            setSelectedLinkId(linkId);
            clearSelection();
          }
        } else {
          const childId = createMindChild(mindDrag.sourceId, end.x, end.y);
          if (childId) {
            window.setTimeout(() => window.dispatchEvent(new CustomEvent('refmind3d-edit-node', { detail: { id: childId } })), 0);
          }
        }
      }
      setMindDrag(null);
    }
    if (selection) {
      const end = event ? rememberPointer(event.clientX, event.clientY) : { x: selection.endX, y: selection.endY };
      const rect = normalizeRect(selection.startX, selection.startY, end.x, end.y);
      if (rect.width > 4 && rect.height > 4) {
        const screenRect = toScreenRect(rect);
        const ids = project.nodes
          .flatMap((node) => {
            if (selection.scopeGroupId) {
              return node.type !== 'group' && node.groupId === selection.scopeGroupId && rectIntersects(screenRect, renderedNodeRect(node))
                ? [node.id]
                : [];
            }
            const parent = node.groupId ? nodesById.get(node.groupId) : undefined;
            // A locked group is a single selectable object. Its children are only
            // considered when the user explicitly starts a marquee inside the group.
            if (isLockedContainerGroup(parent) && activeGroupId !== node.groupId) return [];
            return rectIntersects(screenRect, renderedNodeRect(node)) ? [node.id] : [];
          });
        const matchedIds = uniqueIds(ids);
        const selectedIds = selection.mode === 'add'
          ? uniqueIds([...selection.initialNodeIds, ...matchedIds])
          : selection.mode === 'subtract'
            ? selection.initialNodeIds.filter((id) => !matchedIds.includes(id))
            : matchedIds;
        selectNodes(selectedIds);
      }
      setSelection(null);
    }
    if (drawRect) {
      const rect = normalizeRect(drawRect.startX, drawRect.startY, drawRect.endX, drawRect.endY);
      if (rect.width > 12 && rect.height > 12) {
        createDrawBox(rect.x, rect.y, rect.width, rect.height);
      }
      setDrawRect(null);
    }
    if (drag?.ids) {
      completeGroupDrop(drag.ids);
    }
    if (drag?.ids || resize) {
      normalizeGroups();
    }
    setResize(null);
    setDrag(null);
    interactionHistoryRecordedRef.current = false;
  };

  const selectionRect = selection ? normalizeRect(selection.startX, selection.startY, selection.endX, selection.endY) : null;
  const activeDrawRect = drawRect ? normalizeRect(drawRect.startX, drawRect.startY, drawRect.endX, drawRect.endY) : null;
  const lowZoom = view.scale < 0.35;
  const selectedTextNode = selectedNodeIds.length === 1
    ? project.nodes.find((node) => selectedNodeIds[0] === node.id && isTextNode(node))
    : undefined;

  const updateSelectedTextStyle = (patch: Partial<CanvasNode>) => {
    if (!selectedTextNode) return;
    const nextNode = { ...selectedTextNode, ...patch };
    if (['note', 'mindmap'].includes(selectedTextNode.type)) {
      updateNode(selectedTextNode.id, { ...patch, ...freeTextNodeSize(nextNode.text || '', nextNode) });
    } else {
      updateNode(selectedTextNode.id, patch);
    }
  };

  const renderTextToolbar = () => {
    if (!selectedTextNode) return null;
    const rect = screenNodeRect(selectedTextNode);
    const top = Math.max(12, rect.y - 48);
    const left = Math.max(12, Math.min(viewportSize.width - 560, rect.x));
    const fontSize = selectedTextNode.fontSize || 22;
    const fontFamily = selectedTextNode.fontFamily || FREE_TEXT_FONT_FAMILY;
    return (
      <div
        className="text-floating-toolbar"
        style={{ left, top }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <label title="文字颜色">
          <span>A</span>
          <input type="color" value={selectedTextNode.textColor || '#ffffff'} onChange={(event) => updateSelectedTextStyle({ textColor: event.currentTarget.value })} />
        </label>
        <label title="背景颜色">
          <span>底</span>
          <input type="color" value={selectedTextNode.fillColor?.startsWith('#') ? selectedTextNode.fillColor : '#2c2c2c'} onChange={(event) => updateSelectedTextStyle({ fillColor: event.currentTarget.value })} />
        </label>
        <label title="边框颜色">
          <span>框</span>
          <input type="color" value={selectedTextNode.strokeColor?.startsWith('#') ? selectedTextNode.strokeColor : '#666666'} onChange={(event) => updateSelectedTextStyle({ strokeColor: event.currentTarget.value })} />
        </label>
        <button className={selectedTextNode.fontWeight === 'bold' ? 'active' : ''} onClick={() => updateSelectedTextStyle({ fontWeight: selectedTextNode.fontWeight === 'bold' ? 'normal' : 'bold' })}>B</button>
        <button className={selectedTextNode.fontStyle === 'italic' ? 'active' : ''} onClick={() => updateSelectedTextStyle({ fontStyle: selectedTextNode.fontStyle === 'italic' ? 'normal' : 'italic' })}>I</button>
        <button className={selectedTextNode.textDecoration === 'underline' ? 'active' : ''} onClick={() => updateSelectedTextStyle({ textDecoration: selectedTextNode.textDecoration === 'underline' ? 'none' : 'underline' })}>U</button>
        <select value={fontSize} onChange={(event) => updateSelectedTextStyle({ fontSize: Number(event.currentTarget.value) || fontSize })}>
          {[12, 14, 16, 18, 22, 28, 36, 48, 64, 96, 128].map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
        <select value={fontFamily} onChange={(event) => updateSelectedTextStyle({ fontFamily: event.currentTarget.value })}>
          <option value="SimHei, Microsoft YaHei, Heiti SC, Segoe UI, sans-serif">黑体</option>
          <option value="Microsoft YaHei, SimHei, Segoe UI, sans-serif">微软雅黑</option>
          <option value="KaiTi, STKaiti, serif">楷体</option>
          <option value="Arial, Helvetica, sans-serif">Arial</option>
          <option value="Open Sans, Segoe UI, sans-serif">Open Sans</option>
        </select>
      </div>
    );
  };

  const updateSpreadsheetNode = (node: CanvasNode, workbook: SpreadsheetWorkbook) => {
    updateNode(node.id, {
      spreadsheetData: workbook,
      text: workbookToText(workbook)
    });
  };

  const updateSpreadsheetCell = (node: CanvasNode, row: number, col: number, patch: Partial<SpreadsheetCell>) => {
    if (!node.spreadsheetData) return;
    const workbook = cloneWorkbook(node.spreadsheetData);
    const active = activeSpreadsheetSheet(workbook, activeSheetByNode[node.id] || 0);
    if (!active) return;
    const { sheet } = active;
    let targetRow = sheet.rows.find((item) => item.index === row);
    if (!targetRow) {
      targetRow = { index: row, cells: [] };
      sheet.rows.push(targetRow);
      sheet.rows.sort((a, b) => a.index - b.index);
    }
    let cell = targetRow.cells.find((item) => item.col === col);
    if (!cell) {
      cell = { row, col, value: '' };
      targetRow.cells.push(cell);
      targetRow.cells.sort((a, b) => a.col - b.col);
    }
    Object.assign(cell, patch, { row, col });
    updateSpreadsheetNode(node, workbook);
  };

  const patchSelectedSpreadsheetCellStyle = (node: CanvasNode, patch: Partial<SpreadsheetCellStyle>) => {
    const selected = selectedSheetCellByNode[node.id] || { row: 1, col: 1 };
    const active = activeSpreadsheetSheet(node.spreadsheetData, activeSheetByNode[node.id] || 0);
    const current = active ? spreadsheetCellMap(active.sheet).get(sheetCellKey(selected.row, selected.col)) : undefined;
    updateSpreadsheetCell(node, selected.row, selected.col, {
      style: { ...(current?.style || {}), ...patch }
    });
  };

  const addSpreadsheetRow = (node: CanvasNode) => {
    if (!node.spreadsheetData) return;
    const workbook = cloneWorkbook(node.spreadsheetData);
    const active = activeSpreadsheetSheet(workbook, activeSheetByNode[node.id] || 0);
    if (!active) return;
    const { maxCol, maxRow } = spreadsheetBounds(active.sheet);
    active.sheet.rows.push({
      index: maxRow + 1,
      cells: Array.from({ length: Math.min(maxCol, 12) }, (_, index) => ({ row: maxRow + 1, col: index + 1, value: '' }))
    });
    updateSpreadsheetNode(node, workbook);
  };

  const addSpreadsheetColumn = (node: CanvasNode) => {
    if (!node.spreadsheetData) return;
    const workbook = cloneWorkbook(node.spreadsheetData);
    const active = activeSpreadsheetSheet(workbook, activeSheetByNode[node.id] || 0);
    if (!active) return;
    const { maxRow, maxCol } = spreadsheetBounds(active.sheet);
    for (let row = 1; row <= maxRow; row += 1) {
      let targetRow = active.sheet.rows.find((item) => item.index === row);
      if (!targetRow) {
        targetRow = { index: row, cells: [] };
        active.sheet.rows.push(targetRow);
      }
      targetRow.cells.push({ row, col: maxCol + 1, value: '' });
    }
    active.sheet.columns = [...(active.sheet.columns || []), { index: maxCol + 1, width: 12 }];
    updateSpreadsheetNode(node, workbook);
  };

  const mergeSelectedSpreadsheetCells = (node: CanvasNode, direction: 'right' | 'down') => {
    if (!node.spreadsheetData) return;
    const selected = selectedSheetCellByNode[node.id] || { row: 1, col: 1 };
    const workbook = cloneWorkbook(node.spreadsheetData);
    const active = activeSpreadsheetSheet(workbook, activeSheetByNode[node.id] || 0);
    if (!active) return;
    active.sheet.merges = (active.sheet.merges || []).filter((merge) => !mergeForCell([merge], selected.row, selected.col));
    active.sheet.merges.push({
      startRow: selected.row,
      startCol: selected.col,
      endRow: direction === 'down' ? selected.row + 1 : selected.row,
      endCol: direction === 'right' ? selected.col + 1 : selected.col
    });
    updateSpreadsheetNode(node, workbook);
  };

  const unmergeSelectedSpreadsheetCell = (node: CanvasNode) => {
    if (!node.spreadsheetData) return;
    const selected = selectedSheetCellByNode[node.id] || { row: 1, col: 1 };
    const workbook = cloneWorkbook(node.spreadsheetData);
    const active = activeSpreadsheetSheet(workbook, activeSheetByNode[node.id] || 0);
    if (!active) return;
    active.sheet.merges = (active.sheet.merges || []).filter((merge) => !mergeForCell([merge], selected.row, selected.col));
    updateSpreadsheetNode(node, workbook);
  };

  const renderSpreadsheetEditor = (node: CanvasNode) => {
    const active = activeSpreadsheetSheet(node.spreadsheetData, activeSheetByNode[node.id] || 0);
    if (!node.spreadsheetData || !active) return null;
    const { sheet, index } = active;
    const selected = selectedSheetCellByNode[node.id] || { row: 1, col: 1 };
    const selectedCell = spreadsheetCellMap(sheet).get(sheetCellKey(selected.row, selected.col));
    const { maxRow, maxCol } = spreadsheetBounds(sheet);
    const cellMap = spreadsheetCellMap(sheet);
    return (
      <div
        className="spreadsheet-editor"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setEditingNodeId(null);
          }
          event.stopPropagation();
        }}
      >
        <div className="spreadsheet-editor-toolbar">
          <button onClick={() => addSpreadsheetRow(node)}>加行</button>
          <button onClick={() => addSpreadsheetColumn(node)}>加列</button>
          <button onClick={() => mergeSelectedSpreadsheetCells(node, 'right')}>向右合并</button>
          <button onClick={() => mergeSelectedSpreadsheetCells(node, 'down')}>向下合并</button>
          <button onClick={() => unmergeSelectedSpreadsheetCell(node)}>取消合并</button>
          <button onClick={() => patchSelectedSpreadsheetCellStyle(node, { bold: !selectedCell?.style?.bold })}>B</button>
          <button onClick={() => patchSelectedSpreadsheetCellStyle(node, { italic: !selectedCell?.style?.italic })}>I</button>
          <button onClick={() => patchSelectedSpreadsheetCellStyle(node, { underline: !selectedCell?.style?.underline })}>U</button>
          <input type="number" min={8} max={72} value={selectedCell?.style?.fontSize || 11} onChange={(event) => patchSelectedSpreadsheetCellStyle(node, { fontSize: Number(event.currentTarget.value) || 11 })} />
          <input type="color" value={colorInputValue(selectedCell?.style?.color, '#111111')} onChange={(event) => patchSelectedSpreadsheetCellStyle(node, { color: event.currentTarget.value })} />
          <input type="color" value={colorInputValue(selectedCell?.style?.backgroundColor, '#ffffff')} onChange={(event) => patchSelectedSpreadsheetCellStyle(node, { backgroundColor: event.currentTarget.value })} />
          <select value={selectedCell?.style?.align || 'left'} onChange={(event) => patchSelectedSpreadsheetCellStyle(node, { align: event.currentTarget.value as SpreadsheetCellStyle['align'] })}>
            <option value="left">左</option>
            <option value="center">中</option>
            <option value="right">右</option>
          </select>
        </div>
        {node.spreadsheetData.sheets.length > 1 && (
          <div className="spreadsheet-tabs">
            {node.spreadsheetData.sheets.map((item, sheetIndex) => (
              <button
                key={item.id || item.name || sheetIndex}
                className={sheetIndex === index ? 'active' : ''}
                onClick={() => setActiveSheetByNode((current) => ({ ...current, [node.id]: sheetIndex }))}
              >
                {item.name || `Sheet${sheetIndex + 1}`}
              </button>
            ))}
          </div>
        )}
        <div className="spreadsheet-scroll">
          <table className="spreadsheet-grid spreadsheet-grid-editor">
            <tbody>
              {Array.from({ length: maxRow }, (_, rowOffset) => {
                const rowNumber = rowOffset + 1;
                return (
                  <tr key={rowNumber}>
                    {Array.from({ length: maxCol }, (_, colOffset) => {
                      const colNumber = colOffset + 1;
                      if (isCoveredMergedCell(sheet.merges, rowNumber, colNumber)) return null;
                      const merge = mergeForCell(sheet.merges, rowNumber, colNumber);
                      const cell = cellMap.get(sheetCellKey(rowNumber, colNumber));
                      const isSelected = selected.row === rowNumber && selected.col === colNumber;
                      return (
                        <td
                          key={colNumber}
                          colSpan={merge ? merge.endCol - merge.startCol + 1 : 1}
                          rowSpan={merge ? merge.endRow - merge.startRow + 1 : 1}
                          className={isSelected ? 'selected-cell' : undefined}
                          style={{ width: columnWidth(sheet, colNumber), ...spreadsheetCellCss(cell?.style) }}
                        >
                          <textarea
                            value={cell?.value || ''}
                            onFocus={() => setSelectedSheetCellByNode((current) => ({ ...current, [node.id]: { row: rowNumber, col: colNumber } }))}
                            onChange={(event) => updateSpreadsheetCell(node, rowNumber, colNumber, { value: event.currentTarget.value })}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderTableEditor = (node: CanvasNode) => {
    if (node.spreadsheetData) {
      return renderSpreadsheetEditor(node);
    }
    const rows = tableRowsForEdit(node.text);
    const updateCell = (rowIndex: number, cellIndex: number, value: string) => {
      const nextRows = rows.map((row) => [...row]);
      nextRows[rowIndex][cellIndex] = value;
      updateNode(node.id, { text: serializeTableRows(nextRows) });
    };
    const addRow = () => updateNode(node.id, { text: serializeTableRows([...rows, new Array(Math.max(1, rows[0]?.length || 1)).fill('')]) });
    const addCol = () => updateNode(node.id, { text: serializeTableRows(rows.map((row) => [...row, ''])) });
    return (
      <div
        className="table-editor-wrap"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setEditingNodeId(null);
          }
        }}
      >
        <div className="table-editor-toolbar">
          <button onClick={addRow}>加行</button>
          <button onClick={addCol}>加列</button>
          <label>文字<input type="color" value={colorInputValue(node.textColor, '#111111')} onChange={(event) => updateNode(node.id, { textColor: event.currentTarget.value })} /></label>
          <label>背景<input type="color" value={colorInputValue(node.fillColor, '#ffffff')} onChange={(event) => updateNode(node.id, { fillColor: event.currentTarget.value })} /></label>
          <label>边框<input type="color" value={colorInputValue(node.strokeColor, '#7a7a7a')} onChange={(event) => updateNode(node.id, { strokeColor: event.currentTarget.value })} /></label>
          <label>字号<input type="number" min={8} max={96} value={node.fontSize || 15} onChange={(event) => updateNode(node.id, { fontSize: Number(event.currentTarget.value) || 15 })} /></label>
          <button onClick={() => updateNode(node.id, { fontWeight: node.fontWeight === 'bold' ? 'normal' : 'bold' })}>{node.fontWeight === 'bold' ? '取消粗体' : '粗体'}</button>
          <button onClick={() => updateNode(node.id, { fontStyle: node.fontStyle === 'italic' ? 'normal' : 'italic' })}>{node.fontStyle === 'italic' ? '取消斜体' : '斜体'}</button>
          <span>表格编辑 / 美化</span>
        </div>
        <div className="table-editor-scroll">
          <table className="table-node-editor">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => {
                    const imagePath = imageTagPath(cell);
                    return (
                      <td key={`${rowIndex}-${cellIndex}`} className={imagePath ? 'embedded-image-cell' : undefined}>
                        {imagePath ? (
                          <div className="table-image-edit-cell">
                            <img src={displayAssetPath(imagePath)} draggable={false} alt="表格内图片" />
                            <small>内嵌图片</small>
                          </div>
                        ) : (
                          <textarea
                            value={cell}
                            onChange={(event) => updateCell(rowIndex, cellIndex, event.currentTarget.value)}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderRichDocumentEditor = (node: CanvasNode) => {
    const initialHtml = sanitizeRichHtml(node.richTextHtml || `<p>${(node.text || '').replace(/\n/g, '<br>')}</p>`);
    const editorStyle = {
      fontFamily: node.fontFamily || 'Segoe UI',
      fontSize: `${Math.max(1, node.fontSize || 16)}px`,
      fontWeight: node.fontWeight || 'normal',
      fontStyle: node.fontStyle || 'normal',
      textDecoration: node.textDecoration || 'none'
    };
    return (
      <div
        ref={editingRef as MutableRefObject<HTMLDivElement | null>}
        className="rich-document-editor"
        style={editorStyle}
        contentEditable
        suppressContentEditableWarning
        dangerouslySetInnerHTML={{ __html: initialHtml }}
        onMouseDown={(event) => event.stopPropagation()}
        onInput={(event) => {
          const html = event.currentTarget.innerHTML;
          recordTextEditHistory();
          updateNode(node.id, {
            richTextHtml: html,
            text: richHtmlToText(html)
          }, false, false);
        }}
        onBlur={(event) => {
          const html = sanitizeRichHtml(event.currentTarget.innerHTML);
          updateNode(node.id, {
            richTextHtml: html,
            text: richHtmlToText(html)
          }, false, true);
          textEditHistoryRecordedRef.current = false;
          setEditingNodeId(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setEditingNodeId(null);
          }
          event.stopPropagation();
        }}
      />
    );
  };

  return (
    <div
      ref={viewportRef}
      className={`canvas-viewport ${drawMode ? 'draw-mode' : ''} ${activeGroupId ? 'group-edit-mode' : ''} ${lowZoom ? 'low-zoom' : ''} ${(drag || resize) ? 'is-interacting' : ''} ${drag?.pan ? 'is-panning' : ''}`}
      onWheel={onWheel}
      onMouseDown={onCanvasMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={(event) => {
        if (!panGestureRef.current?.active) onMouseUp(event);
      }}
      onContextMenu={(event) => {
        rememberPointer(event.clientX, event.clientY);
        if (event.altKey) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div
        ref={worldRef}
        className="canvas-world screen-space-renderer"
      >
        {showGrid && !lowZoom && <div className="canvas-grid" />}
        <svg className="mindmap-layer" width={viewportSize.width} height={viewportSize.height} viewBox={`0 0 ${viewportSize.width} ${viewportSize.height}`}>
          {project.links.map((link) => {
            const fromNode = nodesById.get(link.fromNodeId);
            const toNode = nodesById.get(link.toNodeId);
            const { from, to } = horizontalConnectionPoints(fromNode, toNode);
            const fromScreen = toScreenPoint(from);
            const toScreen = toScreenPoint(to);
            const path = connectionPath(fromScreen, toScreen, view.scale);
            const selected = selectedLinkId === link.id;
            return (
              <g
                key={link.id}
                className={`mindmap-link-group ${selected ? 'selected-link' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setSelectedLinkId(link.id);
                  clearSelection();
                }}
              >
                <title>{selected ? '已选中牵引线：按 Delete 删除' : '点击选中牵引线'}</title>
                <path className="mindmap-link-hit" d={path} stroke="transparent" strokeWidth={Math.max(14, (link.width || 2) + 10)} fill="none" strokeLinecap="round" />
                <path className="mindmap-link-visible" d={path} stroke={selected ? '#7fb0ff' : link.color} strokeWidth={selected ? (link.width || 2) + 2 : link.width} fill="none" strokeLinecap="round" />
              </g>
            );
          })}
          {mindDrag && (() => {
            const startScreen = toScreenPoint(mindDrag.start);
            const currentScreen = toScreenPoint(mindDrag.current);
            return (
              <path
                d={connectionPath(startScreen, currentScreen, view.scale)}
                stroke="#b7b7b7"
                strokeWidth={2}
                strokeDasharray="8 6"
                fill="none"
                strokeLinecap="round"
              />
            );
          })()}
        </svg>
        {renderTextToolbar()}
        {renderedNodes
          .slice()
          .sort((a, b) => (visualZIndex(a) || 0) - (visualZIndex(b) || 0))
          .map((node) => {
            const asset = node.assetId ? assetsById.get(node.assetId) : undefined;
            const selected = selectedNodeIds.includes(node.id);
            const editing = editingNodeId === node.id;
            const parentGroup = node.groupId ? nodesById.get(node.groupId) : undefined;
            const lockedByGroup = Boolean(isLockedContainerGroup(parentGroup) && activeGroupId !== node.groupId);
            const groupEditing = node.type === 'group' && node.isGroupContainer !== false && activeGroupId === node.id;
            const screenRect = screenNodeRect(node);
            const textStyle = isTextNode(node) ? {
              fontFamily: node.fontFamily || (['note','mindmap'].includes(node.type) ? FREE_TEXT_FONT_FAMILY : 'Segoe UI'),
              fontSize: `${Math.max(1, (node.fontSize || 16) * view.scale)}px`,
              fontWeight: node.fontWeight || 'normal',
              fontStyle: node.fontStyle || 'normal',
              textDecoration: node.textDecoration || 'none'
            } : undefined;
            return (
              <div
                key={node.id}
                data-node-id={node.id}
                className={`canvas-node ${node.type}-canvas-node ${selected ? 'selected' : ''} ${editing ? 'editing' : ''} ${lockedByGroup ? 'group-child-locked' : ''} ${groupEditing ? 'group-edit-active' : ''}`}
                style={{
                  left: screenRect.x,
                  top: screenRect.y,
                  width: screenRect.width,
                  height: screenRect.height,
                  transform: `rotate(${node.rotation}deg)`,
                  zIndex: visualZIndex(node),
                  background: node.type === 'group' || isTextNode(node) ? node.fillColor : undefined,
                  borderColor: node.type === 'group' || isTextNode(node) ? node.strokeColor : undefined,
                  color: node.textColor,
                  ...textStyle
                }}
                onMouseDown={(event) => onNodeMouseDown(event, node)}
                onDoubleClick={(event) => {
                  if (node.type === 'group' && node.isGroupContainer !== false) {
                    event.stopPropagation();
                    setActiveGroupId(node.id);
                    selectNode(node.id);
                    return;
                  }
                  if (isLockedContainerGroup(parentGroup) && activeGroupId !== node.groupId) {
                    event.stopPropagation();
                    setActiveGroupId(node.groupId!);
                    selectNode(node.id);
                    return;
                  }
                  if (isTextNode(node)) {
                    event.stopPropagation();
                    setEditingNodeId(node.id);
                  }
                }}
              >
                {node.type === 'image' && asset && (
                  <CanvasImage
                    asset={asset}
                    lowZoom={lowZoom}
                    alt={node.title}
                    selected={selected}
                    title={node.title}
                  />
                )}
                {node.type === 'video' && asset && (
                  <div
                    className="video-node"
                    title="视频节点：点击播放/暂停，支持声音；边缘可拖动窗口"
                  >
                    <div className="video-move-edge edge-top" onMouseDown={(event) => onNodeMouseDown(event, node)} title="拖动边缘移动视频窗口" />
                    <div className="video-move-edge edge-bottom" onMouseDown={(event) => onNodeMouseDown(event, node)} title="拖动边缘移动视频窗口" />
                    <div className="video-move-edge edge-left" onMouseDown={(event) => onNodeMouseDown(event, node)} title="拖动边缘移动视频窗口" />
                    <div className="video-move-edge edge-right" onMouseDown={(event) => onNodeMouseDown(event, node)} title="拖动边缘移动视频窗口" />
                    <video
                      className="video-node-player"
                      src={assetUrl(asset)}
                      controls
                      playsInline
                      preload="metadata"
                      onMouseDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onError={(event) => {
                        const video = event.currentTarget;
                        video.dataset.error = '1';
                      }}
                    />
                    <div className="video-format-hint">视频 · MP4/WebM 可直接播放，AVI 等取决于系统/WebView 编码支持</div>
                    <div className="node-title">{node.title}</div>
                  </div>
                )}
                {node.type === 'model' && asset && (
                  <div
                    className="model-node"
                    onMouseDown={(event) => {
                      // 模型节点内部直接交给 OrbitControls 处理，避免旋转模型时拖动画布节点。
                      event.stopPropagation();
                    }}
                    onDoubleClick={(event) => {
                      if (node.groupId && activeGroupId !== node.groupId) return;
                      event.stopPropagation();
                      onOpenModel?.(asset as ImportedModel);
                    }}
                    title="可直接 360° 预览，双击放大预览"
                  >
                    <div
                      className="model-drag-strip"
                      title="拖动这里移动 3D 窗口"
                      onMouseDown={(event) => onNodeMouseDown(event, node)}
                    >移动窗口</div>
                    <div className="model-move-edge edge-top" onMouseDown={(event) => onNodeMouseDown(event, node)} title="拖动边缘移动 3D 窗口" />
                    <div className="model-move-edge edge-bottom" onMouseDown={(event) => onNodeMouseDown(event, node)} title="拖动边缘移动 3D 窗口" />
                    <div className="model-move-edge edge-left" onMouseDown={(event) => onNodeMouseDown(event, node)} title="拖动边缘移动 3D 窗口" />
                    <div className="model-move-edge edge-right" onMouseDown={(event) => onNodeMouseDown(event, node)} title="拖动边缘移动 3D 窗口" />
                    <ModelViewer
                      modelPath={assetModelSource(asset)}
                      modelFormat={asset.format}
                      compact
                    />
                    <div className="node-low-zoom-placeholder">
                      3D 模型<br />
                      {node.title}<br />
                      <small>{Math.round(((asset as ImportedModel).stats?.fileSize || asset.fileSize || 0) / 1024 / 1024)} MB · 双击独立预览</small>
                    </div>
                    <div className="model-badge">3D · 双击独立预览</div>
                  </div>
                )}
                {isTextNode(node) && !editing && (
                  <div className="note-node-display">
                    {documentLabel(node) && <span className="document-node-badge">{documentLabel(node)}</span>}
                    {renderTextPreview(node, activeSheetByNode[node.id] || 0, (sheetIndex) => setActiveSheetByNode((current) => ({ ...current, [node.id]: sheetIndex })))}
                  </div>
                )}
                {isTextNode(node) && editing && (
                  node.type === 'table' ? renderTableEditor(node) : (
                  node.type === 'document' && node.richTextHtml !== undefined ? renderRichDocumentEditor(node) : (
                    <textarea
                      ref={editingRef as MutableRefObject<HTMLTextAreaElement | null>}
                      className="note-node-text"
                      value={node.text || ''}
                      style={textStyle}
                      onMouseDown={(event) => event.stopPropagation()}
                      wrap="off"
                      onChange={(event) => {
                        recordTextEditHistory();
                        updateNode(node.id, freeTextPatch(node, event.currentTarget.value), false, false);
                      }}
                      onBlur={() => {
                        textEditHistoryRecordedRef.current = false;
                        setEditingNodeId(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setEditingNodeId(null);
                          return;
                        }
                        if (event.key === 'Enter' && !event.ctrlKey) {
                          event.preventDefault();
                          setEditingNodeId(null);
                          return;
                        }
                        if (event.key === 'Enter' && event.ctrlKey) {
                          event.preventDefault();
                          const textarea = event.currentTarget;
                          const start = textarea.selectionStart || 0;
                          const end = textarea.selectionEnd || 0;
                          const nextText = `${textarea.value.slice(0, start)}\n${textarea.value.slice(end)}`;
                          recordTextEditHistory();
                          updateNode(node.id, freeTextPatch(node, nextText), false, false);
                          window.setTimeout(() => {
                            textarea.selectionStart = start + 1;
                            textarea.selectionEnd = start + 1;
                          }, 0);
                        }
                      }}
                    />
                  ))
                )}
                {node.type === 'group' && (
                  <div className="group-node-label">{groupEditing ? `${node.title} · 组内编辑` : (node.isGroupContainer !== false && node.groupLocked !== false ? `${node.title} · 已锁定` : node.title)}</div>
                )}
                {!isTextNode(node) && node.type !== 'video' && <div className="node-title">{node.title}</div>}
                {isTextNode(node) && node.type !== 'note' && node.type !== 'mindmap' && <div className="node-title document-title">{node.title}</div>}
                {selected && !editing && (
                  <div className="resize-handles" aria-hidden="true">
                    {resizeHandles.map((handle) => (
                      <button
                        key={handle}
                        className={`uniform-resize-edge handle-${handle}`}
                        title="等比缩放"
                        onMouseDown={(event) => beginUniformResize(event, node, handle)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        {selectionRect && (() => {
          const screenSelection = toScreenRect(selectionRect);
          return (
            <div
              className="selection-rect"
              style={{ left: screenSelection.x, top: screenSelection.y, width: screenSelection.width, height: screenSelection.height }}
            />
          );
        })()}
        {activeDrawRect && (() => {
          const screenDrawRect = toScreenRect(activeDrawRect);
          return (
            <div
              className="draw-rect"
              style={{ left: screenDrawRect.x, top: screenDrawRect.y, width: screenDrawRect.width, height: screenDrawRect.height }}
            />
          );
        })()}
      </div>
      {activeGroupId && <div className="group-edit-indicator">组内编辑：双击组后已解锁组内物体，点击空白处退出</div>}
    </div>
  );
}
