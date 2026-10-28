/**
 * AgentDomainService.js
 * Domain service for managing AI agents, registration, telemetry, and onboarding.
 * Shared by REST API, WebSocket event broker, and MCP server.
 */

const { normalizeAgentId } = require('../protocol/MessageProtocol');
const PromptGenerator = require('../broker/PromptGenerator');

class AgentDomainService {
  constructor(options = {}) {
    this.agentRegistry = options.agentRegistry;
    this.telemetryMap = options.telemetryMap || new Map();
  }

  setAgentRegistry(registry) {
    this.agentRegistry = registry;
  }

  setTelemetryMap(map) {
    this.telemetryMap = map;
  }

  /**
   * Returns all registered agents enriched with dynamic runtime telemetry
   */
  getAllAgents(connectedSocketsMap = new Map()) {
    if (!this.agentRegistry) return [];

    return this.agentRegistry.getAll().map(a => {
      const norm = a.id.toLowerCase();
      const conn = connectedSocketsMap.get(norm);
      const telem = this.telemetryMap.get(norm) || {};

      let calculatedStatus = 'offline';
      if (!a.enabled) {
        calculatedStatus = 'disabled';
      } else if (a.paused) {
        calculatedStatus = 'paused';
      } else if (conn) {
        calculatedStatus = telem.status === 'working' ? 'working' : (telem.status === 'waiting' ? 'waiting' : (telem.status === 'degraded' ? 'degraded' : 'idle'));
      } else if (telem.status === 'degraded') {
        calculatedStatus = 'degraded';
      }

      return {
        ...a,
        connected: !!conn,
        status: calculatedStatus,
        lastHeartbeat: telem.lastHeartbeat || null,
        lastSeen: conn ? conn.connectedAt : telem.lastSeen,
        currentTaskId: telem.currentTaskId || null,
        currentTaskTitle: telem.currentTaskTitle || null,
        completedCount: telem.completedCount || 0,
        failedCount: telem.failedCount || 0,
        lastError: telem.lastError || null
      };
    });
  }

  /**
   * Retrieves an agent by ID or party code
   */
  getAgent(id) {
    if (!this.agentRegistry || !id) return null;
    const norm = normalizeAgentId(id);
    return this.agentRegistry.get(norm);
  }

  /**
   * Registers a new AI agent
   */
  registerAgent(agentData) {
    if (!this.agentRegistry) throw new Error('AgentRegistry not initialized');
    return this.agentRegistry.register(agentData);
  }

  /**
   * Updates an existing agent
   */
  updateAgent(id, updates) {
    if (!this.agentRegistry) throw new Error('AgentRegistry not initialized');
    return this.agentRegistry.update(id, updates);
  }

  /**
   * Pauses an agent's task assignment without terminating running tasks
   */
  pauseAgent(id) {
    if (!this.agentRegistry) throw new Error('AgentRegistry not initialized');
    return this.agentRegistry.update(id, { paused: true });
  }

  /**
   * Resumes an agent's task assignment
   */
  resumeAgent(id) {
    if (!this.agentRegistry) throw new Error('AgentRegistry not initialized');
    return this.agentRegistry.update(id, { paused: false });
  }

  /**
   * Generates a project-specific team onboarding prompt for an agent
   */
  generateOnboardingPrompt(agentConfig) {
    return PromptGenerator.generate(agentConfig);
  }
}

module.exports = AgentDomainService;
