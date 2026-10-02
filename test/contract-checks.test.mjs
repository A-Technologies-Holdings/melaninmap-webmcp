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
  assert.equal(check(root, 'check-openapi-pointers.mjs').status, 0);
  const path = join(root, 'schemas/openapi.yaml');
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll('check_ownership_verification', 'check_verification_status'));
  const result = check(root, 'check-openapi-pointers.mjs');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /schemas name a tool the contract does not define: check_verification_status/);
}));

test('private parity fails for a missing configured path and passes for a matching registrar', () => fixture((root) => {
  const result = check(root, 'check-contract-matches-reference.mjs', { WEBMCP_LIVE_REGISTRAR: join(root, 'missing.ts') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not exist/);
  const match = check(root, 'check-contract-matches-reference.mjs', { WEBMCP_LIVE_REGISTRAR: join(root, 'reference/registerAgentTools.ts') });
  assert.equal(match.status, 0, match.stderr);
}));
