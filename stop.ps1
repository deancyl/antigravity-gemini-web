<#
.SYNOPSIS
    优雅关闭 gemini-web-bridge 常驻守护进程及其受控 Chrome 会话
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ToolRoot = $PSScriptRoot

Push-Location $ToolRoot
try {
    if (Test-Path (Join-Path $ToolRoot "dist\src\cli.js")) {
        & node "dist\src\cli.js" stop
        exit $LASTEXITCODE
    }

    $daemonFile = Join-Path $ToolRoot "data\daemon.json"
    if (-not (Test-Path $daemonFile)) {
        Write-Host "[*] 未检测到运行中的 gemini-web-bridge 守护进程。" -ForegroundColor Gray
        exit 0
    }

    $info = Get-Content -Path $daemonFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($info.app -eq "gemini-web-bridge" -and $info.host -and $info.port -and $info.token) {
        try {
            $headers = @{ "x-bridge-token" = "$($info.token)" }
            Invoke-RestMethod -Method Post -Uri "http://$($info.host):$($info.port)/api/shutdown" -Headers $headers -TimeoutSec 5 | Out-Null
            Write-Host "[+] 已发送优雅关闭信号 (PID=$($info.pid), Port=$($info.port))" -ForegroundColor Green
        } catch {
            Write-Warning "守护进程可能已退出: $($_.Exception.Message)"
        }
    }
} finally {
    Pop-Location
}
