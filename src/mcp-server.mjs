import path from 'node:path'
import fsp from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { loadConfig, getAccessToken, configSummary } from './config.mjs'
import { BaiduNetdiskClient } from './baidu-api.mjs'
import { SyncEngine } from './sync-engine.mjs'
import { BackupEngine } from './backup-engine.mjs'
import { RestoreEngine, restorePlanDigest } from './restore-engine.mjs'
import { normalizeRemotePath, resolveLocalPathChecked, remoteJoin } from './paths.mjs'
import { ensureRealDirectory } from './local-tree.mjs'
import { createLogger, redact } from './log.mjs'
import { HdsBaiduError } from './errors.mjs'
import { useApprovedTempDir } from './temp.mjs'
import { syncId } from './local-tree.mjs'
import { ProjectUploader } from './project-upload.mjs'
import { describeMirrorState, mirrorStatePath, readMirrorState } from './watch.mjs'

export const SERVER_NAME = 'hds-baidu-bridge'
export const SERVER_VERSION = '0.1.0'
const PROTOCOL_VERSION = '2025-06-18'
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024

/**
 * Keep every remote write under the configured cloud root. This is not a
 * substitute for the user's own confirmation, but prevents an accidental tool
 * call from touching unrelated Netdisk paths.
 * @param {any} config
 * @param {string} remotePath
 */
function assertRemoteUnderRoot(config, remotePath) {
  const root = normalizeRemotePath(config.remoteRoot)
  const normalized = normalizeRemotePath(remotePath)
  if (normalized === root) return normalized
  if (!normalized.startsWith(`${root}/`)) {
    throw new HdsBaiduError('remote-policy', `remote path must stay under ${root}: ${normalized}`)
  }
  return normalized
}

/**
 * Tool definitions. Descriptions are intentionally explicit about destructive
 * behavior so a model cannot infer it accidentally.
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'hds_baidu_status',
    description: 'Show configured HDS and Baidu paths, whether a token is present, and the remote root. Does not contact Baidu.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'hds_baidu_doctor',
    description: 'Verify the Baidu token, quota, and configured remote root with a live API call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'hds_baidu_list',
    description: 'List one remote Baidu directory. Paths must stay under the configured remote root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute Baidu path, e.g. /HDS/projects/demo' },
        recursive: { type: 'boolean', default: false },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_baidu_upload',
    description: 'Upload one local file to a Baidu directory. Local paths are restricted to approved drives (never C:).',
    inputSchema: {
      type: 'object',
      properties: {
        localPath: { type: 'string' },
        remoteDir: { type: 'string' },
        overwrite: { type: 'boolean', default: true },
      },
      required: ['localPath', 'remoteDir'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_baidu_download',
    description: 'Download one remote file to an approved local path. Never writes to C:.',
    inputSchema: {
      type: 'object',
      properties: {
        remotePath: { type: 'string' },
        localPath: { type: 'string' },
      },
      required: ['remotePath', 'localPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_project_sync_plan',
    description: 'Plan a project or folder sync between a local directory and Baidu. Never modifies either side.',
    inputSchema: {
      type: 'object',
      properties: {
        localDir: { type: 'string' },
        remoteDir: { type: 'string' },
        direction: { type: 'string', enum: ['push', 'pull', 'both'], default: 'both' },
      },
      required: ['localDir', 'remoteDir'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_project_sync_apply',
    description: 'Apply a project sync. Uploads are default; conflicts are always skipped. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        localDir: { type: 'string' },
        remoteDir: { type: 'string' },
        direction: { type: 'string', enum: ['push', 'pull', 'both'], default: 'push' },
        confirm: { type: 'boolean' },
      },
      required: ['localDir', 'remoteDir', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_mirror_prepare',
    description: 'Create a local mirror on an approved drive, pull remote files into it, and return the path to open as an HDS workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        remoteDir: { type: 'string' },
        name: { type: 'string', pattern: '^[A-Za-z0-9._-]+$' },
      },
      required: ['remoteDir', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_backup',
    description: 'Plan or run a content-addressed backup of HDS sessions, workspace registry, and configured projects. Run requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['plan', 'run', 'list'], default: 'plan' },
        projects: { type: 'array', items: { type: 'string' } },
        confirm: { type: 'boolean', default: false },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_restore',
    description: 'Plan or apply a restore. Apply requires confirm=true and the exact planDigest returned by the plan.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['plan', 'apply'], default: 'plan' },
        snapshotId: { type: 'string' },
        mapping: {
          type: 'object',
          description: 'Optional target roots: hds-home, project:<name>.',
          additionalProperties: { type: 'string' },
        },
        confirm: { type: 'boolean', default: false },
        planDigest: { type: 'string' },
      },
      required: ['action', 'snapshotId'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_project_upload',
    description: 'Upload a whole local project to Baidu (exclusions apply). Optional git bundle preserves history. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        localDir: { type: 'string' },
        remoteDir: { type: 'string' },
        includeGitBundle: { type: 'boolean', default: true },
        confirm: { type: 'boolean' },
      },
      required: ['localDir', 'remoteDir', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_project_download',
    description: 'Materialize a remote project into a local mirror directory on an approved drive and return the path to open as a workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        remoteDir: { type: 'string' },
        name: { type: 'string', pattern: '^[A-Za-z0-9._-]+$' },
        confirm: { type: 'boolean' },
      },
      required: ['remoteDir', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_mirror_status',
    description: 'Read the recorded state of a running mirror daemon for one local/remote pair.',
    inputSchema: {
      type: 'object',
      properties: {
        localDir: { type: 'string' },
        remoteDir: { type: 'string' },
      },
      required: ['localDir', 'remoteDir'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_baidu_mkdir',
    description: 'Create a remote directory under the configured remote root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'hds_baidu_delete',
    description: 'Delete remote files. Disabled unless mcp.allowDestructiveTools is true; also requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1 },
        confirm: { type: 'boolean' },
      },
      required: ['paths', 'confirm'],
      additionalProperties: false,
    },
  },
]

/**
 * MCP stdio server implementation.
 */
