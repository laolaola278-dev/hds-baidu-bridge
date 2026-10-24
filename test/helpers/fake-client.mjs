import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { hashFile } from '../../src/baidu-api.mjs'
import { HdsBaiduError } from '../../src/errors.mjs'
import { ensureRealDirectory } from '../../src/local-tree.mjs'

/**
 * In-memory implementation of the Baidu client used by unit and integration
 * tests. It intentionally mirrors the production methods rather than mocking
 * individual HTTP calls, so engine behavior is exercised end to end.
 */
export class FakeBaiduClient {
  constructor() {
    /** @type {Map<string, {data: Buffer, md5: string, fsid: number, mtime: number}>} */
    this.files = new Map()
    this.directories = new Set(['/'])
    this.nextId = 1000
    this.failNextUpload = false
    this.failNextDownload = false
    this.calls = []
  }

  normalize(remotePath) {
    const normalized = path.posix.normalize(remotePath)
    if (!normalized.startsWith('/')) throw new HdsBaiduError('remote-path', `relative remote path: ${remotePath}`)
    return normalized
  }

  ensureRemoteDir(remotePath) {
    const normalized = this.normalize(remotePath)
    const parts = normalized.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      this.directories.add(current)
    }
  }

  async stat(remotePath) {
    const normalized = this.normalize(remotePath)
    if (this.directories.has(normalized)) {
      return { fs_id: 1, path: normalized, isdir: 1, size: 0 }
    }
    const file = this.files.get(normalized)
    if (!file) return undefined
    return {
      fs_id: file.fsid,
      path: normalized,
      server_filename: path.posix.basename(normalized),
      isdir: 0,
      size: file.data.length,
      md5: file.md5,
      server_mtime: file.mtime,
    }
  }

  async list(dir = '/') {
    const normalized = this.normalize(dir)
    if (!this.directories.has(normalized)) return []
    const prefix = normalized === '/' ? '/' : `${normalized}/`
    const output = []
    for (const directory of this.directories) {
      if (directory === normalized || !directory.startsWith(prefix)) continue
      if (directory.slice(prefix.length).includes('/')) continue
      output.push({ fs_id: this.nextId++, path: directory, server_filename: path.posix.basename(directory), isdir: 1, size: 0 })
    }
    for (const [filePath, file] of this.files) {
      if (!filePath.startsWith(prefix)) continue
      if (filePath.slice(prefix.length).includes('/')) continue
      output.push({
        fs_id: file.fsid,
        path: filePath,
        server_filename: path.posix.basename(filePath),
        isdir: 0,
        size: file.data.length,
        md5: file.md5,
        server_mtime: file.mtime,
      })
    }
    return output
  }

  async listAll(dir = '/') {
    this.calls.push(['listAll', dir])
    const normalized = this.normalize(dir)
    const prefix = normalized === '/' ? '/' : `${normalized}/`
    const output = []
    for (const [filePath, file] of this.files) {
      if (!filePath.startsWith(prefix)) continue
      output.push({
        fs_id: file.fsid,
        path: filePath,
        server_filename: path.posix.basename(filePath),
        isdir: 0,
        size: file.data.length,
        md5: file.md5,
        server_mtime: file.mtime,
      })
    }
    return output
  }

  async ensureDir(remotePath) {
    this.ensureRemoteDir(remotePath)
  }

  async upload(localPath, remoteDir, options = {}) {
    const data = await fsp.readFile(localPath)
    const md5 = createHash('md5').update(data).digest('hex')
    const filename = options.filename ?? path.basename(localPath)
    const remotePath = path.posix.join(this.normalize(remoteDir), filename)
    this.ensureRemoteDir(remoteDir)
    if (this.failNextUpload) {
      this.failNextUpload = false
      throw new HdsBaiduError('upload-failed', 'simulated upload failure')
    }
    if (this.files.has(remotePath) && options.ondup === 'fail') {
      throw new HdsBaiduError('upload-conflict', `remote file exists: ${remotePath}`)
    }
    const fsid = this.nextId++
    this.files.set(remotePath, { data, md5, fsid, mtime: Math.floor(Date.now() / 1000) })
    return { path: remotePath, size: data.length, md5, fsid, returnType: 1 }
  }

  async uploadAtomic(localPath, remotePath, options = {}) {
    const directory = path.posix.dirname(this.normalize(remotePath))
    const temporary = path.posix.join(directory, '.hds-tmp', `${randomUUID()}.tmp`)
    const uploaded = await this.upload(localPath, path.posix.dirname(temporary), {
      filename: path.posix.basename(temporary),
      ondup: 'overwrite',
    })
    this.files.set(this.normalize(remotePath), this.files.get(uploaded.path))
    this.files.delete(uploaded.path)
    return { path: this.normalize(remotePath), size: uploaded.size, md5: uploaded.md5, fsid: uploaded.fsid }
  }

  async download(remotePath, localPath, options = {}) {
    this.calls.push(['download', remotePath])
    const file = this.files.get(this.normalize(remotePath))
    if (!file) throw new HdsBaiduError('remote-not-found', `remote path not found: ${remotePath}`)
    if (this.failNextDownload) {
      this.failNextDownload = false
      throw new HdsBaiduError('download-failed', 'simulated download failure')
    }
    await fsp.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 })
    await fsp.writeFile(localPath, file.data)
    return { path: localPath, size: file.data.length, md5: file.md5, resumedFrom: 0 }
  }

  async remove(remotePaths) {
    for (const remotePath of remotePaths) this.files.delete(this.normalize(remotePath))
    this.calls.push(['remove', [...remotePaths]])
  }

  async move(source, destinationDir, newName) {
    const from = this.normalize(source)
    const file = this.files.get(from)
    if (!file) throw new HdsBaiduError('remote-not-found', `remote path not found: ${source}`)
    const to = path.posix.join(this.normalize(destinationDir), newName ?? path.posix.basename(from))
    this.ensureRemoteDir(destinationDir)
    this.files.set(to, file)
    this.files.delete(from)
  }

  /** Test helper: list all remote files. */
  snapshot() {
    return [...this.files.entries()].map(([remotePath, file]) => ({ remotePath, size: file.data.length, md5: file.md5 }))
  }
}

