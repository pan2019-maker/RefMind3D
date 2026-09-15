import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from './projectStore';
import type { AssetRecord, CanvasNode, RefMindProject } from '../shared/types';

function emptyProject(): RefMindProject {
  return {
    version: 1,
    name: 'test',
    assets: [],
    nodes: [],
    links: [],
    doodles: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function node(): CanvasNode {
  return { id: 'node-1', type: 'image', title: 'image', x: 10, y: 20, width: 100, height: 80, rotation: 0, zIndex: 1 };
}

describe('project history', () => {
  beforeEach(() => useProjectStore.getState().setProject(emptyProject()));

  it('undoes and redoes node edits', () => {
    useProjectStore.getState().addNode(node());
    useProjectStore.getState().updateNode('node-1', { x: 250 });
    expect(useProjectStore.getState().project.nodes[0].x).toBe(250);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.nodes[0].x).toBe(10);
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.nodes[0].x).toBe(250);
  });

  it('keeps clipboard copies detached from later node edits', () => {
    useProjectStore.getState().addNode(node());
    useProjectStore.getState().copySelected();
    useProjectStore.getState().updateNode('node-1', { title: 'changed' });
    expect(useProjectStore.getState().clipboardNodes[0].title).toBe('image');
  });

  it('reuses an existing asset when the same source is imported again', () => {
    const first: AssetRecord = { id: 'asset-1', kind: 'image', name: 'a.png', originalPath: 'D:\\a.png', projectAssetPath: '', fileSize: 42, format: 'png', importedAt: '' };
    const duplicate = { ...first, id: 'asset-2' };
    useProjectStore.getState().addAssetsAndNodes([first], [{ ...node(), assetId: first.id }]);
    useProjectStore.getState().addAssetsAndNodes([duplicate], [{ ...node(), id: 'node-2', assetId: duplicate.id }]);
    expect(useProjectStore.getState().project.assets).toHaveLength(1);
    expect(useProjectStore.getState().project.nodes.find((item) => item.id === 'node-2')?.assetId).toBe(first.id);
  });

  it('normalizes and persists non-destructive image controls', () => {
    useProjectStore.getState().setProject({ ...emptyProject(), nodes: [{ ...node(), opacity: 3, imageScale: 20, imagePanX: -250 }] });
    const image = useProjectStore.getState().project.nodes[0];
    expect(image.opacity).toBe(1);
    expect(image.imageScale).toBe(8);
    expect(image.imagePanX).toBe(-100);
    useProjectStore.getState().updateNode(image.id, { cropEnabled: true, flipX: true, imageScale: 1.75 });
    expect(useProjectStore.getState().project.nodes[0]).toMatchObject({ cropEnabled: true, flipX: true, imageScale: 1.75 });
  });

  it('tracks canvas modes and linked asset mode in undo history', () => {
    const asset: AssetRecord = { id: 'asset-1', kind: 'image', name: 'a.png', originalPath: 'D:\\a.png', projectAssetPath: '', fileSize: 42, format: 'png', importedAt: '' };
    useProjectStore.getState().addAsset(asset);
    useProjectStore.getState().updateAsset(asset.id, { storageMode: 'linked' });
    useProjectStore.getState().updateProjectOptions({ canvasLocked: true, canvasGrayscale: true });
    expect(useProjectStore.getState().project.assets[0].storageMode).toBe('linked');
    expect(useProjectStore.getState().project).toMatchObject({ canvasLocked: true, canvasGrayscale: true });
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.canvasLocked).toBe(false);
  });

  it('merges exact duplicate assets and migrates every node reference', () => {
    const first: AssetRecord = { id: 'asset-1', kind: 'image', name: 'one.png', originalPath: 'D:\\one.png', projectAssetPath: '', fileSize: 42, format: 'png', importedAt: '', contentHash: 'same' };
    const second: AssetRecord = { ...first, id: 'asset-2', name: 'copy.png', originalPath: 'D:\\copy.png' };
    useProjectStore.getState().setProject({ ...emptyProject(), assets: [first, second], nodes: [{ ...node(), assetId: second.id }] });
    expect(useProjectStore.getState().mergeDuplicateAssets()).toBe(1);
    expect(useProjectStore.getState().project.assets.map((asset) => asset.id)).toEqual(['asset-1']);
    expect(useProjectStore.getState().project.nodes[0].assetId).toBe('asset-1');
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.assets).toHaveLength(2);
  });
});
