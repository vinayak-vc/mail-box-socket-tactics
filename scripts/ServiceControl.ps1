# ServiceControl.ps1
# Manages the MailBox Socket Tactics daemon service on Windows.
# Actions: start, stop, restart, status
param(
    [Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'restart', 'status')][string]$Action,
    [ValidateSet('all', 'broker', 'adapters')][string]$Mode = 'all'
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
            node $serviceRunner --stop
            Start-Sleep -Seconds 1
            if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
            Write-Host "[ServiceControl] Service stopped." -ForegroundColor Green
        } else {
            Write-Host "[ServiceControl] Service is not running." -ForegroundColor Yellow
        }
        # Clean up any orphan zrok processes sharing port 8766
        Get-CimInstance Win32_Process -Filter "Name LIKE '%zrok%'" -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.CommandLine -match '8766') {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }

    'start' {
        $pidVal = Get-ServicePid
        if ($pidVal) {
            Write-Host "[ServiceControl] Service is already running (PID $pidVal)." -ForegroundColor Yellow
            return
        }

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
