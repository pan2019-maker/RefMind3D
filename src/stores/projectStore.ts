import { create } from 'zustand';
import type { AssetRecord, CanvasNode, DoodleStroke, ImportedImage, MindLink, RefMindProject } from '../shared/types';
import { FREE_TEXT_FONT_FAMILY, freeTextNodeSize } from '../shared/freeText';

interface ProjectState {
  project: RefMindProject;
  selectedNodeIds: string[];
  clipboardNodes: CanvasNode[];
  history: ProjectPatch[];
  future: ProjectPatch[];
  addAsset: (asset: AssetRecord) => void;
  addNode: (node: CanvasNode) => void;
  addAssetsAndNodes: (assets: AssetRecord[], nodes: CanvasNode[], selectedNodeIds?: string[]) => void;
  updateNode: (id: string, patch: Partial<CanvasNode>, recordHistory?: boolean, applyGroups?: boolean) => void;
  updateNodes: (updates: Array<{ id: string; patch: Partial<CanvasNode> }>, recordHistory?: boolean, applyGroups?: boolean) => void;
  beginHistory: () => void;
  deleteSelected: () => void;
  selectNode: (id: string, additive?: boolean) => void;
  selectNodes: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;
  setProject: (project: RefMindProject) => void;
  setProjectRoot: (rootPath: string) => void;
  newProject: () => void;
  undo: () => void;
  redo: () => void;
  copySelected: () => void;
  pasteClipboard: (at?: { x: number; y: number }) => void;
  bringNodesToFront: (ids: string[]) => void;
  bringSelectedToFront: () => void;
  sendSelectedToBack: () => void;
  moveSelectedForward: () => void;
  moveSelectedBackward: () => void;
  createTextNode: (x?: number, y?: number, startEditing?: boolean) => string;
  createDrawBox: (x: number, y: number, width: number, height: number) => void;
  addDoodleStroke: (stroke: DoodleStroke) => void;
  undoLastDoodle: () => void;
  clearDoodles: () => void;
  groupSelected: () => void;
  ungroupSelected: () => void;
  toggleSelectedGroupLock: () => void;
  completeGroupDrop: (nodeIds: string[]) => void;
  fitSelectedImagesToNaturalSize: () => void;
  createMindChild: (sourceId: string, x: number, y: number) => string | null;
  createMindLink: (sourceId: string, targetId: string) => string | null;
  deleteMindLink: (linkId: string) => void;
  normalizeGroups: () => void;
}

let lastRevisionTime = 0;
const now = () => {
  const wallClock = Date.now();
  lastRevisionTime = Math.max(wallClock, lastRevisionTime + 1);
  return new Date(lastRevisionTime).toISOString();
};
const GROUP_PADDING = 28;
const HISTORY_LIMIT = 100;
const DEFAULT_FREE_TEXT_FILL = 'transparent';
const DEFAULT_FREE_TEXT_STROKE = 'transparent';
const LEGACY_FREE_TEXT_FILL = 'rgba(44,44,44,0.82)';
const LEGACY_FREE_TEXT_STROKE = 'rgba(255,255,255,0.18)';

function createEmptyProject(): RefMindProject {
  return {
    version: 1,
    name: 'Untitled RefMind3D Project',
    assets: [],
    nodes: [],
    links: [],
    doodles: [],
    createdAt: now(),
    updatedAt: now()
  };
}

function cloneNodes(nodes: CanvasNode[]): CanvasNode[] {
  return JSON.parse(JSON.stringify(nodes)) as CanvasNode[];
}

// Store mutations always replace the affected arrays/objects. History can keep
// the immutable project root directly and share unchanged assets, document
// payloads and doodle points instead of serializing the entire project on every
// edit. Clipboard data still uses cloneProject because it is detached data.
type PatchField = 'name' | 'rootPath' | 'assets' | 'nodes' | 'links' | 'doodles';
type ProjectPatch = { fields: PatchField[]; values: Partial<RefMindProject>; updatedAt: string };
const ALL_PATCH_FIELDS: PatchField[] = ['name', 'rootPath', 'assets', 'nodes', 'links', 'doodles'];

function historySnapshot(project: RefMindProject, fields: PatchField[] = ALL_PATCH_FIELDS): ProjectPatch {
  const values: Partial<RefMindProject> = {};
  for (const field of fields) (values as Record<string, unknown>)[field] = project[field];
  return { fields, values, updatedAt: project.updatedAt };
}

