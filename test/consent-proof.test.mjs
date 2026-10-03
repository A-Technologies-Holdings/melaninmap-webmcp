/**
 * signConsentProof / verifyConsentProof, against the built output.
 *
 * A proof is accepted only when it is authentic, unexpired, for this
 * audience, this tool and these exact arguments, and has never been used.
 * Every other input — tampered, re-targeted, replayed, or not a proof at all —
 * must come back as a refusal, and nothing may throw.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONSENT_PROOF_CLOCK_SKEW_MS,
  CONSENT_PROOF_MAX_LENGTH,
  CONSENT_PROOF_MAX_TTL_MS,
  argsDigest,
  signConsentProof,
  verifyConsentProof,
} from "../dist/server.js";

const secret = "test-secret-that-is-at-least-32-bytes-long!";
const otherSecret = "another-secret-that-is-at-least-32-bytes!!";
const audience = "https://api.example.test/handoff";
const toolName = "hold_tickets";
const T0 = 1_800_000_000_000;
const digest = await argsDigest(toolName, { eventId: "evt_1", quantity: 2 });
const swapped = await argsDigest(toolName, { eventId: "evt_1", quantity: 200 });

/** A fresh in-memory nonce store, the way a host would back `consume`. */
function ledger() {
  const used = new Map();
  const calls = [];
  return {
    calls,
    consume: async (nonce, expiresAt) => {
      calls.push([nonce, expiresAt]);
      if (used.has(nonce)) return false;
      used.set(nonce, expiresAt);
      return true;
    },
  };
}

const sign = (overrides = {}) =>
  signConsentProof({ secret, toolName, argsDigest: digest, audience, ttlMs: 60_000, now: T0, ...overrides });
const verify = (proof, overrides = {}) =>
  verifyConsentProof({ secret, proof, toolName, argsDigest: digest, audience, now: T0 + 1_000, consume: ledger().consume, ...overrides });

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
async function hmac(key, text) {
  const imported = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // The documented MAC input: a fixed context, then "v1.<payload>".
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(`webmcp-consent/proof/${text}`)));
}
/** A correctly MAC'd proof over any payload text: proves payload checks run AFTER the MAC, and still hold. */
async function forgeWithSecret(payloadText) {
  const payload = b64url(typeof payloadText === "string" ? Buffer.from(payloadText, "utf8") : payloadText);
  return `v1.${payload}.${b64url(await hmac(secret, `v1.${payload}`))}`;
}
const decodePayload = (proof) => JSON.parse(Buffer.from(proof.split(".")[1], "base64url").toString("utf8"));

test("a valid proof verifies once and reports what it binds", async () => {
  const proof = await sign();
  const store = ledger();
  const result = await verify(proof, { consume: store.consume });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.claims).sort(), ["argsDigest", "audience", "expiresAt", "issuedAt", "nonce", "toolName"]);
  assert.equal(result.claims.toolName, toolName);
  assert.equal(result.claims.argsDigest, digest);
  assert.equal(result.claims.audience, audience);
  assert.equal(result.claims.issuedAt, T0);
  assert.equal(result.claims.expiresAt, T0 + 60_000);
  // consume sees the nonce, and how long it must remember it at least: past
  // the last moment any verifier, skewed either way, would accept it.
  assert.deepEqual(store.calls, [[result.claims.nonce, T0 + 60_000 + 2 * CONSENT_PROOF_CLOCK_SKEW_MS]]);
});

test("the proof is v1.<payload>.<mac>, carries a digest and never the arguments", async () => {
  const proof = await sign();
  const parts = proof.split(".");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "v1");
  for (const part of parts.slice(1)) assert.match(part, /^[A-Za-z0-9_-]+$/);
  const payload = decodePayload(proof);
  assert.deepEqual(Object.keys(payload).sort(), ["args", "aud", "exp", "iat", "nonce", "tool", "v"]);
  assert.equal(payload.args, digest);
  assert.doesNotMatch(proof, /evt_1/);
});

