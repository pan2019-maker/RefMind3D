Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Vendor = Join-Path $Root "vendor"
$Downloads = Join-Path $Vendor "downloads"
New-Item -ItemType Directory -Force -Path $Downloads | Out-Null

function Require-Command($Name, $Message) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (!$cmd) {
    throw $Message
  }
  return $cmd.Source
}

Write-Host "== RefMind3D offline AI downloads =="
Write-Host "This step needs internet and can download many GB."

$ollamaModelsDir = "D:\ReMind3D\ollama-models"
New-Item -ItemType Directory -Force -Path $ollamaModelsDir | Out-Null
setx OLLAMA_MODELS $ollamaModelsDir | Out-Null
$env:OLLAMA_MODELS = $ollamaModelsDir
Write-Host "OLLAMA_MODELS=$ollamaModelsDir"

$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (!$ollama) {
  $ollamaSetup = Join-Path $Downloads "OllamaSetup.exe"
  if (!(Test-Path -LiteralPath $ollamaSetup)) {
    Write-Host "Downloading Ollama Windows installer..."
    Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $ollamaSetup
  }
  Write-Host "Install Ollama once, then re-run this script if ollama is still not on PATH."
  Start-Process -FilePath $ollamaSetup -Wait
  $ollama = Get-Command ollama -ErrorAction SilentlyContinue
}
if (!$ollama) {
  throw "Ollama is still not available. Install Ollama and re-run this script."
}

$models = @(
  "qwen2.5vl:7b",
  "minicpm-v4.5",
  "gemma3:12b"
)

foreach ($model in $models) {
  Write-Host "Pulling Ollama model: $model"
  & ollama pull $model
}

$webView2 = Join-Path $Downloads "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
if (!(Test-Path -LiteralPath $webView2)) {
  Write-Host "Downloading WebView2 Evergreen Runtime bootstrapper..."
  Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $webView2
}

$vcRedist = Join-Path $Downloads "VC_redist.x64.exe"
if (!(Test-Path -LiteralPath $vcRedist)) {
  Write-Host "Downloading Visual C++ Redistributable x64..."
  Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $vcRedist
}

$redist = Join-Path $Root "release\offline-staging\redist"
New-Item -ItemType Directory -Force -Path $redist | Out-Null
Copy-Item -LiteralPath $webView2 -Destination (Join-Path $redist "MicrosoftEdgeWebView2RuntimeInstallerX64.exe") -Force
Copy-Item -LiteralPath $vcRedist -Destination (Join-Path $redist "VC_redist.x64.exe") -Force

Write-Host ""
Write-Host "Ollama vision models are ready. Run:"
Write-Host "  scripts\prepare-offline-ai-assets.ps1"
