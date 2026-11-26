<#
.SYNOPSIS
    One-click installer for the Antigravity Gemini Web Bridge plugin (Windows).
.DESCRIPTION
    Installs or updates the plugin into ~/.gemini/config/plugins/gemini-web,
    installs isolated Node dependencies, builds TypeScript, initializes config.json
    from config.example.json if absent, and runs a health check.
#>
[CmdletBinding()]
param(
    [string]$TargetDir = (Join-Path $env:USERPROFILE ".gemini\config\plugins\gemini-web")
)

$ErrorActionPreference = "Stop"
$SourceDir = $PSScriptRoot
$ResolvedSource = (Resolve-Path $SourceDir).Path
$TargetParent = Split-Path -Parent $TargetDir

if (-not (Test-Path $TargetParent)) {
    New-Item -ItemType Directory -Path $TargetParent -Force | Out-Null
}

$ResolvedTarget = if (Test-Path $TargetDir) { (Resolve-Path $TargetDir).Path } else { $TargetDir }

if ($ResolvedSource -ne $ResolvedTarget) {
    Write-Host "[*] Syncing plugin files to $TargetDir ..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    $itemsToCopy = @(
        "plugin.json",
        "mcp_config.json",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "README.md",
        "run.ps1",
        "stop.ps1",
        "install.ps1",
        "install.sh",
        "src",
        "skills",
        "tests"
    )
    foreach ($item in $itemsToCopy) {
        $srcPath = Join-Path $ResolvedSource $item
        if (Test-Path $srcPath) {
            Copy-Item -Path $srcPath -Destination (Join-Path $TargetDir $item) -Recurse -Force
        }
    }

    $targetConfigDir = Join-Path $TargetDir "config"
    New-Item -ItemType Directory -Path $targetConfigDir -Force | Out-Null
    Copy-Item -Path (Join-Path $ResolvedSource "config\selectors.json") -Destination (Join-Path $targetConfigDir "selectors.json") -Force
    Copy-Item -Path (Join-Path $ResolvedSource "config\config.example.json") -Destination (Join-Path $targetConfigDir "config.example.json") -Force
}

$localConfig = Join-Path $TargetDir "config\config.json"
$exampleConfig = Join-Path $TargetDir "config\config.example.json"
if (-not (Test-Path $localConfig) -and (Test-Path $exampleConfig)) {
    Copy-Item -Path $exampleConfig -Destination $localConfig -Force
    Write-Host "[+] Initialized local config/config.json from template." -ForegroundColor Green
}

Push-Location $TargetDir
try {
    Write-Host "[*] Installing isolated Node.js dependencies..." -ForegroundColor Yellow
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "[*] Compiling TypeScript..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "[*] Running doctor check..." -ForegroundColor Yellow
    & node "dist\src\cli.js" doctor
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

Write-Host "`n[OK] Antigravity plugin 'gemini-web' installed at: $TargetDir" -ForegroundColor Green
Write-Host "Next: Start a new turn in Antigravity and say: /gemini-web login myaccount" -ForegroundColor Cyan
