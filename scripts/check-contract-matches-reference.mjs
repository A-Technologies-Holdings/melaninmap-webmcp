/**
 * The published contract must match the deployed registrar.
 *
 * A published tool contract that disagrees with the running tools is worse
 * than publishing nothing: an agent author generates a client from it, every
 * call fails argument validation, and the failure looks like our bug from the
 * outside. This drifted once already (`request_event_handoff` published
 * `targetId` while the registrar reads `targetExternalId` and also requires
 * `channel`), so it is checked mechanically rather than by eye.
 *
 * Run: npm run check:contract
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(root, "schemas/melaninmap.tools.json"), "utf8"),
);
const source = readFileSync(
  join(root, "reference/registerAgentTools.ts"),
  "utf8",
);

let failures = 0;

for (const tool of contract.tools) {
  const at = source.indexOf(`"${tool.name}"`);
  if (at === -1) {
    console.error(`FAIL ${tool.name}: not registered in reference/registerAgentTools.ts`);
    failures += 1;
    continue;
  }
  const block = source.slice(at, at + 2600);
  const body = /inputSchema:\s*\{(.*?)\n {2}\},\n/s.exec(block)?.[1] ?? "";
  const deployedProps = [...new Set([...body.matchAll(/\n {6}(\w+): \{/g)].map((m) => m[1]))].sort();
  const requiredRaw = /required: \[([^\]]*)\]/.exec(body)?.[1] ?? "";
  const deployedRequired = requiredRaw
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .sort();

  const publishedProps = Object.keys(tool.inputSchema.properties ?? {}).sort();
  const publishedRequired = [...(tool.inputSchema.required ?? [])].sort();

  const same =
    JSON.stringify(deployedProps) === JSON.stringify(publishedProps) &&
    JSON.stringify(deployedRequired) === JSON.stringify(publishedRequired);

  if (same) {
    console.log(`ok   ${tool.name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${tool.name}`);
    console.error(`  published properties: ${publishedProps.join(", ")}`);
    console.error(`  deployed  properties: ${deployedProps.join(", ")}`);
    console.error(`  published required:   ${publishedRequired.join(", ")}`);
    console.error(`  deployed  required:   ${deployedRequired.join(", ")}`);
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} tool(s) drifted. Update schemas/melaninmap.tools.json to match reference/registerAgentTools.ts.`,
  );
  process.exit(1);
}
console.log(`\nAll ${contract.tools.length} published tools match the registrar.`);
