/**
 * UsageDomainService.js
 * Domain service for tracking AI resource consumption, token metrics, and subscription quotas.
 * Adheres strictly to Section 11 of the Master Engineering Specification:
 * - Separates subscription quotas from API token counts.
 * - Uses explicit confidence states: Available, Estimated, Unavailable, Stale.
 * - Does not scrape undocumented private APIs or fabricate measurements.
 */

const fs = require('fs');
const path = require('path');

class UsageDomainService {
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.resolve(__dirname, '../../data/usage_metrics.json');
    this.usageData = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      agents: {
        claude: {
          taskCount: 0,
          totalDurationMs: 0,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          lastActiveAt: null
        },
        codex: {
          taskCount: 0,
          totalDurationMs: 0,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          lastActiveAt: null
        },
        antigravity: {
          taskCount: 0,
          totalDurationMs: 0,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          lastActiveAt: null
        }
      }
    };

    this.load();
  }

  load() {
    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.agents) {
          this.usageData = parsed;
        }
      } catch (_) {}
    }
  }

  save() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.usageData.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.storagePath, JSON.stringify(this.usageData, null, 2), 'utf8');
    } catch (_) {}
  }

  /**
   * Records completed task execution metrics for an agent
   */
  recordTaskUsage(agentId, durationMs = 0, inputTokens = 0, outputTokens = 0) {
    if (!agentId) return;
    const key = agentId.toLowerCase();
    if (!this.usageData.agents[key]) {
      this.usageData.agents[key] = {
        taskCount: 0,
        totalDurationMs: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        lastActiveAt: null
      };
    }

    const rec = this.usageData.agents[key];
    rec.taskCount += 1;
    rec.totalDurationMs += Math.max(0, durationMs);
    rec.estimatedInputTokens += Math.max(0, inputTokens);
    rec.estimatedOutputTokens += Math.max(0, outputTokens);
    rec.lastActiveAt = new Date().toISOString();
    this.save();
  }

  /**
   * Returns authoritative system-wide usage and quota telemetry
   */
  getUsageSummary() {
    const now = new Date().toISOString();

    return {
      timestamp: now,
      quotas: [
        {
          agentId: 'Claude',
          displayName: 'Claude Desktop',
          vendor: 'Anthropic',
          tier: 'Claude Pro / Max Subscription',
          fiveHourQuota: {
            state: 'Unavailable',
            value: null,
            resetTime: null,
            note: 'Claude Desktop does not expose rolling 5-hour quota percentages over local unauthenticated APIs.'
          },
          weeklyQuota: {
            state: 'Unavailable',
            value: null,
            resetTime: null,
            note: 'Weekly limits are managed dynamically server-side by Anthropic without local telemetry.'
          },
          taskMetrics: {
            state: 'Available',
            tasksExecuted: this.usageData.agents.claude?.taskCount || 0,
            totalComputeMs: this.usageData.agents.claude?.totalDurationMs || 0,
            estimatedTokens: (this.usageData.agents.claude?.estimatedInputTokens || 0) + (this.usageData.agents.claude?.estimatedOutputTokens || 0),
            lastActiveAt: this.usageData.agents.claude?.lastActiveAt || null,
            source: 'MailSocketTactics Task Execution Telemetry',
            confidence: 'High'
          }
        },
        {
          agentId: 'Codex',
          displayName: 'Codex Desktop',
          vendor: 'OpenAI',
          tier: 'ChatGPT Plus / Pro / Team',
          fiveHourQuota: {
            state: 'Unavailable',
            value: null,
            resetTime: null,
            note: 'OpenAI Desktop uses dynamic server-side message caps; no local socket exposes raw subscription limits.'
          },
          weeklyQuota: {
            state: 'Unavailable',
            value: null,
            resetTime: null,
            note: 'Weekly subscription ceiling is server-enforced.'
          },
          taskMetrics: {
            state: 'Available',
            tasksExecuted: this.usageData.agents.codex?.taskCount || 0,
            totalComputeMs: this.usageData.agents.codex?.totalDurationMs || 0,
            estimatedTokens: (this.usageData.agents.codex?.estimatedInputTokens || 0) + (this.usageData.agents.codex?.estimatedOutputTokens || 0),
            lastActiveAt: this.usageData.agents.codex?.lastActiveAt || null,
            source: 'MailSocketTactics Task Execution Telemetry',
            confidence: 'High'
          }
        },
        {
          agentId: 'Antigravity',
          displayName: 'Antigravity Desktop',
          vendor: 'Google Deepmind',
          tier: 'Advanced Agentic Coding Environment',
          fiveHourQuota: {
            state: 'Estimated',
            value: 'Within Active Workspace Bounds',
            resetTime: null,
            note: 'Execution bounded by conversation context and background task limits.'
          },
          weeklyQuota: {
            state: 'Unavailable',
            value: null,
            resetTime: null,
            note: 'Subscription quota not exposed via local programmatic endpoint.'
          },
          taskMetrics: {
            state: 'Available',
            tasksExecuted: this.usageData.agents.antigravity?.taskCount || 0,
            totalComputeMs: this.usageData.agents.antigravity?.totalDurationMs || 0,
            estimatedTokens: (this.usageData.agents.antigravity?.estimatedInputTokens || 0) + (this.usageData.agents.antigravity?.estimatedOutputTokens || 0),
            lastActiveAt: this.usageData.agents.antigravity?.lastActiveAt || null,
            source: 'MailSocketTactics Task Execution Telemetry',
            confidence: 'High'
          }
        }
      ],
      aggregated: {
        totalTasks: Object.values(this.usageData.agents).reduce((acc, a) => acc + (a.taskCount || 0), 0),
        totalComputeDurationMs: Object.values(this.usageData.agents).reduce((acc, a) => acc + (a.totalDurationMs || 0), 0),
        totalEstimatedTokens: Object.values(this.usageData.agents).reduce((acc, a) => acc + (a.estimatedInputTokens || 0) + (a.estimatedOutputTokens || 0), 0)
      }
    };
  }
}

module.exports = UsageDomainService;