function applyHistoryPatch(project: RefMindProject, patch: ProjectPatch): RefMindProject {
  return { ...project, ...patch.values, updatedAt: patch.updatedAt };
}

function defaultTextPatch(node: CanvasNode): CanvasNode {
  if (!['note', 'mindmap', 'document', 'table', 'pdf'].includes(node.type)) return node;
  const isDocumentLike = ['document', 'table', 'pdf'].includes(node.type);
  const isFreeText = ['note', 'mindmap'].includes(node.type);
  const patched: CanvasNode = {
    ...node,
    fillColor: isDocumentLike
      ? (node.fillColor || '#ffffff')
      : (!node.fillColor || node.fillColor === LEGACY_FREE_TEXT_FILL ? DEFAULT_FREE_TEXT_FILL : node.fillColor),
    strokeColor: isDocumentLike
      ? (node.strokeColor || '#747474')
      : (!node.strokeColor || node.strokeColor === LEGACY_FREE_TEXT_STROKE ? DEFAULT_FREE_TEXT_STROKE : node.strokeColor),
    textColor: isFreeText
      ? (!node.textColor || node.textColor === '#111111' ? '#ffffff' : node.textColor)
      : (node.textColor || '#111111'),
    fontFamily: isFreeText
      ? (!node.fontFamily || node.fontFamily.startsWith('Microsoft YaHei') ? FREE_TEXT_FONT_FAMILY : node.fontFamily)
      : (node.fontFamily || 'Segoe UI'),
    fontSize: node.fontSize || (isFreeText ? 22 : 16),
    fontWeight: node.fontWeight || 'normal',
    fontStyle: node.fontStyle || 'normal',
    textDecoration: node.textDecoration || 'none'
  };
  return isFreeText ? { ...patched, ...freeTextNodeSize(patched.text || '', patched) } : patched;
}

function normalizeProject(project: RefMindProject): RefMindProject {
  const normalized: RefMindProject = {
    version: 1,
    name: project.name || 'Untitled RefMind3D Project',
    rootPath: project.rootPath,
    assets: project.assets || [],
    nodes: (project.nodes || []).map((node, index) => defaultTextPatch({
      ...node,
      rotation: node.rotation ?? 0,
      zIndex: node.zIndex ?? index + 1
    })),
    links: (project.links || []).map((link) => ({
      id: link.id || crypto.randomUUID(),
      fromNodeId: link.fromNodeId,
      toNodeId: link.toNodeId,
      color: link.color || '#8a8a8a',
      width: link.width || 2
    })),
    doodles: (project.doodles || []).map((stroke) => ({
      id: stroke.id || crypto.randomUUID(),
      tool: (stroke.tool === 'arrow' || stroke.tool === 'rectangle' || stroke.tool === 'ellipse'
        ? stroke.tool
        : 'brush') as DoodleStroke['tool'],
      color: /^#[0-9a-fA-F]{6}$/.test(stroke.color || '') ? stroke.color : '#ff4d4f',
      width: Math.max(1, Math.min(40, Number(stroke.width) || 6)),
      points: (stroke.points || [])
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map((point) => ({
          x: point.x,
          y: point.y,
          pressure: Math.max(0.05, Math.min(1, Number(point.pressure) || 1))
        }))
    })).filter((stroke) => stroke.points.length > 0),
    createdAt: project.createdAt || now(),
    updatedAt: project.updatedAt || now()
  };
  return { ...normalized, nodes: applyGroupRules(normalized.nodes) };
}

function withHistory(state: ProjectState, fields: PatchField[] = ALL_PATCH_FIELDS) {
  return {
    history: [...state.history.slice(-(HISTORY_LIMIT - 1)), historySnapshot(state.project, fields)],
    future: []
  };
}

function maxZ(nodes: CanvasNode[]) {
  return nodes.reduce((max, node) => Math.max(max, node.zIndex || 0), 0);
}

