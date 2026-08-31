/**
 * WebMCP registrar for the Melanin Map agent gateway (SLA-1160).
 *
 * Registers five tools on the proposed Web Model Context API
 * (`navigator.modelContext` / `document.modelContext`) when a capable browser
 * is present. Fully feature-detected: in every browser shipping today this is
 * a silent no-op. Loaded lazily from main.tsx after app mount so non-agent
 * visitors pay ~zero bundle cost and a registrar bug can never break the SPA.
 */

import {
  AgentGatewayApiError,
  recordAgentAction,
  requestAgentBusiness,
  requestAgentHandoff,
  requestAgentSearch,
  requestAgentVerification,
  type AgentSearchItem,
} from "./agentGatewayApi";
import { requestHandoffConsent } from "./consentBridge";
import { ensureHandoffConsentCardMounted } from "./HandoffConsentCard";
import { getAgentInstallationId } from "./installation";
import type {
  DetectedModelContext,
  ModelContextProvideContext,
  ModelContextRegisterTool,
  ModelContextTool,
  ModelContextToolResult,
} from "./modelContext";

const GLOBAL_FLAG = "__mmWebmcpAgentToolsRegistered";

let registered = false;

function alreadyRegistered(): boolean {
  if (registered) return true;
  try {
    return Boolean(
      (globalThis as unknown as Record<string, unknown>)[GLOBAL_FLAG],
    );
  } catch {
    return false;
  }
}

function markRegistered(): void {
  registered = true;
  try {
    (globalThis as unknown as Record<string, unknown>)[GLOBAL_FLAG] = true;
  } catch {
    // Module-level flag still holds for this evaluation.
  }
}

function detectModelContext(): DetectedModelContext | null {
  const fromNavigator =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { modelContext?: unknown }).modelContext
      : undefined;
  const fromDocument =
    typeof document !== "undefined"
      ? (document as Document & { modelContext?: unknown }).modelContext
      : undefined;
  const candidate = fromNavigator ?? fromDocument;
  if (typeof candidate !== "object" || candidate === null) return null;

  const host = candidate as Record<string, unknown>;
  const registerTool = host.registerTool;
  const provideContext = host.provideContext;
  const hasRegister = typeof registerTool === "function";
  const hasProvide = typeof provideContext === "function";
  if (!hasRegister && !hasProvide) return null;

  return {
    registerTool: hasRegister
      ? (registerTool as ModelContextRegisterTool).bind(candidate)
      : undefined,
    provideContext: hasProvide
      ? (provideContext as ModelContextProvideContext).bind(candidate)
      : undefined,
  };
}

/** Single place that shapes every tool result. */
function toToolResult(result: unknown): ModelContextToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

function errorEnvelope(error: unknown): { ok: false; code: string } {
  if (error instanceof AgentGatewayApiError) {
    return { ok: false, code: error.code };
  }
  return { ok: false, code: "network_error" };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

const searchTool: ModelContextTool = {
  name: "search_black_owned_directory",
  description:
    "Search Melanin Map's published directory of Black-owned businesses, events, and tours in Clarksville, Tennessee. Results are published directory records. The response includes a recommendationId, which subsequent record_interest and request_event_handoff calls require.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Free-text search terms.",
      },
      category: {
        type: "string",
        description: "Optional category filter.",
      },
      kind: {
        type: "string",
        enum: ["business", "event", "all"],
        description: 'Optional record kind filter; defaults to "all".',
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return.",
      },
    },
    required: [],
  },
  annotations: { readOnlyHint: true },
  execute: async (args) => {
    try {
      const response = await requestAgentSearch({
        installationId: getAgentInstallationId(),
        query: optionalString(args.query),
        category: optionalString(args.category),
        kind: optionalString(args.kind),
        limit: optionalNumber(args.limit),
      });
      if ("items" in response && Array.isArray(response.items)) {
        rememberTargetNames(response.items);
      }
      return toToolResult(response);
    } catch (error) {
      return toToolResult(errorEnvelope(error));
    }
  },
};

const businessDetailsTool: ModelContextTool = {
  name: "get_business_details",
  description:
    "Get the published directory record for one listing by its externalId, as returned by search_black_owned_directory. Returns only fields the listing has published.",
  inputSchema: {
    type: "object",
    properties: {
      externalId: {
        type: "string",
        description:
          "The listing's externalId from search_black_owned_directory.",
      },
    },
    required: ["externalId"],
  },
  annotations: { readOnlyHint: true },
  execute: async (args) => {
    const externalId = optionalString(args.externalId);
    if (!externalId) {
      return toToolResult({ ok: false, code: "invalid_arguments" });
    }
    try {
      return toToolResult(await requestAgentBusiness({ externalId }));
    } catch (error) {
      return toToolResult(errorEnvelope(error));
    }
  },
};

