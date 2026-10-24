import path from 'node:path'
import fsp from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { loadConfig, getAccessToken, saveAccessToken, configSummary, PROJECT_ROOT } from '../src/config.mjs'
import { BaiduNetdiskClient } from '../src/baidu-api.mjs'
import { SyncEngine } from '../src/sync-engine.mjs'
import { BackupEngine } from '../src/backup-engine.mjs'
import { RestoreEngine, restorePlanDigest } from '../src/restore-engine.mjs'
import { resolveLocalPathChecked, normalizeRemotePath } from '../src/paths.mjs'
import { ensureRealDirectory, syncId } from '../src/local-tree.mjs'
import { createLogger } from '../src/log.mjs'
import { HdsBaiduError } from '../src/errors.mjs'
import { startMcpServer } from '../src/mcp-server.mjs'
import { tempDirAudit, useApprovedTempDir } from '../src/temp.mjs'
import { MirrorDaemon, describeMirrorState, mirrorStatePath, readMirrorState } from '../src/watch.mjs'
import {
  appCredentialsPath,
  authorizeUrl,
  exchangeCode,
  loadCredentials,
  refreshAccessToken,
  resolveAppCredentials,
  saveAppCredentials,
  saveCredentials,
  tokenStatus,
} from '../src/oauth.mjs'
import {
  BackupScheduler,
  directorySummary,
  installScheduledTask,
  queryScheduledTask,
  removeScheduledTask,
  schedulerStatePath,
} from '../src/scheduler.mjs'

/**
 * Print safe JSON to stdout for CLI consumers.
 * @param {unknown} value
 */
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function usage() {
  return `hds-baidu-bridge ${'0.1.0'}

Usage:
  node bin/hds-baidu.mjs doctor
  node bin/hds-baidu.mjs token app --app-key <AppKey> --secret-key <SecretKey>
  node bin/hds-baidu.mjs token login [--code <code>]
  node bin/hds-baidu.mjs token refresh
  node bin/hds-baidu.mjs token set [--token <access token>]
  node bin/hds-baidu.mjs token status
  node bin/hds-baidu.mjs ls <remote-path> [--recursive]
  node bin/hds-baidu.mjs mkdir <remote-path>
  node bin/hds-baidu.mjs upload <local-file> <remote-dir>
  node bin/hds-baidu.mjs download <remote-file> <local-file>
  node bin/hds-baidu.mjs sync plan <local-dir> <remote-dir> [--direction push|pull|both]
  node bin/hds-baidu.mjs sync apply <local-dir> <remote-dir> [--direction push|pull|both] --apply
  node bin/hds-baidu.mjs mirror <name> <remote-dir> [--apply]
  node bin/hds-baidu.mjs mirror status <local-dir> <remote-dir>
  node bin/hds-baidu.mjs backup plan [--project <dir>]
  node bin/hds-baidu.mjs backup run [--project <dir>] --apply
  node bin/hds-baidu.mjs backup list
  node bin/hds-baidu.mjs backup watch [--interval 1h] [--project <dir>]
  node bin/hds-baidu.mjs backup task [--every 60] [--status] [--remove] [--apply]
  node bin/hds-baidu.mjs restore plan <snapshot-id> [--map-hds-home <dir>] [--map-project <name>=<dir>]
  node bin/hds-baidu.mjs restore apply <snapshot-id> --plan-digest <digest> --apply [--map-hds-home <dir>] [--map-project <name>=<dir>]
  node bin/hds-baidu.mjs watch <local-dir> <remote-dir> [--interval 60s] [--direction both]
  node bin/hds-baidu.mjs project plan <local-dir> <remote-dir> [--no-bundle]
  node bin/hds-baidu.mjs project apply <local-dir> <remote-dir> --apply [--no-bundle]
  node bin/hds-baidu.mjs manifest [--dir <dir>]
  node bin/hds-baidu.mjs install mcp|storage|domain [--apply]
  node bin/hds-baidu.mjs install status
  node bin/hds-baidu.mjs install rollback --apply
  node bin/hds-baidu.mjs mcp

All writes are restricted to approved drives (default G:) and C: is always refused.
`
}