/**
 * The directory every test workspace is created under.
 *
 * Derived from this file's own location so a checkout anywhere works: an
 * absolute base (e.g. `G:\...\var\test`) made the suite unrunnable for anyone
 * who cloned the project somewhere else. `var/` is gitignored, and the caller
 * still passes `config.local.allowedDrives`, so the "no writes outside the
 * approved drive" guarantee is unchanged.
 */
export const TEST_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'var', 'test')

/**
 * Create an isolated test workspace under the project's own `var/test`.
 * @param {string} label
 */
export async function makeTestRoot(label) {
  return makeTestRootIn(TEST_BASE, label)
}

/**
 * Create an isolated test workspace under an explicit base directory.
 * @param {string} base
 * @param {string} label
 */
export async function makeTestRootIn(base, label) {
  const root = path.join(base, `${label}-${process.pid}-${randomUUID().slice(0, 8)}`)
  await ensureRealDirectory(root)
  return {
    root,
    localRoot: path.join(root, 'local'),
    remoteRoot: `/test/${label}`,
    stateDir: path.join(root, 'state'),
    stagingDir: path.join(root, 'staging'),
    cacheRoot: path.join(root, 'cache'),
    config: {
      local: { root, stateDir: path.join(root, 'state'), stagingDir: path.join(root, 'staging'), allowedDrives: ['G'] },
      sync: { exclude: ['node_modules/**', '.git/**'], concurrency: 3 },
      backup: { maxFileBytes: 100 * 1024 * 1024 },
      remoteRoot: `/test/${label}`,
    },
  }
}

/**
 * Hash a local file for assertions.
 * @param {string} file
 */
export async function sha(file) {
  return hashFile(file, 'sha256')
}
