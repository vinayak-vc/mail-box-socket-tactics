/**
 * api.ts
 * Real-time WebSocket connection manager and REST client for MailSocketTactics Control Center.
 */

import { SystemSnapshot, Agent, Task, ActivityEvent } from './types';

const API_BASE = window.location.port === '5173' ? 'http://127.0.0.1:8766' : '';
const WS_URL = window.location.port === '5173' ? 'ws://127.0.0.1:8765' : `ws://${window.location.hostname}:8765`;
const AUTH_TOKEN = 'mailbox-socket-secret-token';

export type EventCallback = (eventType: string, data: any) => void;

class ControlCenterClient {
  private ws: WebSocket | null = null;
  private listeners: Set<EventCallback> = new Set();
  private isConnected = false;
  private reconnectTimer: any = null;
  private onConnectionChange: ((connected: boolean) => void) | null = null;

  constructor() {
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
        // Authenticate as Dashboard
        const authPayload = JSON.stringify({
          type: 'AUTH_REQUEST',
          agentId: 'Dashboard',
          token: AUTH_TOKEN
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
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
    });
    if (!res.ok) throw new Error(`Snapshot request failed with status ${res.status}`);
    return res.json();
  }

  public async updateAgent(id: string, updates: Partial<Agent>): Promise<Agent> {
    const res = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`
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
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
    });
    return res.json();
  }

  public async generatePrompt(agentConfig: any): Promise<string> {
    const res = await fetch(`${API_BASE}/api/prompt/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`
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
        'Authorization': `Bearer ${AUTH_TOKEN}`
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
        'Authorization': `Bearer ${AUTH_TOKEN}`
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
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
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
        'Authorization': `Bearer ${AUTH_TOKEN}`
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
        'Authorization': `Bearer ${AUTH_TOKEN}`
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
}

export const client = new ControlCenterClient();
