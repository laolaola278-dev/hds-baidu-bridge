import path from 'node:path'

/**
 * YAML emitters for the DSH profile patch layer.
 *
 * The patch layer is a top-level YAML array of patch entries. Three shapes are
 * relevant here:
 *   - `{ insert: [...] }` appends new loader rows at the root;
 *   - `{ id, name?, config }` overrides an existing row by id;
 *   - `{ id, disable: true }` disables an existing row.
 *
 * Only strings, numbers, booleans, arrays and plain objects are emitted, so a
 * small dedicated emitter is safer than pulling a YAML dependency into a
 * zero-dependency project. Strings are always single-quoted (literal) except
 * values explicitly marked as JavaScript expressions.
 */

/** Marker for a value that must be emitted as a `!!js` expression. */
export class JsExpression {
  /** @param {string} source */
  constructor(source) {
    this.source = source
  }
}

/**
 * Quote a YAML scalar. Single quotes are literal: backslashes need no
 * escaping, and only an embedded single quote is doubled.
 * @param {string} value
 */
export function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * A plain object is a non-null object whose prototype is Object.prototype or
 * null. Anything else (Date, Map, class instance) is a programming error here.
 * @param {unknown} value
 */
function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Emit an inline scalar, or `undefined` when the value needs block form.
 * @param {unknown} value
 * @returns {string|undefined}
 */
function inlineScalar(value) {
  if (value instanceof JsExpression) return `!!js ${quote(value.source)}`
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`cannot emit non-finite number: ${value}`)
    return String(value)
  }
  if (typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  return undefined
}

/**
 * Emit a value in block form at a given indentation.
 * @param {unknown} value
 * @param {number} indent
 * @returns {string} A document fragment whose lines are already indented.
 */
function emitBlock(value, indent) {
  const pad = ' '.repeat(indent)
  const inline = inlineScalar(value)
  if (inline !== undefined) return `${pad}${inline}`
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    const lines = []
    for (const item of value) {
      const itemInline = inlineScalar(item)
      if (itemInline !== undefined) {
        lines.push(`${pad}- ${itemInline}`)
        continue
      }
      // Block item: render at indent+2 and splice the first line onto the dash.
      const nested = emitBlock(item, indent + 2).split('\n')
      const [first, ...rest] = nested
      lines.push(`${pad}- ${first.slice(indent + 2)}`)
      lines.push(...rest)
    }
    return lines.join('\n')
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter(key => value[key] !== undefined)
    if (keys.length === 0) return `${pad}{}`
    const lines = []
    for (const key of keys) {
      const itemInline = inlineScalar(value[key])
      if (itemInline !== undefined) {
        lines.push(`${pad}${key}: ${itemInline}`)
      } else if (Array.isArray(value[key]) && value[key].length === 0) {
        lines.push(`${pad}${key}: []`)
      } else if (isPlainObject(value[key]) && Object.keys(value[key]).length === 0) {
        lines.push(`${pad}${key}: {}`)
      } else {
        lines.push(`${pad}${key}:`)
        lines.push(emitBlock(value[key], indent + 2))
      }
    }
    return lines.join('\n')
  }
  throw new TypeError(`cannot emit YAML value: ${Object.prototype.toString.call(value)}`)
}

/**
 * Emit a list of patch entries as a YAML document body.
 * @param {Array<Record<string, unknown>>} entries
 * @returns {string}
 */
export function toYamlPatch(entries) {
  for (const entry of entries) {
    if (!isPlainObject(entry)) throw new TypeError('each patch entry must be a plain object')
  }
  return `${emitBlock(entries, 0)}\n`
}

/**
 * Patch entries that register this project's stdio MCP server.
 *
 * The token is deliberately NOT written into the profile: the MCP server reads
 * it from the process environment or from `state/credentials.json` on the
 * approved drive. That keeps a secret out of a file DSH may print in
 * diagnostics and avoids fragile `!!js` quoting.
 * @param {{node: string, server: string, configPath: string, serverName?: string, cwd?: string}} options
 */
export function mcpPatchEntries(options) {
  const serverName = options.serverName ?? 'hds-baidu'
  return [{
    insert: [{
      id: `mcp-${serverName}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        transport: 'stdio',
        serverName,
        command: options.node,
        args: [options.server],
        env: { HDS_BAIDU_CONFIG: options.configPath },
        cwd: options.cwd ?? '',
        toolCallTimeoutMs: 120000,
        failOnStartupError: false,
        reconnect: { enabled: true },
      },
    }],
  }]
}

/**
 * Patch entries that register the Baidu storage backend plugin.
 *
 * The backend plugin reads its token from `accessTokenEnv`, so DSH itself must
 * run with that variable set. It never stores the token in the patch file.
 * @param {{remoteRoot: string, cacheRoot: string, tokenEnv?: string, allowedDrive?: string, offlinePolicy?: 'reject'|'cache'}} options
 */
export function storageBackendPatchEntries(options) {
  return [{
    insert: [{
      id: 'storage-baidu',
      name: '@deepseek-ai/dsh-storage-baidu',
      config: {
        remoteRoot: options.remoteRoot,
        cacheRoot: options.cacheRoot,
        accessTokenEnv: options.tokenEnv ?? 'BAIDU_NETDISK_ACCESS_TOKEN',
        offlinePolicy: options.offlinePolicy ?? 'reject',
        allowedDrives: [options.allowedDrive ?? 'G'],
      },
    }],
  }]
}

/**
 * Patch entry that switches the storage domain backend. Kept separate because
 * it changes durability semantics for every DSH storage write.
 * @param {string} [backend]
 */
export function storageDomainSwitchEntries(backend = 'baidu') {
  return [{ id: 'storage-domain', config: { backend } }]
}

/**
 * Patch entry that removes a previously inserted row.
 * @param {string} id
 */
export function disableEntry(id) {
  return [{ id, disable: true }]
}

/**
 * Locate the profile patch file.
 * @param {{hdsHome: string, profile: string}} config
 */
export function profilePatchPath(config) {
  return path.join(config.hdsHome, 'profiles', config.profile, 'cordis.patch.yml')
}

/**
 * Locate the profile node_modules scope directory used for plugin linking.
 * @param {{hdsHome: string, profile: string}} config
 */
export function profileModulesPath(config) {
  return path.join(config.hdsHome, 'profiles', config.profile, 'node_modules', '@deepseek-ai')
}
