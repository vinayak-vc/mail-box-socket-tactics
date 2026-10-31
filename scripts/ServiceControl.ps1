# ServiceControl.ps1
# Manages the MailBox Socket Tactics daemon service on Windows.
# Actions: start, stop, restart, status
param(
    [Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'restart', 'status')][string]$Action,
    [ValidateSet('all', 'broker', 'adapters')][string]$Mode = 'broker'
)

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$projectRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$serviceRunner = Join-Path $projectRoot 'src\service\ServiceRunner.js'
$pidFile = Join-Path $projectRoot '.service.pid'

function Get-ServicePid {
    if (Test-Path $pidFile) {
        $p = (Get-Content $pidFile).Trim()
        if ($p -match '^\d+$') {
            $proc = Get-Process -Id ([int]$p) -ErrorAction SilentlyContinue
            if ($proc) { return [int]$p }
        }
    }
    return $null
}

function Release-ZrokShares {
    $zrokBin = (Get-Command zrok2 -ErrorAction SilentlyContinue).Source
    if (-not $zrokBin) { $zrokBin = (Get-Command zrok -ErrorAction SilentlyContinue).Source }
    if (-not $zrokBin -and (Test-Path "C:\scrcpy-win64-v2.4\zrok2.exe")) { $zrokBin = "C:\scrcpy-win64-v2.4\zrok2.exe" }
    if ($zrokBin) {
        try {
            $rawJson = cmd /c "`"$zrokBin`" overview --json 2>nul"
            if (-not $rawJson) { $rawJson = cmd /c "`"$zrokBin`" list shares --json 2>nul" }
            if ($rawJson) {
                $str = $rawJson -join "`n"
                $sIdx = $str.IndexOf('{')
                $eIdx = $str.LastIndexOf('}')
                if ($sIdx -ge 0 -and $eIdx -gt $sIdx) {
                    $jsonStr = $str.Substring($sIdx, $eIdx - $sIdx + 1)
                    $parsed = $jsonStr | ConvertFrom-Json -ErrorAction SilentlyContinue
                    $sharesList = @()
                    if ($parsed.shares) { $sharesList = $parsed.shares }
                    elseif ($parsed.environments) {
                        foreach ($env in $parsed.environments) {
                            if ($env.shares) { $sharesList += $env.shares }
                        }
                    }
                    foreach ($s in $sharesList) {
                        $tgt = if ($s.target) { $s.target } else { $s.backendProxyEndpoint }
                        $hasEp = if ($s.frontendEndpoints) { ($s.frontendEndpoints -join ' ') -match 'mailsocket' } else { $false }
                        if (($tgt -match ':8766' -or $hasEp) -and $s.shareToken) {
                            Write-Host "[ServiceControl] Releasing zrok cloud share $($s.shareToken)..." -ForegroundColor Cyan
                            cmd /c "`"$zrokBin`" delete share $($s.shareToken) 2>nul" | Out-Null
                            cmd /c "`"$zrokBin`" release $($s.shareToken) 2>nul" | Out-Null
                        }
                    }
                    if ($parsed.names) {
                        foreach ($n in $parsed.names) {
                            if ($n.name -eq 'mailsocket' -and $n.shareToken -and $n.shareToken -ne '-') {
                                Write-Host "[ServiceControl] Releasing shareToken $($n.shareToken) from name $($n.name)..." -ForegroundColor Cyan
                                cmd /c "`"$zrokBin`" delete share $($n.shareToken) 2>nul" | Out-Null
                            }
                        }
                    }
                }
            }
        } catch {}
    }
}

switch ($Action) {
    'status' {
        $pidVal = Get-ServicePid
        if ($pidVal) {
            Write-Host "[ServiceControl] Service is RUNNING (PID $pidVal)." -ForegroundColor Green
            node $serviceRunner --status
        } else {
            Write-Host "[ServiceControl] Service is STOPPED." -ForegroundColor Yellow
        }
    }

    'stop' {
        $pidVal = Get-ServicePid
        if ($pidVal) {
            Write-Host "[ServiceControl] Stopping service (PID $pidVal)..."
            # Gracefully attempt HTTP stop first
            try {
                Invoke-RestMethod -Uri "http://127.0.0.1:8766/api/service/control" -Method Post -Body '{"action":"stop","target":"all"}' -ContentType 'application/json' -TimeoutSec 2 -ErrorAction SilentlyContinue | Out-Null
                Start-Sleep -Seconds 1
            } catch {}
            node $serviceRunner --stop
            Start-Sleep -Seconds 1
            if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
            Write-Host "[ServiceControl] Service stopped." -ForegroundColor Green
        } else {
            Write-Host "[ServiceControl] Service is not running." -ForegroundColor Yellow
        }
        # Release all zrok cloud shares targeting port 8766
        Release-ZrokShares
        # Clean up any lingering zrok processes
        Get-Process *zrok* -ErrorAction SilentlyContinue | ForEach-Object {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    }

    'start' {
        $pidVal = Get-ServicePid
        if ($pidVal) {
            Write-Host "[ServiceControl] Service is already running (PID $pidVal)." -ForegroundColor Yellow
            return
        }

        # Pre-flight: release any stale shares and clean lingering processes
        Release-ZrokShares

        Write-Host "[ServiceControl] Starting service in mode --$Mode..."
        $cmdLine = "node.exe `"$serviceRunner`" --$Mode"
        $wmiResult = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $cmdLine
            CurrentDirectory = $projectRoot
        }

        Start-Sleep -Seconds 2
        $newPid = Get-ServicePid
        if ($newPid) {
            Write-Host "[ServiceControl] Service successfully started with PID $newPid." -ForegroundColor Green
        } else {
            Write-Host "[ServiceControl] Process created (ProcessId: $($wmiResult.ProcessId))." -ForegroundColor Green
        }
    }

    'restart' {
        & $MyInvocation.MyCommand.Path -Action stop
        Start-Sleep -Seconds 1
        & $MyInvocation.MyCommand.Path -Action start -Mode $Mode
    }
}
