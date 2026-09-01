/**
 * Thin fetch client for the same-origin agent gateway endpoints.
 *
 * Error idiom copied from client/src/lib/webDemoApi.ts: non-2xx responses
 * throw AgentGatewayApiError with `payload.code || payload.error`, 429 is
 * special-cased as a rate limit. 200-with-`ok:false` envelopes are returned as
 * typed unions, not thrown.
 *
 * Response types are deliberately duplicated here rather than imported from
 * shared/agentGateway.ts — that module is owned by the server lane and
 * parallel editing would race; the small duplication is accepted and reviewed
 * later.
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

export type AgentHandoffConsentResponse =
  | {
      ok: true;
      consentProof: string;
      expiresAt: number;
      targetType: "event" | "tour";
    }
  | AgentGatewayRefusal;

export type AgentHandoffOpenResponse =
  | {
      ok: true;
      destinationUrl: string;
      attributionIncluded: boolean;
      replayed: boolean;
      sequence: number;
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

/** Exchange the visible card's UI signal for an operation-bound server proof. */
export async function requestAgentHandoffConsent(args: {
  installationId: string;
  recommendationId: string;
  targetExternalId: string;
  channel: "event_detail";
  consentToken: string;
  idempotencyKey: string;
}): Promise<AgentHandoffConsentResponse> {
  return postJson<AgentHandoffConsentResponse>("/api/agent/handoff-consent", {
    installationId: args.installationId,
    recommendationId: args.recommendationId,
    targetExternalId: args.targetExternalId,
    channel: args.channel,
    consentToken: args.consentToken,
    idempotencyKey: args.idempotencyKey,
  });
}

/**
 * The static card marker is only a UI signal. The ledger accepts the
 * short-lived, one-time server proof returned by requestAgentHandoffConsent.
 */
export async function requestAgentHandoff(args: {
  installationId: string;
  recommendationId: string;
  targetType: "event" | "tour";
  targetExternalId: string;
  channel: string;
  consentToken: string;
  consentProof: string;
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
    consentProof: args.consentProof,
    idempotencyKey: args.idempotencyKey,
  });
}

/** Redeem a signed, installation-owned handoff into its attributed URL. */
export async function openAgentHandoff(args: {
  installationId: string;
  token: string;
  idempotencyKey: string;
}): Promise<AgentHandoffOpenResponse> {
  return postJson<AgentHandoffOpenResponse>("/api/agent/handoff-open", {
    installationId: args.installationId,
    token: args.token,
    idempotencyKey: args.idempotencyKey,
  });
}
