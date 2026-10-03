import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

function commands(mode) {
  const bin = mkdtempSync(path.join(tmpdir(), 'webmcp-ci-'));
  writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 });
  return execFileSync('bash', ['scripts/buildkite-check.sh', mode], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

test('ready PR gate keeps behavioral tests and contract checks without package analysis', () => {
  const output = commands('package');
  for (const command of ['run typecheck', 'run check:contract', 'run check:openapi', 'run build:test', 'test']) assert.ok(output.split('\n').includes(command));
  assert.ok(!output.split('\n').includes('run check'));
});

test('nightly/release calls the complete package gate', () => {
  assert.match(commands('regression'), /run check\n/);
});

test('unknown CI mode fails instead of reporting green', () => {
  const result = spawnSync('bash', ['scripts/buildkite-check.sh', 'typo'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
});
