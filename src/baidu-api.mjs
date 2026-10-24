import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { BaiduApiError, HdsBaiduError, PathPolicyError } from './errors.mjs'
import { fetchWithRetry, readJsonResponse, assertBaiduOk } from './http.mjs'
import { normalizeRemotePath, remoteJoin } from './paths.mjs'
import { redact } from './log.mjs'

const USER_AGENT = 'pan.baidu.com'
const DEFAULT_PART_SIZE = 4 * 1024 * 1024
const LIST_PAGE_SIZE = 1000

/**
 * errno values Baidu uses for "the path does not exist".
 * @type {readonly number[]}
 */
/**
 * XPAN errnos that mean "this path is not there". Shared with the engines so a
 * first-run push against a directory nobody has created yet is not an error.
 */
export const NOT_FOUND_ERRNOS = [-9, 31066, 31061]

/**
 * True when a reported digest is a real MD5 that can be compared against a
 * locally computed hash.
 *
 * Baidu's read endpoints (`file_list`, `filemetas`) return a content-derived
 * digest that is *stable* and *different for different content*, but is not a
 * valid MD5 — it contains characters such as `i`, `n`, `p`, `s` that no
 * hexadecimal string can hold. It is safe to use as an opaque equality key
 * (which is what the sync baseline does) but never as a checksum.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isVerifiableMd5(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value)
}

/**
 * Hash a local file while optionally reading it once.
 * @param {string} file
 * @param {'md5'|'sha256'} [algorithm]
 * @returns {Promise<string>}
 */
