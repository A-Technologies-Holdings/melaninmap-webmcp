/**
 * Partial-registration behavior, in its own process.
 *
 * Registration state is module-level and there is deliberately no
 * `unregister()` — aborting a scoped registration is the only way to release
 * it. That makes two "permanently marks registered" cases impossible to run in
 * one process, so this one gets a fresh module instance rather than the main
 * smoke file contorting itself around the ordering.
 *
 * What it protects: registration is not atomic and WebMCP offers no rollback.
 * If a later tool fails after earlier ones landed, the flags must STAY set —
 * otherwise a retry re-registers the live tools, duplicating executions and
 * consent prompts, or failing outright on a host that enforces unique names.
 */

import assert from "node:assert/strict";
import { registerAgentTools } from "../dist/index.js";

const tool = {
  name: "t",
  description: "d",
  inputSchema: { type: "object" },
  annotations: {},
  execute: async () => ({ content: [{ type: "text", text: "null" }] }),
};

let calls = 0;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: {
    modelContext: {
      registerTool() {
        calls += 1;
        if (calls > 1) throw new Error("host rejected the second tool");
      },
    },
  },
});

const partial = registerAgentTools([tool, tool]);
assert.deepEqual(partial, {
  registered: false,
  reason: "partial_registration",
  toolCount: 1,
});
console.log("ok   a partial registration reports the exact partial state");

// Three calls, not two: tool 1 lands, tool 2 throws on the optioned call, and
// the compatibility fallback retries it bare before giving up. That is the
// mid-loop failure this case exists to cover — one tool live, one not.
assert.equal(calls, 3, "tool 1 landed, tool 2 failed on both the optioned and bare calls");
console.log("ok   the failure happened mid-loop, after one tool landed");

assert.deepEqual(registerAgentTools([tool]), {
  registered: false,
  reason: "already_registered",
});
console.log("ok   a partial registration still blocks an unsafe retry");

console.log("\nAll 3 partial-registration assertions passed against dist/.");
