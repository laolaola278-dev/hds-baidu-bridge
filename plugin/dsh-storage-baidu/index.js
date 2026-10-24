import path from 'node:path'
import fsp from 'node:fs/promises'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { BaiduNetdiskClient } from '../../src/baidu-api.mjs'
import { normalizeRemotePath, remoteJoin, resolveLocalPathChecked } from '../../src/paths.mjs'
import { writeFileAtomic } from '../../src/log.mjs'
import { HdsBaiduError } from '../../src/errors.mjs'

/**
 * Cordis plugin name.
 */
export const name = 'storage-baidu'

/**
 * The storage hub is mandatory; the plugin registers a backend on it.
 */
export const inject = ['storage']

/**
 * Plugin configuration. No path has a C: default.
 *
 * @typedef {{
 *   remoteRoot: string,
 *   cacheRoot: string,
 *   accessTokenEnv?: string,
 *   requestTimeoutMs?: number,
 *   offlinePolicy?: 'reject'|'cache',
 *   allowedDrives?: string[]
 * }} Config
 */

/**
 * Plugin config validation. Cordis resolves `Config` only when it exposes the
 * Standard Schema `~standard` interface; this plain descriptor is documentation
 * and is validated defensively in `apply`, so the plugin does not accidentally
 * claim a schema it cannot enforce.
 */
export const Config = {
  type: 'object',
  description: 'Baidu Netdisk storage backend configuration',
  properties: {
    remoteRoot: { type: 'string', default: '/HDS/dsh' },
    cacheRoot: { type: 'string' },
    accessTokenEnv: { type: 'string', default: 'BAIDU_NETDISK_ACCESS_TOKEN' },
    requestTimeoutMs: { type: 'number', default: 120000 },
    offlinePolicy: { type: 'string', enum: ['reject', 'cache'], default: 'reject' },
    allowedDrives: { type: 'array', items: { type: 'string' }, default: ['G'] },
  },
  required: ['cacheRoot'],
}

function validateDescriptor(descriptor) {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}

/**
 * Parse the on-disk unit document. The format matches DSH's JSON backend so a
 * unit can be moved between backends without translation.
 * @param {string} text
 * @param {any} descriptor
 */
function parseUnitDocument(text, descriptor) {
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': remote file is not valid JSON`, { cause: error })
  }
  if (typeof document !== 'object' || document === null) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': remote file is not a JSON object`)
  }
  const { unit, global: globalValue, tables } = document
  if (typeof unit !== 'object' || unit === null || unit.name !== descriptor.name || typeof unit.version !== 'number') {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': missing or foreign unit header`)
  }
  if (unit.version !== descriptor.version) {
    throw new StorageError('version-mismatch', `unit '${descriptor.name}': stored version ${unit.version} != expected ${descriptor.version}`)
  }
  if (typeof tables !== 'object' || tables === null) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': tables is not an object`)
  }
  const state = {
    version: descriptor.version,
    global: globalValue ?? null,
    tables: new Map(),
  }
  for (const table of descriptor.tables) {
    const records = tables[table]
    if (records === undefined) {
      state.tables.set(table, new Map())
      continue
    }
    if (typeof records !== 'object' || records === null || Array.isArray(records)) {
      throw new StorageError('malformed-medium', `unit '${descriptor.name}': table '${table}' is not an object`)
    }
    state.tables.set(table, new Map(Object.entries(records)))
  }
  return state
}

function serializeUnitDocument(descriptor, state) {
  const tables = {}
  for (const [table, records] of state.tables) tables[table] = Object.fromEntries(records)
  return `${JSON.stringify({
    unit: { name: descriptor.name, version: descriptor.version },
    global: state.global,
    tables,
  }, null, 2)}\n`
}

