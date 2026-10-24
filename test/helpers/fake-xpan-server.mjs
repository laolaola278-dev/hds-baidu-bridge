import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import path from 'node:path'

/**
 * A functional in-process stand-in for the Baidu XPAN OpenAPI.
 *
 * The existing `http-client.test.mjs` checks individual requests. This server
 * goes further: it keeps real state (directories, file bytes, upload sessions,
 * part tables) so the *engines* can drive the real `BaiduNetdiskClient` over
 * real HTTP and end up with correct bytes on the other side. That is the
 * closest thing to a live acceptance run that exists without a token.
 *
 * It implements the methods the client actually calls:
 *   list, filemetas (via /multimedia), create (dir + file), precreate,
 *   superfile2 part upload, filemanager (move/rename/delete), quota, uinfo,
 *   and dlink download.
 *
 * Deliberate deviations from the real service are limited to what a test needs:
 * dlinks point back at this server, and there is no rate limiting.
 */
export function createFakePan(options = {}) {
  /** @type {Map<string, {data: Buffer, md5: string, mtime: number}>} */
  const files = new Map()
  const directories = new Set(['/'])
  /** @type {Map<string, {path: string, size: number, blockList: string[], parts: Map<number, Buffer>}>} */
  const uploads = new Map()
  let nextFsId = 1000
  const requests = []
  let token = options.token ?? 'fake-token'
  const stats = { uploads: 0, downloads: 0, moves: 0, deletes: 0 }

  const fileEntry = (filePath, file) => ({
    fs_id: file.fsId,
    path: filePath,
    server_filename: path.posix.basename(filePath),
    isdir: 0,
    size: file.data.length,
    md5: file.md5,
    server_mtime: file.mtime,
  })

  const dirEntry = directory => ({
    fs_id: nextFsId++,
    path: directory,
    server_filename: path.posix.basename(directory),
    isdir: 1,
    size: 0,
  })

  const ensureDirs = remotePath => {
    const parts = path.posix.normalize(remotePath).split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      directories.add(current)
    }
  }

  const removeTree = remotePath => {
    const normalized = path.posix.normalize(remotePath)
    const prefix = `${normalized}/`
    for (const key of [...files.keys()]) if (key === normalized || key.startsWith(prefix)) files.delete(key)
    for (const key of [...directories]) if (key === normalized || key.startsWith(prefix)) directories.delete(key)
  }

  const send = (response, payload) => {
    const text = JSON.stringify(payload)
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
    response.end(text)
  }

  const fail = (response, errno, message) => send(response, { errno, error_msg: message })

  const readForm = body => {
    // superfile2 also carries a multipart body; the client only needs the query.
    if (!body) return new URLSearchParams()
    if (body.includes('----formdata') || body.startsWith('--')) return new URLSearchParams()
    try {
      return new URLSearchParams(body)
    } catch {
      return new URLSearchParams()
    }
  }

  /**
   * Extract the file payload from a multipart/form-data body.
   * The body is handed in as a latin1 string so bytes round-trip unchanged.
   */
  const readMultipartFile = (body, contentType) => {
    const matched = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
    if (!matched) return Buffer.alloc(0)
    const boundary = `--${matched[1] ?? matched[2]}`
    const raw = Buffer.from(body, 'binary')
    const delimiter = Buffer.from(`\r\n\r\n`, 'binary')
    let cursor = 0
    while (cursor < raw.length) {
      const boundaryAt = raw.indexOf(boundary, cursor)
      if (boundaryAt === -1) break
      const headerStart = boundaryAt + boundary.length
      const headerEnd = raw.indexOf(delimiter, headerStart)
      if (headerEnd === -1) break
      const headers = raw.subarray(headerStart, headerEnd).toString('latin1')
      const bodyStart = headerEnd + delimiter.length
      const nextBoundary = raw.indexOf(boundary, bodyStart)
      const bodyEnd = nextBoundary === -1 ? raw.length : nextBoundary
      if (/name="file"/i.test(headers) || /filename=/i.test(headers)) {
        // Trim the CRLF that precedes the next boundary.
        let end = bodyEnd
        if (end >= 2 && raw[end - 2] === 0x0d && raw[end - 1] === 0x0a) end -= 2
        return raw.subarray(bodyStart, end)
      }
      cursor = bodyEnd
    }
    return Buffer.alloc(0)
  }

  const handle = (request, response, url, body) => {
    const base = `http://127.0.0.1:${port}`
    const method = url.searchParams.get('method')
    if (url.searchParams.get('access_token') !== token) {
      return fail(response, -6, 'access token invalid')
    }
    const queryPath = url.searchParams.get('path')

    if (url.pathname === '/api/quota') {
      // `free` is the free-tier allowance, per the official field table
      // (total 总空间大小 / used 已使用大小 / free 免费容量). It is deliberately NOT
      // total - used: the real endpoint returns a round GiB figure unrelated to
      // the remainder, which once made `doctor` understate headroom by ~6 TB.
      return send(response, {
        errno: 0,
        total: 10 * 1024 ** 3,
        used: 1024 ** 2,
        free: 5 * 1024 ** 3,
        expire: false,
      })
    }
    if (url.pathname === '/rest/2.0/xpan/nas') {
      return send(response, { errno: 0, uk: 424242, vip_type: 2 })
    }
    if (url.pathname === '/rest/2.0/xpan/file' || url.pathname === '/rest/2.0/xpan/multimedia') {
      if (method === 'list') {
        const dir = path.posix.normalize(url.searchParams.get('dir') ?? '/')
        if (!directories.has(dir)) return fail(response, -9, 'file does not exist')
        const prefix = dir === '/' ? '/' : `${dir}/`
        const list = []
        for (const directory of directories) {
          if (directory === dir || !directory.startsWith(prefix)) continue
          if (directory.slice(prefix.length).includes('/')) continue
          list.push(dirEntry(directory))
        }
        for (const [filePath, file] of files) {
          if (!filePath.startsWith(prefix)) continue
          if (filePath.slice(prefix.length).includes('/')) continue
          list.push(fileEntry(filePath, file))
        }
        return send(response, { errno: 0, list })
      }
      if (method === 'filemetas') {
        const ids = JSON.parse(url.searchParams.get('fsids') ?? '[]')
        const list = []
        for (const [filePath, file] of files) {
          if (!ids.includes(file.fsId)) continue
          list.push({ ...fileEntry(filePath, file), dlink: `${base}/download?path=${encodeURIComponent(filePath)}` })
        }
        if (!list.length) return fail(response, -9, 'file does not exist')
        return send(response, { errno: 0, list })
      }
      if (method === 'precreate') {
        const form = readForm(body)
        const target = path.posix.normalize(form.get('path') ?? url.searchParams.get('path') ?? '/')
        const size = Number(form.get('size') ?? url.searchParams.get('size') ?? 0)
        const blockList = JSON.parse(form.get('block_list') ?? url.searchParams.get('block_list') ?? '[]')
        ensureDirs(path.posix.dirname(target))
        const uploadId = `up-${uploads.size + 1}-${Math.random().toString(36).slice(2, 8)}`
        uploads.set(uploadId, { path: target, size, blockList, parts: new Map() })
        // return_type 1 means "upload the parts"; 2 would mean instant transfer.
        return send(response, { errno: 0, uploadid: uploadId, return_type: 1 })
      }
      if (method === 'create') {
        const form = readForm(body)
        const targetPath = path.posix.normalize(form.get('path') ?? url.searchParams.get('path') ?? '/')
        if (form.get('isdir') === '1') {
          if (directories.has(targetPath)) return fail(response, 31061, 'file already exists')
          ensureDirs(targetPath)
          return send(response, { errno: 0, fs_id: nextFsId++, path: targetPath, isdir: 1 })
        }
        const uploadId = form.get('uploadid')
        const session = uploads.get(uploadId)
        if (!session) return fail(response, -9, 'upload session not found')
        const assembled = Buffer.concat(
          [...session.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, buffer]) => buffer),
        )
        if (assembled.length !== session.size) {
          return fail(response, 31023, `size mismatch: ${assembled.length} != ${session.size}`)
        }
        const md5 = createHash('md5').update(assembled).digest('hex')
        const declared = session.blockList.map(block => String(block).toLowerCase())
        const actual = []
        for (const buffer of [...session.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part)) {
          actual.push(createHash('md5').update(buffer).digest('hex'))
        }
        if (declared.length && declared.join(',') !== actual.join(',')) {
          return fail(response, 31024, 'block_list does not match uploaded parts')
        }
        const ondup = form.get('ondup') ?? 'overwrite'
        if (files.has(targetPath) && ondup === 'fail') return fail(response, 31000, 'file already exists')
        ensureDirs(path.posix.dirname(targetPath))
        files.set(targetPath, { data: assembled, md5, mtime: Math.floor(Date.now() / 1000), fsId: nextFsId++ })
        uploads.delete(uploadId)
        return send(response, { errno: 0, fs_id: nextFsId, path: targetPath, size: assembled.length, md5 })
      }
      if (url.pathname === '/rest/2.0/xpan/file' && method === 'filemanager') {
        const form = readForm(body)
        const opera = url.searchParams.get('opera')
        const entries = JSON.parse(form.get('filelist') ?? '[]')
        if (opera === 'delete') {
          for (const entry of entries) {
            const target = path.posix.normalize(typeof entry === 'string' ? entry : entry.path)
            removeTree(target)
            stats.deletes += 1
          }
          return send(response, { errno: 0, info: entries.map(() => ({ errno: 0 })) })
        }
        if (opera === 'move') {
          for (const entry of entries) {
            const from = path.posix.normalize(entry.path)
            const dir = path.posix.normalize(entry.dest)
            let to = path.posix.join(dir, entry.newname ?? path.posix.basename(from))
            const file = files.get(from)
            if (!file) return fail(response, -9, `file does not exist: ${from}`)
            ensureDirs(dir)
            // The real API rejects a colliding move with errno 12 for EVERY
            // ondup value, including `overwrite`; only `newcopy` proceeds, and
            // it renames instead of replacing. Modelling that is what makes the
            // delete-then-move in uploadAtomic necessary rather than decorative.
            const ondup = form.get('ondup') ?? 'fail'
            if (files.has(to) || directories.has(to)) {
              if (ondup === 'newcopy') {
                const ext = path.posix.extname(to)
                const stem = to.slice(0, to.length - ext.length)
                let counter = 1
                while (files.has(`${stem}(${counter})${ext}`)) counter += 1
                to = `${stem}(${counter})${ext}`
              } else {
                // Reported per-file in `info`, with the envelope errno still 0.
                return send(response, { errno: 0, info: [{ errno: 12, path: from, to_path: to }] })
              }
            }
            files.set(to, file)
            files.delete(from)
            stats.moves += 1
          }
          return send(response, { errno: 0, info: entries.map(() => ({ errno: 0 })) })
        }
        if (opera === 'rename') {
          for (const entry of entries) {
            const from = path.posix.normalize(entry.path)
            const to = path.posix.join(path.posix.dirname(from), entry.newname)
            const file = files.get(from)
            if (!file) return fail(response, -9, `file does not exist: ${from}`)
            files.set(to, file)
            files.delete(from)
          }
          return send(response, { errno: 0, info: entries.map(() => ({ errno: 0 })) })
        }
        return fail(response, -3, `unsupported opera: ${opera}`)
      }
      return fail(response, -3, `unsupported method: ${method}`)
    }
    if (url.pathname === '/rest/2.0/pcs/superfile2') {
      const uploadId = url.searchParams.get('uploadid')
      const partSeq = Number(url.searchParams.get('partseq') ?? 0)
      const session = uploads.get(uploadId)
      if (!session) return fail(response, -9, 'upload session not found')
      const payload = readMultipartFile(body, request.headers['content-type'])
      session.parts.set(partSeq, payload)
      stats.uploads += 1
      return send(response, { errno: 0, md5: createHash('md5').update(payload).digest('hex') })
    }
    if (url.pathname === '/download') {
      const target = path.posix.normalize(url.searchParams.get('path') ?? '/')
      const file = files.get(target)
      if (!file) return fail(response, -9, 'file does not exist')
      const range = request.headers.range
      let start = 0
      if (range) {
        const matched = /bytes=(\d+)-/.exec(range)
        if (matched) start = Number(matched[1])
      }
      stats.downloads += 1
      const slice = file.data.subarray(start)
      response.writeHead(start > 0 ? 206 : 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': slice.length,
        ...(start > 0 ? { 'Content-Range': `bytes ${start}-${file.data.length - 1}/${file.data.length}` } : {}),
      })
      response.end(slice)
      return undefined
    }
    return fail(response, -3, `unsupported path: ${url.pathname}`)
  }

  let port = 0
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const body = Buffer.concat(chunks).toString('binary')
      requests.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        bytes: Buffer.concat(chunks).length,
      })
      try {
        handle(request, response, url, body)
      } catch (error) {
        if (!response.headersSent) fail(response, 500, error.message)
        else response.destroy()
      }
    })
  })

  return {
    listen: () => new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port
        resolve({
          base: `http://127.0.0.1:${port}`,
          requests,
          stats,
          files,
          directories,
        })
      })
    }),
    close: () => new Promise(resolve => server.close(resolve)),
    /** Live remote state, readable before `listen()` resolves. */
    files,
    directories,
    stats,
    requests,
    get token() {
      return token
    },
    set token(value) {
      token = value
    },
    /** Test helper: current remote bytes by path. */
    read: remotePath => files.get(path.posix.normalize(remotePath))?.data,
    /** Test helper: every remote file path, sorted. */
    paths: () => [...files.keys()].sort(),
  }
}
