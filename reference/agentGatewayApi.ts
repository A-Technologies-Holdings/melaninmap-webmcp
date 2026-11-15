/**
 * Thin fetch client for the same-origin agent gateway endpoints.
 *
 * Error idiom copied from client/src/lib/webDemoApi.ts: non-2xx responses
 * throw AgentGatewayApiError with a stable public `payload.code` or
 * `payload.error`; unsafe values fall back to a local code. 429 is special-cased
 * as a rate limit. 200-with-`ok:false` envelopes are returned as typed unions,
 * not thrown.
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
  type: "business" | "event";
  externalId: string;
  name: string;
  category?: string;
  city?: string;
  verifiedBadge?: boolean;
};

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

/**
 * Bounds for fields that can cross from the catalog into model-visible text.
 * Invalid gateway data is refused as a whole rather than silently truncated.
 */
const MODEL_VISIBLE_LIMITS = {
  itemCount: 16,
  identifier: 200,
  name: 256,
  category: 128,
  city: 128,
  description: 4_000,
  location: 512,
  url: 2_048,
  refusalCode: 100,
} as const;

const INVALID_GATEWAY_RESPONSE = {
  ok: false,
  code: "invalid_gateway_response",
} as const;

const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_.-]+$/;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(
  value: unknown,
  maximum: number,
  allowEmpty = true,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum
  );
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  maximum: number,
): boolean {
  const value = source[key];
  if (value === undefined) return true;
  if (!boundedString(value, maximum)) return false;
  target[key] = value;
  return true;
}

function publicCode(value: unknown): value is string {
  return (
    boundedString(value, MODEL_VISIBLE_LIMITS.refusalCode, false) &&
    PUBLIC_CODE_PATTERN.test(value)
  );
}

function gatewayErrorCode(payload: unknown, fallback: string): string {
  const source = objectRecord(payload);
  if (!source) return fallback;
  if (publicCode(source.code)) return source.code;
  if (publicCode(source.error)) return source.error;
  return fallback;
}

function projectRefusal(
  source: Record<string, unknown>,
): AgentGatewayRefusal {
  if (source.code === undefined) return { ok: false };
  if (!publicCode(source.code)) {
    return INVALID_GATEWAY_RESPONSE;
  }
  return { ok: false, code: source.code };
}

function projectSearchItem(value: unknown): AgentSearchItem | null {
  const source = objectRecord(value);
  if (!source || (source.type !== "business" && source.type !== "event")) {
    return null;
  }
  if (
    !boundedString(
      source.externalId,
      MODEL_VISIBLE_LIMITS.identifier,
      false,
    ) ||
    !boundedString(source.name, MODEL_VISIBLE_LIMITS.name)
  ) {
    return null;
  }

  const projected: Record<string, unknown> = {
    type: source.type,
    externalId: source.externalId,
    name: source.name,
  };
  if (
    !copyOptionalString(
      source,
      projected,
      "category",
      MODEL_VISIBLE_LIMITS.category,
    ) ||
    !copyOptionalString(source, projected, "city", MODEL_VISIBLE_LIMITS.city)
  ) {
    return null;
  }
  if (source.verifiedBadge !== undefined) {
    if (typeof source.verifiedBadge !== "boolean") return null;
    projected.verifiedBadge = source.verifiedBadge;
  }
  return projected as AgentSearchItem;
}

function projectSearchResponse(value: unknown): AgentSearchResponse {
  const source = objectRecord(value);
  if (!source) return INVALID_GATEWAY_RESPONSE;
  if (source.ok === false) return projectRefusal(source);
  if (source.ok !== undefined && source.ok !== true) {
    return INVALID_GATEWAY_RESPONSE;
  }
  if (
    !Array.isArray(source.items) ||
    source.items.length > MODEL_VISIBLE_LIMITS.itemCount
  ) {
    return INVALID_GATEWAY_RESPONSE;
  }
  const items: AgentSearchItem[] = [];
  for (const value of source.items) {
    const item = projectSearchItem(value);
    if (!item) return INVALID_GATEWAY_RESPONSE;
    items.push(item);
  }
  if (
    source.recommendationId !== null &&
    !boundedString(
      source.recommendationId,
      MODEL_VISIBLE_LIMITS.identifier,
      false,
    )
  ) {
    return INVALID_GATEWAY_RESPONSE;
  }
  const projected: Exclude<AgentSearchResponse, AgentGatewayRefusal> = {
    items,
    recommendationId: source.recommendationId,
  };
  if (source.ok === true) projected.ok = true;
  return projected;
}

