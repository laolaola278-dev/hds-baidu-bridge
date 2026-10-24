import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const SECRET_PATTERNS = [
  /access_token=[^&\s"']+/gi,
  /("?(?:accessToken|access_token|token)"?\s*[:=]\s*"?)[^",\s}]+/gi,
  /BDUSS=[^;\s]+/gi,
  // A bare Baidu token: `<app-segment>.<32+ hex chars>`. Error bodies sometimes
  // echo the credential back without a key name, so the shape has to be caught
  // on its own rather than only via `access_token=`.
  /\b\d{1,4}\.[0-9a-fA-F]{30,}\b/g,
  // Authorization headers that slipped into an error message.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
]

/**
 * Redact likely secrets from text. Never log raw API errors without this.
 * @param {unknown} value
 * @returns {string}
 */
export function redact(value) {
  let text = value instanceof Error ? value.stack ?? value.message : String(value)
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, (match, prefix) => `${prefix ?? ''}[REDACTED]`)
  return text
}

/**
 * Create a logger that writes structured lines to stderr and optionally a file.
 * stdout is reserved for MCP JSON-RPC frames.
 * @param {{level?: 'debug'|'info'|'warn'|'error', file?: string, quiet?: boolean}} options
 */
export function createLogger(options = {}) {
  const level = options.level ?? 'info'
  const ranks = { debug: 10, info: 20, warn: 30, error: 40 }
  const threshold = ranks[level]
  let stream
  if (options.file) {
    fs.mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 })
    stream = fs.createWriteStream(options.file, { flags: 'a', mode: 0o600 })
  }
  const write = (name, message, details) => {
    if (ranks[name] < threshold) return
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: name,
      message: redact(message),
      ...(details === undefined ? {} : { details: sanitize(details) }),
    })
    if (!options.quiet) process.stderr.write(`${line}\n`)
    stream?.write(`${line}\n`)
  }
  return {
    debug: (message, details) => write('debug', message, details),
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details),
    async close() {
      if (!stream) return
      await new Promise(resolve => stream.end(resolve))
    },
  }
}

function sanitize(value, depth = 0) {
  if (depth > 5) return '[depth-limit]'
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitize(item, depth + 1))
  if (value && typeof value === 'object') {
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password|bduss/i.test(key)) output[key] = '[REDACTED]'
      else output[key] = sanitize(item, depth + 1)
    }
    return output
  }
  return value
}

/**
 * Write UTF-8 text atomically inside an already-approved directory.
 * @param {string} file
 * @param {string} text
 */
export async function writeFileAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  const handle = await fsp.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsp.rename(temporary, file)
}

/**
 * Read JSON, returning undefined for an absent file.
 * @param {string} file
 * @returns {Promise<any|undefined>}
 */
export async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Current timestamp safe for file and object names.
 * @param {Date} [date]
 * @returns {string}
 */
export function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}
