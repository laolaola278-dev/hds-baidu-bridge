import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { FakeBaiduClient, makeTestRoot, TEST_BASE } from './helpers/fake-client.mjs'

/**
 * Contract test against the REAL DSH packages.
 *
 * `storage-backend.test.mjs` exercises this plugin against an in-repo memory
 * double. That proves the plugin is self-consistent, but not that it satisfies
 * DSH's actual `KvFacet`/`KvUnit` contact surface. This file imports the
 * installed `@deepseek-ai/cordis`, `@deepseek-ai/dsh-storage` and
 * `@deepseek-ai/dsh-storage-domain`, so the service registration path, the
 * domain layer's `open()` sequence and its snapshot shape are the real ones.
 *
 * The packages live in the DSH profile and are reached through junctioned
 * `node_modules` entries on the approved drive. When they are absent (a plain
 * checkout with no local DSH install) the suite skips instead of failing: the
 * plugin still has to build, it just cannot be proven against a host here.
 *
 * The plugin import is deliberately dynamic. A static
 * `import { BaiduStorageBackend } from '../plugin/...'` resolves before any skip
 * can apply, so a bare checkout died with ERR_MODULE_NOT_FOUND instead of
 * skipping — the header promise above was not kept.
 */
let BaiduStorageBackend
let pluginLoadError
try {
  ;({ BaiduStorageBackend } = await import('../plugin/dsh-storage-baidu/index.js'))
} catch (error) {
  pluginLoadError = error
}
const PROFILE_MODULES = 'G:\\.dsh\\profiles\\node_modules'
const DSH_STORAGE_LIB = 'G:\\project\\deepseek-harness\\deepseek-harness-master\\apps\\cli\\node_modules\\@deepseek-ai\\dsh-web-app\\node_modules\\@deepseek-ai\\dsh-storage\\lib\\index.js'
const DSH_DOMAIN_LIB = 'G:\\project\\deepseek-harness\\deepseek-harness-master\\apps\\cli\\node_modules\\@deepseek-ai\\dsh-web-app\\node_modules\\@deepseek-ai\\dsh-storage-domain\\lib\\index.js'

async function loadRealPackages() {
  const cordisEntry = path.join(PROFILE_MODULES, '@deepseek-ai', 'cordis', 'lib', 'index.js')
  for (const file of [cordisEntry, DSH_STORAGE_LIB, DSH_DOMAIN_LIB]) {
    const present = await fsp.stat(file).then(stat => stat.isFile(), () => false)
    if (!present) return undefined
  }
  return {
    cordis: await import(pathToFileURL(cordisEntry).href),
    storage: await import(pathToFileURL(DSH_STORAGE_LIB).href),
    domain: await import(pathToFileURL(DSH_DOMAIN_LIB).href),
  }
}

const real = await loadRealPackages()
const skip = !BaiduStorageBackend
  ? `plugin cannot load without @deepseek-ai/dsh-storage (${pluginLoadError?.code ?? pluginLoadError?.message})`
  : (real ? false : 'DSH packages are not installed on this machine')

/**
 * Minimal schema stand-in for the domain layer.
 *
 * `defineDomain` only calls `safeParse(null).success` (to reject a global
 * schema that would swallow the "never written" sentinel) and `parse(value)`
 * when projecting stored records. A full zod install is not a dependency of
 * this project, so the stand-in implements exactly that surface.
 */
function schema(validate) {
  const parse = value => {
    if (!validate(value)) throw new Error(`schema rejected ${JSON.stringify(value)}`)
    return value
  }
  return {
    parse,
    safeParse(value) {
      try {
        return { success: true, data: parse(value) }
      } catch (error) {
        return { success: false, error }
      }
    },
  }
}

const isRecordWith = key => value =>
  Boolean(value) && typeof value === 'object' && typeof value[key] === 'string'

function spec(name, version, tableName) {
  return real.domain.defineDomain({
    name,
    version,
    tables: { [tableName]: { valueSchema: schema(isRecordWith('id')) } },
  })
}

async function makeBackend(label) {
  const workspace = await makeTestRoot(label)
  const root = workspace.root
  const client = new FakeBaiduClient()
  const remoteRoot = `${workspace.remoteRoot}/dsh`
  const backend = new BaiduStorageBackend({
    client,
    cacheRoot: workspace.cacheRoot,
    remoteRoot,
    offlinePolicy: 'reject',
    pathPolicy: { root, allowedDrives: ['G'] },
  })
  return { root, workspace, client, backend, remoteRoot }
}

/**
 * Boot a real Cordis host: a root Context, the real Storage service, this
 * project's backend registered through `ctx.effect` exactly as DSH does it, and
 * the real domain facility mounted on the hub.
 */
