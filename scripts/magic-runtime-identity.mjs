import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const upstreamCommit = '278c9847363d04c1cb2e8768c878b94a65fb33a1';
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim()) throw new Error('Runtime identity requires a clean, committed source tree');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['merge-base', '--is-ancestor', upstreamCommit, sourceCommit]);
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceCommit) throw new Error('Runtime source differs from checked-out workflow SHA');
const version = `0.9.10-magic.${sourceCommit.slice(0,12)}`;
for (const file of ['package.json', ...['api','cli','dashboard'].map(name => `apps/${name}/package.json`), ...['platform','sdk','contracts','core','adapters','openship'].map(name => `packages/${name}/package.json`)]) {
  const pkg = JSON.parse(readFileSync(file, 'utf8')); pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
const identity = { schemaVersion: 1, version, sourceCommit, upstreamCommit, contractVersion: 1, tag: `magic-runtime-${sourceCommit.slice(0,12)}` };
writeFileSync('magic-runtime.json', JSON.stringify(identity, null, 2) + '\n');
console.log(JSON.stringify(identity));
