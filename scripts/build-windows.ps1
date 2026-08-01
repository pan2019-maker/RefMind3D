Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "== RefMind3D v2 Windows Build =="
Write-Host "Checking Node..."
node -v
npm -v

Write-Host "Checking Rust..."
rustc --version
cargo --version

Write-Host "Installing npm dependencies..."
npm install

Write-Host "Building Tauri Windows package..."
npm run tauri:build

Write-Host "Build complete. Check src-tauri\target\release\bundle"