/**
 * One open unit backed by a local cache and the Baidu remote object.
 *
 * Write protocol:
 *  1. serialize the complete candidate state;
 *  2. upload it atomically to a temporary remote object;
 *  3. move it over the final remote path (remote durability point);
 *  4. update the memory state and the local cache.
 *
 * A failed remote write leaves memory and cache untouched. This is stricter
 * than a local-only backend and is the reason `offlinePolicy: reject` is the
 * default.
 */
class BaiduKvUnit {
  constructor(backend, descriptor, cachePath, remotePath, initialState, remoteAvailable) {
    this.backend = backend
    this.descriptor = descriptor
    this.cachePath = cachePath
    this.remotePath = remotePath
    this.state = initialState
    this.remoteAvailable = remoteAvailable
    this.closed = false
    this.writeChain = Promise.resolve()
  }

  assertOpen() {
    if (this.closed) throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
  }

  records(table) {
    const records = this.state.tables.get(table)
    if (!records) throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    return records
  }

  async loadAll() {
    this.assertOpen()
    const tables = {}
    for (const [table, records] of this.state.tables) tables[table] = Object.fromEntries(records)
    return { tables, global: this.state.global }
  }

  async putRecord(table, key, value) {
    this.assertOpen()
    const records = this.records(table)
    const hadKey = records.has(key)
    const previous = records.get(key)
    records.set(key, value)
    try {
      await this.persist()
    } catch (error) {
      if (hadKey) records.set(key, previous)
      else records.delete(key)
      throw error
    }
  }

  async deleteRecord(table, key) {
    this.assertOpen()
    const records = this.records(table)
    if (!records.has(key)) return
    const previous = records.get(key)
    records.delete(key)
    try {
      await this.persist()
    } catch (error) {
      records.set(key, previous)
      throw error
    }
  }

  async setGlobal(value) {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    const previous = this.state.global
    this.state.global = value
    try {
      await this.persist()
    } catch (error) {
      this.state.global = previous
      throw error
    }
  }

  persist() {
    const operation = this.writeChain.then(async () => {
      this.assertOpen()
      const text = serializeUnitDocument(this.descriptor, this.state)
      const staging = `${this.cachePath}.${process.pid}.${Date.now()}.staging`
      await writeFileAtomic(staging, text)
      try {
        await this.backend.client.uploadAtomic(staging, this.remotePath)
      } catch (error) {
        if (this.backend.offlinePolicy !== 'cache') throw error
        this.backend.logger?.warn('remote storage write failed; cache fallback retained', { unit: this.descriptor.name, error: error.message })
      }
      await writeFileAtomic(this.cachePath, text)
      await fsp.rm(staging, { force: true })
      this.remoteAvailable = this.backend.offlinePolicy === 'cache' ? this.remoteAvailable : true
    })
    this.writeChain = operation.catch(() => {})
    return operation
  }

  async close() {
    if (this.closed) {
      await Promise.allSettled([this.writeChain])
      return
    }
    this.closed = true
    await Promise.allSettled([this.writeChain])
    this.backend.open.delete(this.descriptor.name)
  }
}

/**
 * DSH storage backend that uses Baidu Netdisk as the durable medium.
 */
export class BaiduStorageBackend {
  /**
   * @param {{
   *   client: any,
   *   cacheRoot: string,
   *   remoteRoot: string,
   *   offlinePolicy: 'reject'|'cache',
   *   pathPolicy: {root: string, allowedDrives: Iterable<string>},
   *   logger?: any
   * }} options
   */
  constructor(options) {
    this.client = options.client
    this.cacheRoot = options.cacheRoot
    this.remoteRoot = normalizeRemotePath(options.remoteRoot)
    this.offlinePolicy = options.offlinePolicy
    this.pathPolicy = options.pathPolicy
    this.logger = options.logger
    this.open = new Map()
    this.opening = new Map()
    this.closed = false
  }

