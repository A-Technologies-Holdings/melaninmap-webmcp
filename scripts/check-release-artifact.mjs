#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "webmcp artifact smoke with spaces "));
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });
try {
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], { cwd: root });
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename, files }] = JSON.parse(packed.stdout);
  for (const required of ["dist/index.js", "dist/index.d.ts", "dist/react.js", "dist/server.js", "compatibility/webmcp.json", "compatibility/webmcp.schema.json"]) {
    assert(files.some(file => file.path === required), `release artifact is missing ${required}`);
  }
  const packageDir = path.join(scratch, "node_modules/@melaninmap/webmcp-consent");
  await mkdir(packageDir, { recursive: true });
  const extracted = run("tar", ["-xzf", path.join(scratch, filename), "-C", packageDir, "--strip-components=1"]);
  assert.equal(extracted.status, 0, extracted.stderr);
  const packedPackage = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const sourcePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packedPackage.version, sourcePackage.version, "installed and source package versions differ");
  assert(!packedPackage.dependencies || Object.keys(packedPackage.dependencies).length === 0, "runtime dependencies leaked into the artifact");

  const consumer = path.join(scratch, "consumer.mjs");
  await writeFile(consumer, [
    'import assert from "node:assert/strict";',
    'import * as root from "@melaninmap/webmcp-consent";',
    'import * as server from "@melaninmap/webmcp-consent/server";',
    'import evidence from "@melaninmap/webmcp-consent/compatibility" with { type: "json" };',
    'assert.equal(typeof root.defineConsequentialTool, "function");',
    'assert.equal(typeof root.registerAgentToolsAsync, "function");',
    'assert.equal(typeof server.verifyConsentProof, "function");',
    'assert.equal(typeof evidence.libraryVersion, "string");',
    'await assert.rejects(import("@melaninmap/webmcp-consent/react"), error => error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("react"));',
  ].join("\n"));
  const smoke = run(process.execPath, [consumer], { cwd: scratch });
  assert.equal(smoke.status, 0, smoke.stderr);
  console.log(`packed ${sourcePackage.version} artifact imports in an isolated consumer; optional React stays optional`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
