import type { RefMindProject } from '../../shared/types';

export type ProjectHealthIssue = {
  level: 'warning' | 'info';
  message: string;
};

export function inspectProjectHealth(project: RefMindProject): ProjectHealthIssue[] {
  const issues: ProjectHealthIssue[] = [];
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const nodeIds = new Set(project.nodes.map((node) => node.id));
  const missingAssets = project.nodes.filter((node) => node.assetId && !assetIds.has(node.assetId)).length;
  const brokenLinks = project.links.filter((link) => !nodeIds.has(link.fromNodeId) || !nodeIds.has(link.toNodeId)).length;
  const emptyGroups = project.nodes.filter((node) => node.type === 'group' && !project.nodes.some((child) => child.groupId === node.id)).length;
  const largeAssets = project.assets.filter((asset) => asset.fileSize >= 250 * 1024 * 1024).length;
  const seen = new Set<string>();
  let duplicates = 0;
  for (const asset of project.assets) {
    const path = (asset.originalPath || asset.projectAssetPath || '').replace(/\\/g, '/').toLowerCase();
    const key = asset.contentHash ? `${asset.kind}:${asset.contentHash}` : (path ? `${asset.kind}:${path}:${asset.fileSize}` : '');
    if (!key) continue;
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  }
  if (missingAssets) issues.push({ level: 'warning', message: `${missingAssets} 个节点引用了不存在的资源` });
  if (brokenLinks) issues.push({ level: 'warning', message: `${brokenLinks} 条思维导图连线已失效` });
  if (duplicates) issues.push({ level: 'info', message: `检测到 ${duplicates} 个重复资源，可在下次导入时自动复用` });
  if (emptyGroups) issues.push({ level: 'info', message: `${emptyGroups} 个空分组可清理` });
  if (largeAssets) issues.push({ level: 'info', message: `${largeAssets} 个资源超过 250 MB，建议保持缓存开启` });
  if (project.nodes.length >= 5000) issues.push({ level: 'info', message: `当前画布有 ${project.nodes.length} 个节点，已自动启用大型画布简化模式` });
  return issues;
}
