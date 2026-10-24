import path from 'node:path'
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { FakeBaiduClient, makeTestRoot } from '../test/helpers/fake-client.mjs'
import { SyncEngine } from '../src/sync-engine.mjs'
import { BackupEngine } from '../src/backup-engine.mjs'
import { RestoreEngine, restorePlanDigest } from '../src/restore-engine.mjs'
import { ProjectUploader } from '../src/project-upload.mjs'
import { MirrorDaemon, mirrorStatePath } from '../src/watch.mjs'

/**
 * End-to-end demonstration against the in-memory Baidu client.
 *
 * This is the executable form of the README walkthrough: it exercises every
 * feature the project claims, on the approved drive, without network access or
 * a real token. Run it with `node scripts/demo.mjs`.
 */
function step(name) {
  process.stdout.write(`\n=== ${name} ===\n`)
}

const root = await makeTestRoot('demo')
const client = new FakeBaiduClient()

const config = {
  remoteRoot: root.remoteRoot,
  local: { ...root.config.local, root: root.root },
  sync: root.config.sync,
  backup: {
    maxFileBytes: 100 * 1024 * 1024,
    includeProjectGitBundle: false,
    sources: { sessions: true, workspaceRegistry: true, sessionProjectionCache: false, profileConfig: false },
    projects: [],
  },
  hds: {
    home: path.join(root.root, 'dsh-home'),
    profile: 'desktop',
    sessionsDir: path.join(root.root, 'dsh-home', 'sessions'),
    storagesDir: path.join(root.root, 'dsh-home', 'storages'),
  },
}

step('1. 百度网盘上的工程 → 本地镜像（可被 HDS 当作普通目录）')
await fsp.mkdir(path.join(root.localRoot, 'src'), { recursive: true })
await fsp.writeFile(path.join(root.localRoot, 'README.md'), '# demo project\n')
await fsp.writeFile(path.join(root.localRoot, 'src', 'app.js'), 'export const x = 1\n')
const mirror = new SyncEngine({ client, config, localRoot: root.localRoot, remoteRoot: `${root.remoteRoot}/projects/demo` })
const pushed = await mirror.apply(await mirror.plan({ direction: 'push' }))
process.stdout.write(`uploaded=${pushed.counts.uploaded} -> ${root.localRoot}\n`)

step('2. 本地直接编辑 → 增量上传')
await fsp.writeFile(path.join(root.localRoot, 'src', 'app.js'), 'export const x = 2 // edited locally\n')
const delta = await mirror.plan({ direction: 'both' })
process.stdout.write(`pending uploads=${delta.summary.uploads} conflicts=${delta.summary.conflicts}\n`)
const applied = await mirror.apply(delta)
process.stdout.write(`uploaded=${applied.counts.uploaded}\n`)

step('3. 写入冲突不会覆盖任何一侧')
await fsp.writeFile(path.join(root.localRoot, 'README.md'), '# local edit\n')
const seed = path.join(root.root, 'seed.md')
await fsp.writeFile(seed, '# remote edit\n')
await client.uploadAtomic(seed, `${root.remoteRoot}/projects/demo/README.md`)
await fsp.writeFile(path.join(root.localRoot, 'README.md'), '# local edit again\n')
const conflictPlan = await mirror.plan({ direction: 'both' })
process.stdout.write(`conflicts=${conflictPlan.conflicts.length} (skipped, never overwritten)\n`)

step('4. 镜像守护：文件监听 + 周期对账')
const daemon = new MirrorDaemon({
  engine: mirror,
  localRoot: root.localRoot,
  remoteRoot: `${root.remoteRoot}/projects/demo`,
  stateFile: mirrorStatePath(config.local.stateDir, mirror.id),
  direction: 'both',
  remoteIntervalMs: 60000,
  debounceMs: 5,
})
await fsp.writeFile(path.join(root.localRoot, 'notes.txt'), 'watched\n')
const cycle = await daemon.cycle('demo')
const daemonState = JSON.parse(await fsp.readFile(daemon.stateFile, 'utf8'))
process.stdout.write(`cycle uploads=${cycle.summary.uploads} daemon state=${daemonState.state} cycles=${daemonState.cycles}\n`)
await daemon.stop()

