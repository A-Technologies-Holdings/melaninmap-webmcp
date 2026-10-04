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
 *    the exact arguments. That endpoint applies whatever rules you have —
 *    which tools may be exchanged at all, session, rate limits, ceilings on
 *    the arguments, server-minted state — and answers with
 *    `signConsentProof(...)`, computing the digest itself.
 * 3. `execute` sends the proof with the arguments. The action endpoint calls
 *    `verifyConsentProof(...)` with the arguments it is about to act on
 *    before doing anything.
 *
 * ## What a valid proof proves
 *
 * That your consent endpoint, holding the secret, issued it recently, for
 * this exact tool, these exact arguments, this audience (and this subject,
 * if you bind one), and that it has not been used before. That closes the
 * direct-writer bypass (the action endpoint no longer accepts a bare
 * "consent: yes" field), binds authorization to one exact operation (a
 * proof for one target cannot be replayed against another), and makes the
 * work rate-limitable at the point where proofs are issued.
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
 * Without a `subject` a proof is a bearer token: whoever holds it may spend
 * it, once. Bind the session or account id as `subject` when the action is
 * per-user.
 *
 * ## Format
 *
 * `v1.<payload>.<mac>`, both parts unpadded base64url. The payload is UTF-8
 * JSON `{ v, aud, tool, args, iat, exp, nonce, sub? }`; the MAC is
 * HMAC-SHA-256 over the ASCII bytes of `webmcp-consent/proof/v1.<payload>`.
 * The context prefix keeps a MAC from ever validating as some other HMAC
 * your application computes — but use a dedicated secret anyway. The payload
 * is signed, not encrypted: it holds a tool name and a digest, never the
 * arguments themselves, but treat it as readable.
 *
 * WebCrypto only — no `node:` imports — so this runs unchanged in Node 22+,
 * browsers and Workers. Never put the secret in a browser bundle; it runs in
 * a browser only so tests and edge runtimes can share it.
 */

import { argsDigest } from "./digest.js";

export { argsDigest };

/** Tolerated clock difference between the server that signs and the one that verifies. */
export const CONSENT_PROOF_CLOCK_SKEW_MS = 5_000;

/** Longest lifetime `signConsentProof` will mint. Proofs are meant to be spent in seconds. */
export const CONSENT_PROOF_MAX_TTL_MS = 10 * 60_000;

/**
 * Longest proof either side accepts. It bounds the work an unauthenticated
 * caller can make `verifyConsentProof` do, and `signConsentProof` enforces it
 * too, so a long audience or tool name fails where it is minted instead of
 * producing a proof that can never verify.
 */
export const CONSENT_PROOF_MAX_LENGTH = 2_048;

/**
 * The shortest secret accepted, in bytes. 32 bytes is the HMAC-SHA-256
 * output size and the usual key-size floor. Length is not entropy: this
 * check rejects a short secret, not a guessable one — generate it randomly.
 */
const MIN_SECRET_BYTES = 32;

/** How many secrets verification will try, so rotation cannot become a work multiplier. */
const MAX_SECRETS = 4;

const VERSION = "v1";
const MAC_CONTEXT = "webmcp-consent/proof/";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;

/**
 * A shared secret: a string (UTF-8) or raw bytes (any typed array or
 * DataView, e.g. a Node Buffer). At least 32 bytes either way. Generate it
 * randomly — `crypto.getRandomValues(new Uint8Array(32))` — dedicate it to
 * consent proofs, and keep it on the server.
 */
export type ConsentProofSecret = string | ArrayBufferView;

/**
 * The operation a proof is bound to. Pass `args` and the digest is computed
 * for you — the safe default, because it cannot come from the client. Pass
 * `argsDigest` only if you already computed it yourself, server-side.
 */
export type ConsentProofOperation = {
  /** The tool whose call this authorizes. */
  toolName: string;
} & (
  | { args: unknown; argsDigest?: never }
  | { argsDigest: string; args?: never }
);

