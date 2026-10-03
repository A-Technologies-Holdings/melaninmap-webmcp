/**
 * A canonical digest of one tool call: which tool, with exactly which
 * arguments.
 *
 * A consent proof is only as narrow as what it is bound to. Bind it to the
 * tool name alone and a proof minted for "hold 2 tickets" also authorizes
 * "hold 200". So the proof binds to this digest, and the server recomputes
 * the digest from the request it is about to act on. Different arguments,
 * different digest, no action.
 *
 * Both sides must produce byte-identical input for the hash, which plain
 * `JSON.stringify` does not guarantee: key order follows insertion order, and
 * values like `undefined`, `NaN` or a `Date` serialise lossily or not at all.
 * So the input is canonical JSON:
 *
 * - object keys sorted by UTF-16 code units (JavaScript's default sort);
 * - no whitespace; strings and numbers exactly as `JSON.stringify` writes them;
 * - only JSON values: plain objects, arrays, strings, finite numbers,
 *   booleans and null. Values that have no JSON form — `undefined`
 *   (including as a property value), functions, symbols, bigints,
 *   `NaN`/`Infinity`, `Date`, `Map`, class instances, sparse arrays, cycles,
 *   strings with lone surrogates — are rejected, because a value two sides
 *   would coerce differently is a binding that quietly does not bind.
 *
 * What it does NOT do, so you are not surprised: like `JSON.stringify` it
 * reads only own enumerable string keys (symbol and non-enumerable keys are
 * ignored), calls getters, never calls `toJSON`, and writes `-0` as `0`.
 * "Plain" is judged by prototype, so a plain object from another realm (an
 * iframe) is rejected, and a Proxy is judged by what its traps report.
 * Numbers must fit in a double: an integer past 2^53 is already rounded
 * before it gets here, on both sides, and differently by different parsers —
 * send large ids as strings.
 *
 * That is intended to be RFC 8785 (JCS) output for every value accepted, so
 * a server in another language can reproduce it with a JCS library. The
 * hashed preimage is the canonical JSON of the three-element array
 * `["webmcp-consent/args/v1", toolName, args]`; the digest is its SHA-256 as
 * lowercase hex. The version tag keeps a digest from ever colliding with one
 * computed for some other purpose.
 *
 * Uses `globalThis.crypto.subtle`, which exists in Node 22, every current
 * browser in a secure context (HTTPS or localhost), and Workers.
 */

/** Deeper than any real tool argument; bounds recursion on hostile input. */
const MAX_DEPTH = 64;

const DIGEST_DOMAIN = "webmcp-consent/args/v1";

function isWellFormed(text: string): boolean {
  // String.prototype.isWellFormed is ES2024; fall back to a lone-surrogate scan.
  const native = (text as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof native === "function") return native.call(text);
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

function canonical(value: unknown, path: string, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) throw new TypeError(`argsDigest: ${path} is nested too deeply`);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`argsDigest: ${path} is not a finite number`);
      return JSON.stringify(value);
    case "string":
      if (!isWellFormed(value)) throw new TypeError(`argsDigest: ${path} contains a lone surrogate`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`argsDigest: ${path} is a ${typeof value}, not a JSON value`);
  }
  const object = value as object;
  if (seen.has(object)) throw new TypeError(`argsDigest: ${path} is a cycle`);
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items: string[] = [];
      for (let index = 0; index < object.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(object, index)) {
          throw new TypeError(`argsDigest: ${path}[${index}] is a hole in a sparse array`);
        }
        items.push(canonical((object as unknown[])[index], `${path}[${index}]`, depth + 1, seen));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`argsDigest: ${path} is not a plain object`);
    }
    const keys = Object.keys(object).sort();
    const members: string[] = [];
    for (const key of keys) {
      if (!isWellFormed(key)) throw new TypeError(`argsDigest: a key in ${path} contains a lone surrogate`);
      const child = `${path}.${key}`;
      const entry = (object as Record<string, unknown>)[key];
      if (entry === undefined) throw new TypeError(`argsDigest: ${child} is undefined`);
      members.push(`${JSON.stringify(key)}:${canonical(entry, child, depth + 1, seen)}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    // A cycle is an object reached again while still inside itself; the same
    // object appearing twice side by side is just repetition, and fine.
    seen.delete(object);
  }
}

function hex(bytes: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(bytes)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * SHA-256 (lowercase hex) of the canonical JSON of
 * `["webmcp-consent/args/v1", toolName, args]`.
 *
 * Rejects with a `TypeError` naming the offending path when `args` holds
 * anything that is not a JSON value, or when `toolName` is not a non-empty
 * string, and with a `TypeError` if WebCrypto is unavailable (an insecure
 * context).
 */
export async function argsDigest(toolName: string, args: unknown): Promise<string> {
  return digestCanonical(toolName, canonicalArgs(args));
}

/**
 * The canonical JSON text of `args`, synchronously. Throws a `TypeError`
 * naming the offending path. Internal: the gate uses it to snapshot
 * arguments before it prompts anyone.
 */
export function canonicalArgs(args: unknown): string {
  return canonical(args, "args", 1, new Set());
}

/** SHA-256 hex of the preimage for already-canonical args text. Internal. */
export async function digestCanonical(toolName: string, canonicalArgsText: string): Promise<string> {
  if (typeof toolName !== "string" || toolName.length === 0) {
    throw new TypeError("argsDigest: toolName must be a non-empty string");
  }
  // The same bytes as canonical([DIGEST_DOMAIN, toolName, args]); built by
  // hand so a rejection names `args.path`, not `$[2].path`.
  const preimage = `[${JSON.stringify(DIGEST_DOMAIN)},${canonical(toolName, "toolName", 0, new Set())},${canonicalArgsText}]`;
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new TypeError("argsDigest: WebCrypto (crypto.subtle) is unavailable");
  return hex(await subtle.digest("SHA-256", new TextEncoder().encode(preimage)));
}
