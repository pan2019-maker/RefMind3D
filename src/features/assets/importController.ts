import { appDataDir, join } from '@tauri-apps/api/path';
import { importDocumentAsset, importImageAsset, importModelAsset, importRemoteImageAsset, importClipboardImageDataUrl, importVideoAsset, registerRuntimeAsset, registerRuntimeDocumentAsset, registerRuntimeModelAsset, registerRuntimeVideoAsset } from './assetImport';
import { useProjectStore } from '../../stores/projectStore';
import type { AssetRecord, CanvasNode, ImportedDocument, ImportedImage, ImportedModel, ImportedVideo } from '../../shared/types';

export const imageExtensions = ['png','jpg','jpeg','webp','bmp','gif','ico','svg','tif','tiff','tga','dds','hdr','exr','avif','qoi','psd','psb'];
export const modelExtensions = ['obj','fbx','glb','gltf'];
export const documentExtensions = ['txt','md','rtf','doc','docx','pdf','csv','tsv','xls','xlsx'];
export const videoExtensions = ['mp4','avi','mov','mkv','webm','m4v','wmv','flv','ogg','ogv','3gp'];
export type ImportLayoutDirection = 'horizontal' | 'vertical';
export type ImageImportCandidate =
  | { kind: 'path'; path: string }
  | { kind: 'remote-url'; url: string; referer?: string }
  | { kind: 'data-url'; dataUrl: string; nameHint?: string };
export type FileDataImportCandidate = { dataUrl: string; name: string; mime?: string };

let cachedDefaultProjectRoot: string | null = null;

export function extensionOf(path: string) {
  const cleanPath = path.split('?')[0];
  return cleanPath.split('.').pop()?.toLowerCase() || '';
}

export async function getDefaultProjectRoot() {
  if (cachedDefaultProjectRoot) return cachedDefaultProjectRoot;
  const base = await appDataDir();
  cachedDefaultProjectRoot = await join(base, 'RefMind3D_Project');
  return cachedDefaultProjectRoot;
}

function nextZIndex() {
  return useProjectStore.getState().project.nodes.reduce((max, node) => Math.max(max, node.zIndex || 0), 0) + 1;
}

function documentNodeType(ext: string): 'document' | 'table' | 'pdf' {
  if (ext === 'pdf') return 'pdf';
  if (['csv', 'tsv', 'xls', 'xlsx'].includes(ext)) return 'table';
  return 'document';
}

