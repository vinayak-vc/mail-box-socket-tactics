/**
 * MessageProtocol.js
 * Core protocol definition, heading parser, recipient matching, and event types
 * for the MailBox Socket Tactics event-driven system.
 */

const EVENT_TYPES = {
  AUTH_REQUEST: 'AUTH_REQUEST',
  AUTH_RESPONSE: 'AUTH_RESPONSE',
  SUBSCRIBE: 'SUBSCRIBE',
  SUBSCRIBE_ACK: 'SUBSCRIBE_ACK',
  MAILBOX_MESSAGE_NOTIFY: 'MAILBOX_MESSAGE_NOTIFY',
  MESSAGE_ACK: 'MESSAGE_ACK',
  LEASE_RENEW: 'LEASE_RENEW',
  LEASE_RENEW_ACK: 'LEASE_RENEW_ACK',
  PING: 'PING',
  PONG: 'PONG',
  PUBLISH_NOTIFY: 'PUBLISH_NOTIFY',
  REPLAY_REQUEST: 'REPLAY_REQUEST',
  REQUEUE_REQUEST: 'REQUEUE_REQUEST',
  STATUS_QUERY: 'STATUS_QUERY',
  STATUS_RESPONSE: 'STATUS_RESPONSE'
};

const PROCESSING_STATUS = {
  PENDING: 'PENDING',
  CLAIMED: 'CLAIMED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  RETRYABLE_FAILED: 'RETRYABLE_FAILED',
  DEAD_LETTER: 'DEAD_LETTER'
};

// Strict heading regex:
// Matches: ### [C-237] Claude -> Antigravity, 2026-10-28 16:02
// Matches: ### [H-1] Owner -> Claude,Codex, 2026-10-28 10:00:00
// Matches: ### [A-170] Antigravity -> Claude,Codex,Owner, 2026-10-28 16:01
const HEADING_REGEX = /^[ \t]*###[ \t]+\[(?<party>[A-Z]+)-(?<number>\d+)\][ \t]+(?<sender>[^-\r\n>]+?)[ \t]*->[ \t]*(?<recipient>.+?)(?:,[ \t]*(?<timestamp>\d{4}-\d{2}-\d{2}[^\r\n]*))?$/gm;

/**
 * Checks if a recipient string includes a specific agent ID.
 * Parses multi-recipient strings split by comma, ampersand, slash, or "and".
 */
function isRecipientMatch(agentId, recipientString) {
  if (!recipientString || !agentId) return false;

  const check = (idStr, targetStr) => {
    const target = String(targetStr).trim().toLowerCase();
    const id = String(idStr).trim().toLowerCase();

    // Split target by delimiters: comma, slash, ampersand, or word "and"
    const rawTokens = target.split(/[,/&]|\band\b/).map(t => t.trim()).filter(Boolean);

    for (const token of rawTokens) {
      if (token === 'all' || token === 'everyone' || token === 'team') {
        return true;
      }

      if (id === 'claude' || id === 'c') {
        if (token === 'claude' || token === 'c' || token.startsWith('claude ') || token.includes('(tech lead)')) {
          return true;
        }
      } else if (id === 'codex' || id === 'x') {
        if (token === 'codex' || token === 'x' || token.startsWith('codex ') || token.includes('independent critic')) {
          return true;
        }
      } else if (id === 'antigravity' || id === 'a' || id === 'ag') {
        if (token === 'antigravity' || token === 'a' || token === 'ag' || token.startsWith('antigravity ') || token.includes('c++ implementer')) {
          return true;
        }
      } else if (id === 'owner' || id === 'h' || id === 'human') {
        if (token === 'owner' || token === 'h' || token === 'human') {
          return true;
        }
      } else {
        if (token === id) {
          return true;
        }
      }
    }
    return false;
  };

  // Support both (agentId, recipientString) and legacy (recipientString, agentId)
  return check(agentId, recipientString) || check(recipientString, agentId);
}

/**
 * Normalizes an agent name to standard canonical ID: 'Claude', 'Codex', 'Antigravity', 'Owner'
 */
function normalizeAgentId(rawId) {
  if (!rawId) return null;
  const norm = String(rawId).trim().toLowerCase();
  if (norm === 'claude' || norm === 'c' || norm.startsWith('claude')) return 'Claude';
  if (norm === 'codex' || norm === 'x' || norm.startsWith('codex')) return 'Codex';
  if (norm === 'antigravity' || norm === 'a' || norm === 'ag' || norm.startsWith('antigravity')) return 'Antigravity';
  if (norm === 'owner' || norm === 'h' || norm === 'human') return 'Owner';
  return rawId;
}

/**
 * Returns party code ('C', 'X', 'A', 'H') for given agent ID
 */
function getPartyCode(agentId) {
  const norm = normalizeAgentId(agentId);
  switch (norm) {
    case 'Claude': return 'C';
    case 'Codex': return 'X';
    case 'Antigravity': return 'A';
    case 'Owner': return 'H';
    default: return null;
  }
}

/**
 * Parses full mailbox markdown text into structured message records.
 * Identifies both valid and malformed headings.
 */
function parseMailboxMessages(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = [];
  let match;
  const regex = new RegExp(HEADING_REGEX.source, 'gm');

  while ((match = regex.exec(text)) !== null) {
    matches.push({
      party: match.groups.party,
      number: parseInt(match.groups.number, 10),
      id: `${match.groups.party}-${match.groups.number}`,
      sender: match.groups.sender.trim(),
      recipientRaw: match.groups.recipient.trim(),
      timestamp: match.groups.timestamp ? match.groups.timestamp.trim() : '',
      index: match.index,
      headerLine: match[0].trim()
    });
  }

  const messages = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const startIndex = current.index;
    const endIndex = (i + 1 < matches.length) ? matches[i + 1].index : text.length;
    const fullText = text.substring(startIndex, endIndex);
    const bodyStartIndex = fullText.indexOf('\n');
    const body = bodyStartIndex !== -1 ? fullText.substring(bodyStartIndex + 1).trim() : '';

    // Validate minimum required fields
    const isMalformed = !current.party || isNaN(current.number) || !current.sender || !current.recipientRaw;

    messages.push({
      ...current,
      fullText: fullText.trim(),
      body: body,
      isMalformed: Boolean(isMalformed)
    });
  }

  return messages;
}

module.exports = {
  EVENT_TYPES,
  PROCESSING_STATUS,
  HEADING_REGEX,
  isRecipientMatch,
  normalizeAgentId,
  getPartyCode,
  parseMailboxMessages
};
