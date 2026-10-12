import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

for (const [mode, expected] of [['spec', 75], ['package', 1]]) {
  test(`Node download failure retains ${mode} exit classification`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'webmcp-bootstrap-'));
    try {
      for (const [name, body] of Object.entries({
        node: 'exit 1',
        npm: 'printf "/image/npm-prefix\\n"',
        npx: 'test "$npm_config_prefix" = /image/npm-prefix || exit 43\nexit 28',
      })) writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, {mode: 0o755});
      const result = spawnSync('bash', ['scripts/buildkite-check.sh', mode], {
        cwd: new URL('..', import.meta.url),
        env: {...process.env, PATH: `${dir}:${process.env.PATH}`},
        encoding: 'utf8',
      });
      assert.equal(result.status, expected, result.stderr);
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}
