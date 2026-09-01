import { useEffect, useRef, useState, useLayoutEffect, type PointerEvent as ReactPointerEvent } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { desktopDir, join } from '@tauri-apps/api/path';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AssetPanel } from '../components/AssetPanel';
import { InspectorPanel } from '../components/InspectorPanel';
import { CanvasView } from '../features/canvas/CanvasView';
import { ModelViewer } from '../features/model-viewer/ModelViewer';
import { documentExtensions, imageExtensions, importFileDataCandidatesToProject, importImageCandidatesToProject, importPathsToProject, modelExtensions, videoExtensions, type FileDataImportCandidate, type ImageImportCandidate, type ImportLayoutDirection } from '../features/assets/importController';
import { exportEditableDocumentAsset, importClipboardImageDataUrl } from '../features/assets/assetImport';
import { AI_VISION_MODELS, type AiModelManifest } from '../features/ai/modelManifest';
import { loadProjectDataUrl, loadProjectFile, saveProjectFile } from '../features/project/projectIO';
import { useProjectStore } from '../stores/projectStore';
import type { AssetRecord, CanvasNode, DoodleTool, ImportedModel, RefMindProject, RefMindProjectFile, RefMindWorkspaceFile } from '../shared/types';
import { exportProjectToPng, exportSelectedNodesToPng } from '../features/export/exportCanvas';
import { clearImageCache, confirmDefaultImageCacheDirectory, getImageCacheStatus, setImageCacheDirectory, type ImageCacheStatus } from '../features/assets/imageCache';

interface ShortcutSettings {
  help: string;
  hierarchy: string;
  settings: string;
  undo: string;
  redo: string;
  copy: string;
  paste: string;
  delete: string;
  text: string;
  draw: string;
  group: string;
  save: string;
  open: string;
  newScene: string;
  close: string;
  exportImage: string;
  locate: string;
  bringFront: string;
  mindChild: string;
}

interface StorageSettings {}

type AIProviderType = 'openai-compatible' | 'ollama' | 'doubao' | 'custom';
type ImageProviderType = 'openai-images' | 'doubao-images';
type ImageInsertMode = 'right' | 'bottom' | 'auto';

interface AISettings {
  provider: AIProviderType;
  apiUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  imageProvider: ImageProviderType;
  imageApiUrl: string;
  imageApiKey: string;
  imageModel: string;
  imageSize: string;
  imageQuality: string;
  imageInsertMode: ImageInsertMode;
  localVisionModelId: string;
  localImageModelId: string;
  installedModelIds: string[];
}

interface LocalAIRuntimeStatus {
  ollamaModels?: string[];
  comfyuiReady?: boolean;
  comfyuiInstalled?: boolean;
  comfyuiBaseUrl?: string;
  installedImageModelIds?: string[];
}

const API_ONLY_EDITION = import.meta.env.VITE_REFMIND_API_ONLY === '1';
const WINDOW_OPACITY_STORAGE_KEY = 'refmind3d.window-opacity';

function readWindowOpacity() {
  const stored = Number(localStorage.getItem(WINDOW_OPACITY_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= 30 && stored <= 100 ? Math.round(stored) : 100;
}
const LOCAL_VISION_MODEL_NAMES = new Set(
  AI_VISION_MODELS.map((model) => model.ollamaModelName).filter(Boolean) as string[]
);
const LOCAL_IMAGE_MODEL_NAMES = [
  'sd-turbo',
  'sdxl-turbo',
  'sd35-medium',
  'flux1-schnell',
  'zero123plus',
  'models/image/'
];

function isLocalVisionModelName(modelName?: string) {
  return Boolean(modelName && LOCAL_VISION_MODEL_NAMES.has(modelName.trim()));
}

function isLocalImageModelName(modelName?: string) {
  const normalized = modelName?.trim().toLowerCase() || '';
  return Boolean(normalized && LOCAL_IMAGE_MODEL_NAMES.some((name) => normalized.includes(name)));
}

interface AppSettings {
  showAssetPanel: boolean;
  showInspectorPanel: boolean;
  showGrid: boolean;
  showStatusbar: boolean;
  importLayoutDirection: ImportLayoutDirection;
  storage: StorageSettings;
  ai: AISettings;
  shortcuts: ShortcutSettings;
}

type MenuAction = () => void | boolean | Promise<void | boolean>;
type ShortcutKey = keyof ShortcutSettings;

type CanvasWorkspace = {
  id: string;
  name: string;
  project: RefMindProject;
};

function cloneProjectSnapshot(project: RefMindProject): RefMindProject {
  return JSON.parse(JSON.stringify(project)) as RefMindProject;
}

function createEmptyCanvasProject(name: string): RefMindProject {
  const now = new Date().toISOString();
  return {
    version: 1,
    name,
    assets: [],
    nodes: [],
    links: [],
    doodles: [],
    createdAt: now,
    updatedAt: now
  };
}

function boundsForNodes(nodes: CanvasNode[]) {
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    centerX: left + (right - left) / 2,
    centerY: top + (bottom - top) / 2
  };
}

function visualOrder(nodes: CanvasNode[]) {
  return nodes.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

function isWorkspaceFile(file: RefMindProjectFile): file is RefMindWorkspaceFile {
  return (file as RefMindWorkspaceFile).fileType === 'refmind3d-workspace' && Array.isArray((file as RefMindWorkspaceFile).canvases);
}

function workspaceSnapshot(
  canvases: CanvasWorkspace[],
  activeCanvasId: string,
  activeProject: RefMindProject
): CanvasWorkspace[] {
  return canvases.map((canvas) => (
    canvas.id === activeCanvasId
      ? { ...canvas, name: activeProject.name || canvas.name, project: cloneProjectSnapshot(activeProject) }
      : { ...canvas, project: cloneProjectSnapshot(canvas.project) }
  ));
}

function workspaceContentSignature(
  canvases: CanvasWorkspace[],
  activeCanvasId: string,
  activeProject: RefMindProject
) {
  return JSON.stringify({
    activeCanvasId,
    canvases: workspaceSnapshot(canvases, activeCanvasId, activeProject)
  });
}

function createWorkspaceFile(
  canvases: CanvasWorkspace[],
  activeCanvasId: string,
  activeProject: RefMindProject,
  cacheId: string
): RefMindWorkspaceFile {
  const now = new Date().toISOString();
  const snapshot = workspaceSnapshot(canvases, activeCanvasId, activeProject);
  return {
    version: 2,
    cacheId,
    fileType: 'refmind3d-workspace',
    name: 'RefMind3D 多画布工程',
    activeCanvasId,
    canvases: snapshot,
    createdAt: snapshot[0]?.project.createdAt || now,
    updatedAt: now
  };
}

const defaultShortcuts: ShortcutSettings = {
  help: 'Ctrl+H',
  hierarchy: 'Ctrl+J',
  settings: 'Ctrl+U',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  delete: 'Delete',
  text: 'Ctrl+N',
  draw: 'Ctrl+D',
  group: 'Ctrl+G',
  save: 'Ctrl+S',
  open: 'Ctrl+O',
  newScene: 'Ctrl+K',
  close: 'Ctrl+Q',
  exportImage: 'Ctrl+E',
  locate: 'F',
  bringFront: 'Ctrl+J',
  mindChild: 'Alt+RightMouse'
};

const shortcutNames: Record<ShortcutKey, string> = {
  help: '帮助',
  hierarchy: '层级/置前',
  settings: '设置',
  undo: '撤销',
  redo: '重做',
  copy: '复制',
  paste: '粘贴',
  delete: '删除选中',
  text: '创建文本',
  draw: '绘制模式',
  group: '打组',
  save: '保存工程',
  open: '打开工程',
  newScene: '新场景',
  close: '关闭',
  exportImage: '按原格式导出选中到桌面',
  locate: '定位并拉近选中',
  bringFront: '选中置于最前',
  mindChild: '拖出思维导图子对象'
};

const defaultStorage: StorageSettings = {};

const defaultAISettings: AISettings = {
  provider: API_ONLY_EDITION ? 'openai-compatible' : 'ollama',
  apiUrl: API_ONLY_EDITION ? 'https://api.openai.com/v1' : 'http://127.0.0.1:11435/v1',
  apiKey: '',
  model: API_ONLY_EDITION ? 'gpt-4o-mini' : 'qwen2.5vl:7b',
  systemPrompt: '你是 RefMind3D 内置 AI 助手。回答要直接、实用，优先帮助用户分析参考图、模型、文档、表格、思维导图和当前画布内容。',
  imageProvider: 'openai-images',
  imageApiUrl: 'https://api.openai.com/v1',
  imageApiKey: '',
  imageModel: 'gpt-image-1',
  imageSize: '1024x1024',
  imageQuality: 'auto',
  imageInsertMode: 'right',
  localVisionModelId: 'qwen25vl-7b-6g',
  localImageModelId: 'sd-turbo-6g',
  installedModelIds: []
};

const defaultSettings: AppSettings = {
  showAssetPanel: false,
  showInspectorPanel: false,
  showGrid: false,
  showStatusbar: true,
  importLayoutDirection: 'horizontal',
  storage: defaultStorage,
  ai: defaultAISettings,
  shortcuts: defaultShortcuts
};

function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('refmind3d.settings');
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const next = {
      ...defaultSettings,
      ...parsed,
      storage: { ...defaultStorage, ...(parsed.storage || {}) },
      ai: { ...defaultAISettings, ...(parsed.ai || {}) },
      shortcuts: { ...defaultShortcuts, ...(parsed.shortcuts || {}) }
    };
    if (API_ONLY_EDITION) {
      if (next.ai.provider === 'ollama') {
        next.ai.provider = 'openai-compatible';
      }
      if (next.ai.imageProvider !== 'openai-images' && next.ai.imageProvider !== 'doubao-images') {
        next.ai.imageProvider = 'openai-images';
      }
      if (isLocalVisionModelName(next.ai.model)) {
        next.ai.model = defaultAISettings.model;
      }
      if (isLocalImageModelName(next.ai.imageModel)) {
        next.ai.imageModel = defaultAISettings.imageModel;
      }
      next.ai.localVisionModelId = '';
      next.ai.localImageModelId = '';
      next.ai.installedModelIds = [];
    }
    return next;
  } catch {
    return defaultSettings;
  }
}

function shortcutLabel(text?: string) {
  return text ? <span className="menu-shortcut">{text}</span> : null;
}

function normalizeShortcut(shortcut: string) {
  return shortcut.toLowerCase().replace(/\s+/g, '');
}

function keyFromShortcut(shortcut: string) {
  const parts = normalizeShortcut(shortcut).split('+');
  return parts[parts.length - 1] || '';
}

function isMouseShortcut(shortcut: string) {
  const normalized = normalizeShortcut(shortcut);
  return normalized.includes('mouse') || normalized.includes('鼠标') || normalized.includes('右键') || normalized.includes('左键') || normalized.includes('中键');
}

function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  if (!shortcut || isMouseShortcut(shortcut)) return false;
  const normalized = normalizeShortcut(shortcut);
  const key = keyFromShortcut(normalized);
  const actual = event.key.toLowerCase();
  if (actual !== key) return false;
  const wantsCtrl = normalized.includes('ctrl') || normalized.includes('cmd') || normalized.includes('meta');
  const wantsAlt = normalized.includes('alt');
  const wantsShift = normalized.includes('shift');
  if (wantsCtrl !== (event.ctrlKey || event.metaKey)) return false;
  if (wantsAlt !== event.altKey) return false;
  if (wantsShift !== event.shiftKey) return false;
  return true;
}


function dispatchFocusNodeIds(ids: string[]) {
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('refmind3d-focus-node-ids', { detail: { ids } }));
  }, 80);
}

function dispatchEditNode(id: string) {
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('refmind3d-edit-node', { detail: { id } }));
  }, 0);
}

function isEditableElement(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable;
}

function readDropWorldPoint(position: unknown, fallback: { x: number; y: number }) {
  const converter = (window as unknown as { __refmind3dClientToWorld?: (clientX: number, clientY: number) => { x: number; y: number } }).__refmind3dClientToWorld;
  if (!converter || !position || typeof position !== 'object') return fallback;
  const point = position as { x?: number; y?: number };
  if (typeof point.x !== 'number' || typeof point.y !== 'number') return fallback;
  let clientX = point.x;
  let clientY = point.y;
  const ratio = window.devicePixelRatio || 1;
  if (ratio > 1 && (clientX > window.innerWidth || clientY > window.innerHeight)) {
    clientX /= ratio;
    clientY /= ratio;
  }
  return converter(clientX, clientY);
}


function looksLikeAbsoluteFilePath(path: string) {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\');
}

function localPathFromFileUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return null;
    const decodedPath = decodeURIComponent(url.pathname);
    if (url.host) return `\\\\${url.host}${decodedPath.replace(/\//g, '\\')}`;
    return decodedPath.replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, '\\');
  } catch {
    return null;
  }
}

function localPathsFromDropText(value: string) {
  const paths: string[] = [];
  const addValue = (rawValue: string) => {
    const cleaned = rawValue.trim().replace(/^['"]|['"]$/g, '');
    if (!cleaned || cleaned.startsWith('#')) return;
    if (/^file:/i.test(cleaned)) {
      const path = localPathFromFileUrl(cleaned);
      if (path && looksLikeAbsoluteFilePath(path)) paths.push(path);
      return;
    }
    if (looksLikeAbsoluteFilePath(cleaned)) paths.push(cleaned);
  };
  value.split(/\r?\n/).forEach(addValue);
  const embeddedFileUrl = value.match(/file:\/\/[^\r\n]+/i)?.[0];
  if (embeddedFileUrl) addValue(embeddedFileUrl);
  return paths;
}

function extractDomDropPaths(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return [] as string[];
  const paths: string[] = [];
  Array.from(dataTransfer.files || []).forEach((file) => {
    const maybePath = (file as File & { path?: string }).path;
    if (maybePath && looksLikeAbsoluteFilePath(maybePath)) {
      paths.push(maybePath);
    }
  });
  const hasDroppedFiles = (dataTransfer.files?.length || 0) > 0;
  const localUriValues = [
    dataTransfer.getData('text/uri-list'),
    dataTransfer.getData('DownloadURL'),
    dataTransfer.getData('text/x-moz-url')
  ];
  localUriValues.forEach((value) => paths.push(...localPathsFromDropText(value)));
  if (hasDroppedFiles) {
    paths.push(...localPathsFromDropText(dataTransfer.getData('text/plain')));
  }
  return Array.from(new Set(paths));
}

function isSupportedAssetExtension(ext: string) {
  return imageExtensions.includes(ext) || modelExtensions.includes(ext) || videoExtensions.includes(ext) || documentExtensions.includes(ext);
}

function fileNameWithTypeFallback(file: File) {
  if (file.name && fileExtension(file.name)) return file.name;
  const mime = file.type.toLowerCase();
  if (mime === 'image/png') return file.name || 'image.png';
  if (mime === 'image/jpeg') return file.name || 'image.jpg';
  if (mime === 'image/webp') return file.name || 'image.webp';
  if (mime === 'image/gif') return file.name || 'image.gif';
  if (mime === 'video/mp4') return file.name || 'video.mp4';
  if (mime === 'video/webm') return file.name || 'video.webm';
  if (mime === 'application/pdf') return file.name || 'document.pdf';
  return file.name || 'dropped-file.bin';
}

async function extractDomDropFileDataCandidates(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return [] as FileDataImportCandidate[];
  const candidates: FileDataImportCandidate[] = [];
  const seen = new Set<File>();
  const addFile = async (file: File | null) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    const maybePath = (file as File & { path?: string }).path;
    if (maybePath && looksLikeAbsoluteFilePath(maybePath)) return;
    const name = fileNameWithTypeFallback(file);
    const ext = fileExtension(name);
    if (!isSupportedAssetExtension(ext)) return;
    candidates.push({ dataUrl: await dataUrlFromBlob(file), name, mime: file.type || undefined });
  };
  for (const file of Array.from(dataTransfer.files || [])) {
    await addFile(file);
  }
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind === 'file') {
      await addFile(item.getAsFile());
    }
  }
  return candidates;
}

const projectExtensions = ['refmind3d', 'refmind'];

type ProjectDropCandidate = {
  name: string;
  dataUrl: string;
};

function fileExtension(path: string) {
  return path.split('?')[0].split('.').pop()?.toLowerCase() || '';
}

function dataUrlFromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取剪贴板图片失败'));
    reader.readAsDataURL(blob);
  });
}

async function extractDomDropProjectCandidates(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return [] as ProjectDropCandidate[];
  const candidates: ProjectDropCandidate[] = [];
  const seen = new Set<File>();
  const addFile = async (file: File | null) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    const maybePath = (file as File & { path?: string }).path;
    if (maybePath && looksLikeAbsoluteFilePath(maybePath)) return;
    const name = file.name || 'dropped.refmind3d';
    if (!projectExtensions.includes(fileExtension(name))) return;
    candidates.push({ name, dataUrl: await dataUrlFromBlob(file) });
  };
  for (const file of Array.from(dataTransfer.files || [])) {
    await addFile(file);
  }
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind === 'file') {
      await addFile(item.getAsFile());
    }
  }
  return candidates;
}

