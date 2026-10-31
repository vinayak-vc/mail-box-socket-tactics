/**
 * EmailDomainService.js
 * Transactional email notifications to the Human Owner via the Brevo (Sendinblue) API.
 * 
 * Based on the reference architecture in Licenese-Validator/functions/emailService.js:
 * Endpoint: POST https://api.brevo.com/v3/smtp/email
 * Auth:     `api-key` header
 * 
 * Enables AI Team Leads (Codex, Claude) and contributors (Antigravity) to send
 * email notifications to the owner for decisions needed, blockers, and milestones.
 */

const fs = require('fs');
const path = require('path');

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const SEND_TIMEOUT_MS = 12000;

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseRecipients(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,;]/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && entry.includes('@'))
    .map(email => ({ email }));
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return 'none';
  const parts = email.trim().split('@');
  if (parts.length !== 2) return '***';
  const name = parts[0];
  const domain = parts[1];
  const maskedName = name.length > 2 ? `${name.slice(0, 2)}***` : `${name.slice(0, 1)}***`;
  return `${maskedName}@${domain}`;
}

class EmailDomainService {
  constructor(options = {}) {
    this.envPath = options.envPath || path.resolve(__dirname, '../../config/.env');
    this.logger = options.logger || console;
    this.cachedConfig = null;
  }

  /**
   * Loads and caches configuration from process.env with fallback to config/.env
   */
  getConfig(forceReload = false) {
    if (this.cachedConfig && !forceReload) {
      return this.cachedConfig;
    }

    // Read config/.env if not present in process.env
    let fileEnv = {};
    if (fs.existsSync(this.envPath)) {
      try {
        const raw = fs.readFileSync(this.envPath, 'utf8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx > 0) {
            const key = trimmed.substring(0, idx).trim();
            const val = trimmed.substring(idx + 1).trim();
            fileEnv[key] = val;
          }
        }
      } catch (_) {}
    }

    const apiKey = (process.env.BREVO_API_KEY || fileEnv.BREVO_API_KEY || '').trim();
    const ownerEmail = (process.env.OWNER_EMAIL || fileEnv.OWNER_EMAIL || process.env.RECEIVER_EMAIL || fileEnv.RECEIVER_EMAIL || '').trim();
    const senderEmail = (process.env.BREVO_SENDER_EMAIL || fileEnv.BREVO_SENDER_EMAIL || process.env.SENDER_EMAIL || fileEnv.SENDER_EMAIL || ownerEmail).trim();
    const senderName = (process.env.BREVO_SENDER_NAME || fileEnv.BREVO_SENDER_NAME || 'MailSocketTactics AI Team').trim();
    const recipients = parseRecipients(ownerEmail);

    this.cachedConfig = {
      apiKey,
      ownerEmail,
      senderEmail,
      senderName,
      recipients,
      isConfigured: !!(apiKey && senderEmail && recipients.length > 0)
    };

