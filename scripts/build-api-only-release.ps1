Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Staging = Join-Path $Root "release\api-only-staging"
$AppStage = Join-Path $Staging "app"
$Redist = Join-Path $Staging "redist"
$OutDir = Join-Path $Root "release\api-only"
$InstallerDir = Join-Path $Root "release\api-only-installer"
$InnoScript = Join-Path $Root "packaging\inno\refmind3d-api-only.iss"

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
New-Item -ItemType Directory -Force -Path $Staging, $AppStage, $Redist, $OutDir, $InstallerDir | Out-Null

Write-Host "== Building RefMind3D Compact edition =="
Push-Location $Root
$env:VITE_REFMIND_API_ONLY = "1"
Invoke-Native "npm.cmd" @("install")
Invoke-Native "npm.cmd" @("run", "build")
Invoke-Native "npm.cmd" @("run", "tauri:build")
Pop-Location

$releaseExe = Join-Path $Root "src-tauri\target\release\refmind3d.exe"
if (!(Test-Path -LiteralPath $releaseExe)) {
  throw "Release executable was not found: $releaseExe"
}
Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $AppStage "refmind3d.exe") -Force

# Use a versioned standalone shortcut icon so Windows cannot reuse the old
# executable-path icon cache after an in-place upgrade.
$shortcutIcon = Join-Path $Root "src-tauri\icons\icon.ico"
if (!(Test-Path -LiteralPath $shortcutIcon)) {
  throw "Shortcut icon was not found: $shortcutIcon"
}
Copy-Item -LiteralPath $shortcutIcon -Destination (Join-Path $AppStage "RefMind3D-App-1.1.3.ico") -Force

$projectIcon = Join-Path $Root "src-tauri\icons\refmind3d-file.ico"
if (!(Test-Path -LiteralPath $projectIcon)) {
  throw "Project icon was not found: $projectIcon"
}
Copy-Item -LiteralPath $projectIcon -Destination (Join-Path $AppStage "RefMind3D-Project-1.1.3.ico") -Force

$downloadDir = Join-Path $Root "vendor\downloads"
$webView2Installer = Join-Path $downloadDir "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
$vcRedistInstaller = Join-Path $downloadDir "VC_redist.x64.exe"
if (Test-Path -LiteralPath $webView2Installer) {
  Copy-Item -LiteralPath $webView2Installer -Destination (Join-Path $Redist "MicrosoftEdgeWebView2RuntimeInstallerX64.exe") -Force
}
if (Test-Path -LiteralPath $vcRedistInstaller) {
  Copy-Item -LiteralPath $vcRedistInstaller -Destination (Join-Path $Redist "VC_redist.x64.exe") -Force
}

$iscc = Find-Tool "iscc" @(
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 7\ISCC.exe",
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
) "Install Inno Setup and ensure ISCC.exe is available."

Invoke-Native $iscc @($InnoScript)

$setup = Join-Path $InstallerDir "RefMind3D_Setup.exe"
if (!(Test-Path -LiteralPath $setup)) {
  throw "Installer was not generated: $setup"
}

$final = Join-Path $OutDir "RefMind3D_Setup.exe"
Copy-Item -LiteralPath $setup -Destination $final -Force

# Copy the installer to the user's workspace directory
$destDir = "d:\RefMind3D_Gemini"
if (Test-Path -LiteralPath $destDir) {
  $destPath = Join-Path $destDir "RefMind3D_Setup.exe"
  Copy-Item -LiteralPath $final -Destination $destPath -Force
  Write-Host "Copied installer to workspace: $destPath"
}

Write-Host ""
Write-Host "Done:"
Write-Host "  $final"
