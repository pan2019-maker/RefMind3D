# Windows 构建说明

## 1. 安装基础环境

需要：

- Windows 10/11 x64
- Node.js 20 或更新版本
- Rust stable
- Microsoft Visual Studio Build Tools，勾选 C++ Desktop Development
- WebView2 Runtime

## 2. 安装依赖

在工程根目录运行：

```powershell
npm install
```

## 3. 开发运行

```powershell
npm run tauri:dev
```

## 4. 打包 Windows exe

```powershell
npm run tauri:build
```

打包结果通常在：

```text
src-tauri\target\release\bundle\nsis\
src-tauri\target\release\bundle\msi\
```

## 5. PSD/PSB 支持说明

PSD 默认优先通过 ImageMagick 渲染合成预览图，然后回退到 Rust `psd` crate。

为了覆盖更多真实 Photoshop 文件，建议在正式安装包中内置 ImageMagick，或要求用户安装 ImageMagick 并确保 `magick.exe` 在 PATH 中。

PSB 文件通常比 PSD 更复杂，当前实现优先依赖 ImageMagick。

## 6. FBX/GLB/GLTF 导出 OBJ 说明

OBJ 直接复制导出。

FBX/GLB/GLTF 转 OBJ 当前通过 `assimp export` 实现。正式产品需要把 assimp 打包到应用目录，避免用户单独安装。