const verificationTool: ModelContextTool = {
  name: "check_ownership_verification",
  description:
    'Check the ownership verification status of a directory listing. Returns one of three statuses: "verified" (a live, source-verified certification with a public Passport URL), "not_listed" (no publicly listed verification for this id), or "exposure_disabled" (public Passport exposure is currently switched off site-wide). Verification is never purchasable.',
  inputSchema: {
    type: "object",
    properties: {
      externalId: {
        type: "string",
        description:
          "The listing's externalId from search_black_owned_directory.",
      },
    },
    required: ["externalId"],
  },
  annotations: { readOnlyHint: true },
  execute: async (args) => {
    const externalId = optionalString(args.externalId);
    if (!externalId) {
      return toToolResult({ ok: false, code: "invalid_arguments" });
    }
    try {
      return toToolResult(await requestAgentVerification({ externalId }));
    } catch (error) {
      return toToolResult(errorEnvelope(error));
    }
  },
};

const INTEREST_ACTIONS = ["tap", "save", "directions"] as const;
type InterestAction = (typeof INTEREST_ACTIONS)[number];

const recordInterestTool: ModelContextTool = {
  name: "record_interest",
  description:
    "Record an attributed follow-through (tap, save, or directions) for a recommendation previously returned by search_black_owned_directory. Safe to call once per genuine user intent; it no-ops if the recommendation has expired.",
  inputSchema: {
    type: "object",
    properties: {
      recommendationId: {
        type: "string",
        description:
          "The recommendationId from a prior search_black_owned_directory response.",
      },
      action: {
        type: "string",
        enum: ["tap", "save", "directions"],
        description: "The kind of follow-through the person expressed.",
      },
      targetType: {
        type: "string",
        description: "The record type of the target, from the search item.",
      },
      targetId: {
        type: "string",
        description: "The target's externalId, from the search item.",
      },
    },
    required: ["recommendationId", "action", "targetType", "targetId"],
  },
  execute: async (args) => {
    const recommendationId = optionalString(args.recommendationId);
    const action = optionalString(args.action);
    const targetType = optionalString(args.targetType);
    const targetId = optionalString(args.targetId);
    if (
      !recommendationId ||
      !targetType ||
      !targetId ||
      !action ||
      !INTEREST_ACTIONS.includes(action as InterestAction)
    ) {
      return toToolResult({ ok: false, code: "invalid_arguments" });
    }
    try {
      const response = await recordAgentAction({
        installationId: getAgentInstallationId(),
        recommendationId,
        action: action as InterestAction,
        targetType,
        targetId,
      });
      return toToolResult(response);
    } catch (error) {
      return toToolResult(errorEnvelope(error));
    }
  },
};

const HANDOFF_TARGET_TYPES = ["event", "tour"] as const;
type HandoffTargetType = (typeof HANDOFF_TARGET_TYPES)[number];

/**
 * externalId → display name from recent search responses, so the consent card
 * can name an event/tour (the business endpoint only resolves businesses).
 * Bounded: cleared once it grows past a page or two of results.
 */
const knownTargetNames = new Map<string, string>();
const KNOWN_TARGET_NAMES_MAX = 200;

function rememberTargetNames(items: readonly AgentSearchItem[]): void {
  if (knownTargetNames.size > KNOWN_TARGET_NAMES_MAX) {
    knownTargetNames.clear();
  }
  for (const item of items) {
    if (typeof item.externalId === "string" && typeof item.name === "string") {
      const name = item.name.trim();
      if (name) knownTargetNames.set(item.externalId, name);
    }
  }
}

async function lookupTargetName(externalId: string): Promise<string> {
  // Names seen in this session's search results cover the event/tour case.
  const remembered = knownTargetNames.get(externalId);
  if (remembered) return remembered;
  // Best-effort business lookup covers business ids; falls back to the raw
  // externalId on any failure.
  try {
    const details = await requestAgentBusiness({ externalId });
    if (details.ok === true && typeof details.business.name === "string") {
      const name = details.business.name.trim();
      if (name) return name;
    }
  } catch {
    // Fall through to the externalId.
  }
  return externalId;
}

