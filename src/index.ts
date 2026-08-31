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
  type ConsequentialToolSpec,
  type ErrorMapper,
  type ToolFailure,
  type ToolSpec,
} from "./defineTool.js";
export {
  detectModelContext,
  registerAgentTools,
  type RegisterResult,
} from "./register.js";
export type {
  DetectedModelContext,
  ModelContextTextContent,
  ModelContextTool,
  ModelContextToolResult,
} from "./types.js";