test("every proof gets a fresh nonce", async () => {
  const nonces = new Set();
  for (let i = 0; i < 20; i += 1) nonces.add(decodePayload(await sign()).nonce);
  assert.equal(nonces.size, 20);
});

test("a replayed proof is refused, and consume decides", async () => {
  const proof = await sign();
  const store = ledger();
  assert.equal((await verify(proof, { consume: store.consume })).ok, true);
  assert.deepEqual(await verify(proof, { consume: store.consume }), { ok: false, reason: "replayed" });
});

test("a tampered payload is refused before it is read", async () => {
  const proof = await sign();
  const [, payload, mac] = proof.split(".");
  const retargeted = b64url(Buffer.from(JSON.stringify({ ...decodePayload(proof), args: swapped })));
  for (const forged of [`v1.${retargeted}.${mac}`, `v1.${payload.slice(0, -2)}${payload.at(-2) === "A" ? "B" : "A"}${payload.at(-1)}.${mac}`]) {
    const store = ledger();
    const result = await verify(forged, { consume: store.consume, argsDigest: swapped });
    assert.ok(result.reason === "bad_signature" || result.reason === "malformed", result.reason);
    assert.equal(result.ok, false);
    assert.deepEqual(store.calls, [], "a forgery never reaches consume");
  }
  // The retargeted payload is well formed, so it must be the MAC that refuses it.
  assert.deepEqual(await verify(`v1.${retargeted}.${mac}`, { argsDigest: swapped }), { ok: false, reason: "bad_signature" });
});

test("a tampered signature is refused", async () => {
  const proof = await sign();
  const [version, payload, mac] = proof.split(".");
  const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
  assert.deepEqual(await verify(`${version}.${payload}.${flipped}`), { ok: false, reason: "bad_signature" });
  // A short MAC is refused whether or not its truncation happens to be valid base64url.
  const truncated = await verify(`${version}.${payload}.${mac.slice(0, -4)}`);
  assert.equal(truncated.ok, false);
  assert.ok(["bad_signature", "malformed"].includes(truncated.reason), truncated.reason);
});

test("a proof signed with another secret is refused", async () => {
  const proof = await sign({ secret: otherSecret });
  assert.deepEqual(await verify(proof), { ok: false, reason: "bad_signature" });
});

test("a proof for another tool, other arguments or another audience is refused", async () => {
  const proof = await sign();
  const store = ledger();
  assert.deepEqual(await verify(proof, { toolName: "cancel_tickets", consume: store.consume }), { ok: false, reason: "wrong_tool" });
  assert.deepEqual(await verify(proof, { argsDigest: swapped, consume: store.consume }), { ok: false, reason: "wrong_args" });
  assert.deepEqual(await verify(proof, { audience: "https://staging.example.test/handoff", consume: store.consume }), { ok: false, reason: "wrong_audience" });
  assert.deepEqual(store.calls, [], "a misdirected proof never burns its nonce");
  assert.equal((await verify(proof, { consume: store.consume })).ok, true, "and still works where it was meant to");
});

test("expiry holds, with a small allowance for clock skew", async () => {
  const proof = await sign({ ttlMs: 10_000 });
  const exp = T0 + 10_000;
  assert.equal((await verify(proof, { now: exp + CONSENT_PROOF_CLOCK_SKEW_MS })).ok, true);
  const store = ledger();
  assert.deepEqual(await verify(proof, { now: exp + CONSENT_PROOF_CLOCK_SKEW_MS + 1, consume: store.consume }), { ok: false, reason: "expired" });
  assert.deepEqual(store.calls, []);
});

test("a proof issued in the future beyond the skew is refused", async () => {
  const proof = await sign({ now: T0 + 60_000 });
  assert.deepEqual(await verify(proof, { now: T0 }), { ok: false, reason: "not_yet_valid" });
  assert.equal((await verify(proof, { now: T0 + 60_000 - CONSENT_PROOF_CLOCK_SKEW_MS })).ok, true);
});

