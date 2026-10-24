import path from 'node:path'
import fsp from 'node:fs/promises'
import { watch as fsWatch } from 'node:fs'
import { SyncEngine } from './sync-engine.mjs'
import { writeFileAtomic } from './log.mjs'
import { timestamp } from './log.mjs'

/**
 * Long-running mirror daemon.
 *
 * Baidu Netdisk has no Windows filesystem driver in this project, so the
 * mirror is a real local directory kept in step by this daemon. Local edits
 * trigger an upload after a short debounce; a slower timer scans the remote
 * side for changes made elsewhere. Conflicts are reported, never overwritten.
 */
export class MirrorDaemon {
  /**
   * @param {{
   *   engine: SyncEngine,
   *   localRoot: string,
   *   remoteRoot: string,
   *   stateFile: string,
   *   direction?: 'push'|'pull'|'both',
   *   remoteIntervalMs?: number,
   *   debounceMs?: number,
   *   logger?: any,
   *   onCycle?: (result: any) => void
   * }} options
   */
  constructor(options) {
    this.engine = options.engine
    this.localRoot = options.localRoot
    this.remoteRoot = options.remoteRoot
    this.stateFile = options.stateFile
    this.direction = options.direction ?? 'both'
    this.remoteIntervalMs = options.remoteIntervalMs ?? 300000
    this.debounceMs = options.debounceMs ?? 2000
    this.logger = options.logger
    this.onCycle = options.onCycle
    this.stopping = false
    this.running = false
    this.pending = false
    this.timer = undefined
    this.watcher = undefined
    this.cycles = 0
    this.lastResult = undefined
  }

  /**
   * Schedule a cycle after the debounce window.
   */
  kick() {
    if (this.stopping) return
    this.pending = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.cycle('local-change')
    }, this.debounceMs)
    this.timer.unref?.()
  }

  /**
   * Run one plan/apply cycle. Cycles never overlap.
   * @param {string} [reason]
   */
  async cycle(reason = 'timer') {
    if (this.stopping) return undefined
    if (this.running) {
      this.pending = true
      return undefined
    }
    this.running = true
    this.pending = false
    const startedAt = Date.now()
    try {
      const plan = await this.engine.plan({ direction: this.direction })
      const actionable = plan.summary.uploads + plan.summary.downloads + plan.summary.unchanged
      let result
      if (actionable === 0) {
        result = { reason, at: new Date().toISOString(), summary: plan.summary, applied: false }
      } else {
        result = { reason, at: new Date().toISOString(), summary: plan.summary, applied: true, result: await this.engine.apply(plan) }
      }
      this.cycles += 1
      this.lastResult = result
      this.logger?.info('mirror cycle', {
        reason,
        uploads: plan.summary.uploads,
        downloads: plan.summary.downloads,
        conflicts: plan.summary.conflicts,
        ms: Date.now() - startedAt,
      })
      await this.writeState('running', result)
      this.onCycle?.(result)
      return result
    } catch (error) {
      if (error?.code === 'token-missing') throw error
      this.logger?.error('mirror cycle failed', { code: error?.code, message: error?.message })
      this.lastResult = { reason, at: new Date().toISOString(), error: { code: error?.code, message: error?.message } }
      await this.writeState('error', this.lastResult)
      return undefined
    } finally {
      this.running = false
      if (this.pending && !this.stopping) this.kick()
    }
  }

  /**
   * Persist a small status file so another process (or the CLI) can inspect
   * the daemon without attaching to it.
   * @param {'running'|'error'|'stopped'} state
   * @param {any} [detail]
   */
  async writeState(state, detail) {
    const document = {
      state,
      pid: process.pid,
      localRoot: this.localRoot,
      remoteRoot: this.remoteRoot,
      direction: this.direction,
      cycles: this.cycles,
      updatedAt: new Date().toISOString(),
      lastResult: detail,
    }
    await writeFileAtomic(this.stateFile, `${JSON.stringify(document, null, 2)}\n`)
  }

  /**
   * Start watching. Resolves only when `stop()` is called.
   */
  async start() {
    await this.writeState('running')
    this.watcher = fsWatch(this.localRoot, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      const name = String(filename)
      if (name.includes('node_modules') || name.includes('.git' + path.sep) || name.endsWith('.part')) return
      this.logger?.debug?.('local change', { eventType, filename: name })
      this.kick()
    })
    this.watcher.on('error', error => {
      this.logger?.warn('watcher error; relying on the remote timer', { message: error?.message })
    })
    const interval = setInterval(() => { void this.cycle('remote-timer') }, this.remoteIntervalMs)
    interval.unref?.()
    await this.cycle('startup')
    await new Promise(resolve => {
      const finish = () => {
        this.stopping = true
        clearInterval(interval)
        resolve()
      }
      process.once('SIGINT', finish)
      process.once('SIGTERM', finish)
    })
    await this.stop()
  }

  async stop() {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.watcher?.close()
    this.watcher = undefined
    while (this.running) await new Promise(resolve => setTimeout(resolve, 50))
    await this.writeState('stopped')
  }
}

/**
 * Read a daemon state file if present.
 * @param {string} file
 */
export async function readMirrorState(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Stable state file for one local/remote pair.
 * @param {string} stateDir
 * @param {string} id
 */
export function mirrorStatePath(stateDir, id) {
  return path.join(stateDir, 'mirror', `${id}.json`)
}

/**
 * Human-readable one-line status.
 * @param {any} state
 */
export function describeMirrorState(state) {
  if (!state) return 'no mirror state recorded'
  const parts = [`state=${state.state}`, `pid=${state.pid}`, `cycles=${state.cycles}`, `updated=${state.updatedAt}`]
  const summary = state.lastResult?.summary
  if (summary) parts.push(`uploads=${summary.uploads}`, `downloads=${summary.downloads}`, `conflicts=${summary.conflicts}`)
  return parts.join(' ')
}

export { timestamp }
