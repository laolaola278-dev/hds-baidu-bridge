import path from 'node:path'
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { SyncManifest } from './sync-manifest.mjs'
import { walkLocal, md5WithBaseline, ensureRealDirectory, publishFile, syncId } from './local-tree.mjs'
import { normalizeRemotePath, remoteJoin, resolveLocalPathChecked, assertInside } from './paths.mjs'
import { createExcludeMatcher } from './exclude.mjs'
import { HdsBaiduError, BaiduApiError } from './errors.mjs'
import { NOT_FOUND_ERRNOS } from './baidu-api.mjs'

/**
 * Map a relative path to a POSIX remote path.
 * @param {string} remoteRoot
 * @param {string} relative
 */
function remoteFor(remoteRoot, relative) {
  return remoteJoin(remoteRoot, relative)
}

/**
 * Remove excluded paths from a remote entry list.
 * @param {Array<any>} entries
 * @param {(relative: string, isDirectory?: boolean) => boolean} excluded
 * @param {string} remoteRoot
 */
function indexRemote(entries, excluded, remoteRoot) {
  const root = normalizeRemotePath(remoteRoot)
  const prefix = root === '/' ? '/' : `${root}/`
  const files = new Map()
  const directories = new Set()
  for (const entry of entries) {
    const entryPath = String(entry.path ?? '')
    if (!entryPath.startsWith(prefix)) continue
    const relative = entryPath.slice(prefix.length)
    if (!relative) continue
    const isDirectory = Number(entry.isdir) === 1
    if (excluded(relative, isDirectory)) continue
    if (isDirectory) {
      directories.add(relative)
      continue
    }
    files.set(relative, {
      relative,
      remotePath: entryPath,
      size: Number(entry.size ?? 0),
      md5: entry.md5 ? String(entry.md5).toLowerCase() : undefined,
      fsid: entry.fs_id ?? entry.fsid,
      mtime: Number(entry.server_mtime ?? entry.mtime ?? 0),
    })
  }
  return { files, directories }
}

/**
 * Compare local and remote trees against a stored baseline.
 *
 * The engine is deliberately split into plan and apply so callers can review
 * every upload, download and conflict before touching either side.
 */
export class SyncEngine {
  /**
   * @param {{
   *   client: any,
   *   config: any,
   *   localRoot: string,
   *   remoteRoot: string,
   *   logger?: any
   * }} options
   */
  constructor(options) {
    this.client = options.client
    this.config = options.config
    this.localRoot = options.localRoot
    this.remoteRoot = normalizeRemotePath(options.remoteRoot)
    this.logger = options.logger
    this.id = syncId(this.localRoot, this.remoteRoot)
    this.exclude = createExcludeMatcher(this.config.sync.exclude)
  }

  async openManifest() {
    const file = SyncManifest.pathFor(this.config.local.stateDir, this.id)
    return SyncManifest.load(file, {
      id: this.id,
      localRoot: this.localRoot,
      remoteRoot: this.remoteRoot,
    })
  }

  /**
   * List the remote tree, treating "the directory does not exist yet" as empty.
   *
   * A first-time push targets a remote directory that nobody has created, so
   * the very first plan would otherwise die with `file_list: file does not
   * exist` — exactly the state every new user starts in. Only the not-found
   * errnos are absorbed; permission and network failures still surface.
   * @returns {Promise<any[]>}
   */
  async listRemote() {
    try {
      return await this.client.listAll(this.remoteRoot)
    } catch (error) {
      const notFound = error instanceof BaiduApiError && NOT_FOUND_ERRNOS.includes(error.errno)
      if (!notFound) throw error
      this.logger?.info('remote root does not exist yet; treating it as empty', { remoteRoot: this.remoteRoot })
      return []
    }
  }