const handoffTool: ModelContextTool = {
  name: "request_event_handoff",
  description:
    "Start a tracked hand-off to an event's or tour's official ticketing destination. A visible confirmation card is shown to the person using this browser, and the hand-off proceeds only if they confirm it; if they decline, no hand-off request is made and the result is { ok: false, code: \"user_declined\" }.",
  inputSchema: {
    type: "object",
    properties: {
      recommendationId: {
        type: "string",
        description:
          "The recommendationId from a prior search_black_owned_directory response.",
      },
      targetType: {
        type: "string",
        enum: ["event", "tour"],
        description: "Whether the target is an event or a tour.",
      },
      targetExternalId: {
        type: "string",
        description: "The event's or tour's externalId, from the search item.",
      },
      channel: {
        type: "string",
        enum: ["event_detail"],
        description:
          'The hand-off channel. The web agent lane always uses "event_detail".',
      },
    },
    required: ["recommendationId", "targetType", "targetExternalId", "channel"],
  },
  annotations: { readOnlyHint: false },
  execute: async (args) => {
    const recommendationId = optionalString(args.recommendationId);
    const targetType = optionalString(args.targetType);
    const targetExternalId = optionalString(args.targetExternalId);
    if (
      !recommendationId ||
      !targetExternalId ||
      !targetType ||
      !HANDOFF_TARGET_TYPES.includes(targetType as HandoffTargetType)
    ) {
      return toToolResult({ ok: false, code: "invalid_arguments" });
    }
    // The journey channel is a closed server-side union and the persisted
    // value is server-governed anyway; the web lane is always the event
    // surface, so never let a creative agent-supplied string break the chain.
    const channel = "event_detail";

    const targetName = await lookupTargetName(targetExternalId);
    const outcome = await requestHandoffConsent({ targetName, targetType });

    if (outcome.status === "busy") {
      return toToolResult({ ok: false, code: "busy" });
    }
    if (outcome.status !== "confirmed") {
      return toToolResult({ ok: false, code: "user_declined" });
    }

    try {
      const response = await requestAgentHandoff({
        installationId: getAgentInstallationId(),
        recommendationId,
        targetType: targetType as HandoffTargetType,
        targetExternalId,
        channel,
        consentToken: outcome.consentToken,
        idempotencyKey: outcome.idempotencyKey,
      });
      return toToolResult(response);
    } catch (error) {
      return toToolResult(errorEnvelope(error));
    }
  },
};

/**
 * Registers the agent tools when a WebMCP-capable browser is present.
 * Silent no-op in every other browser. Idempotent (StrictMode/HMR safe).
 */
export function registerAgentTools(): void {
  if (alreadyRegistered()) return;

  const modelContext = detectModelContext();
  if (!modelContext) return;

  ensureHandoffConsentCardMounted();

  const tools = [
    searchTool,
    businessDetailsTool,
    verificationTool,
    recordInterestTool,
    handoffTool,
  ];
  // Incremental (`registerTool`) is preferred over bulk (`provideContext`)
  // when a browser offers both: only the incremental call takes the per-tool
  // `{ signal }` option, so bulk would quietly drop the scoped registration.
  // `src/register.ts` makes the same choice for the same reason.
  // Registration is not atomic and WebMCP offers no rollback. If a later tool
  // fails after an earlier one landed, the earlier one is still live in the
  // host — so the failure path must still mark, or a later call would register
  // it a second time: duplicate executions, duplicate consent prompts, or a
  // hard failure on a host enforcing unique tool names.
  let anyRegistered = false;
  try {
    if (modelContext.registerTool) {
      const signal =
        typeof AbortController !== "undefined"
          ? new AbortController().signal
          : undefined;
      for (const tool of tools) {
        try {
          // Pass { signal } for implementations that support scoped
          // registration; retry without options if the options bag is
          // rejected.
          modelContext.registerTool(tool, signal ? { signal } : undefined);
        } catch {
          modelContext.registerTool(tool);
        }
        anyRegistered = true;
      }
    } else if (modelContext.provideContext) {
      modelContext.provideContext({ tools });
    }
    // Marked only AFTER registration succeeds. Setting it earlier made a
    // transient or tool-specific failure permanent: the catch below swallows
    // the error, and every later call would then exit through
    // alreadyRegistered() with some or all tools missing and no way to retry.
    markRegistered();
  } catch (error) {
    // The lane is optional; never surface registration failures to visitors.
    // Mark ONLY if something actually registered: a clean failure stays
    // retryable, a partial one must not be retried (see above).
    if (anyRegistered) markRegistered();
    console.debug("[webmcp] agent tool registration failed", error);
  }
}
