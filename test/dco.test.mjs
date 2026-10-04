import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('DCO accepts trailers but rejects unsigned commits and signatures in prose', () => {
  const root = mkdtempSync(join(tmpdir(), 'webmcp-dco-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.org');
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    const script = new URL('../scripts/check-dco.mjs', import.meta.url).pathname;
    const check = () => spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, DCO_BASE: base }, encoding: 'utf8' });
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'signed\n\nSigned-off-by: Test <test@example.org>');
    assert.equal(check().status, 0);
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'dependency update\n\n---\nupdated-dependencies:\n- dependency-name: typescript\n...\n\nSigned-off-by: dependabot[bot] <support@github.com>');
    assert.equal(check().status, 0, 'Dependabot metadata must not hide the trailing sign-off');
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'unsigned');
    assert.equal(check().status, 1);
    git('-c', 'commit.gpgsign=false', 'commit', '--amend', '--allow-empty', '-qm', 'prose\n\nSigned-off-by: Test <test@example.org>\n\nThis is body text after the signature.');
    assert.equal(check().status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