export type SignConsentProofOptions = ConsentProofOperation & {
  secret: ConsentProofSecret;
  /**
   * Who may accept the proof: name the action endpoint and environment, e.g.
   * `"https://api.example.com/handoff"`. A proof minted for staging is then
   * worthless against production.
   */
  audience: string;
  /**
   * Optional: who may spend it — the session or account id. A proof with a
   * subject verifies only for that subject; without one it is a bearer token.
   */
  subject?: string;
  /** Lifetime in ms, at most `CONSENT_PROOF_MAX_TTL_MS`. Seconds, not minutes. */
  ttlMs: number;
  /** Current time in ms since the epoch. Defaults to `Date.now()`. */
  now?: number;
};

export type VerifyConsentProofOptions = ConsentProofOperation & {
  /**
   * The secret, or during a rotation up to four of them, newest first. A
   * proof signed with any of them verifies.
   */
  secret: ConsentProofSecret | readonly ConsentProofSecret[];
  /** The proof as received. Anything — it is untrusted input. */
  proof: unknown;
  audience: string;
  /**
   * The subject this request acts for, if proofs are minted with one. Must
   * match the proof's exactly: a proof with a subject is refused when none
   * is given, and the other way round.
   */
  subject?: string;
  /** Current time in ms since the epoch. Defaults to `Date.now()`. */
  now?: number;
  /**
   * Single use is YOUR storage. Called once, last, only for a proof that
   * passed every other check, as a plain function (pass an arrow, not an
   * unbound method). Record the nonce and return `true`; if the nonce was
   * already recorded, return `false`. Do both atomically — a read-then-write
   * that two requests can interleave accepts a proof twice.
   *
   * Keep the record at least until `expiresAt` (ms since the epoch). That is
   * past the last moment any verifier will accept the proof, with margin for
   * clock skew between verifiers; evict earlier and a replay can slip in.
   *
   * Required, because a proof that can be replayed authorizes as many
   * operations as an attacker cares to send. A throw, a rejection, or any
   * answer but `true` fails closed.
   */
  consume: (nonce: string, expiresAt: number) => Promise<boolean>;
};

/** What a verified proof says. */
export type ConsentProofClaims = {
  toolName: string;
  argsDigest: string;
  audience: string;
  subject?: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

/**
 * Why a proof was refused. For your logs — answer the client with one
 * undifferentiated 403, so the endpoint is not an oracle for which check a
 * forgery got past. (A server-side result, so it is `{ ok, reason }`, not the
 * `{ ok, code, message }` envelope written for a model to read.)
 */
export type ConsentProofFailure =
  /**
   * Not a proof: wrong type, too long, wrong shape, undecodable, or an
   * invalid payload — or the request's own `args` could not be digested.
   */
  | "malformed"
  /** The MAC does not match: tampered, or signed with another secret. */
  | "bad_signature"
  | "wrong_audience"
  | "wrong_tool"
  /** Signed for different arguments. */
  | "wrong_args"
  /** Signed for a different subject, or the subject is missing on one side. */
  | "wrong_subject"
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
  | { ok: true; claims: ConsentProofClaims }
  | { ok: false; reason: ConsentProofFailure };

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (value === undefined) throw new TypeError("WebCrypto (crypto.subtle) is unavailable");
  return value;
}

