import path from 'node:path'
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hashFile } from './baidu-api.mjs'
import { ensureRealDirectory, publishFile } from './local-tree.mjs'
import { HdsBaiduError } from './errors.mjs'
import { resolveLocalPathChecked } from './paths.mjs'
import { timestamp } from './log.mjs'

/**
 * Restore planner and applier for a backup snapshot.
 *
 * The plan is always produced first. Applying requires the caller to re-supply
 * the exact plan object and an explicit confirmation, so a stale or edited
 * plan cannot silently overwrite local state.
 */
export class RestoreEngine {
  /**
   * @param {{client: any, config: any, backupEngine: any, logger?: any}} options
   */
  constructor(options) {
    this.client = options.client
    this.config = options.config
    this.backupEngine = options.backupEngine
    this.logger = options.logger
  }

  /**
   * Decide the local target for a manifest entry.
   * @param {any} entry
   * @param {any} manifest
   * @param {Record<string,string>} mapping
   */
  targetFor(entry, manifest, mapping) {
    if (entry.source === 'hds-sessions') {
      return path.join(this.mapRoot(manifest, mapping, 'hds-home'), 'sessions', entry.relative)
    }
    if (entry.source === 'hds-workspace' || entry.source === 'hds-projection-cache') {
      return path.join(this.mapRoot(manifest, mapping, 'hds-home'), 'storages', entry.relative)
    }
    if (entry.source === 'hds-profile') {
      return path.join(this.mapRoot(manifest, mapping, 'hds-home'), 'profiles', this.config.hds.profile, entry.relative)
    }
    if (entry.source.startsWith('project-')) {
      const projectName = entry.source.slice('project-'.length)
      const mapped = mapping[`project:${projectName}`]
      if (mapped) return path.join(mapped, entry.relative)
      return path.join(this.config.local.root, 'restored-projects', projectName, entry.relative)
    }
    throw new HdsBaiduError('unknown-source', `unknown backup source: ${entry.source}`)
  }

  mapRoot(manifest, mapping, key) {
    if (mapping[key]) return mapping[key]
    return this.config.hds.home
  }

  /**
   * Build a plan with conflicts and required bytes.
   * @param {string} snapshotId
   * @param {{mapping?: Record<string,string>}} [options]
   */
  async plan(snapshotId, options = {}) {
    const manifest = await this.backupEngine.manifest(snapshotId)
    const mapping = options.mapping ?? {}
    const entries = []
    for (const file of manifest.files) {
      const target = this.targetFor(file, manifest, mapping)
      await resolveLocalPathChecked(target, this.config.local)
      const existing = await fsp.stat(target).catch(error => {
        if (error?.code === 'ENOENT') return undefined
        throw error
      })
      entries.push({
        ...file,
        target,
        exists: Boolean(existing),
        existingSize: existing?.size,
        action: existing ? 'overwrite' : 'create',
      })
    }
    const duplicates = new Set()
    const seen = new Set()
    for (const entry of entries) {
      const key = entry.target.toLowerCase()
      if (seen.has(key)) duplicates.add(entry.target)
      seen.add(key)
    }
    if (duplicates.size) {
      throw new HdsBaiduError('restore-collision', `multiple backup entries target the same local path: ${[...duplicates].join(', ')}`)
    }
    return {
      snapshotId,
      manifestCreatedAt: manifest.createdAt,
      generatedAt: new Date().toISOString(),
      mapping,
      entries,
      summary: {
        files: entries.length,
        overwrite: entries.filter(entry => entry.action === 'overwrite').length,
        create: entries.filter(entry => entry.action === 'create').length,
        bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      },
    }
  }

  /**
   * Apply a previously generated plan. Existing files are copied to a
   * restorable local safety directory before replacement.
   * @param {Awaited<ReturnType<RestoreEngine['plan']>>} plan
   * @param {{confirm: boolean, planDigest: string}} options
   */
  async apply(plan, options) {
    if (!options?.confirm) throw new HdsBaiduError('confirmation-required', 'restore apply requires confirm: true')
    const digest = await restorePlanDigest(this, plan)
    if (!options.planDigest || options.planDigest !== digest) {
      throw new HdsBaiduError('plan-mismatch', `planDigest must be ${digest}`)
    }
    const safetyRoot = path.join(this.config.local.stateDir, 'restore-safety', timestamp())
    const stagingRoot = path.join(this.config.local.stagingDir, 'restore', plan.snapshotId, randomUUID())
    await ensureRealDirectory(stagingRoot)
    const prepared = []
    const failures = []
    for (const entry of plan.entries) {
      try {
        await resolveLocalPathChecked(entry.target, this.config.local)
        const objectFile = path.join(stagingRoot, entry.sha256)
        await ensureRealDirectory(path.dirname(objectFile))
        await this.client.download(entry.object, objectFile, { resume: false })
        const actual = await hashFile(objectFile, 'sha256')
        if (actual !== entry.sha256) {
          throw new HdsBaiduError('restore-corrupt', `SHA-256 mismatch for ${entry.relative}`)
        }
        prepared.push({ entry, objectFile })
      } catch (error) {
        failures.push({ relative: entry.relative, code: error.code, message: error.message })
      }
    }
    if (failures.length) return { ok: false, stage: 'download', failures, safetyRoot: undefined }

    for (const { entry, objectFile } of prepared) {
      const existing = await fsp.stat(entry.target).catch(error => {
        if (error?.code === 'ENOENT') return undefined
        throw error
      })
      if (existing) {
        const safety = path.join(safetyRoot, entry.source, entry.relative)
        await fsp.mkdir(path.dirname(safety), { recursive: true, mode: 0o700 })
        await fsp.copyFile(entry.target, safety)
        entry.safetyCopy = safety
      }
      await ensureRealDirectory(path.dirname(entry.target))
      await publishFile(objectFile, entry.target)
    }
    const workspaceWarning = this.workspaceWarning(plan)
    return {
      ok: true,
      snapshotId: plan.snapshotId,
      restored: prepared.length,
      safetyRoot,
      warnings: workspaceWarning ? [workspaceWarning] : [],
    }
  }

  workspaceWarning(plan) {
    const hasSessions = plan.entries.some(entry => entry.source === 'hds-sessions')
    if (!hasSessions) return undefined
    return 'Session headers keep their original cwd. Start HDS at the same paths or add the project again in the Workspace UI; this tool intentionally does not rewrite compressed session logs.'
  }
}

/**
 * Resolve the digest asynchronously before applying. Kept separate so callers
 * can display the exact token required by apply.
 * @param {RestoreEngine} engine
 * @param {any} plan
 * @returns {Promise<string>}
 */
export async function restorePlanDigest(engine, plan) {
  const { createHash } = await import('node:crypto')
  const stable = JSON.stringify(plan.entries.map(entry => ({
    target: entry.target,
    sha256: entry.sha256,
    object: entry.object,
  })).sort((left, right) => left.target.localeCompare(right.target)))
  return createHash('sha256').update(stable).digest('hex')
}