export class McpServer {
  /**
   * @param {{config: any, token?: string, logger?: any, stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream}} options
   */
  constructor(options) {
    this.config = options.config
    this.token = options.token
    this.logger = options.logger
    this.stdin = options.stdin ?? process.stdin
    this.stdout = options.stdout ?? process.stdout
    this.client = undefined
    this.initialized = false
  }

  baidu() {
    if (!this.token) {
      throw new HdsBaiduError('token-missing', 'Baidu Netdisk is not configured. Run: node bin/hds-baidu.mjs token set')
    }
    this.client ??= new BaiduNetdiskClient({ accessToken: this.token, timeoutMs: this.config.storageBackend.requestTimeoutMs })
    return this.client
  }

  /**
   * Re-resolve the token before use.
   *
   * The server long outlives the credentials it starts with: HDS spawns it once
   * and keeps it for the life of the app, while the user may run `token login`
   * afterwards. Reading `credentials.json` only in `startMcpServer()` left every
   * tool reporting "not configured" until HDS was restarted, even though the
   * token was on disk. Resolve per call instead, and rebuild the client when the
   * token actually changed; refresh-token rotation also changes it mid-session.
   */
  async resolveToken(options = {}) {
    const resolved = await getAccessToken(this.config)
    if (resolved && resolved !== this.token) {
      this.token = resolved
      this.client = undefined
    }
    if (!this.token && options.quiet !== true) {
      throw new HdsBaiduError('token-missing', 'Baidu Netdisk is not configured. Run: node bin/hds-baidu.mjs token set')
    }
    return this.token
  }

  async baiduLive() {
    await this.resolveToken()
    return this.baidu()
  }

  send(message) {
    const text = JSON.stringify(message)
    this.stdout.write(`${text}\n`)
  }

  error(id, code, message) {
    this.send({ jsonrpc: '2.0', id, error: { code, message: redact(message) } })
  }

  result(id, result) {
    this.send({ jsonrpc: '2.0', id, result })
  }

