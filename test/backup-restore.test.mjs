import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { BackupEngine } from '../src/backup-engine.mjs'
import { RestoreEngine, restorePlanDigest } from '../src/restore-engine.mjs'
import { FakeBaiduClient, makeTestRoot } from './helpers/fake-client.mjs'
import { HdsBaiduError } from '../src/errors.mjs'

async function setup(label) {
  const root = await makeTestRoot(label)
  const client = new FakeBaiduClient()
  const config = {
    ...root.config,
    remoteRoot: root.remoteRoot,
    local: { ...root.config.local, root: root.root },
    hds: {
      home: path.join(root.root, 'dsh-home'),
      profile: 'desktop',
      sessionsDir: path.join(root.root, 'dsh-home', 'sessions'),
      storagesDir: path.join(root.root, 'dsh-home', 'storages'),
    },
    backup: {
      maxFileBytes: 100 * 1024 * 1024,
      sources: { sessions: true, workspaceRegistry: true, sessionProjectionCache: false, profileConfig: false },
      projects: [],
    },
  }
  await fsp.mkdir(path.join(config.hds.sessionsDir, 'proj', 's1'), { recursive: true })
  await fsp.writeFile(path.join(config.hds.sessionsDir, 'proj', 's1', 'session.jsonl.zstd'), 'session-bytes')
  await fsp.mkdir(config.hds.storagesDir, { recursive: true })
  await fsp.writeFile(path.join(config.hds.storagesDir, 'workspace.json'), '{"unit":{"name":"workspace","version":2}}')
  const engine = new BackupEngine({ client, config })
  return { root, client, config, engine }
}

test('backup uploads objects once and records snapshots', async () => {
  const { engine } = await setup('backup')
  const plan = await engine.plan()
  assert.equal(plan.summary.files, 2)
  const first = await engine.apply(plan)
  assert.equal(first.ok, true)
  assert.equal(first.uploaded, 2)

  const secondPlan = await engine.plan()
  assert.equal(secondPlan.summary.uploads, 0)
  const second = await engine.apply(secondPlan)
  assert.equal(second.ok, true)
  assert.equal(second.uploaded, 0)
  assert.notEqual(second.snapshotId, first.snapshotId)
  const listed = await engine.list()
  assert.equal(listed.snapshots.length, 2)
})

test('restore verifies a plan digest and restores files', async () => {
  const { engine, config, root } = await setup('restore')
  const backup = await engine.apply(await engine.plan())
  const restore = new RestoreEngine({ client: engine.client, config, backupEngine: engine })

  const plan = await restore.plan(backup.snapshotId)
  assert.equal(plan.entries.length, 2)
  const digest = await restorePlanDigest(restore, plan)
  await assert.rejects(
    restore.apply(plan, { confirm: true, planDigest: 'bad' }),
    /planDigest must be/,
  )

  await fsp.rm(path.join(config.hds.sessionsDir, 'proj', 's1', 'session.jsonl.zstd'))
  await fsp.rm(path.join(config.hds.storagesDir, 'workspace.json'))
  const result = await restore.apply(plan, { confirm: true, planDigest: digest })
  assert.equal(result.ok, true)
  assert.equal(result.restored, 2)
  assert.equal(await fsp.readFile(path.join(config.hds.sessionsDir, 'proj', 's1', 'session.jsonl.zstd'), 'utf8'), 'session-bytes')
  assert.equal(await fsp.readFile(path.join(config.hds.storagesDir, 'workspace.json'), 'utf8'), '{"unit":{"name":"workspace","version":2}}')
  assert.ok(result.safetyRoot)
})

test('restore refuses a corrupted object', async () => {
  const { engine, config } = await setup('restore-corrupt')
  const backup = await engine.apply(await engine.plan())
  const restore = new RestoreEngine({ client: engine.client, config, backupEngine: engine })
  const plan = await restore.plan(backup.snapshotId)
  const digest = await restorePlanDigest(restore, plan)
  for (const [remotePath, file] of engine.client.files) {
    const data = Buffer.from('corrupted')
    engine.client.files.set(remotePath, {
      ...file,
      data,
      md5: '00000000000000000000000000000000',
    })
  }
  const result = await restore.apply(plan, { confirm: true, planDigest: digest })
  assert.equal(result.ok, false)
  assert.ok(result.failures.length > 0)
})

test('a catalog upload failure removes the orphan manifest it already wrote', async () => {
  const { engine, client, config, root } = await setup('backup-orphan')
  // Only the second uploadAtomic (the catalog) fails; the manifest upload and
  // every object upload before it succeed. FakeBaiduClient's flag is a boolean
  // that fires on the next upload, so arm it after the objects are staged.
  const originalUploadAtomic = client.uploadAtomic.bind(client)
  let atomicCalls = 0
  client.uploadAtomic = async (localPath, remotePath, options) => {
    atomicCalls += 1
    if (String(remotePath).endsWith('catalog.json')) {
      throw new HdsBaiduError('upload-failed', 'simulated catalog upload failure')
    }
    return originalUploadAtomic(localPath, remotePath, options)
  }
  try {
    const plan = await engine.plan()
    await assert.rejects(engine.apply(plan), error => {
      assert.equal(error.code, 'upload-failed')
      return true
    })
    // The manifest written before the failed catalog upload must not survive as
    // an orphan: it would be invisible to `backup list` and unrestorable.
    const manifests = [...client.files.keys()].filter(item => item.includes('/snapshots/') && item.endsWith('manifest.json'))
    assert.deepEqual(manifests, [], `orphan manifests must be removed, saw: ${manifests.join(', ')}`)
    const listed = await engine.list()
    assert.equal(listed.snapshots.length, 0)
    assert.ok(atomicCalls >= 2, 'the manifest and catalog uploads must both have been attempted')
  } finally {
    await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
  }
})

test('list reports a snapshot directory the catalog does not know about', async () => {
  const { engine, client, root } = await setup('backup-orphan-list')
  try {
    const plan = await engine.plan()
    await engine.apply(plan)
    const clean = await engine.list()
    assert.equal(clean.snapshots.length, 1)
    assert.equal(clean.orphanSnapshots, undefined, 'a healthy backup has no orphans')

    // Simulate the failure window: a snapshot directory published on the remote
    // that the catalog never learned about.
    const orphan = '/test/backup-orphan-list/backups/snapshots/1999-01-01T00-00-00-000Z'
    await client.ensureDir(orphan)
    await client.uploadAtomic(
      path.join(root.root, 'orphan-manifest.json'),
      `${orphan}/manifest.json`,
    ).catch(async () => {
      await fsp.writeFile(path.join(root.root, 'orphan-manifest.json'), '{"files":[]}\n')
      await client.uploadAtomic(path.join(root.root, 'orphan-manifest.json'), `${orphan}/manifest.json`)
    })

    const listed = await engine.list()
    assert.deepEqual(listed.orphanSnapshots, ['1999-01-01T00-00-00-000Z'])
    // The catalog itself must stay authoritative: the orphan is reported, not adopted.
    assert.equal(listed.snapshots.length, 1)
  } finally {
    await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
  }
})