export async function hashFile(file, algorithm = 'md5') {
  const hash = createHash(algorithm)
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * Split a file into Baidu's 4 MiB upload parts.
 * @param {number} size
 * @param {number} [partSize]
 * @returns {Array<{offset: number, length: number}>}
 */
export function planParts(size, partSize = DEFAULT_PART_SIZE) {
  if (!Number.isSafeInteger(size) || size < 0) throw new HdsBaiduError('invalid-size', `invalid file size: ${size}`)
  if (size === 0) return [{ offset: 0, length: 0 }]
  const parts = []
  for (let offset = 0; offset < size; offset += partSize) {
    parts.push({ offset, length: Math.min(partSize, size - offset) })
  }
  return parts
}

/**
 * MD5 every upload block. Baidu's precreate/create block_list is the list of
 * per-part digests, not a single whole-file digest, for files larger than one
 * 4 MiB part.
 * @param {string} file
 * @param {number} size
 * @param {number} [partSize]
 * @returns {Promise<string[]>}
 */
export async function md5Blocks(file, size, partSize = DEFAULT_PART_SIZE) {
  const parts = planParts(size, partSize)
  const handle = await fsp.open(file, 'r')
  try {
    const output = []
    const buffer = Buffer.allocUnsafe(partSize)
    for (const part of parts) {
      if (part.length === 0) {
        output.push(createHash('md5').digest('hex'))
        continue
      }
      const { bytesRead } = await handle.read(buffer, 0, part.length, part.offset)
      if (bytesRead !== part.length) throw new HdsBaiduError('short-read', `short read while hashing ${file}`)
      output.push(createHash('md5').update(buffer.subarray(0, bytesRead)).digest('hex'))
    }
    return output
  } finally {
    await handle.close()
  }
}

/**
 * Minimal official Baidu Netdisk OpenAPI client.
 *
 * Endpoints are the documented XPAN REST API. The client deliberately keeps
 * the access token out of error text and never writes outside paths handed in
 * by the caller.
 */
export class BaiduNetdiskClient {
  /**
   * @param {{
   *   accessToken: string,
   *   panBase?: string,
   *   pcsBase?: string,
   *   timeoutMs?: number,
   *   fetchImpl?: typeof fetch,
   *   partSize?: number,
   *   onProgress?: (event: any) => void
   * }} options
   */
  constructor(options) {
    if (!options?.accessToken) throw new HdsBaiduError('token-missing', 'BAIDU_NETDISK_ACCESS_TOKEN is not configured')
    this.token = options.accessToken
    this.panBase = (options.panBase ?? process.env.BAIDU_PAN_BASE ?? 'https://pan.baidu.com').replace(/\/+$/, '')
    this.pcsBase = (options.pcsBase ?? process.env.BAIDU_PCS_BASE ?? 'https://d.pcs.baidu.com').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 120000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.partSize = options.partSize ?? DEFAULT_PART_SIZE
    this.onProgress = options.onProgress ?? (() => {})
  }

  withToken(url) {
    const parsed = new URL(url)
    if (!parsed.searchParams.has('access_token')) parsed.searchParams.set('access_token', this.token)
    return parsed
  }

  /**
   * @param {string} methodName
   * @param {Record<string, string|number|undefined>} query
   */
  panUrl(methodName, query = {}) {
    const url = new URL(`${this.panBase}/rest/2.0/xpan/file`)
    url.searchParams.set('method', methodName)
    url.searchParams.set('access_token', this.token)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url
  }

  async requestJson(url, init, methodName) {
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          'User-Agent': USER_AGENT,
          ...(init?.headers ?? {}),
        },
      })
      const payload = await readJsonResponse(response, methodName)
      return assertBaiduOk(payload, methodName)
    } catch (error) {
      if (error instanceof BaiduApiError || error instanceof HdsBaiduError) throw error
      throw new BaiduApiError(methodName, undefined, `request failed: ${redact(error)}`, { cause: error })
    }
  }

  /**
   * List one directory. `start` is a file-count offset so callers can page
   * deterministically; Baidu returns the whole directory when it fits.
   * @param {string} dir
   * @param {number} [start]
   * @returns {Promise<any[]>}
   */
  async list(dir = '/', start = 0) {
    const normalized = normalizeRemotePath(dir)
    const url = this.panUrl('list', {
      dir: normalized,
      order: 'name',
      desc: 0,
      start: Math.max(0, Number(start) || 0),
      limit: LIST_PAGE_SIZE,
    })
    const payload = await this.requestJson(url, { method: 'GET' }, 'file_list')
    return Array.isArray(payload.list) ? payload.list : []
  }

  /**
   * Recursively list a directory tree.
   * @param {string} dir
   * @param {{signal?: AbortSignal, maxEntries?: number}} [options]
   * @returns {Promise<Array<any & {path: string}>>}
   */
  async listAll(dir = '/', options = {}) {
    const queue = [normalizeRemotePath(dir)]
    const seen = new Set()
    const output = []
    const maxEntries = options.maxEntries ?? 200000
    while (queue.length) {
      options.signal?.throwIfAborted()
      const current = queue.shift()
      if (seen.has(current)) continue
      seen.add(current)
      for (let start = 0; ; start += LIST_PAGE_SIZE) {
        const entries = await this.list(current, start)
        for (const entry of entries) {
          if (output.length >= maxEntries) {
            throw new HdsBaiduError('too-many-entries', `remote listing exceeded ${maxEntries} entries`)
          }
          const item = { ...entry, path: entry.path ?? remoteJoin(current, entry.server_filename ?? '') }
          output.push(item)
          if (Number(entry.isdir) === 1) queue.push(item.path)
        }
        if (entries.length < LIST_PAGE_SIZE) break
      }
    }
    return output
  }

  /**
   * Return metadata for a remote path, or undefined when absent.
   * @param {string} remotePath
   * @returns {Promise<any|undefined>}
   */
  async stat(remotePath) {
    const normalized = normalizeRemotePath(remotePath)
    if (normalized === '/') return { path: '/', isdir: 1, size: 0 }
    const parent = path.posix.dirname(normalized)
    const name = path.posix.basename(normalized)
    let entries
    try {
      entries = await this.list(parent)
    } catch (error) {
      if (error instanceof BaiduApiError && NOT_FOUND_ERRNOS.includes(error.errno)) return undefined
      throw error
    }
    return entries.find(entry => entry.server_filename === name || entry.path === normalized)
  }

  async meta(fsid) {
    const url = new URL(`${this.panBase}/rest/2.0/xpan/multimedia`)
    url.searchParams.set('method', 'filemetas')
    url.searchParams.set('access_token', this.token)
    url.searchParams.set('fsids', JSON.stringify([Number(fsid)]))
    url.searchParams.set('dlink', '1')
    url.searchParams.set('thumb', '0')
    url.searchParams.set('extra', '1')
    const payload = await this.requestJson(url, { method: 'GET' }, 'file_meta')
    return Array.isArray(payload.list) ? payload.list[0] : undefined
  }

  /**
   * Create one directory. Existing directories are accepted.
   * @param {string} remotePath
   */
  async mkdir(remotePath) {
    const normalized = normalizeRemotePath(remotePath)
    if (normalized === '/') return
    const body = new URLSearchParams({
      path: normalized,
      isdir: '1',
      size: '0',
      rtype: '1',
    })
    const url = this.panUrl('create')
    try {
      const payload = await this.requestJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }, 'make_dir')
      return payload
    } catch (error) {
      if (error instanceof BaiduApiError && [31061, 31062, 31063, 31064, 31065, 31066].includes(error.errno)) return undefined
      throw error
    }
  }

  /**
   * Ensure every component of a remote directory exists. Existing directories
   * are the normal case, so a mkdir failure is tolerated only when the path
   * really is there afterwards.
   * @param {string} remotePath
   */
  async ensureDir(remotePath) {
    const normalized = normalizeRemotePath(remotePath)
    const parts = normalized.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      const existing = await this.stat(current).catch(error => {
        if (error instanceof BaiduApiError && NOT_FOUND_ERRNOS.includes(error.errno)) return undefined
        throw error
      })
      if (existing && Number(existing.isdir) === 1) continue
      try {
        await this.mkdir(current)
      } catch (error) {
        if (error instanceof BaiduApiError && [31061, 31062, 31063, 31064, 31065, 31066].includes(error.errno)) continue
        throw error
      }
    }
  }

  /**
   * Resolve a fresh download link.
   * @param {string} remotePath
   * @returns {Promise<{dlink: string, size: number, md5?: string}>}
   */
  async getDlink(remotePath) {
    const metadata = await this.stat(remotePath)
    if (!metadata) throw new HdsBaiduError('remote-not-found', `remote path not found: ${remotePath}`)
    if (Number(metadata.isdir) === 1) throw new HdsBaiduError('is-directory', `remote path is a directory: ${remotePath}`)
    const full = await this.meta(metadata.fs_id)
    const dlink = full?.dlink
    if (!dlink) throw new HdsBaiduError('download-link-unavailable', `Baidu did not return a dlink for ${remotePath}`)
    return { dlink, size: Number(full.size ?? metadata.size ?? 0), md5: full.md5 ?? metadata.md5 }
  }

  /**
   * Download to a local path with resumable partial files. The caller must have
   * approved the destination already; this method never performs path policy.
   * @param {string} remotePath
   * @param {string} localPath
   * @param {{signal?: AbortSignal, resume?: boolean, expectedMd5?: string}} [options]
   * @returns {Promise<{path: string, size: number, md5: string, resumedFrom: number}>}
   */
  async download(remotePath, localPath, options = {}) {
    const link = await this.getDlink(remotePath)
    // Not every `md5` the API reports is a real content hash. `file_list`,
    // `filemetas` and the dlink metadata return an obfuscated, content-derived
    // digest that includes characters outside [0-9a-f] (observed `i`, `n`, `p`,
    // `s`). Comparing a real MD5 against it would reject every correct
    // download, so only verifiable digests are enforced. See
    // docs/operations.md#remote-md5.
    const remoteMd5 = options.expectedMd5 ?? link.md5
    const expectedMd5 = isVerifiableMd5(remoteMd5) ? String(remoteMd5).toLowerCase() : undefined
    await fsp.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 })
    const partPath = `${localPath}.part`
    let offset = 0
    if (options.resume !== false) {
      try {
        offset = (await fsp.stat(partPath)).size
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (offset > link.size) {
        await fsp.rm(partPath, { force: true })
        offset = 0
      }
    } else {
      await fsp.rm(partPath, { force: true })
    }
    if (offset < link.size) {
      const headers = { 'User-Agent': USER_AGENT }
      if (offset > 0) headers.Range = `bytes=${offset}-`
      const response = await fetchWithRetry(this.withToken(link.dlink), {
        method: 'GET',
        headers,
        timeoutMs: this.timeoutMs,
        retries: 3,
        methodName: 'file_download',
        signal: options.signal,
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new BaiduApiError('file_download', undefined, `HTTP ${response.status}: ${redact(body.slice(0, 300))}`, { status: response.status })
      }
      const handle = await fsp.open(partPath, offset > 0 ? 'a' : 'w', 0o600)
      try {
        if (!response.body) throw new HdsBaiduError('empty-body', 'download response had no body')
        let written = offset
        for await (const chunk of response.body) {
          options.signal?.throwIfAborted()
          await handle.write(chunk)
          written += chunk.length
          this.onProgress({ phase: 'download', remotePath, bytes: written, total: link.size })
        }
      } finally {
        await handle.close()
      }
    }
    const size = (await fsp.stat(partPath)).size
    if (size !== link.size) {
      throw new HdsBaiduError('download-incomplete', `download incomplete: ${size}/${link.size} bytes (${remotePath})`)
    }
    const md5 = await hashFile(partPath, 'md5')
    let verified = false
    if (expectedMd5) {
      if (md5 !== expectedMd5) {
        await fsp.rm(partPath, { force: true })
        throw new HdsBaiduError('download-corrupt', `MD5 mismatch after download: ${remotePath}`)
      }
      verified = true
    } else if (options.expectedSize !== undefined && Number(options.expectedSize) !== size) {
      // With no comparable digest, size is the only cheap integrity signal.
      await fsp.rm(partPath, { force: true })
      throw new HdsBaiduError('download-incomplete', `size mismatch after download: ${size}/${options.expectedSize} bytes (${remotePath})`)
    }
    await fsp.rename(partPath, localPath)
    return { path: localPath, size, md5, resumedFrom: offset, verified, remoteMd5: remoteMd5 ?? null }
  }

  /**
   * Upload one local file. Small files and all chunks share one precreate
   * upload id; the remote publish is a create call.
   * @param {string} localPath
   * @param {string} remoteDir
   * @param {{ondup?: 'fail'|'newcopy'|'overwrite'|'skip', signal?: AbortSignal, filename?: string}} [options]
   */
  async upload(localPath, remoteDir, options = {}) {
    const stat = await fsp.stat(localPath)
    if (!stat.isFile()) throw new HdsBaiduError('not-a-file', `not a regular file: ${localPath}`)
    const filename = options.filename ?? path.basename(localPath)
    const targetDir = normalizeRemotePath(remoteDir)
    await this.ensureDir(targetDir)
    const targetPath = remoteJoin(targetDir, filename)
    const md5 = await hashFile(localPath, 'md5')
    const blockList = await md5Blocks(localPath, stat.size, this.partSize)
    const precreate = new URLSearchParams({
      path: targetPath,
      size: String(stat.size),
      isdir: '0',
      autoinit: '1',
      rtype: '3',
      block_list: JSON.stringify(blockList),
    })
    const precreatePayload = await this.requestJson(
      this.panUrl('precreate'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: precreate,
      },
      'file_precreate',
    )
    const uploadId = precreatePayload.uploadid
    if (!uploadId) throw new HdsBaiduError('upload-id-missing', `precreate did not return uploadid for ${localPath}`)
    const returnType = Number(precreatePayload.return_type ?? 1)
    if (returnType !== 2) {
      const parts = planParts(stat.size, this.partSize)
      for (let index = 0; index < parts.length; index += 1) {
        options.signal?.throwIfAborted()
        const part = parts[index]
        const buffer = Buffer.alloc(part.length)
        if (part.length > 0) {
          const handle = await fsp.open(localPath, 'r')
          try {
            await handle.read(buffer, 0, part.length, part.offset)
          } finally {
            await handle.close()
          }
        }
        const form = new FormData()
        form.append('file', new Blob([buffer]), filename)
        const uploadUrl = new URL(`${this.pcsBase}/rest/2.0/pcs/superfile2`)
        uploadUrl.searchParams.set('method', 'upload')
        uploadUrl.searchParams.set('access_token', this.token)
        uploadUrl.searchParams.set('type', 'tmpfile')
        uploadUrl.searchParams.set('path', targetPath)
        uploadUrl.searchParams.set('uploadid', uploadId)
        uploadUrl.searchParams.set('partseq', String(index))
        const response = await fetchWithRetry(uploadUrl, {
          method: 'POST',
          body: form,
          headers: { 'User-Agent': USER_AGENT },
          timeoutMs: this.timeoutMs,
          retries: 3,
          methodName: 'file_upload_part',
          signal: options.signal,
        })
        const payload = await readJsonResponse(response, 'file_upload_part')
        assertBaiduOk(payload, 'file_upload_part')
        this.onProgress({
          phase: 'upload',
          localPath,
          part: index + 1,
          parts: parts.length,
          bytes: part.offset + part.length,
          total: stat.size,
        })
      }
    }
    const create = new URLSearchParams({
      path: targetPath,
      size: String(stat.size),
      isdir: '0',
      rtype: '3',
      uploadid: uploadId,
      block_list: JSON.stringify(blockList),
      ondup: options.ondup ?? 'overwrite',
    })
    const created = await this.requestJson(
      this.panUrl('create'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: create,
      },
      'file_create',
    )
    return {
      path: targetPath,
      size: stat.size,
      md5,
      fsid: created.fs_id ?? created.fsid,
      returnType,
    }
  }

  /**
   * Upload atomically: write a hidden temporary object, then move it over the
   * destination. Other clients never observe a half-written final path.
   * @param {string} localPath
   * @param {string} remotePath
   * @param {{signal?: AbortSignal}} [options]
   */
  async uploadAtomic(localPath, remotePath, options = {}) {
    const normalized = normalizeRemotePath(remotePath)
    const targetDir = path.posix.dirname(normalized)
    const targetName = path.posix.basename(normalized)
    const tempDir = remoteJoin(targetDir, '.hds-tmp')
    const tempName = `${targetName}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`
    await this.ensureDir(tempDir)
    const staged = await this.upload(localPath, tempDir, {
      filename: tempName,
      ondup: 'overwrite',
      signal: options.signal,
    })
    try {
      await this.ensureDir(targetDir)
      // `filemanager` accepts ondup=overwrite|fail|newcopy|skip but rejects a
      // *move* that collides regardless of the value: every one of them returns
      // errno 12. Only `newcopy` succeeds, and it renames the object to
      // "name(1)" instead of replacing it. So the replace is delete-then-move.
      // The window between the two calls is unavoidable on this API; the
      // destination is missing for milliseconds rather than half-written.
      if (options.replace !== false) {
        const existing = await this.stat(normalized)
        if (existing) {
          // Refuse to replace a directory with a file. `filemanager delete`
          // removes a directory tree recursively, so blindly deleting whatever
          // sits at the destination can destroy an entire tree — that is how a
          // failed backup once emptied and renamed its own `/HDS/backups`
          // directory.
          if (Number(existing.isdir) === 1) {
            throw new HdsBaiduError(
              'target-is-directory',
              `refusing to overwrite a directory with a file: ${normalized}`,
            )
          }
          await this.remove([normalized], { force: true })
        }
      }
      await this.move(staged.path, targetDir, targetName, 'overwrite')
      return { path: normalized, size: staged.size, md5: staged.md5, fsid: staged.fsid }
    } catch (error) {
      await this.remove([staged.path], { force: true }).catch(() => {})
      throw error
    } finally {
      // Leaving `.hds-tmp` behind pollutes every directory this project writes
      // to; the cleanup must not mask a real failure, hence the swallow.
      await this.remove([tempDir], { force: true }).catch(() => {})
    }
  }

  /**
   * Move with ondup policy.
   * @param {string} source
   * @param {string} destinationDir
   * @param {string} [newName]
   * @param {'fail'|'newcopy'|'overwrite'|'skip'} [ondup]
   */
  async move(source, destinationDir, newName, ondup = 'overwrite') {
    const file = { path: normalizeRemotePath(source), dest: normalizeRemotePath(destinationDir) }
    if (newName) file.newname = newName
    const body = new URLSearchParams({
      async: '0',
      ondup,
      filelist: JSON.stringify([file]),
    })
    const url = this.panUrl('filemanager', { opera: 'move' })
    return this.requestJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, 'file_move')
  }

  /**
   * Rename within the current directory.
   * @param {string} remotePath
   * @param {string} newName
   * @param {'fail'|'newcopy'|'overwrite'|'skip'} [ondup]
   */
  async rename(remotePath, newName, ondup = 'fail') {
    const body = new URLSearchParams({
      async: '0',
      ondup,
      filelist: JSON.stringify([{ path: normalizeRemotePath(remotePath), newname: newName }]),
    })
    return this.requestJson(
      this.panUrl('filemanager', { opera: 'rename' }),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      'file_rename',
    )
  }

  /**
   * Delete remote paths. The caller decides whether confirmation was collected.
   * @param {readonly string[]} remotePaths
   * @param {{force?: boolean}} [options]
   */
  async remove(remotePaths, options = {}) {
    if (!Array.isArray(remotePaths) || remotePaths.length === 0) return { deleted: [] }
    if (!options.force) throw new HdsBaiduError('confirmation-required', 'remote delete requires force: true')
    const body = new URLSearchParams({
      async: '0',
      filelist: JSON.stringify(remotePaths.map(normalizeRemotePath)),
    })
    await this.requestJson(
      this.panUrl('filemanager', { opera: 'delete' }),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      'file_delete',
    )
    return { deleted: remotePaths }
  }

  /** @returns {Promise<any>} */
  async quota() {
    const url = new URL(`${this.panBase}/api/quota`)
    url.searchParams.set('access_token', this.token)
    url.searchParams.set('checkfree', '1')
    url.searchParams.set('checkexpire', '1')
    const response = await fetchWithRetry(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT }, methodName: 'get_quota' })
    return readJsonResponse(response, 'get_quota')
  }

  /** @returns {Promise<any>} */
  async userInfo() {
    const url = new URL(`${this.panBase}/rest/2.0/xpan/nas`)
    url.searchParams.set('method', 'uinfo')
    url.searchParams.set('access_token', this.token)
    const response = await fetchWithRetry(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT }, methodName: 'user_info' })
    const payload = await readJsonResponse(response, 'user_info')
    return assertBaiduOk(payload, 'user_info')
  }

  /**
   * Verify connectivity and that the configured remote root is usable.
   * @param {string} remoteRoot
   */
  async doctor(remoteRoot) {
    const user = await this.userInfo()
    const quota = await this.quota()
    await this.ensureDir(normalizeRemotePath(remoteRoot))
    const listing = await this.list(normalizeRemotePath(remoteRoot))
    const total = Number(quota.total ?? 0)
    const used = Number(quota.used ?? 0)
    // `free` is NOT "remaining space". The official field table reads:
    //   total 总空间大小 / used 已使用大小 / free 免费容量
    // `free` is a separate free-tier allowance (it comes back as a round
    // GiB figure, e.g. exactly 105 GiB, unrelated to total - used). Reporting it
    // as "available" understated this account's headroom by ~6 TB, so compute
    // the real remainder and keep the raw field under an honest name.
    return {
      user: { uk: user.uk, vip_type: user.vip_type },
      quota: {
        total,
        used,
        available: Math.max(0, total - used),
        freeAllowance: Number(quota.free ?? 0),
        expiresWithin7Days: quota.expire === true,
      },
      remoteRoot,
      entries: listing.length,
    }
  }
}

/**
 * Retry an idempotent asynchronous operation.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{attempts?: number, delayMs?: number}} [options]
 * @returns {Promise<T>}
 */
export async function retry(operation, options = {}) {
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 500
  let last
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      last = error
      if (attempt + 1 === attempts) break
      await sleep(delayMs * 2 ** attempt)
    }
  }
  throw last
}
