import path from 'node:path'
import { readJson, writeFileAtomic } from './log.mjs'

/**
 * Persistent sync baseline. Mirrors a mirror or project to a remote directory.
 */
export class SyncManifest {
  /**
   * @param {string} file
   * @param {{id: string, localRoot: string, remoteRoot: string}} identity
   */
  constructor(file, identity) {
    this.file = file
    this.identity = identity
    this.data = {
      version: 1,
      ...identity,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files: {},
    }
  }

  /**
   * @param {string} file
   * @param {{id: string, localRoot: string, remoteRoot: string}} identity
   */
  static async load(file, identity) {
    const manifest = new SyncManifest(file, identity)
    const stored = await readJson(file)
    if (!stored) return manifest
    if (stored.version !== 1 || stored.id !== identity.id) return manifest
    manifest.data = {
      ...manifest.data,
      ...stored,
      localRoot: identity.localRoot,
      remoteRoot: identity.remoteRoot,
      files: stored.files && typeof stored.files === 'object' ? stored.files : {},
    }
    return manifest
  }

  get files() {
    return this.data.files
  }

  get(relative) {
    return this.data.files[relative]
  }

  set(relative, value) {
    this.data.files[relative] = value
  }

  delete(relative) {
    delete this.data.files[relative]
  }

  async save() {
    this.data.updatedAt = new Date().toISOString()
    const temporary = `${this.file}.tmp`
    await writeFileAtomic(temporary, `${JSON.stringify(this.data, null, 2)}\n`)
    await import('node:fs/promises').then(fs => fs.rename(temporary, this.file))
  }

  /**
   * @param {string} stateDir
   * @param {string} id
   */
  static pathFor(stateDir, id) {
    return path.join(stateDir, 'sync', `${id}.json`)
  }
}
