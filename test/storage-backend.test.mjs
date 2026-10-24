import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { FakeBaiduClient, makeTestRoot } from './helpers/fake-client.mjs'

/**
 * The storage backend plugin imports `@deepseek-ai/dsh-storage` for the real
 * `StorageError`, `UNIT_NAME_RE` and `storageBackendServiceKey` so it cannot
 * drift from the host contract. That package ships with DeepSeek-Harness, not
 * with this project, so a checkout without DSH installed cannot load the
 * plugin at all — skip instead of crashing the run.
 */
let BaiduStorageBackend
let loadError
try {
  ;({ BaiduStorageBackend } = await import('../plugin/dsh-storage-baidu/index.js'))
} catch (error) {
  loadError = error
}
const needsHost = {
  skip: BaiduStorageBackend ? false : `@deepseek-ai/dsh-storage not available (${loadError?.code ?? loadError?.message})`,
}

async function backend(label, options = {}) {
  const root = await makeTestRoot(label)
  const client = new FakeBaiduClient()
  const instance = new BaiduStorageBackend({
    client,
    cacheRoot: root.cacheRoot,
    remoteRoot: `${root.remoteRoot}/dsh`,
    offlinePolicy: options.offlinePolicy ?? 'reject',
    pathPolicy: { root: root.root, allowedDrives: ['G'] },
  })
  return { root, client, backend: instance }
}

const descriptor = {
  name: 'workspace',
  version: 2,
  tables: ['workspaces'],
  hasGlobal: true,
}

test('storage backend creates an empty unit and writes remote state', needsHost, async () => {
  const { client, backend: instance } = await backend('storage-write')
  const unit = await instance.kv.open(descriptor)
  await unit.putRecord('workspaces', 'w1', { path: 'G:\\work', title: 'work' })
  await unit.setGlobal({ initialized: true })
  const remote = client.snapshot()
  assert.equal(remote.some(item => item.remotePath.endsWith('/units/workspace.json')), true)
  await unit.close()
  await instance.close()
})

test('storage backend reloads records from the remote copy', needsHost, async () => {
  const { backend: first } = await backend('storage-reload')
  const unit = await first.kv.open(descriptor)
  await unit.putRecord('workspaces', 'w1', { path: 'G:\\work' })
  await unit.close()
  await first.close()

  const state = await first.client.download
  const { backend: second } = await backend('storage-reload')
  // Reuse the same fake client and cache to model a process restart.
  second.client = first.client
  second.cacheRoot = first.cacheRoot
  const reopened = await second.kv.open(descriptor)
  const all = await reopened.loadAll()
  assert.deepEqual(all.tables.workspaces.w1, { path: 'G:\\work' })
  await reopened.close()
  await second.close()
})

test('failed remote write does not mutate in-memory state', needsHost, async () => {
  const { client, backend: instance } = await backend('storage-rollback')
  const unit = await instance.kv.open(descriptor)
  client.failNextUpload = true
  await assert.rejects(unit.putRecord('workspaces', 'w1', { path: 'G:\\work' }), /simulated upload failure/)
  const all = await unit.loadAll()
  assert.equal(all.tables.workspaces.w1, undefined)
  await unit.close()
  await instance.close()
})

test('offline cache policy opens from the local cache', needsHost, async () => {
  const { client, backend: instance } = await backend('storage-cache', { offlinePolicy: 'cache' })
  const unit = await instance.kv.open(descriptor)
  await unit.putRecord('workspaces', 'w1', { path: 'G:\\work' })
  await unit.close()
  client.files.clear()
  const reopened = await instance.kv.open(descriptor)
  const all = await reopened.loadAll()
  assert.deepEqual(all.tables.workspaces.w1, { path: 'G:\\work' })
  await reopened.close()
  await instance.close()
})
