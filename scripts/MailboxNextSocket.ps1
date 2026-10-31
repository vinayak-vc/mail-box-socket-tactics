# MailboxNextSocket.ps1
# Event-driven drop-in replacement for MailboxNext.ps1.
# Replaces 5-second polling loops with an event-driven WebSocket listener.
# Uses explicit recipient matching: only wakes when a message is addressed to -Me.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\MailboxNextSocket.ps1 -Me <C|X|A> [-SeenCount N] [-Seconds 300] [-Mailbox path] [-WsPort 8765] [-AuthToken token]
param(
    [Parameter(Mandatory = $true)][ValidateSet('C', 'X', 'A', 'H')][string]$Me,
    [int]$SeenCount = -1,
    [int]$Seconds = 300,
    [string]$Mailbox = '',
    [int]$WsPort = 8765,
    [string]$AuthToken = ''
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

$agentName = switch ($Me) { 'C' { 'Claude' } 'X' { 'Codex' } 'A' { 'Antigravity' } 'H' { 'Owner' } }

function Test-IsRecipientMatch([string]$partyCode, [string]$recipientText) {
    if (-not $recipientText) { return $false }
    $tokens = $recipientText.ToLower() -split '[,/&]|\band\b'
    foreach ($tok in $tokens) {
        $t = $tok.Trim()
        if ($t -eq 'all' -or $t -eq 'everyone' -or $t -eq 'team') { return $true }
        if ($partyCode -eq 'C' -and ($t -eq 'claude' -or $t -eq 'c' -or $t -like 'claude *' -or $t -like '*(tech lead)*')) { return $true }
        if ($partyCode -eq 'X' -and ($t -eq 'codex' -or $t -eq 'x' -or $t -like 'codex *' -or $t -like '*independent critic*')) { return $true }
        if ($partyCode -eq 'A' -and ($t -eq 'antigravity' -or $t -eq 'a' -or $t -eq 'ag' -or $t -like 'antigravity *' -or $t -like '*c++ implementer*')) { return $true }
        if ($partyCode -eq 'H' -and ($t -eq 'owner' -or $t -eq 'h' -or $t -like 'owner *' -or $t -like '*human*')) { return $true }
    }
    return $false
}

function Read-ParsedMailbox {
    if (-not (Test-Path $Mailbox)) {
        return @{ Text = ''; Heads = @() }
    }
    $text = [System.IO.File]::ReadAllText($Mailbox)
    $pattern = '(?m)^[ \t]*###[ \t]+\[(?<p>[A-Z]+)-(?<n>\d+)\][ \t]+(?<from>[^-\r\n>]+?)[ \t]*->[ \t]*(?<to>.+?)(?:,[ \t]*(?<time>\d{4}-\d{2}-\d{2}[^\r\n]*?))?\s*$'
    $matches = [regex]::Matches($text, $pattern)
    return @{ Text = $text; Heads = $matches }
}

if ($SeenCount -lt 0) {
    try { $r = Read-ParsedMailbox } catch { Write-Output "MailboxNextSocket: the mailbox could not be read: $($_.Exception.Message)"; exit 1 }
    Write-Output ("MailboxNextSocket: first call, {0} messages exist" -f $r.Heads.Count)
    Write-Output ("NEXT_SEEN_COUNT={0}" -f $r.Heads.Count)
    exit 0
}

# 1. Fast path: check if messages addressed to $Me exist right now
$r = Read-ParsedMailbox
if ($r.Heads.Count -gt $SeenCount) {
    $heads = $r.Heads
    $text = $r.Text
    $out = @()
    for ($i = $SeenCount; $i -lt $heads.Count; $i++) {
        $head = $heads[$i]
        $sender = $head.Groups['p'].Value
        $to = $head.Groups['to'].Value.Trim()
        
        # Sender cannot be self, and recipient must explicitly match $Me
        if ($sender -eq $Me) { continue }
        if (-not (Test-IsRecipientMatch $Me $to)) { continue }

        $end = if ($i + 1 -lt $heads.Count) { $heads[$i + 1].Index } else { $text.Length }
        $body = $text.Substring($head.Index, $end - $head.Index)
        $out += $body
    }
    $seen = $heads.Count
    if ($out.Count -gt 0) {
        Write-Output ("MailboxNextSocket: {0} NEW MESSAGE(S)" -f $out.Count)
        $out | ForEach-Object { Write-Output $_ }
        Write-Output ("NEXT_SEEN_COUNT={0}" -f $seen)
        exit 0
    }
}

# 2. Event-driven path: Connect via WebSocket to wait for notification
Write-Output ("MailboxNextSocket: {0} listening via socket (ws://127.0.0.1:{1}) after message #{2}, timeout {3} s" -f $Me, $WsPort, $SeenCount, $Seconds)

$wsUri = [System.Uri]"ws://127.0.0.1:$WsPort"
$cts = New-Object System.Threading.CancellationTokenSource
$cts.CancelAfter([System.TimeSpan]::FromSeconds($Seconds))

$client = New-Object System.Net.WebSockets.ClientWebSocket
$connected = $false

try {
    $connectTask = $client.ConnectAsync($wsUri, $cts.Token)
    $connectTask.Wait(4000)
    if ($client.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        $connected = $true
        # Send Auth
        $authJson = '{"type":"AUTH_REQUEST","agentId":"' + $agentName + '","token":"' + $AuthToken + '"}'
        $authBytes = [System.Text.Encoding]::UTF8.GetBytes($authJson)
        $client.SendAsync([System.ArraySegment[byte]]$authBytes, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).Wait(2000)

        # Receive loop waiting for notification
        $buffer = New-Object byte[] 4096
        while ($client.State -eq [System.Net.WebSockets.WebSocketState]::Open -and -not $cts.IsCancellationRequested) {
            $segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$buffer)
            $recvTask = $client.ReceiveAsync($segment, $cts.Token)
            $recvTask.Wait()
            $result = $recvTask.Result

            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                break
            }

            $rawMsg = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
            if ($rawMsg -match '"type"\s*:\s*"PING"') {
                $pong = '{"type":"PONG","agentId":"' + $agentName + '"}'
                $pongBytes = [System.Text.Encoding]::UTF8.GetBytes($pong)
                $client.SendAsync([System.ArraySegment[byte]]$pongBytes, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).Wait(1000)
                continue
            }

            if ($rawMsg -match '"type"\s*:\s*"MAILBOX_MESSAGE_NOTIFY"') {
                # Event arrived! Re-read mailbox and output matching messages
                $r = Read-ParsedMailbox
                $heads = $r.Heads
                $text = $r.Text
                $out = @()
                for ($i = $SeenCount; $i -lt $heads.Count; $i++) {
                    $head = $heads[$i]
                    $sender = $head.Groups['p'].Value
                    $to = $head.Groups['to'].Value.Trim()
                    if ($sender -eq $Me) { continue }
                    if (-not (Test-IsRecipientMatch $Me $to)) { continue }

                    $end = if ($i + 1 -lt $heads.Count) { $heads[$i + 1].Index } else { $text.Length }
                    $out += $text.Substring($head.Index, $end - $head.Index)
                }
                $seen = $heads.Count
                if ($out.Count -gt 0) {
                    Write-Output ("MailboxNextSocket: EVENT RECEIVED - {0} NEW MESSAGE(S)" -f $out.Count)
                    $out | ForEach-Object { Write-Output $_ }
                    Write-Output ("NEXT_SEEN_COUNT={0}" -f $seen)
                    exit 0
                }
            }
        }
    }
}
catch [System.AggregateException] {
    if ($_.InnerException -is [System.OperationCanceledException]) {
        Write-Output ("MailboxNextSocket: TIMEOUT, nothing new for {0} after message #{1}" -f $Me, $SeenCount)
        Write-Output ("NEXT_SEEN_COUNT={0}" -f $SeenCount)
        exit 2
    }
}
catch {
    Write-Output ("MailboxNextSocket: Notice: " + $_.Exception.Message)
}
finally {
    if ($client.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        try { $client.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'Closing', [System.Threading.CancellationToken]::None).Wait(1000) } catch {}
    }
    $client.Dispose()
    $cts.Dispose()
}

Write-Output ("MailboxNextSocket: TIMEOUT, nothing new for {0} after message #{1}" -f $Me, $SeenCount)
Write-Output ("NEXT_SEEN_COUNT={0}" -f $SeenCount)
exit 2
