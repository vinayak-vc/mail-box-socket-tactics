# SendOwnerEmail.ps1
# Sends a transactional email notification directly to the Human Owner via Brevo API.
# Used by AI Team Leads (Codex, Claude, Antigravity) and human operators.

param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Subject,
    [Parameter(Mandatory = $true, Position = 1)][string]$Message,
    [ValidateSet('DECISION_NEEDED', 'URGENT_BLOCKER', 'MILESTONE_REACHED', 'REVIEW_REQUESTED', 'GENERAL_UPDATE')][string]$Urgency = 'DECISION_NEEDED',
    [string]$SenderAgent = 'AI Team Lead',
    [string]$TaskReference = $null
)

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$projectRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " MailSocketTactics: Notify Human Owner (Email)   " -ForegroundColor Green
Write-Host " Urgency: $Urgency | Sender: $SenderAgent" -ForegroundColor Yellow
Write-Host "=================================================" -ForegroundColor Cyan

$nodeScript = @"
const path = require('path');
const EmailDomainService = require('./src/domain/EmailDomainService');
const emailService = new EmailDomainService({
  envPath: path.resolve('$($projectRoot.Replace('\', '/'))', 'config/.env'),
  logger: { log: () => {}, warn: () => {}, error: () => {} }
});

async function run() {
  const status = emailService.getStatus();
  if (!status.enabled) {
    console.error(JSON.stringify({ error: 'Email service is not configured. Check BREVO_API_KEY and OWNER_EMAIL/RECEIVER_EMAIL in config/.env' }));
    process.exit(1);
  }

  const result = await emailService.sendOwnerEmail({
    senderAgent: process.env.MST_SENDER || '$SenderAgent',
    subject: process.env.MST_SUBJECT,
    message: process.env.MST_MESSAGE,
    urgency: process.env.MST_URGENCY || 'DECISION_NEEDED',
    taskReference: process.env.MST_TASK_REF || null
  });

  console.log(JSON.stringify(result));
  if (result.status === 'error') {
    process.exit(2);
  }
}

run().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
"@

$env:MST_SUBJECT = $Subject
$env:MST_MESSAGE = $Message
$env:MST_URGENCY = $Urgency
$env:MST_SENDER = $SenderAgent
$env:MST_TASK_REF = if ($TaskReference) { $TaskReference } else { "" }

Push-Location $projectRoot
try {
    $output = node -e "$nodeScript"
    $jsonLine = ($output | Where-Object { $_ -and $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    $parsed = if ($jsonLine) { $jsonLine | ConvertFrom-Json -ErrorAction SilentlyContinue } else { $null }
    if ($parsed -and $parsed.status -eq 'sent') {
        Write-Host "Email successfully sent to owner!" -ForegroundColor Green
        Write-Host "Message ID: $($parsed.messageId)" -ForegroundColor Cyan
        Write-Host "Recipients: $($parsed.recipients -join ', ')" -ForegroundColor Gray
    } elseif ($parsed -and $parsed.status -eq 'skipped') {
        Write-Host "Email skipped: $($parsed.reason)" -ForegroundColor Yellow
    } elseif ($parsed -and $parsed.status -eq 'error') {
        Write-Host "Failed to send email: $($parsed.reason)" -ForegroundColor Red
        exit 2
    } else {
        Write-Host "Output: $output"
    }
} finally {
    $env:MST_SUBJECT = $null
    $env:MST_MESSAGE = $null
    $env:MST_URGENCY = $null
    $env:MST_SENDER = $null
    $env:MST_TASK_REF = $null
    Pop-Location
}
