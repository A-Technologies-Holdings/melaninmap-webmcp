import { execFileSync } from 'node:child_process';

// Arguments are passed directly to git; PR titles/messages are never shell code.
const base = process.env.DCO_BASE;
if (!base || !/^[0-9a-f]{40}$/.test(base)) {
  console.error('FAIL DCO_BASE must be a full base commit SHA');
  process.exit(1);
}
const commits = execFileSync('git', ['rev-list', `${base}..HEAD`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
let failures = 0;
for (const sha of commits) {
  const message = execFileSync('git', ['show', '-s', '--format=%B', sha], { encoding: 'utf8' });
  const trailers = execFileSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8' });
  if (!/^Signed-off-by: .+ <[^<>\s]+@[^<>\s]+>$/im.test(trailers)) {
    console.error(`FAIL ${sha}: missing Signed-off-by DCO trailer`);
    failures += 1;
  }
}
console.log(`DCO: checked ${commits.length} commits`);
process.exitCode = failures ? 1 : 0;
