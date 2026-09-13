# Windows 构建说明

## 环境要求

- Windows 10/11 x64
- Node.js 20 或更高版本
- Rust stable-msvc
- Microsoft Visual Studio Build Tools，并安装“使用 C++ 的桌面开发”
- Microsoft Edge WebView2 Runtime

## 安装依赖

```powershell
npm install
```

## 开发运行

```powershell
npm run tauri:dev
```

## 检查与测试

```powershell
npm run check
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## 构建

项目附带发布脚本：

```powershell
.\scripts\build-windows.ps1
```

也可以直接构建 Tauri 应用：

```powershell
npm run tauri:build
```

Tauri 标准安装包通常生成在：

```text
src-tauri\target\release\bundle\nsis\
src-tauri\target\release\bundle\msi\
```

正式发布前必须完成 [测试清单](testing.md) 中的自动化测试和关键人工回归。