function projectBusinessResponse(value: unknown): AgentBusinessResponse {
  const source = objectRecord(value);
  if (!source) return INVALID_GATEWAY_RESPONSE;
  if (source.ok === false) return projectRefusal(source);
  if (source.ok !== true) return INVALID_GATEWAY_RESPONSE;

  const business = objectRecord(source.business);
  if (!business) return INVALID_GATEWAY_RESPONSE;
  const projected: Record<string, unknown> = {};
  if (
    !copyOptionalString(
      business,
      projected,
      "externalId",
      MODEL_VISIBLE_LIMITS.identifier,
    ) ||
    !copyOptionalString(
      business,
      projected,
      "name",
      MODEL_VISIBLE_LIMITS.name,
    ) ||
    !copyOptionalString(
      business,
      projected,
      "description",
      MODEL_VISIBLE_LIMITS.description,
    ) ||
    !copyOptionalString(
      business,
      projected,
      "category",
      MODEL_VISIBLE_LIMITS.category,
    ) ||
    !copyOptionalString(
      business,
      projected,
      "location",
      MODEL_VISIBLE_LIMITS.location,
    ) ||
    !copyOptionalString(
      business,
      projected,
      "website",
      MODEL_VISIBLE_LIMITS.url,
    ) ||
    !copyOptionalString(
      business,
      projected,
      "imageUrl",
      MODEL_VISIBLE_LIMITS.url,
    )
  ) {
    return INVALID_GATEWAY_RESPONSE;
  }
  return {
    ok: true,
    business: projected,
  } as AgentBusinessResponse;
}

function projectVerificationResponse(value: unknown): AgentVerificationResponse {
  const source = objectRecord(value);
  if (!source) return INVALID_GATEWAY_RESPONSE;
  if (source.ok === false) return projectRefusal(source);
  if (source.ok !== true) return INVALID_GATEWAY_RESPONSE;
  if (source.status === "verified") {
    return boundedString(source.passportUrl, MODEL_VISIBLE_LIMITS.url, false)
      ? { ok: true, status: "verified", passportUrl: source.passportUrl }
      : INVALID_GATEWAY_RESPONSE;
  }
  if (
    source.status === "not_listed" ||
    source.status === "exposure_disabled"
  ) {
    return { ok: true, status: source.status };
  }
  return INVALID_GATEWAY_RESPONSE;
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  // The host's signal aborts the request itself, so a cancelled tool call
  // stops waiting at once instead of holding a connection it will ignore.
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (response.status === 429) {
    const payload: unknown = await response.json().catch(() => ({}));
    throw new AgentGatewayApiError(gatewayErrorCode(payload, "rate_limit"), 429);
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => ({}));
    throw new AgentGatewayApiError(
      gatewayErrorCode(payload, "agent_gateway_failed"),
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
}, signal?: AbortSignal): Promise<AgentSearchResponse> {
  const response = await postJson<unknown>("/api/agent/search", {
    installationId: args.installationId,
    query: args.query,
    category: args.category,
    kind: args.kind,
    limit: args.limit,
  }, signal);
  return projectSearchResponse(response);
}

export async function requestAgentBusiness(args: {
  externalId: string;
}, signal?: AbortSignal): Promise<AgentBusinessResponse> {
  const response = await postJson<unknown>("/api/agent/business", {
    externalId: args.externalId,
  }, signal);
  return projectBusinessResponse(response);
}

export async function requestAgentVerification(args: {
  externalId: string;
}, signal?: AbortSignal): Promise<AgentVerificationResponse> {
  const response = await postJson<unknown>("/api/agent/verification", {
    externalId: args.externalId,
  }, signal);
  return projectVerificationResponse(response);
}

export async function recordAgentAction(args: {
  installationId: string;
  recommendationId: string;
  action: "tap" | "save" | "directions";
  targetType: string;
  targetId: string;
}, signal?: AbortSignal): Promise<AgentActionResponse> {
  return postJson<AgentActionResponse>("/api/agent/action", {
    installationId: args.installationId,
    recommendationId: args.recommendationId,
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId,
  }, signal);
}

/** Exchange the visible card's UI signal for an operation-bound server proof. */
export async function requestAgentHandoffConsent(args: {
  installationId: string;
  recommendationId: string;
  targetExternalId: string;
  channel: "event_detail";
  consentToken: string;
  idempotencyKey: string;
}, signal?: AbortSignal): Promise<AgentHandoffConsentResponse> {
  return postJson<AgentHandoffConsentResponse>("/api/agent/handoff-consent", {
    installationId: args.installationId,
    recommendationId: args.recommendationId,
    targetExternalId: args.targetExternalId,
    channel: args.channel,
    consentToken: args.consentToken,
    idempotencyKey: args.idempotencyKey,
  }, signal);
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
}, signal?: AbortSignal): Promise<AgentHandoffResponse> {
  return postJson<AgentHandoffResponse>("/api/agent/handoff", {
    installationId: args.installationId,
    recommendationId: args.recommendationId,
    targetType: args.targetType,
    targetExternalId: args.targetExternalId,
    channel: args.channel,
    consentToken: args.consentToken,
    consentProof: args.consentProof,
    idempotencyKey: args.idempotencyKey,
  }, signal);
}

/** Redeem a signed, installation-owned handoff into its attributed URL. */
export async function openAgentHandoff(args: {
  installationId: string;
  token: string;
  idempotencyKey: string;
}, signal?: AbortSignal): Promise<AgentHandoffOpenResponse> {
  return postJson<AgentHandoffOpenResponse>("/api/agent/handoff-open", {
    installationId: args.installationId,
    token: args.token,
    idempotencyKey: args.idempotencyKey,
  }, signal);
}