function naturalComparePath(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function layoutAdvanceSize(kind: 'image' | 'model' | 'video' | 'document' | 'table' | 'pdf', width: number, height: number) {
  // Large original images can be thousands of pixels wide. For multi-file drag-in layout,
  // use each node's actual size but keep a practical minimum spacing.
  return {
    width: Math.max(80, width),
    height: Math.max(80, height)
  };
}

function fitInitialNodeSize(width: number, height: number, maxSide = 1200) {
  const safeWidth = Math.max(24, width || 24);
  const safeHeight = Math.max(24, height || 24);
  const side = Math.max(safeWidth, safeHeight);
  if (side <= maxSide) return { width: safeWidth, height: safeHeight };
  const scale = maxSide / side;
  return {
    width: Math.max(24, Math.round(safeWidth * scale)),
    height: Math.max(24, Math.round(safeHeight * scale))
  };
}

function addImageAssetNode(asset: ImportedImage, x: number, y: number) {
  const current = useProjectStore.getState();
  const nodeId = crypto.randomUUID();
  const { width, height } = fitInitialNodeSize(asset.width, asset.height);
  current.addAssetsAndNodes([asset], [{
    id: nodeId,
    type: 'image',
    assetId: asset.id,
    title: asset.name,
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex: nextZIndex()
  }]);
  return { nodeId, width, height };
}

function imageNodeForAsset(asset: ImportedImage, x: number, y: number, zIndex: number) {
  const nodeId = crypto.randomUUID();
  const { width, height } = fitInitialNodeSize(asset.width, asset.height);
  const node: CanvasNode = {
    id: nodeId,
    type: 'image',
    assetId: asset.id,
    title: asset.name,
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex
  };
  return { node, width, height };
}

function createLayoutCursor(insertPoint?: { x: number; y: number }, layoutDirection: ImportLayoutDirection = 'horizontal') {
  const gap = 36;
  let cursorX = insertPoint?.x ?? undefined;
  let cursorY = insertPoint?.y ?? undefined;
  return (width: number, height: number) => {
    const current = useProjectStore.getState();
    const nodeCount = current.project.nodes.length;
    const x = Math.round(cursorX ?? (120 + nodeCount * 30));
    const y = Math.round(cursorY ?? (120 + nodeCount * 20));
    if (cursorX !== undefined && cursorY !== undefined) {
      const advance = layoutAdvanceSize('image', width, height);
      if (layoutDirection === 'vertical') {
        cursorY += advance.height + gap;
      } else {
        cursorX += advance.width + gap;
      }
    }
    return { x, y };
  };
}

export async function importPathsToProject(
  paths: string[],
  insertPoint?: { x: number; y: number },
  layoutDirection: ImportLayoutDirection = 'horizontal',
  projectRootOverride?: string
): Promise<{ imported: number; errors: string[]; nodeIds: string[] }> {
  const files = paths.filter(Boolean).slice().sort(naturalComparePath);
  if (files.length === 0) return { imported: 0, errors: [], nodeIds: [] };

  const state = useProjectStore.getState();
  const projectRoot = projectRootOverride?.trim() || state.project.rootPath || await getDefaultProjectRoot();
  let imported = 0;
  const errors: string[] = [];
  const nodeIds: string[] = [];
  const stagedAssets: AssetRecord[] = [];
  const stagedNodes: CanvasNode[] = [];
  const baseNodeCount = state.project.nodes.length;
  let z = state.project.nodes.reduce((max, node) => Math.max(max, node.zIndex || 0), 0);
  const gap = 36;
  let cursorX = insertPoint?.x ?? undefined;
  let cursorY = insertPoint?.y ?? undefined;

  const nextPosition = (width: number, height: number) => {
    const nodeCount = baseNodeCount + stagedNodes.length;
    const x = Math.round(cursorX ?? (120 + nodeCount * 30));
    const y = Math.round(cursorY ?? (120 + nodeCount * 20));
    if (cursorX !== undefined && cursorY !== undefined) {
      const advance = layoutAdvanceSize('image', width, height);
      if (layoutDirection === 'vertical') {
        cursorY += advance.height + gap;
      } else {
        cursorX += advance.width + gap;
      }
    }
    return { x, y };
  };

  for (const file of files) {
    const ext = extensionOf(file);
    try {
      if (imageExtensions.includes(ext)) {
        const asset = await importImageAsset(file, projectRoot);
        const { width, height } = fitInitialNodeSize(asset.width, asset.height);
        const pos = nextPosition(width, height);
        const { node } = imageNodeForAsset(asset, pos.x, pos.y, ++z);
        stagedAssets.push(asset);
        stagedNodes.push(node);
        const nodeId = node.id;
        nodeIds.push(nodeId);
        imported += 1;
      } else if (modelExtensions.includes(ext)) {
        const asset = await importModelAsset(file, projectRoot);
        const nodeId = crypto.randomUUID();
        const width = 420;
        const height = 300;
        const pos = nextPosition(width, height);
        stagedAssets.push(asset);
        stagedNodes.push({
          id: nodeId,
          type: 'model',
          assetId: asset.id,
          title: asset.name,
          x: pos.x,
          y: pos.y,
          width,
          height,
          rotation: 0,
          zIndex: ++z
        });
        nodeIds.push(nodeId);
        imported += 1;
      } else if (videoExtensions.includes(ext)) {
        const asset = await importVideoAsset(file, projectRoot);
        const nodeId = crypto.randomUUID();
        const width = 520;
        const height = 320;
        const pos = nextPosition(width, height);
        stagedAssets.push(asset);
        stagedNodes.push({
          id: nodeId,
          type: 'video',
          assetId: asset.id,
          title: asset.name,
          x: pos.x,
          y: pos.y,
          width,
          height,
          rotation: 0,
          zIndex: ++z
        });
        nodeIds.push(nodeId);
        imported += 1;
      } else if (documentExtensions.includes(ext)) {
        const asset = await importDocumentAsset(file, projectRoot) as ImportedDocument;
        const nodeType = documentNodeType(ext);
        const nodeId = crypto.randomUUID();
        const width = nodeType === 'table' ? 620 : 520;
        const height = nodeType === 'pdf' ? 700 : 380;
        const pos = nextPosition(width, height);
        stagedAssets.push(asset);
        stagedNodes.push({
          id: nodeId,
          type: nodeType,
          assetId: asset.id,
          title: asset.name,
          x: pos.x,
          y: pos.y,
          width,
          height,
          rotation: 0,
          zIndex: ++z,
          text: asset.extractedText || '双击编辑内容',
          richTextHtml: asset.contentHtml,
          spreadsheetData: asset.spreadsheetData,
          fillColor: nodeType === 'pdf' ? '#f5f5f2' : '#ffffff',
          strokeColor: '#7a7a7a',
          textColor: '#111111',
          fontFamily: 'Microsoft YaHei',
          fontSize: 15,
          fontWeight: 'normal',
          fontStyle: 'normal'
        });
        nodeIds.push(nodeId);
        imported += 1;
      } else {
        errors.push(`${file}\n当前格式暂不支持: .${ext || 'unknown'}`);
      }
    } catch (error) {
      errors.push(`${file}\n${String(error)}`);
    }
  }

  if (stagedAssets.length > 0 || stagedNodes.length > 0) {
    useProjectStore.getState().addAssetsAndNodes(stagedAssets, stagedNodes, nodeIds.length > 0 ? [nodeIds[nodeIds.length - 1]] : undefined);
  }

  return { imported, errors, nodeIds };
}

export async function importFileDataCandidatesToProject(
  candidates: FileDataImportCandidate[],
  insertPoint?: { x: number; y: number },
  layoutDirection: ImportLayoutDirection = 'horizontal'
): Promise<{ imported: number; errors: string[]; nodeIds: string[] }> {
  const unique = new Map<string, FileDataImportCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.name}:${candidate.dataUrl.slice(0, 96)}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const list = Array.from(unique.values());
  if (list.length === 0) return { imported: 0, errors: [], nodeIds: [] };

  const nextPosition = createLayoutCursor(insertPoint, layoutDirection);
  let imported = 0;
  const errors: string[] = [];
  const nodeIds: string[] = [];
  const state = useProjectStore.getState();
  const stagedAssets: AssetRecord[] = [];
  const stagedNodes: CanvasNode[] = [];
  let z = state.project.nodes.reduce((max, node) => Math.max(max, node.zIndex || 0), 0);

  for (const candidate of list) {
    const ext = extensionOf(candidate.name);
    try {
      if (imageExtensions.includes(ext)) {
        const asset = await registerRuntimeAsset(candidate.dataUrl, candidate.name);
        const { width, height } = fitInitialNodeSize(asset.width, asset.height);
        const pos = nextPosition(width, height);
        const { node } = imageNodeForAsset(asset, pos.x, pos.y, ++z);
        stagedAssets.push(asset);
        stagedNodes.push(node);
        nodeIds.push(node.id);
        imported += 1;
      } else if (videoExtensions.includes(ext)) {
        const asset = await registerRuntimeVideoAsset(candidate.dataUrl, candidate.name) as ImportedVideo;
        const nodeId = crypto.randomUUID();
        const width = 520;
        const height = 320;
        const pos = nextPosition(width, height);
        stagedAssets.push(asset);
        stagedNodes.push({
          id: nodeId,
          type: 'video',
          assetId: asset.id,
          title: asset.name,
          x: pos.x,
          y: pos.y,
          width,
          height,
          rotation: 0,
          zIndex: ++z
        });
        nodeIds.push(nodeId);
        imported += 1;
      } else if (modelExtensions.includes(ext)) {
        const asset = await registerRuntimeModelAsset(candidate.dataUrl, candidate.name) as ImportedModel;
        const nodeId = crypto.randomUUID();
        const width = 420;
        const height = 300;
        const pos = nextPosition(width, height);
        stagedAssets.push(asset);
        stagedNodes.push({
          id: nodeId,
          type: 'model',
          assetId: asset.id,
          title: asset.name,
          x: pos.x,
          y: pos.y,
          width,
          height,
          rotation: 0,
          zIndex: ++z
        });
        nodeIds.push(nodeId);
        imported += 1;
      } else if (documentExtensions.includes(ext)) {
        const asset = await registerRuntimeDocumentAsset(candidate.dataUrl, candidate.name) as ImportedDocument;
        const nodeType = documentNodeType(ext);
        const nodeId = crypto.randomUUID();
        const width = nodeType === 'table' ? 620 : 520;
        const height = nodeType === 'pdf' ? 700 : 380;
        const pos = nextPosition(width, height);
        stagedAssets.push(asset);
        stagedNodes.push({
          id: nodeId,
          type: nodeType,
          assetId: asset.id,
          title: asset.name,
          x: pos.x,
          y: pos.y,
          width,
          height,
          rotation: 0,
          zIndex: ++z,
          text: asset.extractedText || '双击编辑内容',
          richTextHtml: asset.contentHtml,
          spreadsheetData: asset.spreadsheetData,
          fillColor: nodeType === 'pdf' ? '#f5f5f2' : '#ffffff',
          strokeColor: '#7a7a7a',
          textColor: '#111111',
          fontFamily: 'Microsoft YaHei',
          fontSize: 15,
          fontWeight: 'normal',
          fontStyle: 'normal'
        });
        nodeIds.push(nodeId);
        imported += 1;
      } else {
        errors.push(`${candidate.name}\n当前格式暂不支持: .${ext || 'unknown'}`);
      }
    } catch (error) {
      errors.push(`${candidate.name}\n${String(error)}`);
    }
  }

  if (stagedAssets.length > 0 || stagedNodes.length > 0) {
    useProjectStore.getState().addAssetsAndNodes(stagedAssets, stagedNodes, nodeIds.length > 0 ? [nodeIds[nodeIds.length - 1]] : undefined);
  }

  return { imported, errors, nodeIds };
}

