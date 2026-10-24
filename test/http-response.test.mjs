import test from 'node:test'
import assert from 'node:assert/strict'
import { assertBaiduOk, readJsonResponse } from '../src/http.mjs'

/**
 * `readJsonResponse` is the single place where an HTTP failure becomes a user
 * visible message. Two things must hold for every failure shape:
 *  - the structured `error`/`description` is preferred over a raw JSON blob;
 *  - nothing that could carry a secret ends up in the message.
 */
function response(body, status) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('an OAuth failure prefers error and error_description over raw JSON', async () => {
  await assert.rejects(
    readJsonResponse(response({ error: 'invalid_client', error_description: 'unknown client id' }, 401), 'oauth_token'),
    error => {
      assert.equal(error.message, 'oauth_token: HTTP 401: invalid_client: unknown client id')
      assert.equal(error.status, 401)
      // No JSON punctuation or braces should leak into the operator-facing text.
      assert.equal(/[{}"]/.test(error.message), false)
      return true
    },
  )
})

test('a Baidu-style errno failure inside a non-2xx body keeps the errno', async () => {
  await assert.rejects(
    readJsonResponse(response({ errno: -6, errmsg: 'access token invalid' }, 403), 'file_list'),
    error => {
      assert.equal(error.errno, -6)
      assert.equal(error.status, 403)
      assert.match(error.message, /access token invalid/)
      return true
    },
  )
})

test('an error without a description still names the error code', async () => {
  await assert.rejects(
    readJsonResponse(response({ error: 'invalid_grant' }, 400), 'oauth_token'),
    error => {
      assert.equal(error.message, 'oauth_token: HTTP 400: invalid_grant')
      return true
    },
  )
})

test('a non-JSON failure body is redacted and truncated', async () => {
  const html = '<html><body>' + 'x'.repeat(2000) + '</body></html>'
  await assert.rejects(readJsonResponse(response(html, 502), 'file_list'), error => {
    // BaiduApiError prefixes the API method, so the status sits after it.
    assert.match(error.message, /^file_list: HTTP 502: /)
    assert.ok(error.message.length < 700, `message should stay short, got ${error.message.length}`)
    return true
  })
})

test('a token in the failure body never reaches the message', async () => {
  await assert.rejects(
    readJsonResponse(
      response({ error: 'invalid_request', error_description: 'bad token 121.abcdef0123456789abcdef0123456789' }, 400),
      'oauth_token',
    ),
    error => {
      assert.equal(error.message.includes('121.abcdef0123456789abcdef0123456789'), false)
      return true
    },
  )
})

test('a malformed JSON success body is a distinct error, not a crash', async () => {
  await assert.rejects(readJsonResponse(response('{ not json', 200), 'file_list'), error => {
    assert.match(error.message, /invalid JSON response/)
    return true
  })
})

test('a valid body passes through untouched', async () => {
  const payload = await readJsonResponse(response({ errno: 0, list: [{ server_filename: 'a.txt' }] }, 200), 'file_list')
  assert.equal(payload.errno, 0)
  assert.equal(payload.list[0].server_filename, 'a.txt')
})

test('a per-file errno inside a batch response is not reported as success', async () => {
  // filemanager keeps the envelope at errno 0 and reports failures per file.
  // Treating the envelope alone as the result turned a rejected move into a
  // "successful" atomic upload.
  assert.throws(
    () => assertBaiduOk({
      errno: 0,
      info: [{ errno: 12, path: '/a/.tmp/x.tmp', to_path: '/a/x' }],
    }, 'file_move'),
    error => {
      assert.equal(error.code, 'baidu-api')
      assert.equal(error.errno, 12)
      assert.match(error.message, /1 of 1 items failed/)
      assert.match(error.message, /\/a\/\.tmp\/x\.tmp/)
      return true
    },
  )
})

test('a fully successful batch response passes through', () => {
  const payload = { errno: 0, info: [{ errno: 0, path: '/a/x' }, { errno: 0, path: '/a/y' }] }
  assert.equal(assertBaiduOk(payload, 'file_move'), payload)
})

test('an empty or absent info array is not a failure', () => {
  assert.deepEqual(assertBaiduOk({ errno: 0 }, 'file_move'), { errno: 0 })
  assert.deepEqual(assertBaiduOk({ errno: 0, info: [] }, 'file_move'), { errno: 0, info: [] })
})

test('a batch with a mix of successes and one failure still throws', () => {
  assert.throws(
    () => assertBaiduOk({
      errno: 0,
      info: [{ errno: 0, path: '/a/ok' }, { errno: 12, path: '/a/dup', to_path: '/a/dup' }],
    }, 'file_move'),
    /1 of 2 items failed/,
  )
})
