import { describe, expect, it } from 'vitest';
import { inspectProjectHealth } from './projectHealth';

describe('inspectProjectHealth', () => {
  it('finds broken asset and link references', () => {
    const issues = inspectProjectHealth({ version: 1, name: 'x', assets: [], nodes: [{ id: 'n', type: 'image', assetId: 'missing', title: '', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 1 }], links: [{ id: 'l', fromNodeId: 'n', toNodeId: 'missing', color: '#fff', width: 1 }], doodles: [], createdAt: '', updatedAt: '' });
    expect(issues.some((issue) => issue.message.includes('不存在'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('失效'))).toBe(true);
  });
});