async function bootHost(backend) {
  const ctx = new real.cordis.Context()
  const storage = new real.storage.Storage(ctx)
  // Cordis publishes a service asynchronously; the hub is unreadable until the
  // fiber that provides it has started.
  await new Promise(resolve => setTimeout(resolve, 10))

  const unregister = storage.backend.register('baidu', backend)

  let facility
  ctx.effect(() => {
    facility = new real.domain.DomainFacility(ctx, { backend: 'baidu', routes: {} })
    const unmount = storage.mount('domain', facility)
    return async () => {
      await facility.closeAll()
      unmount()
    }
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  return {
    ctx,
    storage,
    facility,
    async dispose() {
      await facility?.closeAll?.()
      unregister()
      await backend.close()
    },
  }
}

async function readRemoteText(client, remotePath, staging) {
  const stat = await client.stat(remotePath)
  if (!stat) throw new Error(`remote object not found: ${remotePath}`)
  await client.download(remotePath, staging, { resume: false, expectedMd5: stat.md5 })
  return fsp.readFile(staging, 'utf8')
}

test('the plugin registers on the real storage hub and unregisters cleanly', { skip }, async () => {
  const { root, backend } = await makeBackend('contract-register')
  const host = await bootHost(backend)
  try {
    assert.deepEqual(host.storage.backend.names(), ['baidu'], 'registration must be visible on the real hub')
    assert.equal(host.storage.backend.get('baidu'), backend, 'the hub must hand back this exact instance')
    assert.ok(host.storage.domain, 'the domain form must be mounted')
  } finally {
    await host.dispose()
    assert.deepEqual(host.storage.backend.names(), [], 'disposing must unregister the backend')
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('a real storage domain opens over the baidu backend and reads its own writes', { skip }, async () => {
  const { root, backend } = await makeBackend('contract-domain')
  const host = await bootHost(backend)
  try {
    const opened = await host.facility.open(spec('workspace', 2, 'workspaces'))
    const table = opened.table('workspaces')
    await table.put('ws-1', { id: 'ws-1', path: 'G:\\project\\demo' })
    assert.deepEqual(table.get('ws-1'), { id: 'ws-1', path: 'G:\\project\\demo' })
    assert.equal(table.size, 1)

    await table.delete('ws-1')
    assert.equal(table.get('ws-1'), undefined)

    await opened.close()
  } finally {
    await host.dispose()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('domain writes land as a remote unit document on the approved drive', { skip }, async () => {
  const { root, client, backend, remoteRoot } = await makeBackend('contract-persist')
  const host = await bootHost(backend)
  const staging = path.join(root, 'readback.json')
  try {
    const opened = await host.facility.open(spec('workspace', 2, 'workspaces'))
    await opened.table('workspaces').put('ws-1', { id: 'ws-1', path: 'G:\\project\\demo' })

    const text = await readRemoteText(client, `${remoteRoot}/units/workspace.json`, staging)
    const stored = JSON.parse(text)
    // The remote document uses DSH's own JSON unit format verbatim, so a unit
    // can move between the json and baidu backends with no translation.
    assert.deepEqual(stored.unit, { name: 'workspace', version: 2 })
    assert.equal(stored.tables.workspaces['ws-1'].path, 'G:\\project\\demo')
    await opened.close()
  } finally {
    await host.dispose()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('the remote document reloads into a fresh backend instance', { skip }, async () => {
  const { root, workspace, client, backend, remoteRoot } = await makeBackend('contract-reload')
  const first = await bootHost(backend)
  try {
    const opened = await first.facility.open(spec('settings', 1, 'entries'))
    await opened.table('entries').put('theme', { id: 'theme', value: 'dark' })
    await opened.close()
  } finally {
    await first.dispose()
  }

  const second = new BaiduStorageBackend({
    client,
    cacheRoot: workspace.cacheRoot,
    remoteRoot,
    offlinePolicy: 'reject',
    pathPolicy: { root, allowedDrives: ['G'] },
  })
  const host = await bootHost(second)
  try {
    // No local cache left behind: the reload must come from the remote bytes.
    await fsp.rm(path.join(workspace.cacheRoot, 'settings.json'), { force: true })
    const opened = await host.facility.open(spec('settings', 1, 'entries'))
    assert.deepEqual(opened.table('entries').get('theme'), { id: 'theme', value: 'dark' })
    await opened.close()
  } finally {
    await host.dispose()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('a rejected remote write leaves the domain readable and unchanged', { skip }, async () => {
  const { root, client, backend } = await makeBackend('contract-reject')
  const host = await bootHost(backend)
  try {
    const opened = await host.facility.open(spec('workspace', 2, 'workspaces'))
    const table = opened.table('workspaces')
    await table.put('ws-1', { id: 'ws-1', path: 'G:\\project\\demo' })
    client.failNextUpload = true
    await assert.rejects(table.put('ws-2', { id: 'ws-2', path: 'G:\\project\\other' }), /simulated upload failure/)
    assert.equal(table.get('ws-2'), undefined, 'a failed write must not appear in memory')
    assert.deepEqual(table.get('ws-1'), { id: 'ws-1', path: 'G:\\project\\demo' })
    await opened.close()
  } finally {
    await host.dispose()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('a version mismatch from the remote medium surfaces as a StorageError', { skip }, async () => {
  const { root, workspace, client, backend, remoteRoot } = await makeBackend('contract-version')
  const fixture = await writeFixture(workspace.root, 'unit-v99.json', JSON.stringify({
    unit: { name: 'workspace', version: 99 },
    global: null,
    tables: { workspaces: {} },
  }))
  await client.uploadAtomic(fixture, `${remoteRoot}/units/workspace.json`)
  const host = await bootHost(backend)
  try {
    await assert.rejects(
      host.facility.open(spec('workspace', 2, 'workspaces')),
      error => error?.code === 'version-mismatch',
    )
  } finally {
    await host.dispose()
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

async function writeFixture(root, name, text) {
  const file = path.join(root, name)
  await fsp.writeFile(file, text)
  return file
}