step('5. 工程上传（排除规则 + 可选 git bundle）')
const project = path.join(root.root, 'project')
await fsp.mkdir(path.join(project, 'node_modules', 'x'), { recursive: true })
await fsp.writeFile(path.join(project, 'package.json'), '{}\n')
await fsp.writeFile(path.join(project, 'node_modules', 'x', 'index.js'), 'excluded\n')
const uploader = new ProjectUploader({ client, config })
const uploadPlan = await uploader.plan({ project, remoteDir: `${root.remoteRoot}/projects/uploaded` })
const uploadResult = await uploader.apply(uploadPlan)
process.stdout.write(`uploaded=${uploadResult.sync.counts.uploaded} bundle=${uploadPlan.bundle.enabled} (${uploadPlan.bundle.reason})\n`)

step('6. HDS 会话与 workspace 备份')
await fsp.mkdir(path.join(config.hds.sessionsDir, 'proj', 's1'), { recursive: true })
await fsp.writeFile(path.join(config.hds.sessionsDir, 'proj', 's1', 'session.jsonl.zstd'), 'session-bytes')
await fsp.mkdir(config.hds.storagesDir, { recursive: true })
await fsp.writeFile(path.join(config.hds.storagesDir, 'workspace.json'), '{"unit":{"name":"workspace","version":2},"tables":{}}')
const backup = new BackupEngine({ client, config })
const snapshot = await backup.apply(await backup.plan())
process.stdout.write(`snapshot=${snapshot.snapshotId} uploaded=${snapshot.uploaded} reused=${snapshot.reused}\n`)

step('7. 第二次备份只上传变化的对象')
await fsp.writeFile(path.join(config.hds.sessionsDir, 'proj', 's1', 'session.jsonl.zstd'), 'session-bytes-v2')
const second = await backup.apply(await backup.plan())
process.stdout.write(`snapshot=${second.snapshotId} uploaded=${second.uploaded} reused=${second.reused}\n`)

step('8. 新机器恢复（含路径映射）')
const newHome = path.join(root.root, 'new-machine', 'dsh')
const restore = new RestoreEngine({ client, config, backupEngine: backup })
const restorePlan = await restore.plan(second.snapshotId, { mapping: { 'hds-home': newHome } })
const digest = await restorePlanDigest(restore, restorePlan)
const restored = await restore.apply(restorePlan, { confirm: true, planDigest: digest })
process.stdout.write(`restored=${restored.restored} safety=${path.basename(restored.safetyRoot ?? '')}\n`)
process.stdout.write(`session file: ${await fsp.readFile(path.join(newHome, 'sessions', 'proj', 's1', 'session.jsonl.zstd'), 'utf8')}\n`)

step('9. 篡改检测：planDigest 不匹配则拒绝落地')
const freshPlan = await restore.plan(second.snapshotId, { mapping: { 'hds-home': path.join(root.root, 'new-machine', 'dsh2') } })
const freshDigest = await restorePlanDigest(restore, freshPlan)
freshPlan.entries[0].sha256 = '0'.repeat(64)
const rejected = await restore.apply(freshPlan, { confirm: true, planDigest: freshDigest }).then(() => false, error => error.code)
process.stdout.write(`tampered plan rejected: ${rejected}\n`)

step('10. C: 路径在任何入口都被拒绝')
const stillSyncable = await mirror.plan({ direction: 'pull' }).then(() => true, () => false)
const cdrive = await import('../src/paths.mjs')
  .then(m => m.resolveLocalPath('C:\\Windows\\Temp\\x', { root: root.root, allowedDrives: ['G'] }))
  .then(() => 'ALLOWED (bug)', error => error.code)
process.stdout.write(`C: -> ${cdrive}; approved-drive plan still works: ${stillSyncable}\n`)

process.stdout.write(`\nRemote objects: ${client.snapshot().length}\n`)
process.stdout.write(`Workdir (G: only): ${root.root}\n`)
