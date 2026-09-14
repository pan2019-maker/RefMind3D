import { invoke } from '@tauri-apps/api/core';
import { LruCache } from './lruCache';

const memoryCovers = new LruCache<string, string>(64);
export async function getModelCover(projectCacheId: string, cacheDirectory: string | undefined, key: string): Promise<string | undefined> {
  const memory = memoryCovers.get(key);
  if (memory) return memory;
  try {
    const value = await invoke<string | null>('load_model_cover', { projectCacheId, cacheDirectory, key });
    if (value) memoryCovers.set(key, value);
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function setModelCover(projectCacheId: string, cacheDirectory: string | undefined, key: string, dataUrl: string): Promise<void> {
  memoryCovers.set(key, dataUrl);
  try {
    const value = await invoke<string>('save_model_cover', { projectCacheId, cacheDirectory, key, dataUrl });
    memoryCovers.set(key, value);
  } catch {
    // The in-memory cover still avoids repeated WebGL work for this session.
  }
}

export function modelCoverKey(projectCacheId: string, asset: { id: string; fileSize: number; importedAt: string }) {
  return `${projectCacheId}:${asset.id}:${asset.fileSize}:${asset.importedAt}`;
}
