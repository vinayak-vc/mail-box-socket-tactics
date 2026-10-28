/**
 * AgentRegistry.js
 * Persistent registry for AI coding agents.
 * Tracks agent identities, integration configurations, capabilities,
 * pause/resume assignments, and onboarding lifecycles.
 */

const fs = require('fs');
const path = require('path');

class AgentRegistry {
  constructor(options = {}) {
    this.registryPath = options.registryPath || path.resolve(__dirname, '../../data/agent_registry.json');
    this.configPath = options.configPath || path.resolve(__dirname, '../../config/default.json');
    this.agents = new Map();
    this.load();
  }

  load() {
    if (fs.existsSync(this.registryPath)) {
      try {
        const raw = fs.readFileSync(this.registryPath, 'utf8');
        const list = JSON.parse(raw);
        this.agents.clear();
        for (const item of list) {
          this.agents.set(item.id.toLowerCase(), item);
        }
        return;
      } catch (err) {
        console.warn(`[AgentRegistry] Failed to parse ${this.registryPath}: ${err.message}. Re-seeding.`);
      }
    }

    // Seed from default.json if available
    this.seedFromDefault();
  }

  seedFromDefault() {
    this.agents.clear();
    let seedData = [];

    if (fs.existsSync(this.configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (cfg.agents) {
          for (const [key, a] of Object.entries(cfg.agents)) {
            seedData.push({
              id: a.id || key,
              displayName: a.id || key,
              partyCode: a.partyCode || key.charAt(0).toUpperCase(),
              vendor: key === 'Claude' ? 'Anthropic' : key === 'Codex' ? 'OpenAI' : key === 'Antigravity' ? 'Google' : 'Custom',
              integrationMethod: a.execMode || 'cli',
              cliCommand: a.cliCommand || '',
              cliArgs: a.cliArgs || [],
              conversationId: a.conversationId || '',
              workingDir: a.workingDir || 'C:\\UnrealProject\\OneBossFight',
              enabled: a.enabled !== false,
              paused: false,
              onboardingStatus: 'ready',
              role: key === 'Claude' ? 'Tech Lead / Principal Architect' : key === 'Codex' ? 'Technical Lead / Independent Critic' : key === 'Antigravity' ? 'Senior C++ Implementer' : 'AI Specialist',
              capabilities: key === 'Claude' ? ['architecture', 'planning', 'review'] : key === 'Codex' ? ['code-review', 'critic', 'validation'] : ['c++', 'unreal-engine', 'gameplay'],
              isCore: true,
              createdAt: new Date().toISOString()
            });
          }
        }
      } catch (err) {
        console.warn(`[AgentRegistry] Error seeding from default config: ${err.message}`);
      }
    }

    if (seedData.length === 0) {
      seedData = [
        {
          id: 'Claude',
          displayName: 'Claude',
          partyCode: 'C',
          vendor: 'Anthropic',
          integrationMethod: 'cli',
          cliCommand: 'claude',
          cliArgs: ['-c', '-p'],
          workingDir: 'C:\\UnrealProject\\OneBossFight',
          enabled: true,
          paused: false,
          onboardingStatus: 'ready',
          role: 'Tech Lead / Principal Architect',
          capabilities: ['architecture', 'planning', 'review'],
          isCore: true,
          createdAt: new Date().toISOString()
        },
        {
          id: 'Codex',
          displayName: 'OpenAI Codex',
          partyCode: 'X',
          vendor: 'OpenAI',
          integrationMethod: 'cli',
          cliCommand: 'codex.exe',
          cliArgs: ['exec', 'resume', '--last'],
          workingDir: 'C:\\UnrealProject\\OneBossFight',
          enabled: true,
          paused: false,
          onboardingStatus: 'ready',
          role: 'Technical Lead / Independent Critic',
          capabilities: ['code-review', 'critic', 'validation'],
          isCore: true,
          createdAt: new Date().toISOString()
        },
        {
          id: 'Antigravity',
          displayName: 'Google Antigravity',
          partyCode: 'A',
          vendor: 'Google',
          integrationMethod: 'agentapi',
          cliCommand: 'agentapi.bat',
          cliArgs: ['send-message'],
          workingDir: 'C:\\UnrealProject\\OneBossFight',
          enabled: true,
          paused: false,
          onboardingStatus: 'ready',
          role: 'Senior C++ Implementer',
          capabilities: ['c++', 'unreal-engine', 'gameplay'],
          isCore: true,
          createdAt: new Date().toISOString()
        }
      ];
    }

    for (const item of seedData) {
      this.agents.set(item.id.toLowerCase(), item);
    }
    this.save();
  }

  save() {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpPath = `${this.registryPath}.tmp.${Date.now()}`;
    const payload = JSON.stringify(Array.from(this.agents.values()), null, 2);
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, this.registryPath);
  }

  getAll() {
    return Array.from(this.agents.values());
  }

  get(id) {
    if (!id) return null;
    return this.agents.get(id.toLowerCase()) || null;
  }

  register(agentData) {
    if (!agentData || !agentData.id) {
      throw new Error('Agent ID is required');
    }
    const cleanId = agentData.id.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanId)) {
      throw new Error('Agent ID must be alphanumeric and can include underscores or dashes');
    }
    const key = cleanId.toLowerCase();
    if (this.agents.has(key)) {
      throw new Error(`An agent with ID '${cleanId}' is already registered`);
    }

    const partyCode = (agentData.partyCode || cleanId.charAt(0)).toUpperCase();
    const newAgent = {
      id: cleanId,
      displayName: (agentData.displayName || cleanId).trim(),
      partyCode: partyCode,
      vendor: agentData.vendor || 'Custom',
      integrationMethod: agentData.integrationMethod || 'cli', // 'cli' | 'agentapi' | 'mcp' | 'custom'
      cliCommand: (agentData.cliCommand || '').trim(),
      cliArgs: Array.isArray(agentData.cliArgs) ? agentData.cliArgs : [],
      conversationId: (agentData.conversationId || '').trim(),
      workingDir: (agentData.workingDir || 'C:\\UnrealProject\\OneBossFight').trim(),
      enabled: agentData.enabled !== false,
      paused: false,
      onboardingStatus: agentData.onboardingStatus || 'configured',
      role: (agentData.role || 'Custom Specialist').trim(),
      capabilities: Array.isArray(agentData.capabilities) ? agentData.capabilities : [],
      isCore: false,
      createdAt: new Date().toISOString()
    };

    this.agents.set(key, newAgent);
    this.save();
    return newAgent;
  }

  update(id, updates) {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Agent '${id}' not found`);
    }

    const allowedUpdates = [
      'displayName',
      'partyCode',
      'vendor',
      'integrationMethod',
      'cliCommand',
      'cliArgs',
      'conversationId',
      'workingDir',
      'enabled',
      'paused',
      'onboardingStatus',
      'role',
      'capabilities'
    ];

    for (const key of allowedUpdates) {
      if (updates[key] !== undefined) {
        existing[key] = updates[key];
      }
    }

    existing.updatedAt = new Date().toISOString();
    this.agents.set(existing.id.toLowerCase(), existing);
    this.save();
    return existing;
  }

  delete(id) {
    const existing = this.get(id);
    if (!existing) return false;
    if (existing.isCore) {
      throw new Error(`Core agent '${existing.id}' cannot be deleted.`);
    }
    const res = this.agents.delete(existing.id.toLowerCase());
    if (res) this.save();
    return res;
  }
}

module.exports = AgentRegistry;
