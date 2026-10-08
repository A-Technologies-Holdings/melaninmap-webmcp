import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = path.join(root, 'scripts/check-compatibility.mjs');
const source = JSON.parse(await readFile(path.join(root, 'compatibility/webmcp.json'), 'utf8'));
const run = file => spawnSync(process.execPath, [checker, file], { cwd: root, encoding: 'utf8' });

for (const [label, mutate] of [
 ['nested field type', value => { value.browser.currentRun.reason = 7 }],
 ['unknown status', value => { value.productionDeployment.status = 'observed' }],
 ['passed without receipt', value => { value.liveOriginTrial = { status: 'passed', command: 'probe' } }],
 ['unknown nested field', value => { value.unsupportedHost.surprise = true }],
]) test(`compatibility schema rejects ${label}`, async () => {
 const scratch = await mkdtemp(path.join(os.tmpdir(), 'webmcp-compat-'));
 try {
  const candidate = structuredClone(source); mutate(candidate);
  const file = path.join(scratch, 'evidence.json'); await writeFile(file, JSON.stringify(candidate));
  const result = run(file); assert.notEqual(result.status, 0, result.stdout);
 } finally { await rm(scratch, { recursive: true, force: true }) }
});

test('compatibility schema permits a future passed browser run with a receipt', async () => {
 const scratch = await mkdtemp(path.join(os.tmpdir(), 'webmcp-compat-'));
 try {
  const candidate = structuredClone(source);
  candidate.browser.currentRun = { status: 'passed', observedAt: '2026-10-08T12:00:00Z', sourceCommit: 'a'.repeat(40), engine: 'Chromium', engineVersion: '153.0.8010.12', playwrightVersion: '1.63.0', command: 'npm run test:browser', surface: 'synthetic validation fixture', receipt: { suite: 'fixture', result: 'passed' } };
  const file = path.join(scratch, 'evidence.json'); await writeFile(file, JSON.stringify(candidate));
  const result = run(file); assert.equal(result.status, 0, result.stderr);
 } finally { await rm(scratch, { recursive: true, force: true }) }
});

for (const [label, mutate] of [
 ['failed browser receipt', value => { value.browser.currentRun = {status: 'failed', command: 'npm run test:browser', reason: 'Synthetic failure fixture'} }],
 ['historical receipt with an older Playwright pin', value => { value.browser.historicalObservation = {status: 'passed', observedAt: '2026-01-01T00:00:00Z', sourceCommit: 'b'.repeat(40), engine: 'Chromium', engineVersion: '140.0', playwrightVersion: '1.50.0', command: 'npm run test:browser', surface: 'synthetic historical fixture', receipt: {suite: 'fixture', result: 'passed'}} }],
]) test(`compatibility schema permits ${label}`, async () => {
 const scratch = await mkdtemp(path.join(os.tmpdir(), 'webmcp-compat-'));
 try {
  const candidate = structuredClone(source); mutate(candidate);
  const file = path.join(scratch, 'evidence.json'); await writeFile(file, JSON.stringify(candidate));
  const result = run(file); assert.equal(result.status, 0, result.stderr);
 } finally { await rm(scratch, {recursive: true, force: true}) }
});
