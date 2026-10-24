import path from 'node:path'
import fsp from 'node:fs/promises'
import { PathPolicyError } from './errors.mjs'

/**
 * Redirect the process temporary directory onto an approved drive.
 *
 * Node and third-party libraries occasionally consult `TEMP`/`TMP`/`TMPDIR`
 * (for example when a library spills to disk). The project's own code never
 * uses the system temp directory, but a hosted process may inherit a C: value
 * from the parent shell or from Windows. Rebinding the variables before any
 * work starts keeps the "no C: writes" rule true for the whole process tree we
 * own.
 *
 * @param {{root: string, allowedDrives?: Iterable<string>}} options
 * @returns {Promise<string>} The approved temporary directory.
 */
export async function useApprovedTempDir(options) {
  const root = options.root
  const drive = path.win32.parse(root).root.slice(0, 1).toUpperCase()
  const allowed = new Set([...(options.allowedDrives ?? ['G'])].map(value => String(value).toUpperCase()))
  if (!/^[A-Z]$/.test(drive)) throw new PathPolicyError(`temporary root has no drive letter: ${root}`)
  if (drive === 'C') throw new PathPolicyError(`refusing a C: temporary root: ${root}`)
  if (!allowed.has(drive)) throw new PathPolicyError(`temporary root drive ${drive}: is not allowed: ${root}`)
  await fsp.mkdir(root, { recursive: true, mode: 0o700 })
  process.env.TEMP = root
  process.env.TMP = root
  process.env.TMPDIR = root
  return root
}

/**
 * Report whether the current process temp variables point off approved drives.
 * @param {Iterable<string>} allowedDrives
 */
export function tempDirAudit(allowedDrives = ['G']) {
  const allowed = new Set([...allowedDrives].map(value => String(value).toUpperCase()))
  const output = {}
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
    const value = process.env[name]
    if (!value) {
      output[name] = { value: null, ok: false, reason: 'unset' }
      continue
    }
    const parsed = path.win32.parse(value)
    const drive = parsed.root.slice(0, 1).toUpperCase()
    const ok = /^[A-Z]$/.test(drive) && drive !== 'C' && allowed.has(drive)
    output[name] = { value, ok, reason: ok ? 'approved' : 'outside allowed drives' }
  }
  return output
}
