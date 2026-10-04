/**
 * argsDigest: the canonical binding between a proof and one exact call.
 *
 * The digest is only useful if two sides that see the same arguments always
 * agree on it, and two sides that see different arguments never do. So these
 * tests pin the canonical form against an independent hash of the expected
 * bytes, and check that every value the two sides could coerce differently is
 * refused instead.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { argsDigest } from "../dist/index.js";
import { argsDigest as serverArgsDigest } from "../dist/server.js";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

test("hashes the documented canonical preimage", async () => {
  const args = { b: [true, null, "x", 1.5, -0], a: { z: 1, y: "é\n\"" } };
  const expected = sha256('["webmcp-consent/args/v1","hold_tickets",{"a":{"y":"é\\n\\"","z":1},"b":[true,null,"x",1.5,0]}]');
  assert.equal(await argsDigest("hold_tickets", args), expected);
});

test("key order does not matter; values, nesting and array order do", async () => {
  const base = await argsDigest("t", { a: 1, b: { c: [1, 2] } });
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(await argsDigest("t", { b: { c: [1, 2] }, a: 1 }), base);
  for (const other of [
    { a: 2, b: { c: [1, 2] } },
    { a: 1, b: { c: [2, 1] } },
    { a: 1, b: { c: [1, 2], d: null } },
    { a: "1", b: { c: [1, 2] } },
    { a: 1 },
  ]) {
    assert.notEqual(await argsDigest("t", other), base, JSON.stringify(other));
  }
  assert.notEqual(await argsDigest("u", { a: 1, b: { c: [1, 2] } }), base, "the tool name is bound too");
});

test("keys sort by UTF-16 code units, like JavaScript's default sort", async () => {
  // Code units, not code points: "😀" is the pair 0xD83D 0xDE00, so it sorts
  // BEFORE "ｚ" (0xFF5A) even though its code point (U+1F600) is larger.
  const args = { z: 1, é: 2, "ｚ": 3, "😀": 4, A: 5 };
  assert.equal(await argsDigest("t", args), sha256('["webmcp-consent/args/v1","t",{"A":5,"z":1,"é":2,"😀":4,"ｚ":3}]'));
});

test("the same object twice is repetition, not a cycle", async () => {
  const shared = { id: 1 };
  assert.equal(
    await argsDigest("t", { a: shared, b: [shared, shared] }),
    await argsDigest("t", { a: { id: 1 }, b: [{ id: 1 }, { id: 1 }] }),
  );
});

test("null-prototype objects are plain objects", async () => {
  const bare = Object.assign(Object.create(null), { a: 1 });
  assert.equal(await argsDigest("t", bare), await argsDigest("t", { a: 1 }));
});

test("the server entry exports the same function", () => {
  assert.equal(serverArgsDigest, argsDigest);
});

const cycle = {};
cycle.self = cycle;
class Point { constructor() { this.x = 1; } }
let deep = {};
for (let i = 0; i < 100; i += 1) deep = { deep };

for (const [label, args] of [
  ["undefined", undefined],
  ["an undefined property", { a: undefined }],
  ["a function", { f() {} }],
  ["a symbol", { s: Symbol("s") }],
  ["a bigint", { n: 1n }],
  ["NaN", { n: NaN }],
  ["Infinity", { n: Infinity }],
  ["a Date", { d: new Date(0) }],
  ["a Map", { m: new Map() }],
  ["a class instance", { p: new Point() }],
  ["a boxed string", { s: new String("x") }],
  ["a sparse array", { a: [1, , 3] }], // eslint-disable-line no-sparse-arrays
  ["a cycle", cycle],
  ["a lone surrogate in a value", { s: "\uD800" }],
  ["a lone surrogate in a key", { ["\uDC00"]: 1 }],
  ["absurd nesting", deep],
]) {
  test(`rejects ${label} instead of coercing it`, async () => {
    await assert.rejects(argsDigest("t", args), TypeError);
  });
}

test("rejects a missing or empty tool name", async () => {
  await assert.rejects(argsDigest("", {}), TypeError);
  await assert.rejects(argsDigest(undefined, {}), TypeError);
  await assert.rejects(argsDigest(7, {}), TypeError);
});

test("a rejection names the offending path", async () => {
  await assert.rejects(argsDigest("t", { a: [{ b: NaN }] }), /args\.a\[0\]\.b/);
});

// RFC 8785 serializes numbers exactly as ECMAScript does. A few of its
// boundary cases, pinned so a refactor cannot drift from JCS.
test("numbers serialize as RFC 8785 / ECMAScript does", async () => {
  const cases = [
    [1e21, "1e+21"], [1e20, "100000000000000000000"], [0.000001, "0.000001"], [1e-7, "1e-7"],
    [-0, "0"], [5e-324, "5e-324"], [1.7976931348623157e308, "1.7976931348623157e+308"],
    [9007199254740993, "9007199254740992"], [0.1 + 0.2, "0.30000000000000004"], [-1.5, "-1.5"],
  ];
  for (const [value, text] of cases) {
    assert.equal(await argsDigest("t", { n: value }), sha256(`["webmcp-consent/args/v1","t",{"n":${text}}]`), text);
  }
});

test("a __proto__ key is data, digested like any other key", async () => {
  const args = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
  assert.equal(await argsDigest("t", args), sha256('["webmcp-consent/args/v1","t",{"__proto__":{"polluted":true},"a":1}]'));
  assert.equal({}.polluted, undefined);
});
