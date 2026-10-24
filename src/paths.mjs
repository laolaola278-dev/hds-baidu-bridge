import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { PathPolicyError } from './errors.mjs'

/**
 * Normalize an allow-list of Windows drive letters.
 * @param {readonly string[]} drives
 * @returns {Set<string>}
 */
export function normalizeAllowedDrives(drives) {
  const result = new Set()
  for (const drive of drives ?? []) {
    const normalized = String(drive).replace(/:$/, '').trim().toUpperCase()
    if (!/^[A-Z]$/.test(normalized)) throw new PathPolicyError(`invalid allowed drive: ${drive}`)
    result.add(normalized)
  }
  return result
}

/**
 * Resolve a user path without ever accepting C: or an unapproved drive.
 *
 * This is a write-safety boundary, not a sandbox for reads: callers must use it
 * before creating, modifying, renaming or deleting anything.
 * @param {string} input Path to resolve.
 * @param {{root: string, allowedDrives: Iterable<string>}} policy
 * @returns {string} Absolute normalized path.
 */
export function resolveLocalPath(input, policy) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new PathPolicyError('local path must be a non-empty string')
  }
  const allowed = new Set([...policy.allowedDrives].map(value => value.toUpperCase()))
  let absolute
  if (path.win32.isAbsolute(input)) {
    if (input.startsWith('\\\\') || input.startsWith('//')) {
      throw new PathPolicyError(`UNC paths are not allowed: ${input}`)
    }
    absolute = path.win32.normalize(input)
  } else {
    absolute = path.resolve(policy.root, input)
  }
  const parsed = path.win32.parse(absolute)
  const drive = parsed.root.slice(0, 1).toUpperCase()
  if (!/^[A-Z]$/.test(drive)) throw new PathPolicyError(`path has no drive letter: ${input}`)
  if (drive === 'C') throw new PathPolicyError(`refusing to touch C: (policy violation): ${absolute}`)
  if (!allowed.has(drive)) {
    throw new PathPolicyError(`drive ${drive}: is not in allowedDrives (${[...allowed].join(', ')}): ${absolute}`)
  }
  return absolute
}

/**
 * Reject a path that is not the root itself or a descendant of it.
 * @param {string} root Absolute allowed root.
 * @param {string} target Absolute candidate.
 * @returns {string} The target.
 */
export function assertInside(root, target) {
  const relative = path.relative(root, target)
  if (relative === '') return target
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathPolicyError(`path escapes allowed root: ${target}`)
  }
  return target
}

/**
 * Resolve a path and verify that its nearest existing ancestor does not escape
 * to a disallowed drive through a junction or symlink.
 * @param {string} input
 * @param {{root: string, allowedDrives: Iterable<string>}} policy
 * @returns {Promise<string>} Absolute normalized path.
 */
export async function resolveLocalPathChecked(input, policy) {
  const absolute = resolveLocalPath(input, policy)
  let cursor = absolute
  for (;;) {
    try {
      const resolved = await realpath(cursor)
      const resolvedDrive = path.win32.parse(resolved).root.slice(0, 1).toUpperCase()
      if (resolvedDrive === 'C' || !new Set([...policy.allowedDrives].map(v => v.toUpperCase())).has(resolvedDrive)) {
        throw new PathPolicyError(`path resolves outside allowed drives through a link: ${input}`)
      }
      return absolute
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw new PathPolicyError(`cannot resolve path: ${input}`)
      cursor = parent
    }
  }
}

/**
 * Convert an absolute local path to a POSIX relative path under a root.
 * @param {string} root
 * @param {string} absolute
 * @returns {string}
 */
export function toPosixRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/')
}

/**
 * Join a POSIX remote path without allowing traversal.
 * @param {...string} segments
 * @returns {string}
 */
export function remoteJoin(...segments) {
  const parts = []
  for (const segment of segments) {
    for (const piece of String(segment).split('/')) {
      if (piece === '' || piece === '.') continue
      if (piece === '..') throw new PathPolicyError(`remote path traversal rejected: ${segments.join('/')}`)
      parts.push(piece)
    }
  }
  return `/${parts.join('/')}`
}

/**
 * Validate and normalize an absolute Baidu remote path.
 * @param {string} remotePath
 * @returns {string}
 */
export function normalizeRemotePath(remotePath) {
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
    throw new PathPolicyError(`remote path must be absolute and start with /: ${remotePath}`)
  }
  return remoteJoin(remotePath)
}

/**
 * Return whether a Windows path is on C:.
 * @param {string} value
 * @returns {boolean}
 */
export function isCDrivePath(value) {
  return /^[a-z]:/i.test(value) && /^c:/i.test(value)
}
