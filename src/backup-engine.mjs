import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { hashFile, NOT_FOUND_ERRNOS } from './baidu-api.mjs'
import { walkLocal, ensureRealDirectory } from './local-tree.mjs'
import { remoteJoin } from './paths.mjs'
import { HdsBaiduError, BaiduApiError } from './errors.mjs'
import { readJson, writeFileAtomic, timestamp } from './log.mjs'

/**
 * Recursively copy a directory on approved storage, preserving only regular
 * files and rejecting reparse points. Used for DSH session/storage snapshots.
 * @param {string} source
 * @param {string} destination
 */
async function copyTree(source, destination) {
  const files = await walkLocal(source, { exclude: [] })
  for (const file of files) {
    const target = path.join(destination, file.relative)
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await fsp.copyFile(file.absolute, target)
  }
  return files
}

/**
 * Content-addressed backup of HDS sessions, workspace registry and projects.
 *
 * Remote layout:
 *   <root>/catalog.json
 *   <root>/objects/<sha256[0:2]>/<sha256>
 *   <root>/snapshots/<snapshotId>/manifest.json
 */
export class BackupEngine {
  /**
   * @param {{client: any, config: any, logger?: any, clock?: () => Date}} options
   */
  constructor(options) {
    this.client = options.client
    this.config = options.config
    this.logger = options.logger
    this.clock = options.clock ?? (() => new Date())
    this.root = `${String(this.config.remoteRoot).replace(/\/+$/, '')}/backups`
  }

  catalogPath() {
    return remoteJoin(this.root, 'catalog.json')
  }

  snapshotPath(snapshotId) {
    return remoteJoin(this.root, 'snapshots', snapshotId, 'manifest.json')
  }

  objectPath(hash) {
    return remoteJoin(this.root, 'objects', hash.slice(0, 2), hash)
  }

  /**
   * Load the remote catalog. A missing catalog is an empty catalog.
   * @returns {Promise<{version: number, objects: Record<string, {size: number, path: string}>, snapshots: Array<any>, updatedAt?: string}>}
   */
  async loadCatalog() {
    const staging = path.join(this.config.local.stagingDir, 'catalog', `${randomUUID()}.json`)
    await ensureRealDirectory(path.dirname(staging))
    try {
      await this.client.download(this.catalogPath(), staging, { resume: false })
      const catalog = JSON.parse(await fsp.readFile(staging, 'utf8'))
      await fsp.rm(staging, { force: true })
      if (catalog?.version !== 1) throw new HdsBaiduError('catalog-version', 'unsupported remote catalog version')
      catalog.objects ??= {}
      catalog.snapshots ??= []
      return catalog
    } catch (error) {
      await fsp.rm(staging, { force: true }).catch(() => {})
      if (error?.code === 'remote-not-found' || /not found/i.test(error?.message ?? '')) {
        return { version: 1, objects: {}, snapshots: [], updatedAt: undefined }
      }
      throw error
    }
  }

  /**
   * Build the list of sources and per-file manifests.
   * @param {{projects?: string[]}} [options]
   */
  async collect(options = {}) {
    const sources = []
    const config = this.config
    if (config.backup.sources.sessions) {
      sources.push({
        name: 'hds-sessions',
        localRoot: config.hds.sessionsDir,
        remoteRoot: remoteJoin(this.root, 'live', 'sessions'),
        exclude: ['**/*.part', '**/*.tmp'],
      })
    }
    if (config.backup.sources.workspaceRegistry) {
      const workspace = path.join(config.hds.storagesDir, 'workspace.json')
      const exists = await fsp.stat(workspace).then(() => true, () => false)
      if (exists) {
        sources.push({
          name: 'hds-workspace',
          localRoot: config.hds.storagesDir,
          remoteRoot: remoteJoin(this.root, 'live', 'storages'),
          include: ['workspace.json'],
          exclude: [],
        })
      }
    }
    if (config.backup.sources.sessionProjectionCache) {
      sources.push({
        name: 'hds-projection-cache',
        localRoot: config.hds.storagesDir,
        remoteRoot: remoteJoin(this.root, 'live', 'storages'),
        include: ['session_projcache.json', 'session_projcache/**'],
        exclude: ['**/*.tmp'],
      })
    }
    if (config.backup.sources.profileConfig) {
      sources.push({
        name: 'hds-profile',
        localRoot: path.join(config.hds.home, 'profiles', config.hds.profile),
        remoteRoot: remoteJoin(this.root, 'live', 'profile', config.hds.profile),
        include: ['cordis.yml', 'cordis.patch.yml', 'package.json'],
        exclude: [],
      })
    }
    const projects = options.projects?.length ? options.projects : config.backup.projects
    for (const project of projects) {
      sources.push({
        name: `project-${path.basename(project)}`,
        localRoot: project,
        remoteRoot: remoteJoin(this.root, 'projects', path.basename(project)),
        exclude: config.sync.exclude,
      })
    }
    return sources
  }