test("consume that throws, rejects or answers anything but a boolean fails closed", async () => {
  const proof = await sign();
  for (const [label, consume] of [
    ["sync throw", () => { throw new Error("db down"); }],
    ["rejection", async () => { throw new Error("db down"); }],
    ["truthy string", async () => "yes"],
    ["undefined", async () => undefined],
    ["1", async () => 1],
    ["sync true (not a promise)", () => true],
  ]) {
    const result = await verify(proof, { consume });
    if (label.startsWith("sync true")) {
      // A synchronous `true` is still `true`; awaiting it is harmless.
      assert.equal(result.ok, true, label);
    } else {
      assert.deepEqual(result, { ok: false, reason: "consume_failed" }, label);
    }
  }
});

test("byte secrets work the same as string secrets", async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const proof = await sign({ secret: bytes });
  assert.equal((await verify(proof, { secret: Buffer.from(bytes) })).ok, true);
  assert.equal((await verify(proof, { secret: new DataView(bytes.buffer) })).ok, true);
  assert.deepEqual(await verify(proof), { ok: false, reason: "bad_signature" });
});

test("malformed proofs of every shape are refused, never thrown on", async () => {
  const proof = await sign();
  const [, payload, mac] = proof.split(".");
  const cases = [
    undefined, null, 42, true, {}, [], ["v1", payload, mac], { toString: () => proof },
    "", "v1", "v1.", "v1..", `v1.${payload}`, `v1.${payload}.`, `.${payload}.${mac}`,
    `v2.${payload}.${mac}`, `V1.${payload}.${mac}`, `v1.${payload}.${mac}.extra`,
    `v1.${payload}.${mac}=`, `v1.${payload}=.${mac}`, `v1.${payload.replace(/./, "+")}.${mac}`,
    `v1.@@@@.${mac}`, `v1.${payload}.${mac.slice(0, -1)}`.padEnd(proof.length, "x"),
    `v1.${payload}.A`, // length % 4 === 1 is never valid base64
    `v1.${"A".repeat(5000)}.${mac}`, // over the length cap
    ` ${proof}`, `${proof}\n`,
  ];
  for (const [index, candidate] of cases.entries()) {
    const store = ledger();
    const result = await verify(candidate, { consume: store.consume });
    assert.equal(result.ok, false, `case ${index}`);
    assert.ok(["malformed", "bad_signature"].includes(result.reason), `case ${index}: ${result.reason}`);
    assert.deepEqual(store.calls, [], `case ${index} reached consume`);
  }
});

test("a non-canonical base64url spelling of a valid MAC is refused", async () => {
  // The MAC is 32 bytes = 43 base64url characters, so the last character
  // carries 2 unused bits. Setting them gives a different string for the
  // same bytes; only the canonical one may verify.
  const proof = await sign();
  const [version, payload, mac] = proof.split(".");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(mac.at(-1));
  const variant = `${version}.${payload}.${mac.slice(0, -1)}${alphabet[last | 1]}`;
  if (variant !== proof) assert.deepEqual(await verify(variant), { ok: false, reason: "malformed" });
});

test("an authentic but invalid payload is still refused", async () => {
  const valid = decodePayload(await sign());
  for (const [label, text] of [
    ["not JSON", "not json"],
    ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ["an array", "[]"],
    ["null", "null"],
    ["the wrong version", JSON.stringify({ ...valid, v: 2 })],
    ["a missing nonce", JSON.stringify({ ...valid, nonce: undefined })],
    ["a string expiry", JSON.stringify({ ...valid, exp: String(valid.exp) })],
    ["expiry before issue", JSON.stringify({ ...valid, exp: valid.iat })],
    ["a lifetime past the maximum", JSON.stringify({ ...valid, exp: valid.iat + CONSENT_PROOF_MAX_TTL_MS + 1 })],
    ["a fractional time", JSON.stringify({ ...valid, iat: valid.iat + 0.5 })],
  ]) {
    const store = ledger();
    const result = await verify(await forgeWithSecret(text), { consume: store.consume });
    assert.deepEqual(result, { ok: false, reason: "malformed" }, label);
    assert.deepEqual(store.calls, [], label);
  }
});

