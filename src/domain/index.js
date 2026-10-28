/**
 * src/domain/index.js
 * Central domain service container for MailSocketTactics.
 * Supplies shared business logic for the REST API, WebSocket broker, and MCP server.
 */

const MailboxDomainService = require('./MailboxDomainService');
const TaskDomainService = require('./TaskDomainService');
const AgentDomainService = require('./AgentDomainService');
const UsageDomainService = require('./UsageDomainService');

function createDomainServices(options = {}) {
  const mailboxService = new MailboxDomainService({
    mailboxPath: options.mailboxPath,
    httpPort: options.httpPort
  });

  const taskService = new TaskDomainService({
    stateStore: options.stateStore,
    logger: options.logger,
    onEvent: options.onEvent,
    mailboxService: mailboxService
  });

  const agentService = new AgentDomainService({
    agentRegistry: options.agentRegistry,
    telemetryMap: options.telemetryMap
  });

  const usageService = new UsageDomainService({
    storagePath: options.usageStoragePath
  });

  return {
    mailboxService,
    taskService,
    agentService,
    usageService
  };
}

module.exports = {
  createDomainServices,
  MailboxDomainService,
  TaskDomainService,
  AgentDomainService,
  UsageDomainService
};
