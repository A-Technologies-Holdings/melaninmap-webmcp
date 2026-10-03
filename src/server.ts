/**
 * `@melaninmap/webmcp-consent/server` — mint and check consent proofs.
 *
 * The consent gate's audit token is not a credential. Anything your page can
 * send, a script can send. This entry point is the pattern that makes the
 * confirmation worth something on the server anyway, generalized from the
 * one Melanin Map runs in production:
 *
 * 1. The page's tool collects a confirmation through the gate.
 * 2. Its `exchangeConsent` calls YOUR consent endpoint with the tool name and
 *    the `argsDigest` of the exact arguments. That endpoint applies whatever
 *    checks you have (session, rate limits, server-minted state) and answers
 *    with `signConsentProof(...)`.
 * 3. `execute` sends the proof with the action. The action endpoint
 *    recomputes the digest from the arguments it received and calls
 *    `verifyConsentProof(...)` before doing anything.
 *
 * ## What a valid proof proves
 *
 * That your consent endpoint, holding the secret, issued it recently, for
 * this exact tool, these exact arguments and this audience, and that it has
 * not been used before. That closes the direct-writer bypass (the action
 * endpoint no longer accepts a bare "consent: yes" field), binds
 * authorization to one exact operation (a proof for one target cannot be
 * replayed against another), and makes the work rate-limitable at the point
 * where proofs are issued.
 *
 * ## What it does not prove
 *
 * That a human was present. The consent endpoint cannot see the page. A
 * script controlling the same browser session can call it exactly as the
 * page does, with exactly the same inputs, and receive a perfectly valid
 * proof. The proof is authorization for one bounded operation, not evidence
 * of a person. Rate limit the consent endpoint on something the caller cannot
 * rotate, and keep money and personal data off this path. See SECURITY.md.
 *
 * ## Format
 *
 * `v1.<payload>.<mac>`, both parts unpadded base64url. The payload is UTF-8
 * JSON `{ v, aud, tool, args, iat, exp, nonce }`; the MAC is HMAC-SHA-256
 * over the ASCII bytes of `v1.<payload>`. The payload is signed, not
 * encrypted: it holds a tool name and a digest, never the arguments
 * themselves, but treat it as readable.
 *
 * WebCrypto only — no `node:` imports — so this runs unchanged in Node 22+,
 * browsers and Workers. Never put the secret in a browser bundle; it runs in
 * a browser only so tests and edge runtimes can share it.
 */

export { argsDigest } from "./digest.js";

/** Tolerated clock difference between the server that signs and the one that verifies. */
export const CONSENT_PROOF_CLOCK_SKEW_MS = 5_000;

/** Longest lifetime `signConsentProof` will mint. Proofs are meant to be spent in seconds. */
export const CONSENT_PROOF_MAX_TTL_MS = 10 * 60_000;

/** The shortest secret accepted: 256 bits, the HMAC-SHA-256 block of entropy that matters. */
const MIN_SECRET_BYTES = 32;

/** Bounds the work an unauthenticated caller can make `verifyConsentProof` do. */
const MAX_PROOF_LENGTH = 2_048;

const VERSION = "v1";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;

/**
 * A shared secret: a string (UTF-8) or raw bytes (any typed array or
 * DataView, e.g. a Node Buffer). At least 32 bytes either way — generate it
 * randomly, e.g. `crypto.getRandomValues(new Uint8Array(32))`, and keep it
 * on the server.
 */
export type ConsentProofSecret = string | ArrayBufferView;

export type SignConsentProofOptions = {
  secret: ConsentProofSecret;
  /** The tool whose call this authorizes. */
  toolName: string;
  /** `argsDigest(toolName, args)` of the call being authorized. */
  argsDigest: string;
  /**
   * Who may accept the proof: name the action endpoint or deployment, e.g.
   * `"https://api.example.com/handoff"`. A proof minted for staging is then
   * worthless against production even if the two share a secret.
   */
  audience: string;
  /** Lifetime in ms, at most `CONSENT_PROOF_MAX_TTL_MS`. Seconds, not minutes. */
  ttlMs: number;
  /** Current time in ms since the epoch. Defaults to `Date.now()`. */
  now?: number;
};

