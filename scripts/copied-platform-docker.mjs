import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const ISOLATED_NODE_IMAGE = 'node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7';

/** Runs the shipped offline DB verifier, with neither a network nor a host
 * Docker socket. Only the copied DB/key, pinned code and old migration files
 * are mounted; all are read-only. The actual copied databases live in tmpfs. */
export function runCopiedPlatformDrill({ dataDirectory, keyFile, runtimeDirectory, oldMigrationsDirectory, dockerHost }) {
  const scratch = mkdtempSync(join(tmpdir(), 'openship-isolated-platform-'));
  const id = randomUUID(), owner = statSync(keyFile);
  const args = dockerHost ? ['--host', dockerHost] : [];
  const docker = commands => {
    try { return execFileSync('docker', [...args, ...commands], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }).trim(); }
    catch { throw new Error('Isolated platform Docker operation failed'); }
  };
  let container;
  try {
    // Required cached immutable fixture. The caller/CI explicitly pulls it;
    // missing Docker or image is a failure, never a skipped migration drill.
    const image = JSON.parse(docker(['image','inspect',ISOLATED_NODE_IMAGE]))[0];
    if (!image.RepoDigests?.includes(ISOLATED_NODE_IMAGE)) throw new Error('Isolated Node fixture does not match its immutable manifest');
    const configuration = join(scratch, 'input.json');
    writeFileSync(configuration, JSON.stringify({ snapshotDataDirectory: '/snapshot', workspace: '/tmp', keyFile: '/original-key', oldMigrationsDirectory: '/old-migrations', targetMigrationsDirectory: '/runtime/dist/server/migrations', assetsDirectory: '/runtime/dist/server/pglite' }), { mode: 0o644 });
    const mounts = [[dataDirectory,'/snapshot'],[keyFile,'/original-key'],[runtimeDirectory,'/runtime'],[oldMigrationsDirectory,'/old-migrations'],[configuration,'/input.json']];
    container = docker(['create','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','2g','--cpus','1',
      '--user',`${owner.uid}:${owner.gid}`,'--tmpfs','/tmp:rw,nosuid,noexec,size=1536m,mode=1777','--label',`openship.drill=${id}`,
      ...mounts.flatMap(([source,target]) => ['--mount',`type=bind,src=${source},dst=${target},readonly`]),
      image.Id,'node','/runtime/dist/server/copied-pglite-upgrade.mjs','--drill','/input.json']);
    const actual = JSON.parse(docker(['inspect',container]))[0];
    if (actual.HostConfig.NetworkMode !== 'none' || !actual.HostConfig.ReadonlyRootfs || actual.HostConfig.Privileged || actual.HostConfig.PidMode || actual.HostConfig.CapDrop?.[0] !== 'ALL' || !actual.HostConfig.SecurityOpt?.includes('no-new-privileges') || actual.Mounts.length !== mounts.length || actual.Mounts.some(mount => mount.RW || !mounts.some(([source,target]) => mount.Source === source && mount.Destination === target)))
      throw new Error('Real Docker isolation does not match the migration drill contract');
    const output = docker(['start','--attach',container]);
    const result = JSON.parse(output.split('\n').at(-1));
    const settled = JSON.parse(docker(['inspect',container]))[0];
    if (settled.State.ExitCode !== 0 || result.upgradeVerified !== true || result.wrongKeyRejected !== true || result.matchingRestoreVerified !== true || result.targetRejectedOldSnapshot !== true) throw new Error('Copied-platform migration/encryption/restore evidence is incomplete');
    // Return known evidence fields, never arbitrary subprocess output.
    return { upgradeVerified: true, wrongKeyRejected: true, matchingRestoreVerified: true, isolationVerified: true, nodeImage: ISOLATED_NODE_IMAGE,
      migrations: result.migrations, projects: result.projects, users: result.users, services: result.services, deployments: result.deployments };
  } finally {
    if (container) docker(['rm','--force',container]);
    rmSync(scratch, { recursive: true, force: true });
  }
}
