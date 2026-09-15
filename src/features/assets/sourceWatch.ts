import type { AssetRecord } from '../../shared/types';

export interface SourceSignature {
  size: number;
  modifiedMs: number;
}

export function sourceSignatureKey(signature: SourceSignature) {
  return `${signature.size}:${signature.modifiedMs}`;
}

export function linkedAssetsToWatch(assets: AssetRecord[], visibleAssetIds: ReadonlySet<string>) {
  return assets.filter((asset) => asset.storageMode === 'linked'
    && asset.autoRefresh !== false
    && Boolean(asset.originalPath)
    && visibleAssetIds.has(asset.id));
}