  async handle(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return
    const { id, method, params } = message
    const isNotification = id === undefined
    try {
      if (method === 'initialize') {
        this.initialized = true
        this.result(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'HDS × Baidu Netdisk tools. Destructive operations require explicit confirmation. All local writes are restricted to approved drives and refuse C:.',
        })
        return
      }
      if (method === 'notifications/initialized') return
      if (method === 'ping') {
        this.result(id, {})
        return
      }
      if (method === 'tools/list') {
        this.result(id, { tools: TOOL_DEFINITIONS })
        return
      }
      if (method === 'tools/call') {
        if (!this.initialized) throw new HdsBaiduError('not-initialized', 'initialize must be called first')
        const name = params?.name
        const args = params?.arguments ?? {}
        const output = await this.callTool(name, args)
        this.result(id, {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: false,
        })
        return
      }
      if (method === 'resources/list') {
        this.result(id, { resources: [] })
        return
      }
      if (method === 'prompts/list') {
        this.result(id, { prompts: [] })
        return
      }
      if (method === 'logging/setLevel') {
        this.result(id, {})
        return
      }
      if (!isNotification) this.error(id, -32601, `unsupported method: ${method}`)
    } catch (error) {
      this.logger?.warn('MCP tool failed', { method, code: error?.code, message: error?.message })
      if (isNotification) return
      if (method === 'tools/call') {
        this.result(id, {
          content: [{ type: 'text', text: redact(error?.message ?? error) }],
          isError: true,
        })
      } else {
        this.error(id, -32000, error?.message ?? String(error))
      }
    }
  }

  /**
   * @param {string} name
   * @param {any} args
   */
  async callTool(name, args) {
    // Re-read the credential before every tool call. HDS spawns this server once
    // and keeps it for the life of the app, while `token login` may run
    // afterwards; resolving only at startup left every tool reporting "not
    // configured" until HDS restarted. `hds_baidu_status` must also work when
    // nothing is on disk, so it resolves quietly and reports the truth.
    await this.resolveToken({ quiet: name === 'hds_baidu_status' })
    switch (name) {
      case 'hds_baidu_status':
        return configSummary(this.config, this.token)
      case 'hds_baidu_doctor': {
        const result = await this.baidu().doctor(this.config.remoteRoot)
        return { ...result, remoteRoot: this.config.remoteRoot }
      }
      case 'hds_baidu_list': {
        const remote = assertRemoteUnderRoot(this.config, args.path)
        const entries = args.recursive
          ? await this.baidu().listAll(remote)
          : await this.baidu().list(remote)
        return {
          path: remote,
          count: entries.length,
          entries: entries.slice(0, 500).map(entry => ({
            path: entry.path,
            name: entry.server_filename,
            isDirectory: Number(entry.isdir) === 1,
            size: Number(entry.size ?? 0),
            md5: entry.md5,
            fsid: entry.fs_id ?? entry.fsid,
          })),
          truncated: entries.length > 500,
        }
      }
      case 'hds_baidu_upload': {
        const local = await resolveLocalPathChecked(args.localPath, this.config.local)
        const remoteDir = assertRemoteUnderRoot(this.config, args.remoteDir)
        const result = await this.baidu().upload(local, remoteDir, {
          ondup: args.overwrite === false ? 'fail' : 'overwrite',
        })
        return result
      }
      case 'hds_baidu_download': {
        const remote = assertRemoteUnderRoot(this.config, args.remotePath)
        const local = await resolveLocalPathChecked(args.localPath, this.config.local)
        const result = await this.baidu().download(remote, local)
        return result
      }
      case 'hds_project_sync_plan': {
        const engine = await this.syncEngine(args.localDir, args.remoteDir)
        const plan = await engine.plan({ direction: args.direction ?? 'both' })
        return summarizePlan(plan)
      }
      case 'hds_project_sync_apply': {
        if (args.confirm !== true) throw new HdsBaiduError('confirmation-required', 'project sync apply requires confirm=true')
        const engine = await this.syncEngine(args.localDir, args.remoteDir)
        const plan = await engine.plan({ direction: args.direction ?? 'push' })
        const result = await engine.apply(plan)
        return { ...result, planSummary: plan.summary }
      }
      case 'hds_mirror_prepare': {
        const remote = assertRemoteUnderRoot(this.config, args.remoteDir)
        if (!/^[A-Za-z0-9._-]+$/.test(args.name ?? '')) {
          throw new HdsBaiduError('invalid-name', 'mirror name may contain only letters, digits, dot, underscore and hyphen')
        }
        const local = await resolveLocalPathChecked(path.join(this.config.local.mirrorDir, args.name), this.config.local)
        await ensureRealDirectory(local)
        const engine = new SyncEngine({
          client: this.baidu(),
          config: this.config,
          localRoot: local,
          remoteRoot: remote,
        })
        const plan = await engine.plan({ direction: 'pull' })
        const result = await engine.apply(plan)
        return {
          localPath: local,
          remoteDir: remote,
          downloaded: result.counts.downloaded,
          conflicts: result.counts.conflicts,
          next: 'Add this localPath as an HDS workspace. Run the CLI watch command for continuous push/pull.',
        }
      }
      case 'hds_backup': {
        const engine = new BackupEngine({ client: this.baidu(), config: this.config, logger: this.logger })
        if (args.action === 'list') return engine.list()
        const plan = await engine.plan({ projects: args.projects })
        if (args.action === 'plan') return summarizeBackupPlan(plan)
        if (args.confirm !== true) throw new HdsBaiduError('confirmation-required', 'backup run requires confirm=true')
        return engine.apply(plan)
      }
      case 'hds_restore': {
        const backup = new BackupEngine({ client: this.baidu(), config: this.config, logger: this.logger })
        const restore = new RestoreEngine({ client: this.baidu(), config: this.config, backupEngine: backup, logger: this.logger })
        const plan = await restore.plan(args.snapshotId, { mapping: args.mapping })
        const digest = await restorePlanDigest(restore, plan)
        if (args.action === 'plan') {
          return {
            ...plan,
            planDigest: digest,
            entries: plan.entries.slice(0, 500).map(entry => ({
              source: entry.source,
              relative: entry.relative,
              target: entry.target,
              size: entry.size,
              action: entry.action,
            })),
            truncated: plan.entries.length > 500,
          }
        }
        if (args.confirm !== true) throw new HdsBaiduError('confirmation-required', 'restore apply requires confirm=true')
        return restore.apply(plan, { confirm: true, planDigest: args.planDigest ?? digest })
      }
      case 'hds_project_upload': {
        if (args.confirm !== true) throw new HdsBaiduError('confirmation-required', 'project upload requires confirm=true')
        const local = await resolveLocalPathChecked(args.localDir, this.config.local)
        const remote = assertRemoteUnderRoot(this.config, args.remoteDir)
        const { promisify } = await import('node:util')
        const { execFile } = await import('node:child_process')
        const uploader = new ProjectUploader({
          client: this.baidu(),
          config: this.config,
          logger: this.logger,
          execFile: promisify(execFile),
        })
        const plan = await uploader.plan({
          project: local,
          remoteDir: remote,
          includeGitBundle: args.includeGitBundle !== false,
        })
        const result = await uploader.apply(plan)
        return {
          ok: result.ok,
          remoteDir: remote,
          uploaded: result.sync.counts.uploaded,
          skipped: result.sync.counts.skipped,
          conflicts: result.sync.counts.conflicts,
          bundle: result.bundle,
          next: 'Use hds_project_download on another machine to materialize this project.',
        }
      }
      case 'hds_project_download': {
        const remote = assertRemoteUnderRoot(this.config, args.remoteDir)
        if (!/^[A-Za-z0-9._-]+$/.test(args.name ?? '')) {
          throw new HdsBaiduError('invalid-name', 'name may contain only letters, digits, dot, underscore and hyphen')
        }
        const local = await resolveLocalPathChecked(path.join(this.config.local.mirrorDir, args.name), this.config.local)
        await ensureRealDirectory(local)
        const engine = new SyncEngine({
          client: this.baidu(),
          config: this.config,
          localRoot: local,
          remoteRoot: remote,
          logger: this.logger,
        })
        const plan = await engine.plan({ direction: 'pull' })
        const result = await engine.apply(plan)
        return {
          localPath: local,
          remoteDir: remote,
          downloaded: result.counts.downloaded,
          conflicts: result.counts.conflicts,
          next: 'Add localPath as an HDS workspace, then run the CLI watch command for continuous sync.',
        }
      }
      case 'hds_mirror_status': {
        const local = await resolveLocalPathChecked(args.localDir, this.config.local)
        const remote = assertRemoteUnderRoot(this.config, args.remoteDir)
        const id = syncId(local, remote)
        const state = await readMirrorState(mirrorStatePath(this.config.local.stateDir, id))
        return { id, description: describeMirrorState(state), state }
      }
      case 'hds_baidu_mkdir': {
        const remote = assertRemoteUnderRoot(this.config, args.path)
        await this.baidu().ensureDir(remote)
        return { path: remote, created: true }
      }
      case 'hds_baidu_delete': {
        if (this.config.mcp.allowDestructiveTools !== true) {
          throw new HdsBaiduError('tool-disabled', 'remote deletion is disabled; set mcp.allowDestructiveTools=true in config.json')
        }
        if (args.confirm !== true) throw new HdsBaiduError('confirmation-required', 'remote delete requires confirm=true')
        const paths = args.paths.map(entry => assertRemoteUnderRoot(this.config, entry))
        return this.baidu().remove(paths, { force: true })
      }
      default:
        throw new HdsBaiduError('unknown-tool', `unknown tool: ${name}`)
    }
  }

  async syncEngine(localDir, remoteDir) {
    const local = await resolveLocalPathChecked(localDir, this.config.local)
    await ensureRealDirectory(local)
    const remote = assertRemoteUnderRoot(this.config, remoteDir)
    return new SyncEngine({
      client: this.baidu(),
      config: this.config,
      localRoot: local,
      remoteRoot: remote,
      logger: this.logger,
    })
  }

  /**
   * Read newline-delimited JSON-RPC frames until EOF.
   */
  async serve() {
    const reader = createInterface({ input: this.stdin, crlfDelay: Infinity, terminal: false })
    for await (const line of reader) {
      if (!line.trim()) continue
      if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
        this.error(null, -32600, 'message too large')
        continue
      }
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.error(null, -32700, 'parse error')
        continue
      }
      if (Array.isArray(message)) {
        for (const item of message) await this.handle(item)
      } else {
        await this.handle(message)
      }
    }
  }
}

