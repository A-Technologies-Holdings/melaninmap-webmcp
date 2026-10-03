/**
 * The `busy` decision, against the built output.
 *
 * `busy` must reach the model as its own refusal — not as `closed` — so an
 * agent can tell "never shown" from "dismissed".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { consentRefusal, defineConsequentialTool } from "../dist/index.js";

const json = (result) => JSON.parse(result.content[0].text);
const prompt = { title: "t", detail: "d", confirmLabel: "Go", timeoutMs: 20 };

function tool(overrides) {
  return defineConsequentialTool({
    name: "observed",
    description: "d",
    inputSchema: { type: "object" },
    parseArgs: (raw) => (raw.bad ? null : raw),
    consent: async () => ({ decision: "confirmed" }),
    describeConsent: () => prompt,
    execute: async () => ({ ok: true }),
    ...overrides,
  });
}

test("busy is its own refusal, distinct from closed, and permits one later retry", () => {
  const busy = consentRefusal("busy");
  const closed = consentRefusal("closed");
  assert.equal(busy.ok, false);
  assert.equal(busy.code, "consent_busy");
  assert.notEqual(busy.message, closed.message);
  assert.match(busy.message, /already open/i);
  assert.match(busy.message, /retry this action once/i);
  assert.match(busy.message, /not retry in a loop/i);
});

test("an unknown decision never leaks into the refusal code", () => {
  assert.deepEqual(consentRefusal("yes"), consentRefusal("closed"));
  assert.deepEqual(consentRefusal("toString"), consentRefusal("closed"));
});

test("a surface answering busy refuses with consent_busy and never runs the action", async () => {
  let ran = false;
  const result = json(await tool({
    consent: async () => ({ decision: "busy" }),
    execute: async () => { ran = true; },
  }).execute({}));
  assert.deepEqual(result, consentRefusal("busy"));
  assert.equal(ran, false);
});
