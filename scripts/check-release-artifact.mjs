#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import ts from "@typescript/typescript6";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "webmcp artifact smoke with spaces "));
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });
try {
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], { cwd: root });
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename, files }] = JSON.parse(packed.stdout);
  for (const required of ["examples/consent-surface.css", "examples/consent-surface.css.d.ts", "dist/domConsentSurface.js", "dist/domConsentSurface.d.ts", "dist/openapi.js", "dist/openapi.d.ts", "dist/referenceSources.json", "dist/index.js", "dist/index.d.ts", "dist/react.js", "dist/server.js", "compatibility/webmcp.json", "compatibility/webmcp.schema.json"]) {
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

  // Exercise the documented consumer import and files copied outside the package.
  const readme = await readFile(path.join(packageDir, "README.md"), "utf8");
  const stylesheetImport = "@melaninmap/webmcp-consent/consent-surface.css";
  const documentedStylesheet = readme.match(/import "([^"]+\.css)";/)?.[1];
  const documentedImport = readme.match(/import \{ domConsentSurface \} from "([^"]+)";/)?.[1];
  assert(documentedImport, "README must demonstrate the DOM surface import");
  await writeFile(path.join(scratch, "copied-example.mjs"),
    await readFile(path.join(packageDir, "examples/domConsentSurface.ts"), "utf8"));
  const customizableSource = (await readFile(path.join(packageDir, "src/domConsentSurface.ts"), "utf8"))
    .replaceAll('from "./index.js"', 'from "@melaninmap/webmcp-consent"');
  const customized = ts.transpileModule(customizableSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  await writeFile(path.join(scratch, "customized-surface.mjs"), customized.outputText);
  const consumer = path.join(scratch, "consumer.mjs");
  await writeFile(consumer, [
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'import * as root from "@melaninmap/webmcp-consent";',
    'import { domConsentSurface } from "@melaninmap/webmcp-consent/dom-consent-surface";',
    'import openapi from "@melaninmap/webmcp-consent/schemas/openapi";',
    'import reference from "@melaninmap/webmcp-consent/reference/source" with { type: "json" };',
    'assert.equal(typeof domConsentSurface, "function");',
    `const stylesheet = readFileSync(new URL(import.meta.resolve(${JSON.stringify(stylesheetImport)})), "utf8");`,
    'assert.match(stylesheet, /\\.mm-consent/);',
    `import { domConsentSurface as documentedSurface } from ${JSON.stringify(documentedImport)};`,
    'import { domConsentSurface as copiedSurface } from "./copied-example.mjs";',
    'import { domConsentSurface as customizedSurface } from "./customized-surface.mjs";',
    'assert.equal(documentedSurface, domConsentSurface);',
    'assert.equal(copiedSurface, domConsentSurface);',
    'assert.equal(typeof customizedSurface, "function");',
    'assert.deepEqual(await customizedSurface(null), { decision: "closed" });',
    'assert.match(openapi, /openapi:/);',
    'assert.equal(typeof reference["consentBridge.ts"], "string");',
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
  assert.equal(documentedStylesheet, stylesheetImport, "README must document the supported CSS export");
  assert.deepEqual(packedPackage.sideEffects, ["./examples/consent-surface.css"], "preserve the stylesheet without marking JS as side-effectful");
  console.log(`packed ${sourcePackage.version} artifact imports in an isolated consumer; documented import, stylesheet, copied example and customizable source resolve; optional React stays optional`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