export type VerifyConsentProofOptions = {
  secret: ConsentProofSecret;
  /** The proof as received. Anything — it is untrusted input. */
  proof: unknown;
  /** The tool this endpoint performs. */
  toolName: string;
  /** Recompute this from the arguments the endpoint is about to act on. Never take it from the client. */
  argsDigest: string;
  audience: string;
  /** Current time in ms since the epoch. Defaults to `Date.now()`. */
  now?: number;
  /**
   * Single use is YOUR storage. Called once, last, only for a proof that
   * passed every other check. Record the nonce and return `true`; if the
   * nonce was already recorded, return `false`. Do both atomically — a
   * read-then-write that two requests can interleave accepts a proof twice.
   * `expiresAt` (ms since the epoch) is when the record may be deleted: an
   * expired proof fails verification before `consume` is ever called.
   *
   * Required, because a proof that can be replayed authorizes as many
   * operations as an attacker cares to send. A throw, a rejection, or any
   * answer but `true` fails closed.
   */
  consume: (nonce: string, expiresAt: number) => Promise<boolean>;
};

export type VerifiedConsentProof = {
  toolName: string;
  argsDigest: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

/**
 * Why a proof was refused. For your logs — answer the client with one
 * undifferentiated 403, so the endpoint is not an oracle for which check a
 * forgery got past.
 */
export type ConsentProofFailure =
  /** Not a proof: wrong type, too long, wrong shape, undecodable, or an invalid payload. */
  | "malformed"
  /** The MAC does not match: tampered, or signed with another secret. */
  | "bad_signature"
  | "wrong_audience"
  | "wrong_tool"
  /** Signed for different arguments. */
  | "wrong_args"
  | "expired"
  /** Issued in the future, beyond the allowed clock skew. */
  | "not_yet_valid"
  /** `consume` returned false: this proof was already used. */
  | "replayed"
  /** `consume` threw, rejected, or answered something other than a boolean. */
  | "consume_failed"
  /** The verifier itself is misconfigured: a short secret, a bad expected value, or no WebCrypto. */
  | "misconfigured";

export type ConsentProofVerification =
  | { ok: true; proof: VerifiedConsentProof }
  | { ok: false; reason: ConsentProofFailure };

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (value === undefined) throw new TypeError("WebCrypto (crypto.subtle) is unavailable");
  return value;
}

function secretBytes(secret: unknown): Uint8Array | null {
  // isView rather than instanceof: a Node Buffer or a Uint8Array from another
  // realm is still bytes. Copied, so WebCrypto never sees a caller's buffer
  // change underneath it.
  const bytes =
    typeof secret === "string" ? new TextEncoder().encode(secret)
    : ArrayBuffer.isView(secret) ? new Uint8Array(secret.buffer, secret.byteOffset, secret.byteLength).slice()
    : null;
  return bytes !== null && bytes.byteLength >= MIN_SECRET_BYTES ? bytes : null;
}

async function hmac(secret: Uint8Array, message: string): Promise<Uint8Array> {
  const crypto = subtle();
  const key = await crypto.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.sign("HMAC", key, new TextEncoder().encode(message)));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict: only the canonical encoding of some byte string decodes. */
function fromBase64url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // Base64 lets the unused low bits of the last character vary. Rejecting any
  // non-canonical spelling keeps exactly one string per proof.
  return base64url(bytes) === text ? bytes : null;
}

/**
 * Compare two MACs without an early exit, so the time taken does not reveal
 * how many leading bytes of a forgery were right. Length is not secret (it is
 * always 32 for HMAC-SHA-256). JavaScript makes no hard constant-time
 * guarantee, but this is the comparison that leaves the JIT nothing to
 * short-circuit.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Mint a proof. Call this from your consent endpoint after your own checks,
 * never from the page.
 *
 * Rejects with a `TypeError` for invalid options — a short secret, an empty
 * tool name or audience, a digest that is not 64 lowercase hex characters, or
 * a ttl outside (0, CONSENT_PROOF_MAX_TTL_MS] — so a misconfiguration fails
 * where it is written instead of minting something unverifiable.
 */
