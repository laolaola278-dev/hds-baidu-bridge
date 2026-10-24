import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { SyncEngine } from './sync-engine.mjs'
import { ensureRealDirectory } from './local-tree.mjs'
import { remoteJoin, normalizeRemotePath } from './paths.mjs'
import { hashFile } from './baidu-api.mjs'
import { HdsBaiduError } from './errors.mjs'
import { redact } from './log.mjs'

/**
 * Project upload: the plain-tree half is the normal sync engine, and the git
 * half is a single `git bundle` artifact that preserves full history even
 * though `.git/` itself is excluded from the tree sync.
 *
 * A bundle is created on the approved drive, uploaded as one object, and then
 * removed locally, so nothing large is left behind.
 */
export class ProjectUploader {
  /**
   * @param {{client: any, config: any, logger?: any, execFile?: Function}} options
   */
  constructor(options) {
    this.client = options.client
    this.config = options.config
    this.logger = options.logger
    this.execFile = options.execFile
  }

  /**
   * Detect whether a directory is a git work tree root.
   * @param {string} project
   */
  async isGitRepository(project) {
    const head = path.join(project, '.git', 'HEAD')
    return fsp.stat(head).then(stat => stat.isFile(), () => false)
  }

  /**
   * Build a plan: files to sync plus an optional bundle step.
   * @param {{project: string, remoteDir: string, includeGitBundle?: boolean}} options
   */
  async plan(options) {
    const project = options.project
    const remoteDir = normalizeRemotePath(options.remoteDir)
    const engine = new SyncEngine({
      client: this.client,
      config: this.config,
      localRoot: project,
      remoteRoot: remoteDir,
      logger: this.logger,
    })
    const syncPlan = await engine.plan({ direction: 'push' })
    const isGit = await this.isGitRepository(project)
    const includeBundle = options.includeGitBundle ?? this.config.backup?.includeProjectGitBundle ?? true
    const bundle = isGit && includeBundle
      ? {
        enabled: true,
        name: `${path.basename(project)}.bundle`,
        remotePath: remoteJoin(remoteDir, '_git', `${path.basename(project)}.bundle`),
        note: 'Created during apply; the bundle file itself is not part of the tree sync.',
      }
      : { enabled: false, reason: isGit ? 'disabled-by-config' : 'not-a-git-repository' }
    return {
      project,
      remoteDir,
      engine,
      syncPlan,
      bundle,
      summary: {
        ...syncPlan.summary,
        gitBundle: bundle.enabled,
      },
    }
  }

  /**
   * Apply a project upload plan.
   * @param {Awaited<ReturnType<ProjectUploader['plan']>>} plan
   * @param {{signal?: AbortSignal}} [options]
   */
  async apply(plan, options = {}) {
    const syncResult = await plan.engine.apply(plan.syncPlan, options)
    let bundleResult
    if (plan.bundle.enabled) {
      bundleResult = await this.uploadBundle(plan, options)
    }
    return {
      ok: syncResult.ok && (bundleResult?.ok ?? true),
      project: plan.project,
      remoteDir: plan.remoteDir,
      sync: syncResult,
      bundle: bundleResult,
    }
  }

  /**
   * Create and upload one git bundle.
   * @param {Awaited<ReturnType<ProjectUploader['plan']>>} plan
   * @param {{signal?: AbortSignal}} [options]
   */
  async uploadBundle(plan, options = {}) {
    const stagingDir = path.join(this.config.local.stagingDir, 'bundles')
    await ensureRealDirectory(stagingDir)
    const localBundle = path.join(stagingDir, `${path.basename(plan.project)}-${randomUUID().slice(0, 8)}.bundle`)
    try {
      const created = await this.runGitBundle(plan.project, localBundle, options)
      if (!created.ok) return created
      const sha256 = await hashFile(localBundle, 'sha256')
      const stat = await fsp.stat(localBundle)
      const remotePath = await this.client.uploadAtomic(localBundle, plan.bundle.remotePath)
      this.logger?.info('git bundle uploaded', { remotePath: plan.bundle.remotePath, size: stat.size })
      return {
        ok: true,
        remotePath: plan.bundle.remotePath,
        localPath: remotePath.path ?? plan.bundle.remotePath,
        size: stat.size,
        sha256,
        note: 'Restore with: git clone <downloaded bundle> <dir>',
      }
    } catch (error) {
      return { ok: false, code: error?.code, message: redact(error?.message ?? error) }
    } finally {
      await fsp.rm(localBundle, { force: true }).catch(() => {})
    }
  }

  /**
   * Run `git bundle create` without a shell. Missing git is a soft failure: the
   * tree sync still succeeded, so the upload is reported as partial.
   * @param {string} project
   * @param {string} target
   * @param {{signal?: AbortSignal}} options
   */
  async runGitBundle(project, target, options) {
    const exec = this.execFile
    if (!exec) return { ok: false, code: 'git-unavailable', message: 'no execution backend configured' }
    try {
      await exec('git', ['bundle', 'create', target, '--all'], {
        cwd: project,
        windowsHide: true,
        signal: options.signal,
        maxBuffer: 16 * 1024 * 1024,
      })
      const stat = await fsp.stat(target)
      return { ok: true, size: stat.size }
    } catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? error)
      if (error?.code === 'ENOENT') return { ok: false, code: 'git-unavailable', message: 'git is not installed or not on PATH' }
      return { ok: false, code: 'git-bundle-failed', message: redact(detail.slice(0, 500)) }
    }
  }
}

/**
 * `git bundle create` through a child process, for callers that prefer a
 * streaming child over an exec promisify wrapper.
 * @param {string} project
 * @param {string} target
 */
export async function spawnGitBundle(project, target) {
  const exists = await fsp.stat(path.join(project, '.git')).then(() => true, () => false)
  if (!exists) throw new HdsBaiduError('not-a-git-repository', `not a git repository: ${project}`)
  const child = spawn('git', ['bundle', 'create', target, '--all'], {
    cwd: project,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const code = await new Promise(resolve => child.once('close', resolve))
  if (code !== 0) throw new HdsBaiduError('git-bundle-failed', redact(stderr.slice(0, 500)))
  return { path: target, size: (await fsp.stat(target)).size }
}
