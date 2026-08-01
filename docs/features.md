# 功能说明

## V1 目标

- 无限画布
- 图片导入
- PSD 合成预览导入
- 特殊图片格式生成 PNG 预览缓存
- OBJ/FBX/GLB/GLTF 预览
- 高面数模型性能保护
- 工程保存和打开
- 模型导出 OBJ

## 图片格式

当前设计目标支持：

- PNG
- JPG/JPEG
- WebP
- BMP
- GIF
- ICO
- TIFF/TIF
- TGA
- DDS
- HDR
- EXR
- AVIF
- QOI
- PSD
- PSB

浏览器无法稳定显示的格式统一生成 PNG 预览缓存。

## 3D 模型格式

当前设计目标支持：

- OBJ
- FBX
- GLB
- GLTF

## 高面数保护策略

- 后端导入不做重型解析，避免阻塞 UI
- OBJ 做轻量文本统计
- GLTF/GLB 先读元数据
- FBX 暂不做完整解析，交给前端加载器和文件大小阈值保护
- 前端预览组件按需渲染
- 删除/切换模型时 dispose geometry/material/texture
- 预留代理模型和取消加载接口

## 后续思维导图扩展

已在类型中预留 `mindmap` 节点类型。后续可增加：

- 文字节点
- 连线节点
- 分组
- 图片和模型关联说明
- 标签和搜索