function isWellFormed(text: string): boolean {
  const native = (text as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof native === "function") return native.call(text);
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

function secretBytes(secret: unknown): Uint8Array<ArrayBuffer> | null {
  // isView rather than instanceof: a Node Buffer or a Uint8Array from another
  // realm is still bytes. Copied, so WebCrypto never sees a caller's buffer
  // change underneath it. A string with a lone surrogate is refused: UTF-8
  // encoding would silently turn it into U+FFFD, and two such secrets would
  // collide.
  const bytes =
    typeof secret === "string" ? (isWellFormed(secret) ? new TextEncoder().encode(secret) : null)
    : ArrayBuffer.isView(secret) ? new Uint8Array(secret.buffer, secret.byteOffset, secret.byteLength).slice()
    : null;
  return bytes !== null && bytes.byteLength >= MIN_SECRET_BYTES ? bytes : null;
}

/** One secret or a short list of them, every one valid — or null. */
function secretList(secret: unknown): Uint8Array<ArrayBuffer>[] | null {
  const candidates = Array.isArray(secret) ? [...secret] : [secret];
  if (candidates.length === 0 || candidates.length > MAX_SECRETS) return null;
  const keys = candidates.map(secretBytes);
  return keys.every((key): key is Uint8Array<ArrayBuffer> => key !== null) ? keys : null;
}

async function hmac(secret: Uint8Array<ArrayBuffer>, signed: string): Promise<Uint8Array> {
  const crypto = subtle();
  const key = await crypto.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.sign("HMAC", key, new TextEncoder().encode(MAC_CONTEXT + signed)));
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
 * Resolve the operation's digest from `args` or `argsDigest` — exactly one
 * of them. Returns null for "neither, both, or not a digest"; rejects (via
 * argsDigest) when `args` cannot be digested.
 */
async function operationDigest(operation: { toolName: unknown; args?: unknown; argsDigest?: unknown; hasArgs: boolean }): Promise<string | null> {
  const { toolName, args, argsDigest: digest, hasArgs } = operation;
  if (!nonEmpty(toolName)) return null;
  if (hasArgs === (digest !== undefined)) return null; // exactly one
  if (!hasArgs) return typeof digest === "string" && DIGEST_HEX.test(digest) ? digest : null;
  return argsDigest(toolName, args);
}

/**
 * Mint a proof. Call this from your consent endpoint after your own checks,
 * never from the page.
 *
 * Rejects with a `TypeError` for invalid options — a short secret, an empty
 * tool name, audience or subject, both or neither of `args` / `argsDigest`,
 * args that cannot be digested, a ttl outside (0, CONSENT_PROOF_MAX_TTL_MS],
 * a clock that overflows, or a result longer than CONSENT_PROOF_MAX_LENGTH —
 * so a misconfiguration fails where it is written instead of minting
 * something unverifiable.
 */
export async function signConsentProof(options: SignConsentProofOptions): Promise<string> {
  const { secret, toolName, audience, subject, ttlMs, now = Date.now() } = options;
  const hasArgs = "args" in options;
  const key = secretBytes(secret);
  if (key === null) throw new TypeError(`signConsentProof: secret must be at least ${MIN_SECRET_BYTES} bytes`);
  if (!nonEmpty(audience)) throw new TypeError("signConsentProof: audience must be a non-empty string");
  if (subject !== undefined && !nonEmpty(subject)) throw new TypeError("signConsentProof: subject must be a non-empty string");
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > CONSENT_PROOF_MAX_TTL_MS) {
    throw new TypeError(`signConsentProof: ttlMs must be an integer in (0, ${CONSENT_PROOF_MAX_TTL_MS}]`);
  }
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ttlMs)) {
    throw new TypeError("signConsentProof: now must be a non-negative integer of ms since the epoch");
  }
  const digest = await operationDigest({ toolName, args: options.args, argsDigest: options.argsDigest, hasArgs });
  if (digest === null) {
    throw new TypeError("signConsentProof: pass a non-empty toolName and exactly one of args or a lowercase SHA-256 hex argsDigest");
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
    ...(subject !== undefined ? { sub: subject } : {}),
  })));
  const signed = `${VERSION}.${payload}`;
  const proof = `${signed}.${base64url(await hmac(key, signed))}`;
  if (proof.length > CONSENT_PROOF_MAX_LENGTH) {
    throw new TypeError(`signConsentProof: the proof would be ${proof.length} characters, over ${CONSENT_PROOF_MAX_LENGTH}; shorten the audience, tool name or subject`);
  }
  return proof;
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
  const { secret, proof, toolName, args, argsDigest: expectedDigest, audience, subject, consume } = options;
  const hasArgs = "args" in options;
  const now = options.now ?? Date.now();
  const keys = secretList(secret);
  if (
    keys === null || !nonEmpty(toolName) || !nonEmpty(audience) ||
    (subject !== undefined && !nonEmpty(subject)) ||
    hasArgs === (expectedDigest !== undefined) ||
    (!hasArgs && (typeof expectedDigest !== "string" || !DIGEST_HEX.test(expectedDigest))) ||
    typeof consume !== "function" ||
    typeof now !== "number" || !Number.isFinite(now)
  ) {
    return { ok: false, reason: "misconfigured" };
  }

  if (typeof proof !== "string" || proof.length > CONSENT_PROOF_MAX_LENGTH) return { ok: false, reason: "malformed" };
  const parts = proof.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
  const [, payloadPart, macPart] = parts as [string, string, string];
  const mac = fromBase64url(macPart);
  const payloadBytes = fromBase64url(payloadPart);
  // An HMAC-SHA-256 tag is always 32 bytes: refuse any other length before
  // paying for one HMAC per key.
  if (mac === null || payloadBytes === null || mac.length !== 32) return { ok: false, reason: "malformed" };

  // Every key is tried, without stopping at the first match, so timing does
  // not say which secret of a rotation signed the proof.
  let authentic = false;
  for (const key of keys) {
    if (timingSafeEqual(await hmac(key, `${VERSION}.${payloadPart}`), mac)) authentic = true;
  }
  if (!authentic) return { ok: false, reason: "bad_signature" };

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
  const { v, aud, tool, args: boundDigest, iat, exp, nonce, sub } = payload;
  if (
    v !== 1 || !nonEmpty(aud) || !nonEmpty(tool) || typeof boundDigest !== "string" || !nonEmpty(nonce) ||
    (sub !== undefined && !nonEmpty(sub)) ||
    typeof iat !== "number" || typeof exp !== "number" ||
    !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) ||
    exp <= iat || exp - iat > CONSENT_PROOF_MAX_TTL_MS
  ) {
    return { ok: false, reason: "malformed" };
  }

  // The request's own args are digested only now: a forgery never costs a
  // canonicalization, and args that cannot be digested are a bad request.
  let digest: string;
  if (hasArgs) {
    try { digest = await argsDigest(toolName, args); }
    catch { return { ok: false, reason: "malformed" }; }
  } else {
    digest = expectedDigest as string;
  }

  if (aud !== audience) return { ok: false, reason: "wrong_audience" };
  if (tool !== toolName) return { ok: false, reason: "wrong_tool" };
  if (boundDigest !== digest) return { ok: false, reason: "wrong_args" };
  if (sub !== subject) return { ok: false, reason: "wrong_subject" };
  if (now > exp + CONSENT_PROOF_CLOCK_SKEW_MS) return { ok: false, reason: "expired" };
  if (iat > now + CONSENT_PROOF_CLOCK_SKEW_MS) return { ok: false, reason: "not_yet_valid" };

  let fresh: unknown;
  try {
    // Twice the skew: this verifier accepts until exp + skew by ITS clock,
    // and another verifier sharing the store may run up to a skew behind.
    fresh = await consume(nonce, exp + 2 * CONSENT_PROOF_CLOCK_SKEW_MS);
  } catch {
    return { ok: false, reason: "consume_failed" };
  }
  if (fresh === false) return { ok: false, reason: "replayed" };
  if (fresh !== true) return { ok: false, reason: "consume_failed" };

  return {
    ok: true,
    claims: {
      toolName: tool,
      argsDigest: boundDigest,
      audience: aud,
      ...(sub !== undefined ? { subject: sub } : {}),
      issuedAt: iat,
      expiresAt: exp,
      nonce,
    },
  };
}
