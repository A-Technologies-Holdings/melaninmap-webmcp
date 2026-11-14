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
 * 2. `performConsequentialAction` authenticates the request, then coordinates
 *    exact transport retries before consuming the proof (single use, via the
 *    ledger) and running the action under an idempotency key. The exact same
 *    proof and request identity can replay a retained result, while a changed
 *    key or request must spend a fresh proof and can never act twice.
 * 3. Every refusal is the same undifferentiated 403 to the client. The
 *    specific reason goes to your server log only, so the endpoint is not
 *    an oracle for which check a forgery got past.
 *
 * The in-memory stores are single-instance references. Behind more than one
 * instance, back the same shapes with an atomic shared store.
 */

import {
  argsDigest,
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
  /** Server-authenticated caller identity, never a client body field. */
  subject?: string;
  proof?: unknown;
  idempotencyKey?: string;
};

export type GatewayResponse = { status: number; body: Record<string, unknown> };

const refused: GatewayResponse = { status: 403, body: { ok: false, error: "refused" } };

type AuthenticatedActionOutcome =
  | { ok: true; replayed: boolean; value: unknown }
  | { ok: false; reason: string };

export function createConsentGateway(options: {
  secret: ConsentProofSecret;
  audience: string;
  ledger?: NonceLedger;
  idempotency?: IdempotencyStore;
  /** Share with the ledger; retain entries through the proof acceptance window. */
  authenticatedRetries?: IdempotencyStore;
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
  const authenticatedRetries =
    options.authenticatedRetries ?? createInMemoryIdempotencyStore();
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
      // Snapshot every request field used by verification and execution so a
      // host object with getters cannot change the operation between checks.
      const { proof, toolName, args, subject, idempotencyKey } = request;
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
        return refuse("missing_idempotency_key", request);
      }

      const verify = (consume: NonceLedger["consume"]) => verifyConsentProof({
        secret: options.secret,
        proof,
        toolName,
        args,
        audience: options.audience,
        subject,
        consume,
      });

      // This pass authenticates and binds the lookup but cannot authorize an
      // action: a new identity still reaches the real ledger consume below.
      const authentication = await verify(async () => true);
      if (!authentication.ok) return refuse(authentication.reason, request);
      const proofFingerprint = await argsDigest(
        "webmcp.consent.retry-proof.v1",
        proof,
      );
      const retryIdentity = JSON.stringify([
        "webmcp.consent.authenticated-retry.v1",
        proofFingerprint,
        idempotencyKey,
        authentication.claims.argsDigest,
        authentication.claims.audience,
        authentication.claims.subject ?? null,
      ]);
      const retryFingerprint = JSON.stringify([
        authentication.claims.toolName,
        authentication.claims.argsDigest,
      ]);

      const retry = await authenticatedRetries.execute<AuthenticatedActionOutcome>(
        retryIdentity,
        retryFingerprint,
        async () => {
          const verification = await verify(
            (nonce, expiresAt) => ledger.consume(nonce, expiresAt),
          );
          if (!verification.ok) return { ok: false, reason: verification.reason };

          const result = await idempotency.execute(
            JSON.stringify([
              verification.claims.audience,
              verification.claims.subject ?? null,
              idempotencyKey,
            ]),
            verification.claims.argsDigest,
            async () => {
              const value = await action(args);
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
          if (result.status === "conflict") {
            return { ok: false, reason: "idempotency_conflict" };
          }
          if (result.status === "capacity_exceeded") {
            return { ok: false, reason: "idempotency_capacity" };
          }
          return {
            ok: true,
            replayed: result.status === "replayed",
            value: result.value,
          };
        },
      );
      if (retry.status === "conflict") {
        return refuse("authenticated_retry_conflict", request);
      }
      if (retry.status === "capacity_exceeded") {
        return refuse("idempotency_capacity", request);
      }
      if (!retry.value.ok) return refuse(retry.value.reason, request);
      return {
        status: 200,
        body: {
          ok: true,
          replayed: retry.status === "replayed" || retry.value.replayed,
          value: retry.value.value ?? null,
        },
      };
    },
  };
}