function summarizePlan(plan) {
  return {
    id: plan.id,
    direction: plan.direction,
    localRoot: plan.localRoot,
    remoteRoot: plan.remoteRoot,
    generatedAt: plan.generatedAt,
    summary: plan.summary,
    actions: plan.actions.slice(0, 300).map(action => ({
      type: action.type,
      relative: action.relative,
      reason: action.reason,
      size: action.local?.size ?? action.remote?.size,
    })),
    truncated: plan.actions.length > 300,
    conflicts: plan.conflicts,
    next: 'Call hds_project_sync_apply with confirm=true to apply. Conflicts are always skipped.',
  }
}

function summarizeBackupPlan(plan) {
  return {
    snapshotId: plan.snapshotId,
    generatedAt: plan.generatedAt,
    summary: plan.summary,
    sources: plan.sources,
    sample: plan.files.slice(0, 100).map(file => ({
      source: file.source,
      relative: file.relative,
      size: file.size,
      sha256: file.sha256,
      needsUpload: file.needsUpload,
    })),
    truncated: plan.files.length > 100,
    next: 'Call hds_backup with action=run and confirm=true to upload.',
  }
}

/**
 * Start the MCP server using the current process streams.
 * @param {{configPath?: string}} [options]
 */
export async function startMcpServer(options = {}) {
  const config = await loadConfig({ configPath: options.configPath })
  await useApprovedTempDir({
    root: path.join(config.local.stagingDir, '..', 'tmp'),
    allowedDrives: config.local.allowedDrives,
  })
  const token = await getAccessToken(config)
  const logger = createLogger({
    level: process.env.HDS_BAIDU_LOG_LEVEL ?? 'warn',
    file: path.join(config.local.stateDir, 'logs', 'mcp.log'),
    quiet: true,
  })
  const server = new McpServer({ config, token, logger })
  await server.serve()
  await logger.close()
}