function minZ(nodes: CanvasNode[]) {
  if (nodes.length === 0) return 0;
  return nodes.reduce((min, node) => Math.min(min, node.zIndex || 0), nodes[0].zIndex || 0);
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function assetFingerprint(asset: AssetRecord) {
  if (asset.contentHash) return `${asset.kind}:hash:${asset.contentHash}`;
  const source = (asset.originalPath || asset.projectAssetPath || '').trim().replace(/\\/g, '/').toLowerCase();
  if (!source || source.startsWith('refmind3d://')) return undefined;
  return `${asset.kind}:path:${source}:${asset.fileSize}`;
}

function nodeCenter(node: CanvasNode) {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function containsPoint(group: CanvasNode, point: { x: number; y: number }) {
  return point.x >= group.x && point.x <= group.x + group.width && point.y >= group.y && point.y <= group.y + group.height;
}

function isContainerGroup(node: CanvasNode) {
  return node.type === 'group' && node.isGroupContainer !== false;
}

function unionBounds(nodes: CanvasNode[]) {
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return { left, top, right, bottom };
}

function applyGroupRules(nodes: CanvasNode[]) {
  const groupNodes = nodes.filter(isContainerGroup);
  if (groupNodes.length === 0) return nodes;
  const groupIds = new Set(groupNodes.map((group) => group.id));
  let next: Array<CanvasNode | null> = nodes.map((node) => {
    if (node.type === 'group') return node;
    const groupId = node.groupId && groupIds.has(node.groupId) ? node.groupId : undefined;
    return groupId === node.groupId ? node : { ...node, groupId };
  });

  const childrenByGroup = new Map<string, CanvasNode[]>();
  next.forEach((node) => {
    if (node && node.type !== 'group' && node.groupId && groupIds.has(node.groupId)) {
      const current = childrenByGroup.get(node.groupId) || [];
      current.push(node);
      childrenByGroup.set(node.groupId, current);
    }
  });

  next = next.map((node) => {
    if (!node) return null;
    if (node.type !== 'group') return node;
    if (!isContainerGroup(node)) return node;
    const children = childrenByGroup.get(node.id) || [];
    if (children.length === 0) return null;
    const bounds = unionBounds(children);
    return {
      ...node,
      x: Math.round(bounds.left - GROUP_PADDING),
      y: Math.round(bounds.top - GROUP_PADDING),
      width: Math.round(bounds.right - bounds.left + GROUP_PADDING * 2),
      height: Math.round(bounds.bottom - bounds.top + GROUP_PADDING * 2)
    };
  });

  return next.filter((node): node is CanvasNode => Boolean(node));
}

function attachNodesToContainingGroups(nodes: CanvasNode[], nodeIds: string[]) {
  const movingIds = new Set(nodeIds);
  const groups = nodes.filter(isContainerGroup);
  return nodes.map((node) => {
    if (!movingIds.has(node.id) || node.type === 'group') return node;
    const center = nodeCenter(node);
    const target = groups
      .filter((group) => group.id !== node.id && containsPoint(group, center))
      .sort((a, b) => (a.width * a.height) - (b.width * b.height))[0];
    const groupId = target?.id;
    return groupId === node.groupId ? node : { ...node, groupId };
  });
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: createEmptyProject(),
  selectedNodeIds: [],
  clipboardNodes: [],
  history: [],
  future: [],

  // Standalone assets are rare, but they are still an editable project change.
  // Image imports use addAssetsAndNodes below so one Ctrl+Z removes both records.
  addAsset: (asset) => set((state) => ({
    ...withHistory(state, ['assets']),
    project: { ...state.project, assets: [...state.project.assets, asset], updatedAt: now() }
  })),

  addNode: (node) => set((state) => ({
    ...withHistory(state, ['nodes']),
    project: { ...state.project, nodes: applyGroupRules(attachNodesToContainingGroups([...state.project.nodes, defaultTextPatch(node)], [node.id])), updatedAt: now() },
    selectedNodeIds: [node.id]
  })),

  addAssetsAndNodes: (assets, nodes, nextSelectedNodeIds) => set((state) => {
    if (assets.length === 0 && nodes.length === 0) return state;
    const knownAssets = new Map<string, string>();
    state.project.assets.forEach((asset) => {
      const fingerprint = assetFingerprint(asset);
      if (fingerprint) knownAssets.set(fingerprint, asset.id);
    });
    const assetIdMap = new Map<string, string>();
    const uniqueAssets: AssetRecord[] = [];
    assets.forEach((asset) => {
      const fingerprint = assetFingerprint(asset);
      const existingId = fingerprint ? knownAssets.get(fingerprint) : undefined;
      if (existingId) {
        assetIdMap.set(asset.id, existingId);
        return;
      }
      uniqueAssets.push(asset);
      if (fingerprint) knownAssets.set(fingerprint, asset.id);
    });
    const patchedNodes = nodes.map((node) => defaultTextPatch({
      ...node,
      assetId: node.assetId ? (assetIdMap.get(node.assetId) || node.assetId) : undefined
    }));
    const combinedNodes = attachNodesToContainingGroups(
      [...state.project.nodes, ...patchedNodes],
      patchedNodes.map((node) => node.id)
    );
    return {
      ...withHistory(state, ['assets', 'nodes']),
      project: {
        ...state.project,
        assets: [...state.project.assets, ...uniqueAssets],
        nodes: applyGroupRules(combinedNodes),
        updatedAt: now()
      },
      selectedNodeIds: nextSelectedNodeIds ?? (patchedNodes.length > 0 ? [patchedNodes[patchedNodes.length - 1].id] : state.selectedNodeIds)
    };
  }),

  beginHistory: () => set((state) => withHistory(state, ['nodes'])),

  updateNode: (id, patch, recordHistory = true, applyGroups = true) => set((state) => ({
    ...(recordHistory ? withHistory(state, ['nodes']) : {}),
    project: {
      ...state.project,
      nodes: (applyGroups ? applyGroupRules : (nodes: CanvasNode[]) => nodes)(
        state.project.nodes.map((node) => node.id === id ? defaultTextPatch({ ...node, ...patch }) : node)
      ),
      updatedAt: now()
    }
  })),

  updateNodes: (updates, recordHistory = true, applyGroups = true) => set((state) => {
    const updateMap = new Map(updates.map((item) => [item.id, item.patch]));
    return {
      ...(recordHistory ? withHistory(state, ['nodes']) : {}),
      project: {
        ...state.project,
        nodes: (applyGroups ? applyGroupRules : (nodes: CanvasNode[]) => nodes)(
          state.project.nodes.map((node) => updateMap.has(node.id) ? defaultTextPatch({ ...node, ...updateMap.get(node.id) }) : node)
        ),
        updatedAt: now()
      }
    };
  }),

  deleteSelected: () => set((state) => {
    const selected = new Set(state.selectedNodeIds);
    const deletedGroups = new Set(state.project.nodes.filter((node) => selected.has(node.id) && node.type === 'group').map((node) => node.id));
    const nodes = state.project.nodes
      .filter((node) => !selected.has(node.id))
      .map((node) => node.groupId && deletedGroups.has(node.groupId) ? { ...node, groupId: undefined } : node);
    return {
      ...withHistory(state, ['nodes', 'links']),
      project: {
        ...state.project,
        nodes: applyGroupRules(nodes),
        links: state.project.links.filter((link) => !selected.has(link.fromNodeId) && !selected.has(link.toNodeId)),
        updatedAt: now()
      },
      selectedNodeIds: []
    };
  }),

  selectNode: (id, additive = false) => {
    const { selectedNodeIds } = get();
    if (additive) {
      set({ selectedNodeIds: selectedNodeIds.includes(id)
        ? selectedNodeIds.filter((nodeId) => nodeId !== id)
        : [...selectedNodeIds, id] });
      return;
    }
    set({ selectedNodeIds: [id] });
  },

  selectNodes: (ids, additive = false) => {
    const filtered = unique(ids.filter(Boolean));
    if (additive) {
      const current = get().selectedNodeIds;
      set({ selectedNodeIds: unique([...current, ...filtered]) });
      return;
    }
    set({ selectedNodeIds: filtered });
  },

  clearSelection: () => set({ selectedNodeIds: [] }),

  setProject: (project) => set({ project: normalizeProject(project), selectedNodeIds: [], history: [], future: [] }),

  setProjectRoot: (rootPath) => set((state) => ({
    project: { ...state.project, rootPath, updatedAt: now() }
  })),

  newProject: () => set((state) => ({
    ...withHistory(state),
    project: createEmptyProject(),
    selectedNodeIds: []
  })),

  undo: () => set((state) => {
    const previous = state.history[state.history.length - 1];
    if (!previous) return state;
    return {
      project: normalizeProject(applyHistoryPatch(state.project, previous)),
      selectedNodeIds: [],
      history: state.history.slice(0, -1),
      future: [historySnapshot(state.project, previous.fields), ...state.future].slice(0, HISTORY_LIMIT)
    };
  }),

  redo: () => set((state) => {
    const next = state.future[0];
    if (!next) return state;
    return {
      project: normalizeProject(applyHistoryPatch(state.project, next)),
      selectedNodeIds: [],
      history: [...state.history, historySnapshot(state.project, next.fields)].slice(-HISTORY_LIMIT),
      future: state.future.slice(1)
    };
  }),

  copySelected: () => {
    const state = get();
    const nodes = state.project.nodes.filter((node) => state.selectedNodeIds.includes(node.id));
    // Copy only selected nodes. Serializing the whole project here previously
    // duplicated every embedded asset merely to obtain this small node array.
    set({ clipboardNodes: cloneNodes(nodes) });
  },

  pasteClipboard: (at) => set((state) => {
    if (state.clipboardNodes.length === 0) return state;
    let z = maxZ(state.project.nodes);
    const minX = Math.min(...state.clipboardNodes.map((node) => node.x));
    const minY = Math.min(...state.clipboardNodes.map((node) => node.y));
    const maxX = Math.max(...state.clipboardNodes.map((node) => node.x + node.width));
    const maxY = Math.max(...state.clipboardNodes.map((node) => node.y + node.height));
    const offsetX = at ? Math.round(at.x - (minX + maxX) / 2) : 36;
    const offsetY = at ? Math.round(at.y - (minY + maxY) / 2) : 36;
    const pasted = state.clipboardNodes.map((node) => ({
      ...node,
      id: crypto.randomUUID(),
      groupId: undefined,
      x: node.x + offsetX,
      y: node.y + offsetY,
      zIndex: ++z
    }));
    return {
      ...withHistory(state),
      project: { ...state.project, nodes: applyGroupRules([...state.project.nodes, ...pasted]), updatedAt: now() },
      selectedNodeIds: pasted.map((node) => node.id)
    };
  }),

  bringNodesToFront: (ids) => set((state) => {
    const targetIds = ids.filter(Boolean);
    if (targetIds.length === 0) return state;
    let z = maxZ(state.project.nodes);
    return {
      project: {
        ...state.project,
        nodes: state.project.nodes.map((node) => targetIds.includes(node.id) ? { ...node, zIndex: ++z } : node),
        updatedAt: now()
      }
    };
  }),

  bringSelectedToFront: () => set((state) => {
    if (state.selectedNodeIds.length === 0) return state;
    let z = maxZ(state.project.nodes);
    return {
      ...withHistory(state),
      project: {
        ...state.project,
        nodes: state.project.nodes.map((node) => state.selectedNodeIds.includes(node.id) ? { ...node, zIndex: ++z } : node),
        updatedAt: now()
      }
    };
  }),

  sendSelectedToBack: () => set((state) => {
    if (state.selectedNodeIds.length === 0) return state;
    let z = minZ(state.project.nodes) - state.selectedNodeIds.length - 1;
    return {
      ...withHistory(state),
      project: {
        ...state.project,
        nodes: state.project.nodes.map((node) => state.selectedNodeIds.includes(node.id) ? { ...node, zIndex: ++z } : node),
        updatedAt: now()
      }
    };
  }),

  moveSelectedForward: () => set((state) => {
    if (state.selectedNodeIds.length === 0) return state;
    return {
      ...withHistory(state),
      project: {
        ...state.project,
        nodes: state.project.nodes.map((node) => state.selectedNodeIds.includes(node.id) ? { ...node, zIndex: (node.zIndex || 0) + 1 } : node),
        updatedAt: now()
      }
    };
  }),

  moveSelectedBackward: () => set((state) => {
    if (state.selectedNodeIds.length === 0) return state;
    return {
      ...withHistory(state),
      project: {
        ...state.project,
        nodes: state.project.nodes.map((node) => state.selectedNodeIds.includes(node.id) ? { ...node, zIndex: (node.zIndex || 0) - 1 } : node),
        updatedAt: now()
      }
    };
  }),

  createTextNode: (x = 120, y = 120) => {
    const id = crypto.randomUUID();
    set((state) => {
      const node: CanvasNode = defaultTextPatch({
        id,
        type: 'note',
        title: '文本',
        text: '',
        x,
        y,
        width: 182,
        height: 40,
        rotation: 0,
        zIndex: maxZ(state.project.nodes) + 1
      });
      return {
        ...withHistory(state),
        project: { ...state.project, nodes: applyGroupRules([...state.project.nodes, node]), updatedAt: now() },
        selectedNodeIds: [node.id]
      };
    });
    return id;
  },

  createDrawBox: (x, y, width, height) => set((state) => {
    const node: CanvasNode = {
      id: crypto.randomUUID(),
      type: 'group',
      title: '绘制组',
      x,
      y,
      width,
      height,
      rotation: 0,
      zIndex: maxZ(state.project.nodes) + 1,
      fillColor: 'rgba(90,120,180,0.16)',
      strokeColor: '#6f8fd8',
      isGroupContainer: false,
      groupLocked: false
    };
    return {
      ...withHistory(state),
      project: { ...state.project, nodes: applyGroupRules([...state.project.nodes, node]), updatedAt: now() },
      selectedNodeIds: [node.id]
    };
  }),

  addDoodleStroke: (stroke) => set((state) => {
    if (stroke.points.length === 0) return state;
    return {
      ...withHistory(state),
      project: {
        ...state.project,
        doodles: [...(state.project.doodles || []), stroke],
        updatedAt: now()
      }
    };
  }),

  undoLastDoodle: () => set((state) => {
    const doodles = state.project.doodles || [];
    if (doodles.length === 0) return state;
    return {
      ...withHistory(state),
      project: { ...state.project, doodles: doodles.slice(0, -1), updatedAt: now() }
    };
  }),

  clearDoodles: () => set((state) => {
    if ((state.project.doodles || []).length === 0) return state;
    return {
      ...withHistory(state),
      project: { ...state.project, doodles: [], updatedAt: now() }
    };
  }),

  groupSelected: () => set((state) => {
    const nodes = state.project.nodes.filter((node) => state.selectedNodeIds.includes(node.id) && node.type !== 'group');
    if (nodes.length === 0) return state;
    const bounds = unionBounds(nodes);
    const groupId = crypto.randomUUID();
    const groupNode: CanvasNode = {
      id: groupId,
      type: 'group',
      title: '组',
      x: bounds.left - GROUP_PADDING,
      y: bounds.top - GROUP_PADDING,
      width: bounds.right - bounds.left + GROUP_PADDING * 2,
      height: bounds.bottom - bounds.top + GROUP_PADDING * 2,
      rotation: 0,
      zIndex: Math.min(...nodes.map((node) => node.zIndex || 0)) - 1,
      fillColor: 'rgba(100,120,170,0.18)',
      strokeColor: '#6e8ed6',
      isGroupContainer: true,
      groupLocked: true
    };
    return {
      ...withHistory(state),
      project: {
        ...state.project,
        nodes: applyGroupRules([...state.project.nodes.map((node) => state.selectedNodeIds.includes(node.id) ? { ...node, groupId } : node), groupNode]),
        updatedAt: now()
      },
      selectedNodeIds: [groupId]
    };
  }),

  ungroupSelected: () => set((state) => {
    const selected = new Set(state.selectedNodeIds);
    const selectedGroups = new Set(state.project.nodes.filter((node) => selected.has(node.id) && isContainerGroup(node)).map((node) => node.id));
    const selectedChildren = new Set(state.project.nodes.filter((node) => selected.has(node.id) && node.type !== 'group').map((node) => node.id));
    if (selectedGroups.size === 0 && selectedChildren.size === 0) return state;
    const releasedIds = state.project.nodes
      .filter((node) => node.type !== 'group' && (selectedChildren.has(node.id) || Boolean(node.groupId && selectedGroups.has(node.groupId))))
      .map((node) => node.id);
    const nodes = state.project.nodes
      .filter((node) => !selectedGroups.has(node.id))
      .map((node) => (selectedChildren.has(node.id) || Boolean(node.groupId && selectedGroups.has(node.groupId))) ? { ...node, groupId: undefined } : node);
    return {
      ...withHistory(state),
      project: { ...state.project, nodes: applyGroupRules(nodes), updatedAt: now() },
      selectedNodeIds: releasedIds
    };
  }),

  toggleSelectedGroupLock: () => set((state) => {
    const selected = new Set(state.selectedNodeIds);
    const groupIds = new Set(state.project.nodes
      .filter((node) => selected.has(node.id) && isContainerGroup(node))
      .map((node) => node.id));
    if (groupIds.size === 0) return state;
    const unlock = Array.from(groupIds).every((id) => state.project.nodes.find((node) => node.id === id)?.groupLocked !== false);
    return {
      ...withHistory(state),
      project: {
        ...state.project,
        nodes: state.project.nodes.map((node) => groupIds.has(node.id) ? { ...node, groupLocked: !unlock } : node),
        updatedAt: now()
      }
    };
  }),

  completeGroupDrop: (nodeIds) => set((state) => {
    if (nodeIds.length === 0) return state;
    return {
      project: {
        ...state.project,
        nodes: applyGroupRules(attachNodesToContainingGroups(state.project.nodes, nodeIds)),
        updatedAt: now()
      }
    };
  }),

  fitSelectedImagesToNaturalSize: () => set((state) => {
    if (state.selectedNodeIds.length === 0) return state;
    const assetsById = new Map(state.project.assets.map((asset) => [asset.id, asset]));
    return {
      ...withHistory(state),
      project: {
        ...state.project,
        nodes: applyGroupRules(state.project.nodes.map((node) => {
          if (!state.selectedNodeIds.includes(node.id) || node.type !== 'image' || !node.assetId) return node;
          const asset = assetsById.get(node.assetId) as ImportedImage | undefined;
          if (!asset?.width || !asset?.height) return node;
          return { ...node, width: asset.width, height: asset.height };
        })),
        updatedAt: now()
      }
    };
  }),

  createMindChild: (sourceId, x, y) => {
    const state = get();
    const source = state.project.nodes.find((node) => node.id === sourceId);
    if (!source || source.type === 'group') return null;
    const childId = crypto.randomUUID();
    const linkId = crypto.randomUUID();
    const child: CanvasNode = defaultTextPatch({
      id: childId,
      type: 'mindmap',
      title: '子对象',
      text: '',
      x: x - 150,
      y: y - 65,
      width: 300,
      height: 130,
      rotation: 0,
      zIndex: maxZ(state.project.nodes) + 1,
      groupId: source.groupId
    });
    const link: MindLink = {
      id: linkId,
      fromNodeId: sourceId,
      toNodeId: childId,
      color: '#8f8f8f',
      width: 2
    };
    set((current) => ({
      ...withHistory(current),
      project: {
        ...current.project,
        nodes: applyGroupRules([...current.project.nodes, child]),
        links: [...current.project.links, link],
        updatedAt: now()
      },
      selectedNodeIds: [childId]
    }));
    return childId;
  },

  createMindLink: (sourceId, targetId) => {
    const state = get();
    if (sourceId === targetId) return null;
    const source = state.project.nodes.find((node) => node.id === sourceId);
    const target = state.project.nodes.find((node) => node.id === targetId);
    if (!source || !target || source.type === 'group' || target.type === 'group') return null;
    const existing = state.project.links.find((link) =>
      (link.fromNodeId === sourceId && link.toNodeId === targetId) ||
      (link.fromNodeId === targetId && link.toNodeId === sourceId)
    );
    if (existing) return existing.id;
    const link: MindLink = {
      id: crypto.randomUUID(),
      fromNodeId: sourceId,
      toNodeId: targetId,
      color: '#8f8f8f',
      width: 2
    };
    set((current) => ({
      ...withHistory(current),
      project: {
        ...current.project,
        links: [...current.project.links, link],
        updatedAt: now()
      },
      selectedNodeIds: []
    }));
    return link.id;
  },

  deleteMindLink: (linkId) => set((state) => {
    if (!linkId || !state.project.links.some((link) => link.id === linkId)) return state;
    return {
      ...withHistory(state),
      project: {
        ...state.project,
        links: state.project.links.filter((link) => link.id !== linkId),
        updatedAt: now()
      },
      selectedNodeIds: []
    };
  }),

  normalizeGroups: () => set((state) => ({
    project: { ...state.project, nodes: applyGroupRules(state.project.nodes), updatedAt: now() }
  }))
}));
