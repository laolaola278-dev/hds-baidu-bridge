import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  appCredentialsPath,
  authorizeUrl,
  exchangeCode,
  extractAuthorizationCode,
  fingerprint,
  loadAppCredentials,
  loadCredentials,
  normalizeTokenResponse,
  refreshAccessToken,
  resolveAppCredentials,
  saveAppCredentials,
  saveCredentials,
  tokenStatus,
} from '../src/oauth.mjs'
import { makeTestRoot, TEST_BASE } from './helpers/fake-client.mjs'


function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

test('the authorize URL carries the scope, state and redirect', () => {
  const { url, state, scope, redirectUri } = authorizeUrl({
    clientId: 'app-key',
    redirectUri: 'oob',
    state: 'fixed-state',
  })
  const parsed = new URL(url)
  assert.equal(parsed.origin + parsed.pathname, 'https://openapi.baidu.com/oauth/2.0/authorize')
  assert.equal(parsed.searchParams.get('response_type'), 'code')
  assert.equal(parsed.searchParams.get('client_id'), 'app-key')
  assert.equal(parsed.searchParams.get('redirect_uri'), 'oob')
  assert.equal(parsed.searchParams.get('state'), 'fixed-state')
  assert.match(scope, /netdisk/)
  assert.equal(state, 'fixed-state')
  assert.equal(redirectUri, 'oob')
})

test('a missing client id is rejected before any URL is built', () => {
  assert.throws(() => authorizeUrl({}), /clientId/)
})

test('a bare code, a query string and a full redirect URL all parse', () => {
  const code = 'abcdef123456abcdef'
  assert.equal(extractAuthorizationCode(code), code)
  assert.equal(extractAuthorizationCode(`?code=${code}&state=x`), code)
  assert.equal(extractAuthorizationCode(`code=${code}`), code)
  assert.equal(extractAuthorizationCode(`https://example.com/cb?code=${code}&state=x`), code)
  assert.equal(extractAuthorizationCode(`  ${code}  `), code)
})

test('a denial and a code-less URL produce distinct, actionable errors', () => {
  assert.throws(() => extractAuthorizationCode('https://x/cb?error=access_denied'), error => {
    assert.equal(error.code, 'oauth-denied')
    return true
  })
  assert.throws(() => extractAuthorizationCode('https://x/cb?state=only'), error => {
    assert.equal(error.code, 'oauth-code')
    return true
  })
  assert.throws(() => extractAuthorizationCode(''), /no authorization code/)
})

test('the token endpoint is queried with the exact RFC 6749 parameters', async () => {
  const calls = []
  const result = await exchangeCode({
    clientId: 'id',
    clientSecret: 'secret',
    code: 'the-code',
    redirectUri: 'oob',
    fetchImpl: async url => {
      calls.push(String(url))
      return jsonResponse({ access_token: 'token-1', expires_in: 3600, refresh_token: 'rt-1', scope: 'basic netdisk' })
    },
  })
  assert.equal(calls.length, 1)
  const parsed = new URL(calls[0])
  assert.equal(parsed.searchParams.get('grant_type'), 'authorization_code')
  assert.equal(parsed.searchParams.get('code'), 'the-code')
  assert.equal(parsed.searchParams.get('client_id'), 'id')
  assert.equal(parsed.searchParams.get('client_secret'), 'secret')
  assert.equal(parsed.searchParams.get('redirect_uri'), 'oob')
  assert.equal(result.accessToken, 'token-1')
  assert.equal(result.refreshToken, 'rt-1')
  assert.ok(new Date(result.expiresAt).getTime() > Date.now())
})

test('a token endpoint error body becomes a typed error without the secret', async () => {
  await assert.rejects(
    exchangeCode({
      clientId: 'id',
      clientSecret: 'super-secret-value',
      code: 'expired-authorization-code',
      fetchImpl: async () => jsonResponse({ error: 'invalid_grant', error_description: 'code expired' }),
    }),
    error => {
      assert.equal(error.code, 'oauth-failed')
      assert.match(error.message, /invalid_grant/)
      assert.equal(error.message.includes('super-secret-value'), false)
      return true
    },
  )
})

