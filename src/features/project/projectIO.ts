import { invoke } from '@tauri-apps/api/core';
import type { RefMindProject, RefMindProjectFile } from '../../shared/types';

export async function saveProjectFile(path: string, project: RefMindProjectFile): Promise<void> {
  await invoke('save_project', { path, project, embedResources: true });
}

export async function loadProjectFile(path: string): Promise<RefMindProjectFile> {
  return invoke<RefMindProjectFile>('load_project', { path });
}

export async function loadProjectIndex(path: string): Promise<RefMindProjectFile> {
  return invoke<RefMindProjectFile>('load_project_index', { path });
}

export async function loadProjectCanvas(path: string, canvasId: string): Promise<RefMindProject> {
  return invoke<RefMindProject>('load_project_canvas', { path, canvasId });
}

export async function loadProjectDataUrl(dataUrl: string, nameHint?: string): Promise<RefMindProjectFile> {
  return invoke<RefMindProjectFile>('load_project_data_url', { dataUrl, nameHint });
}

export async function saveRecoveryProject(cacheId: string, project: RefMindProjectFile): Promise<void> {
  await invoke('save_recovery_project', { cacheId, project });
}

export async function loadNewerRecoveryProject(cacheId: string, projectPath: string): Promise<RefMindProjectFile | null> {
  return invoke<RefMindProjectFile | null>('load_newer_recovery_project', { cacheId, projectPath });
}

export async function clearRecoveryProject(cacheId: string): Promise<void> {
  await invoke('clear_recovery_project', { cacheId });
}

const resourceFields = [
  'originalPath', 'projectAssetPath', 'previewPath', 'thumbnailPath',
  'embeddedDataUrl', 'embeddedPreviewDataUrl', 'embeddedThumbnailDataUrl', 'documentMedia'
] as const;

function projectsInFile(file: RefMindProjectFile): RefMindProject[] {
  const workspace = file as import('../../shared/types').RefMindWorkspaceFile;
  return workspace.fileType === 'refmind3d-workspace'
    ? workspace.canvases.map((canvas) => canvas.project).filter(Boolean)
    : [file as RefMindProject];
}

export function projectAssetIds(file: RefMindProjectFile): Set<string> {
  return new Set(projectsInFile(file).flatMap((project) => project.assets.map((asset) => asset.id)));
}

function stripPersistedResources(project: RefMindProject, persistedAssetIds: ReadonlySet<string>): RefMindProject {
  return {
    ...project,
    assets: project.assets.map((asset) => {
      if (!persistedAssetIds.has(asset.id)) return asset;
      const lightweight = { ...asset } as Record<string, unknown>;
      for (const field of resourceFields) delete lightweight[field];
      return lightweight as unknown as typeof asset;
    })
  };
}

/** Keeps unsaved new assets recoverable without duplicating resources already stored in the project package. */
export function createLightweightRecoverySnapshot(
  file: RefMindProjectFile,
  persistedAssetIds: ReadonlySet<string>,
  baselineCanvasRevisions?: ReadonlyMap<string, string>
): RefMindProjectFile {
  const workspace = file as import('../../shared/types').RefMindWorkspaceFile;
  if (workspace.fileType === 'refmind3d-workspace') {
    return {
      ...workspace,
      canvases: workspace.canvases
        .filter((canvas) => !baselineCanvasRevisions || baselineCanvasRevisions.get(canvas.id) !== canvas.project.updatedAt)
        .map((canvas) => ({
        ...canvas,
        project: stripPersistedResources(canvas.project, persistedAssetIds)
      }))
    };
  }
  return stripPersistedResources(file as RefMindProject, persistedAssetIds);
}

function mergeProjectResources(base: RefMindProject, recovered: RefMindProject): RefMindProject {
  const baseAssets = new Map(base.assets.map((asset) => [asset.id, asset]));
  return {
    ...recovered,
    assets: recovered.assets.map((asset) => {
      const original = baseAssets.get(asset.id);
      if (!original) return asset;
      const merged = { ...asset } as Record<string, unknown>;
      for (const field of resourceFields) {
        const value = original[field];
        if (value !== undefined) merged[field] = value;
        else delete merged[field];
      }
      return merged as unknown as typeof asset;
    })
  };
}

/** Rebinds a lightweight recovery snapshot to resources registered from the saved project. */
export function mergeRecoveryResources(base: RefMindProjectFile, recovered: RefMindProjectFile): RefMindProjectFile {
  const baseWorkspace = base as import('../../shared/types').RefMindWorkspaceFile;
  const recoveredWorkspace = recovered as import('../../shared/types').RefMindWorkspaceFile;
  if (baseWorkspace.fileType === 'refmind3d-workspace' && recoveredWorkspace.fileType === 'refmind3d-workspace') {
    const baseCanvases = new Map(baseWorkspace.canvases.map((canvas) => [canvas.id, canvas]));
    const recoveredCanvases = new Map(recoveredWorkspace.canvases.map((canvas) => [canvas.id, canvas]));
    return {
      ...recoveredWorkspace,
      canvases: baseWorkspace.canvases.map((canvas) => {
        const recoveredCanvas = recoveredCanvases.get(canvas.id);
        return recoveredCanvas
          ? { ...recoveredCanvas, project: mergeProjectResources(canvas.project, recoveredCanvas.project) }
          : canvas;
      }).concat(recoveredWorkspace.canvases.filter((canvas) => !baseCanvases.has(canvas.id)))
    };
  }
  if (baseWorkspace.fileType !== 'refmind3d-workspace' && recoveredWorkspace.fileType !== 'refmind3d-workspace') {
    return mergeProjectResources(base as RefMindProject, recovered as RefMindProject);
  }
  return recovered;
}
