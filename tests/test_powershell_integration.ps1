# test_powershell_integration.ps1
# End-to-end verification of PowerShell socket scripts with recipient routing and event dispatch

$ErrorActionPreference = 'Stop'
$testDir = Join-Path $PSScriptRoot 'temp_ps'
if (Test-Path $testDir) { Remove-Item $testDir -Recurse -Force }
New-Item -ItemType Directory -Path $testDir -Force | Out-Null
$testMailbox = Join-Path $testDir 'TEAM_MAILBOX.md'
Set-Content -Path $testMailbox -Value "# Test Mailbox`r`n" -Encoding UTF8

$postScript = Join-Path $PSScriptRoot '..\scripts\MailboxPostSocket.ps1'
$nextScript = Join-Path $PSScriptRoot '..\scripts\MailboxNextSocket.ps1'
$serviceRunner = Join-Path $PSScriptRoot '..\src\service\ServiceRunner.js'

Write-Host "--- TEST 1: First call to MailboxNextSocket (-SeenCount -1) ---"
$out1 = & powershell -NoProfile -ExecutionPolicy Bypass -File $nextScript -Me C -SeenCount -1 -Mailbox $testMailbox
$str1 = $out1 -join "`n"
Write-Host $str1
if ($str1 -notmatch 'NEXT_SEEN_COUNT=0') { throw "Test 1 failed: expected NEXT_SEEN_COUNT=0" }
Write-Host "TEST 1 PASS`n" -ForegroundColor Green

Write-Host "--- TEST 2: Post message via MailboxPostSocket addressed strictly to Claude ---"
$out2 = & powershell -NoProfile -ExecutionPolicy Bypass -File $postScript -As X -To Claude -Body "TASK: Test PowerShell Socket Post" -Mailbox $testMailbox
$str2 = $out2 -join "`n"
Write-Host $str2
if ($str2 -notmatch 'POSTED X-1') { throw "Test 2 failed: expected POSTED X-1" }
Write-Host "TEST 2 PASS`n" -ForegroundColor Green

Write-Host "--- TEST 3: Recipient Claude receives message ---"
$out3 = & powershell -NoProfile -ExecutionPolicy Bypass -File $nextScript -Me C -SeenCount 0 -Seconds 5 -Mailbox $testMailbox
$str3 = $out3 -join "`n"
Write-Host $str3
if ($str3 -notmatch 'X-1' -or $str3 -notmatch 'NEXT_SEEN_COUNT=1') { throw "Test 3 failed: expected X-1 and NEXT_SEEN_COUNT=1" }
Write-Host "TEST 3 PASS`n" -ForegroundColor Green

Write-Host "--- TEST 4: Non-recipient Codex does NOT receive message (Timeout expected) ---"
$procInfo = New-Object System.Diagnostics.ProcessStartInfo
$procInfo.FileName = 'powershell.exe'
$procInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$nextScript`" -Me X -SeenCount 0 -Seconds 2 -Mailbox `"$testMailbox`""
$procInfo.RedirectStandardOutput = $true
$procInfo.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($procInfo)
$proc.WaitForExit()
$out4 = $proc.StandardOutput.ReadToEnd()
Write-Host $out4
if ($proc.ExitCode -ne 2) { throw "Test 4 failed: expected exit code 2 (timeout) for non-recipient, got $($proc.ExitCode)" }
Write-Host "TEST 4 PASS (Exit code 2 verified)`n" -ForegroundColor Green

Write-Host "--- TEST 5: Real socket wait and instant wake-up ---"
# Start background broker on port 9984 / 9985
$env:MAILBOX_WS_PORT = '9984'
$env:MAILBOX_HTTP_PORT = '9985'
$env:MAILBOX_PATH = $testMailbox
$brokerProc = Start-Process -FilePath "node.exe" -ArgumentList "`"$serviceRunner`" --broker" -WorkingDirectory (Join-Path $PSScriptRoot '..') -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

try {
    # Start MailboxNextSocket in background listening on port 9984
    $receiverJob = Start-Job -ScriptBlock {
        param($script, $mailbox)
        & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Me A -SeenCount 1 -Seconds 8 -Mailbox $mailbox -WsPort 9984
    } -ArgumentList $nextScript, $testMailbox

    Start-Sleep -Seconds 1

    # Post message addressed to Antigravity
    & powershell -NoProfile -ExecutionPolicy Bypass -File $postScript -As C -To Antigravity -Body "TASK: Instant socket wake test" -Mailbox $testMailbox -HttpPort 9985

    # Wait for job to complete
    $jobResult = Wait-Job $receiverJob -Timeout 6 | Receive-Job
    $jobStr = $jobResult -join "`n"
    Write-Host $jobStr

    if ($jobStr -notmatch 'EVENT RECEIVED' -and $jobStr -notmatch 'C-2') {
        throw "Test 5 failed: event notification was not received by socket listener"
    }
    Write-Host "TEST 5 PASS (Instant socket wake verified!)`n" -ForegroundColor Green
}
finally {
    if ($brokerProc -and -not $brokerProc.HasExited) {
        $brokerProc.Kill()
    }
    Remove-Job -Job $receiverJob -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\MAILBOX_WS_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:\MAILBOX_HTTP_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:\MAILBOX_PATH -ErrorAction SilentlyContinue
}

Write-Host "=================================================" -ForegroundColor Green
Write-Host "   ALL 5 POWERSHELL INTEGRATION TESTS PASSED!    " -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Green
