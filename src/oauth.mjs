import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fetchWithRetry, readJsonResponse } from './http.mjs'
import { HdsBaiduError } from './errors.mjs'
import { redact, writeFileAtomic } from './log.mjs'

/**
 * OAuth authorization-code helper for Baidu Netdisk.
 *
 * Getting a token by hand means assembling an authorize URL, copying the code
 * out of a redirect, and posting it with a matching redirect_uri. That is
 * error-prone enough that people paste a stale or wrong-scope token, and then
 * blame the client. This module keeps the three steps in one place:
 *
 *   1. `authorizeUrl()` builds the consent URL and records the CSRF state.
 *   2. `exchangeCode()` posts the code with the exact same redirect_uri.
 *   3. `refresh()` rotates an expired token without a new consent round.
 *
 * Baidu's OAuth 2.0 endpoint follows RFC 6749: the token endpoint takes
 * `grant_type=authorization_code|refresh_token` as query parameters.
 *
 * @see https://pan.baidu.com/union/doc/使用入门/接入授权/授权码模式/
 */
export const AUTHORIZE_ENDPOINT = 'https://openapi.baidu.com/oauth/2.0/authorize'
export const TOKEN_ENDPOINT = 'https://openapi.baidu.com/oauth/2.0/token'

/**
 * Scope needed for everything this project does: user info, listing, upload,
 * download and file management all live under `basic` + `netdisk`.
 */
export const DEFAULT_SCOPE = 'basic netdisk'

/**
 * Build the consent URL.
 *
 * `redirect_uri` must be registered on the app exactly as sent here; the token
 * endpoint rejects a mismatch. `oob` ("out of band") is Baidu's shipped default
 * for desktop tools and shows the code on screen instead of redirecting.
 *
 * @param {{
 *   clientId: string,
 *   redirectUri?: string,
 *   scope?: string,
 *   state?: string,
 *   display?: 'page'|'popup'|'mobile'|'dialog'
 * }} options
 */
export function authorizeUrl(options) {
  if (!options.clientId) throw new HdsBaiduError('oauth-config', 'clientId (AppKey) is required')
  const redirectUri = options.redirectUri ?? 'oob'
  const state = options.state ?? randomBytes(12).toString('hex')
  const url = new URL(AUTHORIZE_ENDPOINT)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', options.scope ?? DEFAULT_SCOPE)
  url.searchParams.set('display', options.display ?? 'page')
  url.searchParams.set('state', state)
  return { url: url.toString(), state, redirectUri, scope: options.scope ?? DEFAULT_SCOPE }
}

/**
 * Extract the authorization code from whatever the user pasted.
 *
 * People paste the whole redirect URL, just the query string, or the bare code.
 * All three are accepted because all three are common; a rejection here would
 * just make the user retry blindly.
 * @param {string} input
 */
export function extractAuthorizationCode(input) {
  const text = String(input ?? '').trim()
  if (!text) throw new HdsBaiduError('oauth-code', 'no authorization code provided')
  const direct = /^[A-Za-z0-9._-]{8,}$/.test(text)
  if (direct && !text.includes('=') && !text.includes('/')) return text
  // Full URL or bare query string.
  let params
  try {
    params = new URL(text.includes('://') ? text : `http://localhost/?${text.replace(/^\?/, '')}`).searchParams
  } catch {
    throw new HdsBaiduError('oauth-code', `could not parse the pasted value as a URL or query string: ${redact(text.slice(0, 80))}`)
  }
  const code = params.get('code')
  if (!code) {
    const error = params.get('error') ?? params.get('error_description')
    if (error) throw new HdsBaiduError('oauth-denied', `authorization was not granted: ${redact(error)}`)
    throw new HdsBaiduError('oauth-code', 'the pasted URL contains no `code` parameter')
  }
  return code
}

/**
 * Post to the token endpoint.
 * @param {Record<string, string>} params
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
async function postToken(params, options = {}) {
  const url = new URL(TOKEN_ENDPOINT)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const response = await fetchWithRetry(url, {
    method: 'GET',
    timeoutMs: 30000,
    retries: 2,
    methodName: 'oauth_token',
    fetchImpl: options.fetchImpl,
  })
  const payload = await readJsonResponse(response, 'oauth_token')
  if (payload.error) {
    // Baidu returns 200 with an error body for a bad code or secret.
    throw new HdsBaiduError(
      'oauth-failed',
      `${payload.error}: ${redact(payload.error_description ?? 'no description')}`,
    )
  }
  if (!payload.access_token) throw new HdsBaiduError('oauth-failed', 'token endpoint returned no access_token')
  return normalizeTokenResponse(payload)
}

/**
 * Normalize the token response into a stable shape with an absolute expiry.
 * @param {any} payload
 */
export function normalizeTokenResponse(payload) {
  if (!payload?.access_token) {
    throw new HdsBaiduError('oauth-failed', 'token endpoint returned no access_token')
  }
  const now = Date.now()
  const expiresIn = Number(payload.expires_in ?? 0)
  return {
    accessToken: String(payload.access_token),
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : undefined,
    scope: payload.scope ? String(payload.scope) : undefined,
    sessionKey: payload.session_key ? String(payload.session_key) : undefined,
    sessionSecret: payload.session_secret ? String(payload.session_secret) : undefined,
    expiresAt: expiresIn > 0 ? new Date(now + expiresIn * 1000).toISOString() : undefined,
    obtainedAt: new Date(now).toISOString(),
  }
}

