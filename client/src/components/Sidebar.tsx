import React from 'react';
import { 
  LayoutDashboard, 
  Bot, 
  ListTodo, 
  Mail, 
  FileText, 
  Activity, 
  UserPlus, 
  Settings 
} from 'lucide-react';
import { SystemSnapshot } from '../types';

export type NavTab = 
  | 'overview' 
  | 'agents' 
  | 'tasks' 
  | 'mailbox' 
  | 'logs' 
  | 'timeline' 
  | 'add-agent' 
  | 'settings';

interface SidebarProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  snapshot: SystemSnapshot | null;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, onTabChange, snapshot }) => {
  const connectedAgentsCount = snapshot?.agents.filter(a => a.connected).length || 0;
  const runningTasksCount = snapshot?.tasks.runningCount || 0;
  const totalMessagesCount = snapshot?.mailbox.totalMessages || 0;

  const navItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'agents', label: 'AI Agents', icon: Bot, badge: connectedAgentsCount ? `${connectedAgentsCount}` : undefined },
    { id: 'tasks', label: 'Task Queue', icon: ListTodo, badge: runningTasksCount ? `${runningTasksCount}` : undefined },
    { id: 'mailbox', label: 'Mailbox', icon: Mail, badge: totalMessagesCount ? `${totalMessagesCount}` : undefined },
    { id: 'logs', label: 'Message Logs', icon: FileText },
    { id: 'timeline', label: 'Activity Timeline', icon: Activity },
    { id: 'add-agent', label: 'Add AI Agent', icon: UserPlus },
    { id: 'settings', label: 'System Settings', icon: Settings },
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