  kv = {
    open: async descriptor => {
      if (this.closed) throw new StorageError('closed', 'baidu storage backend is closed')
      validateDescriptor(descriptor)
      if (this.open.has(descriptor.name) || this.opening.has(descriptor.name)) {
        throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
      }
      const operation = this.openUnit(descriptor)
      this.opening.set(descriptor.name, operation)
      try {
        return await operation
      } finally {
        this.opening.delete(descriptor.name)
      }
    },
  }

  async openUnit(descriptor) {
    await fsp.mkdir(this.cacheRoot, { recursive: true, mode: 0o700 })
    await resolveLocalPathChecked(this.cacheRoot, this.pathPolicy)
    const cachePath = path.join(this.cacheRoot, `${descriptor.name}.json`)
    const remotePath = remoteJoin(this.remoteRoot, 'units', `${descriptor.name}.json`)
    let remoteAvailable = true
    let initialState
    let remoteText
    try {
      const stat = await this.client.stat(remotePath)
      if (stat) {
        const staging = `${cachePath}.${process.pid}.${Date.now()}.remote`
        await this.client.download(remotePath, staging, { resume: false, expectedMd5: stat.md5 })
        remoteText = await fsp.readFile(staging, 'utf8')
        await fsp.rm(staging, { force: true })
        initialState = parseUnitDocument(remoteText, descriptor)
      }
    } catch (error) {
      remoteAvailable = false
      if (this.offlinePolicy !== 'cache') throw error
      this.logger?.warn('remote unit unavailable; using local cache', { unit: descriptor.name, error: error.message })
    }
    if (!initialState) {
      try {
        const cached = await fsp.readFile(cachePath, 'utf8')
        initialState = parseUnitDocument(cached, descriptor)
      } catch (error) {
        if (error instanceof StorageError) throw error
        if (error?.code !== 'ENOENT') throw error
        initialState = {
          version: descriptor.version,
          global: null,
          tables: new Map(descriptor.tables.map(table => [table, new Map()])),
        }
      }
    }
    if (remoteText !== undefined) {
      await writeFileAtomic(cachePath, remoteText)
    }
    if (this.closed) throw new StorageError('closed', 'baidu storage backend is closed')
    const unit = new BaiduKvUnit(this, descriptor, cachePath, remotePath, initialState, remoteAvailable)
    this.open.set(descriptor.name, unit)
    return unit
  }

  async close() {
    this.closed = true
    await Promise.allSettled([...this.opening.values()])
    await Promise.all([...this.open.values()].map(unit => unit.close()))
  }
}

/**
 * Register the `baidu` backend on the storage hub.
 *
 * @param {any} ctx Cordis context.
 * @param {Config} config Validated plugin config.
 */
export function apply(ctx, config) {
  const tokenEnv = config.accessTokenEnv ?? 'BAIDU_NETDISK_ACCESS_TOKEN'
  const token = process.env[tokenEnv]
  if (!token) {
    throw new HdsBaiduError('token-missing', `${tokenEnv} is required by the storage-baidu backend`)
  }
  if (!config.cacheRoot) throw new HdsBaiduError('config-invalid', 'storage-baidu requires cacheRoot')
  if (!config.allowedDrives || config.allowedDrives.includes('C')) {
    throw new HdsBaiduError('config-invalid', 'storage-baidu allowedDrives must be explicit and must not include C')
  }
  const logger = ctx.logger?.('storage-baidu')
  const backend = new BaiduStorageBackend({
    client: new BaiduNetdiskClient({
      accessToken: token,
      timeoutMs: config.requestTimeoutMs ?? 120000,
      onProgress: event => logger?.debug?.('transfer', event),
    }),
    cacheRoot: config.cacheRoot,
    remoteRoot: config.remoteRoot ?? '/HDS/dsh',
    offlinePolicy: config.offlinePolicy ?? 'reject',
    pathPolicy: { root: config.cacheRoot, allowedDrives: config.allowedDrives },
    logger,
  })
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('baidu', backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey('baidu'), backend)
}
