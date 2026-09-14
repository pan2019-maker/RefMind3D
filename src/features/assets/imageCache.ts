import { invoke } from '@tauri-apps/api/core';
import type { AssetRecord } from '../../shared/types';

export interface ImageCacheStatus {
  directory: string;
  sizeBytes: number;
  sizeCalculated: boolean;
  maxBytes: number;
  initialized: boolean;
  available: boolean;
  error?: string;
}

export interface PreparedImageCache {
  previewUrl: string;
  mediumUrl: string;
  thumbnailUrl: string;
  cacheHit: boolean;
}

export const getImageCacheStatus = (projectCacheId: string, cacheDirectory?: string, calculateSize = false) =>
  invoke<ImageCacheStatus>('image_cache_status', { projectCacheId, cacheDirectory, calculateSize });
export const setImageCacheDirectory = (projectCacheId: string, directory: string) =>
  invoke<ImageCacheStatus>('set_image_cache_directory', { projectCacheId, directory });
export const confirmDefaultImageCacheDirectory = (projectCacheId: string) =>
  invoke<ImageCacheStatus>('confirm_default_image_cache_directory', { projectCacheId });
export const clearImageCache = (projectCacheId: string, cacheDirectory?: string, olderThanDays?: number) =>
  invoke<ImageCacheStatus>('clear_image_cache', { projectCacheId, cacheDirectory, olderThanDays });
export const prepareImageCache = (projectCacheId: string, cacheDirectory: string | undefined, asset: AssetRecord) =>
  invoke<PreparedImageCache>('prepare_image_cache', { projectCacheId, cacheDirectory, asset });
