import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { normalizeAllowedDrives, resolveLocalPathChecked } from './paths.mjs'
import { HdsBaiduError } from './errors.mjs'
import { readJson, writeFileAtomic } from './log.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(HERE, '..')

/**
 * Build the default configuration rooted on the project drive.
 * @returns {any}
 */
function defaults() {
  const home = process.env.DSH_HOME || 'G:\\.dsh'
  return {
    remoteRoot: '/HDS',
    local: {
      root: PROJECT_ROOT,
      stateDir: path.join(PROJECT_ROOT, 'state'),
      mirrorDir: path.join(PROJECT_ROOT, 'mirrors'),
      stagingDir: path.join(PROJECT_ROOT, 'var', 'staging'),
      allowedDrives: [path.parse(PROJECT_ROOT).root.slice(0, 1)],
    },
    hds: {
      home,
      profile: process.env.DSH_PROFILE || 'desktop',
      sessionsDir: path.join(home, 'sessions'),
      storagesDir: path.join(home, 'storages'),
    },
    sync: {
      exclude: [
        '.git/**',
        'node_modules/**',
        '.venv/**',
        'venv/**',
        '__pycache__/**',
        '.pytest_cache/**',
        '.mypy_cache/**',
        '.ruff_cache/**',
        '.next/**',
        'dist/**',
        'build/**',
        'target/**',
        '.cache/**',
        '**/*.pyc',
        '**/.DS_Store',
        '**/Thumbs.db',
        '**/*.part',
        '.hds-baidu/**',
      ],
      concurrency: 3,
      conflictPolicy: 'skip',
    },
    backup: {
      sources: {
        sessions: true,
        workspaceRegistry: true,
        sessionProjectionCache: false,
        profileConfig: false,
      },
      projects: [],
      includeProjectGitBundle: true,
      maxFileBytes: 5 * 1024 * 1024 * 1024,
    },
    storageBackend: {
      remoteRoot: '/HDS/dsh',
      cacheRoot: path.join(PROJECT_ROOT, 'var', 'dsh-storage-cache'),
      offlinePolicy: 'reject',
      requestTimeoutMs: 120000,
    },
    mcp: {
      serverName: 'hds-baidu',
      allowDestructiveTools: false,
    },
  }
}

function merge(base, override) {
  if (Array.isArray(override)) return override.slice()
  if (override && typeof override === 'object') {
    const output = { ...base }
    for (const [key, value] of Object.entries(override)) {
      output[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? merge(base?.[key] ?? {}, value)
        : value
    }
    return output
  }
  return override
}

/**
 * Load configuration, validate every write location and create only approved
 * state directories.
 * @param {{configPath?: string}} [options]
 * @returns {Promise<any>}
 */
export async function loadConfig(options = {}) {
  const configPath = options.configPath
    || process.env.HDS_BAIDU_CONFIG
    || path.join(PROJECT_ROOT, 'config', 'config.json')
  let fileConfig
  try {
    fileConfig = await readJson(configPath)
  } catch (error) {
    throw new HdsBaiduError('config-invalid', `cannot read config: ${configPath}`, { cause: error })
  }
  const config = merge(defaults(), fileConfig ?? {})
  config.configPath = configPath
  config.local.allowedDrives = [...normalizeAllowedDrives(config.local.allowedDrives)]
  if (config.local.allowedDrives.includes('C')) {
    throw new HdsBaiduError('config-invalid', 'C: must never appear in local.allowedDrives')
  }
  for (const key of ['root', 'stateDir', 'mirrorDir', 'stagingDir']) {
    const value = config.local[key]
    config.local[key] = await resolveLocalPathChecked(value, {
      root: PROJECT_ROOT,
      allowedDrives: config.local.allowedDrives,
    })
  }
  for (const key of ['home', 'sessionsDir', 'storagesDir']) {
    config.hds[key] = await resolveLocalPathChecked(config.hds[key], {
      root: PROJECT_ROOT,
      allowedDrives: config.local.allowedDrives,
    })
  }
  config.storageBackend.cacheRoot = await resolveLocalPathChecked(config.storageBackend.cacheRoot, {
    root: PROJECT_ROOT,
    allowedDrives: config.local.allowedDrives,
  })
  config.backup.projects = await Promise.all((config.backup.projects ?? []).map(project =>
    resolveLocalPathChecked(project, { root: config.local.root, allowedDrives: config.local.allowedDrives })))
  config.local.stateDir = await resolveLocalPathChecked(config.local.stateDir, {
    root: config.local.root,
    allowedDrives: config.local.allowedDrives,
  })
  await fsp.mkdir(config.local.stateDir, { recursive: true, mode: 0o700 })
  return config
}

/**
 * Resolve the access token. Environment wins; the local file is a fallback.
 * @param {any} config
 * @returns {Promise<string|undefined>}
 */
export async function getAccessToken(config) {
  if (process.env.BAIDU_NETDISK_ACCESS_TOKEN) return process.env.BAIDU_NETDISK_ACCESS_TOKEN.trim()
  const file = path.join(config.local.stateDir, 'credentials.json')
  const document = await readJson(file)
  const token = document?.accessToken
  return typeof token === 'string' && token.trim() ? token.trim() : undefined
}

/**
 * Persist a token in the approved G-drive state directory.
 * @param {any} config
 * @param {string} token
 */
export async function saveAccessToken(config, token) {
  if (typeof token !== 'string' || token.trim().length < 8) {
    throw new HdsBaiduError('token-invalid', 'access token is empty or too short')
  }
  const file = path.join(config.local.stateDir, 'credentials.json')
  await writeFileAtomic(file, `${JSON.stringify({ accessToken: token.trim(), savedAt: new Date().toISOString() }, null, 2)}\n`)
  return file
}

/**
 * Produce a token-free summary for diagnostics.
 * @param {any} config
 * @param {string|undefined} token
 */
export function configSummary(config, token) {
  return {
    configPath: config.configPath,
    remoteRoot: config.remoteRoot,
    localRoot: config.local.root,
    stateDir: config.local.stateDir,
    mirrorDir: config.local.mirrorDir,
    stagingDir: config.local.stagingDir,
    allowedDrives: config.local.allowedDrives,
    hdsHome: config.hds.home,
    hdsProfile: config.hds.profile,
    sessionsDir: config.hds.sessionsDir,
    storagesDir: config.hds.storagesDir,
    tokenConfigured: Boolean(token),
  }
}
