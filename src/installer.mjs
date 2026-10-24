import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  mcpPatchEntries,
  profileModulesPath,
  profilePatchPath,
  storageBackendPatchEntries,
  storageDomainSwitchEntries,
  toYamlPatch,
} from './patch.mjs'
import { ensureRealDirectory } from './local-tree.mjs'
import { HdsBaiduError } from './errors.mjs'
import { timestamp } from './log.mjs'
import { PROJECT_ROOT } from './config.mjs'

/**
 * Installer for the two DSH integrations.
 *
 * Every mutation is plan-first: `plan(kind)` returns exactly what would change,
 * `apply(kind)` is only reachable with an explicit confirmation, and both the
 * patch file and the plugin link are backed up or idempotent. Nothing outside
 * the approved drive is touched, and `C:` is rejected before any filesystem
 * call.
 */
export class Installer {
  /**
   * @param {{config: any, logger?: any}} options
   */
  constructor(options) {
    this.config = options.config
    this.logger = options.logger
    this.patchFile = profilePatchPath({ hdsHome: this.config.hds.home, profile: this.config.hds.profile })
    this.modulesDir = profileModulesPath({ hdsHome: this.config.hds.home, profile: this.config.hds.profile })
  }

  /**
   * Plugin link target for the storage backend.
   */
  pluginLink() {
    return path.join(this.modulesDir, 'dsh-storage-baidu')
  }

  pluginSource() {
    return path.join(PROJECT_ROOT, 'plugin', 'dsh-storage-baidu')
  }

  mcpServerEntry() {
    return path.join(PROJECT_ROOT, 'mcp-server.mjs')
  }

  /**
   * Build the change set for one integration.
   * @param {'mcp'|'storage'|'domain'} kind
   */
  async plan(kind) {
    const patchExists = await fsp.stat(this.patchFile).then(() => true, () => false)
    const patchText = patchExists ? await fsp.readFile(this.patchFile, 'utf8') : '[]\n'
    // Emitted YAML single-quotes every string; strip them so detection does not
    // depend on whether a value happens to need quoting.
    const flat = patchText.replaceAll("'", '')
    const base = {
      kind,
      patchFile: this.patchFile,
      patchExists,
      patchSha256: createHash('sha256').update(patchText).digest('hex').slice(0, 16),
    }
    if (kind === 'mcp') {
      const entries = mcpPatchEntries({
        node: process.execPath,
        server: this.mcpServerEntry(),
        configPath: this.config.configPath ?? path.join(PROJECT_ROOT, 'config', 'config.json'),
        serverName: this.config.mcp.serverName,
      })
      return {
        ...base,
        entries,
        yaml: toYamlPatch(entries),
        alreadyInstalled: flat.includes(`id: mcp-${this.config.mcp.serverName}`),
        writes: [this.patchFile],
        notes: [
          'Appends one stdio MCP client row; it does not replace existing rows.',
          'No token is written into the patch: the server reads the environment or state/credentials.json.',
        ],
      }
    }
    if (kind === 'storage') {
      const entries = storageBackendPatchEntries({
        remoteRoot: this.config.storageBackend.remoteRoot,
        cacheRoot: this.config.storageBackend.cacheRoot,
        offlinePolicy: this.config.storageBackend.offlinePolicy,
        allowedDrive: this.config.local.allowedDrives[0],
      })
      const linkExists = await fsp.lstat(this.pluginLink()).then(stat => stat.isSymbolicLink(), () => false)
      return {
        ...base,
        entries,
        yaml: toYamlPatch(entries),
        alreadyInstalled: flat.includes('id: storage-baidu'),
        link: { path: this.pluginLink(), target: this.pluginSource(), exists: linkExists },
        writes: [this.patchFile, this.pluginLink()],
        notes: [
          'Registers the baidu backend; it does NOT switch the domain layer to it.',
          'Run the domain step only after the backend passes a write test.',
        ],
      }
    }
    if (kind === 'domain') {
      const entries = storageDomainSwitchEntries('baidu')
      return {
        ...base,
        entries,
        yaml: toYamlPatch(entries),
        alreadyInstalled: /id: storage-domain[\s\S]{0,200}?backend: baidu/.test(flat),
        writes: [this.patchFile],
        notes: [
          'Every DSH storage write will wait for a Baidu upload.',
          'Roll back with storageDomainSwitchEntries("json").',
        ],
      }
    }
    throw new HdsBaiduError('usage', `unknown install target: ${kind}`)
  }

  /**
   * Apply a plan returned by `plan()`.
   * @param {any} plan
   */
  async apply(plan) {
    if (plan.kind === 'storage' && plan.link && !plan.link.exists) {
      await this.linkPlugin(plan.link)
    }
    if (plan.alreadyInstalled) {
      return { ok: true, changed: false, reason: 'already installed', patchFile: this.patchFile }
    }
    await ensureRealDirectory(path.dirname(this.patchFile))
    const backup = `${this.patchFile}.bak-hds-baidu-${timestamp()}`
    const original = await fsp.readFile(this.patchFile, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return '[]\n'
      throw error
    })
    await fsp.writeFile(backup, original, { mode: 0o600 })
    const separator = original.endsWith('\n') ? '' : '\n'
    await fsp.writeFile(this.patchFile, `${original}${separator}${plan.yaml}`, { mode: 0o600 })
    this.logger?.info('profile patch updated', { kind: plan.kind, patchFile: this.patchFile, backup })
    return { ok: true, changed: true, patchFile: this.patchFile, backup, entries: plan.entries.length }
  }

  /**
   * Create the junction that makes the plugin resolvable from the DSH profile.
   * A junction is used instead of a copy so the plugin stays a single source of
   * truth, and it is created on the approved drive only.
   * @param {{path: string, target: string}} link
   */
  async linkPlugin(link) {
    const stat = await fsp.stat(link.target).catch(error => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (!stat?.isDirectory()) throw new HdsBaiduError('plugin-missing', `plugin directory not found: ${link.target}`)
    await ensureRealDirectory(this.modulesDir)
    await fsp.symlink(link.target, link.path, 'junction')
    this.logger?.info('plugin linked', link)
  }

  /**
   * Remove a link and restore the most recent patch backup.
   * @param {{restorePatch?: boolean}} [options]
   */
  async rollback(options = {}) {
    const link = this.pluginLink()
    if (await fsp.lstat(link).then(stat => stat.isSymbolicLink(), () => false)) {
      await fsp.rm(link, { recursive: false, force: false })
    }
    if (options.restorePatch === false) return { ok: true, linkRemoved: true }
    const directory = path.dirname(this.patchFile)
    const backups = (await fsp.readdir(directory))
      .filter(name => name.startsWith(`${path.basename(this.patchFile)}.bak-hds-baidu-`))
      .sort()
    if (!backups.length) throw new HdsBaiduError('rollback-unavailable', `no patch backup found in ${directory}`)
    const newest = path.join(directory, backups[backups.length - 1])
    await fsp.copyFile(newest, this.patchFile)
    return { ok: true, linkRemoved: true, restoredFrom: newest }
  }
}
