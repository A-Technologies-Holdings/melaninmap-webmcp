import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// @typescript/typescript6 hoists an older `tsc` into node_modules/.bin, so the
// compiler scripts must name TypeScript 7's binary explicitly.
test('build scripts compile with the declared TypeScript', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['build', 'typecheck', 'build:test']) {
    assert.match(pkg.scripts[name], /^node node_modules\/typescript\/bin\/tsc /, name);
  }
  const version = execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--version'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.match(version, new RegExp(`Version ${pkg.devDependencies.typescript.replace(/\./g, '\\.')}`));
});
