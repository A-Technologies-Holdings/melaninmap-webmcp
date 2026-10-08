// resultFormat: "json" resolves the plain JSON value for spec WebMCP hosts,
// which serialize whatever execute returns; the default keeps the MCP envelope.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineConsequentialTool, defineReadTool, toJsonResult } from "../dist/index.js";

const read = (overrides = {}) => defineReadTool({
  name: "read_json",
  description: "d",
  inputSchema: { type: "object" },
  parseArgs: (raw) => raw,
  execute: async () => ({ ok: true, count: 1 }),
  ...overrides,
});
const prompt = { title: "t", detail: "d", confirmLabel: "Go", timeoutMs: 20 };
const act = (decision, overrides = {}) => defineConsequentialTool({
  name: "act_json",
  description: "d",
  inputSchema: { type: "object" },
  parseArgs: () => ({}),
  consent: async () => ({ decision }),
  describeConsent: () => prompt,
  execute: async () => ({ ok: true, held: 2 }),
  ...overrides,
});

test("the default stays the MCP content envelope", async () => {
  assert.deepEqual(await read().execute({}), { content: [{ type: "text", text: '{"ok":true,"count":1}' }] });
});
test("json resolves the result value itself", async () => {
  assert.deepEqual(await read({ resultFormat: "json" }).execute({}), { ok: true, count: 1 });
});
test("json carries refusals as objects, so a model reads the code directly", async () => {
  const result = await act("declined", { resultFormat: "json" }).execute({});
  assert.equal(result.ok, false);
  assert.equal(result.code, "consent_declined");
  assert.deepEqual(await act("confirmed", { resultFormat: "json" }).execute({}), { ok: true, held: 2 });
});
test("json keeps the null fallback for values that do not serialize", async () => {
  assert.equal(await read({ resultFormat: "json", execute: async () => undefined }).execute({}), null);
  assert.equal(await read({ resultFormat: "json", execute: async () => 1n }).execute({}), null);
  const circular = {}; circular.self = circular;
  assert.equal(toJsonResult(circular), null);
});
test("json maps invalid arguments and handler errors the same way", async () => {
  const bad = await read({ resultFormat: "json", parseArgs: () => null }).execute({});
  assert.equal(bad.code, "invalid_arguments");
  const failed = await read({ resultFormat: "json", execute: async () => { throw new Error("down"); } }).execute({});
  assert.equal(failed.ok, false);
});
test("an unknown format from plain JavaScript keeps the envelope", async () => {
  assert.ok(Array.isArray((await read({ resultFormat: "JSON" }).execute({})).content));
});