  /**
   * Build a complete plan without modifying local or remote state.
   * @param {{direction?: 'push'|'pull'|'both', computeHashes?: boolean}} [options]
   */
  async plan(options = {}) {
    const direction = options.direction ?? 'both'
    await ensureRealDirectory(this.localRoot)
    const manifest = await this.openManifest()
    const localFiles = await walkLocal(this.localRoot, {
      exclude: this.config.sync.exclude,
      maxFileBytes: this.config.backup.maxFileBytes,
      signal: options.signal,
    })
    const local = new Map()
    for (const file of localFiles) {
      const baseline = manifest.get(file.relative)
      file.md5 = options.computeHashes === false && baseline?.localMd5
        ? baseline.localMd5
        : await md5WithBaseline(file, baseline)
      local.set(file.relative, file)
    }
    const remoteEntries = await this.listRemote()
    const remote = indexRemote(remoteEntries, this.exclude, this.remoteRoot).files
    const relatives = new Set([...local.keys(), ...remote.keys(), ...Object.keys(manifest.files)])
    const actions = []
    const conflicts = []
    for (const relative of [...relatives].sort()) {
      const localFile = local.get(relative)
      const remoteFile = remote.get(relative)
      const baseline = manifest.get(relative)
      const localMd5 = localFile?.md5
      const remoteMd5 = remoteFile?.md5
      const same = localFile && remoteFile && localMd5 && remoteMd5 && localMd5 === remoteMd5
      if (same) {
        if (!baseline || baseline.localMd5 !== localMd5 || baseline.remoteMd5 !== remoteMd5) {
          actions.push({ type: 'record', relative, local: localFile, remote: remoteFile })
        }
        continue
      }
      if (direction === 'push' || direction === 'both') {
        if (localFile && !remoteFile) {
          actions.push({ type: 'upload', relative, local: localFile, reason: baseline ? 'remote-missing' : 'new' })
          continue
        }
        if (localFile && remoteFile) {
          const localUnchanged = baseline?.localMd5 && baseline.localMd5 === localMd5
          const remoteUnchanged = baseline?.remoteMd5 && baseline.remoteMd5 === remoteMd5
          if (localUnchanged && !remoteUnchanged) {
            if (direction === 'both') {
              actions.push({ type: 'download', relative, remote: remoteFile, reason: 'remote-changed' })
            } else {
              actions.push({ type: 'skip', relative, reason: 'remote-changed-pull-required' })
            }
            continue
          }
          if (remoteUnchanged) {
            actions.push({ type: 'upload', relative, local: localFile, reason: 'local-changed' })
            continue
          }
          conflicts.push({ relative, reason: 'both-changed', localMd5, remoteMd5, baselineLocalMd5: baseline?.localMd5, baselineRemoteMd5: baseline?.remoteMd5 })
          actions.push({ type: 'conflict', relative, reason: 'both-changed' })
          continue
        }
        if (!localFile && remoteFile) {
          if (baseline) actions.push({ type: 'skip', relative, reason: 'local-deleted-remote-kept' })
          continue
        }
      }
      if (direction === 'pull' || direction === 'both') {
        if (remoteFile && !localFile) {
          actions.push({ type: 'download', relative, remote: remoteFile, reason: baseline ? 'local-missing' : 'new' })
          continue
        }
        if (remoteFile && localFile) {
          const localUnchanged = baseline?.localMd5 && baseline.localMd5 === localMd5
          const remoteUnchanged = baseline?.remoteMd5 && baseline.remoteMd5 === remoteMd5
          if (localUnchanged && !remoteUnchanged) {
            actions.push({ type: 'download', relative, remote: remoteFile, reason: 'remote-changed' })
            continue
          }
          if (remoteUnchanged) {
            if (direction === 'both') {
              actions.push({ type: 'upload', relative, local: localFile, reason: 'local-changed' })
            } else {
              actions.push({ type: 'skip', relative, reason: 'local-changed-push-required' })
            }
            continue
          }
          conflicts.push({ relative, reason: 'both-changed', localMd5, remoteMd5 })
          actions.push({ type: 'conflict', relative, reason: 'both-changed' })
          continue
        }
        if (!remoteFile && localFile && baseline) {
          actions.push({ type: 'skip', relative, reason: 'remote-deleted-local-kept' })
        }
      }
    }
    const summary = {
      uploads: actions.filter(action => action.type === 'upload').length,
      downloads: actions.filter(action => action.type === 'download').length,
      conflicts: conflicts.length,
      unchanged: actions.filter(action => action.type === 'record').length,
      skipped: actions.filter(action => action.type === 'skip').length,
    }
    return {
      id: this.id,
      direction,
      localRoot: this.localRoot,
      remoteRoot: this.remoteRoot,
      generatedAt: new Date().toISOString(),
      manifestUpdatedAt: manifest.data.updatedAt,
      summary,
      actions,
      conflicts,
    }
  }

