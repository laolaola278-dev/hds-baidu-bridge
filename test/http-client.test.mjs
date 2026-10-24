import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { BaiduNetdiskClient } from '../src/baidu-api.mjs'
import { makeTestRoot } from './helpers/fake-client.mjs'

/**
 * Serve a tiny in-process fake of the Baidu XPAN API so the real HTTP client is
 * exercised without network access or a token.
 */
function startFakePan(handler) {
  return new Promise(resolve => {
    const requests = []
    const server = createServer((request, response) => {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        const url = new URL(request.url, 'http://127.0.0.1')
        const body = Buffer.concat(chunks).toString('utf8')
        const record = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body }
        requests.push(record)
        try {
          handler(record, response)
        } catch (error) {
          response.writeHead(500, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ errno: 500, error_msg: error.message }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise(done => server.close(done)),
      })
    })
  })
}

test('client lists a directory over HTTP with the access token attached', async () => {
  const pan = await startFakePan((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      errno: 0,
      list: [{ fs_id: 7, path: '/HDS/a.txt', server_filename: 'a.txt', isdir: 0, size: 3, md5: 'abc' }],
    }))
  })
  try {
    const client = new BaiduNetdiskClient({ accessToken: 'token-123', panBase: pan.base })
    const entries = await client.list('/HDS')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, '/HDS/a.txt')
    const request = pan.requests[0]
    assert.equal(request.path, '/rest/2.0/xpan/file')
    assert.equal(request.query.method, 'list')
    assert.equal(request.query.access_token, 'token-123')
    assert.equal(request.query.dir, '/HDS')
  } finally {
    await pan.close()
  }
})

test('an errno response becomes a BaiduApiError with the code', async () => {
  const pan = await startFakePan((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ errno: -7, error_msg: 'access token invalid' }))
  })
  try {
    const client = new BaiduNetdiskClient({ accessToken: 'bad', panBase: pan.base })
    await assert.rejects(client.list('/HDS'), error => {
      assert.equal(error.code, 'baidu-api')
      assert.equal(error.errno, -7)
      assert.match(error.message, /access token invalid/)
      return true
    })
  } finally {
    await pan.close()
  }
})

test('stat returns undefined for a 404-style missing path', async () => {
  const pan = await startFakePan((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ errno: -9, error_msg: 'file not found' }))
  })
  try {
    const client = new BaiduNetdiskClient({ accessToken: 'token', panBase: pan.base })
    const stat = await client.stat('/HDS/missing.txt')
    assert.equal(stat, undefined)
  } finally {
    await pan.close()
  }
})

test('token never appears in a thrown error message', async () => {
  const pan = await startFakePan((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ errno: -6, error_msg: 'denied for access_token=super-secret-value' }))
  })
  try {
    const client = new BaiduNetdiskClient({ accessToken: 'super-secret-value', panBase: pan.base })
    await assert.rejects(client.list('/HDS'), error => {
      assert.equal(error.message.includes('super-secret-value'), false)
      return true
    })
  } finally {
    await pan.close()
  }
})

test('download streams a dlink body and verifies the md5', async () => {
  const payload = Buffer.from('hello baidu')
  const dlinkServer = await startFakePan((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length) })
    response.end(payload)
  })
  const pan = await startFakePan((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      errno: 0,
      list: [{ fs_id: 9, path: '/HDS/a.txt', isdir: 0, size: payload.length, md5: createHash('md5').update(payload).digest('hex'), dlink: `${dlinkServer.base}/file` }],
    }))
  })
  try {
    const root = await makeTestRoot('http-download')
    const target = path.join(root.root, 'a.txt')
    const client = new BaiduNetdiskClient({ accessToken: 'token', panBase: pan.base })
    const result = await client.download('/HDS/a.txt', target)
    assert.equal(result.size, payload.length)
    assert.equal(await fsp.readFile(target, 'utf8'), 'hello baidu')
  } finally {
    await pan.close()
    await dlinkServer.close()
  }
})