  /**
   * Plan a backup: hash every file, compare with remote catalog, list uploads.
   * @param {{projects?: string[]}} [options]
   */
  async plan(options = {}) {
    const sources = await this.collect(options)
    const catalog = await this.loadCatalog()
    const files = []
    for (const source of sources) {
      const exists = await fsp.stat(source.localRoot).then(stat => stat.isDirectory(), () => false)
      if (!exists) continue
      let walked = await walkLocal(source.localRoot, {
        exclude: source.exclude ?? [],
        maxFileBytes: this.config.backup.maxFileBytes,
      })
      if (source.include?.length) {
        const allowed = source.include.map(pattern => new RegExp(`^${pattern.replaceAll('**', '.*').replaceAll('*', '[^/]*')}$`))
        walked = walked.filter(file => allowed.some(regex => regex.test(file.relative)))
      }
      for (const file of walked) {
        const sha256 = await hashFile(file.absolute, 'sha256')
        files.push({
          source: source.name,
          localRoot: source.localRoot,
          relative: file.relative,
          absolute: file.absolute,
          size: file.size,
          mtimeMs: file.mtimeMs,
          sha256,
          object: this.objectPath(sha256),
          needsUpload: catalog.objects[sha256] === undefined,
        })
      }
    }
    const snapshotId = timestamp(this.clock())
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    const uploadBytes = files.filter(file => file.needsUpload).reduce((sum, file) => sum + file.size, 0)
    return {
      snapshotId,
      generatedAt: new Date().toISOString(),
      localRoot: this.config.local.root,
      remoteRoot: this.root,
      sources: sources.map(source => ({ name: source.name, localRoot: source.localRoot, remoteRoot: source.remoteRoot })),
      files,
      summary: {
        files: files.length,
        totalBytes,
        uploads: files.filter(file => file.needsUpload).length,
        uploadBytes,
        reusedObjects: files.filter(file => !file.needsUpload).length,
      },
    }
  }