  /**
   * Apply a plan. Uploads and downloads are independent and bounded by
   * `sync.concurrency`. Hash-verified but not transactional across files.
   * @param {Awaited<ReturnType<SyncEngine['plan']>>} plan
   * @param {{signal?: AbortSignal}} [options]
   */
  async apply(plan, options = {}) {
    const manifest = await this.openManifest()
    const results = []
    const queue = plan.actions.filter(action => ['upload', 'download', 'record'].includes(action.type))
    const concurrency = Math.max(1, Math.min(16, Number(this.config.sync.concurrency) || 3))
    let cursor = 0
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        options.signal?.throwIfAborted()
        const index = cursor
        cursor += 1
        const action = queue[index]
        if (!action) return
        try {
          const result = await this.applyOne(action, manifest, options)
          results.push(result)
        } catch (error) {
          results.push({ type: 'error', relative: action.relative, message: error.message, code: error.code })
        }
      }
    })
    await Promise.all(workers)
    for (const action of plan.actions.filter(item => item.type === 'conflict' || item.type === 'skip')) {
      results.push({ type: action.type, relative: action.relative, reason: action.reason })
    }
    await manifest.save()
    return {
      id: this.id,
      appliedAt: new Date().toISOString(),
      ok: results.every(result => result.type !== 'error'),
      counts: {
        uploaded: results.filter(result => result.type === 'uploaded').length,
        downloaded: results.filter(result => result.type === 'downloaded').length,
        recorded: results.filter(result => result.type === 'recorded').length,
        skipped: results.filter(result => result.type === 'skip').length,
        conflicts: results.filter(result => result.type === 'conflict').length,
        errors: results.filter(result => result.type === 'error').length,
      },
      results,
      conflicts: plan.conflicts,
    }
  }

  async applyOne(action, manifest, options) {
    if (action.type === 'record') {
      manifest.set(action.relative, this.baseline(action.relative, action.local, action.remote))
      return { type: 'recorded', relative: action.relative }
    }
    if (action.type === 'upload') {
      const remotePath = remoteFor(this.remoteRoot, action.relative)
      const uploaded = await this.client.uploadAtomic(action.local.absolute, remotePath, { signal: options.signal })
      const remoteStat = await this.client.stat(remotePath)
      const remote = {
        remotePath,
        size: uploaded.size,
        md5: uploaded.md5,
        fsid: remoteStat?.fs_id ?? uploaded.fsid,
        mtime: Number(remoteStat?.server_mtime ?? 0),
      }
      const local = { ...action.local, md5: uploaded.md5 }
      manifest.set(action.relative, this.baseline(action.relative, local, remote))
      return { type: 'uploaded', relative: action.relative, size: uploaded.size, md5: uploaded.md5 }
    }
    if (action.type === 'download') {
      const target = assertInside(this.localRoot, path.join(this.localRoot, action.relative))
      await resolveLocalPathChecked(target, this.config.local)
      await ensureRealDirectory(path.dirname(target))
      const stagingDir = path.join(this.config.local.stagingDir, 'sync', this.id)
      await ensureRealDirectory(stagingDir)
      const staging = path.join(stagingDir, `${randomUUID()}.download`)
      // `action.remote.md5` is whatever the listing reported. When it is a real
      // MD5 the download verifies against it; when Baidu returned its
      // obfuscated digest it is not comparable, so fall back to a size check
      // and record the bytes we actually hashed as the new baseline.
      const downloaded = await this.client.download(action.remote.remotePath, staging, {
        signal: options.signal,
        expectedMd5: action.remote.md5,
        expectedSize: action.remote.size,
      })
      await publishFile(staging, target)
      const stat = await fsp.stat(target)
      const local = {
        relative: action.relative,
        absolute: target,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        md5: downloaded.md5,
      }
      manifest.set(action.relative, this.baseline(action.relative, local, action.remote))
      return { type: 'downloaded', relative: action.relative, size: stat.size, md5: downloaded.md5 }
    }
    throw new HdsBaiduError('unsupported-action', `unsupported action: ${action.type}`)
  }

  baseline(relative, local, remote) {
    return {
      relative,
      localSize: local?.size,
      localMtimeMs: local?.mtimeMs,
      localMd5: local?.md5,
      remotePath: remote?.remotePath ?? remoteFor(this.remoteRoot, relative),
      remoteFsid: remote?.fsid,
      remoteMd5: remote?.md5,
      remoteSize: remote?.size,
      remoteMtime: remote?.mtime,
      syncedAt: new Date().toISOString(),
    }
  }
}
