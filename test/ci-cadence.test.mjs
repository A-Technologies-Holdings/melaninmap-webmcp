import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

function commands(mode) {
  const bin = mkdtempSync(path.join(tmpdir(), 'webmcp-ci-'));
  writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\nprintf "npx %s\\n" "$*"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nif [ "$1" = "--test" ]; then printf "node --test\\n"; else exec "$WEBMCP_TEST_NODE" "$@"; fi\n', { mode: 0o755 });
  return execFileSync('bash', ['scripts/buildkite-check.sh', mode], {
    encoding: 'utf8', env: { ...process.env, WEBMCP_TEST_NODE: process.execPath, PATH: `${bin}:${process.env.PATH}` },
  });
}

test('ready PR gate keeps behavioral tests and contract checks without package analysis', () => {
  const output = commands('package');
  for (const command of ['run typecheck', 'run check:contract', 'run check:openapi', 'run build:test', 'node --test']) assert.ok(output.split('\n').includes(command));
  assert.ok(!output.split('\n').includes('run check'));
  assert.ok(!output.split('\n').includes('test'), 'npm test would run pretest and rebuild both targets');
  for (const command of ['run build', 'run build:test']) assert.equal(output.split('\n').filter(line => line === command).length, 1);
});

test('nightly/release calls the complete package gate', () => {
  assert.match(commands('regression'), /run check\n/);
});

test('unknown CI mode fails instead of reporting green', () => {
  const result = spawnSync('bash', ['scripts/buildkite-check.sh', 'typo'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
});

test('browser regression installs Playwright Chromium, then runs the browser suite', () => {
  const lines = commands('browser').split('\n');
  assert.deepEqual(lines.filter(Boolean), ['ci --ignore-scripts', 'npx playwright install chromium', 'run test:browser']);
});

test('spec drift runs check:spec, and an install failure reports as network (75)', () => {
  assert.deepEqual(commands('spec').split('\n').filter(Boolean), ['ci --ignore-scripts', 'run check:spec']);
  const bin = mkdtempSync(path.join(tmpdir(), 'webmcp-ci-'));
  writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = spawnSync('bash', ['scripts/buildkite-check.sh', 'spec'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 75);
});