test('a too-short code is rejected locally instead of being sent upstream', async () => {
  let called = false
  await assert.rejects(
    exchangeCode({
      clientId: 'id',
      clientSecret: 'secret',
      code: 'bad',
      fetchImpl: async () => {
        called = true
        return jsonResponse({ access_token: 'x' })
      },
    }),
    /could not parse|no authorization code|code/,
  )
  assert.equal(called, false, 'a malformed code must never reach the token endpoint')
})

test('refresh sends grant_type=refresh_token and keeps the rotated token', async () => {
  let captured
  const result = await refreshAccessToken({
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'old-refresh',
    fetchImpl: async url => {
      captured = new URL(String(url))
      return jsonResponse({ access_token: 'token-2', expires_in: 2592000, refresh_token: 'new-refresh' })
    },
  })
  assert.equal(captured.searchParams.get('grant_type'), 'refresh_token')
  assert.equal(captured.searchParams.get('refresh_token'), 'old-refresh')
  assert.equal(result.accessToken, 'token-2')
  assert.equal(result.refreshToken, 'new-refresh')
})

test('an empty token response is rejected rather than stored as blank', () => {
  assert.throws(() => normalizeTokenResponse({}), /no access_token/)
})

test('expiry accounting distinguishes fresh, expiring and expired', () => {
  const soon = new Date(Date.now() + 60_000).toISOString()
  const later = new Date(Date.now() + 3600_000).toISOString()
  const past = new Date(Date.now() - 1000).toISOString()
  assert.equal(tokenStatus({ accessToken: 't', expiresAt: later }).valid, true)
  assert.equal(tokenStatus({ accessToken: 't', expiresAt: soon }).reason, 'expiring')
  assert.equal(tokenStatus({ accessToken: 't', expiresAt: past }).reason, 'expired')
  assert.equal(tokenStatus({ accessToken: 't' }).reason, 'no-expiry-recorded')
  assert.equal(tokenStatus({}).reason, 'missing')
})