export async function signConsentProof(options: SignConsentProofOptions): Promise<string> {
  const { secret, toolName, argsDigest: digest, audience, ttlMs, now = Date.now() } = options;
  const key = secretBytes(secret);
  if (key === null) throw new TypeError(`signConsentProof: secret must be at least ${MIN_SECRET_BYTES} bytes`);
  if (!nonEmpty(toolName)) throw new TypeError("signConsentProof: toolName must be a non-empty string");
  if (!nonEmpty(audience)) throw new TypeError("signConsentProof: audience must be a non-empty string");
  if (typeof digest !== "string" || !DIGEST_HEX.test(digest)) {
    throw new TypeError("signConsentProof: argsDigest must be a lowercase SHA-256 hex digest");
  }
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > CONSENT_PROOF_MAX_TTL_MS) {
    throw new TypeError(`signConsentProof: ttlMs must be an integer in (0, ${CONSENT_PROOF_MAX_TTL_MS}]`);
  }
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("signConsentProof: now must be a non-negative integer of ms since the epoch");
  }
  const nonceBytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(nonceBytes);
  const payload = base64url(new TextEncoder().encode(JSON.stringify({
    v: 1,
    aud: audience,
    tool: toolName,
    args: digest,
    iat: now,
    exp: now + ttlMs,
    nonce: base64url(nonceBytes),
  })));
  const signed = `${VERSION}.${payload}`;
  return `${signed}.${base64url(await hmac(key, signed))}`;
}

/**
 * Check a proof. Never throws and never rejects: every outcome, including a
 * misconfigured verifier, is a `{ ok: false, reason }`.
 *
 * Checks run cheapest-and-unauthenticated first, then the MAC, and only
 * then anything the payload says. `consume` runs last, so neither a forgery
 * nor an expired or misdirected proof can burn a nonce.
 */
export async function verifyConsentProof(options: VerifyConsentProofOptions): Promise<ConsentProofVerification> {
  try {
    return await verify(options);
  } catch {
    // Every expected failure is handled inside; reaching here means the
    // environment broke (no WebCrypto, a hostile options object). Fail closed.
    return { ok: false, reason: "misconfigured" };
  }
}

async function verify(options: VerifyConsentProofOptions): Promise<ConsentProofVerification> {
  // Read every option once: a getter must not answer one way when checked
  // and another when used.
  const { secret, proof, toolName, argsDigest: digest, audience, consume } = options;
  const now = options.now ?? Date.now();
  const key = secretBytes(secret);
  if (
    key === null || !nonEmpty(toolName) || !nonEmpty(audience) ||
    typeof digest !== "string" || !DIGEST_HEX.test(digest) ||
    typeof consume !== "function" ||
    typeof now !== "number" || !Number.isFinite(now)
  ) {
    return { ok: false, reason: "misconfigured" };
  }

  if (typeof proof !== "string" || proof.length > MAX_PROOF_LENGTH) return { ok: false, reason: "malformed" };
  const parts = proof.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
  const [, payloadPart, macPart] = parts as [string, string, string];
  const mac = fromBase64url(macPart);
  const payloadBytes = fromBase64url(payloadPart);
  if (mac === null || payloadBytes === null) return { ok: false, reason: "malformed" };

  const expected = await hmac(key, `${VERSION}.${payloadPart}`);
  if (!timingSafeEqual(expected, mac)) return { ok: false, reason: "bad_signature" };

  // Authentic from here on, so a malformed payload means a signer bug, not
  // an attacker — but it is still refused rather than trusted.
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "malformed" };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const { v, aud, tool, args, iat, exp, nonce } = payload;
  if (
    v !== 1 || !nonEmpty(aud) || !nonEmpty(tool) || typeof args !== "string" || !nonEmpty(nonce) ||
    typeof iat !== "number" || typeof exp !== "number" ||
    !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) ||
    exp <= iat || exp - iat > CONSENT_PROOF_MAX_TTL_MS
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (aud !== audience) return { ok: false, reason: "wrong_audience" };
  if (tool !== toolName) return { ok: false, reason: "wrong_tool" };
  if (args !== digest) return { ok: false, reason: "wrong_args" };
  if (now > exp + CONSENT_PROOF_CLOCK_SKEW_MS) return { ok: false, reason: "expired" };
  if (iat > now + CONSENT_PROOF_CLOCK_SKEW_MS) return { ok: false, reason: "not_yet_valid" };

  let fresh: unknown;
  try {
    fresh = await consume(nonce, exp + CONSENT_PROOF_CLOCK_SKEW_MS);
  } catch {
    return { ok: false, reason: "consume_failed" };
  }
  if (fresh === false) return { ok: false, reason: "replayed" };
  if (fresh !== true) return { ok: false, reason: "consume_failed" };

  return {
    ok: true,
    proof: { toolName: tool, argsDigest: args, audience: aud, issuedAt: iat, expiresAt: exp, nonce },
  };
}
