/**
 * Thin fetch client for the same-origin agent gateway endpoints.
 *
 * Two conventions worth copying:
 *
 * - A non-2xx response throws `AgentGatewayApiError` carrying the server's
 *   stable public code; 429 is special-cased as a rate limit.
 * - A 200 response with `ok: false` is NOT an error. It is a refusal the model
 *   should read and reason about — the person declined, the recommendation
 *   expired, the feature is off — so it comes back as a typed union rather
 *   than an exception. Throwing here would turn an answerable outcome into an
 *   opaque dead end.
 *
 * The endpoint paths are the deployed ones; see schemas/openapi.yaml for the
 * request and response shapes.
 */

export class AgentGatewayApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "AgentGatewayApiError";
    this.code = code;
    this.status = status;
  }
}

export type AgentGatewayRefusal = {
  ok: false;
  code?: string;
};

export type AgentSearchItem = {
  type: string;
  externalId: string;
  name: string;
  category?: string;
  city?: string;
  verifiedBadge?: boolean;
} & Record<string, unknown>;

export type AgentSearchResponse =
  | {
      ok?: true;
      items: AgentSearchItem[];
      recommendationId: string | null;
    }
  | AgentGatewayRefusal;

export type AgentBusinessResponse =
  | {
      ok: true;
      business: {
        externalId?: string;
        name?: string;
        description?: string;
        category?: string;
        location?: string;
        website?: string;
        imageUrl?: string;
      };
    }
  | AgentGatewayRefusal;

export type AgentVerificationResponse =
  | { ok: true; status: "verified"; passportUrl: string }
  | { ok: true; status: "not_listed" }
  | { ok: true; status: "exposure_disabled" }
  | AgentGatewayRefusal;

export type AgentActionResponse = {
  recorded: boolean;
  reason?: string;
};

export type AgentHandoffResponse =
  | {
      ok: true;
      journeyId: string;
      token: string;
      expiresAt: number;
      attributionIncluded: boolean;
      replayed: boolean;
    }
  | AgentGatewayRefusal;

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    const payload = (await response.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
    };
    throw new AgentGatewayApiError(
      payload.code || payload.error || "rate_limit",
      429,
    );
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
    };
    throw new AgentGatewayApiError(
      payload.code || payload.error || "agent_gateway_failed",
      response.status,
    );
  }

  return (await response.json()) as T;
}

export async function requestAgentSearch(args: {
  installationId: string;
  query?: string;
  category?: string;
  kind?: string;
  limit?: number;
}): Promise<AgentSearchResponse> {
  return postJson<AgentSearchResponse>("/api/agent/search", {
    installationId: args.installationId,
    query: args.query,
    category: args.category,
    kind: args.kind,
    limit: args.limit,
  });
}

export async function requestAgentBusiness(args: {
  externalId: string;
}): Promise<AgentBusinessResponse> {
  return postJson<AgentBusinessResponse>("/api/agent/business", {
    externalId: args.externalId,
  });
}

export async function requestAgentVerification(args: {
  externalId: string;
}): Promise<AgentVerificationResponse> {
  return postJson<AgentVerificationResponse>("/api/agent/verification", {
    externalId: args.externalId,
  });
}

export async function recordAgentAction(args: {
  installationId: string;
  recommendationId: string;
  action: "tap" | "save" | "directions";
  targetType: string;
  targetId: string;
}): Promise<AgentActionResponse> {
  return postJson<AgentActionResponse>("/api/agent/action", {
    installationId: args.installationId,
    recommendationId: args.recommendationId,
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId,
  });
}

/**
 * Must only be called with a consentToken obtained from the consent card's
 * resolution (see consentBridge.ts) — the token constant is private to the
 * card module, so execute code cannot fabricate it.
 */
export async function requestAgentHandoff(args: {
  installationId: string;
  recommendationId: string;
  targetType: "event" | "tour";
  targetExternalId: string;
  channel: string;
  consentToken: string;
  /** Minted once per consent-card open (consentBridge) so retries replay. */
  idempotencyKey: string;
}): Promise<AgentHandoffResponse> {
  return postJson<AgentHandoffResponse>("/api/agent/handoff", {
    installationId: args.installationId,
    recommendationId: args.recommendationId,
    targetType: args.targetType,
    targetExternalId: args.targetExternalId,
    channel: args.channel,
    consentToken: args.consentToken,
    idempotencyKey: args.idempotencyKey,
  });
}
