import React, { useState, useEffect, useCallback } from 'react';
import { Sidebar, NavTab } from './components/Sidebar';
import { TopNav } from './components/TopNav';
import { OverviewView } from './views/OverviewView';
import { AgentsView } from './views/AgentsView';
import { TaskQueueView } from './views/TaskQueueView';
import { MailboxView } from './views/MailboxView';
import { MessageLogsView } from './views/MessageLogsView';
import { ActivityTimelineView } from './views/ActivityTimelineView';
import { AddAgentWizard } from './views/AddAgentWizard';
import { SettingsView } from './views/SettingsView';
import { SystemSnapshot } from './types';
import { client } from './api';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSnapshot = useCallback(async () => {
    try {
      const data = await client.fetchSnapshot();
      setSnapshot(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch snapshot');
    }
  }, []);

  useEffect(() => {
    // Initial fetch
    refreshSnapshot();

    // WS connection status tracking
    client.setConnectionCallback((connected) => {
      setWsConnected(connected);
      if (connected) {
        refreshSnapshot();
      }
    });

    // Real-time event subscriber
    const unsubscribe = client.subscribe((eventType, data) => {
      // Whenever an event occurs, refresh snapshot to maintain 100% authoritative sync
      refreshSnapshot();
    });

    // Gentle fallback refresh every 10 seconds
    const interval = setInterval(refreshSnapshot, 10000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [refreshSnapshot]);

  const renderActiveView = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewView snapshot={snapshot} onRefresh={refreshSnapshot} />;
      case 'agents':
        return <AgentsView snapshot={snapshot} onRefresh={refreshSnapshot} />;
      case 'tasks':
        return <TaskQueueView snapshot={snapshot} onRefresh={refreshSnapshot} />;
      case 'mailbox':
        return <MailboxView snapshot={snapshot} onRefresh={refreshSnapshot} />;
      case 'logs':
        return <MessageLogsView snapshot={snapshot} />;
      case 'timeline':
        return <ActivityTimelineView snapshot={snapshot} />;
      case 'add-agent':
        return <AddAgentWizard onAgentAdded={refreshSnapshot} />;
      case 'settings':
        return <SettingsView snapshot={snapshot} />;
      default:
        return <OverviewView snapshot={snapshot} onRefresh={refreshSnapshot} />;
    }
  };

  return (
    <div className="app-container">
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} snapshot={snapshot} />
      <div className="main-wrapper">
        <TopNav snapshot={snapshot} wsConnected={wsConnected} onRefresh={refreshSnapshot} />
        {error && !snapshot && (
          <div style={{ padding: '12px 24px', background: 'var(--color-danger-bg)', color: 'var(--color-danger)', fontSize: '13px' }}>
            Connection error: {error}. Trying to connect to Event Broker...
          </div>
        )}
        {renderActiveView()}
      </div>
    </div>
  );
};

export default App;
