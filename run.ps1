<#
.SYNOPSIS
    gemini-web-bridge 快捷运行与诊断入口
.EXAMPLE
    .\run.ps1 doctor
    .\run.ps1 login personal "个人号"
    .\run.ps1 capabilities personal
    .\run.ps1 stop
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = "doctor",

    [Parameter(Position = 1)]
    [string]$Arg1 = "",

    [Parameter(Position = 2)]
    [string]$Arg2 = ""
)

$ErrorActionPreference = "Stop"
$ToolRoot = $PSScriptRoot

Push-Location $ToolRoot
try {
    if (-not (Test-Path (Join-Path $ToolRoot "node_modules"))) {
        Write-Host "[*] 正在初始化独立依赖 node_modules..." -ForegroundColor Yellow
        npm install --no-audit --no-fund
    }
    if (-not (Test-Path (Join-Path $ToolRoot "dist\src\cli.js"))) {
        Write-Host "[*] 正在编译 TypeScript..." -ForegroundColor Yellow
        npm run build
    }

    $cliArgs = @("dist\src\cli.js", $Command)
    if ($Arg1) { $cliArgs += $Arg1 }
    if ($Arg2) { $cliArgs += $Arg2 }

    & node @cliArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
