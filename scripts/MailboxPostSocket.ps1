# MailboxPostSocket.ps1
# Appends ONE message to TEAM_MAILBOX.md under a named mutex,
# then immediately notifies the Event Broker for instant (<15ms) event-driven dispatch.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\MailboxPostSocket.ps1 -As X -To Claude -BodyFile path\to\message.txt
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\MailboxPostSocket.ps1 -As A -To Claude -Body "TASK: ...`nSTATUS: ..."
# Multi-project:
#   -Mailbox <path> -MutexName 'Global\MusicalTambolaMailbox' -Format tel -Project musical-tambola [-Status OPEN]
#   -Format broker (default) writes "### [C-12] Claude -> Codex, yyyy-MM-dd HH:mm"
#   -Format tel             writes "## [MSG-003] C -> A | yyyy-MM-dd HH:mm | OPEN" (global MSG numbering, local time)
param(
    [Parameter(Mandatory = $true)][ValidateSet('C', 'X', 'A', 'H')][string]$As,
    [Parameter(Mandatory = $true)][string]$To,
    [string]$Body = '',
    [string]$BodyFile = '',
    [string]$Mailbox = '',
    [int]$HttpPort = 8766,
    [string]$AuthToken = '',
    [string]$MutexName = 'Global\OneBossFightMailbox',
    [ValidateSet('broker', 'tel')][string]$Format = 'broker',
    [string]$Project = '',
    [ValidateSet('OPEN', 'ACK', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'REVIEW', 'ACCEPTED', 'CHANGES_REQUESTED')][string]$Status = 'OPEN'
)

$ErrorActionPreference = 'Stop'

# Resolve the broker auth token: explicit -AuthToken, then $env:MAILBOX_AUTH_TOKEN, then config\.env.
# No built-in default token: the token is a secret and must never be hardcoded.
if (-not $AuthToken) { $AuthToken = $env:MAILBOX_AUTH_TOKEN }
if (-not $AuthToken) {
    $envFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'config\.env'
    if (Test-Path $envFile) {
        $line = Select-String -Path $envFile -Pattern '^\s*MAILBOX_AUTH_TOKEN\s*=\s*(.+)$' | Select-Object -First 1
        if ($line) { $AuthToken = $line.Matches[0].Groups[1].Value.Trim() }
    }
}


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
if ($Format -eq 'tel' -and $Body -match '(?m)^##\s*\[') { Write-Output 'MailboxPostSocket: the body must not contain a "## [MSG-###]" heading line: the script writes it'; exit 1 }
if ($MutexName -notmatch '^(Global\\|Local\\)?[A-Za-z0-9_.-]{1,200}$') { Write-Output 'MailboxPostSocket: invalid -MutexName'; exit 1 }

$names = @{ C = 'Claude'; X = 'Codex'; A = 'Antigravity'; H = 'Owner' }
$mutex = New-Object System.Threading.Mutex($false, $MutexName)
$got = $false

# Maps agent names in -To to party codes for the compact "tel" header (C -> A, X)
function ConvertTo-PartyCodes([string]$recipients) {
    $codes = foreach ($tok in ($recipients -split '\s*[,/&]\s*')) {
        $t = $tok.Trim()
        if (-not $t) { continue }
        switch -Regex ($t.ToLowerInvariant()) {
            '^(c|claude.*)$' { 'C'; break }
            '^(x|codex.*)$' { 'X'; break }
            '^(a|ag|antigravity.*)$' { 'A'; break }
            '^(h|owner|human)$' { 'H'; break }
            default { $t }
        }
    }
    return ($codes -join ', ')
}

try {
    # The mutex is held from reading the current max number until the append is flushed,
    # so two posters can never pick the same number.
    try {
        $got = $mutex.WaitOne(15000)
    }
    catch [System.Threading.AbandonedMutexException] {
        # A previous holder died without releasing. Windows hands ownership to us, so carry on.
        $got = $true
    }
    if (-not $got) { Write-Output 'MailboxPostSocket: could not get the mailbox lock in 15 s'; exit 1 }

    # Read with FileShare.ReadWrite so an editor or watcher that has the file open does not fail the post
    $text = ''
    if (Test-Path $Mailbox) {
        $rs = [System.IO.File]::Open($Mailbox, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try { $text = (New-Object System.IO.StreamReader($rs, [System.Text.Encoding]::UTF8)).ReadToEnd() }
        finally { $rs.Dispose() }
    }
    $max = 0
    $body = ($Body -replace "`r?`n", "`r`n")
    if ($Format -eq 'tel') {
        # Global numbering across all senders: ## [MSG-###]
        foreach ($m in [regex]::Matches($text, '(?m)^##\s+\[MSG-(\d+)\]')) {
            $n = [int]$m.Groups[1].Value
            if ($n -gt $max) { $max = $n }
        }
        $id = 'MSG-{0:D3}' -f ($max + 1)
        # Local date + time, same as the broker format (older tel headers are date-only; both parse)
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
        $senderLabel = $As
        $recipientLabel = ConvertTo-PartyCodes $To
        $message = "`r`n## [{0}] {1} -> {2} | {3} | {4}`r`n{5}`r`n" -f $id, $As, $recipientLabel, $stamp, $Status, $body
    } else {
        foreach ($m in [regex]::Matches($text, '(?m)^#{2,3} \[?' + $As + '-(\d+)\]?')) {
            $n = [int]$m.Groups[1].Value
            if ($n -gt $max) { $max = $n }
        }
        $id = '{0}-{1}' -f $As, ($max + 1)
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
        $senderLabel = $names[$As]
        $recipientLabel = $To
        $message = "`r`n### [{0}] {1} -> {2}, {3}`r`n{4}`r`n" -f $id, $names[$As], $To, $stamp, $body
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $stream = [System.IO.File]::Open($Mailbox, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try {
        $bytes = $utf8.GetBytes($message)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    finally { $stream.Dispose() }

    # The append is on disk: release the lock now. The broker notification below is a network call
    # (up to 2 s when the broker is down) and must not keep other posters waiting.
    $mutex.ReleaseMutex()
    $got = $false

    Write-Output ("POSTED {0}" -f $id)

    # Fast event notification to broker
    try {
        $publishUrl = "http://127.0.0.1:$HttpPort/publish"
        $headers = @{
            'Authorization' = "Bearer $AuthToken"
            'Content-Type' = 'application/json'
        }
        $payload = @{
            project = $Project
            message = @{
                id = $id
                party = $As
                sender = $senderLabel
                recipientRaw = $recipientLabel
                timestamp = $stamp
                mailboxPath = $Mailbox
                project = $Project
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
