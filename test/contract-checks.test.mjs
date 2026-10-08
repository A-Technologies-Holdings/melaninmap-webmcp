import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function fixture(run) {
  // Under the project so yaml resolves from the existing devDependencies.
  const root = mkdtempSync(new URL('../.test-build/contract-', import.meta.url).pathname);
  try {
    for (const folder of ['scripts', 'schemas', 'reference']) {
      cpSync(new URL(`../${folder}`, import.meta.url), join(root, folder), { recursive: true });
    }
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function check(root, script, env = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', script)], {
    encoding: 'utf8', env: { ...process.env, WEBMCP_LIVE_REGISTRAR: '', ...env },
  });
}

test('OpenAPI check rejects a stale tool name while accepting refusal codes', () => fixture((root) => {
  // Child output in the messages: this test failed once without it, and the
  // exit status alone could not say why.
  const clean = check(root, 'check-openapi-pointers.mjs');
  assert.equal(clean.status, 0, `${clean.error ?? ''}\n${clean.signal ?? ''}\n${clean.stdout}\n${clean.stderr}`);
  const path = join(root, 'schemas/openapi.yaml');
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll('check_ownership_verification', 'check_verification_status'));
  const result = check(root, 'check-openapi-pointers.mjs');
  assert.equal(result.status, 1, `${result.error ?? ''}\n${result.signal ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /schemas name a tool the contract does not define: check_verification_status/);
}));

test('private parity fails for a missing configured path and passes for a matching registrar', () => fixture((root) => {
  const result = check(root, 'check-contract-matches-reference.mjs', { WEBMCP_LIVE_REGISTRAR: join(root, 'missing.ts') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not exist/);
  const match = check(root, 'check-contract-matches-reference.mjs', { WEBMCP_LIVE_REGISTRAR: join(root, 'reference/registerAgentTools.ts') });
  assert.equal(match.status, 0, match.stderr);
}));

const literalTools = `const tools = [
    searchTool,
    businessDetailsTool,
    verificationTool,
    recordInterestTool,
    handoffTool,
  ];`;
const allTools = `[
    searchTool,
    businessDetailsTool,
    verificationTool,
    recordInterestTool,
    handoffTool,
  ]`;

function liveRegistrarFixture(root, replacement, addition = '') {
  const source = readFileSync(join(root, 'reference/registerAgentTools.ts'), 'utf8');
  assert.ok(source.includes(literalTools), 'public fixture registration array changed');
  const live = join(root, 'live.ts');
  writeFileSync(live, `${source.replace(literalTools, replacement)}\n${addition}`);
  return check(root, 'check-contract-matches-reference.mjs', { WEBMCP_LIVE_REGISTRAR: live });
}

test('private parity accepts an exported static no-argument getter, including comments and formatting', () => fixture((root) => {
  const result = liveRegistrarFixture(root, 'const tools = getDirectoryAgentTools ( /* intentionally empty */ );', `
export function getDirectoryAgentTools(): ModelContextTool[] {
  // Formatting and comments cannot change the statically returned set.
  return ${allTools};
}`);
  assert.equal(result.status, 0, result.stderr);
}));

test('getter registration still rejects an omitted tool', () => fixture((root) => {
  const result = liveRegistrarFixture(root, 'const tools = getDirectoryAgentTools();', `function getDirectoryAgentTools(): ModelContextTool[] {
  return [searchTool, businessDetailsTool, verificationTool, recordInterestTool];
}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tool sets differ|declared but never registered/);
}));

test('an unrelated matching getter cannot rescue the getter used by registration', () => fixture((root) => {
  const result = liveRegistrarFixture(root, 'const tools = getRegisteredTools();', `function unrelatedMatchingGetter(): ModelContextTool[] { return ${allTools}; }
function getRegisteredTools(): ModelContextTool[] {
  return [searchTool, businessDetailsTool, verificationTool, recordInterestTool];
}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tool sets differ|declared but never registered/);
}));

test('dynamic getter registrations fail closed', () => fixture((root) => {
  const result = liveRegistrarFixture(root, 'const tools = getDirectoryAgentTools();',
    'function getDirectoryAgentTools(): ModelContextTool[] { return buildTools(); }');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no statically readable `const tools`/);
}));

test('duplicate getter entries fail closed', () => fixture((root) => {
  const result = liveRegistrarFixture(root, 'const tools = getDirectoryAgentTools();', `function getDirectoryAgentTools(): ModelContextTool[] {
  return [searchTool, businessDetailsTool, verificationTool, recordInterestTool, handoffTool, handoffTool];
}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no statically readable `const tools`/);
}));

for (const declaration of ['async function', 'function*']) {
  test(`parity rejects a ${declaration} getter`, () => fixture((root) => {
    const result = liveRegistrarFixture(root, 'const tools = getDirectoryAgentTools();',
      `${declaration} getDirectoryAgentTools() { return ${allTools}; }`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no statically readable `const tools`/);
  }));
}