/**
 * Exchange an authorization code for a token.
 * @param {{clientId: string, clientSecret: string, code: string, redirectUri?: string, fetchImpl?: typeof fetch}} options
 */
export async function exchangeCode(options) {
  if (!options.clientSecret) throw new HdsBaiduError('oauth-config', 'clientSecret (SecretKey) is required')
  const code = extractAuthorizationCode(options.code)
  return postToken({
    grant_type: 'authorization_code',
    code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri ?? 'oob',
  }, options)
}

/**
 * Refresh an access token. Baidu rotates the refresh token, so callers must
 * persist the new pair.
 * @param {{clientId: string, clientSecret: string, refreshToken: string, fetchImpl?: typeof fetch}} options
 */
export async function refreshAccessToken(options) {
  if (!options.refreshToken) throw new HdsBaiduError('oauth-config', 'refreshToken is required')
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  }, options)
}

/**
 * Report whether a stored token is still usable, without a network call.
 * @param {{expiresAt?: string}} credentials
 * @param {number} [skewMs] treat tokens expiring this soon as expired
 */
export function tokenStatus(credentials, skewMs = 120000) {
  if (!credentials?.accessToken) return { valid: false, reason: 'missing' }
  if (!credentials.expiresAt) return { valid: true, reason: 'no-expiry-recorded' }
  const remaining = new Date(credentials.expiresAt).getTime() - Date.now()
  if (Number.isNaN(remaining)) return { valid: true, reason: 'unparseable-expiry' }
  if (remaining <= 0) return { valid: false, reason: 'expired', expiresAt: credentials.expiresAt }
  if (remaining <= skewMs) return { valid: false, reason: 'expiring', expiresAt: credentials.expiresAt }
  return { valid: true, reason: 'fresh', expiresAt: credentials.expiresAt, remainingMs: remaining }
}

/**
 * Persist the full credential set (not just the access token) so a later run
 * can refresh without asking the user to authorize again.
 * @param {string} file
 * @param {any} credentials
 */
export async function saveCredentials(file, credentials) {
  const document = {
    ...credentials,
    savedAt: new Date().toISOString(),
    fingerprint: fingerprint(credentials.accessToken),
  }
  await writeFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`)
  return document
}

/**
 * Read stored credentials, tolerating the older token-only file shape.
 * @param {string} file
 */
export async function loadCredentials(file) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const document = JSON.parse(text)
    if (typeof document?.accessToken === 'string') return document
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Short, non-reversible identifier so logs can say *which* token is in use
 * without revealing it.
 * @param {string} token
 */
export function fingerprint(token) {
  if (typeof token !== 'string' || !token) return undefined
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

/**
 * Application-level credentials (AppKey/SecretKey), needed by `token login`
 * and `token refresh`.
 *
 * These are kept in a separate file from the access token because their
 * lifetimes differ: the token rotates every ~30 days while the app secret only
 * changes when the developer resets it. Both files live under `state/`, which
 * is git-ignored and excluded from every backup.
 *
 * @param {string} stateDir
 */
export function appCredentialsPath(stateDir) {
  return path.join(stateDir, 'app-credentials.json')
}

/**
 * Read stored app credentials.
 * @param {string} stateDir
 */
export async function loadAppCredentials(stateDir) {
  const file = appCredentialsPath(stateDir)
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const document = JSON.parse(text)
    if (!document?.appKey || !document?.secretKey) return undefined
    return document
  } catch {
    return undefined
  }
}

/**
 * Persist app credentials with owner-only permissions.
 * @param {string} stateDir
 * @param {{appId?: string, appKey: string, secretKey: string, signKey?: string}} credentials
 */
export async function saveAppCredentials(stateDir, credentials) {
  const appKey = String(credentials.appKey ?? '').trim()
  const secretKey = String(credentials.secretKey ?? '').trim()
  if (!appKey) throw new HdsBaiduError('oauth-config', 'appKey (AppKey) is required')
  if (!secretKey) throw new HdsBaiduError('oauth-config', 'secretKey (SecretKey) is required')
  const document = {
    appId: credentials.appId ? String(credentials.appId).trim() : undefined,
    appKey,
    secretKey,
    // SignKey and ShareSecret are not used by this project; they are recorded
    // only when supplied so an operator can see what was configured.
    signKey: credentials.signKey ? String(credentials.signKey).trim() : undefined,
    appKeyFingerprint: fingerprint(appKey),
    savedAt: new Date().toISOString(),
  }
  const file = appCredentialsPath(stateDir)
  await writeFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`)
  await fsp.chmod(file, 0o600).catch(() => {})
  return document
}

/**
 * Resolve app credentials from flags, then environment, then the state file.
 * @param {{
 *   stateDir: string,
 *   clientId?: string,
 *   clientSecret?: string,
 *   env?: NodeJS.ProcessEnv
 * }} options
 */
export async function resolveAppCredentials(options) {
  const env = options.env ?? process.env
  const clientId = options.clientId ?? env.BAIDU_APP_KEY
  const clientSecret = options.clientSecret ?? env.BAIDU_SECRET_KEY
  if (clientId && clientSecret) return { clientId, clientSecret, source: options.clientId ? 'flags' : 'environment' }
  const stored = await loadAppCredentials(options.stateDir)
  if (stored) {
    return {
      clientId: clientId ?? stored.appKey,
      clientSecret: clientSecret ?? stored.secretKey,
      source: 'state file',
      appId: stored.appId,
    }
  }
  return { clientId, clientSecret, source: 'none' }
}
