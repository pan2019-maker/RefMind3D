import { open, save } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from '../stores/projectStore';
import { documentExtensions, imageExtensions, importPathsToProject, modelExtensions } from '../features/assets/importController';
import { loadProjectFile, saveProjectFile } from '../features/project/projectIO';
import type { RefMindProject, RefMindWorkspaceFile } from '../shared/types';

export function Toolbar() {
  const { project, setProject, deleteSelected } = useProjectStore();

  const importFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        { name: 'All supported files', extensions: [...imageExtensions, ...modelExtensions, ...documentExtensions] },
        { name: 'Images', extensions: imageExtensions },
        { name: '3D Models', extensions: modelExtensions },
        { name: 'Documents / Tables / PDF', extensions: documentExtensions }
      ]
    });
    if (!selected) return;
    const files = Array.isArray(selected) ? selected : [selected];
    const result = await importPathsToProject(files);
    if (result.errors.length > 0) {
      alert(`导入完成 ${result.imported} 个文件，失败 ${result.errors.length} 个：\n\n${result.errors.join('\n\n')}`);
    }
  };

  const saveProject = async () => {
    const path = await save({ filters: [{ name: 'RefMind3D Project', extensions: ['refmind3d', 'refmind'] }] });
    if (!path) return;
    await saveProjectFile(path, project);
  };

  const loadProject = async () => {
    const path = await open({ filters: [{ name: 'RefMind3D Project', extensions: ['refmind3d', 'refmind'] }] });
    if (!path || Array.isArray(path)) return;
    const loaded = await loadProjectFile(path);
    const workspace = loaded as RefMindWorkspaceFile;
    if (workspace.fileType === 'refmind3d-workspace' && Array.isArray(workspace.canvases)) {
      const active = workspace.canvases.find((canvas) => canvas.id === workspace.activeCanvasId) || workspace.canvases[0];
      if (active) setProject(active.project);
      return;
    }
    setProject(loaded as RefMindProject);
  };

  return (
    <div className="toolbar">
      <div className="brand">RefMind3D v2</div>
      <button onClick={importFiles}>导入图片/模型</button>
      <button onClick={saveProject}>保存工程</button>
      <button onClick={loadProject}>打开工程</button>
      <button onClick={deleteSelected}>删除选中</button>
      <div className="toolbar-spacer" />
      <span className="build-tag">maintainable source build</span>
    </div>
  );
}
