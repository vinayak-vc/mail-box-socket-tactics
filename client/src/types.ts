/**
 * types.ts
 * Shared data types for MailSocketTactics Control Center
 */

export type AgentStatus = 'connected' | 'idle' | 'working' | 'waiting' | 'degraded' | 'offline' | 'disabled' | 'paused' | 'unknown';

export interface Agent {
  id: string;
  displayName: string;
  partyCode: string;
  vendor: string;
  integrationMethod: 'cli' | 'agentapi' | 'mcp' | 'custom';
  cliCommand?: string;
  cliArgs?: string[];
  conversationId?: string;
  workingDir?: string;
  enabled: boolean;
  paused: boolean;
  onboardingStatus: 'draft' | 'prompt_generated' | 'awaiting_setup' | 'configured' | 'ready' | 'disabled';
  role: string;
  capabilities: string[];
  isCore: boolean;
  createdAt?: string;

  // Live telemetry
  connected: boolean;
  status: AgentStatus;
  lastHeartbeat?: string | null;
  lastSeen?: string | null;
  currentTaskId?: string | null;
  currentTaskTitle?: string | null;
  completedCount: number;
  failedCount: number;
  lastError?: string | null;
}

export type TaskStatus = 'PENDING' | 'CLAIMED' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'RETRYABLE_FAILED' | 'DEAD_LETTER' | 'CANCELLED';

export interface Task {
  messageId: string;
  party: string;
  number: number;
  sender: string;
  recipient: string;
  status: TaskStatus;
  claimOwner?: string | null;
  attempts: number;
  maxAttempts: number;
  claimedAt?: number;
  leaseExpiresAt?: number;
  completedAt?: number;
  lastError?: string | null;
  evidence?: {
    workerId: string;
    completedAt: string;
    hash?: string;
  };
}

export interface MailboxMessage {
  id: string;
  party: string;
  number: number;
  sender: string;
  recipientRaw: string;
  timestamp: string;
  rawHeader?: string;
  body: string;
}

export interface ActivityEvent {
  id: string;
  timestamp: string;
  sequence: number;
  level: 'INFO' | 'WARN' | 'ERROR';
  type: string;
  agentId?: string | null;
  messageId?: string | null;
  details?: any;
  summary: string;
}

export interface SystemSnapshot {
  timestamp: string;
  broker: {
    status: 'UP' | 'DOWN';
    host: string;
    port: number;
    httpPort: number;
    uptimeSeconds: number;
    startTime: string;
    metrics: {
      connectionsAccepted: number;
      authFailures: number;
      notificationsSent: number;
      acksReceived: number;
      renewalsReceived: number;
      retriesTriggered: number;
      deadLettersCount: number;
    };
    lastError?: string | null;
  };
  zrok?: {
    enabled: boolean;
    status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'STARTING' | 'DISABLED';
    publicUrl: string | null;
    shareToken?: string | null;
    target?: string;
    tokenConfigured?: boolean;
    tokenMasked?: string | null;
    lastError?: string | null;
  };
  services: {
    brokerRunning: boolean;
    watcherRunning: boolean;
    watcherPath?: string | null;
    stateStoreHealthy: boolean;
  };
  mailbox: {
    path?: string | null;
    exists: boolean;
    totalMessages: number;
    messages: MailboxMessage[];
  };
  agents: Agent[];
  tasks: {
    all: Task[];
    deadLetters: Task[];
    pendingCount: number;
    runningCount: number;
    completedCount: number;
    failedCount: number;
    deadLetterCount: number;
  };
  logs: ActivityEvent[];
  usage?: UsageSummary | null;
}

export interface QuotaItem {
  state: 'Available' | 'Estimated' | 'Unavailable' | 'Stale';
  value: string | number | null;
  resetTime?: string | null;
  note: string;
}

export interface AgentQuota {
  agentId: string;
  displayName: string;
  vendor: string;
  tier: string;
  fiveHourQuota: QuotaItem;
  weeklyQuota: QuotaItem;
  taskMetrics: {
    state: 'Available' | 'Estimated' | 'Unavailable' | 'Stale';
    tasksExecuted: number;
    totalComputeMs: number;
    estimatedTokens: number;
    lastActiveAt?: string | null;
    source: string;
    confidence: string;
  };
}

export interface UsageSummary {
  timestamp: string;
  quotas: AgentQuota[];
  aggregated: {
    totalTasks: number;
    totalComputeDurationMs: number;
    totalEstimatedTokens: number;
  };
}
