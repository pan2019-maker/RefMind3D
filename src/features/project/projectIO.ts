import { invoke } from '@tauri-apps/api/core';
import type { RefMindProject, RefMindProjectFile } from '../../shared/types';

export async function saveProjectFile(path: string, project: RefMindProjectFile): Promise<void> {
  await invoke('save_project', { path, project, embedResources: true });
}

export async function loadProjectFile(path: string): Promise<RefMindProjectFile> {
  return invoke<RefMindProjectFile>('load_project', { path });
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
