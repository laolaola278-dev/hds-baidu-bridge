import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { BackupScheduler, installScheduledTask, readSchedulerState, schedulerStatePath } from '../src/scheduler.mjs'
import { BackupEngine } from '../src/backup-engine.mjs'
import { FakeBaiduClient, makeTestRoot } from './helpers/fake-client.mjs'

async function setup(label) {
  const root = await makeTestRoot(label)
  const config = {
    remoteRoot: root.remoteRoot,
    local: { ...root.config.local, root: root.root },
    sync: root.config.sync,
    hds: {
      home: path.join(root.root, 'dsh-home'),
      profile: 'desktop',
      sessionsDir: path.join(root.root, 'dsh-home', 'sessions'),
      storagesDir: path.join(root.root, 'dsh-home', 'storages'),
    },
    backup: {
      maxFileBytes: 100 * 1024 * 1024,
      sources: { sessions: true, workspaceRegistry: false, sessionProjectionCache: false, profileConfig: false },
      projects: [],
    },
  }
  await fsp.mkdir(config.hds.sessionsDir, { recursive: true })
  await fsp.writeFile(path.join(config.hds.sessionsDir, 'a.zstd'), 'session')
  const engine = new BackupEngine({ client: new FakeBaiduClient(), config })
  return { root, config, engine }
}

test('a scheduler run produces a snapshot and records state', async () => {
  const { root, engine } = await setup('scheduler-run')
  const scheduler = new BackupScheduler({
    engine,
    intervalMs: 60000,
    stateFile: schedulerStatePath(root.config.local.stateDir),
  })
  const result = await scheduler.runOnce('test')
  assert.equal(result.ok, true)
  assert.equal(result.files, 1)
  assert.equal(result.uploaded, 1)
  const state = await readSchedulerState(scheduler.stateFile)
  assert.equal(state.state, 'idle')
  assert.equal(state.runs, 1)
  assert.equal(state.lastResult.snapshotId, result.snapshotId)
})

test('a scheduler failure is recorded and does not throw', async () => {
  const { root, engine } = await setup('scheduler-error')
  engine.client.failNextUpload = true
  const scheduler = new BackupScheduler({
    engine,
    intervalMs: 60000,
    stateFile: schedulerStatePath(root.config.local.stateDir),
  })
  const result = await scheduler.runOnce('test')
  assert.equal(result.ok, false)
  const state = await readSchedulerState(scheduler.stateFile)
  assert.equal(state.state, 'error')
  assert.equal(state.runs, 0)
})

test('the interval is clamped to at least one minute', async () => {
  const { root, engine } = await setup('scheduler-clamp')
  const scheduler = new BackupScheduler({ engine, intervalMs: 100, stateFile: schedulerStatePath(root.config.local.stateDir) })
  assert.equal(scheduler.intervalMs, 60000)
  const oneHour = new BackupScheduler({ engine, intervalMs: 3_600_000, stateFile: schedulerStatePath(root.config.local.stateDir) })
  assert.equal(oneHour.intervalMs, 3_600_000)
})

test('the scheduled task dry run never executes schtasks', async () => {
  let called = false
  const result = await installScheduledTask({
    nodePath: 'G:\\node\\node.exe',
    scriptPath: 'G:\\p\\bin\\hds-baidu.mjs',
    workingDirectory: 'G:\\p',
    everyMinutes: 45,
    dryRun: true,
    execFile: async () => {
      called = true
      return { stdout: '', stderr: '' }
    },
  })
  assert.equal(called, false)
  assert.equal(result.dryRun, true)
  assert.equal(result.everyMinutes, 45)
  assert.deepEqual(result.args.slice(0, 2), ['/Create', '/TN'])
  assert.match(result.command, /backup run --apply$/)
})

test('every minutes is clamped into the supported range', async () => {
  const base = {
    nodePath: 'n',
    scriptPath: 's',
    workingDirectory: 'w',
    dryRun: true,
    execFile: async () => ({ stdout: '', stderr: '' }),
  }
  assert.equal((await installScheduledTask({ ...base, everyMinutes: 0 })).everyMinutes, 1)
  assert.equal((await installScheduledTask({ ...base, everyMinutes: 99999 })).everyMinutes, 1440)
})