/**
 * Tiny flag parser; no dependency and no shell execution.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item.startsWith('--')) {
      const name = item.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        index += 1
      }
    } else {
      positionals.push(item)
    }
  }
  return { positionals, flags }
}

function parseDuration(value) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(String(value))
  if (!match) throw new HdsBaiduError('usage', `invalid duration: ${value} (use 30s, 5m, 2h)`)
  const amount = Number(match[1])
  const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]
  return amount * unit
}

/**
 * Resolve project paths from flags and validate each one against the policy.
 * @param {any} config
 * @param {string[]} projects
 */
async function resolveProjects(config, projects) {
  return Promise.all((projects ?? []).map(project =>
    resolveLocalPathChecked(project, config.local)))
}

async function main(argv) {
  const { positionals, flags } = parseArgs(argv)
  const command = positionals[0]
  if (!command || command === 'help' || command === '--help' || flags.help) {
    process.stdout.write(usage())
    return 0
  }
  const config = await loadConfig({ configPath: flags.config })
  const tempRoot = await useApprovedTempDir({
    root: path.join(config.local.stagingDir, '..', 'tmp'),
    allowedDrives: config.local.allowedDrives,
  })
  const logger = createLogger({
    level: flags.verbose ? 'debug' : 'info',
    file: path.join(config.local.stateDir, 'logs', 'cli.log'),
  })
  if (command === 'mcp') {
    await startMcpServer({ configPath: flags.config })
    return 0
  }
  const token = await getAccessToken(config)
  const client = () => {
    if (!token) throw new HdsBaiduError('token-missing', 'Baidu token missing. Run: node bin/hds-baidu.mjs token set')
    return new BaiduNetdiskClient({ accessToken: token, timeoutMs: config.storageBackend.requestTimeoutMs })
  }

  try {
    if (command === 'doctor') {
      const summary = configSummary(config, token)
      const environment = {
        node: process.version,
        platform: process.platform,
        tempDir: tempRoot,
        tempAudit: tempDirAudit(config.local.allowedDrives),
        cwd: process.cwd(),
      }
      const { directorySummary } = await import('../src/scheduler.mjs')
      const localChecks = {
        hdsSessions: await directorySummary(config.hds.sessionsDir),
        hdsStorages: await directorySummary(config.hds.storagesDir),
        state: await directorySummary(config.local.stateDir),
        mirrors: await directorySummary(config.local.mirrorDir),
      }
      if (!token) {
        print({ ...summary, environment, localChecks, ok: false, reason: 'token missing' })
        return 2
      }
      const live = await client().doctor(config.remoteRoot)
      print({ ...summary, environment, localChecks, ok: true, live })
      return 0
    }
    if (command === 'token') {
      const action = positionals[1]
      const credentialsFile = path.join(config.local.stateDir, 'credentials.json')
      if (action === 'status') {
        const stored = await loadCredentials(credentialsFile)
        print({
          configured: Boolean(token),
          source: process.env.BAIDU_NETDISK_ACCESS_TOKEN ? 'environment' : token ? 'state file' : 'none',
          stored: stored
            ? {
              fingerprint: stored.fingerprint,
              expiresAt: stored.expiresAt,
              scope: stored.scope,
              hasRefreshToken: Boolean(stored.refreshToken),
            }
            : undefined,
          validity: tokenStatus(stored),
        })
        return 0
      }
      if (action === 'app') {
        // Store AppKey/SecretKey once so later `login`/`refresh` need no flags.
        const appKey = flags['app-key'] ?? flags['client-id'] ?? process.env.BAIDU_APP_KEY
        const secretKey = flags['secret-key'] ?? flags['client-secret'] ?? process.env.BAIDU_SECRET_KEY
        if (!appKey || !secretKey) {
          throw new HdsBaiduError(
            'oauth-config',
            'app needs --app-key/--secret-key (or BAIDU_APP_KEY/BAIDU_SECRET_KEY)',
          )
        }
        const saved = await saveAppCredentials(config.local.stateDir, {
          appId: flags['app-id'],
          appKey,
          secretKey,
          signKey: flags['sign-key'],
        })
        print({
          ok: true,
          file: appCredentialsPath(config.local.stateDir),
          appId: saved.appId,
          appKeyFingerprint: saved.appKeyFingerprint,
          note: 'Stored with owner-only permissions on the approved drive. Never committed or backed up.',
        })
        return 0
      }
      if (action === 'login') {
        // Interactive authorization-code flow. The secret is never printed and
        // the token is written only after a successful exchange.
        const resolved = await resolveAppCredentials({
          stateDir: config.local.stateDir,
          clientId: flags['client-id'],
          clientSecret: flags['client-secret'],
        })
        const clientId = resolved.clientId
        const clientSecret = resolved.clientSecret
        if (!clientId || !clientSecret) {
          throw new HdsBaiduError(
            'oauth-config',
            'login needs app credentials: run `token app --app-key ... --secret-key ...`, pass --client-id/--client-secret, or set BAIDU_APP_KEY/BAIDU_SECRET_KEY',
          )
        }
        const redirectUri = flags['redirect-uri'] ?? 'oob'
        // `--code` keeps the flow usable from a script or a non-interactive
        // shell, where stdin closes immediately and a prompt would hang.
        const suppliedCode = flags.code
        const authorization = authorizeUrl({ clientId, redirectUri, scope: flags.scope })
        print({
          step: 'authorize',
          open: authorization.url,
          note: 'Open the URL, approve the scope, then paste the code back here (or pass it with --code).',
          state: authorization.state,
          scope: authorization.scope,
        })
        let pasted = suppliedCode
        if (!pasted) {
          if (process.stdin.isTTY !== true) {
            throw new HdsBaiduError(
              'oauth-noninteractive',
              'no terminal to prompt on. Open the URL above, then re-run with --code <authorization code>',
            )
          }
          const terminal = createInterface({ input: process.stdin, output: process.stdout })
          try {
            pasted = await terminal.question('Authorization code (or redirect URL): ')
          } finally {
            terminal.close()
          }
        }
        if (!String(pasted ?? '').trim()) {
          throw new HdsBaiduError('oauth-code', 'no authorization code provided')
        }
        const exchanged = await exchangeCode({ clientId, clientSecret, code: pasted, redirectUri })
        const saved = await saveCredentials(credentialsFile, exchanged)
        print({
          ok: true,
          file: credentialsFile,
          fingerprint: saved.fingerprint,
          expiresAt: saved.expiresAt,
          scope: saved.scope,
          hasRefreshToken: Boolean(saved.refreshToken),
          note: 'Token stored on the approved drive. Run `doctor` to confirm.',
        })
        return 0
      }
      if (action === 'refresh') {
        const stored = await loadCredentials(credentialsFile)
        if (!stored?.refreshToken) {
          throw new HdsBaiduError('oauth-refresh', 'no refresh token stored; run `token login` once')
        }
        const resolved = await resolveAppCredentials({
          stateDir: config.local.stateDir,
          clientId: flags['client-id'],
          clientSecret: flags['client-secret'],
        })
        if (!resolved.clientId || !resolved.clientSecret) {
          throw new HdsBaiduError(
            'oauth-config',
            'refresh needs app credentials: run `token app --app-key ... --secret-key ...`, or pass --client-id/--client-secret',
          )
        }
        const refreshed = await refreshAccessToken({
          clientId: resolved.clientId,
          clientSecret: resolved.clientSecret,
          refreshToken: stored.refreshToken,
        })
        const saved = await saveCredentials(credentialsFile, refreshed)
        print({ ok: true, fingerprint: saved.fingerprint, expiresAt: saved.expiresAt })
        return 0
      }
      if (action === 'set') {
        // --token first so the value never has to sit in a shell history prompt,
        // and so this works without a TTY.
        let value = flags.token ?? (process.env.BAIDU_NETDISK_ACCESS_TOKEN || undefined)
        if (!value) {
          if (process.stdin.isTTY !== true) {
            throw new HdsBaiduError(
              'oauth-noninteractive',
              'no terminal to prompt on. Re-run with --token <access token>, or set BAIDU_NETDISK_ACCESS_TOKEN',
            )
          }
          const terminal = createInterface({ input: process.stdin, output: process.stdout })
          try {
            value = await terminal.question('Baidu Netdisk access token (input is visible; paste then Enter): ')
          } finally {
            terminal.close()
          }
        }
        const trimmed = String(value ?? '').trim()
        if (!trimmed) throw new HdsBaiduError('oauth-code', 'no access token provided')
        const file = await saveAccessToken(config, trimmed)
        print({ ok: true, file, note: 'Token stored under the approved G-drive state directory. Never commit it.' })
        return 0
      }
      throw new HdsBaiduError('usage', 'token action must be app, login, refresh, set or status')
    }
    if (command === 'ls') {
      const remote = normalizeRemotePath(positionals[1] ?? config.remoteRoot)
      const entries = flags.recursive ? await client().listAll(remote) : await client().list(remote)
      print({ path: remote, count: entries.length, entries })
      return 0
    }
    if (command === 'mkdir') {
      const remote = normalizeRemotePath(positionals[1] ?? '')
      await client().ensureDir(remote)
      print({ ok: true, path: remote })
      return 0
    }
    if (command === 'upload') {
      const local = await resolveLocalPathChecked(positionals[1] ?? '', config.local)
      const remoteDir = normalizeRemotePath(positionals[2] ?? config.remoteRoot)
      const result = await client().upload(local, remoteDir)
      print(result)
      return 0
    }
    if (command === 'download') {
      const remote = normalizeRemotePath(positionals[1] ?? '')
      const local = await resolveLocalPathChecked(positionals[2] ?? '', config.local)
      const result = await client().download(remote, local)
      print(result)
      return 0
    }
    if (command === 'sync') {
      const action = positionals[1]
      const localDir = await resolveLocalPathChecked(positionals[2] ?? '', config.local)
      await ensureRealDirectory(localDir)
      const remoteDir = normalizeRemotePath(positionals[3] ?? '')
      const engine = new SyncEngine({ client: client(), config, localRoot: localDir, remoteRoot: remoteDir, logger })
      const direction = flags.direction ?? 'both'
      const plan = await engine.plan({ direction })
      if (action === 'plan') {
        print(plan)
        return 0
      }
      if (action === 'apply') {
        if (flags.apply !== true) throw new HdsBaiduError('confirmation-required', 'sync apply requires --apply')
        print(await engine.apply(plan))
        return 0
      }
      throw new HdsBaiduError('usage', 'sync action must be plan or apply')
    }
    if (command === 'backup') {
      const action = positionals[1] ?? 'plan'
      const projects = await resolveProjects(config, flags.project ? [flags.project] : [])
      if (action === 'task') {
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const run = promisify(execFile)
        const dryRun = flags.apply !== true
        const running = flags.status === true
          ? await queryScheduledTask({ taskName: flags.name, execFile: run })
          : flags.remove === true
            ? await removeScheduledTask({ taskName: flags.name, dryRun, execFile: run })
            : await installScheduledTask({
              nodePath: process.execPath,
              scriptPath: path.join(PROJECT_ROOT, 'bin', 'hds-baidu.mjs'),
              workingDirectory: PROJECT_ROOT,
              taskName: flags.name,
              everyMinutes: flags.every ? Number(flags.every) : 60,
              dryRun,
              execFile: run,
            })
        print(running)
        return 0
      }
      const engine = new BackupEngine({ client: client(), config, logger })
      if (action === 'list') {
        print(await engine.list())
        return 0
      }
      if (action === 'watch') {
        const intervalMs = parseDuration(flags.interval ?? '1h')
        const scheduler = new BackupScheduler({
          engine,
          intervalMs,
          stateFile: schedulerStatePath(config.local.stateDir),
          projects,
          logger,
        })
        print({ ok: true, mode: 'backup-scheduler', intervalMs, projects, stateFile: scheduler.stateFile })
        await scheduler.start()
        return 0
      }
      const plan = await engine.plan({ projects })
      if (action === 'plan') {
        print({ ...plan, files: plan.files.map(file => ({ ...file, absolute: undefined })) })
        return 0
      }
      if (action === 'run') {
        if (flags.apply !== true) throw new HdsBaiduError('confirmation-required', 'backup run requires --apply')
        print(await engine.apply(plan))
        return 0
      }
      throw new HdsBaiduError('usage', 'backup action must be plan, run or list')
    }
    if (command === 'restore') {
      const action = positionals[1]
      const snapshotId = positionals[2]
      if (!snapshotId) throw new HdsBaiduError('usage', 'snapshot id required')
      const mapping = {}
      if (flags['map-hds-home']) mapping['hds-home'] = await resolveLocalPathChecked(flags['map-hds-home'], config.local)
      if (flags['map-project']) {
        const equals = String(flags['map-project']).indexOf('=')
        if (equals < 1) throw new HdsBaiduError('usage', '--map-project must be name=path')
        const name = String(flags['map-project']).slice(0, equals)
        const target = await resolveLocalPathChecked(String(flags['map-project']).slice(equals + 1), config.local)
        mapping[`project:${name}`] = target
      }
      const backup = new BackupEngine({ client: client(), config, logger })
      const engine = new RestoreEngine({ client: client(), config, backupEngine: backup, logger })
      const plan = await engine.plan(snapshotId, { mapping })
      const digest = await restorePlanDigest(engine, plan)
      if (action === 'plan') {
        print({ ...plan, planDigest: digest })
        return 0
      }
      if (action === 'apply') {
        if (flags.apply !== true) throw new HdsBaiduError('confirmation-required', 'restore apply requires --apply')
        print(await engine.apply(plan, { confirm: true, planDigest: flags['plan-digest'] ?? digest }))
        return 0
      }
      throw new HdsBaiduError('usage', 'restore action must be plan or apply')
    }
    if (command === 'watch') {
      const localDir = await resolveLocalPathChecked(positionals[1] ?? '', config.local)
      await ensureRealDirectory(localDir)
      const remoteDir = normalizeRemotePath(positionals[2] ?? '')
      const direction = flags.direction ?? 'both'
      const remoteIntervalMs = parseDuration(flags.interval ?? '5m')
      const engine = new SyncEngine({ client: client(), config, localRoot: localDir, remoteRoot: remoteDir, logger })
      const daemon = new MirrorDaemon({
        engine,
        localRoot: localDir,
        remoteRoot: remoteDir,
        stateFile: mirrorStatePath(config.local.stateDir, engine.id),
        direction,
        remoteIntervalMs,
        logger,
      })
      print({ ok: true, mode: 'mirror-daemon', localRoot: localDir, remoteDir, direction, remoteIntervalMs, stateFile: daemon.stateFile })
      await daemon.start()
      return 0
    }
    if (command === 'mirror') {
      const action = positionals[1]
      if (action === 'status') {
        const localDir = await resolveLocalPathChecked(positionals[2] ?? '', config.local)
        const remoteDir = normalizeRemotePath(positionals[3] ?? '')
        const id = syncId(localDir, remoteDir)
        const state = await readMirrorState(mirrorStatePath(config.local.stateDir, id))
        print({ id, summary: describeMirrorState(state), state })
        return 0
      }
      const name = positionals[1]
      if (!/^[A-Za-z0-9._-]+$/.test(name ?? '')) throw new HdsBaiduError('usage', 'mirror name invalid')
      const remoteDir = normalizeRemotePath(positionals[2] ?? '')
      const localRoot = await resolveLocalPathChecked(path.join(config.local.mirrorDir, name), config.local)
      await ensureRealDirectory(localRoot)
      const engine = new SyncEngine({ client: client(), config, localRoot, remoteRoot: remoteDir, logger })
      const plan = await engine.plan({ direction: 'pull' })
      print({ localRoot, remoteDir, summary: plan.summary })
      if (flags.apply === true) print(await engine.apply(plan))
      else process.stdout.write('\nDry run. Re-run with --apply to materialize the mirror.\n')
      return 0
    }
    if (command === 'project') {
      const action = positionals[1] ?? 'plan'
      const projectPath = await resolveLocalPathChecked(positionals[2] ?? '', config.local)
      const remoteDir = normalizeRemotePath(positionals[3] ?? '')
      const { ProjectUploader } = await import('../src/project-upload.mjs')
      const { promisify } = await import('node:util')
      const { execFile } = await import('node:child_process')
      const uploader = new ProjectUploader({
        client: client(),
        config,
        logger,
        execFile: promisify(execFile),
      })
      const plan = await uploader.plan({
        project: projectPath,
        remoteDir,
        includeGitBundle: flags['no-bundle'] === true ? false : undefined,
      })
      if (action === 'plan') {
        print({
          project: plan.project,
          remoteDir: plan.remoteDir,
          summary: plan.summary,
          bundle: plan.bundle,
          actions: plan.syncPlan.actions.slice(0, 200).map(item => ({
            type: item.type,
            relative: item.relative,
            reason: item.reason,
          })),
          truncated: plan.syncPlan.actions.length > 200,
        })
        return 0
      }
      if (action === 'apply') {
        if (flags.apply !== true) throw new HdsBaiduError('confirmation-required', 'project apply requires --apply')
        print(await uploader.apply(plan))
        return 0
      }
      throw new HdsBaiduError('usage', 'project action must be plan or apply')
    }
    if (command === 'manifest') {
      const directory = await resolveLocalPathChecked(flags.dir ?? config.local.root, config.local)
      print({
        ...(await directorySummary(directory)),
        stateDir: config.local.stateDir,
        mirrorDir: config.local.mirrorDir,
        stagingDir: config.local.stagingDir,
        hdsHome: config.hds.home,
        backupSources: config.backup.sources,
        backupProjects: config.backup.projects,
      })
      return 0
    }
    if (command === 'install') {
      const { Installer } = await import('../src/installer.mjs')
      const installer = new Installer({ config, logger })
      const target = positionals[1]
      if (target === 'status') {
        const patch = await fsp.readFile(installer.patchFile, 'utf8').catch(() => '')
        const flat = patch.replaceAll("'", '')
        const linkStat = await fsp.lstat(installer.pluginLink()).catch(() => undefined)
        print({
          patchFile: installer.patchFile,
          patchExists: patch !== '',
          mcpInstalled: flat.includes(`id: mcp-${config.mcp.serverName}`),
          storageBackendInstalled: flat.includes('id: storage-baidu'),
          domainUsesBaidu: /id: storage-domain[\s\S]{0,200}?backend: baidu/.test(flat),
          pluginLink: installer.pluginLink(),
          pluginLinked: Boolean(linkStat?.isSymbolicLink()),
          pluginSource: installer.pluginSource(),
          node: process.execPath,
        })
        return 0
      }
      if (target === 'rollback') {
        if (flags.apply !== true) {
          print({ ok: false, dryRun: true, note: 'install rollback requires --apply' })
          return 1
        }
        print(await installer.rollback())
        return 0
      }
      if (!['mcp', 'storage', 'domain'].includes(target)) {
        throw new HdsBaiduError('usage', 'install target must be mcp, storage, domain, status or rollback')
      }
      const plan = await installer.plan(target)
      if (flags.apply !== true) {
        print({ ...plan, dryRun: true, note: 're-run with --apply to write these changes' })
        return 0
      }
      print(await installer.apply(plan))
      return 0
    }
    throw new HdsBaiduError('usage', `unknown command: ${command}`)
  } finally {
    await logger.close()
  }
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code
}).catch(error => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error?.code ?? 'error',
    message: error?.message ?? String(error),
  })}\n`)
  process.exitCode = 1
})
