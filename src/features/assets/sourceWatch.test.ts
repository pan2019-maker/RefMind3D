import { describe, expect, it } from 'vitest';
import { linkedAssetsToWatch, sourceSignatureKey } from './sourceWatch';
import type { AssetRecord } from '../../shared/types';

const asset = (patch: Partial<AssetRecord>): AssetRecord => ({
  id: 'a', kind: 'image', name: 'a.png', originalPath: 'D:/a.png', projectAssetPath: 'D:/a.png',
  fileSize: 1, format: 'png', importedAt: 'now', storageMode: 'linked', ...patch
});

describe('linked source watcher', () => {
  it('only watches visible linked assets that opted in', () => {
    const values = [asset({}), asset({ id: 'b', autoRefresh: false }), asset({ id: 'c', storageMode: 'embedded' })];
    expect(linkedAssetsToWatch(values, new Set(['a', 'b', 'c'])).map((item) => item.id)).toEqual(['a']);
    expect(sourceSignatureKey({ size: 12, modifiedMs: 34 })).toBe('12:34');
  });
});
