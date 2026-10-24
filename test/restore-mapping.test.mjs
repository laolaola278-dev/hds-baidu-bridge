import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { restorePlanDigest } from '../src/restore-engine.mjs'
import { BackupEngine } from '../src/backup-engine.mjs'
import { RestoreEngine } from '../src/restore-engine.mjs'
import { FakeBaiduClient, makeTestRoot } from './helpers/fake-client.mjs'

async function configFor(label, options = {}) {
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
      sources: { sessions: true, workspaceRegistry: true, sessionProjectionCache: false, profileConfig: false },
      projects: options.projects ?? [],
    },
  }
  await fsp.mkdir(config.hds.sessionsDir, { recursive: true })
  await fsp.writeFile(path.join(config.hds.sessionsDir, 'a.jsonl.zstd'), 'sessions')
  await fsp.mkdir(config.hds.storagesDir, { recursive: true })
  await fsp.writeFile(path.join(config.hds.storagesDir, 'workspace.json'), '{"unit":1}')
  return { root, config, client: new FakeBaiduClient() }
}

test('restore mapping moves the HDS home to a new drive-approved root', async () => {
  const { root, config, client } = await configFor('restore-map')
  const backup = new BackupEngine({ client, config })
  const snapshot = await backup.apply(await backup.plan())
  const restore = new RestoreEngine({ client, config, backupEngine: backup })
  const newHome = path.join(root.root, 'new-home')
  const plan = await restore.plan(snapshot.snapshotId, { mapping: { 'hds-home': newHome } })
  for (const entry of plan.entries) {
    assert.equal(entry.target.startsWith(newHome), true, `target escaped: ${entry.target}`)
  }
  const digest = await restorePlanDigest(restore, plan)
  const result = await restore.apply(plan, { confirm: true, planDigest: digest })
  assert.equal(result.ok, true)
  assert.equal(await fsp.readFile(path.join(newHome, 'sessions', 'a.jsonl.zstd'), 'utf8'), 'sessions')
})

test('restore refuses a mapping that targets C:', async () => {
  const { config, client } = await configFor('restore-cdrive')
  const backup = new BackupEngine({ client, config })
  const snapshot = await backup.apply(await backup.plan())
  const restore = new RestoreEngine({ client, config, backupEngine: backup })
  await assert.rejects(
    restore.plan(snapshot.snapshotId, { mapping: { 'hds-home': 'C:\\Users\\Public\\hds' } }),
    /refusing to touch C:/,
  )
})

test('restore reject a stale plan digest', async () => {
  const { config, client } = await configFor('restore-stale')
  const backup = new BackupEngine({ client, config })
  const snapshot = await backup.apply(await backup.plan())
  const restore = new RestoreEngine({ client, config, backupEngine: backup })
  const plan = await restore.plan(snapshot.snapshotId)
  const digest = await restorePlanDigest(restore, plan)
  plan.entries[0].sha256 = '0'.repeat(64)
  await assert.rejects(
    restore.apply(plan, { confirm: true, planDigest: digest }),
    /planDigest must be/,
  )
})
