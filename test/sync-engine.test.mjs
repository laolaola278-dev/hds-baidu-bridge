import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { SyncEngine } from '../src/sync-engine.mjs'
import { FakeBaiduClient, makeTestRoot } from './helpers/fake-client.mjs'

async function setup(label) {
  const root = await makeTestRoot(label)
  const client = new FakeBaiduClient()
  await fsp.mkdir(root.localRoot, { recursive: true })
  const engine = new SyncEngine({
    client,
    config: root.config,
    localRoot: root.localRoot,
    remoteRoot: root.remoteRoot,
  })
  return { root, client, engine }
}

test('push uploads new and changed files and records a baseline', async () => {
  const { client, engine, root } = await setup('push')
  await fsp.writeFile(path.join(root.localRoot, 'a.txt'), 'one')
  await fsp.mkdir(path.join(root.localRoot, 'src'))
  await fsp.writeFile(path.join(root.localRoot, 'src', 'b.txt'), 'two')

  let plan = await engine.plan({ direction: 'push' })
  assert.equal(plan.summary.uploads, 2)
  let result = await engine.apply(plan)
  assert.equal(result.ok, true)
  assert.equal(result.counts.uploaded, 2)

  await fsp.writeFile(path.join(root.localRoot, 'a.txt'), 'one changed')
  plan = await engine.plan({ direction: 'push' })
  assert.equal(plan.summary.uploads, 1)
  assert.equal(plan.actions.find(action => action.relative === 'a.txt').reason, 'local-changed')
  const remoteBefore = client.snapshot().find(item => item.remotePath.endsWith('/a.txt'))
  result = await engine.apply(plan)
  assert.equal(result.counts.uploaded, 1)
  const remoteAfter = client.snapshot().find(item => item.remotePath.endsWith('/a.txt'))
  assert.notEqual(remoteAfter.md5, remoteBefore.md5)
})

test('pull refuses to overwrite a local file changed on both sides', async () => {
  const { client, engine, root } = await setup('conflict')
  await fsp.writeFile(path.join(root.localRoot, 'a.txt'), 'base')
  let plan = await engine.plan({ direction: 'push' })
  await engine.apply(plan)

  await fsp.writeFile(path.join(root.localRoot, 'a.txt'), 'local change')
  await client.uploadAtomic(path.join(root.localRoot, 'a.txt'), `${root.remoteRoot}/a.txt`)
  await fsp.writeFile(path.join(root.localRoot, 'a.txt'), 'local second change')

  plan = await engine.plan({ direction: 'pull' })
  assert.equal(plan.summary.conflicts, 1)
  const result = await engine.apply(plan)
  assert.equal(result.counts.conflicts, 1)
  assert.equal(await fsp.readFile(path.join(root.localRoot, 'a.txt'), 'utf8'), 'local second change')
})

test('pull downloads a remote-only file into the local mirror', async () => {
  const { client, engine, root } = await setup('pull')
  const remoteSource = path.join(root.root, 'seed.txt')
  await fsp.writeFile(remoteSource, 'remote content')
  await client.uploadAtomic(remoteSource, `${root.remoteRoot}/docs/seed.txt`)

  const plan = await engine.plan({ direction: 'pull' })
  assert.equal(plan.summary.downloads, 1)
  const result = await engine.apply(plan)
  assert.equal(result.counts.downloaded, 1)
  assert.equal(await fsp.readFile(path.join(root.localRoot, 'docs', 'seed.txt'), 'utf8'), 'remote content')
})

test('local deletion does not delete the remote copy', async () => {
  const { client, engine, root } = await setup('local-delete')
  await fsp.writeFile(path.join(root.localRoot, 'keep.txt'), 'keep')
  await engine.apply(await engine.plan({ direction: 'push' }))
  await fsp.rm(path.join(root.localRoot, 'keep.txt'))
  const plan = await engine.plan({ direction: 'both' })
  assert.equal(plan.summary.uploads, 0)
  assert.equal(plan.actions.some(action => action.reason === 'local-deleted-remote-kept'), true)
  const result = await engine.apply(plan)
  assert.equal(result.counts.downloads ?? 0, 0)
  assert.equal(client.snapshot().some(item => item.remotePath.endsWith('/keep.txt')), true)
})

test('a first push into a remote directory that does not exist yet succeeds', async () => {
  const { client, engine, root } = await setup('first-push-missing-remote')
  await fsp.writeFile(path.join(root.localRoot, 'only.txt'), 'first ever file')
  // No remote directory has been created: this is the state every new user
  // starts in, and it must not fail with file_list/file does not exist.
  const plan = await engine.plan({ direction: 'push' })
  assert.equal(plan.summary.uploads, 1)
  const result = await engine.apply(plan)
  assert.equal(result.ok, true)
  assert.equal(client.snapshot().length, 1)
})

test('a remote listing failure with a non-not-found errno still aborts the plan', async () => {
  const { client, engine, root } = await setup('list-failure')
  await fsp.writeFile(path.join(root.localRoot, 'a.txt'), 'x')
  client.listAll = async () => {
    const error = new Error('access token invalid')
    error.code = 'baidu-api'
    error.errno = -6
    error.method = 'file_list'
    throw error
  }
  await assert.rejects(engine.plan({ direction: 'push' }), /access token invalid/)
})
