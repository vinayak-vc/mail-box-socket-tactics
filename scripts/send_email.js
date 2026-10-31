#!/usr/bin/env node
/**
 * send_email.js
 * Cross-platform CLI utility to dispatch email notifications to the Human Owner via Brevo API.
 * Usage: node scripts/send_email.js --subject "Subject" --message "Message body" [--urgency DECISION_NEEDED] [--agent "Codex"]
 */

const EmailDomainService = require('../src/domain/EmailDomainService');

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    subject: '',
    message: '',
    urgency: 'DECISION_NEEDED',
    senderAgent: 'AI Team Lead',
    taskReference: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--subject' || arg === '-s') && args[i + 1]) {
      params.subject = args[++i];
    } else if ((arg === '--message' || arg === '-m') && args[i + 1]) {
      params.message = args[++i];
    } else if ((arg === '--urgency' || arg === '-u') && args[i + 1]) {
      params.urgency = args[++i];
    } else if ((arg === '--agent' || arg === '-a') && args[i + 1]) {
      params.senderAgent = args[++i];
    } else if ((arg === '--task' || arg === '-t') && args[i + 1]) {
      params.taskReference = args[++i];
    }
  }

  return params;
}

async function main() {
  const params = parseArgs();
  if (!params.subject || !params.message) {
    console.error('Usage: node scripts/send_email.js --subject "<subject>" --message "<message>" [--urgency <level>] [--agent <name>]');
    process.exit(1);
  }

  const emailService = new EmailDomainService();
  const status = emailService.getStatus();

  if (!status.enabled) {
    console.error('Email notifications are not configured. Ensure BREVO_API_KEY and OWNER_EMAIL or RECEIVER_EMAIL are set in config/.env');
    process.exit(1);
  }

  console.log(`Sending email notification to owner (${status.ownerEmailMasked})...`);
  const result = await emailService.sendOwnerEmail({
    subject: params.subject,
    message: params.message,
    urgency: params.urgency,
    senderAgent: params.senderAgent,
    taskReference: params.taskReference
  });

  if (result.status === 'sent') {
    console.log(`✓ Email sent successfully! MessageId: ${result.messageId}`);
    process.exit(0);
  } else {
    console.error(`✗ Failed to send email: ${result.reason}`);
    process.exit(2);
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
