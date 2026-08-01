# 测试清单

## 图片导入

- PNG 导入
- JPG 导入
- WebP 导入
- TIFF 导入
- TGA 导入
- EXR/HDR 导入
- AVIF 导入
- PSD 导入
- PSB 导入
- 损坏图片导入
- 超大图片导入
- 中文路径导入
- 空格路径导入

## 模型导入

- OBJ 导入
- FBX 导入
- GLB 导入
- GLTF 导入
- 高面数 OBJ 导入
- 高面数 FBX 导入
- 贴图缺失模型导入
- 损坏模型导入

## 性能

- 加载 100 张图片后拖动画布
- 加载高面数模型时拖动画布
- 连续删除和重新导入模型，观察内存是否持续增长
- 切换材质/灰模/白模/线框模式

## 导出

- OBJ -> OBJ
- FBX -> OBJ，需要 assimp
- GLB -> OBJ，需要 assimp
- GLTF -> OBJ，需要 assimp
