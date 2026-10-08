/**
 * The published contract must match the deployed registrar — COMPLETELY.
 *
 * A published tool contract that disagrees with the running tools is worse
 * than publishing nothing: an agent author generates a client from it, every
 * call fails argument validation, and the failure looks like our bug from the
 * outside. This drifted once already (`request_event_handoff` published
 * `targetId` while the registrar reads `targetExternalId` and also requires
 * `channel`), so it is checked mechanically rather than by eye.
 *
 * The first version of this gate compared property NAMES and `required` only.
 * That was too weak, and review caught three separate drifts it waved through:
 * a published `limit` maximum of 20 against a relay that clamps to 16, a
 * `targetType` published as a bare string against a closed six-value backend
 * union, and `maxLength` constraints present in the contract but absent from
 * the registrar. Every one of those produces the exact failure this gate exists
 * to prevent — a call that is valid per the published schema and refused by the
 * server. So it now compares the whole input schema, deeply.
 *
 * Two checks:
 *   0. every published tool is REGISTERED, not merely declared
 *   1. published tools.json  ==  reference/registerAgentTools.ts (deep)
 *   2. reference/registerAgentTools.ts  ==  the live landing registrar
 *
 * Check 2 runs only when WEBMCP_LIVE_REGISTRAR points at the live registrar
 * file — the private monorepo sets it to its landing-site copy. This public
 * repo cannot see that file, so the gate skips check 2 rather than failing:
 * the published package must stay self-checking on its own.
 *
 * Run: npm run check:contract
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "@typescript/typescript6";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(root, "schemas/melaninmap.tools.json"), "utf8"),
);

const REFERENCE = join(root, "reference/registerAgentTools.ts");
// Set by the private monorepo; unset (and check 2 skipped) everywhere else.
const LIVE = process.env.WEBMCP_LIVE_REGISTRAR || null;

/** Strip comments so an object literal can be evaluated. Not inside strings. */
function stripComments(text) {
  let out = "";
  let inString = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Tool identifier -> tool name, for every tool a registrar DECLARES.
 *
 * Declaration is not registration; see extractRegisteredToolNames.
 */
function extractDeclaredTools(source) {
  const declared = new Map();
  const marker = /const\s+(\w+)\s*:\s*ModelContextTool\s*=\s*\{/g;
  let m;
  while ((m = marker.exec(source)) !== null) {
    const identifier = m[1];
    const open = source.indexOf("{", m.index);
    const cleaned = stripComments(source.slice(open));
    let depth = 0;
    let end = -1;
    for (let i = 0; i < cleaned.length; i += 1) {
      if (cleaned[i] === "{") depth += 1;
      else if (cleaned[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) continue;
    const name = /\n {2}name:\s*"([^"]+)"/.exec(cleaned.slice(0, end))?.[1];
    if (name) declared.set(identifier, name);
  }
  return declared;
}

/**
 * The tool names a registrar actually REGISTERS.
 *
 * Read from the `const tools = [...]` array (or its exact, local, no-argument
 * getter), which is what gets passed to
 * `registerTool` and `provideContext` — not from the declarations. A tool can
 * be declared, published, and byte-identical across all three files while
 * having been dropped from that array, in which case it is advertised to
 * agents and never registered. Comparing declarations reports success for
 * exactly that case, so the registered set is the one that counts.
 */
function extractRegisteredToolNames(source) {
  const declared = extractDeclaredTools(source);
  const file = ts.createSourceFile("registrar.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const toolDeclarations = [];
  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "tools") {
          toolDeclarations.push(declaration);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (toolDeclarations.length !== 1) return null;

  let initializer = toolDeclarations[0].initializer;
  if (initializer && ts.isCallExpression(initializer)) {
    if (!ts.isIdentifier(initializer.expression) || initializer.arguments.length !== 0) return null;
    const getterName = initializer.expression.text;
    const getters = file.statements.filter((statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === getterName,
    );
    if (getters.length !== 1) return null;
    const getter = getters[0];
    // Match the invoked binding, not merely a top-level name: a parameter or
    // local variable can shadow an otherwise matching, unused declaration.
    // Resolve this one source file without loading imports or ambient types.
    const compilerOptions = { noLib: true, noResolve: true };
    const host = ts.createCompilerHost(compilerOptions);
    host.getSourceFile = name => name === file.fileName ? file : undefined;
    const program = ts.createProgram([file.fileName], compilerOptions, host);
    const declarations = program.getTypeChecker().getSymbolAtLocation(initializer.expression)?.declarations;
    if (declarations?.length !== 1 || declarations[0] !== getter) return null;
    if (getter.asteriskToken || getter.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return null;
    if (getter.parameters.length !== 0 || !getter.body || getter.body.statements.length !== 1) return null;
    const returned = getter.body.statements[0];
    if (!ts.isReturnStatement(returned) || !returned.expression) return null;
    initializer = returned.expression;
  }
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) return null;
  const identifiers = [];
  for (const element of initializer.elements) {
    if (!ts.isIdentifier(element)) return null;
    identifiers.push(element.text);
  }
  if (new Set(identifiers).size !== identifiers.length) return null;
  return identifiers
    .map((identifier) => declared.get(identifier) ?? `<unknown:${identifier}>`)
    .sort();
}

/** Extract `inputSchema: { ... }` for one tool by brace matching, then evaluate. */
function extractInputSchema(source, toolName) {
  const at = source.indexOf(`"${toolName}"`);
  if (at === -1) return null;
  const key = source.indexOf("inputSchema:", at);
  if (key === -1) return null;
  const open = source.indexOf("{", key);
  if (open === -1) return null;

  const cleaned = stripComments(source.slice(open));
  let depth = 0;
  let end = -1;
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] === "{") depth += 1;
    else if (cleaned[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;

  // A pure object literal of literal values. Evaluated with no globals.
  try {
    return runInContext(`(${cleaned.slice(0, end)})`, createContext(
      Object.create(null),
    ));
  } catch {
    return null;
  }
}

/** Stable, key-order-independent rendering for comparison. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  }
  return value;
}

const show = (v) => JSON.stringify(canonical(v));

let failures = 0;
const referenceSource = readFileSync(REFERENCE, "utf8");

const publishedNames = contract.tools.map((t) => t.name).sort();
const referenceNames = extractRegisteredToolNames(referenceSource);
if (referenceNames === null) {
  failures += 1;
  console.error("FAIL no statically readable `const tools` registration array in reference/registerAgentTools.ts");
}
const declaredButUnregistered = [...extractDeclaredTools(referenceSource).values()]
  .filter((name) => !(referenceNames ?? []).includes(name))
  .sort();
if (declaredButUnregistered.length > 0) {
  failures += 1;
  console.error(
    `FAIL declared but never registered in reference/: ${declaredButUnregistered.join(", ")}`,
  );
}
if (referenceNames !== null && JSON.stringify(publishedNames) !== JSON.stringify(referenceNames)) {
  failures += 1;
  console.error("FAIL tool sets differ between the contract and reference/registerAgentTools.ts");
  console.error(`  published: ${publishedNames.join(", ")}`);
  console.error(`  reference: ${referenceNames.join(", ")}`);
}

for (const tool of contract.tools) {
  const deployed = extractInputSchema(referenceSource, tool.name);
  if (!deployed) {
    console.error(`FAIL ${tool.name}: no readable inputSchema in reference/registerAgentTools.ts`);
    failures += 1;
    continue;
  }
  if (show(deployed) === show(tool.inputSchema)) {
    console.log(`ok   ${tool.name}`);
    continue;
  }
  failures += 1;
  console.error(`FAIL ${tool.name}: published input schema differs from the registrar`);
  console.error(`  published: ${show(tool.inputSchema)}`);
  console.error(`  deployed:  ${show(deployed)}`);
}

if (LIVE && !existsSync(LIVE)) {
  // Set but wrong is a misconfiguration, not a standalone package: skipping
  // here would report parity that was never checked.
  failures += 1;
  console.error(`FAIL WEBMCP_LIVE_REGISTRAR does not exist: ${LIVE}`);
} else if (LIVE) {
  const liveSource = readFileSync(LIVE, "utf8");
  const liveNames = extractRegisteredToolNames(liveSource);
  // Mirror the reference side exactly. An unreadable registration array must
  // FAIL, not skip: the per-tool schema checks below read standalone
  // declarations and would still pass, so a live registrar that renamed or
  // removed `const tools = [...]` would be reported as fully matching while
  // registering nothing this gate can see.
  if (liveNames === null) {
    failures += 1;
    console.error("FAIL no statically readable `const tools` registration array in the live landing registrar");
  } else if (JSON.stringify(liveNames) !== JSON.stringify(referenceNames)) {
    failures += 1;
    console.error("FAIL tool sets differ between reference/ and the live registrar");
    console.error(`  live:      ${liveNames.join(", ")}`);
    console.error(`  reference: ${(referenceNames ?? []).join(", ")}`);
  }
  const liveDeclaredButUnregistered = [...extractDeclaredTools(liveSource).values()]
    .filter((name) => !(liveNames ?? []).includes(name))
    .sort();
  if (liveNames !== null && liveDeclaredButUnregistered.length > 0) {
    failures += 1;
    console.error(
      `FAIL declared but never registered in the live registrar: ${liveDeclaredButUnregistered.join(", ")}`,
    );
  }
  for (const tool of contract.tools) {
    const live = extractInputSchema(liveSource, tool.name);
    const ref = extractInputSchema(referenceSource, tool.name);
    if (!live) {
      console.error(`FAIL ${tool.name}: not registered in the live landing registrar`);
      failures += 1;
      continue;
    }
    if (show(live) === show(ref)) {
      console.log(`ok   ${tool.name} (reference matches the live registrar)`);
      continue;
    }
    failures += 1;
    console.error(`FAIL ${tool.name}: reference/ has drifted from the live registrar`);
    console.error(`  live:      ${show(live)}`);
    console.error(`  reference: ${show(ref)}`);
  }
} else {
  console.log("\nskip live-registrar parity: WEBMCP_LIVE_REGISTRAR is not set");
}

if (failures > 0) {
  console.error(
    `\n${failures} check(s) failed. The published contract, the reference copy and the live registrar must all agree.`,
  );
  process.exit(1);
}
console.log(`\nAll ${contract.tools.length} published tools match the registrar, constraints included.`);
