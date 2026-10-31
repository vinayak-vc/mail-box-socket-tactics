/**
 * test_email_service.js
 * Unit and integration tests for EmailDomainService (Brevo transactional email integration).
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const EmailDomainService = require('../src/domain/EmailDomainService');

let passed = 0;
let failed = 0;

function report(name, ok, err) {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.error(`[FAIL] ${name}: ${err ? err.message : ''}`);
    if (err && err.stack) console.error(err.stack);
  }
}

async function runTests() {
  console.log('===================================================================');
  console.log('   MAILSOCKETTACTICS EMAIL NOTIFICATION SERVICE TEST SUITE        ');
  console.log('===================================================================\n');

  const testEnvPath = path.resolve(__dirname, 'temp_test.env');

  // Test 1: Graceful behavior when not configured
  try {
    fs.writeFileSync(testEnvPath, '# Empty env\n', 'utf8');
    const emailService = new EmailDomainService({ envPath: testEnvPath });
    const status = emailService.getStatus();
    assert.strictEqual(status.enabled, false);
    assert.strictEqual(status.hasApiKey, false);
    assert.strictEqual(status.ownerEmailConfigured, false);

    const sendRes = await emailService.sendOwnerEmail({
      subject: 'Test Subject',
      message: 'Test message body'
    });
    assert.strictEqual(sendRes.status, 'skipped');
    assert.ok(sendRes.reason.includes('missing'));

    report('Test 1: Graceful skip when BREVO_API_KEY or OWNER_EMAIL not configured', true);
  } catch (e) {
    report('Test 1: Graceful skip when BREVO_API_KEY or OWNER_EMAIL not configured', false, e);
  }

  // Test 2: Configuration loading and email masking
  try {
    fs.writeFileSync(testEnvPath, [
      'BREVO_API_KEY=xkeysib-mock-1234567890abcdef',
      'OWNER_EMAIL=boss.lead@example.com',
      'BREVO_SENDER_NAME=Custom MailBox Tactics'
    ].join('\n'), 'utf8');

    const emailService = new EmailDomainService({ envPath: testEnvPath });
    const config = emailService.getConfig(true);
    assert.strictEqual(config.isConfigured, true);
    assert.strictEqual(config.apiKey, 'xkeysib-mock-1234567890abcdef');
    assert.strictEqual(config.recipients.length, 1);
    assert.strictEqual(config.recipients[0].email, 'boss.lead@example.com');
    assert.strictEqual(config.senderName, 'Custom MailBox Tactics');

    const status = emailService.getStatus();
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.hasApiKey, true);
    assert.strictEqual(status.ownerEmailConfigured, true);
    assert.ok(status.ownerEmailMasked.includes('***@example.com'));
    assert.ok(!status.ownerEmailMasked.includes('boss.lead'));

    report('Test 2: Proper configuration parsing and privacy email masking', true);
  } catch (e) {
    report('Test 2: Proper configuration parsing and privacy email masking', false, e);
  }

  // Test 3: HTML and text template rendering
  try {
    const emailService = new EmailDomainService({ envPath: testEnvPath });
    const html = emailService.buildNotificationHtml({
      senderAgent: 'Codex (Technical Lead)',
      subject: 'Critical Boss Stagger Logic Review',
      message: 'Line 42 requires confirmation:\n\nShould stamina damage penetrate armor block?',
      urgency: 'DECISION_NEEDED',
      taskReference: 'X-280'
    });

    assert.ok(html.includes('Critical Boss Stagger Logic Review'));
    assert.ok(html.includes('Codex (Technical Lead)'));
    assert.ok(html.includes('DECISION NEEDED'));
    assert.ok(html.includes('X-280'));
    assert.ok(html.includes('Should stamina damage penetrate armor block?'));
    assert.ok(html.includes('TEAM_MAILBOX.md'));

    report('Test 3: HTML notification template incorporates agent, urgency, and task reference', true);
  } catch (e) {
    report('Test 3: HTML notification template incorporates agent, urgency, and task reference', false, e);
  }

  // Test 4: Validation errors on missing parameters
  try {
    const emailService = new EmailDomainService({ envPath: testEnvPath });
    let threw = false;
    try {
      await emailService.sendOwnerEmail({ subject: 'Missing message' });
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('Missing required fields'));
    }
    assert.strictEqual(threw, true);
    report('Test 4: Strict validation rejects missing subject or message fields', true);
  } catch (e) {
    report('Test 4: Strict validation rejects missing subject or message fields', false, e);
  }

  // Test 5: Multiple comma-separated recipients support
  try {
    fs.writeFileSync(testEnvPath, [
      'BREVO_API_KEY=xkeysib-mock-test',
      'OWNER_EMAIL=primary@example.com, backup@example.com ; mobile@example.com'
    ].join('\n'), 'utf8');

    const emailService = new EmailDomainService({ envPath: testEnvPath });
    const config = emailService.getConfig(true);
    assert.strictEqual(config.recipients.length, 3);
    assert.strictEqual(config.recipients[0].email, 'primary@example.com');
    assert.strictEqual(config.recipients[1].email, 'backup@example.com');
    assert.strictEqual(config.recipients[2].email, 'mobile@example.com');

    report('Test 5: Multiple owner recipients parsed cleanly across comma and semicolon delimiters', true);
  } catch (e) {
    report('Test 5: Multiple owner recipients parsed cleanly across comma and semicolon delimiters', false, e);
  }

  // Cleanup
  if (fs.existsSync(testEnvPath)) {
    try { fs.unlinkSync(testEnvPath); } catch (_) {}
  }

  console.log('\n===================================================================');
  console.log(`EMAIL SERVICE TEST SUMMARY: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('===================================================================');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Fatal email service test error:', err);
  process.exit(1);
});
