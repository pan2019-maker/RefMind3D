import { invoke } from '@tauri-apps/api/core';
import type { AssetRecord } from '../../shared/types';

export interface ImageCacheStatus {
  directory: string;
  sizeBytes: number;
  maxBytes: number;
  initialized: boolean;
  available: boolean;
  error?: string;
}

export interface PreparedImageCache {
  previewUrl: string;
  thumbnailUrl: string;
  cacheHit: boolean;
}

export const getImageCacheStatus = () => invoke<ImageCacheStatus>('image_cache_status');
export const setImageCacheDirectory = (directory: string) => invoke<ImageCacheStatus>('set_image_cache_directory', { directory });
export const confirmDefaultImageCacheDirectory = () => invoke<ImageCacheStatus>('confirm_default_image_cache_directory');
export const clearImageCache = (olderThanDays?: number) => invoke<ImageCacheStatus>('clear_image_cache', { olderThanDays });
export const prepareImageCache = (projectCacheId: string, asset: AssetRecord) => invoke<PreparedImageCache>('prepare_image_cache', { projectCacheId, asset });