  /**
   * Apply a backup plan. Uploads each missing object, writes the snapshot
   * manifest, then publishes the updated catalog.
   * @param {Awaited<ReturnType<BackupEngine['plan']>>} plan
   */
  async apply(plan) {
    const catalog = await this.loadCatalog()
    const uploaded = []
    const failed = []
    const uploads = plan.files.filter(file => file.needsUpload)
    let cursor = 0
    const workers = Array.from({ length: Math.max(1, Math.min(8, Number(this.config.sync?.concurrency) || 3)) }, async () => {
      for (;;) {
        const file = uploads[cursor]
        cursor += 1
        if (!file) return
        try {
          const stat = await this.client.stat(file.object)
          if (!stat) {
            const result = await this.client.upload(file.absolute, path.posix.dirname(file.object), {
              filename: path.posix.basename(file.object),
              ondup: 'overwrite',
            })
            uploaded.push({ sha256: file.sha256, size: file.size, path: file.object, result })
          }
          catalog.objects[file.sha256] = {
            size: file.size,
            path: file.object,
            uploadedAt: new Date().toISOString(),
          }
        } catch (error) {
          failed.push({ relative: file.relative, message: error.message, code: error.code })
        }
      }
    })
    await Promise.all(workers)
    if (failed.length) {
      return { ok: false, snapshotId: plan.snapshotId, uploaded: uploaded.length, failed }
    }
    const manifest = {
      version: 1,
      snapshotId: plan.snapshotId,
      createdAt: new Date().toISOString(),
      localRoot: plan.localRoot,
      remoteRoot: plan.remoteRoot,
      sources: plan.sources,
      files: plan.files.map(file => ({
        source: file.source,
        relative: file.relative,
        size: file.size,
        mtimeMs: file.mtimeMs,
        sha256: file.sha256,
        object: file.object,
      })),
      summary: plan.summary,
    }
    const manifestFile = path.join(this.config.local.stagingDir, 'manifests', `${plan.snapshotId}.json`)
    await writeFileAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    await this.client.uploadAtomic(manifestFile, this.snapshotPath(plan.snapshotId))
    catalog.snapshots = [
      { snapshotId: plan.snapshotId, manifest: this.snapshotPath(plan.snapshotId), createdAt: manifest.createdAt, files: manifest.files.length, bytes: plan.summary.totalBytes },
      ...catalog.snapshots.filter(item => item.snapshotId !== plan.snapshotId),
    ].slice(0, 100)
    catalog.updatedAt = new Date().toISOString()
    const catalogFile = path.join(this.config.local.stagingDir, 'catalog', `${plan.snapshotId}.json`)
    await writeFileAtomic(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`)
    try {
      await this.client.uploadAtomic(catalogFile, this.catalogPath())
    } catch (error) {
      // The manifest is already on the remote but the catalog that points at it
      // is not. Left alone that becomes an orphan snapshot: it consumes space,
      // is invisible to `backup list`, and can never be restored. Remove it so
      // a failed run leaves no trace.
      const snapshotDir = remoteJoin(this.root, 'snapshots', plan.snapshotId)
      await this.client.remove([this.snapshotPath(plan.snapshotId), snapshotDir], { force: true }).catch(() => {})
      throw error
    }
    return {
      ok: true,
      snapshotId: plan.snapshotId,
      uploaded: uploaded.length,
      reused: plan.files.length - uploaded.length,
      manifest: this.snapshotPath(plan.snapshotId),
      catalog: this.catalogPath(),
    }
  }

  /**
   * List snapshots from the remote catalog.
   *
   * The catalog is the source of truth for restores, but it is not the only
   * thing on the remote: a run that uploaded its manifest and then failed to
   * publish the catalog leaves a snapshot directory that no catalog entry
   * points at. Such an orphan is invisible here, consumes quota, and can never
   * be restored — so compare against the real directory listing and report them.
   */
  async list() {
    const catalog = await this.loadCatalog()
    const known = new Set(catalog.snapshots.map(item => item.snapshotId))
    let orphans = []
    try {
      const entries = await this.client.list(remoteJoin(this.root, 'snapshots'))
      orphans = entries
        .filter(entry => Number(entry.isdir) === 1 && !known.has(entry.server_filename))
        .map(entry => entry.server_filename)
    } catch (error) {
      // A missing snapshots directory just means nothing has been backed up yet;
      // any other failure must still surface.
      const ignorable = error instanceof BaiduApiError && NOT_FOUND_ERRNOS.includes(error.errno)
      if (!ignorable) throw error
    }
    return {
      remoteRoot: this.root,
      updatedAt: catalog.updatedAt,
      objects: Object.keys(catalog.objects).length,
      snapshots: catalog.snapshots,
      ...(orphans.length > 0 ? { orphanSnapshots: orphans.sort() } : {}),
    }
  }

  /**
   * Download one manifest.
   * @param {string} snapshotId
   */
  async manifest(snapshotId) {
    const staging = path.join(this.config.local.stagingDir, 'manifests', `${snapshotId}.download.json`)
    await ensureRealDirectory(path.dirname(staging))
    await this.client.download(this.snapshotPath(snapshotId), staging, { resume: false })
    return JSON.parse(await fsp.readFile(staging, 'utf8'))
  }
}

/**
 * Build a deterministic gzip archive plan for a directory. This is a simple
 * tar-like container used only to make a single transferable project artifact.
 * @param {string} root
 * @param {({relative: string, data: Buffer}[])} entries
 */
export function buildBundleBuffer(entries) {
  const header = Buffer.from(JSON.stringify({ format: 'hds-bundle-v1', createdAt: new Date().toISOString(), entries: entries.map(entry => ({ relative: entry.relative, size: entry.data.length })) }))
  const chunks = [Buffer.from([header.length >>> 24, (header.length >>> 16) & 255, (header.length >>> 8) & 255, header.length & 255]), header]
  for (const entry of entries) {
    const name = Buffer.from(entry.relative, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(entry.data.length)
    const nameLength = Buffer.alloc(2)
    nameLength.writeUInt16BE(name.length)
    chunks.push(nameLength, name, length, entry.data)
  }
  return gzipSync(Buffer.concat(chunks), { level: 6 })
}

/**
 * Build a Git bundle on the approved drive when the project is a Git repo.
 * @param {string} project
 * @param {string} target
 * @param {{spawn: typeof import('node:child_process').spawn}} deps
 */
export async function createGitBundle(project, target, deps) {
  const gitDir = path.join(project, '.git')
  const exists = await fsp.stat(gitDir).then(() => true, () => false)
  if (!exists) return { created: false, reason: 'not-a-git-repository' }
  const child = deps.spawn('git', ['bundle', 'create', target, '--all'], {
    cwd: project,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const code = await new Promise(resolve => child.once('close', resolve))
  if (code !== 0) return { created: false, reason: `git bundle failed: ${createHash('sha256').update(stderr).digest('hex').slice(0, 8)}` }
  const stat = await fsp.stat(target)
  return { created: true, path: target, size: stat.size }
}
