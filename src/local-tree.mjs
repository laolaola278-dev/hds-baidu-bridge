import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { hashFile } from './baidu-api.mjs'
import { createExcludeMatcher } from './exclude.mjs'
import { HdsBaiduError } from './errors.mjs'

/**
 * Walk a local tree without following reparse points. Returns regular files
 * only, with POSIX relative paths.
 * @param {string} root
 * @param {{exclude?: readonly string[], maxFileBytes?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<Array<{relative: string, absolute: string, size: number, mtimeMs: number, md5?: string}>>}
 */
export async function walkLocal(root, options = {}) {
  const excluded = createExcludeMatcher(options.exclude ?? [])
  const output = []
  const rootStat = await fsp.lstat(root).catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (!rootStat) return output
  if (!rootStat.isDirectory()) throw new HdsBaiduError('not-a-directory', `not a directory: ${root}`)
  const stack = ['']
  while (stack.length) {
    options.signal?.throwIfAborted()
    const relativeDir = stack.pop()
    const absoluteDir = path.join(root, relativeDir)
    const directory = await fsp.opendir(absoluteDir)
    for await (const entry of directory) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const absolute = path.join(root, relative)
      const stat = await fsp.lstat(absolute)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (!excluded(relative, true)) stack.push(relative)
        continue
      }
      if (!stat.isFile()) continue
      if (excluded(relative, false)) continue
      if (options.maxFileBytes !== undefined && stat.size > options.maxFileBytes) {
        throw new HdsBaiduError('file-too-large', `file exceeds maxFileBytes: ${relative}`)
      }
      output.push({
        relative,
        absolute,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      })
    }
  }
  return output.sort((left, right) => left.relative.localeCompare(right.relative))
}

/**
 * Compute an MD5 only when a baseline cannot prove the content unchanged.
 * @param {{absolute: string, size: number, mtimeMs: number}} current
 * @param {{size: number, mtimeMs: number, md5: string}|undefined} baseline
 * @returns {Promise<string>}
 */
export async function md5WithBaseline(current, baseline) {
  if (baseline && baseline.size === current.size && baseline.mtimeMs === current.mtimeMs && baseline.md5) {
    return baseline.md5
  }
  return hashFile(current.absolute, 'md5')
}

/**
 * Ensure a path is a real directory (rejecting reparse points) and create it.
 * @param {string} directory
 */
export async function ensureRealDirectory(directory) {
  const stat = await fsp.lstat(directory).catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (!stat) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
    return
  }
  if (stat.isSymbolicLink()) throw new HdsBaiduError('reparse-point', `refusing to use junction/symlink: ${directory}`)
  if (!stat.isDirectory()) throw new HdsBaiduError('not-a-directory', `not a directory: ${directory}`)
}

/**
 * Replace a destination file with a staged file.
 * @param {string} staged
 * @param {string} destination
 */
export async function publishFile(staged, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  try {
    await fsp.rename(staged, destination)
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error
    await fsp.rm(destination, { force: true })
    await fsp.rename(staged, destination)
  }
}

/**
 * Stable short id for a local/remote pair.
 * @param {string} localRoot
 * @param {string} remoteRoot
 * @returns {string}
 */
export function syncId(localRoot, remoteRoot) {
  return createHash('sha256').update(`${localRoot}\0${remoteRoot}`).digest('hex').slice(0, 16)
}
