export {
  CONSENT_DEFAULT_TIMEOUT_MS,
  consentRefusal,
  type ConsentDecision,
  type ConsentRequest,
  type ConsentResult,
  type ConsentSurface,
} from "./consent.js";
export {
  defineConsequentialTool,
  defineReadTool,
  toToolResult,
  type ConsentConfirmation,
  type ConsentDecisionRecord,
  type ConsequentialToolSpec,
  type DecisionObserver,
  type ErrorMapper,
  type ToolFailure,
  type ToolSpec,
} from "./defineTool.js";
export {
  CONSENT_QUEUE_DEFAULT_CAPACITY,
  createConsentQueue,
  type ConsentConfirmEvent,
  type ConsentQueue,
  type ConsentQueueOptions,
  type DisplayedConsentRequest,
} from "./queue.js";
export {
  detectModelContext,
  registerAgentTools,
  registerAgentToolsAsync,
  type RegisterAgentToolsOptions,
  type RegisterResult,
} from "./register.js";
export type {
  DetectedModelContext,
  ModelContextProvideContext,
  ModelContextRegisterOptions,
  ModelContextRegisterTool,
  ModelContextTextContent,
  ModelContextTool,
  ModelContextToolResult,
  ToolExecutionOptions,
} from "./types.js";
