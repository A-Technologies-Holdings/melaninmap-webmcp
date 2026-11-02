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
 *    trusted client-address header, never a body field) and only then signs,
 *    binding the proof to the exact tool and arguments the page confirmed.
 * 2. `performConsequentialAction` verifies the proof (single use, via the
 *    ledger), then runs the action under an idempotency key, so a retried
 *    request replays the first result instead of acting twice, and the same
 *    key with different arguments is a conflict, never a silent replay.
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
  subject?: string;
  proof?: unknown;
  idempotencyKey?: string;
};

export type GatewayResponse = { status: number; body: Record<string, unknown> };

const refused: GatewayResponse = { status: 403, body: { ok: false, error: "refused" } };

export function createConsentGateway(options: {
  secret: ConsentProofSecret;
  audience: string;
  ledger?: NonceLedger;
  idempotency?: IdempotencyStore;
  /** Proof-issuance ceiling per remote key. */
  issueLimit?: { limit: number; windowMs: number };
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
  const refuse = (reason: string, request: GatewayRequest): GatewayResponse => {
    try { options.onRefusal?.(reason, request); } catch { /* Logging must not change the answer. */ }
    return refused;
  };

  return {
    async issueConsentProof(request) {
      if (!limiter.check(request.remoteKey).allowed) return refuse("rate_limited", request);
      try {
        const proof = await signConsentProof({
          secret: options.secret,
          toolName: request.toolName,
          args: request.args,
          audience: options.audience,
          subject: request.subject,
          ttlMs: 60_000,
        });
        return { status: 200, body: { ok: true, proof } };
      } catch {
        return refuse("cannot_issue", request);
      }
    },

    async performConsequentialAction(request, action) {
      const verification = await verifyConsentProof({
        secret: options.secret,
        proof: request.proof,
        toolName: request.toolName,
        args: request.args,
        audience: options.audience,
        subject: request.subject,
        consume: ledger.consume,
      });
      if (!verification.ok) return refuse(verification.reason, request);
      if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.length === 0) {
        return refuse("missing_idempotency_key", request);
      }
      const result = await idempotency.execute(
        request.idempotencyKey,
        verification.claims.argsDigest,
        async () => {
          const value = await action(request.args);
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
      return {
        status: 200,
        body: { ok: true, replayed: result.status === "replayed", value: result.value ?? null },
      };
    },
  };
}