test("a misconfigured verifier refuses everything instead of throwing", async () => {
  const proof = await sign();
  for (const [label, overrides] of [
    ["a short secret", { secret: "short" }],
    ["no secret", { secret: undefined }],
    ["a numeric secret", { secret: 12345678901234567890123456789012345 }],
    ["no consume", { consume: undefined }],
    ["an empty tool name", { toolName: "" }],
    ["an empty audience", { audience: "" }],
    ["a digest that is not a digest", { argsDigest: "abc" }],
    ["an uppercase digest", { argsDigest: digest.toUpperCase() }],
    ["a non-numeric clock", { now: "now" }],
  ]) {
    assert.deepEqual(await verify(proof, overrides), { ok: false, reason: "misconfigured" }, label);
  }
  assert.deepEqual(await verifyConsentProof(null), { ok: false, reason: "misconfigured" });
  assert.deepEqual(await verifyConsentProof(undefined), { ok: false, reason: "misconfigured" });
  const hostile = new Proxy({}, { get() { throw new Error("trap"); } });
  assert.deepEqual(await verifyConsentProof(hostile), { ok: false, reason: "misconfigured" });
});

test("signing refuses options that would mint something unverifiable", async () => {
  for (const [label, overrides] of [
    ["a short secret", { secret: "short" }],
    ["an empty tool name", { toolName: "" }],
    ["an empty audience", { audience: "" }],
    ["a bad digest", { argsDigest: "nope" }],
    ["a zero ttl", { ttlMs: 0 }],
    ["a negative ttl", { ttlMs: -1 }],
    ["a fractional ttl", { ttlMs: 1.5 }],
    ["a ttl past the maximum", { ttlMs: CONSENT_PROOF_MAX_TTL_MS + 1 }],
    ["a non-numeric clock", { now: "now" }],
  ]) {
    await assert.rejects(sign(overrides), TypeError, label);
  }
});

// Workers and browsers have no `node:` modules. The server entry must reach
// nothing but its own relative imports.
test("the server entry imports nothing outside the package", () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
    const specifiers = [
      ...source.matchAll(/^(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^import\s*["']([^"']+)["']/gm),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith("./"), `${file} imports ${specifier}`);
      visit(specifier.slice(2));
    }
  };
  visit("server.js");
  assert.deepEqual([...seen].sort(), ["digest.js", "server.js"]);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./server"].import, "./dist/server.js");
  assert.equal(pkg.exports["./server"].types, "./dist/server.d.ts");
});

// --- binding by args, subject, rotation, length --------------------------

const callArgs = { eventId: "evt_1", quantity: 2 };

test("args can be passed instead of a digest, on both sides", async () => {
  const proof = await sign({ argsDigest: undefined, args: callArgs });
  assert.equal(decodePayload(proof).args, digest, "the same digest either way");
  assert.equal((await verify(proof, { argsDigest: undefined, args: { quantity: 2, eventId: "evt_1" } })).ok, true);
  assert.deepEqual(await verify(proof, { argsDigest: undefined, args: { ...callArgs, quantity: 200 } }), { ok: false, reason: "wrong_args" });
});

test("a request whose args cannot be digested is malformed, not a crash", async () => {
  const proof = await sign();
  let deep = {};
  for (let i = 0; i < 100; i += 1) deep = { deep };
  for (const [label, args] of [["missing", undefined], ["a Date", { d: new Date(0) }], ["absurd nesting", deep]]) {
    const store = ledger();
    assert.deepEqual(await verify(proof, { argsDigest: undefined, args, consume: store.consume }), { ok: false, reason: "malformed" }, label);
    assert.deepEqual(store.calls, [], label);
  }
});