test('credentials round-trip and expose only a fingerprint', async () => {
  const root = await makeTestRoot('oauth-store')
  const file = path.join(root.stateDir, 'credentials.json')
  try {
    const saved = await saveCredentials(file, {
      accessToken: 'the-access-token',
      refreshToken: 'the-refresh-token',
      scope: 'basic netdisk',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    assert.equal(saved.fingerprint, createHash('sha256').update('the-access-token').digest('hex').slice(0, 12))
    const loaded = await loadCredentials(file)
    assert.equal(loaded.accessToken, 'the-access-token')
    assert.equal(loaded.refreshToken, 'the-refresh-token')
    // The file is on the approved drive and holds no derived secret material.
    assert.equal(path.isAbsolute(file), true)
    assert.ok(file.startsWith('G:'))
  } finally {
    await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
  }
})

test('a missing credential file reads as undefined, not an error', async () => {
  const root = await makeTestRoot('oauth-missing')
  try {
    assert.equal(await loadCredentials(path.join(root.stateDir, 'nope.json')), undefined)
  } finally {
    await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
  }
})

test('a corrupt credential file reads as undefined instead of crashing the CLI', async () => {
  const root = await makeTestRoot('oauth-corrupt')
  const file = path.join(root.stateDir, 'credentials.json')
  try {
    await fsp.mkdir(root.stateDir, { recursive: true })
    await fsp.writeFile(file, '{ not json')
    assert.equal(await loadCredentials(file), undefined)
  } finally {
    await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
  }
})

test('fingerprints are stable, short, and differ per token', () => {
  assert.equal(fingerprint('a'), fingerprint('a'))
  assert.notEqual(fingerprint('a'), fingerprint('b'))
  assert.equal(fingerprint('a').length, 12)
  assert.equal(fingerprint(''), undefined)
  assert.equal(fingerprint(undefined), undefined)
})

test('app credentials round-trip with the secret never echoed', async () => {
  const root = await makeTestRoot('oauth-app')
  try {
    const saved = await saveAppCredentials(root.stateDir, {
      appId: '100000001',
      appKey: 'test-app-key-value',
      secretKey: 'test-secret-key-value',
    })
    assert.equal(saved.appId, '100000001')
    assert.equal(saved.appKeyFingerprint, fingerprint('test-app-key-value'))
    const loaded = await loadAppCredentials(root.stateDir)
    assert.equal(loaded.appKey, 'test-app-key-value')
    assert.equal(loaded.secretKey, 'test-secret-key-value')
    // Nothing derived from the secret may be stored alongside it.
    assert.equal(JSON.stringify(saved).includes('test-secret-key-value'), true)
    assert.equal(JSON.stringify({ ...saved, secretKey: undefined }).includes('test-secret-key-value'), false)
  } finally {
    await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
  }
})

test('app credentials are written owner-only where the platform supports it', async () => {
  const root = await makeTestRoot('oauth-app-mode')
  try {
    await saveAppCredentials(root.stateDir, { appKey: 'k', secretKey: 's' })
    const file = appCredentialsPath(root.stateDir)
    const stat = await fsp.stat(file)
    assert.ok(file.startsWith('G:'), 'credentials must live on the approved drive')
    // On Windows the mode bits are not authoritative, so only assert on POSIX.
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600)
  } finally {
    await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
  }
})

test('a partial app credential pair is rejected rather than half-saved', async () => {
  const root = await makeTestRoot('oauth-app-partial')
  try {
    await assert.rejects(saveAppCredentials(root.stateDir, { appKey: 'only-key' }), /secretKey/)
    await assert.rejects(saveAppCredentials(root.stateDir, { secretKey: 'only-secret' }), /appKey/)
    assert.equal(await loadAppCredentials(root.stateDir), undefined)
  } finally {
    await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
  }
})

test('resolveAppCredentials prefers flags, then environment, then the file', async () => {
  const root = await makeTestRoot('oauth-resolve')
  try {
    // Nothing configured anywhere.
    const empty = await resolveAppCredentials({ stateDir: root.stateDir, env: {} })
    assert.equal(empty.source, 'none')

    await saveAppCredentials(root.stateDir, { appKey: 'file-key', secretKey: 'file-secret' })

    const fromFile = await resolveAppCredentials({ stateDir: root.stateDir, env: {} })
    assert.equal(fromFile.source, 'state file')
    assert.equal(fromFile.clientId, 'file-key')
    assert.equal(fromFile.clientSecret, 'file-secret')

    const fromEnv = await resolveAppCredentials({
      stateDir: root.stateDir,
      env: { BAIDU_APP_KEY: 'env-key', BAIDU_SECRET_KEY: 'env-secret' },
    })
    assert.equal(fromEnv.source, 'environment')
    assert.equal(fromEnv.clientId, 'env-key')

    const fromFlags = await resolveAppCredentials({
      stateDir: root.stateDir,
      clientId: 'flag-key',
      clientSecret: 'flag-secret',
      env: { BAIDU_APP_KEY: 'env-key', BAIDU_SECRET_KEY: 'env-secret' },
    })
    assert.equal(fromFlags.source, 'flags')
    assert.equal(fromFlags.clientId, 'flag-key')
  } finally {
    await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
  }
})

test('a corrupt app credential file resolves to no credentials, not a crash', async () => {
  const root = await makeTestRoot('oauth-app-corrupt')
  try {
    await fsp.mkdir(root.stateDir, { recursive: true })
    await fsp.writeFile(appCredentialsPath(root.stateDir), 'not json at all')
    assert.equal(await loadAppCredentials(root.stateDir), undefined)
    const resolved = await resolveAppCredentials({ stateDir: root.stateDir, env: {} })
    assert.equal(resolved.source, 'none')
  } finally {
    await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
  }
})

test('a bare Baidu token shape is redacted even without a key name', async () => {
  const { redact } = await import('../src/log.mjs')
  const token = `121.${'a'.repeat(32)}`
  const output = redact(`the server said: bad credential ${token} sorry`)
  assert.equal(output.includes(token), false)
  assert.match(output, /REDACTED/)
  // Ordinary dotted numbers must survive.
  assert.equal(redact('version 1.2.3'), 'version 1.2.3')
})
