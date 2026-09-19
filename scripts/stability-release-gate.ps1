$ErrorActionPreference = 'Stop'

Write-Host '1/5 TypeScript and production bundle'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }

Write-Host '2/5 Unit and regression tests'
npm test
if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }

Write-Host '3/5 Rust tests'
cargo test --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed.' }

Write-Host '4/5 Version consistency'
$packageVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tauriVersion = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
$cargoVersion = ([regex]::Match((Get-Content src-tauri/Cargo.toml -Raw), '(?m)^version\s*=\s*"([^"]+)"')).Groups[1].Value
if ($packageVersion -ne $tauriVersion -or $packageVersion -ne $cargoVersion) {
  throw "Version mismatch: package=$packageVersion tauri=$tauriVersion cargo=$cargoVersion"
}

Write-Host '5/5 Release hygiene'
$forbiddenProductName = 'p' + 'ureref'
if (Select-String -Path README.md -Pattern $forbiddenProductName -CaseSensitive:$false -Quiet) {
  throw 'README contains a forbidden third-party product name.'
}
Write-Host "Stability release gate passed for v$packageVersion"
