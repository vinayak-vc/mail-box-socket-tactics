/**
 * src/domain/index.js
 * Central domain service container for MailSocketTactics.
 * Supplies shared business logic for the REST API, WebSocket broker, and MCP server.
 */

const MailboxDomainService = require('./MailboxDomainService');
const TaskDomainService = require('./TaskDomainService');
const AgentDomainService = require('./AgentDomainService');
const UsageDomainService = require('./UsageDomainService');
const ProgressDomainService = require('./ProgressDomainService');
const EmailDomainService = require('./EmailDomainService');
const BoardDomainService = require('./BoardDomainService');

/**
 * Creates the services whose data belongs to one project: its mailbox, task
 * lifecycle (StateStore), progress docs and Kanban board.
 * Options: mailboxPath, httpPort, stateStore, logger, onEvent, projectId,
 * headerFormat, mutexName, docsDir, boardStoragePath.
 */
function createProjectServices(options = {}) {
  const mailboxService = new MailboxDomainService({
    mailboxPath: options.mailboxPath,
    httpPort: options.httpPort,
    projectId: options.projectId,
    headerFormat: options.headerFormat,
    mutexName: options.mutexName
  });

  const taskService = new TaskDomainService({
    stateStore: options.stateStore,
    logger: options.logger,
    onEvent: options.onEvent,
    mailboxService: mailboxService
  });

  const progressService = new ProgressDomainService({
    mailboxPath: options.mailboxPath,
    docsDir: options.docsDir,
    headerFormat: options.headerFormat
  });

  const boardService = new BoardDomainService({
    storagePath: options.boardStoragePath,
    logger: options.logger,
    onEvent: options.onEvent || (() => {})
  });

  return { mailboxService, taskService, progressService, boardService };
}

function createDomainServices(options = {}) {
  const { mailboxService, taskService, progressService, boardService } = createProjectServices(options);

  const agentService = new AgentDomainService({
    agentRegistry: options.agentRegistry,
    telemetryMap: options.telemetryMap
  });

  const usageService = new UsageDomainService({
    storagePath: options.usageStoragePath
  });

  const emailService = new EmailDomainService({
    envPath: options.envPath,
    logger: options.logger,
    getPublicUrl: options.getPublicUrl,
    zrokManager: options.zrokManager
  });

  return {
    progressService,
    mailboxService,
    taskService,
    agentService,
    usageService,
    emailService,
    boardService
  };
}

module.exports = {
  createDomainServices,
  createProjectServices,
  MailboxDomainService,
  TaskDomainService,
  AgentDomainService,
  UsageDomainService,
  ProgressDomainService,
  EmailDomainService,
  BoardDomainService
};