    return this.cachedConfig;
  }

  /**
   * Returns safe status object for dashboard telemetry and MCP status
   */
  getStatus() {
    const config = this.getConfig();
    return {
      enabled: config.isConfigured,
      hasApiKey: !!config.apiKey,
      ownerEmailConfigured: config.recipients.length > 0,
      ownerEmailMasked: config.ownerEmail ? maskEmail(config.ownerEmail) : 'not_set',
      senderEmailMasked: config.senderEmail ? maskEmail(config.senderEmail) : 'not_set',
      senderName: config.senderName
    };
  }

  /**
   * Low-level Brevo API send
   */
  async sendBrevoEmail({ to, subject, htmlContent, textContent }) {
    const config = this.getConfig();

    if (!config.apiKey) {
      throw new Error('BREVO_API_KEY is not configured in .env');
    }
    if (!config.senderEmail) {
      throw new Error('BREVO_SENDER_EMAIL (or OWNER_EMAIL) is not configured');
    }
    if (!Array.isArray(to) || to.length === 0) {
      throw new Error('No valid email recipients configured in OWNER_EMAIL');
    }

    const payload = {
      sender: { email: config.senderEmail, name: config.senderName },
      to,
      subject,
      htmlContent
    };
    if (textContent) {
      payload.textContent = textContent;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(BREVO_ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': config.apiKey,
          'content-type': 'application/json',
          'accept': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Brevo send failed (${response.status}): ${bodyText}`);
    }

    try {
      return JSON.parse(bodyText);
    } catch (_) {
      return { raw: bodyText };
    }
  }

  /**
   * Formats HTML email for AI Lead / Agent notifications to the Owner
   */
  buildNotificationHtml({ senderAgent, subject, message, urgency = 'DECISION_NEEDED', taskReference = null, metadata = {} }) {
    const urgencyColors = {
      DECISION_NEEDED: { bg: '#fef3c7', text: '#92400e', border: '#f59e0b', label: 'DECISION NEEDED' },
      URGENT_BLOCKER: { bg: '#fee2e2', text: '#991b1b', border: '#ef4444', label: 'URGENT BLOCKER' },
      MILESTONE_REACHED: { bg: '#dcfce7', text: '#166534', border: '#10b981', label: 'MILESTONE REACHED' },
      REVIEW_REQUESTED: { bg: '#e0e7ff', text: '#3730a3', border: '#6366f1', label: 'REVIEW REQUESTED' },
      GENERAL_UPDATE: { bg: '#f1f5f9', text: '#334155', border: '#94a3b8', label: 'UPDATE' }
    };

    const urgencyStyle = urgencyColors[urgency] || urgencyColors.DECISION_NEEDED;
    const dateStr = new Date().toLocaleString('en-US', { timeZoneName: 'short' });

    // Format paragraphs from message
    const formattedMessageHtml = escapeHtml(message)
      .split('\n\n')
      .map(p => `<p style="margin: 0 0 12px 0; line-height: 1.6;">${p.replace(/\n/g, '<br/>')}</p>`)
      .join('');

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f8fafc;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0f172a; padding: 24px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #1e293b; border: 1px solid #334155; border-radius: 10px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.4);">
          
          <!-- Header -->
          <tr>
            <td style="padding: 24px 28px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border-bottom: 1px solid #334155;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.1em; color: #38bdf8; text-transform: uppercase;">MailSocketTactics Team Notification</span>
                    <h1 style="margin: 6px 0 0 0; font-size: 20px; font-weight: 700; color: #ffffff;">${escapeHtml(subject)}</h1>
                  </td>
                  <td align="right" valign="top">
                    <span style="display: inline-block; padding: 4px 10px; font-size: 11px; font-weight: 700; border-radius: 20px; background-color: ${urgencyStyle.bg}; color: ${urgencyStyle.text}; border: 1px solid ${urgencyStyle.border};">
                      ${urgencyStyle.label}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Metadata Bar -->
          <tr>
            <td style="padding: 12px 28px; background-color: #0b1120; border-bottom: 1px solid #334155; font-size: 12px; color: #94a3b8;">
              <strong>From:</strong> <span style="color: #38bdf8;">${escapeHtml(senderAgent)}</span>
              ${taskReference ? ` &nbsp;|&nbsp; <strong>Task Ref:</strong> <code style="background: rgba(56,189,248,0.15); color: #38bdf8; padding: 2px 6px; border-radius: 4px;">${escapeHtml(taskReference)}</code>` : ''}
              &nbsp;|&nbsp; <strong>Time:</strong> ${escapeHtml(dateStr)}
            </td>
          </tr>

          <!-- Message Body -->
          <tr>
            <td style="padding: 28px; font-size: 14px; color: #e2e8f0; line-height: 1.6;">
              ${formattedMessageHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 16px 28px; background-color: #0b1120; border-top: 1px solid #334155; font-size: 11px; color: #64748b; text-align: center;">
              This notification was dispatched by AI Agent <strong>${escapeHtml(senderAgent)}</strong> via the MailSocketTactics Event Broker & Shared MCP Server.<br/>
              Authoritative Mailbox: <code style="color: #94a3b8;">TEAM_MAILBOX.md</code>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  /**
   * Dispatches an email notification to the Human Owner.
   * Safe execution: logs cleanly and returns outcome status.
   */
  async sendOwnerEmail({ senderAgent = 'AI Team Lead', subject, message, urgency = 'DECISION_NEEDED', taskReference = null, metadata = {} }) {
    const config = this.getConfig();

    if (!config.isConfigured) {
      const missing = [];
      if (!config.apiKey) missing.push('BREVO_API_KEY');
      if (config.recipients.length === 0) missing.push('OWNER_EMAIL/RECEIVER_EMAIL');
      const reason = `Email notification skipped: missing ${missing.join(', ')} in config/.env`;
      if (this.logger.warn) this.logger.warn(`[EmailDomainService] ${reason}`);
      return { status: 'skipped', reason };
    }

    if (!subject || !message) {
      throw new Error("Missing required fields: 'subject', 'message'");
    }

    const htmlContent = this.buildNotificationHtml({
      senderAgent,
      subject,
      message,
      urgency,
      taskReference,
      metadata
    });

    const textContent = [
      `[MailSocketTactics] ${urgency}: ${subject}`,
      `From: ${senderAgent}`,
      taskReference ? `Task Reference: ${taskReference}` : '',
      `Date: ${new Date().toISOString()}`,
      '',
      '----------------------------------------',
      message,
      '----------------------------------------',
      '',
      'Authoritative Mailbox: TEAM_MAILBOX.md'
    ].filter(Boolean).join('\n');

    try {
      const result = await this.sendBrevoEmail({
        to: config.recipients,
        subject: `[MailSocketTactics] ${subject}`,
        htmlContent,
        textContent
      });

      if (this.logger.log) {
        this.logger.log({
          level: 'INFO',
          type: 'OWNER_EMAIL_SENT',
          agentId: senderAgent,
          summary: `Sent email to owner '${maskEmail(config.ownerEmail)}' for '${subject}'`
        });
      }

      return {
        status: 'sent',
        messageId: result?.messageId || result?.raw || 'success',
        recipients: config.recipients.map(r => maskEmail(r.email))
      };
    } catch (err) {
      if (this.logger.error) {
        this.logger.error(`[EmailDomainService] Email send error: ${err.message}`);
      }
      return {
        status: 'error',
        reason: err.message
      };
    }
  }

  /**
   * Alias for sendOwnerEmail
   */
  async sendOwnerNotification(options) {
    return this.sendOwnerEmail(options);
  }
}

module.exports = EmailDomainService;
