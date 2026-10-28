# SetupWindowsStartup.ps1
# Configures automatic startup for MailBox Socket Tactics after Windows reboot or user logon.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\SetupWindowsStartup.ps1 [-Trigger Logon|Boot] [-RemoveTask]
param(
    [ValidateSet('Logon', 'Boot')][string]$Trigger = 'Logon',
    [switch]$RemoveTask
)

$taskName = 'MailBoxSocketTacticsDaemon'
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$projectRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$serviceRunner = Join-Path $projectRoot 'src\service\ServiceRunner.js'

if ($RemoveTask) {
    Write-Host "Unregistering scheduled task '$taskName'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    
    $startupDir = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startupDir 'MailBoxSocketTactics.bat'
    if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force -ErrorAction SilentlyContinue }

    Write-Host "Task '$taskName' and startup shortcuts removed." -ForegroundColor Green
    exit 0
}

Write-Host "Configuring Windows Startup for MailBox Socket Tactics (Mode: $Trigger)..." -ForegroundColor Cyan

$action = New-ScheduledTaskAction -Execute 'node.exe' -Argument "`"$serviceRunner`" --all" -WorkingDirectory $projectRoot

if ($Trigger -eq 'Boot') {
    $taskTrigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
} else {
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
}

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $taskTrigger -Principal $principal -Settings $settings -Force
    Write-Host "Scheduled task '$taskName' registered successfully! Trigger: $Trigger." -ForegroundColor Green
}
catch {
    Write-Host "Could not register Task Scheduler task directly (elevation may be needed): $($_.Exception.Message)" -ForegroundColor Yellow
    if ($Trigger -eq 'Logon') {
        Write-Host "Falling back to Windows User Startup folder..." -ForegroundColor Cyan
        $startupDir = [Environment]::GetFolderPath('Startup')
        $shortcutPath = Join-Path $startupDir 'MailBoxSocketTactics.bat'
        $batContent = "@echo off`r`ncd /d `"$projectRoot`"`r`nstart `"`" /b node `"$serviceRunner`" --all`r`n"
        [System.IO.File]::WriteAllText($shortcutPath, $batContent)
        Write-Host "Created startup launcher at: $shortcutPath" -ForegroundColor Green
    } else {
        Write-Host "Boot startup requires administrative elevation. Please run PowerShell as Administrator." -ForegroundColor Red
    }
}
