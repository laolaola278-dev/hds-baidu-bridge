import path from 'node:path'
import fsp from 'node:fs/promises'
import { writeFileAtomic } from './log.mjs'
import { readJson } from './log.mjs'

/**
 * Periodic backup runner.
 *
 * A long-running process is used instead of an internal DSH timer because the
 * backup must survive DSH restarts and because it holds no DSH services. The
 * loop is deliberately boring: plan, run, record, sleep. Failures are recorded
 * and never abort the loop, so one bad network window does not silently end
 * backups for the rest of the day.
 */
export class BackupScheduler {
  /**
   * @param {{
   *   engine: any,
   *   intervalMs: number,
   *   stateFile: string,
   *   projects?: string[],
   *   logger?: any,
   *   clock?: () => Date,
   *   onRun?: (result: any) => void
   * }} options
   */
  constructor(options) {
    this.engine = options.engine
    this.intervalMs = Math.max(60_000, Number(options.intervalMs) || 3_600_000)
    this.stateFile = options.stateFile
    this.projects = options.projects ?? []
    this.logger = options.logger
    this.clock = options.clock ?? (() => new Date())
    this.onRun = options.onRun
    this.stopping = false
    this.runs = 0
    this.lastResult = undefined
  }

  /**
   * One backup attempt.
   * @param {string} [reason]
   */
  async runOnce(reason = 'schedule') {
    const startedAt = Date.now()
    try {
      const plan = await this.engine.plan({ projects: this.projects })
      const result = await this.engine.apply(plan)
      this.runs += result.ok ? 1 : 0
      this.lastResult = {
        reason,
        at: new Date().toISOString(),
        ok: result.ok,
        snapshotId: result.snapshotId,
        uploaded: result.uploaded,
        reused: result.reused,
        files: plan.summary.files,
        bytes: plan.summary.totalBytes,
        ms: Date.now() - startedAt,
        ...(result.ok ? {} : { failures: result.failed }),
      }
      if (result.ok) this.logger?.info('backup complete', this.lastResult)
      else this.logger?.error('backup partially failed', this.lastResult)
      await this.writeState(result.ok ? 'idle' : 'error')
      this.onRun?.(this.lastResult)
      return this.lastResult
    } catch (error) {
      this.lastResult = {
        reason,
        at: new Date().toISOString(),
        ok: false,
        error: { code: error?.code, message: error?.message },
        ms: Date.now() - startedAt,
      }
      this.logger?.error('backup failed', this.lastResult.error)
      await this.writeState('error')
      return this.lastResult
    }
  }

  /**
   * Persist scheduler state for observability.
   * @param {'idle'|'running'|'error'|'stopped'} state
   */
  async writeState(state) {
    const document = {
      state,
      pid: process.pid,
      intervalMs: this.intervalMs,
      projects: this.projects,
      runs: this.runs,
      updatedAt: new Date().toISOString(),
      lastResult: this.lastResult,
    }
    await writeFileAtomic(this.stateFile, `${JSON.stringify(document, null, 2)}\n`)
  }

  /**
   * Run until stopped.
   */
  async start() {
    await this.writeState('running')
    this.logger?.info('backup scheduler started', { intervalMs: this.intervalMs, stateFile: this.stateFile })
    const stopSignal = () => { this.stopping = true }
    process.once('SIGINT', stopSignal)
    process.once('SIGTERM', stopSignal)
    while (!this.stopping) {
      await this.runOnce('schedule')
      const deadline = Date.now() + this.intervalMs
      while (!this.stopping && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(30_000, deadline - Date.now())))
      }
    }
    await this.writeState('stopped')
  }

  async stop() {
    this.stopping = true
  }
}

/**
 * Read scheduler state when present.
 * @param {string} file
 */
export async function readSchedulerState(file) {
  return readJson(file)
}

/**
 * Where the scheduler records its state.
 * @param {string} stateDir
 */
export function schedulerStatePath(stateDir) {
  return path.join(stateDir, 'backup-scheduler.json')
}

/**
 * Install a Windows scheduled task that runs the CLI backup action.
 *
 * This shells out to `schtasks`, which cannot be expressed with the Node
 * standard library. It is opt-in, always dry-run first, and never writes to C:.
 * The task itself is registered with Windows; the command it runs lives on the
 * approved drive.
 *
 * @param {{
 *   nodePath: string,
 *   scriptPath: string,
 *   workingDirectory: string,
 *   taskName?: string,
 *   everyMinutes?: number,
 *   dryRun?: boolean,
 *   execFile: (file: string, args: string[], options: any) => Promise<{stdout: string, stderr: string}>
 * }} options
 */
export async function installScheduledTask(options) {
  const every = Math.max(1, Math.min(1440, Math.floor(options.everyMinutes ?? 60)))
  const taskName = options.taskName ?? 'HDS-Baidu-Backup'
  const command = `"${options.nodePath}" "${options.scriptPath}" backup run --apply`
  const args = [
    '/Create',
    '/TN', taskName,
    '/TR', command,
    '/SC', 'MINUTE',
    '/MO', String(every),
    '/F',
  ]
  if (options.dryRun !== false) {
    return {
      dryRun: true,
      taskName,
      everyMinutes: every,
      command,
      execFile: 'schtasks',
      args,
      note: 'Run with dryRun:false to register the task. Registration changes Windows Task Scheduler, not project files.',
    }
  }
  const result = await options.execFile('schtasks', args, {
    cwd: options.workingDirectory,
    windowsHide: true,
  })
  return { dryRun: false, taskName, everyMinutes: every, command, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

/**
 * Remove the scheduled task.
 * @param {{taskName?: string, dryRun?: boolean, execFile: Function}} options
 */
export async function removeScheduledTask(options) {
  const taskName = options.taskName ?? 'HDS-Baidu-Backup'
  if (options.dryRun !== false) return { dryRun: true, taskName, execFile: 'schtasks', args: ['/Delete', '/TN', taskName, '/F'] }
  const result = await options.execFile('schtasks', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true })
  return { dryRun: false, taskName, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

/**
 * Query the task's registration.
 * @param {{taskName?: string, execFile: Function}} options
 */
export async function queryScheduledTask(options) {
  const taskName = options.taskName ?? 'HDS-Baidu-Backup'
  try {
    const result = await options.execFile('schtasks', ['/Query', '/TN', taskName, '/FO', 'LIST'], { windowsHide: true })
    return { installed: true, taskName, detail: result.stdout.trim() }
  } catch (error) {
    return { installed: false, taskName, detail: error?.stderr ?? error?.message }
  }
}

/**
 * Report whether a directory has a state file, used by `manifest` diagnostics.
 * @param {string} directory
 */
export async function directorySummary(directory) {
  const stat = await fsp.stat(directory).catch(() => undefined)
  if (!stat) return { directory, exists: false }
  if (!stat.isDirectory()) return { directory, exists: true, kind: 'file', size: stat.size }
  const entries = await fsp.readdir(directory, { withFileTypes: true })
  return {
    directory,
    exists: true,
    kind: 'directory',
    files: entries.filter(entry => entry.isFile()).length,
    directories: entries.filter(entry => entry.isDirectory()).length,
    names: entries.slice(0, 50).map(entry => entry.name),
    truncated: entries.length > 50,
  }
}