function isPotentialDropData(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  return types.some((type) => {
    const normalized = type.toLowerCase();
    return type === 'Files' || normalized.includes('html') || normalized.includes('uri') || normalized.includes('url') || normalized.startsWith('text/') || normalized === 'downloadurl';
  });
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

function isDataImageUrl(value: string) {
  return /^data:image\//i.test(value.trim());
}

function isLikelyImageUrl(value: string) {
  const clean = value.trim();
  if (isDataImageUrl(clean)) return true;
  if (!isHttpUrl(clean)) return false;
  const withoutQuery = clean.split(/[?#]/)[0].toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|ico|tiff?|avif|svg)$/.test(withoutQuery) || clean.includes('/image') || clean.includes('img');
}

function absoluteImageUrl(value: string, base?: string | null) {
  const clean = value.trim().replace(/^['"]|['"]$/g, '');
  if (!clean || clean.startsWith('cid:')) return '';
  if (isDataImageUrl(clean) || isHttpUrl(clean)) return clean;
  if (!base) return '';
  try {
    return new URL(clean, base).toString();
  } catch {
    return '';
  }
}

function decodeUrlish(value: string) {
  let clean = value.trim().replace(/^['"]|['"]$/g, '').replace(/&amp;/g, '&').replace(/\\\//g, '/').replace(/\\u002F/gi, '/').replace(/\\u003A/gi, ':');
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(clean);
      if (decoded === clean) break;
      clean = decoded;
    } catch {
      break;
    }
  }
  return clean;
}

function addImageUrlCandidate(candidates: ImageImportCandidate[], value: string, referer?: string | null, trustImageContext = false) {
  const decoded = decodeUrlish(value);
  try {
    const parsed = new URL(decoded);
    ['objurl', 'thumbURL', 'middleURL', 'hoverURL', 'currentSrc', 'src', 'imgurl'].forEach((key) => {
      const nested = parsed.searchParams.get(key);
      if (nested) addImageUrlCandidate(candidates, nested, referer, true);
    });
  } catch {
    // Plain relative URLs are handled below.
  }
  const url = absoluteImageUrl(decoded, referer);
  if (!url) return;
  if (isDataImageUrl(url)) {
    candidates.push({ kind: 'data-url', dataUrl: url });
    return;
  }
  if (trustImageContext || isLikelyImageUrl(url) || /pinterest|pinimg|baidu|bdimg/i.test(url)) {
    candidates.push({ kind: 'remote-url', url, referer: referer || undefined });
  }
}

function srcsetUrls(value: string) {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function extractImageCandidatesFromHtml(html: string, fallbackBase?: string) {
  const candidates: ImageImportCandidate[] = [];
  if (!html.trim()) return candidates;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = doc.querySelector('base[href]')?.getAttribute('href') || fallbackBase;
  doc.querySelectorAll('img, source, a, meta, div, span').forEach((element) => {
    ['src', 'href', 'content', 'data-src', 'data-original', 'data-lazy-src', 'data-iurl', 'data-objurl', 'data-thumb', 'data-pin-media', 'data-fullsrc'].forEach((attr) => {
      const value = element.getAttribute(attr);
      if (value) addImageUrlCandidate(candidates, value, base, attr !== 'href');
    });
    const srcset = element.getAttribute('srcset') || element.getAttribute('data-srcset');
    if (srcset) srcsetUrls(srcset).forEach((url) => addImageUrlCandidate(candidates, url, base, true));
  });
  const cssUrls = html.match(/url\(([^)]+)\)/gi) || [];
  cssUrls.forEach((match) => {
    const raw = match.replace(/^url\(/i, '').replace(/\)$/, '');
    addImageUrlCandidate(candidates, raw, base, true);
  });
  return candidates;
}

function extractImageCandidatesFromText(text: string) {
  const candidates: ImageImportCandidate[] = [];
  const urls = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  urls.forEach((url) => addImageUrlCandidate(candidates, url, undefined, urls.length === 1));
  if (isDataImageUrl(text.trim())) candidates.push({ kind: 'data-url', dataUrl: text.trim() });
  return candidates;
}

function extractCandidatesFromDownloadUrl(value: string) {
  const candidates: ImageImportCandidate[] = [];
  if (!value.trim()) return candidates;
  const match = value.match(/https?:\/\/.+$/i);
  if (match) addImageUrlCandidate(candidates, match[0], undefined, true);
  return candidates;
}

function extractGenericTextDropCandidates(dataTransfer: DataTransfer) {
  const candidates: ImageImportCandidate[] = [];
  for (const type of Array.from(dataTransfer.types || [])) {
    const normalized = type.toLowerCase();
    if (type === 'Files') continue;
    let value = '';
    try {
      value = dataTransfer.getData(type);
    } catch {
      continue;
    }
    if (!value) continue;
    if (normalized === 'downloadurl') {
      candidates.push(...extractCandidatesFromDownloadUrl(value));
    } else if (normalized.includes('html')) {
      candidates.push(...extractImageCandidatesFromHtml(value));
    } else if (normalized.includes('uri') || normalized.includes('url') || normalized.startsWith('text/')) {
      candidates.push(...extractImageCandidatesFromText(value));
      value.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#')).forEach((url) => addImageUrlCandidate(candidates, url, undefined, true));
    }
  }
  return candidates;
}

function remoteCandidateIdentity(url: string) {
  try {
    const parsed = new URL(decodeUrlish(url));
    const host = parsed.hostname.toLowerCase();
    let path = parsed.pathname.toLowerCase();
    if (host.includes('i.pinimg.com')) {
      path = path.replace(/^\/(originals|236x|474x|564x|736x)\//, '/');
      return `pinimg:${path}`;
    }
    for (const key of ['objurl', 'thumburl', 'middleurl', 'hoverurl', 'currentsrc', 'src', 'imgurl']) {
      const nested = parsed.searchParams.get(key) || parsed.searchParams.get(key.toUpperCase());
      if (nested && isHttpUrl(nested)) return remoteCandidateIdentity(nested);
    }
    parsed.hash = '';
    ['w', 'h', 'width', 'height', 'size', 'quality', 'q'].forEach((key) => parsed.searchParams.delete(key));
    return `${host}${parsed.pathname}${parsed.search}`;
  } catch {
    return decodeUrlish(url).trim().toLowerCase();
  }
}

function remoteCandidateScore(candidate: Extract<ImageImportCandidate, { kind: 'remote-url' }>) {
  let score = 100;
  try {
    const parsed = new URL(decodeUrlish(candidate.url));
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (isLikelyImageUrl(parsed.toString())) score += 300;
    if (host.includes('i.pinimg.com')) score += 300;
    if (host.includes('bdimg.com') || host.includes('baidu.com')) score += 140;
    if (path.includes('/736x/')) score += 180;
    if (path.includes('/564x/')) score += 160;
    if (path.includes('/474x/')) score += 130;
    if (path.includes('/236x/')) score += 90;
    if (path.includes('/originals/')) score += 80;
    if (/\.(png|jpe?g|webp|gif|bmp|ico|tiff?|avif|svg)$/i.test(path)) score += 120;
    if (/\/pin\/\d+/i.test(path)) score += 30;
    const nestedKeys = ['objurl', 'thumbURL', 'middleURL', 'hoverURL', 'currentSrc', 'src', 'imgurl'];
    if (nestedKeys.some((key) => parsed.searchParams.has(key))) score += 80;
  } catch {
    if (isLikelyImageUrl(candidate.url)) score += 200;
  }
  if (candidate.referer) score += 20;
  return score;
}

function candidateDropKey(candidate: ImageImportCandidate) {
  if (candidate.kind === 'path') return `path:${candidate.path.trim().toLowerCase()}`;
  if (candidate.kind === 'remote-url') return `remote:${remoteCandidateIdentity(candidate.url)}`;
  return `data:${candidate.nameHint || ''}:${candidate.dataUrl.slice(0, 128)}`;
}

function selectPureRefStyleCandidates(candidates: ImageImportCandidate[]) {
  const pathCandidates = new Map<string, ImageImportCandidate>();
  const remoteGroups = new Map<string, Extract<ImageImportCandidate, { kind: 'remote-url' }>>();
  const dataCandidates = new Map<string, Extract<ImageImportCandidate, { kind: 'data-url' }>>();

  for (const candidate of candidates) {
    if (candidate.kind === 'path') {
      pathCandidates.set(candidate.path.trim().toLowerCase(), candidate);
    } else if (candidate.kind === 'remote-url') {
      const key = remoteCandidateIdentity(candidate.url);
      const existing = remoteGroups.get(key);
      if (!existing || remoteCandidateScore(candidate) > remoteCandidateScore(existing)) {
        remoteGroups.set(key, candidate);
      }
    } else {
      const key = `${candidate.nameHint || ''}:${candidate.dataUrl.slice(0, 128)}`;
      const existing = dataCandidates.get(key);
      if (!existing || candidate.dataUrl.length > existing.dataUrl.length) {
        dataCandidates.set(key, candidate);
      }
    }
  }

  const paths = Array.from(pathCandidates.values());
  if (paths.length > 0) return paths;

  const remotes = Array.from(remoteGroups.values()).sort((a, b) => remoteCandidateScore(b) - remoteCandidateScore(a));
  if (remotes.length > 0) return [remotes[0]];

  const dataUrls = Array.from(dataCandidates.values()).sort((a, b) => b.dataUrl.length - a.dataUrl.length);
  return dataUrls.slice(0, 1);
}

async function extractDomDropImageCandidates(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return [] as ImageImportCandidate[];
  const candidates: ImageImportCandidate[] = [];
  const seenFiles = new Set<File>();
  for (const file of Array.from(dataTransfer.files || [])) {
    seenFiles.add(file);
    const maybePath = (file as File & { path?: string }).path;
    if (maybePath && looksLikeAbsoluteFilePath(maybePath) && imageExtensions.includes(fileExtension(maybePath))) {
      candidates.push({ kind: 'path', path: maybePath });
    } else if (file.type.startsWith('image/') || imageExtensions.includes(fileExtension(file.name))) {
      candidates.push({ kind: 'data-url', dataUrl: await dataUrlFromBlob(file), nameHint: file.name });
    }
  }
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file && !seenFiles.has(file) && (item.type.startsWith('image/') || imageExtensions.includes(fileExtension(file.name)))) {
        candidates.push({ kind: 'data-url', dataUrl: await dataUrlFromBlob(file), nameHint: file.name });
      }
    }
  }
  const html = dataTransfer.getData('text/html');
  const uriList = dataTransfer.getData('text/uri-list');
  const plain = dataTransfer.getData('text/plain');
  const fallbackBase = uriList.split(/\r?\n/).find((line) => isHttpUrl(line.trim())) || (isHttpUrl(plain.trim()) ? plain.trim() : undefined);
  candidates.push(...extractImageCandidatesFromHtml(html, fallbackBase));
  uriList.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#')).forEach((url) => addImageUrlCandidate(candidates, url, undefined, true));
  candidates.push(...extractImageCandidatesFromText(plain));
  candidates.push(...extractCandidatesFromDownloadUrl(dataTransfer.getData('DownloadURL')));
  candidates.push(...extractGenericTextDropCandidates(dataTransfer));
  if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
    console.debug('RefMind3D drop payload', {
      types: Array.from(dataTransfer.types || []),
      htmlLength: html.length,
      uriList,
      plain,
      files: dataTransfer.files?.length || 0,
      items: dataTransfer.items?.length || 0,
      candidates
    });
  }
  return candidates;
}

function extractTauriDropPaths(payload: unknown) {
  if (!payload || typeof payload !== 'object') return [] as string[];
  const maybePayload = payload as { paths?: unknown; path?: unknown };
  if (Array.isArray(maybePayload.paths)) {
    return maybePayload.paths.filter((path): path is string => typeof path === 'string' && path.length > 0);
  }
  if (typeof maybePayload.path === 'string' && maybePayload.path.length > 0) {
    return [maybePayload.path];
  }
  return [] as string[];
}

export function App() {
  const {
    project,
    setProject,
    deleteSelected,
    selectedNodeIds,
    undo,
    redo,
    copySelected,
    pasteClipboard,
    createTextNode,
    updateNode,
    updateNodes,
    groupSelected,
    ungroupSelected,
    toggleSelectedGroupLock,
    bringSelectedToFront,
    sendSelectedToBack,
    moveSelectedForward,
    moveSelectedBackward,
    fitSelectedImagesToNaturalSize,
    undoLastDoodle,
    clearDoodles,
    history,
    future,
    clipboardNodes
  } = useProjectStore();
  const [status, setStatus] = useState('就绪 · 右键打开菜单，拖入文件可导入');
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [windowOpacity, setWindowOpacity] = useState(readWindowOpacity);
  const [opacityPanelOpen, setOpacityPanelOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => readSettings());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const preferInternalClipboardRef = useRef(false);

  useLayoutEffect(() => {
    if (contextMenu && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const menuWidth = rect.width;
      const menuHeight = rect.height;
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      
      let left = contextMenu.x;
      let top = contextMenu.y;
      
      if (left + menuWidth > windowWidth) {
        left = windowWidth - menuWidth - 8;
      }
      if (left < 8) {
        left = 8;
      }
      
      if (top + menuHeight > windowHeight) {
        top = windowHeight - menuHeight - 8;
      }
      if (top < 8) {
        top = 8;
      }
      
      menuRef.current.style.left = `${left}px`;
      menuRef.current.style.top = `${top}px`;
      
      // If there is not enough room on the right for submenus, make them open to the left
      const openLeft = left + menuWidth * 2 > windowWidth;
      if (openLeft) {
        menuRef.current.classList.add('open-left');
      } else {
        menuRef.current.classList.remove('open-left');
      }
      
      menuRef.current.style.visibility = 'visible';
    }
  }, [contextMenu]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceCacheId, setWorkspaceCacheId] = useState<string>(() => crypto.randomUUID());
  const [imageCacheStatus, setImageCacheStatus] = useState<ImageCacheStatus | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [pendingCanvasDeletionId, setPendingCanvasDeletionId] = useState<string | null>(null);
  const [closePromptMode, setClosePromptMode] = useState<'unsaved' | 'confirm' | null>(null);
  const [closeSaveBusy, setCloseSaveBusy] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [doodleMode, setDoodleMode] = useState(false);
  const [doodleColor, setDoodleColor] = useState('#ff4d4f');
  const [doodleWidth, setDoodleWidth] = useState(6);
  const [doodleTool, setDoodleTool] = useState<DoodleTool>('brush');
  const [modelPreview, setModelPreview] = useState<ImportedModel | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [localOllamaModels, setLocalOllamaModels] = useState<string[]>([]);
  const [modelInstallBusy, setModelInstallBusy] = useState('');
  const launchProjectHandledRef = useRef(false);
  const [aiDockTop, setAiDockTop] = useState(96);
  const [aiDockOpen, setAiDockOpen] = useState(false);
  const [canvasDockOpen, setCanvasDockOpen] = useState(false);
  const [editingCanvasId, setEditingCanvasId] = useState<string | null>(null);
  const [editingCanvasName, setEditingCanvasName] = useState('');
  const aiDockRef = useRef<HTMLElement | null>(null);
  const aiDragRef = useRef<{ pointerId: number; startY: number; startTop: number } | null>(null);
  const [lastCanvasPoint, setLastCanvasPoint] = useState({ x: 160, y: 160 });
  const [activeCanvasId, setActiveCanvasId] = useState('main-canvas');
  const [canvasSwitching, setCanvasSwitching] = useState(false);
  const [canvases, setCanvases] = useState<CanvasWorkspace[]>(() => [{
    id: 'main-canvas',
    name: '主画布',
    project: cloneProjectSnapshot(project)
  }]);
  const lastCanvasPointRef = useRef(lastCanvasPoint);
  const activeCanvasIdRef = useRef(activeCanvasId);
  const canvasSwitchTimerRef = useRef<number | null>(null);
  const lastDropKeyRef = useRef<{ key: string; time: number } | null>(null);
  const saveNoticeTimerRef = useRef<number | null>(null);
  const [savedWorkspaceSignature, setSavedWorkspaceSignature] = useState<string | null>(null);
  const currentWorkspaceSignature = workspaceContentSignature(canvases, activeCanvasId, project);
  const hasUnsavedChanges = savedWorkspaceSignature !== null && savedWorkspaceSignature !== currentWorkspaceSignature;
  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);

  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (savedWorkspaceSignature === null) {
      setSavedWorkspaceSignature(currentWorkspaceSignature);
    }
  }, [currentWorkspaceSignature, savedWorkspaceSignature]);

  useEffect(() => () => {
    if (saveNoticeTimerRef.current) window.clearTimeout(saveNoticeTimerRef.current);
  }, []);

  const showTransientNotice = (message: string) => {
    setSaveNotice(message);
    if (saveNoticeTimerRef.current) window.clearTimeout(saveNoticeTimerRef.current);
    saveNoticeTimerRef.current = window.setTimeout(() => {
      setSaveNotice(null);
      saveNoticeTimerRef.current = null;
    }, 2400);
  };

  const showProjectSavedNotice = (path: string) => {
    const fileName = path.split(/[\\/]/).pop() || path;
    showTransientNotice(`已保存 · ${fileName}`);
  };

  const toggleAlwaysOnTop = async () => {
    try {
      const appWindow = getCurrentWindow();
      const next = !(await appWindow.isAlwaysOnTop());
      await appWindow.setAlwaysOnTop(next);
      setAlwaysOnTop(next);
      showTransientNotice(next ? '已置于所有窗口最前 · Ctrl+Shift+A 取消' : '已取消窗口置顶');
    } catch (error) {
      setStatus(`切换窗口置顶失败：${String(error)}`);
    }
  };

  const toggleFullscreen = async () => {
    try {
      const appWindow = getCurrentWindow();
      const next = !(await appWindow.isFullscreen());
      await appWindow.setFullscreen(next);
      setFullscreen(next);
      showTransientNotice(next ? '已进入全屏画布 · Ctrl+F 退出' : '已退出全屏画布');
    } catch (error) {
      setStatus(`切换全屏失败：${String(error)}`);
    }
  };

  const applyWindowOpacity = (value: number, announce = false) => {
    const next = Math.max(30, Math.min(100, Math.round(value)));
    setWindowOpacity(next);
    localStorage.setItem(WINDOW_OPACITY_STORAGE_KEY, String(next));
    if (announce) showTransientNotice(`画布透明度 ${next}%`);
  };

  useEffect(() => {
    const appWindow = getCurrentWindow();
    void Promise.all([appWindow.isAlwaysOnTop(), appWindow.isFullscreen()])
      .then(([top, full]) => {
        setAlwaysOnTop(top);
        setFullscreen(full);
      })
      .catch((error) => console.error('Failed to read window state', error));
  }, []);

  useEffect(() => {
    void invoke('set_window_opacity', { opacity: windowOpacity / 100 }).catch((error) => {
      console.error('Failed to apply window opacity', error);
    });
  }, [windowOpacity]);

  const updateSettings = (patch: Partial<AppSettings>) => {
    setSettings((current) => {
      const next = {
        ...current,
        ...patch,
        storage: { ...current.storage, ...(patch.storage || {}) },
        ai: { ...current.ai, ...(patch.ai || {}) },
        shortcuts: { ...current.shortcuts, ...(patch.shortcuts || {}) }
      };
      localStorage.setItem('refmind3d.settings', JSON.stringify(next));
      return next;
    });
  };

  const refreshImageCacheStatus = async () => {
    try {
      const next = await getImageCacheStatus();
      setImageCacheStatus(next);
      if (!next.available) {
        setSettingsOpen(true);
        setStatus('图片缓存目录不可用，请在设置中重新选择');
      }
      return next;
    } catch (error) {
      setStatus(`读取图片缓存状态失败：${String(error)}`);
      return null;
    }
  };

  useEffect(() => {
    void getImageCacheStatus().then((next) => {
      setImageCacheStatus(next);
      if (!next.initialized || !next.available) {
        setSettingsOpen(true);
        setStatus(next.available ? '首次使用：请确认或修改图片缓存目录' : '图片缓存目录不可用，请重新选择');
      }
    }).catch((error) => setStatus(`图片缓存初始化失败：${String(error)}`));
  }, []);

  useEffect(() => {
    const onCacheError = (event: Event) => {
      const message = (event as CustomEvent<string>).detail || '缓存目录不可用';
      setStatus('图片缓存不可用，请重新选择目录');
      setSettingsOpen(true);
      setImageCacheStatus((current) => current ? { ...current, available: false, error: message } : current);
    };
    window.addEventListener('refmind3d-image-cache-error', onCacheError);
    return () => window.removeEventListener('refmind3d-image-cache-error', onCacheError);
  }, []);

  const chooseImageCacheDirectory = async () => {
    const selected = await open({ directory: true, multiple: false, title: '选择 RefMind3D 图片缓存目录' });
    if (!selected || Array.isArray(selected)) return;
    setCacheBusy(true);
    try {
      setImageCacheStatus(await setImageCacheDirectory(selected));
      window.dispatchEvent(new Event('refmind3d-image-cache-reset'));
      setStatus('图片缓存目录已更新');
    } catch (error) {
      alert(`缓存目录不可用，请重新选择。\n\n${String(error)}`);
    } finally { setCacheBusy(false); }
  };

  const confirmDefaultCache = async () => {
    setCacheBusy(true);
    try { setImageCacheStatus(await confirmDefaultImageCacheDirectory()); setStatus('已使用默认图片缓存目录'); }
    catch (error) { alert(`默认缓存目录不可用：${String(error)}`); }
    finally { setCacheBusy(false); }
  };

  const runCacheCleanup = async (olderThanDays?: number) => {
    setCacheBusy(true);
    try {
      setImageCacheStatus(await clearImageCache(olderThanDays));
      window.dispatchEvent(new Event('refmind3d-image-cache-reset'));
      setStatus(olderThanDays ? '已清理 30 天前未使用的图片缓存' : '图片缓存已全部清理');
    } catch (error) { alert(`清理缓存失败：${String(error)}`); }
    finally { setCacheBusy(false); }
  };

  const updateAISettings = (patch: Partial<AISettings>) => {
    updateSettings({ ai: { ...settings.ai, ...patch } });
  };

  const updateAIProvider = (provider: AIProviderType) => {
    const nextProvider = API_ONLY_EDITION && provider === 'ollama' ? 'openai-compatible' : provider;
    const nextAI = { ...settings.ai, provider: nextProvider };
    if (nextProvider !== 'ollama' && isLocalVisionModelName(nextAI.model)) {
      nextAI.model = defaultAISettings.model;
    }
    updateSettings({ ai: nextAI });
  };

  const updateShortcut = (key: ShortcutKey, value: string) => {
    updateSettings({ shortcuts: { ...settings.shortcuts, [key]: value } });
  };

  const resetShortcuts = () => updateSettings({ shortcuts: defaultShortcuts });
  const closeMenu = () => setContextMenu(null);
  const clearConfiguredCache = async () => {
    const targets = ([] as string[])
      .map((item) => item.trim())
      .filter(Boolean);
    if (targets.length === 0) {
      alert('请先设置无缓存模式或工程资源解包。');
      return;
    }
    if (!confirm(`确定清理以下缓存目录吗？\n\n${targets.join('\n')}`)) return;
    try {
      const count = targets.length;
      setStatus(`已清理 ${count} 个缓存目录`);
    } catch (error) {
      alert(`清理缓存失败：${String(error)}`);
    }
  };

  const nextZIndex = () => useProjectStore.getState().project.nodes.reduce((max, node) => Math.max(max, node.zIndex || 0), 0) + 1;

  const insertClipboardImageDataUrl = async (dataUrl: string, index = 0) => {
    const asset = await importClipboardImageDataUrl(dataUrl);
    const nodeId = crypto.randomUUID();
    const point = lastCanvasPointRef.current;
    const spacing = 36;
    const offset = index * spacing;
    const width = Math.max(24, asset.width);
    const height = Math.max(24, asset.height);
    useProjectStore.getState().addAssetsAndNodes([asset], [{
      id: nodeId,
      type: 'image',
      assetId: asset.id,
      title: asset.name,
      x: Math.round(point.x - width / 2 + offset),
      y: Math.round(point.y - height / 2 + offset),
      width,
      height,
      rotation: 0,
      zIndex: nextZIndex()
    }]);
    return nodeId;
  };

  const handleSystemClipboardPaste = async () => {
    let inserted = 0;
    try {
      if ('clipboard' in navigator && typeof navigator.clipboard?.read === 'function') {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith('image/'));
          if (!imageType) continue;
          const blob = await item.getType(imageType);
          const dataUrl = await dataUrlFromBlob(blob);
          await insertClipboardImageDataUrl(dataUrl, inserted);
          inserted += 1;
        }
      }
    } catch (error) {
      console.warn('读取系统剪贴板图片失败，尝试内部粘贴兜底', error);
    }
    if (inserted > 0) {
      setStatus(`已从系统剪贴板粘贴 ${inserted} 张图片`);
      return true;
    }
    return false;
  };

  const handleClipboardEventPaste = async (event: ClipboardEvent) => {
    if (isEditableElement(event.target)) return false;
    const data = event.clipboardData;
    if (!data) return false;
    const imageFiles = Array.from(data.files || []).filter((file) => file.type.startsWith('image/'));
    const itemFiles = Array.from(data.items || [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const files = imageFiles.length > 0 ? imageFiles : itemFiles;
    if (files.length === 0) {
      const candidates: ImageImportCandidate[] = [];
      const plain = data.getData('text/plain');
      const uriList = data.getData('text/uri-list');
      const fallbackBase = uriList.split(/\r?\n/).find((line) => isHttpUrl(line.trim())) || (isHttpUrl(plain.trim()) ? plain.trim() : undefined);
      candidates.push(...extractImageCandidatesFromHtml(data.getData('text/html'), fallbackBase));
      uriList.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#')).forEach((url) => addImageUrlCandidate(candidates, url, undefined, true));
      candidates.push(...extractImageCandidatesFromText(plain));
      if (candidates.length === 0) return false;
      event.preventDefault();
      event.stopPropagation();
      const selectedCandidates = selectPureRefStyleCandidates(candidates);
      const result = await importImageCandidatesToProject(selectedCandidates, lastCanvasPointRef.current, settings.importLayoutDirection);
      if (result.nodeIds.length > 0) dispatchFocusNodeIds([result.nodeIds[0]]);
      setStatus(result.errors.length > 0 ? `粘贴完成 ${result.imported} 张，失败 ${result.errors.length} 张` : `已粘贴 ${result.imported} 张图片`);
      if (result.errors.length > 0) {
        alert(`粘贴部分图片失败：\n\n${result.errors.join('\n\n')}`);
      }
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    let inserted = 0;
    for (const file of files) {
      const dataUrl = await dataUrlFromBlob(file);
      await insertClipboardImageDataUrl(dataUrl, inserted);
      inserted += 1;
    }
    setStatus(`已从系统剪贴板粘贴 ${inserted} 张图片`);
    return true;
  };


  useEffect(() => {
    lastCanvasPointRef.current = lastCanvasPoint;
  }, [lastCanvasPoint]);

  useEffect(() => {
    if (!settingsOpen && settings.ai.provider !== 'ollama') return;
    void refreshOllamaModels();
  }, [settingsOpen, settings.ai.provider, settings.ai.apiUrl]);

  useEffect(() => {
    activeCanvasIdRef.current = activeCanvasId;
  }, [activeCanvasId]);

  // Do not continuously mirror the global project into the canvas list.
  // The active canvas is snapshotted explicitly when switching, creating, saving,
  // or deleting canvases. Mirroring in an effect can race with setActiveCanvasId
  // and overwrite inactive canvases, making multiple canvases save with the same content.

  useEffect(() => () => {
    if (canvasSwitchTimerRef.current) window.clearTimeout(canvasSwitchTimerRef.current);
  }, []);

  const switchCanvas = (canvasId: string) => {
    const target = canvases.find((canvas) => canvas.id === canvasId);
    if (!target || canvasId === activeCanvasId) return;
    closeMenu();
    setCanvasSwitching(true);
    setCanvases((current) => current.map((canvas) => (
      canvas.id === activeCanvasId ? { ...canvas, project: cloneProjectSnapshot(project) } : canvas
    )));
    setActiveCanvasId(canvasId);
    setProject(cloneProjectSnapshot(target.project));
    setStatus(`已切换到画布：${target.name}`);
    if (canvasSwitchTimerRef.current) window.clearTimeout(canvasSwitchTimerRef.current);
    canvasSwitchTimerRef.current = window.setTimeout(() => setCanvasSwitching(false), 320);
  };

  const createCanvas = () => {
    closeMenu();
    const name = `画布 ${canvases.length + 1}`;
    const id = crypto.randomUUID();
    const nextProject = createEmptyCanvasProject(name);
    setCanvases((current) => [
      ...current.map((canvas) => canvas.id === activeCanvasId ? { ...canvas, project: cloneProjectSnapshot(project) } : canvas),
      { id, name, project: nextProject }
    ]);
    setCanvasSwitching(true);
    setActiveCanvasId(id);
    setProject(nextProject);
    setEditingCanvasId(id);
    setEditingCanvasName(name);
    setStatus(`已新建并切换到画布：${name}`);
    if (canvasSwitchTimerRef.current) window.clearTimeout(canvasSwitchTimerRef.current);
    canvasSwitchTimerRef.current = window.setTimeout(() => setCanvasSwitching(false), 320);
  };

  const renameCanvas = (canvasId = activeCanvasId) => {
    closeMenu();
    const canvas = canvases.find((item) => item.id === canvasId);
    if (!canvas) return;
    setEditingCanvasId(canvasId);
    setEditingCanvasName(canvas.name);
  };

  const commitCanvasRename = (canvasId: string, nextName: string) => {
    const canvas = canvases.find((item) => item.id === canvasId);
    if (!canvas) {
      setEditingCanvasId(null);
      return;
    }
    const name = nextName.trim() || canvas.name;
    setCanvases((current) => current.map((item) => item.id === canvasId ? { ...item, name, project: { ...item.project, name } } : item));
    if (canvasId === activeCanvasId) {
      setProject({ ...project, name });
    }
    setEditingCanvasId(null);
    setEditingCanvasName('');
    setStatus(`画布已重命名：${name}`);
  };

  const requestDeleteCanvas = (canvasId = activeCanvasId) => {
    closeMenu();
    if (canvases.length <= 1) {
      alert('至少保留一个画布。');
      return;
    }
    const canvas = canvases.find((item) => item.id === canvasId);
    if (!canvas) return;
    setPendingCanvasDeletionId(canvasId);
  };

  const deleteCanvas = (canvasId: string) => {
    const canvas = canvases.find((item) => item.id === canvasId);
    if (!canvas || canvases.length <= 1) {
      setPendingCanvasDeletionId(null);
      return;
    }
    setPendingCanvasDeletionId(null);
    const remaining = canvases.filter((item) => item.id !== canvasId);
    setCanvases(remaining);
    if (canvasId === activeCanvasId) {
      const next = remaining[0];
      setActiveCanvasId(next.id);
      setProject(cloneProjectSnapshot(next.project));
      setStatus(`已删除画布并切换到：${next.name}`);
    } else {
      setStatus(`已删除画布：${canvas.name}`);
    }
  };

  const importFiles = async () => {
    closeMenu();
    const selected = await open({
      multiple: true,
      filters: [
        { name: '全部支持文件', extensions: [...imageExtensions, ...modelExtensions, ...videoExtensions, ...documentExtensions] },
        { name: '图片', extensions: imageExtensions },
        { name: '3D 模型', extensions: modelExtensions },
        { name: '视频', extensions: videoExtensions },
        { name: '文档 / 表格 / PDF', extensions: documentExtensions }
      ]
    });
    if (!selected) return;
    const files = Array.isArray(selected) ? selected : [selected];
    setStatus(`正在导入 ${files.length} 个文件...`);
    const wasEmptyCanvas = useProjectStore.getState().project.nodes.length === 0;
    const result = await importPathsToProject(files, lastCanvasPointRef.current, settings.importLayoutDirection);
    if (wasEmptyCanvas && result.nodeIds.length > 0) {
      dispatchFocusNodeIds([result.nodeIds[0]]);
    }
    const message = result.errors.length > 0
      ? `导入完成 ${result.imported} 个，失败 ${result.errors.length} 个`
      : `导入完成 ${result.imported} 个文件`;
    setStatus(message);
    if (result.errors.length > 0) {
      alert(`${message}：\n\n${result.errors.join('\n\n')}`);
    }
  };

  const saveWorkspaceToPath = async (path: string) => {
    const workspaceFile = createWorkspaceFile(canvases, activeCanvasId, project, workspaceCacheId);
    await saveProjectFile(path, workspaceFile);
    const savedCanvases = workspaceSnapshot(canvases, activeCanvasId, project);
    setCanvases(savedCanvases);
    setSavedWorkspaceSignature(workspaceContentSignature(savedCanvases, activeCanvasId, project));
    setStatus(`多画布工程已保存：${path}`);
    showProjectSavedNotice(path);
  };

  const saveProjectAs = async () => {
    closeMenu();
    const path = await save({ filters: [{ name: 'RefMind3D Project', extensions: ['refmind3d', 'refmind'] }] });
    if (!path) return false;
    await saveWorkspaceToPath(path);
    setCurrentProjectPath(path);
    return true;
  };

  const saveProject = async () => {
    closeMenu();
    if (!currentProjectPath) return saveProjectAs();
    await saveWorkspaceToPath(currentProjectPath);
    return true;
  };

  const loadProjectFromPath = async (path: string) => {
    const loaded = await loadProjectFile(path);
    if (isWorkspaceFile(loaded)) {
      setWorkspaceCacheId(loaded.cacheId || crypto.randomUUID());
      const loadedCanvases = loaded.canvases.length > 0 ? loaded.canvases : [{ id: 'main-canvas', name: '主画布', project: createEmptyCanvasProject('主画布') }];
      const nextActiveId = loadedCanvases.some((canvas) => canvas.id === loaded.activeCanvasId)
        ? loaded.activeCanvasId
        : loadedCanvases[0].id;
      const active = loadedCanvases.find((canvas) => canvas.id === nextActiveId) || loadedCanvases[0];
      setCanvases(loadedCanvases.map((canvas) => ({ ...canvas, project: cloneProjectSnapshot(canvas.project) })));
      setActiveCanvasId(nextActiveId);
      setProject(cloneProjectSnapshot(active.project));
      setSavedWorkspaceSignature(workspaceContentSignature(loadedCanvases, nextActiveId, useProjectStore.getState().project));
      setCurrentProjectPath(path);
      setStatus(`多画布工程已打开：${path}`);
      return;
    }

    setWorkspaceCacheId(loaded.cacheId || crypto.randomUUID());
    const legacyCanvas = { id: 'main-canvas', name: loaded.name || '主画布', project: loaded };
    setCanvases([legacyCanvas]);
    setActiveCanvasId(legacyCanvas.id);
    setProject(loaded);
    setSavedWorkspaceSignature(workspaceContentSignature([legacyCanvas], legacyCanvas.id, useProjectStore.getState().project));
    setCurrentProjectPath(path);
    setStatus(`旧版单画布工程已打开：${path}`);
  };

  const loadProjectFromDataUrl = async (dataUrl: string, name: string) => {
    const loaded = await loadProjectDataUrl(dataUrl, name);
    if (isWorkspaceFile(loaded)) {
      setWorkspaceCacheId(loaded.cacheId || crypto.randomUUID());
      const loadedCanvases = loaded.canvases.length > 0 ? loaded.canvases : [{ id: 'main-canvas', name: '主画布', project: createEmptyCanvasProject('主画布') }];
      const nextActiveId = loadedCanvases.some((canvas) => canvas.id === loaded.activeCanvasId)
        ? loaded.activeCanvasId
        : loadedCanvases[0].id;
      const active = loadedCanvases.find((canvas) => canvas.id === nextActiveId) || loadedCanvases[0];
      setCanvases(loadedCanvases.map((canvas) => ({ ...canvas, project: cloneProjectSnapshot(canvas.project) })));
      setActiveCanvasId(nextActiveId);
      setProject(cloneProjectSnapshot(active.project));
      setSavedWorkspaceSignature(workspaceContentSignature(loadedCanvases, nextActiveId, useProjectStore.getState().project));
      setCurrentProjectPath(null);
      setStatus(`已打开拖入工程：${name}`);
      return;
    }

    setWorkspaceCacheId(loaded.cacheId || crypto.randomUUID());
    const legacyCanvas = { id: 'main-canvas', name: loaded.name || '主画布', project: loaded };
    setCanvases([legacyCanvas]);
    setActiveCanvasId(legacyCanvas.id);
    setProject(loaded);
    setSavedWorkspaceSignature(workspaceContentSignature([legacyCanvas], legacyCanvas.id, useProjectStore.getState().project));
    setCurrentProjectPath(null);
    setStatus(`已打开拖入工程：${name}`);
  };

  const loadProject = async () => {
    closeMenu();
    const path = await open({ filters: [{ name: 'RefMind3D Project', extensions: ['refmind3d', 'refmind'] }] });
    if (!path || Array.isArray(path)) return;
    await loadProjectFromPath(path);
  };

  useEffect(() => {
    if (launchProjectHandledRef.current) return;
    void invoke<string | null>('get_launch_project_path').then((path) => {
      if (!path || launchProjectHandledRef.current) return;
      launchProjectHandledRef.current = true;
      return loadProjectFromPath(path).catch((error) => {
        setStatus('工程文件打开失败');
        alert(`工程文件打开失败：${String(error)}`);
      });
    }).catch(() => {
      // Starting without a project path is the normal application launch path.
    });
  }, []);

  const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'exported_asset';

  const assetSourcePath = (asset: { projectAssetPath?: string; originalPath?: string }) => asset.projectAssetPath || asset.originalPath || '';
  const exportAssetOriginal = async (asset: { embeddedDataUrl?: string; projectAssetPath?: string; originalPath?: string }, outputPath: string) => {
    if (asset.embeddedDataUrl) {
      await invoke('save_data_url_to_path', { path: outputPath, dataUrl: asset.embeddedDataUrl });
      return;
    }
    const sourcePath = assetSourcePath(asset);
    if (!sourcePath) throw new Error('未找到原始资源数据');
    await invoke('copy_file_to_path', { sourcePath, outputPath });
  };

  const desktopExportPath = async (name: string, extension: string) => {
    const normalizedExt = (extension || 'dat').replace(/^\./, '').toLowerCase();
    const cleaned = safeFileName(name || `RefMind3D_Export.${normalizedExt}`);
    const stem = cleaned.replace(/\.[^.]+$/, '') || 'RefMind3D_Export';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return join(await desktopDir(), `${stem}_${stamp}.${normalizedExt}`);
  };

  const exportSelectedAsPngToDesktop = async (label = 'RefMind3D_Selected') => {
    const outputPath = await desktopExportPath(label, 'png');
    await exportSelectedNodesToPng(project, selectedNodeIds, outputPath);
    return outputPath;
  };

  const exportSelectedAsPng = async () => {
    closeMenu();
    if (selectedNodeIds.length === 0) {
      alert('请先选中要导出的图片、文本、文档、表格、PDF、模型或组。');
      return;
    }
    const selectedNames = project.nodes
      .filter((node) => selectedNodeIds.includes(node.id))
      .map((node) => node.title || node.type);
    const baseName = selectedNames.length === 1
      ? safeFileName(selectedNames[0]).replace(/\.[^.]+$/, '')
      : `RefMind3D_Selected_${selectedNames.length}`;
    const path = await save({
      defaultPath: `${baseName || 'RefMind3D_Selected'}.png`,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    });
    if (!path) return;
    setStatus('正在导出选中内容 PNG...');
    try {
      await exportSelectedNodesToPng(project, selectedNodeIds, path);
      setStatus(`选中内容已导出 PNG：${path}`);
    } catch (error) {
      setStatus('导出 PNG 失败');
      alert(`导出选中内容 PNG 失败：${String(error)}`);
    }
  };

  const editableDocumentExportContent = (node: CanvasNode, asset: { contentHtml?: string; extractedText?: string }, format: string) => {
    if (format.toLowerCase() === 'xlsx' && node.spreadsheetData) {
      return JSON.stringify(node.spreadsheetData);
    }
    return node.richTextHtml || node.text || asset.contentHtml || asset.extractedText || '';
  };

  const exportSelectedOriginalFormat = async () => {
    closeMenu();
    if (selectedNodeIds.length === 0) {
      alert('请先选中要导出的对象。');
      return;
    }

    const selectedNodes = project.nodes.filter((node) => selectedNodeIds.includes(node.id));
    const assetNodes = selectedNodes
      .map((node) => ({ node, asset: node.assetId ? project.assets.find((asset) => asset.id === node.assetId) : undefined }))
      .filter((item): item is { node: typeof selectedNodes[number]; asset: NonNullable<typeof item.asset> } => Boolean(item.asset));

    try {
      setStatus('正在导出到桌面...');
      if (selectedNodes.length === 1) {
        const node = selectedNodes[0];
        const asset = node.assetId ? project.assets.find((item) => item.id === node.assetId) : undefined;

        if (!asset && ['note', 'mindmap'].includes(node.type)) {
          const path = await desktopExportPath(node.title || '文本', 'txt');
          await exportEditableDocumentAsset('txt', node.text || '', path);
          setStatus(`文本已导出到桌面：${path}`);
          return;
        }

        if (!asset && node.type === 'group') {
          const path = await exportSelectedAsPngToDesktop(node.title || '组');
          setStatus(`组已导出到桌面 PNG：${path}`);
          return;
        }

        if (!asset) {
          const path = await exportSelectedAsPngToDesktop(node.title || 'RefMind3D_Selected');
          setStatus(`选中对象已导出到桌面 PNG：${path}`);
          return;
        }

        const format = (asset.format || 'dat').toLowerCase();
        const defaultName = safeFileName(asset.name || `${node.title || 'asset'}.${format}`);
        const path = await desktopExportPath(defaultName, format);
        if (['table', 'document'].includes(asset.kind) && ['txt', 'md', 'csv', 'tsv', 'xls', 'xlsx', 'docx'].includes(format)) {
          await exportEditableDocumentAsset(format, editableDocumentExportContent(node, asset, format), path);
        } else {
          await exportAssetOriginal(asset, path);
        }
        setStatus(`已按原格式导出到桌面：${path}`);
        return;
      }

      if (assetNodes.length === 0) {
        const path = await exportSelectedAsPngToDesktop(`RefMind3D_Selected_${selectedNodes.length}`);
        setStatus(`多选内容已导出到桌面 PNG：${path}`);
        return;
      }

      let exported = 0;
      for (const { node, asset } of assetNodes) {
        const format = (asset.format || 'dat').toLowerCase();
        const path = await desktopExportPath(asset.name || node.title || `asset.${format}`, format);
        if (['table', 'document'].includes(asset.kind) && ['txt', 'md', 'csv', 'tsv', 'xls', 'xlsx', 'docx'].includes(format)) {
          await exportEditableDocumentAsset(format, editableDocumentExportContent(node, asset, format), path);
        } else {
          await exportAssetOriginal(asset, path);
        }
        exported += 1;
      }
      setStatus(`已按原格式导出 ${exported} 个文件到桌面`);
    } catch (error) {
      setStatus('按原格式导出失败');
      alert(`按原格式导出失败：${String(error)}`);
    }
  };

  const exportCanvasImage = async () => {
    closeMenu();
    const path = await save({
      defaultPath: 'RefMind3D_Canvas.png',
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    });
    if (!path) return;
    setStatus('正在导出整张画布 PNG...');
    try {
      await exportProjectToPng(project, path);
      setStatus(`整张画布已导出：${path}`);
    } catch (error) {
      setStatus('导出失败');
      alert(`导出整张画布失败：${String(error)}`);
    }
  };


  const exportSelectedDocument = async () => {
    closeMenu();
    const node = project.nodes.find((item) => selectedNodeIds.includes(item.id) && ['document', 'table', 'pdf'].includes(item.type));
    if (!node?.assetId) {
      alert('请先选中一个文档、表格或 PDF 节点。');
      return;
    }
    const asset = project.assets.find((item) => item.id === node.assetId);
    if (!asset) {
      alert('未找到对应资源。');
      return;
    }
    const format = asset.format || 'txt';
    const extension = format.toLowerCase();
    const defaultPath = asset.name.replace(/\.[^.]+$/, '') + `_edited.${extension}`;
    const path = await save({
      defaultPath,
      filters: [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }]
    });
    if (!path) return;
    setStatus(`正在导出 ${extension.toUpperCase()}...`);
    try {
      await exportEditableDocumentAsset(extension, editableDocumentExportContent(node, asset, extension), path);
      setStatus(`已按当前编辑内容导出：${path}`);
    } catch (error) {
      setStatus('文档导出失败');
      alert(`文档/表格导出失败：${String(error)}`);
    }
  };

  const deleteNodes = () => {
    closeMenu();
    deleteSelected();
    setStatus('已删除选中节点');
  };

  const selectedAIContext = () => {
    const selectedNodes = project.nodes.filter((node) => selectedNodeIds.includes(node.id));
    const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
    const targetNodes = selectedNodes.length > 0 ? selectedNodes : project.nodes.slice(0, 20);
    const header = selectedNodes.length > 0
      ? `选中对象数量：${selectedNodes.length}`
      : `当前未选中对象，提供画布前 ${targetNodes.length} 个对象作为上下文`;
    const lines = targetNodes.map((node, index) => {
      const asset = node.assetId ? assetsById.get(node.assetId) : undefined;
      const assetText = asset
        ? [
            `资源名=${asset.name}`,
            `类型=${asset.kind}`,
            `格式=${asset.format}`,
            `大小=${Math.round((asset.fileSize || 0) / 1024)}KB`
          ].join('，')
        : '无资源文件';
      const text = (node.text || '').trim();
      const clippedText = text.length > 800 ? `${text.slice(0, 800)}……` : text;
      return [
        `${index + 1}. 节点标题：${node.title || node.type}`,
        `节点类型：${node.type}`,
        `位置尺寸：x=${Math.round(node.x)}, y=${Math.round(node.y)}, w=${Math.round(node.width)}, h=${Math.round(node.height)}`,
        `资源信息：${assetText}`,
        clippedText ? `节点文字：${clippedText}` : ''
      ].filter(Boolean).join('\n');
    });
    return [header, ...lines].join('\n\n');
  };

  const selectedAIImageAssets = () => {
    const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
    return project.nodes
      .filter((node) => selectedNodeIds.includes(node.id))
      .map((node) => node.assetId ? assetsById.get(node.assetId) : undefined)
      .filter((asset): asset is AssetRecord => asset?.kind === 'image')
      .slice(0, 4);
  };

  const selectedAIImageCandidateCount = () => selectedAIImageAssets().length;

  const imageAssetToDataUrl = async (asset: AssetRecord) => {
    return invoke<string>('image_asset_to_data_url', { asset });
  };

  const copySelectedImageToSystemClipboard = async () => {
    const selectedImageNodes = project.nodes
      .filter((node) => selectedNodeIds.includes(node.id) && node.type === 'image' && node.assetId)
      .sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0));
    const asset = selectedImageNodes[0]?.assetId
      ? project.assets.find((item) => item.id === selectedImageNodes[0].assetId && item.kind === 'image')
      : undefined;
    if (!asset) {
      setStatus('请先选中一张画布图片');
      return false;
    }
    try {
      await invoke('copy_image_asset_to_clipboard', { asset });
      setStatus(`已复制图片到系统剪贴板：${asset.name}`);
      return true;
    } catch (error) {
      setStatus('复制图片到系统剪贴板失败');
      alert(`复制图片失败：${String(error)}`);
      return false;
    }
  };

  const selectedAIImageDataUrls = async () => {
    const dataUrls: string[] = [];
    for (const asset of selectedAIImageAssets()) {
      try {
        const dataUrl = await imageAssetToDataUrl(asset);
        if (dataUrl.startsWith('data:image/')) {
          dataUrls.push(dataUrl);
        }
      } catch (error) {
        console.warn('Failed to prepare selected image for AI', asset.name, error);
      }
    }
    return dataUrls;
  };

  const selectedAIReferenceNode = () => {
    const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
    return project.nodes.find((node) => {
      if (!selectedNodeIds.includes(node.id) || !node.assetId) return false;
      const asset = assetsById.get(node.assetId);
      return asset?.kind === 'image';
    });
  };

  const isImageGenerationPrompt = (prompt: string) => {
    const normalized = prompt.replace(/\s+/g, '').toLowerCase();
    return [
      '生成', '生成图片', '生成图', '生成一张', '生成一个', '出图', '画一张', '做一张图', '给我一张图',
      '重新生成', '生成另一张', '以图生图', '左视图', '右视图', '背视图', '前视图', '顶视图',
      '设计变体', '改成图片', '生成参考图',
      'generateimage', 'createimage', 'makeanimage', 'renderimage', 'imagegeneration'
    ].some((keyword) => normalized.includes(keyword));
  };

  const isAnalysisOllamaEndpoint = () => {
    const endpoint = settings.ai.apiUrl.toLowerCase();
    return settings.ai.provider === 'ollama' || endpoint.includes('localhost:11434') || endpoint.includes('127.0.0.1:11434') || endpoint.includes('0.0.0.0:11434') || endpoint.includes('localhost:11435') || endpoint.includes('127.0.0.1:11435');
  };

  const buildVisionGuidedImagePrompt = async (userPrompt: string, referenceImageDataUrl: string) => {
    const instruction = [
      'Analyze the selected reference image carefully, then rewrite the user request as a production-ready English prompt for an image generation model.',
      'The prompt must preserve the main object identity, proportions, material, construction, color palette, decorative details, and visual style from the reference image.',
      'If the user asks for a new view or angle, describe that target view clearly while keeping the same object design.',
      'Do not invent a different object, person, fabric scene, or background unless the user explicitly asks for it.',
      'Return only the final English image prompt. No markdown, no explanation.',
      '',
      `User request: ${userPrompt}`
    ].join('\n');
    const response = await invoke<string>('ai_chat', {
      apiUrl: settings.ai.apiUrl,
      apiKey: settings.ai.apiKey,
      model: settings.ai.model,
      systemPrompt: 'You are a visual reference interpreter for RefMind3D. Convert reference images and user requirements into concise, accurate English prompts for image generation.',
      userMessage: instruction,
      context: selectedAIContext(),
      imageDataUrls: [referenceImageDataUrl]
    });
    const cleaned = response
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-zA-Z]*|```/g, '').trim())
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim();
    return cleaned || userPrompt;
  };

  const selectedVisionModel = () => AI_VISION_MODELS.find((model) => model.id === settings.ai.localVisionModelId) || AI_VISION_MODELS[0];
  const isOllamaModelInstalled = (model: AiModelManifest) => Boolean(model.ollamaModelName && localOllamaModels.includes(model.ollamaModelName));

  const refreshOllamaModels = async () => {
    try {
      const status = await invoke<LocalAIRuntimeStatus>('ai_local_runtime_status', { apiUrl: settings.ai.apiUrl || 'http://localhost:11434/v1' });
      const models = status.ollamaModels || [];
      setLocalOllamaModels(models);
      const installedVisionIds = AI_VISION_MODELS
        .filter((model) => model.ollamaModelName && models.includes(model.ollamaModelName))
        .map((model) => model.id);
      const merged = Array.from(new Set([...settings.ai.installedModelIds, ...installedVisionIds]));
      const patch: Partial<AISettings> = {};
      if (merged.length !== settings.ai.installedModelIds.length) {
        patch.installedModelIds = merged;
      }
      if (Object.keys(patch).length > 0) {
        updateAISettings(patch);
      }
    } catch {
      setLocalOllamaModels([]);
    }
  };

  const installVisionModel = async (model: AiModelManifest) => {
    if (!model.ollamaModelName) return;
    setModelInstallBusy(model.id);
    setStatus(`正在安装本地视觉模型：${model.displayName}`);
    try {
      await invoke<string>('ai_pull_ollama_model', {
        apiUrl: settings.ai.apiUrl || 'http://localhost:11434/v1',
        model: model.ollamaModelName
      });
      const nextInstalled = Array.from(new Set([...settings.ai.installedModelIds, model.id]));
      updateAISettings({
        provider: 'ollama',
        apiUrl: 'http://localhost:11434/v1',
        model: model.ollamaModelName,
        localVisionModelId: model.id,
        installedModelIds: nextInstalled
      });
      await refreshOllamaModels();
      setStatus(`本地视觉模型已安装：${model.displayName}`);
    } catch (error) {
      alert(`安装本地视觉模型失败：\n${String(error)}\n\n请确认 Ollama 已安装并正在运行。`);
      setStatus('本地视觉模型安装失败');
    } finally {
      setModelInstallBusy('');
    }
  };

  const selectVisionModel = (model: AiModelManifest) => {
    updateAISettings({
      provider: 'ollama',
      apiUrl: 'http://localhost:11434/v1',
      model: model.ollamaModelName || settings.ai.model,
      localVisionModelId: model.id
    });
  };

  const imageProviderLabel = () => settings.ai.imageProvider === 'doubao-images'
      ? '豆包图片接口'
      : 'OpenAI 图片接口';

  const calculateGeneratedImagePosition = (sourceNode: { x: number; y: number; width: number; height: number } | undefined, width: number, height: number) => {
    if (!sourceNode) {
      return { x: Math.round(lastCanvasPointRef.current.x + 24), y: Math.round(lastCanvasPointRef.current.y + 24) };
    }
    const gap = 120;
    if (settings.ai.imageInsertMode === 'bottom') {
      return { x: Math.round(sourceNode.x), y: Math.round(sourceNode.y + sourceNode.height + gap) };
    }
    if (settings.ai.imageInsertMode === 'auto') {
      const rightX = Math.round(sourceNode.x + sourceNode.width + gap);
      const rightY = Math.round(sourceNode.y);
      const hasCollision = useProjectStore.getState().project.nodes.some((node) =>
        Math.abs(node.x - rightX) < Math.max(120, width * 0.4) && Math.abs(node.y - rightY) < Math.max(120, height * 0.4)
      );
      if (hasCollision) {
        return { x: Math.round(sourceNode.x), y: Math.round(sourceNode.y + sourceNode.height + gap) };
      }
      return { x: rightX, y: rightY };
    }
    return { x: Math.round(sourceNode.x + sourceNode.width + gap), y: Math.round(sourceNode.y) };
  };

  const insertAIGeneratedImageOnCanvas = async (dataUrl: string, sourceNodeId?: string) => {
    const state = useProjectStore.getState();
    const asset = await importClipboardImageDataUrl(dataUrl);
    const nodeId = crypto.randomUUID();
    const sourceNode = sourceNodeId ? state.project.nodes.find((node) => node.id === sourceNodeId) : undefined;
    const position = calculateGeneratedImagePosition(sourceNode, Math.max(24, asset.width), Math.max(24, asset.height));
    state.addAssetsAndNodes([asset], [{
      id: nodeId,
      type: 'image',
      assetId: asset.id,
      title: `${sourceNode ? sourceNode.title || '参考图' : 'AI'}_AI生成`,
      x: position.x,
      y: position.y,
      width: Math.max(24, asset.width),
      height: Math.max(24, asset.height),
      rotation: 0,
      zIndex: nextZIndex()
    }]);
    if (sourceNode) {
      useProjectStore.getState().createMindLink(sourceNode.id, nodeId);
    }
    dispatchFocusNodeIds([nodeId]);
    setAiResponse(sourceNode ? 'AI 图片已生成，并作为当前画布中的新节点插入，且已与原参考图建立牵引线连接。' : 'AI 图片已生成，并作为当前画布中的新节点插入。');
    setStatus('AI 生成图片已插入当前画布');
  };


  const clampAIDockTop = (nextTop: number) => {
    const dockHeight = aiDockRef.current?.offsetHeight ?? 520;
    const maxTop = Math.max(8, window.innerHeight - dockHeight - 8);
    return Math.min(Math.max(8, nextTop), maxTop);
  };

  const startAIDockDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    aiDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTop: aiDockTop
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!aiDragRef.current) return;
      const deltaY = event.clientY - aiDragRef.current.startY;
      setAiDockTop(clampAIDockTop(aiDragRef.current.startTop + deltaY));
    };
    const stopDrag = () => {
      aiDragRef.current = null;
    };
    const onResize = () => setAiDockTop((current) => clampAIDockTop(current));
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const generateAIImageToCanvas = async (overridePrompt?: string) => {
    const prompt = (overridePrompt ?? aiPrompt).trim();
    if (!prompt) {
      setAiError('请输入生成图片的提示词。');
      return;
    }
    if (!settings.ai.imageApiUrl.trim() || !settings.ai.imageModel.trim()) {
      setAiError('未配置图片生成接口。请到 右键 → 设置 → AI 接口 → 图片生成设置，选择 OpenAI 图片接口或豆包图片接口，并填写 API 地址、API Key、模型名称。');
      setStatus('图片生成接口未配置');
      return;
    }
    if (isLocalImageModelName(settings.ai.imageModel)) {
      setAiError('当前图片模型名称是旧的本地模型，不适用于 API Key 模式。请填写你的 API 服务商支持的图片模型名称，例如 gpt-image-1，或服务商文档中给出的模型名。');
      setStatus('图片模型名称不适用于 API');
      return;
    }
    setAiBusy(true);
    setAiError('');
    setAiResponse('');
    setStatus(`AI 正在通过${imageProviderLabel()}生成图片...`);
    const sourceNode = selectedAIReferenceNode();
    const sourceAsset = sourceNode?.assetId
      ? project.assets.find((asset) => asset.id === sourceNode.assetId && asset.kind === 'image')
      : undefined;
    const referenceImageDataUrl = sourceAsset ? await imageAssetToDataUrl(sourceAsset).catch(() => null) : null;
    let generationPrompt = prompt;
    if (false) {
      try {
        setStatus('AI 正在先理解参考图，并整理生图提示词...');
        generationPrompt = await buildVisionGuidedImagePrompt(prompt, referenceImageDataUrl || '');
      } catch (error) {
        console.warn('Vision-guided prompt generation failed, falling back to the original prompt.', error);
        generationPrompt = prompt;
      }
      setStatus(`AI 正在通过${imageProviderLabel()}按参考图生成图片...`);
    }
    try {
      const imageProvider = settings.ai.imageProvider === 'doubao-images' ? 'doubao-images' : 'openai-images';
      const imageDataUrl = await invoke<string>('ai_generate_image', {
        provider: imageProvider,
        apiUrl: settings.ai.imageApiUrl,
        apiKey: settings.ai.imageApiKey || settings.ai.apiKey,
        model: settings.ai.imageModel,
        prompt: generationPrompt,
        referenceImageDataUrl,
        size: settings.ai.imageSize,
        quality: settings.ai.imageQuality
      });
      await insertAIGeneratedImageOnCanvas(imageDataUrl, sourceNode?.id);
    } catch (error) {
      const message = String(error);
      setAiError(message);
      setStatus('AI 生成图片失败');
    } finally {
      setAiBusy(false);
    }
  };

  const callAI = async (overridePrompt?: string) => {
    const prompt = (overridePrompt ?? aiPrompt).trim();
    if (!prompt) {
      setAiError('请输入要问 AI 的内容。');
      return;
    }
    if (settings.ai.provider !== 'ollama' && isLocalVisionModelName(settings.ai.model)) {
      setAiError('当前分析模型名称是本地 Ollama 模型，不适用于 API Key 模式。请填写你的 API 服务商支持的对话/视觉模型名称。');
      setStatus('分析模型名称不适用于 API');
      return;
    }
    setAiBusy(true);
    setAiError('');
    setStatus('AI 正在分析...');
    try {
      const imageDataUrls = await selectedAIImageDataUrls();
      const response = await invoke<string>('ai_chat', {
        apiUrl: settings.ai.apiUrl,
        apiKey: settings.ai.apiKey,
        model: settings.ai.model,
        systemPrompt: settings.ai.systemPrompt,
        userMessage: prompt,
        context: selectedAIContext(),
        imageDataUrls
      });
      setAiResponse(response);
      setStatus('AI 已返回结果');
    } catch (error) {
      const message = String(error);
      setAiError(message);
      setStatus('AI 请求失败');
    } finally {
      setAiBusy(false);
    }
  };

  const testAIConnection = async () => {
    await callAI('请用一句话回复：RefMind3D AI 接口连接成功。');
  };

  const insertAIResponseAsTextNode = () => {
    if (!aiResponse.trim()) {
      setAiError('没有可写入画布的 AI 结果。');
      return;
    }
    const id = createTextNode(lastCanvasPoint.x, lastCanvasPoint.y, false);
    updateNode(id, {
      title: 'AI 分析结果',
      text: aiResponse,
      width: 520,
      height: 280
    }, true);
    setStatus('AI 结果已生成文本节点');
  };

  const insertAIResponseAsMindMap = () => {
    if (!aiResponse.trim()) {
      setAiError('没有可写入画布的 AI 结果。');
      return;
    }
    const lines = aiResponse
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*#\d.\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 8);
    const text = lines.length > 0 ? lines.map((line) => `- ${line}`).join('\n') : aiResponse;
    const id = createTextNode(lastCanvasPoint.x, lastCanvasPoint.y, false);
    updateNode(id, {
      title: 'AI 思维导图草稿',
      text,
      width: 440,
      height: 240
    }, true);
    setStatus('AI 结果已生成思维导图草稿节点');
  };

  const showHelp = () => {
    closeMenu();
    alert([
      'RefMind3D v2 快捷键',
      '',
      `${settings.shortcuts.text}：创建文本，创建后可直接输入；单击选择/拖动，双击编辑`,
      `${settings.shortcuts.group}：把选中图片/节点打组`,
      `${settings.shortcuts.copy} / ${settings.shortcuts.paste}：复制 / 粘贴`,
      `${settings.shortcuts.delete}：删除选中节点`,
      `${settings.shortcuts.undo} / ${settings.shortcuts.redo}：撤销 / 重做`,
      `${settings.shortcuts.save} / ${settings.shortcuts.open}：保存 / 打开工程`,
      `${settings.shortcuts.exportImage}：按原格式导出选中对象到桌面`,
      `${settings.shortcuts.mindChild}：从图片/文本/模型/文档等节点拖出牵引线；拖到空白处创建子对象，拖到已有节点上创建连接`,
      '点击牵引线可选中，按 Delete 删除牵引线',
      '鼠标中键或 Alt+左键拖拽：平移画布',
      '滚轮：缩放画布',
      '空白处拖拽：框选多个节点',
      '导入文档/表格/PDF 后，双击节点可编辑画布上的内容层',
      '选中图片后会自动置于最前面',
      '',
      '所有快捷键可在 右键 → 设置 → 快捷键 中修改。'
    ].join('\n'));
  };

  const createText = (x = lastCanvasPoint.x, y = lastCanvasPoint.y) => {
    closeMenu();
    const id = createTextNode(x, y, true);
    dispatchEditNode(id);
    setStatus('已创建文本节点：可直接输入，单击拖动，双击编辑');
  };

  const toggleDraw = () => {
    closeMenu();
    setDrawMode((current) => {
      const next = !current;
      if (next) setDoodleMode(false);
      setStatus(next ? '绘制模式已开启：在画布拖拽可绘制框' : '绘制模式已关闭');
      return next;
    });
  };

  const toggleDoodle = () => {
    closeMenu();
    setDoodleMode((current) => {
      const next = !current;
      if (next) setDrawMode(false);
      setStatus(next ? '涂鸦模式已开启：画笔会始终显示在所有画布内容上方' : '涂鸦模式已关闭');
      return next;
    });
  };

  const createGroup = () => {
    closeMenu();
    groupSelected();
    setStatus('已创建组：可在属性面板调整颜色和大小');
  };

  const ungroupCurrentSelection = () => {
    closeMenu();
    ungroupSelected();
    setStatus('已解除分组');
  };

  const toggleCurrentGroupLock = () => {
    const groups = project.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.type === 'group' && node.isGroupContainer !== false);
    if (groups.length === 0) {
      setStatus('请先选中一个组');
      return;
    }
    const willUnlock = groups.every((group) => group.groupLocked !== false);
    toggleSelectedGroupLock();
    setStatus(willUnlock ? '已解锁组，可直接编辑组内对象' : '已锁定组，单击会选择整组');
  };

  const selectedLayoutNodes = () => project.nodes.filter((node) => selectedNodeIds.includes(node.id));

  const applyLayoutUpdates = (updates: Array<{ id: string; patch: Partial<CanvasNode> }>, message: string) => {
    if (updates.length === 0) {
      setStatus('请先选中要整理的对象');
      closeMenu();
      return;
    }
    updateNodes(updates, true);
    setStatus(message);
    closeMenu();
  };

  const arrangeSelectedLine = (axis: 'horizontal' | 'vertical') => {
    const nodes = visualOrder(selectedLayoutNodes());
    if (nodes.length < 2) {
      setStatus('请至少选中两个对象');
      closeMenu();
      return;
    }
    const bounds = boundsForNodes(nodes);
    const gap = 24;
    let cursor = axis === 'horizontal' ? bounds.left : bounds.top;
    const updates = nodes.map((node) => {
      const patch = axis === 'horizontal'
        ? { x: Math.round(cursor), y: Math.round(bounds.top) }
        : { x: Math.round(bounds.left), y: Math.round(cursor) };
      cursor += (axis === 'horizontal' ? node.width : node.height) + gap;
      return { id: node.id, patch };
    });
    applyLayoutUpdates(updates, axis === 'horizontal' ? '已横向排列选中对象' : '已纵向排列选中对象');
  };

  const arrangeSelectedGrid = () => {
    const nodes = visualOrder(selectedLayoutNodes());
    if (nodes.length < 2) {
      setStatus('请至少选中两个对象');
      closeMenu();
      return;
    }
    const bounds = boundsForNodes(nodes);
    const columns = Math.ceil(Math.sqrt(nodes.length));
    const gap = 24;
    const cellWidth = Math.max(...nodes.map((node) => node.width)) + gap;
    const cellHeight = Math.max(...nodes.map((node) => node.height)) + gap;
    const updates = nodes.map((node, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      return {
        id: node.id,
        patch: {
          x: Math.round(bounds.left + col * cellWidth),
          y: Math.round(bounds.top + row * cellHeight)
        }
      };
    });
    applyLayoutUpdates(updates, '已整理为网格');
  };

  const alignSelected = (mode: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom') => {
    const nodes = selectedLayoutNodes();
    if (nodes.length < 2) {
      setStatus('请至少选中两个对象');
      closeMenu();
      return;
    }
    const bounds = boundsForNodes(nodes);
    const updates = nodes.map((node) => {
      let patch: Partial<CanvasNode> = {};
      if (mode === 'left') patch = { x: Math.round(bounds.left) };
      if (mode === 'centerX') patch = { x: Math.round(bounds.centerX - node.width / 2) };
      if (mode === 'right') patch = { x: Math.round(bounds.right - node.width) };
      if (mode === 'top') patch = { y: Math.round(bounds.top) };
      if (mode === 'centerY') patch = { y: Math.round(bounds.centerY - node.height / 2) };
      if (mode === 'bottom') patch = { y: Math.round(bounds.bottom - node.height) };
      return { id: node.id, patch };
    });
    applyLayoutUpdates(updates, '已对齐选中对象');
  };

  const distributeSelected = (axis: 'horizontal' | 'vertical') => {
    const nodes = selectedLayoutNodes()
      .slice()
      .sort((a, b) => axis === 'horizontal' ? a.x - b.x : a.y - b.y);
    if (nodes.length < 3) {
      setStatus('请至少选中三个对象');
      closeMenu();
      return;
    }
    const bounds = boundsForNodes(nodes);
    const totalSize = nodes.reduce((sum, node) => sum + (axis === 'horizontal' ? node.width : node.height), 0);
    const span = axis === 'horizontal' ? bounds.width : bounds.height;
    const gap = Math.max(12, (span - totalSize) / Math.max(1, nodes.length - 1));
    let cursor = axis === 'horizontal' ? bounds.left : bounds.top;
    const updates = nodes.map((node) => {
      const patch = axis === 'horizontal'
        ? { x: Math.round(cursor) }
        : { y: Math.round(cursor) };
      cursor += (axis === 'horizontal' ? node.width : node.height) + gap;
      return { id: node.id, patch };
    });
    applyLayoutUpdates(updates, axis === 'horizontal' ? '已水平均匀分布' : '已垂直均匀分布');
  };

  const matchSelectedSize = (mode: 'width' | 'height' | 'both') => {
    const nodes = selectedLayoutNodes();
    if (nodes.length < 2) {
      setStatus('请至少选中两个对象');
      closeMenu();
      return;
    }
    const anchor = nodes.find((node) => node.id === selectedNodeIds[0]) || nodes[0];
    const updates = nodes.filter((node) => node.id !== anchor.id).map((node) => {
      const centerX = node.x + node.width / 2;
      const centerY = node.y + node.height / 2;
      const width = mode === 'height' ? node.width : anchor.width;
      const height = mode === 'width' ? node.height : anchor.height;
      return {
        id: node.id,
        patch: {
          x: Math.round(centerX - width / 2),
          y: Math.round(centerY - height / 2),
          width: Math.max(18, Math.round(width)),
          height: Math.max(18, Math.round(height))
        }
      };
    });
    applyLayoutUpdates(updates, mode === 'both' ? '已匹配首个对象尺寸' : (mode === 'width' ? '已匹配首个对象宽度' : '已匹配首个对象高度'));
  };

  const scaleSelected = (factor: number) => {
    const nodes = selectedLayoutNodes();
    if (nodes.length === 0) {
      setStatus('请先选中要缩放的对象');
      closeMenu();
      return;
    }
    const updates = nodes.map((node) => {
      const centerX = node.x + node.width / 2;
      const centerY = node.y + node.height / 2;
      const width = Math.max(18, Math.round(node.width * factor));
      const height = Math.max(18, Math.round(node.height * factor));
      return {
        id: node.id,
        patch: {
          x: Math.round(centerX - width / 2),
          y: Math.round(centerY - height / 2),
          width,
          height
        }
      };
    });
    applyLayoutUpdates(updates, factor < 1 ? '已缩小选中对象' : '已放大选中对象');
  };

  const openSelectedModelPreview = () => {
    const modelNode = project.nodes.find((node) => selectedNodeIds.includes(node.id) && node.type === 'model' && node.assetId);
    if (!modelNode?.assetId) {
      setStatus('请先选中一个 3D 模型节点');
      closeMenu();
      return;
    }
    const asset = project.assets.find((item) => item.id === modelNode.assetId && item.kind === 'model') as ImportedModel | undefined;
    if (!asset) {
      setStatus('未找到模型资源');
      closeMenu();
      return;
    }
    setModelPreview(asset);
    setStatus(`正在预览 3D 模型：${asset.name}`);
    closeMenu();
  };

  const focusImportedObjects = () => {
    closeMenu();
    window.dispatchEvent(new CustomEvent('refmind3d-focus-selection'));
    setStatus(selectedNodeIds.length > 0 ? '已定位并拉近选中对象' : '已定位全部导入对象');
  };

  const resetView = () => {
    closeMenu();
    window.dispatchEvent(new Event('refmind3d-reset-view'));
    setStatus('画布视图已重置');
  };

  const makeNewScene = () => {
    closeMenu();
    if (confirm('确定新建场景吗？当前未保存内容可能丢失。')) {
      const blank = createEmptyCanvasProject('主画布');
      setCanvases([{ id: 'main-canvas', name: '主画布', project: blank }]);
      setActiveCanvasId('main-canvas');
      setProject(blank);
      setWorkspaceCacheId(crypto.randomUUID());
      setCurrentProjectPath(null);
      setStatus('已新建场景');
    }
  };

  const forceCloseWindow = () => {
    setClosePromptMode(null);
    void invoke('force_close_window').catch((error) => {
      setClosePromptMode(hasUnsavedChangesRef.current ? 'unsaved' : 'confirm');
      setCloseSaveBusy(false);
      setStatus('关闭窗口失败');
      alert(`关闭窗口失败：${String(error)}`);
    });
  };

  const requestCloseApp = () => {
    closeMenu();
    setClosePromptMode(hasUnsavedChangesRef.current ? 'unsaved' : 'confirm');
  };

  const closeApp = () => requestCloseApp();

  const saveAndCloseApp = async () => {
    if (closeSaveBusy) return;
    setCloseSaveBusy(true);
    try {
      const saved = await saveProject();
      if (saved) forceCloseWindow();
    } catch (error) {
      setStatus('保存工程失败，窗口未关闭');
      alert(`保存工程失败：${String(error)}`);
    } finally {
      setCloseSaveBusy(false);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      setClosePromptMode(hasUnsavedChangesRef.current ? 'unsaved' : 'confirm');
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  const discardChangesAndCloseApp = () => {
    if (closeSaveBusy) return;
    setCloseSaveBusy(true);
    forceCloseWindow();
  };

  const runMenuAction = (action: MenuAction) => (event?: React.MouseEvent) => {
    event?.stopPropagation();
    void action();
  };

  const shouldAcceptDrop = (paths: string[], point: { x: number; y: number }) => {
    const normalized = paths.map((path) => path.trim()).filter(Boolean).sort();
    if (normalized.length === 0) return false;
    const key = `${normalized.join('|')}@${Math.round(point.x)}:${Math.round(point.y)}`;
    const now = Date.now();
    const last = lastDropKeyRef.current;
    if (last && last.key === key && now - last.time < 1200) return false;
    lastDropKeyRef.current = { key, time: now };
    return true;
  };

  const importDroppedPaths = async (paths: string[], dropPoint: { x: number; y: number }) => {
    const cleanPaths = Array.from(new Set(paths.filter(Boolean)));
    if (!shouldAcceptDrop(cleanPaths, dropPoint)) return;
    const projectFiles = cleanPaths.filter((path) => projectExtensions.includes(fileExtension(path)));
    if (projectFiles.length > 0) {
      if (projectFiles.length > 1 || cleanPaths.length > 1) {
        alert('检测到工程文件。请一次只拖入一个 .refmind3d / .refmind 工程文件，不要和素材文件混合拖入。');
        return;
      }
      const path = projectFiles[0];
      if (!confirm('是否打开拖入的工程文件？当前画布内容会被切换到该工程。')) return;
      try {
        await loadProjectFromPath(path);
      } catch (error) {
        setStatus('拖入工程文件打开失败');
        alert(`拖入工程文件打开失败：${String(error)}`);
      }
      return;
    }
    setStatus(`正在导入 ${cleanPaths.length} 个文件...`);
    try {
      const wasEmptyCanvas = useProjectStore.getState().project.nodes.length === 0;
      const result = await importPathsToProject(cleanPaths, dropPoint, settings.importLayoutDirection);
      if (wasEmptyCanvas && result.nodeIds.length > 0) {
        dispatchFocusNodeIds([result.nodeIds[0]]);
      }
      const message = result.errors.length > 0
        ? `导入完成 ${result.imported} 个，失败 ${result.errors.length} 个`
        : `导入完成 ${result.imported} 个文件`;
      setStatus(message);
      if (result.errors.length > 0) {
        alert(`${message}：\n\n${result.errors.join('\n\n')}`);
      }
    } catch (error) {
      setStatus('拖拽导入失败');
      alert(`拖拽导入失败：${String(error)}`);
    }
  };

  const importDroppedImageCandidates = async (candidates: ImageImportCandidate[], dropPoint: { x: number; y: number }) => {
    const selectedCandidates = selectPureRefStyleCandidates(candidates);
    candidates = selectedCandidates;
    const keys = selectedCandidates.map(candidateDropKey);
    if (!shouldAcceptDrop(keys, dropPoint)) return;
    setStatus(`æ­£åœ¨æŠ“å– ${candidates.length} å¼ å›¾ç‰‡...`);
    try {
      const wasEmptyCanvas = useProjectStore.getState().project.nodes.length === 0;
      const result = await importImageCandidatesToProject(selectedCandidates, dropPoint, settings.importLayoutDirection);
      if (wasEmptyCanvas && result.nodeIds.length > 0) {
        dispatchFocusNodeIds([result.nodeIds[0]]);
      }
      const message = result.errors.length > 0
        ? `å›¾ç‰‡å¯¼å…¥å®Œæˆ ${result.imported} å¼ ï¼Œå¤±è´¥ ${result.errors.length} å¼ `
        : `å›¾ç‰‡å¯¼å…¥å®Œæˆ ${result.imported} å¼ `;
      setStatus(message);
      if (result.errors.length > 0) {
        alert(`${message}ï¼š\n\n${result.errors.join('\n\n')}`);
      }
    } catch (error) {
      setStatus('å›¾ç‰‡æŠ“å–å¤±è´¥');
      alert(`å›¾ç‰‡æŠ“å–å¤±è´¥ï¼?{String(error)}`);
    }
  };

  const importDroppedFileDataCandidates = async (candidates: FileDataImportCandidate[], dropPoint: { x: number; y: number }) => {
    const keys = candidates.map((candidate) => `${candidate.name}:${candidate.dataUrl.slice(0, 96)}`);
    if (!shouldAcceptDrop(keys, dropPoint)) return;
    setStatus(`正在导入 ${candidates.length} 个文件...`);
    try {
      const wasEmptyCanvas = useProjectStore.getState().project.nodes.length === 0;
      const result = await importFileDataCandidatesToProject(candidates, dropPoint, settings.importLayoutDirection);
      if (wasEmptyCanvas && result.nodeIds.length > 0) {
        dispatchFocusNodeIds([result.nodeIds[0]]);
      }
      const message = result.errors.length > 0
        ? `导入完成 ${result.imported} 个，失败 ${result.errors.length} 个`
        : `导入完成 ${result.imported} 个文件`;
      setStatus(message);
      if (result.errors.length > 0) {
        alert(`${message}：\n\n${result.errors.join('\n\n')}`);
      }
    } catch (error) {
      setStatus('拖拽文件导入失败');
      alert(`拖拽文件导入失败：${String(error)}`);
    }
  };

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    const handleNativeDragDropEvent = async (event: { payload: unknown }) => {
      const payload = event.payload;
      const payloadType = (payload as { type?: string }).type;
      if (payloadType === 'drop') {
        const paths = extractTauriDropPaths(payload);
        const dropPoint = readDropWorldPoint((payload as { position?: unknown }).position, lastCanvasPointRef.current);
        if (paths.length > 0) {
          await importDroppedPaths(paths, dropPoint);
        } else {
          setStatus('没有读取到拖拽文件路径，请使用右键菜单导入');
        }
      } else if (payloadType === 'enter' || payloadType === 'over') {
        const point = readDropWorldPoint((payload as { position?: unknown }).position, lastCanvasPointRef.current);
        lastCanvasPointRef.current = point;
        setLastCanvasPoint(point);
        setStatus('松开鼠标即可导入文件');
      } else if (payloadType === 'leave' || payloadType === 'cancel') {
        setStatus('就绪 · 右键打开菜单，拖入文件可导入');
      }
    };

    getCurrentWebview().onDragDropEvent(handleNativeDragDropEvent).then((fn) => {
      unlisteners.push(fn);
    }).catch((error) => {
      console.error('注册 Tauri Webview 拖拽导入事件失败', error);
      setStatus('Tauri 拖拽事件注册失败，已启用备用拖拽导入');
    });

    getCurrentWindow().onDragDropEvent(handleNativeDragDropEvent).then((fn) => {
      unlisteners.push(fn);
    }).catch((error) => {
      console.error('注册 Tauri Window 拖拽导入事件失败', error);
      setStatus('Tauri 拖拽事件注册失败，已启用备用拖拽导入');
    });

    const onDragOver = (event: DragEvent) => {
      if (!isPotentialDropData(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      const point = readDropWorldPoint({ x: event.clientX, y: event.clientY }, lastCanvasPointRef.current);
      lastCanvasPointRef.current = point;
      setLastCanvasPoint(point);
    };

    const onDrop = async (event: DragEvent) => {
      if (!isPotentialDropData(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const paths = extractDomDropPaths(event.dataTransfer);
      const dropPoint = readDropWorldPoint({ x: event.clientX, y: event.clientY }, lastCanvasPointRef.current);
      if (paths.length > 0) {
        void importDroppedPaths(paths, dropPoint);
      } else {
        const projectCandidates = await extractDomDropProjectCandidates(event.dataTransfer);
        if (projectCandidates.length > 0) {
          if (projectCandidates.length > 1) {
            alert('检测到多个工程文件。请一次只拖入一个 .refmind3d / .refmind 工程文件。');
            return;
          }
          if (!confirm('是否打开拖入的工程文件？当前画布内容会被切换到该工程。')) return;
          const projectCandidate = projectCandidates[0];
          try {
            await loadProjectFromDataUrl(projectCandidate.dataUrl, projectCandidate.name);
          } catch (error) {
            setStatus('拖入工程文件打开失败');
            alert(`拖入工程文件打开失败：${String(error)}`);
          }
          return;
        }
        const fileDataCandidates = await extractDomDropFileDataCandidates(event.dataTransfer);
        if (fileDataCandidates.length > 0) {
          void importDroppedFileDataCandidates(fileDataCandidates, dropPoint);
          return;
        }
        const candidates = await extractDomDropImageCandidates(event.dataTransfer);
        if (candidates.length > 0) {
          void importDroppedImageCandidates(candidates, dropPoint);
        } else {
          setStatus('拖拽内容未读取到可用图片，请尝试复制粘贴');
        }
      }
    };

    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('drop', onDrop, true);

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      void handleClipboardEventPaste(event);
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, [lastCanvasPoint]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const prevent = () => event.preventDefault();
      if (event.repeat) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a') {
        prevent();
        void toggleAlwaysOnTop();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        prevent();
        void toggleFullscreen();
        return;
      }
      if (isEditableElement(event.target)) return;
      // Undo and redo are core canvas commands. Keep these standard shortcuts
      // available even if an old settings file contains a custom shortcut map.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        prevent();
        if (event.shiftKey) {
          redo();
          setStatus('已重做');
        } else {
          undo();
          setStatus('已撤销');
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'y') {
        prevent();
        redo();
        setStatus('已重做');
        return;
      }
      if (matchesShortcut(event, settings.shortcuts.delete)) {
        if (selectedNodeIds.length > 0) {
          prevent();
          deleteSelected();
          setStatus('已删除选中节点');
        }
        return;
      }
      if (matchesShortcut(event, settings.shortcuts.help)) { prevent(); showHelp(); return; }
      if (matchesShortcut(event, settings.shortcuts.hierarchy) || matchesShortcut(event, settings.shortcuts.bringFront)) { prevent(); bringSelectedToFront(); setStatus('已置于最前'); return; }
      if (matchesShortcut(event, settings.shortcuts.settings)) { prevent(); setSettingsOpen(true); return; }
      if (matchesShortcut(event, settings.shortcuts.redo)) { prevent(); redo(); setStatus('已重做'); return; }
      if (matchesShortcut(event, settings.shortcuts.undo)) { prevent(); undo(); setStatus('已撤销'); return; }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'g') {
        prevent();
        ungroupCurrentSelection();
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'l') {
        prevent();
        toggleCurrentGroupLock();
        return;
      }
      if (matchesShortcut(event, settings.shortcuts.copy)) {
        prevent();
        if (selectedNodeIds.length === 0) {
          setStatus('请先选择要复制的节点');
          return;
        }

        // The internal node clipboard is authoritative for canvas-to-canvas
        // copy/paste. Save it synchronously before the optional system image
        // clipboard write so text nodes cannot be lost behind stale image data.
        copySelected();
        preferInternalClipboardRef.current = true;
        const includesImage = project.nodes.some((node) => (
          selectedNodeIds.includes(node.id) && node.type === 'image' && node.assetId
        ));
        if (includesImage) {
          void copySelectedImageToSystemClipboard();
        } else {
          setStatus(`已复制 ${selectedNodeIds.length} 个节点`);
        }
        return;
      }
      if (matchesShortcut(event, settings.shortcuts.paste)) {
        prevent();
        // Prefer the app's node clipboard after an in-app copy. The previous
        // system-first order could paste an older OS clipboard image instead
        // of the text node the user had just copied on another canvas.
        if (preferInternalClipboardRef.current && useProjectStore.getState().clipboardNodes.length > 0) {
          pasteClipboard(lastCanvasPointRef.current);
          setStatus('已粘贴复制的节点');
          return;
        }
        void handleSystemClipboardPaste().then((handled) => {
          if (!handled) {
            pasteClipboard(lastCanvasPointRef.current);
            setStatus('已粘贴');
          }
        });
        return;
      }
      if (matchesShortcut(event, settings.shortcuts.text)) { prevent(); createText(lastCanvasPoint.x, lastCanvasPoint.y); return; }
      if (matchesShortcut(event, settings.shortcuts.draw)) { prevent(); toggleDraw(); return; }
      if (matchesShortcut(event, settings.shortcuts.group)) { prevent(); groupSelected(); setStatus('已创建组'); return; }
      if (matchesShortcut(event, settings.shortcuts.save)) { prevent(); void saveProject(); return; }
      if (matchesShortcut(event, settings.shortcuts.open)) { prevent(); void loadProject(); return; }
      if (matchesShortcut(event, settings.shortcuts.newScene)) { prevent(); makeNewScene(); return; }
      if (matchesShortcut(event, settings.shortcuts.close)) { prevent(); void closeApp(); return; }
      if (matchesShortcut(event, settings.shortcuts.exportImage)) { prevent(); void exportSelectedOriginalFormat(); return; }
      if (matchesShortcut(event, settings.shortcuts.locate)) { prevent(); focusImportedObjects(); return; }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [project, selectedNodeIds, history, future, clipboardNodes, settings, lastCanvasPoint, currentProjectPath]);

  useEffect(() => {
    const close = () => {
      setContextMenu(null);
      setOpacityPanelOpen(false);
    };
    const onBlur = () => {
      close();
      // Returning from another application usually means its clipboard is
      // newer, so allow externally copied images to take precedence again.
      preferInternalClipboardRef.current = false;
    };
    window.addEventListener('click', close);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModelPreview(null);
        setSettingsOpen(false);
        setAiDockOpen(false);
        setCanvasDockOpen(false);
        setOpacityPanelOpen(false);
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, []);

  const layoutClass = [
    'main-layout',
    canvasSwitching ? 'canvas-switching' : '',
    !settings.showAssetPanel ? 'hide-assets' : '',
    !settings.showInspectorPanel ? 'hide-inspector' : ''
  ].join(' ');

  const renderLocalModelCard = (model: AiModelManifest) => {
    const selected = settings.ai.localVisionModelId === model.id;
    const installed = isOllamaModelInstalled(model) || settings.ai.installedModelIds.includes(model.id);
    return (
      <article key={model.id} className={`ai-model-card ${selected ? 'selected' : ''}`}>
        <div className="ai-model-card-main">
          <strong>{model.displayName}</strong>
          <span>{model.description}</span>
          <small>推荐显存 {model.recommendedVramGb}G · {model.installSize} · {model.licenseLabel}</small>
          <small>安装组件：{model.installerComponentId}</small>
        </div>
        <div className="ai-model-card-actions">
          <span className={installed ? 'model-installed' : 'model-missing'}>{installed ? '已安装' : '未安装'}</span>
          <button onClick={() => selectVisionModel(model)}>选择</button>
          <button onClick={() => void installVisionModel(model)} disabled={modelInstallBusy === model.id || !model.ollamaModelName}>
            {modelInstallBusy === model.id ? '安装中...' : '安装'}
          </button>
        </div>
      </article>
    );
  };

  return (
    <div
      className={`app-shell pureref-shell ${canvasSwitching ? 'canvas-transition-active' : ''} ${fullscreen ? 'fullscreen-canvas' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault();
        if (event.altKey) return;
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <header
        className="window-titlebar"
        onMouseDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('.window-titlebar-controls')) return;
          void getCurrentWindow().startDragging();
        }}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('.window-titlebar-controls')) return;
          void getCurrentWindow().toggleMaximize();
        }}
      >
        <div
          className="window-titlebar-controls"
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <button title="最小化" aria-label="最小化" onClick={() => void getCurrentWindow().minimize()}>−</button>
          <button title="最大化或还原" aria-label="最大化或还原" onClick={() => void getCurrentWindow().toggleMaximize()}>□</button>
          <button className="window-close-button" title="关闭" aria-label="关闭" onClick={() => void requestCloseApp()}>×</button>
        </div>
      </header>
      <div className="window-resize-zones" aria-hidden="true">
        <div className="window-resize-handle resize-n" onMouseDown={() => void getCurrentWindow().startResizeDragging('North')} />
        <div className="window-resize-handle resize-s" onMouseDown={() => void getCurrentWindow().startResizeDragging('South')} />
        <div className="window-resize-handle resize-e" onMouseDown={() => void getCurrentWindow().startResizeDragging('East')} />
        <div className="window-resize-handle resize-w" onMouseDown={() => void getCurrentWindow().startResizeDragging('West')} />
        <div className="window-resize-handle resize-ne" onMouseDown={() => void getCurrentWindow().startResizeDragging('NorthEast')} />
        <div className="window-resize-handle resize-nw" onMouseDown={() => void getCurrentWindow().startResizeDragging('NorthWest')} />
        <div className="window-resize-handle resize-se" onMouseDown={() => void getCurrentWindow().startResizeDragging('SouthEast')} />
        <div className="window-resize-handle resize-sw" onMouseDown={() => void getCurrentWindow().startResizeDragging('SouthWest')} />
      </div>
      <main className={layoutClass}>
        {settings.showAssetPanel && <AssetPanel />}
        <CanvasView
          focusContentKey={activeCanvasId}
          projectCacheId={workspaceCacheId}
          showGrid={settings.showGrid}
          drawMode={drawMode}
          doodleMode={doodleMode}
          doodleColor={doodleColor}
          doodleWidth={doodleWidth}
          doodleTool={doodleTool}
          mindChildShortcut={settings.shortcuts.mindChild}
          onOpenModel={(asset) => {
            setModelPreview(asset);
            setStatus(`正在预览 3D 模型：${asset.name}`);
          }}
          onPointerWorldChange={setLastCanvasPoint}
        />
        {settings.showInspectorPanel && <InspectorPanel />}
      </main>

      {saveNotice && <div className="project-save-notice" role="status" aria-live="polite">{saveNotice}</div>}

      <section
        className={`canvas-opacity-control ${opacityPanelOpen ? 'is-open' : ''}`}
        aria-label="画布透明度"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="canvas-opacity-trigger"
          aria-expanded={opacityPanelOpen}
          aria-controls="canvas-opacity-panel"
          title={`画布透明度 ${windowOpacity}%`}
          onClick={() => setOpacityPanelOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8.4 4.5h8.1a3 3 0 0 1 3 3v8.1a3 3 0 0 1-3 3H8.4a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3Z" />
            <path d="M4.5 8.4h8.1a3 3 0 0 1 3 3v8.1H7.5a3 3 0 0 1-3-3V8.4Z" />
          </svg>
          <span>{windowOpacity}%</span>
        </button>
        <div id="canvas-opacity-panel" className="canvas-opacity-panel">
          <div className="canvas-opacity-heading">
            <span>画布透明度</span>
            <output htmlFor="canvas-opacity-range">{windowOpacity}%</output>
          </div>
          <input
            id="canvas-opacity-range"
            type="range"
            min="30"
            max="100"
            step="1"
            value={windowOpacity}
            style={{ '--opacity-progress': `${((windowOpacity - 30) / 70) * 100}%` } as React.CSSProperties}
            aria-valuetext={`${windowOpacity}%`}
            onChange={(event) => applyWindowOpacity(Number(event.currentTarget.value))}
            onPointerUp={() => showTransientNotice(`画布透明度 ${windowOpacity}%`)}
            onKeyUp={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                showTransientNotice(`画布透明度 ${windowOpacity}%`);
              }
            }}
          />
          <div className="canvas-opacity-footer">
            <span>安全范围 30–100%</span>
            <button type="button" onClick={() => applyWindowOpacity(100, true)} disabled={windowOpacity === 100}>恢复 100%</button>
          </div>
        </div>
      </section>

      <aside className={`edge-dock edge-dock-right canvas-dock ${canvasDockOpen ? 'canvas-dock-open' : ''}`} onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="edge-dock-tab canvas-dock-tab"
          onClick={(event) => {
            event.stopPropagation();
            setCanvasDockOpen((open) => !open);
          }}
          aria-expanded={canvasDockOpen}
          aria-controls="canvas-switch-panel"
          title="点击打开/收起画布列表"
        >
          画布
        </button>
        <div id="canvas-switch-panel" className="edge-dock-panel canvas-switch-panel">
          <strong>画布切换</strong>
          <div className="canvas-list">
            {canvases.map((canvas) => (
              <div
                key={canvas.id}
                className={`canvas-list-item ${canvas.id === activeCanvasId ? 'active-canvas-button' : ''}`}
                title="单击切换画布，双击重命名"
                onClick={runMenuAction(() => switchCanvas(canvas.id))}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  renameCanvas(canvas.id);
                }}
              >
                {editingCanvasId === canvas.id ? (
                  <input
                    className="canvas-list-name-input"
                    value={editingCanvasName}
                    autoFocus
                    aria-label="画布名称"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onChange={(event) => setEditingCanvasName(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={(event) => commitCanvasRename(canvas.id, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') {
                        setEditingCanvasId(null);
                        setEditingCanvasName('');
                      }
                    }}
                  />
                ) : (
                  <span className="canvas-list-name">{canvas.name}</span>
                )}
                <button
                  className="canvas-delete-button"
                  title="删除画布"
                  onClick={(event) => {
                    event.stopPropagation();
                    requestDeleteCanvas(canvas.id);
                  }}
                  disabled={canvases.length <= 1}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="canvas-actions">
            <button onClick={runMenuAction(createCanvas)}>新建画布</button>
          </div>
          <span>单击切换，双击重命名，点击 × 删除画布</span>
        </div>
      </aside>
      <aside
        ref={aiDockRef}
        className={`edge-dock edge-dock-left edge-dock-ai ai-dock ${aiDockOpen || aiBusy ? 'ai-dock-open' : ''}`}
        style={{ top: aiDockTop }}
        onClick={(event) => event.stopPropagation()}
        onFocus={() => setAiDockOpen(true)}
      >
        <div
          className="edge-dock-tab ai-dock-tab"
          onPointerDown={startAIDockDrag}
          onClick={(event) => {
            event.stopPropagation();
            setAiDockOpen((open) => !open);
          }}
          title="点击打开/收起，拖动可移动 AI 按钮"
        >
          AI
        </div>
        <div className="edge-dock-panel ai-panel">
          <strong>AI 助手</strong>
          <span className="muted">读取当前选中对象上下文；分析模型和图片生成模型分开配置。生成图片会直接插入当前画布并自动连牵引线。</span>
          <div className="ai-context-box">
            <b>上下文</b>
            <span>{selectedNodeIds.length > 0 ? `已选中 ${selectedNodeIds.length} 个对象，附加 ${selectedAIImageCandidateCount()} 张图片` : `未选中对象，将读取当前画布概览`}</span>
          </div>
          <textarea
            className="ai-input"
            value={aiPrompt}
            onFocus={() => setAiDockOpen(true)}
            onChange={(event) => setAiPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void callAI();
              }
            }}
            placeholder="例如：分析选中参考图适合拆成哪些建模模块"
          />
          <div className="ai-actions">
            <button onClick={() => void callAI()} disabled={aiBusy}>{aiBusy ? '发送中...' : '发送分析'}</button>
            <button onClick={() => void generateAIImageToCanvas()} disabled={aiBusy}>生成图片到画布</button>
          </div>
          {aiError && <div className="ai-error">{aiError}</div>}
          <div className="ai-response">
            {aiResponse ? aiResponse : 'AI 返回结果会显示在这里。'}
          </div>
          <div className="ai-actions">
            <button onClick={insertAIResponseAsTextNode} disabled={!aiResponse.trim()}>生成文本节点</button>
            <button onClick={insertAIResponseAsMindMap} disabled={!aiResponse.trim()}>生成思维导图草稿</button>
          </div>
          <button onClick={() => setSettingsOpen(true)}>AI 设置</button>
        </div>
      </aside>
      {drawMode && <div className="floating-mode">绘制模式</div>}
      {doodleMode && (
        <section
          className="doodle-toolbar"
          aria-label="涂鸦工具"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="doodle-tool-picker" role="group" aria-label="涂鸦类型">
            {([
              ['brush', '✎', '画笔'],
              ['arrow', '➜', '箭头'],
              ['rectangle', '□', '矩形'],
              ['ellipse', '○', '圆形']
            ] as const).map(([tool, icon, label]) => (
              <button
                key={tool}
                type="button"
                className={doodleTool === tool ? 'active' : ''}
                aria-pressed={doodleTool === tool}
                title={label}
                onClick={() => setDoodleTool(tool)}
              >
                <span aria-hidden="true">{icon}</span>{label}
              </button>
            ))}
          </div>
          <strong>涂鸦</strong>
          <label className="doodle-color-control" title="画笔颜色">
            <span>颜色</span>
            <input
              type="color"
              value={doodleColor}
              aria-label="画笔颜色"
              onChange={(event) => setDoodleColor(event.currentTarget.value)}
            />
          </label>
          <label className="doodle-width-control" title="画笔粗细">
            <span>粗细</span>
            <input
              type="range"
              min="1"
              max="40"
              step="1"
              value={doodleWidth}
              aria-label="画笔粗细"
              onChange={(event) => setDoodleWidth(Number(event.currentTarget.value))}
            />
            <output>{doodleWidth}px</output>
          </label>
          <span className="doodle-pressure-badge" title="数位笔压力会实时改变线条宽度">压感开启</span>
          <button
            type="button"
            onClick={() => { undoLastDoodle(); setStatus('已撤销当前画布的上一笔涂鸦'); }}
            disabled={(project.doodles || []).length === 0}
          >撤销上一笔</button>
          <button
            type="button"
            className="doodle-clear-button"
            onClick={() => { clearDoodles(); setStatus('已清除当前画布的全部涂鸦'); }}
            disabled={(project.doodles || []).length === 0}
          >一键清除</button>
          <button type="button" onClick={() => { setDoodleMode(false); setStatus('涂鸦模式已关闭'); }}>完成</button>
        </section>
      )}

      {pendingCanvasDeletionId && (() => {
        const canvas = canvases.find((item) => item.id === pendingCanvasDeletionId);
        if (!canvas) return null;
        return (
          <div className="canvas-delete-backdrop" role="presentation" onMouseDown={() => setPendingCanvasDeletionId(null)}>
            <section className="canvas-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="canvas-delete-title" onMouseDown={(event) => event.stopPropagation()}>
              <h2 id="canvas-delete-title">确认删除画布？</h2>
              <p>“{canvas.name}”中的内容将从当前工程移除。此操作无法撤销。</p>
              <div className="canvas-delete-actions">
                <button autoFocus onClick={() => setPendingCanvasDeletionId(null)}>取消</button>
                <button className="canvas-delete-confirm" onClick={() => deleteCanvas(canvas.id)}>删除画布</button>
              </div>
            </section>
          </div>
        );
      })()}

      {closePromptMode && (
        <div className="canvas-delete-backdrop" role="presentation">
          <section className="canvas-delete-dialog window-close-dialog" role="alertdialog" aria-modal="true" aria-labelledby="window-close-title">
            {closePromptMode === 'unsaved' ? (
              <>
                <h2 id="window-close-title">工程尚未保存</h2>
                <p>当前画布有未保存的更改。为避免误触丢失内容，请先保存工程，或明确选择放弃更改。</p>
                <div className="canvas-delete-actions">
                  <button autoFocus disabled={closeSaveBusy} onClick={() => setClosePromptMode(null)}>取消</button>
                  <button className="canvas-delete-confirm" disabled={closeSaveBusy} onClick={() => void discardChangesAndCloseApp()}>放弃更改并关闭</button>
                  <button className="window-close-save" disabled={closeSaveBusy} onClick={() => void saveAndCloseApp()}>{closeSaveBusy ? '正在保存...' : '保存并关闭'}</button>
                </div>
              </>
            ) : (
              <>
                <h2 id="window-close-title">确认关闭工程？</h2>
                <p>工程内容已经保存。是否确认关闭 RefMind3D？</p>
                <div className="canvas-delete-actions">
                  <button autoFocus disabled={closeSaveBusy} onClick={() => setClosePromptMode(null)}>取消</button>
                  <button className="canvas-delete-confirm" disabled={closeSaveBusy} onClick={() => void discardChangesAndCloseApp()}>关闭工程</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu pureref-menu"
          style={{ left: '-9999px', top: '-9999px', visibility: 'hidden' }}
          onClick={(event) => event.stopPropagation()}
        >
          <button onClick={runMenuAction(showHelp)}>帮助 {shortcutLabel(settings.shortcuts.help)}</button>
          <div className="menu-row has-submenu">层级 {shortcutLabel(settings.shortcuts.hierarchy)}<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(() => { bringSelectedToFront(); setStatus('已置于最前'); closeMenu(); })} disabled={selectedNodeIds.length === 0}>置于最前</button>
              <button onClick={runMenuAction(() => { moveSelectedForward(); setStatus('已上移一层'); closeMenu(); })} disabled={selectedNodeIds.length === 0}>上移一层</button>
              <button onClick={runMenuAction(() => { moveSelectedBackward(); setStatus('已下移一层'); closeMenu(); })} disabled={selectedNodeIds.length === 0}>下移一层</button>
              <button onClick={runMenuAction(() => { sendSelectedToBack(); setStatus('已置于最后'); closeMenu(); })} disabled={selectedNodeIds.length === 0}>置于最后</button>
            </div>
          </div>
          <button onClick={runMenuAction(() => { setSettingsOpen(true); closeMenu(); })}>设置 {shortcutLabel(settings.shortcuts.settings)}</button>
          <div className="menu-row has-submenu">窗口<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(() => { void toggleAlwaysOnTop(); closeMenu(); })}>
                <span>{alwaysOnTop ? '✓ ' : ''}始终置于最前</span><span className="menu-shortcut">Ctrl+Shift+A</span>
              </button>
              <button onClick={runMenuAction(() => { void toggleFullscreen(); closeMenu(); })}>
                <span>{fullscreen ? '✓ ' : ''}全屏画布</span><span className="menu-shortcut">Ctrl+F</span>
              </button>
              <button onClick={runMenuAction(() => { setOpacityPanelOpen(true); closeMenu(); })}>
                <span>画布透明度</span><span className="menu-shortcut">{windowOpacity}%</span>
              </button>
            </div>
          </div>
          <div className="menu-separator" />
          <button onClick={runMenuAction(() => { undo(); setStatus('已撤销'); closeMenu(); })} disabled={history.length === 0}>撤销 {shortcutLabel(settings.shortcuts.undo)}</button>
          <button onClick={runMenuAction(() => { redo(); setStatus('已重做'); closeMenu(); })} disabled={future.length === 0}>重做 {shortcutLabel(settings.shortcuts.redo)}</button>
          <div className="menu-separator" />
          <button onClick={runMenuAction(() => { copySelected(); setStatus('已复制选中节点'); closeMenu(); })} disabled={selectedNodeIds.length === 0}>复制节点布局</button>
          <button onClick={runMenuAction(async () => { await copySelectedImageToSystemClipboard(); closeMenu(); })} disabled={!project.nodes.some((node) => selectedNodeIds.includes(node.id) && node.type === 'image')}>复制图片到系统剪贴板 {shortcutLabel(settings.shortcuts.copy)}</button>
          <button onClick={runMenuAction(() => { pasteClipboard(lastCanvasPointRef.current); setStatus('已粘贴'); closeMenu(); })} disabled={clipboardNodes.length === 0}>粘贴 {shortcutLabel(settings.shortcuts.paste)}</button>
          <button onClick={runMenuAction(() => createText(lastCanvasPoint.x, lastCanvasPoint.y))}>文本 {shortcutLabel(settings.shortcuts.text)}</button>
          <button onClick={runMenuAction(toggleDraw)}>绘制 {shortcutLabel(settings.shortcuts.draw)}</button>
          <button onClick={runMenuAction(toggleDoodle)}>涂鸦</button>
          <div className="menu-row has-submenu">组<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(createGroup)} disabled={selectedNodeIds.length === 0}>打组 {shortcutLabel(settings.shortcuts.group)}</button>
              <button onClick={runMenuAction(ungroupCurrentSelection)} disabled={selectedNodeIds.length === 0}>解除分组 Ctrl+Shift+G</button>
              <button onClick={runMenuAction(toggleCurrentGroupLock)} disabled={!project.nodes.some((node) => selectedNodeIds.includes(node.id) && node.type === 'group' && node.isGroupContainer !== false)}>锁定/解锁组 Alt+L</button>
            </div>
          </div>
          <div className="menu-row has-submenu">整理<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(() => arrangeSelectedLine('horizontal'))} disabled={selectedNodeIds.length < 2}>横向排列</button>
              <button onClick={runMenuAction(() => arrangeSelectedLine('vertical'))} disabled={selectedNodeIds.length < 2}>纵向排列</button>
              <button onClick={runMenuAction(arrangeSelectedGrid)} disabled={selectedNodeIds.length < 2}>网格排列</button>
              <button onClick={runMenuAction(() => distributeSelected('horizontal'))} disabled={selectedNodeIds.length < 3}>水平分布</button>
              <button onClick={runMenuAction(() => distributeSelected('vertical'))} disabled={selectedNodeIds.length < 3}>垂直分布</button>
              <div className="menu-separator" />
              <button onClick={runMenuAction(() => alignSelected('left'))} disabled={selectedNodeIds.length < 2}>左对齐</button>
              <button onClick={runMenuAction(() => alignSelected('centerX'))} disabled={selectedNodeIds.length < 2}>水平居中</button>
              <button onClick={runMenuAction(() => alignSelected('right'))} disabled={selectedNodeIds.length < 2}>右对齐</button>
              <button onClick={runMenuAction(() => alignSelected('top'))} disabled={selectedNodeIds.length < 2}>顶对齐</button>
              <button onClick={runMenuAction(() => alignSelected('centerY'))} disabled={selectedNodeIds.length < 2}>垂直居中</button>
              <button onClick={runMenuAction(() => alignSelected('bottom'))} disabled={selectedNodeIds.length < 2}>底对齐</button>
              <div className="menu-separator" />
              <button onClick={runMenuAction(() => matchSelectedSize('width'))} disabled={selectedNodeIds.length < 2}>匹配宽度</button>
              <button onClick={runMenuAction(() => matchSelectedSize('height'))} disabled={selectedNodeIds.length < 2}>匹配高度</button>
              <button onClick={runMenuAction(() => matchSelectedSize('both'))} disabled={selectedNodeIds.length < 2}>匹配尺寸</button>
              <button onClick={runMenuAction(() => scaleSelected(0.5))} disabled={selectedNodeIds.length === 0}>缩小 50%</button>
              <button onClick={runMenuAction(() => scaleSelected(2))} disabled={selectedNodeIds.length === 0}>放大 200%</button>
            </div>
          </div>
          <div className="menu-separator" />
          <div className="menu-row has-submenu">模式<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(() => { setDrawMode(false); setDoodleMode(false); setStatus('已切换到选择模式'); closeMenu(); })}>选择模式</button>
              <button onClick={runMenuAction(() => { setDrawMode(true); setDoodleMode(false); setStatus('已切换到绘制模式'); closeMenu(); })}>绘制模式</button>
              <button onClick={runMenuAction(() => { setDrawMode(false); setDoodleMode(true); setStatus('已切换到涂鸦模式'); closeMenu(); })}>涂鸦模式</button>
            </div>
          </div>
          <div className="menu-row has-submenu">窗口<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(() => updateSettings({ showAssetPanel: !settings.showAssetPanel }))}>{settings.showAssetPanel ? '隐藏资源栏' : '显示资源栏'}</button>
              <button onClick={runMenuAction(() => updateSettings({ showInspectorPanel: !settings.showInspectorPanel }))}>{settings.showInspectorPanel ? '隐藏属性栏' : '显示属性栏'}</button>
              <button onClick={runMenuAction(() => updateSettings({ showStatusbar: !settings.showStatusbar }))}>{settings.showStatusbar ? '隐藏状态栏' : '显示状态栏'}</button>
            </div>
          </div>
          <div className="menu-row has-submenu">画布<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(focusImportedObjects)}>定位并拉近 {shortcutLabel(settings.shortcuts.locate)}</button>
              <button onClick={runMenuAction(resetView)}>重置视图</button>
              <button onClick={runMenuAction(() => updateSettings({ showGrid: !settings.showGrid }))}>{settings.showGrid ? '隐藏网格' : '显示网格'}</button>
              <button onClick={runMenuAction(() => { fitSelectedImagesToNaturalSize(); setStatus('已恢复图片原始尺寸'); closeMenu(); })} disabled={selectedNodeIds.length === 0}>图片原始尺寸</button>
            </div>
          </div>
          <div className="menu-row has-submenu">图片<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(importFiles)}>导入文件</button>
              <button onClick={runMenuAction(async () => { await copySelectedImageToSystemClipboard(); closeMenu(); })} disabled={!project.nodes.some((node) => selectedNodeIds.includes(node.id) && node.type === 'image')}>复制图片到系统剪贴板</button>
              <button onClick={runMenuAction(() => { bringSelectedToFront(); setStatus('已把选中图片置于最前'); closeMenu(); })} disabled={selectedNodeIds.length === 0}>选中置于最前</button>
              <button onClick={runMenuAction(() => { fitSelectedImagesToNaturalSize(); setStatus('已恢复图片原始尺寸'); closeMenu(); })} disabled={selectedNodeIds.length === 0}>原始尺寸</button>
            </div>
          </div>
          <div className="menu-row has-submenu">模型<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(openSelectedModelPreview)} disabled={selectedNodeIds.length === 0}>进入 3D 预览</button>
              <button onClick={runMenuAction(importFiles)}>导入 OBJ/FBX/GLB/GLTF</button>
            </div>
          </div>
          <div className="menu-row has-submenu">思维导图<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button disabled>选中图片/文本后按住 {settings.shortcuts.mindChild} 拖出子对象</button>
              <button onClick={runMenuAction(() => { setSettingsOpen(true); closeMenu(); })}>修改快捷键</button>
            </div>
          </div>
          <div className="menu-row has-submenu">文档<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(importFiles)}>导入文档/表格/PDF</button>
              <button disabled>支持 txt/md/rtf/doc/docx/csv/tsv/xls/xlsx/pdf；导入后双击节点编辑内容层</button>
            </div>
          </div>
          <div className="menu-separator" />
          <div className="menu-row has-submenu">保存<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(saveProject)}>保存工程</button>
              <button onClick={runMenuAction(saveProjectAs)}>另存为</button>
              <button onClick={runMenuAction(exportSelectedOriginalFormat)} disabled={selectedNodeIds.length === 0}>导出选中到桌面 {shortcutLabel(settings.shortcuts.exportImage)}</button>
              <button onClick={runMenuAction(exportSelectedAsPng)} disabled={selectedNodeIds.length === 0}>导出选中为 PNG</button>
              <button onClick={runMenuAction(exportCanvasImage)}>导出整张画布为 PNG</button>
              <button onClick={runMenuAction(exportSelectedDocument)} disabled={!project.nodes.some((item) => selectedNodeIds.includes(item.id) && ['document', 'table', 'pdf'].includes(item.type))}>导出选中文档/表格</button>
            </div>
          </div>
          <div className="menu-row has-submenu">打开<span className="submenu-arrow">›</span>
            <div className="submenu">
              <button onClick={runMenuAction(loadProject)}>打开工程</button>
              <button onClick={runMenuAction(importFiles)}>导入文件</button>
            </div>
          </div>
          <button onClick={runMenuAction(makeNewScene)}>新场景 {shortcutLabel(settings.shortcuts.newScene)}</button>
          <button onClick={runMenuAction(deleteNodes)} disabled={selectedNodeIds.length === 0}>删除选中 {shortcutLabel(settings.shortcuts.delete)}</button>
          <div className="menu-separator" />
          <button onClick={runMenuAction(closeApp)}>关闭 {shortcutLabel(settings.shortcuts.close)}</button>
        </div>
      )}

      {modelPreview && (
        <div className="model-preview-backdrop" onMouseDown={() => setModelPreview(null)}>
          <section className="model-preview-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header className="model-preview-header">
              <div>
                <strong>{modelPreview.name}</strong>
                <span>左键按模型中心旋转 · 中键平移 · 滚轮缩放 · Shift+右键拖动天光 · Esc/关闭退出</span>
              </div>
              <button onClick={() => setModelPreview(null)}>关闭</button>
            </header>
            <ModelViewer modelPath={modelPreview.embeddedDataUrl || modelPreview.projectAssetPath} modelFormat={modelPreview.format} />
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="settings-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-dialog settings-dialog-wide" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <strong>设置</strong>
              <button onClick={() => setSettingsOpen(false)}>关闭</button>
            </header>
            <label>
              <input
                type="checkbox"
                checked={settings.showAssetPanel}
                onChange={(event) => updateSettings({ showAssetPanel: event.currentTarget.checked })}
              />
              显示资源栏
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.showInspectorPanel}
                onChange={(event) => updateSettings({ showInspectorPanel: event.currentTarget.checked })}
              />
              显示属性栏
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.showGrid}
                onChange={(event) => updateSettings({ showGrid: event.currentTarget.checked })}
              />
              显示画布网格
            </label>
            <label className="setting-select-row">
              <span>批量导入排列</span>
              <select
                value={settings.importLayoutDirection}
                onChange={(event) => updateSettings({ importLayoutDirection: event.currentTarget.value as ImportLayoutDirection })}
              >
                <option value="horizontal">横向一字排列</option>
                <option value="vertical">纵向一字排列</option>
              </select>
            </label>
            <section className="storage-settings">
              <div className="settings-section-title">
                <strong>图片缓存</strong>
                <button onClick={() => void refreshImageCacheStatus()} disabled={cacheBusy}>刷新状态</button>
              </div>
              <div className={`cache-status-card ${imageCacheStatus?.available === false ? 'is-error' : ''}`}>
                <span className="cache-status-label">缓存目录</span>
                <code title={imageCacheStatus?.directory}>{imageCacheStatus?.directory || '正在读取…'}</code>
                <span>{imageCacheStatus ? `${(imageCacheStatus.sizeBytes / 1024 / 1024).toFixed(1)} MB / 10 GB` : '—'}</span>
              </div>
              {imageCacheStatus?.error && <p className="cache-error">{imageCacheStatus.error}</p>}
              <div className="cache-actions">
                <button onClick={() => void chooseImageCacheDirectory()} disabled={cacheBusy}>更改目录</button>
                {!imageCacheStatus?.initialized && <button className="primary" onClick={() => void confirmDefaultCache()} disabled={cacheBusy}>使用默认目录</button>}
                <button onClick={() => void runCacheCleanup(30)} disabled={cacheBusy}>清理 30 天前缓存</button>
                <button onClick={() => { if (confirm('确定清理全部图片缓存吗？工程文件和原图不会被删除。')) void runCacheCleanup(); }} disabled={cacheBusy}>清理全部缓存</button>
              </div>
              <label className="storage-checkbox-row">
                <input
                  type="checkbox"
                  checked={true}
                  disabled
                  readOnly
                />
                保存工程时内嵌图片、模型、视频和文档本体
              </label>
              <p className="muted">工程仍会内嵌原始素材，方便独立传输；画布显示使用持久化缩略图和解码缓存。仅加载视野内及附近节点，原文件大小或修改时间变化后会自动重建缓存。缓存上限固定为 10 GB，跨版本和卸载默认保留。</p>
            </section>
            <section className="ai-settings-section">
              {!API_ONLY_EDITION && <section className="ai-local-model-manager">
                <div className="settings-section-title ai-subsection-title">
                  <strong>本地 AI 模型管理</strong>
                  <button onClick={() => void refreshOllamaModels()} disabled={Boolean(modelInstallBusy)}>刷新本机模型</button>
                </div>
                <p className="muted">可不安装本地模型，只使用 API Key；也可以选择本地视觉模型。视觉模型走 Ollama，图片输入使用 Ollama 原生 images 字段。</p>
                <div className="ai-model-group-title">视觉理解模型</div>
                <div className="ai-model-grid">
                  {AI_VISION_MODELS.map(renderLocalModelCard)}
                </div>
              </section>}
              <div className="settings-section-title">
                <strong>AI 接口</strong>
              </div>

              <div className="settings-section-title ai-subsection-title">
                <strong>分析模型设置</strong>
                <button onClick={() => void testAIConnection()} disabled={aiBusy}>测试分析连接</button>
              </div>
              <label className="setting-select-row">
                <span>分析 Provider</span>
                <select
                  value={settings.ai.provider}
                  onChange={(event) => updateAIProvider(event.currentTarget.value as AIProviderType)}
                >
                  {!API_ONLY_EDITION && <option value="ollama">Ollama / 本地</option>}
                  <option value="openai-compatible">OpenAI 兼容</option>
                  <option value="doubao">豆包 / 火山方舟</option>
                  <option value="custom">自定义 HTTP</option>
                </select>
              </label>
              <label className="ai-setting-row">
                <span>分析 API 地址</span>
                <input
                  value={settings.ai.apiUrl}
                  placeholder="http://localhost:11434/v1 或 https://ark.cn-beijing.volces.com/api/v3"
                  onChange={(event) => updateSettings({ ai: { ...settings.ai, apiUrl: event.currentTarget.value } })}
                  spellCheck={false}
                />
              </label>
              <label className="ai-setting-row">
                <span>分析 API Key</span>
                <input
                  type="password"
                  value={settings.ai.apiKey}
                  placeholder="本地 Ollama 可留空"
                  onChange={(event) => updateSettings({ ai: { ...settings.ai, apiKey: event.currentTarget.value } })}
                  spellCheck={false}
                />
              </label>
              <label className="ai-setting-row">
                <span>分析模型名称</span>
                <input
                  value={settings.ai.model}
                  placeholder="qwen2.5vl:7b / doubao-vision / gpt-4o-mini"
                  onChange={(event) => updateSettings({ ai: { ...settings.ai, model: event.currentTarget.value } })}
                  spellCheck={false}
                />
              </label>
              <label className="ai-setting-row ai-setting-row-tall">
                <span>系统提示词</span>
                <textarea
                  value={settings.ai.systemPrompt}
                  onChange={(event) => updateSettings({ ai: { ...settings.ai, systemPrompt: event.currentTarget.value } })}
                  spellCheck={false}
                />
              </label>

              <div className="settings-section-title ai-subsection-title">
                <strong>图片生成设置</strong>
                <button onClick={() => void generateAIImageToCanvas('生成一张简单测试图，纯白背景，极简几何图形。')} disabled={aiBusy}>测试出图</button>
              </div>
              <label className="setting-select-row">
                <span>图片 Provider</span>
                <select
                  value={settings.ai.imageProvider}
                  onChange={(event) => updateSettings({ ai: { ...settings.ai, imageProvider: event.currentTarget.value as ImageProviderType } })}
                >
                  <option value="openai-images">OpenAI 图片接口</option>
                  <option value="doubao-images">豆包图片接口</option>
                </select>
              </label>
              <>
                  <label className="ai-setting-row">
                    <span>图片 API 地址</span>
                    <input
                      value={settings.ai.imageApiUrl}
                      placeholder="https://api.openai.com/v1 或 https://ark.cn-beijing.volces.com/api/v3"
                      onChange={(event) => updateSettings({ ai: { ...settings.ai, imageApiUrl: event.currentTarget.value } })}
                      spellCheck={false}
                    />
                  </label>
                  <label className="ai-setting-row">
                    <span>图片 API Key</span>
                    <input
                      type="password"
                      value={settings.ai.imageApiKey}
                      placeholder="不填则复用分析 API Key"
                      onChange={(event) => updateSettings({ ai: { ...settings.ai, imageApiKey: event.currentTarget.value } })}
                      spellCheck={false}
                    />
                  </label>
                  <label className="ai-setting-row">
                    <span>图片模型名称</span>
                    <input
                      value={settings.ai.imageModel}
                      placeholder="gpt-image-1 / doubao-seedream-4-0-250828 / doubao-seedream-5-0"
                      onChange={(event) => updateSettings({ ai: { ...settings.ai, imageModel: event.currentTarget.value } })}
                      spellCheck={false}
                    />
                  </label>
              </>
              <label className="setting-select-row">
                <span>图片尺寸</span>
                <select
                  value={settings.ai.imageSize}
                  onChange={(event) => updateSettings({ ai: { ...settings.ai, imageSize: event.currentTarget.value } })}
                >
                  <option value="1024x1024">1024x1024</option>
                  <option value="1024x1536">1024x1536</option>
                  <option value="1536x1024">1536x1024</option>
                  <option value="2K">2K</option>
                  <option value="4K">4K</option>
                </select>
              </label>
              <label className="setting-select-row">
                <span>图片质量</span>
                <select
                  value={settings.ai.imageQuality}
                  onChange={(event) => updateSettings({ ai: { ...settings.ai, imageQuality: event.currentTarget.value } })}
                >
                  <option value="auto">auto</option>
                  <option value="standard">standard</option>
                  <option value="hd">hd</option>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </label>
              <label className="setting-select-row">
                <span>插入位置</span>
                <select
                  value={settings.ai.imageInsertMode}
                  onChange={(event) => updateSettings({ ai: { ...settings.ai, imageInsertMode: event.currentTarget.value as ImageInsertMode } })}
                >
                  <option value="right">原图右侧</option>
                  <option value="bottom">原图下方</option>
                  <option value="auto">自动避让</option>
                </select>
              </label>
              <p className="muted">“发送分析”使用分析模型；“生成图片到画布”使用图片生成 Provider。出图成功后会直接插入当前画布，并自动与原图建立牵引线。</p>
            </section>
            <section className="shortcut-settings">
              <div className="settings-section-title">
                <strong>快捷键</strong>
                <button onClick={resetShortcuts}>恢复默认</button>
              </div>
              {(Object.keys(shortcutNames) as ShortcutKey[]).map((key) => (
                <label key={key} className="shortcut-row">
                  <span>{shortcutNames[key]}</span>
                  <input
                    value={settings.shortcuts[key]}
                    onChange={(event) => updateShortcut(key, event.currentTarget.value)}
                    spellCheck={false}
                  />
                </label>
              ))}
              <p className="muted">键盘格式示例：Ctrl+N、Ctrl+Shift+Z、Alt+T。鼠标格式示例：Alt+RightMouse、Alt+LeftMouse。</p>
            </section>
            <p className="muted">文本逻辑：Ctrl+N 会在鼠标所在画布位置创建文本；单击选择/拖动，双击编辑。Delete 删除选中节点。</p>
          </section>
        </div>
      )}
    </div>
  );
}
