Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Staging = Join-Path $Root "release\offline-staging"
$AppStage = Join-Path $Staging "app"
$InstallerDir = Join-Path $Root "release\installer"
$FinalDir = Join-Path $Root "release\final"
$InnoScript = Join-Path $Root "packaging\inno\refmind3d-offline.iss"
$SfxConfig = Join-Path $Root "packaging\winrar\refmind3d-sfx.conf"

function Require-Tool($Name, $Hint) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (!$cmd) {
    throw "$Name was not found. $Hint"
  }
  return $cmd.Source
}

function Find-Tool($Name, $Candidates, $Hint) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  foreach ($candidate in $Candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }
  throw "$Name was not found. $Hint"
}

function Invoke-Native($Command, $Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

if (Test-Path -LiteralPath $Staging) {
  Remove-Item -LiteralPath $Staging -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Staging, $AppStage, $InstallerDir, $FinalDir | Out-Null

Write-Host "== Building RefMind3D main app =="
Push-Location $Root
$env:VITE_REFMIND_API_ONLY = "0"
Invoke-Native "npm.cmd" @("install")
Invoke-Native "npm.cmd" @("run", "build")
Invoke-Native "npm.cmd" @("run", "tauri:build")
Pop-Location

$releaseExe = Join-Path $Root "src-tauri\target\release\refmind3d.exe"
if (!(Test-Path -LiteralPath $releaseExe)) {
  throw "Release executable was not found: $releaseExe"
}

Write-Host "== Staging app files =="
Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $AppStage "refmind3d.exe") -Force
$bundleRoot = Join-Path $Root "src-tauri\target\release\bundle\nsis"
if (Test-Path -LiteralPath $bundleRoot) {
  Copy-Item -LiteralPath $bundleRoot -Destination (Join-Path $Staging "tauri-nsis") -Recurse -Force
}

Write-Host "== Preparing AI/runtime staging =="
& (Join-Path $Root "scripts\prepare-offline-ai-assets.ps1")

Write-Host "== Building graphical offline installer =="
$iscc = Find-Tool "iscc" @(
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 7\ISCC.exe",
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
) "Install Inno Setup and ensure ISCC.exe is available."

function Has-Files($Path) {
  return (Test-Path -LiteralPath $Path) -and [bool](Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)
}

$innoDefines = @()
Write-Host "Installer local image components: disabled; image generation uses API Key providers only."

& $iscc @innoDefines $InnoScript

$offlineSetup = Join-Path $InstallerDir "RefMind3D_Offline_Setup.exe"
if (!(Test-Path -LiteralPath $offlineSetup)) {
  throw "Offline installer was not generated: $offlineSetup"
}

Write-Host "== Building WinRAR SFX package =="
$rar = Find-Tool "rar" @(
  "D:\RAR\Rar.exe",
  "C:\Program Files\WinRAR\Rar.exe",
  "C:\Program Files (x86)\WinRAR\Rar.exe"
) "Install WinRAR and ensure Rar.exe is available."

$sfxRoot = Join-Path $Root "release\sfx-root"
if (Test-Path -LiteralPath $sfxRoot) {
  Remove-Item -LiteralPath $sfxRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $sfxRoot "installer") | Out-Null
Copy-Item -LiteralPath $offlineSetup -Destination (Join-Path $sfxRoot "installer\RefMind3D_Offline_Setup.exe") -Force

$payloadModels = Join-Path $Staging "ollama-models"
if (Test-Path -LiteralPath $payloadModels) {
  New-Item -ItemType Directory -Force -Path (Join-Path $sfxRoot "payload") | Out-Null
  Copy-Item -Path $payloadModels -Destination (Join-Path $sfxRoot "payload") -Recurse -Force
}

$archive = Join-Path $FinalDir "RefMind3D_Offline_Formal.exe"
Get-ChildItem -LiteralPath $FinalDir -Filter "RefMind3D_Offline_Formal.part*" -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue

Push-Location $sfxRoot
& $rar a -r -sfx -v3900m -z"$SfxConfig" "$archive" *
Pop-Location

Write-Host ""
Write-Host "Done:"
Write-Host "  $archive"
