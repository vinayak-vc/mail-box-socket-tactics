/**
 * api.ts
 * Real-time WebSocket connection manager and REST client for MailSocketTactics Control Center.
 */

import { SystemSnapshot, Agent, Task, ActivityEvent, UsageSummary, ProgressData } from './types';

const isViteDev = window.location.port === '5173';
const API_BASE = isViteDev ? 'http://127.0.0.1:8766' : '';
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsHost = isViteDev ? '127.0.0.1:8766' : (window.location.host || '127.0.0.1:8766');
const WS_URL = `${wsProtocol}//${wsHost}`;

export function getAuthToken(): string {
  if (typeof window !== 'undefined') {
    const injected = (window as any).__MST_CONFIG__?.authToken;
    if (injected) return injected;
    const stored = localStorage.getItem('mst_auth_token');
    if (stored) return stored;
  }
  return '';
}

export function setAuthToken(token: string): void {
  if (typeof window !== 'undefined') {
    (window as any).__MST_CONFIG__ = Object.assign((window as any).__MST_CONFIG__ || {}, { authToken: token });
    localStorage.setItem('mst_auth_token', token);
  }
}

export type EventCallback = (eventType: string, data: any) => void;

class ControlCenterClient {
  private ws: WebSocket | null = null;
  private listeners: Set<EventCallback> = new Set();
  private isConnected = false;
  private reconnectTimer: any = null;
  private onConnectionChange: ((connected: boolean) => void) | null = null;

  constructor() {
    this.bootstrapAndConnect();
  }

  private async bootstrapAndConnect() {
    // If running in dev or if injected config is missing, fetch authoritative config from broker
    if (typeof window !== 'undefined' && !(window as any).__MST_CONFIG__?.authToken) {
      try {
        const res = await fetch(`${API_BASE}/api/config`);
        if (res.ok) {
          const cfg = await res.json();
          if (cfg.authToken) {
            setAuthToken(cfg.authToken);
          }
        }
      } catch (_) {}
    }
    // Remote (tunnelled) viewers are not given the token; ask once and remember it locally
    if (typeof window !== 'undefined' && !getAuthToken()) {
      const entered = window.prompt('Enter the MailSocketTactics broker auth token:');
      if (entered && entered.trim()) setAuthToken(entered.trim());
    }
    this.connectWs();
  }

  public setConnectionCallback(cb: (connected: boolean) => void) {
    this.onConnectionChange = cb;
    cb(this.isConnected);
  }

  public subscribe(cb: EventCallback) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private connectWs() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        // Authenticate as Dashboard using dynamic token
        const authPayload = JSON.stringify({
          type: 'AUTH_REQUEST',
          agentId: 'Dashboard',
          token: getAuthToken()
        });
        this.ws?.send(authPayload);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'AUTH_RESPONSE' && msg.success) {
            this.isConnected = true;
            if (this.onConnectionChange) this.onConnectionChange(true);

            // Subscribe to dashboard events
            this.ws?.send(JSON.stringify({
              type: 'SUBSCRIBE',
              channels: ['dashboard']
            }));
          }

          if (msg.type === 'PING') {
            this.ws?.send(JSON.stringify({ type: 'PONG', agentId: 'Dashboard' }));
          }

          if (msg.type === 'DASHBOARD_EVENT') {
            this.listeners.forEach(cb => cb(msg.eventType, msg.data));
          }
        } catch (_) {}
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        if (this.onConnectionChange) this.onConnectionChange(false);
        this.reconnectTimer = setTimeout(() => this.connectWs(), 3000);
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch (_) {
      this.reconnectTimer = setTimeout(() => this.connectWs(), 4000);
    }
  }

  public async fetchSnapshot(): Promise<SystemSnapshot> {
    const res = await fetch(`${API_BASE}/api/snapshot`, {
      headers: { 'Authorization': `Bearer ${getAuthToken()}` }
    });
    if (!res.ok) throw new Error(`Snapshot request failed with status ${res.status}`);
    return res.json();
  }

  public async fetchProgress(): Promise<ProgressData> {
    const res = await fetch(`${API_BASE}/api/progress?messages=30`, {
      headers: { 'Authorization': `Bearer ${getAuthToken()}` }
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'Unauthorized: token missing or wrong' : `Progress request failed (${res.status})`);
    return res.json();
  }

  public async fetchUsage(): Promise<UsageSummary> {
    const res = await fetch(`${API_BASE}/api/usage`, {
      headers: { 'Authorization': `Bearer ${getAuthToken()}` }
    });
    if (!res.ok) throw new Error(`Usage request failed with status ${res.status}`);
    return res.json();
  }

  public async updateAgent(id: string, updates: Partial<Agent>): Promise<Agent> {
    const res = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`
      },
      body: JSON.stringify(updates)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Update failed' }));
      throw new Error(err.error || 'Update failed');
    }
    const data = await res.json();
    return data.agent;
  }

  public async testAgent(id: string): Promise<any> {
    const res = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getAuthToken()}` }
    });
    return res.json();
  }

  public async generatePrompt(agentConfig: any): Promise<string> {
    const res = await fetch(`${API_BASE}/api/prompt/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`
      },
      body: JSON.stringify(agentConfig)
    });
    const data = await res.json();
    return data.prompt;
  }

  public async registerAgent(agentData: any): Promise<Agent> {
    const res = await fetch(`${API_BASE}/api/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`
      },
      body: JSON.stringify(agentData)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Registration failed' }));
      throw new Error(err.error || 'Registration failed');
    }
    const data = await res.json();
    return data.agent;
  }

  public async retryTask(id: string): Promise<void> {
    const res = await fetch(`${API_BASE}/requeue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`
      },
      body: JSON.stringify({ messageId: id })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Retry failed' }));
      throw new Error(err.error || 'Retry failed');
    }
  }

  public async cancelTask(id: string): Promise<void> {
    const res = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getAuthToken()}` }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Cancel failed' }));
      throw new Error(err.error || 'Cancel failed');
    }
  }

  public async postMailboxMessage(as: string, to: string, body: string): Promise<string> {
    const res = await fetch(`${API_BASE}/api/mailbox/post`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`
      },
      body: JSON.stringify({ as, to, body })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Post failed' }));
      throw new Error(err.error || 'Post failed');
    }
    const data = await res.json();
    return data.output || 'Message posted';
  }

  public async serviceControl(action: 'start' | 'stop' | 'restart' | 'status', target: 'all' | 'broker' | 'adapters'): Promise<any> {
    const res = await fetch(`${API_BASE}/api/service/control`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`
      },
      body: JSON.stringify({ action, target })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Service command failed' }));
      throw new Error(err.error || 'Service command failed');
    }
    return res.json();
  }

  public getExportUrl(format: 'json' | 'csv'): string {
    return `${API_BASE}/api/logs?format=${format}`;
  }

  public async fetchEmailStatus(): Promise<{ enabled: boolean; hasApiKey?: boolean; ownerEmailMasked?: string }> {
    const res = await fetch(`${API_BASE}/api/notify/status`);
    if (!res.ok) return { enabled: false };
    return res.json();
  }

  public async notifyOwner(payload: { subject: string; message: string; urgency?: string; taskReference?: string; senderAgent?: string }): Promise<any> {
    const res = await fetch(`${API_BASE}/api/notify/owner`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Notification failed' }));
      throw new Error(err.error || 'Notification failed');
    }
    return res.json();
  }
}

export const client = new ControlCenterClient();
