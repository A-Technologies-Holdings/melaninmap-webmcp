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

export type ModelContextTool = {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** MCP-style behavior hints (e.g. readOnlyHint). */
  annotations?: { readOnlyHint?: boolean } & Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<ModelContextToolResult>;
};

export type ModelContextRegisterOptions = {
  signal?: AbortSignal;
};

/** Incremental registration shape from the proposal. */
export type ModelContextRegisterTool = (
  tool: ModelContextTool,
  options?: ModelContextRegisterOptions,
) => unknown;

/** Bulk registration shape from the proposal. */
export type ModelContextProvideContext = (context: {
  tools: ModelContextTool[];
}) => unknown;

/**
 * The narrowed shape we use after runtime feature detection. Both methods are
 * optional — a UA may ship either registration style.
 */
export type DetectedModelContext = {
  registerTool?: ModelContextRegisterTool;
  provideContext?: ModelContextProvideContext;
};
