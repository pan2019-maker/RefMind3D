import { describe, expect, it } from 'vitest';
import { createLightweightRecoverySnapshot, mergeRecoveryResources, projectAssetIds } from './projectIO';
import type { RefMindProject } from '../../shared/types';

function project(path: string, x: number): RefMindProject {
  return {
    version: 1,
    name: 'test',
    assets: [{
      id: 'asset-1', kind: 'image', name: 'image.png', originalPath: path,
      projectAssetPath: path, previewPath: path, fileSize: 10, format: 'png', importedAt: 'now'
    }],
    nodes: [{ id: 'node-1', type: 'image', assetId: 'asset-1', title: 'image', x, y: 0, width: 100, height: 100, rotation: 0, zIndex: 1 }],
    links: [], doodles: [], createdAt: 'now', updatedAt: 'now'
  };
}

describe('mergeRecoveryResources', () => {
  it('keeps recovered edits while rebinding resource paths from the loaded project', () => {
    const merged = mergeRecoveryResources(project('refmind3d://resource/asset-1/current', 0), project('refmind3d://resource/asset-1/stale', 400)) as RefMindProject;
    expect(merged.nodes[0].x).toBe(400);
    expect(merged.assets[0].projectAssetPath).toBe('refmind3d://resource/asset-1/current');
  });

  it('keeps assets created after the last manual save', () => {
    const base = project('base.png', 0);
    const recovered = project('stale.png', 20);
    recovered.assets.push({ id: 'new', kind: 'image', name: 'new.png', originalPath: 'new.png', projectAssetPath: 'new.png', fileSize: 20, format: 'png', importedAt: 'now' });
    const merged = mergeRecoveryResources(base, recovered) as RefMindProject;
    expect(merged.assets.find((asset) => asset.id === 'new')?.projectAssetPath).toBe('new.png');
  });

  it('removes persisted resource payloads from recovery snapshots', () => {
    const base = project('base.png', 0);
    base.assets[0].embeddedDataUrl = 'data:image/png;base64,large';
    const recovery = createLightweightRecoverySnapshot(base, projectAssetIds(base)) as RefMindProject;
    expect(recovery.assets[0].projectAssetPath).toBeUndefined();
    expect(recovery.assets[0].embeddedDataUrl).toBeUndefined();
  });

  it('keeps resources for assets that have never been manually saved', () => {
    const current = project('base.png', 0);
    current.assets.push({
      id: 'new', kind: 'image', name: 'new.png', originalPath: 'new.png',
      projectAssetPath: 'new.png', embeddedDataUrl: 'data:image/png;base64,new',
      fileSize: 20, format: 'png', importedAt: 'now'
    });
    const recovery = createLightweightRecoverySnapshot(current, new Set(['asset-1'])) as RefMindProject;
    expect(recovery.assets.find((asset) => asset.id === 'new')?.embeddedDataUrl).toBe('data:image/png;base64,new');
  });
});
