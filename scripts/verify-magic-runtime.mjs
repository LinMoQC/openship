import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(process.argv[2]);
const identity = JSON.parse(readFileSync(join(root, 'magic-runtime.json'), 'utf8'));
if (identity.contractVersion !== 1 || identity.upstreamCommit !== '234d8a9d0bd571aff3fe3ce73a8408f226dcb4a0' || identity.version !== `0.8.0-magic.${identity.sourceCommit.slice(0,12)}`) throw new Error('Invalid runtime provenance');
const version = execFileSync('node', [join(root,'dist/index.js'), '--version'], { cwd: root, encoding: 'utf8' }).trim();
if (version !== identity.version || JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version !== version) throw new Error('CLI and public SDK versions differ');
for (const file of ['dist/server/index.js','dist/server/copied-platform-docker.mjs','dist/native/engine-worker.mjs','dist/server/pglite/pglite.wasm','dist/server/pglite/pglite.data','dist/server/migrations/0151_gitops_releases.sql','dist/server/migrations/meta/0151_snapshot.json','dist/sdk/native.js','dist/sdk/client.js','dist/sdk/index.d.ts'])
  if (!existsSync(join(root,file))) throw new Error(`Incomplete runtime: ${file}`);
if (!existsSync(join(root,'dist/server/copied-pglite-upgrade.mjs'))) throw new Error('Offline copied-platform database verifier is missing');
const journal = JSON.parse(readFileSync(join(root,'dist/server/migrations/meta/_journal.json'),'utf8'));
if (journal.entries.at(-1)?.tag !== '0151_gitops_releases') throw new Error('Runtime migrations are incomplete');
// Import installed SDK exports from the extracted distribution's own dependency
// context. No monorepo node_modules or TypeScript loader may rescue missing files.
execFileSync('node', ['--input-type=module', '-e', "import('./dist/sdk/client.js').then(m=>{if(typeof m.OpenshipClient!=='function')throw Error('Missing SDK client')})"], { cwd: root, stdio: 'pipe' });
console.log(JSON.stringify({ version, sourceCommit: identity.sourceCommit, contractVersion: identity.contractVersion, migrations: journal.entries.length }));
