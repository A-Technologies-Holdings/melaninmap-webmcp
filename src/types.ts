/**
 * Minimal structural types for the proposed W3C Web Model Context ("WebMCP")
 * API surface (`navigator.modelContext` / `document.modelContext`).
 *
 * The API is a browser proposal, not a shipped standard — nothing here may
 * assume it exists. The host object is typed as `unknown` and must be narrowed
 * at runtime (see registerAgentTools.ts). No npm types are installed for this.
 */

export type ModelContextTextContent = {
  type: "text";
  text: string;
};

export type ModelContextToolResult = {
  content: ModelContextTextContent[];
};

export type ToolExecutionOptions = { signal?: AbortSignal };

/**
 * A tool as handed to the host. `Result` is what `execute` resolves to: the
 * MCP-style content envelope by default, or the plain JSON value for a tool
 * defined with `resultFormat: "json"`.
 */
export type ModelContextTool<Result = ModelContextToolResult> = {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** MCP-style behavior hints (e.g. readOnlyHint). */
  annotations?: { readOnlyHint?: boolean } & Record<string, unknown>;
  execute: (args: Record<string, unknown>, options?: ToolExecutionOptions) => Promise<Result>;
};

export type ModelContextRegisterOptions = {
  signal?: AbortSignal;
};

/** Incremental registration shape from the proposal. */
export type ModelContextRegisterTool = (
  tool: ModelContextTool<unknown>,
  options?: ModelContextRegisterOptions,
) => unknown;

/** Bulk registration shape from the proposal. */
export type ModelContextProvideContext = (context: {
  tools: ModelContextTool<unknown>[];
}) => unknown;

/**
 * The narrowed shape we use after runtime feature detection. Both methods are
 * optional — a UA may ship either registration style.
 */
export type DetectedModelContext = {
  registerTool?: ModelContextRegisterTool;
  provideContext?: ModelContextProvideContext;
};
