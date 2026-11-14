/**
 * Copyable reference gateway for the server half of the consent gate.
 *
 * Framework-agnostic: each handler takes a plain request object and returns
 * a plain `{ status, body }`, so wiring it into Express, Fastify, a Worker
 * or a serverless function is a five-line adapter. In a published app these
 * imports come from "@melaninmap/webmcp-consent/server"; the relative paths
 * here keep this file typechecking inside the package.
 *
 * The shape, and why:
 *
 * 1. `issueConsentProof` is the ONLY route that mints proofs. It rate limits
 *    on the network origin the server observed (`remoteKey` — your proxy's
 *    trusted client-address header, never a body field), requires an
 *    authenticated subject and calls the application's authorization policy.
 *    Only the policy's normalized operation is signed; request fields never
 *    become authority by themselves.
 * 2. `performConsequentialAction` has its own rate limit, reapplies the policy
 *    so current server state still authorizes the operation, verifies the
 *    proof (single use, via the ledger), and gives only normalized arguments
 *    to the action. It runs under an idempotency key, so a retry replays the
 *    first result instead of acting twice, and the same key with different
 *    arguments is a conflict, never a silent replay.
 * 3. Every refusal is the same undifferentiated 403 to the client. The
 *    specific reason goes to your server log only, so the endpoint is not
 *    an oracle for which check a forgery got past.
 *
 * The in-memory stores are single-instance references. Behind more than one
 * instance, back the same shapes with an atomic shared store.
 */

import {
  createInMemoryIdempotencyStore,
  createInMemoryNonceLedger,
  createRateLimiter,
  signConsentProof,
  verifyConsentProof,
  type ConsentProofSecret,
  type IdempotencyStore,
  type NonceLedger,
  type RateLimiter,
} from "../src/server.js";

export type GatewayRequest = {
  toolName: string;
  args: unknown;
  /** Server-observed caller key (network origin). Never a body field. */
  remoteKey: string;
  /** Identity populated from the server's authenticated session. Never a body field. */
  authenticatedSubject: string;
  proof?: unknown;
  idempotencyKey?: string;
};

export type GatewayResponse = { status: number; body: Record<string, unknown> };

export type GatewayAuthorizationRequest = Readonly<Pick<
  GatewayRequest,
  "toolName" | "args" | "remoteKey" | "authenticatedSubject"
>>;

export type GatewayAuthorizedOperation = Readonly<{
  toolName: string;
  args: unknown;
}>;

export type GatewayAuthorizationDecision =
  | Readonly<{ authorized: true; operation: GatewayAuthorizedOperation }>
  | Readonly<{ authorized: false }>;

export type GatewayAuthorizationPolicy = (
  request: GatewayAuthorizationRequest,
) => GatewayAuthorizationDecision | Promise<GatewayAuthorizationDecision>;

/** A recommendation record minted and stored by the server, never accepted from the body. */
export type HoldTicketsRecommendation = Readonly<{
  recommendationId: string;
  subject: string;
  eventId: string;
  maxQuantity: number;
  expiresAt: number;
}>;

type HoldTicketsArgs = {
  recommendationId: string;
  eventId: string;
  quantity: number;
};

const HOLD_TICKETS_KEYS = ["recommendationId", "eventId", "quantity"] as const;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TICKET_QUANTITY = 8;

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readHoldTicketsArgs(value: unknown): HoldTicketsArgs | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== HOLD_TICKETS_KEYS.length || HOLD_TICKETS_KEYS.some((key) => !keys.includes(key))) {
    return null;
  }
  const descriptors = HOLD_TICKETS_KEYS.map((key) => Object.getOwnPropertyDescriptor(value, key));
  if (descriptors.some((descriptor) =>
    descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
  )) return null;
  const [recommendation, event, quantityProperty] = descriptors;
  const recommendationId = recommendation!.value as unknown;
  const eventId = event!.value as unknown;
  const quantity = quantityProperty!.value as unknown;
  if (
    !boundedIdentifier(recommendationId) || !boundedIdentifier(eventId) ||
    typeof quantity !== "number" || !Number.isInteger(quantity) ||
    quantity < 1 || quantity > MAX_TICKET_QUANTITY
  ) return null;
  return { recommendationId, eventId, quantity };
}

/**
 * Concrete policy for the ticket example: one tool, an exact argument schema,
 * a hard quantity ceiling, an authenticated subject and a live server-minted
 * recommendation whose target and per-recommendation ceiling must match.
 */
export function createHoldTicketsAuthorizationPolicy(options: {
  loadRecommendation: (
    recommendationId: string,
  ) => HoldTicketsRecommendation | undefined | Promise<HoldTicketsRecommendation | undefined>;
  now?: () => number;
}): GatewayAuthorizationPolicy {
  const now = options.now ?? Date.now;
  return async (request) => {
    if (request.toolName !== "hold_tickets" || !nonEmptyString(request.authenticatedSubject)) {
      return { authorized: false };
    }
    const args = readHoldTicketsArgs(request.args);
    if (args === null) return { authorized: false };
    const recommendation = await options.loadRecommendation(args.recommendationId);
    const currentTime = now();
    if (
      recommendation === undefined ||
      !boundedIdentifier(recommendation.recommendationId) ||
      recommendation.recommendationId !== args.recommendationId ||
      !boundedIdentifier(recommendation.eventId) ||
      recommendation.eventId !== args.eventId ||
      recommendation.subject !== request.authenticatedSubject ||
      !Number.isInteger(recommendation.maxQuantity) ||
      recommendation.maxQuantity < 1 || recommendation.maxQuantity > MAX_TICKET_QUANTITY ||
      args.quantity > recommendation.maxQuantity ||
      !Number.isSafeInteger(recommendation.expiresAt) ||
      !Number.isSafeInteger(currentTime) || currentTime < 0 ||
      recommendation.expiresAt <= currentTime
    ) return { authorized: false };
    return {
      authorized: true,
      operation: {
        toolName: "hold_tickets",
        args: Object.freeze({
          recommendationId: recommendation.recommendationId,
          eventId: recommendation.eventId,
          quantity: args.quantity,
        }),
      },
    };
  };
}

