import React from 'react';
import { Bot, Mail, Activity, Settings, TrendingUp } from 'lucide-react';
import { SystemSnapshot } from '../types';

export type NavTab = 
  | 'progress'
  | 'overview' 
  | 'agents' 
  | 'tasks' 
  | 'mailbox' 
  | 'logs' 
  | 'timeline' 
  | 'ai-usage'
  | 'add-agent' 
  | 'settings';

interface SidebarProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  snapshot: SystemSnapshot | null;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, onTabChange, snapshot }) => {
  const connectedAgentsCount = snapshot?.agents.filter(a => a.connected).length || 0;
  const totalMessagesCount = snapshot?.mailbox.totalMessages || 0;

  // Monitoring-only navigation. The broker task queue, logs, usage and agent wizard views still exist
  // in the codebase but are not offered here.
  const navItems = [
    { id: 'progress', label: 'Progress', icon: TrendingUp },
    { id: 'mailbox', label: 'Mailbox', icon: Mail, badge: totalMessagesCount ? `${totalMessagesCount}` : undefined },
    { id: 'agents', label: 'AI Agents', icon: Bot, badge: connectedAgentsCount ? `${connectedAgentsCount}` : undefined },
    { id: 'timeline', label: 'Activity', icon: Activity },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand-icon">MST</div>
        <div className="brand-text">
          <h1>Control Center</h1>
          <span>v1.0.0 · Localhost</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              className={`nav-item ${isActive ? 'active' : ''}`}
              onClick={() => onTabChange(item.id as NavTab)}
            >
              <Icon size={18} />
              <span>{item.label}</span>
              {item.badge && <span className="nav-badge">{item.badge}</span>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div>Broker: ws://127.0.0.1:{snapshot?.broker.port || 8765}</div>
        <div>HTTP API: :8766</div>
      </div>
    </aside>
  );
};
