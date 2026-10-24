import { setTimeout as sleep } from 'node:timers/promises'
import { BaiduApiError } from './errors.mjs'
import { redact } from './log.mjs'

/**
 * Parse a Retry-After header in seconds.
 * @param {Headers} headers
 * @returns {number}
 */
function retryAfterMs(headers) {
  const value = headers.get('retry-after')
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}

/**
 * Fetch with bounded retries and abort-based timeout. Error messages are
 * redacted before leaving this module.
 * @param {string|URL} url
 * @param {RequestInit & {timeoutMs?: number, retries?: number, methodName?: string}} options
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
  const { timeoutMs = 60000, retries = 3, methodName = 'http', fetchImpl = globalThis.fetch, ...init } = options
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs)
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal })
      if (response.status === 429 || response.status === 503 || response.status === 504) {
        if (attempt === retries) return response
        const delay = retryAfterMs(response.headers) || Math.min(30000, 1000 * 2 ** attempt)
        await sleep(delay)
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (attempt === retries) {
        throw new BaiduApiError(methodName, undefined, `network request failed: ${redact(error)}`, { cause: error })
      }
      await sleep(Math.min(30000, 1000 * 2 ** attempt))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new BaiduApiError(methodName, undefined, `network request failed: ${redact(lastError)}`, { cause: lastError })
}

/**
 * Read a JSON response and translate an HTTP failure into a safe error.
 * @param {Response} response
 * @param {string} methodName
 * @returns {Promise<any>}
 */
export async function readJsonResponse(response, methodName) {
  const text = await response.text()
  if (!response.ok) {
    // The OAuth token endpoint reports failures with an HTTP status *and* an
    // `error`/`error_description` body, so prefer the structured fields: they
    // produce `invalid_client: unknown client id` instead of a raw JSON blob.
    const parsed = tryParseJson(text)
    const code = parsed?.error ?? parsed?.errmsg
    const description = parsed?.error_description ?? parsed?.error_msg
    const detail = code
      ? `${redact(String(code))}${description ? `: ${redact(String(description))}` : ''}`
      : redact(text.slice(0, 500))
    throw new BaiduApiError(methodName, parsed?.errno, `HTTP ${response.status}: ${detail}`, {
      status: response.status,
    })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new BaiduApiError(methodName, undefined, `invalid JSON response: ${redact(text.slice(0, 300))}`, { cause: error })
  }
}

/**
 * Parse JSON without throwing; used to decorate error messages.
 * @param {string} text
 */
function tryParseJson(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Throw when a Baidu-style JSON payload carries a non-zero errno.
 * @param {any} payload
 * @param {string} methodName
 * @param {readonly number[]} [allowed]
 * @returns {any}
 */
export function assertBaiduOk(payload, methodName, allowed = [0]) {
  const errno = Number(payload?.errno ?? 0)
  if (errno !== 0 && !allowed.includes(errno)) {
    throw new BaiduApiError(methodName, errno, redact(payload?.errmsg || payload?.error_msg || `errno ${errno}`))
  }
  // Batch operations (`filemanager` move/rename/delete) keep the envelope at
  // errno 0 and report success or failure *per file* inside `info`. Ignoring
  // that array silently reports a failed move as a successful one, which is how
  // a rejected overwrite turned into a "successful" atomic upload.
  const info = Array.isArray(payload?.info) ? payload.info : []
  const failed = info.filter(item => Number(item?.errno ?? 0) !== 0)
  if (failed.length > 0) {
    const first = failed[0]
    const detail = failed
      .map(item => `${item?.path ?? '?'}->${item?.to_path ?? '?'} errno ${item?.errno}`)
      .slice(0, 3)
      .join('; ')
    throw new BaiduApiError(
      methodName,
      Number(first.errno),
      redact(`${failed.length} of ${info.length} items failed: ${detail}`),
    )
  }
  return payload
}
