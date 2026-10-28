# MailboxPostSocket.ps1
# Appends ONE message to TEAM_MAILBOX.md under a named mutex,
# then immediately notifies the Event Broker for instant (<15ms) event-driven dispatch.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\MailboxPostSocket.ps1 -As X -To Claude -BodyFile path\to\message.txt
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\MailboxPostSocket.ps1 -As A -To Claude -Body "TASK: ...`nSTATUS: ..."
param(
    [Parameter(Mandatory = $true)][ValidateSet('C', 'X', 'A')][string]$As,
    [Parameter(Mandatory = $true)][string]$To,
    [string]$Body = '',
    [string]$BodyFile = '',
    [string]$Mailbox = '',
    [int]$HttpPort = 8766,
    [string]$AuthToken = 'mailbox-socket-secret-token'
)

$ErrorActionPreference = 'Stop'

if (-not $Mailbox) {
    $scriptDir = $PSScriptRoot
    if (-not $scriptDir -and $MyInvocation.MyCommand.Path) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $candidate1 = if ($scriptDir) { Join-Path $scriptDir '..\..\OneBossFight\Documentation\TEAM_MAILBOX.md' } else { '' }
    $candidate2 = if ($scriptDir) { Join-Path $scriptDir '..\Documentation\TEAM_MAILBOX.md' } else { '' }
    
    if ($candidate1 -and (Test-Path $candidate1)) {
        $Mailbox = (Resolve-Path $candidate1).Path
    } elseif ($candidate2 -and (Test-Path $candidate2)) {
        $Mailbox = (Resolve-Path $candidate2).Path
    } else {
        $Mailbox = Join-Path (Get-Location).Path 'Documentation\TEAM_MAILBOX.md'
    }
}

if ($BodyFile) { $Body = [System.IO.File]::ReadAllText($BodyFile) }
$Body = $Body.Trim()
if (-not $Body) { Write-Output 'MailboxPostSocket: empty body, nothing posted'; exit 1 }
if ($Body -match '(?m)^###\s*\[') { Write-Output 'MailboxPostSocket: the body must not contain a "### [id]" heading line: the script writes it'; exit 1 }

$names = @{ C = 'Claude'; X = 'Codex'; A = 'Antigravity' }
$mutex = New-Object System.Threading.Mutex($false, 'Global\OneBossFightMailbox')
$got = $false

try {
    $got = $mutex.WaitOne(15000)
    if (-not $got) { Write-Output 'MailboxPostSocket: could not get the mailbox lock in 15 s'; exit 1 }

    $text = if (Test-Path $Mailbox) { [System.IO.File]::ReadAllText($Mailbox) } else { '' }
    $max = 0
    foreach ($m in [regex]::Matches($text, '(?m)^#{2,3} \[?' + $As + '-(\d+)\]?')) {
        $n = [int]$m.Groups[1].Value
        if ($n -gt $max) { $max = $n }
    }

    $id = '{0}-{1}' -f $As, ($max + 1)
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
    $message = "`r`n### [{0}] {1} -> {2}, {3}`r`n{4}`r`n" -f $id, $names[$As], $To, $stamp, ($Body -replace "`r?`n", "`r`n")
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $stream = [System.IO.File]::Open($Mailbox, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try {
        $bytes = $utf8.GetBytes($message)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    finally { $stream.Dispose() }

    Write-Output ("POSTED {0}" -f $id)

    # Fast event notification to broker
    try {
        $publishUrl = "http://127.0.0.1:$HttpPort/publish"
        $headers = @{
            'Authorization' = "Bearer $AuthToken"
            'Content-Type' = 'application/json'
        }
        $payload = @{
            message = @{
                id = $id
                party = $As
                sender = $names[$As]
                recipientRaw = $To
                timestamp = $stamp
                mailboxPath = $Mailbox
            }
        } | ConvertTo-Json
        $null = Invoke-RestMethod -Uri $publishUrl -Method Post -Headers $headers -Body $payload -TimeoutSec 2 -ErrorAction SilentlyContinue
    }
    catch {
        # Broker notification is best-effort optimization; file append is authoritative
    }

    exit 0
}
catch {
    Write-Output ("MailboxPostSocket: failed: {0}" -f $_.Exception.Message)
    exit 1
}
finally {
    if ($got) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
