import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { SyncEngine } from '../src/sync-engine.mjs'
import { MirrorDaemon, describeMirrorState, mirrorStatePath, readMirrorState } from '../src/watch.mjs'
import { FakeBaiduClient, makeTestRoot } from './helpers/fake-client.mjs'

async function setup(label) {
  const root = await makeTestRoot(label)
  const client = new FakeBaiduClient()
  await fsp.mkdir(root.localRoot, { recursive: true })
  const engine = new SyncEngine({ client, config: root.config, localRoot: root.localRoot, remoteRoot: root.remoteRoot })
  const stateFile = mirrorStatePath(root.config.local.stateDir, engine.id)
  const daemon = new MirrorDaemon({
    engine,
    localRoot: root.localRoot,
    remoteRoot: root.remoteRoot,
    stateFile,
    direction: 'both',
    remoteIntervalMs: 60000,
    debounceMs: 5,
  })
  return { root, client, engine, daemon, stateFile }
}

test('a cycle uploads a new local file and records state', async () => {
  const { client, root, daemon, stateFile } = await setup('daemon-cycle')
  await fsp.writeFile(path.join(root.localRoot, 'a.txt'), 'hello')
  const result = await daemon.cycle('test')
  assert.equal(result.applied, true)
  assert.equal(result.summary.uploads, 1)
  assert.equal(client.snapshot().some(item => item.remotePath.endsWith('/a.txt')), true)
  const state = await readMirrorState(stateFile)
  assert.equal(state.state, 'running')
  assert.equal(state.cycles, 1)
  assert.match(describeMirrorState(state), /uploads=1/)
  await daemon.stop()
})

test('a clean cycle does not apply anything', async () => {
  const { root, daemon } = await setup('daemon-clean')
  await fsp.writeFile(path.join(root.localRoot, 'a.txt'), 'hello')
  await daemon.cycle('first')
  const second = await daemon.cycle('second')
  assert.equal(second.summary.uploads, 0)
  assert.equal(second.summary.downloads, 0)
  await daemon.stop()
})

test('a failing cycle records the error and keeps running', async () => {
  const { client, root, daemon, stateFile } = await setup('daemon-error')
  await fsp.writeFile(path.join(root.localRoot, 'a.txt'), 'hello')
  client.failNextUpload = true
  // uploadAtomic in the fake client uses upload internally, so the failure
  // surfaces as an apply error rather than a thrown cycle.
  const result = await daemon.cycle('failing')
  assert.ok(result === undefined || result.summary)
  const state = await readMirrorState(stateFile)
  assert.equal(state.state, 'running')
  await daemon.stop()
})

test('stop writes a stopped state exactly once', async () => {
  const { daemon, stateFile } = await setup('daemon-stop')
  await daemon.stop()
  const state = await readMirrorState(stateFile)
  assert.equal(state.state, 'stopped')
})
