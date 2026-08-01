Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Staging = Join-Path $Root "release\offline-staging"
$Redist = Join-Path $Staging "redist"
$OllamaRuntime = Join-Path $Staging "ai-runtime\ollama"
$OllamaModels = Join-Path $Staging "ollama-models"

function New-Dir($Path) {
  if (!(Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
}

function Copy-DirIfExists($Source, $Dest) {
  if (Test-Path -LiteralPath $Source) {
    New-Dir $Dest
    Copy-Item -Path (Join-Path $Source "*") -Destination $Dest -Recurse -Force
  }
}

New-Dir $Staging
New-Dir $Redist
New-Dir $OllamaRuntime
New-Dir $OllamaModels

Write-Host "== RefMind3D offline AI asset staging =="
Write-Host "Staging: $Staging"

$downloadDir = Join-Path $Root "vendor\downloads"
$webView2Installer = Join-Path $downloadDir "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
$vcRedistInstaller = Join-Path $downloadDir "VC_redist.x64.exe"
if (Test-Path -LiteralPath $webView2Installer) {
  Copy-Item -LiteralPath $webView2Installer -Destination (Join-Path $Redist "MicrosoftEdgeWebView2RuntimeInstallerX64.exe") -Force
}
if (Test-Path -LiteralPath $vcRedistInstaller) {
  Copy-Item -LiteralPath $vcRedistInstaller -Destination (Join-Path $Redist "VC_redist.x64.exe") -Force
}

$ollamaCandidates = @(
  "$env:LOCALAPPDATA\Programs\Ollama",
  "$env:ProgramFiles\Ollama",
  (Join-Path $Root "vendor\ollama")
)
foreach ($candidate in $ollamaCandidates) {
  if ((Test-Path -LiteralPath (Join-Path $candidate "ollama.exe"))) {
    Copy-DirIfExists $candidate $OllamaRuntime
    break
  }
}

$ollamaModelCandidates = @(
  "D:\ReMind3D\ollama-models",
  $env:OLLAMA_MODELS,
  (Join-Path $HOME ".ollama\models")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$userOllamaModels = $ollamaModelCandidates | Select-Object -First 1
if ($userOllamaModels) {
  Write-Host "Copying local Ollama model store from $userOllamaModels"
  $dest = Join-Path $OllamaModels "all"
  New-Dir $dest
  Copy-Item -Path (Join-Path $userOllamaModels "*") -Destination $dest -Recurse -Force
} else {
  Write-Warning "Ollama model store was not found. Expected D:\ReMind3D\ollama-models or OLLAMA_MODELS. Run download-offline-ai-assets.ps1 first."
}

Write-Host ""
Write-Host "Next:"
Write-Host "1. Put WebView2 and VC++ offline installers in $Redist"
Write-Host "2. Run scripts\build-offline-release.ps1"