test("exactly one of args or argsDigest", async () => {
  const proof = await sign();
  assert.deepEqual(await verify(proof, { args: callArgs }), { ok: false, reason: "misconfigured" }, "both");
  assert.deepEqual(await verify(proof, { argsDigest: undefined }), { ok: false, reason: "misconfigured" }, "neither");
  await assert.rejects(sign({ args: callArgs }), TypeError);
  await assert.rejects(sign({ argsDigest: undefined }), TypeError);
  await assert.rejects(sign({ argsDigest: undefined, args: { d: new Date(0) } }), TypeError);
});

test("a subject binds the proof to one session, in both directions", async () => {
  const proof = await sign({ subject: "session-a" });
  assert.equal(decodePayload(proof).sub, "session-a");
  const store = ledger();
  assert.deepEqual(await verify(proof, { subject: "session-b", consume: store.consume }), { ok: false, reason: "wrong_subject" });
  assert.deepEqual(await verify(proof, { consume: store.consume }), { ok: false, reason: "wrong_subject" }, "a subject proof is not a bearer token");
  assert.deepEqual(store.calls, []);
  const ok = await verify(proof, { subject: "session-a", consume: store.consume });
  assert.equal(ok.ok, true);
  assert.equal(ok.claims.subject, "session-a");
  assert.deepEqual(await verify(await sign(), { subject: "session-a" }), { ok: false, reason: "wrong_subject" }, "nor the other way round");
  await assert.rejects(sign({ subject: "" }), TypeError);
});

test("rotation: verification accepts any of a short list of secrets", async () => {
  const old = await sign({ secret: otherSecret });
  const current = await sign();
  assert.equal((await verify(old, { secret: [secret, otherSecret] })).ok, true);
  assert.equal((await verify(current, { secret: [secret, otherSecret] })).ok, true);
  assert.deepEqual(await verify(old, { secret: [secret] }), { ok: false, reason: "bad_signature" });
  assert.deepEqual(await verify(current, { secret: [] }), { ok: false, reason: "misconfigured" });
  assert.deepEqual(await verify(current, { secret: [secret, "short"] }), { ok: false, reason: "misconfigured" });
  assert.deepEqual(await verify(current, { secret: Array(5).fill(secret) }), { ok: false, reason: "misconfigured" });
});

test("signing refuses what verification would refuse as too long", async () => {
  await assert.rejects(sign({ audience: "https://example.test/" + "a".repeat(1400) }), /over 2048/);
  await assert.rejects(sign({ toolName: "名".repeat(450), argsDigest: await argsDigest("名".repeat(450), {}) }), /over 2048/);
  const longest = await sign({ audience: "https://example.test/" + "a".repeat(1000) });
  assert.ok(longest.length <= CONSENT_PROOF_MAX_LENGTH);
  assert.equal((await verify(longest, { audience: "https://example.test/" + "a".repeat(1000) })).ok, true);
});

test("a clock that would overflow cannot sign", async () => {
  await assert.rejects(sign({ now: Number.MAX_SAFE_INTEGER - 10 }), TypeError);
});

test("an audience or tool name containing dots or unicode round-trips", async () => {
  const odd = { audience: "https://a.b.c/ü.v1.x", toolName: "tool.with.dots", argsDigest: await argsDigest("tool.with.dots", {}) };
  assert.equal((await verify(await sign(odd), odd)).ok, true);
});

test("a string secret with a lone surrogate is refused", async () => {
  const broken = "\uD800" + "x".repeat(40);
  await assert.rejects(sign({ secret: broken }), TypeError);
  assert.deepEqual(await verify(await sign(), { secret: broken }), { ok: false, reason: "misconfigured" });
});