export async function importImageCandidatesToProject(
  candidates: ImageImportCandidate[],
  insertPoint?: { x: number; y: number },
  layoutDirection: ImportLayoutDirection = 'horizontal',
  projectRootOverride?: string
): Promise<{ imported: number; errors: string[]; nodeIds: string[] }> {
  const unique = new Map<string, ImageImportCandidate>();
  for (const candidate of candidates) {
    const key = candidate.kind === 'path'
      ? `path:${candidate.path}`
      : candidate.kind === 'remote-url'
        ? `url:${candidate.url}`
        : `data:${candidate.nameHint || ''}:${candidate.dataUrl.slice(0, 96)}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const list = Array.from(unique.values());
  if (list.length === 0) return { imported: 0, errors: [], nodeIds: [] };

  const state = useProjectStore.getState();
  const projectRoot = projectRootOverride?.trim() || state.project.rootPath || await getDefaultProjectRoot();
  const nextPosition = createLayoutCursor(insertPoint, layoutDirection);
  let imported = 0;
  const errors: string[] = [];
  const nodeIds: string[] = [];
  const stagedAssets: AssetRecord[] = [];
  const stagedNodes: CanvasNode[] = [];
  let z = state.project.nodes.reduce((max, node) => Math.max(max, node.zIndex || 0), 0);

  for (const candidate of list) {
    try {
      let asset: ImportedImage;
      if (candidate.kind === 'path') {
        asset = await importImageAsset(candidate.path, projectRoot);
      } else if (candidate.kind === 'remote-url') {
        asset = await importRemoteImageAsset(candidate.url, candidate.referer);
      } else {
        asset = candidate.nameHint
          ? await registerRuntimeAsset(candidate.dataUrl, candidate.nameHint)
          : await importClipboardImageDataUrl(candidate.dataUrl);
        if (candidate.nameHint && !asset.name) asset.name = candidate.nameHint;
      }
      const { width, height } = fitInitialNodeSize(asset.width, asset.height);
      const pos = nextPosition(width, height);
      const { node } = imageNodeForAsset(asset, pos.x, pos.y, ++z);
      stagedAssets.push(asset);
      stagedNodes.push(node);
      nodeIds.push(node.id);
      imported += 1;
    } catch (error) {
      const label = candidate.kind === 'path'
        ? candidate.path
        : candidate.kind === 'remote-url'
          ? candidate.url
          : candidate.nameHint || 'clipboard image';
      errors.push(`${label}\n${String(error)}`);
    }
  }

  if (stagedAssets.length > 0 || stagedNodes.length > 0) {
    useProjectStore.getState().addAssetsAndNodes(stagedAssets, stagedNodes, nodeIds.length > 0 ? [nodeIds[nodeIds.length - 1]] : undefined);
  }

  return { imported, errors, nodeIds };
}