const refused: GatewayResponse = { status: 403, body: { ok: false, error: "refused" } };

export function createConsentGateway(options: {
  secret: ConsentProofSecret;
  audience: string;
  /** Required fail-closed application policy. Its normalized operation is the only signable input. */
  authorize: GatewayAuthorizationPolicy;
  ledger?: NonceLedger;
  idempotency?: IdempotencyStore;
  /** Proof-issuance ceiling per remote key. */
  issueLimit?: { limit: number; windowMs: number };
  /** Independent consequential-action ceiling per remote key. */
  actionLimit?: { limit: number; windowMs: number };
  onRefusal?: (reason: string, request: GatewayRequest) => void;
  log?: (record: Record<string, unknown>) => void;
}): {
  issueConsentProof(request: GatewayRequest): Promise<GatewayResponse>;
  performConsequentialAction(
    request: GatewayRequest,
    action: (args: unknown) => Promise<unknown>,
  ): Promise<GatewayResponse>;
} {
  const ledger = options.ledger ?? createInMemoryNonceLedger();
  const idempotency = options.idempotency ?? createInMemoryIdempotencyStore();
  const limiter: RateLimiter = createRateLimiter(
    options.issueLimit ?? { limit: 30, windowMs: 60_000 },
  );
  const actionLimiter: RateLimiter = createRateLimiter(
    options.actionLimit ?? { limit: 60, windowMs: 60_000 },
  );
  const refuse = (reason: string, request: GatewayRequest): GatewayResponse => {
    try { options.onRefusal?.(reason, request); } catch { /* Logging must not change the answer. */ }
    return refused;
  };
  const authorize = async (request: GatewayRequest): Promise<
    | { ok: true; operation: GatewayAuthorizedOperation; subject: string }
    | { ok: false; reason: string }
  > => {
    try {
      const subject = request.authenticatedSubject;
      if (!nonEmptyString(subject)) return { ok: false, reason: "unauthenticated" };
      const policyRequest: GatewayAuthorizationRequest = Object.freeze({
        toolName: request.toolName,
        args: request.args,
        remoteKey: request.remoteKey,
        authenticatedSubject: subject,
      });
      const decision = await options.authorize(policyRequest);
      if (decision === null || typeof decision !== "object" || decision.authorized !== true) {
        return { ok: false, reason: "not_authorized" };
      }
      const operation = decision.operation;
      if (
        operation === null || typeof operation !== "object" ||
        typeof operation.toolName !== "string" || operation.toolName.length === 0 ||
        !Object.prototype.hasOwnProperty.call(operation, "args")
      ) return { ok: false, reason: "invalid_authorization" };
      return {
        ok: true,
        subject,
        operation: { toolName: operation.toolName, args: operation.args },
      };
    } catch {
      return { ok: false, reason: "authorization_failed" };
    }
  };

  return {
    async issueConsentProof(request) {
      if (!limiter.check(request.remoteKey).allowed) return refuse("rate_limited", request);
      const authorization = await authorize(request);
      if (!authorization.ok) return refuse(authorization.reason, request);
      try {
        const proof = await signConsentProof({
          secret: options.secret,
          toolName: authorization.operation.toolName,
          args: authorization.operation.args,
          audience: options.audience,
          subject: authorization.subject,
          ttlMs: 60_000,
        });
        return { status: 200, body: { ok: true, proof } };
      } catch {
        return refuse("cannot_issue", request);
      }
    },

    async performConsequentialAction(request, action) {
      if (!actionLimiter.check(request.remoteKey).allowed) {
        return refuse("action_rate_limited", request);
      }
      const authorization = await authorize(request);
      if (!authorization.ok) return refuse(authorization.reason, request);
      const verification = await verifyConsentProof({
        secret: options.secret,
        proof: request.proof,
        toolName: authorization.operation.toolName,
        args: authorization.operation.args,
        audience: options.audience,
        subject: authorization.subject,
        consume: ledger.consume,
      });
      if (!verification.ok) return refuse(verification.reason, request);
      if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.length === 0) {
        return refuse("missing_idempotency_key", request);
      }
      const result = await idempotency.execute(
        JSON.stringify([
          verification.claims.audience,
          verification.claims.subject ?? null,
          request.idempotencyKey,
        ]),
        verification.claims.argsDigest,
        async () => {
          const value = await action(authorization.operation.args);
          try {
            options.log?.({
              type: "webmcp.consent.action",
              toolName: verification.claims.toolName,
              argsDigest: verification.claims.argsDigest,
              nonce: verification.claims.nonce,
              at: new Date().toISOString(),
            });
          } catch { /* The action already ran; logging must not fail it. */ }
          return value;
        },
      );
      if (result.status === "conflict") return refuse("idempotency_conflict", request);
      if (result.status === "capacity_exceeded") return refuse("idempotency_capacity", request);
      return {
        status: 200,
        body: { ok: true, replayed: result.status === "replayed", value: result.value ?? null },
      };
    },
  };
}
