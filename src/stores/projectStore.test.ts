import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from './projectStore';
import type { CanvasNode, RefMindProject } from '../shared/types';

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
});
