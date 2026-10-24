import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { resolveLocalPath, normalizeAllowedDrives, remoteJoin, assertInside } from '../src/paths.mjs'

test('allowed drives are normalized and C is not special-cased', () => {
  const drives = normalizeAllowedDrives(['g:', 'H'])
  assert.ok(drives.has('G'))
  assert.ok(drives.has('H'))
})

test('C: is refused even when it would otherwise be allowed', () => {
  const policy = { root: 'G:\\project', allowedDrives: ['G', 'C'] }
  assert.throws(
    () => resolveLocalPath('C:\\Windows\\Temp\\x', policy),
    /refusing to touch C:/,
  )
})

test('an unapproved drive is refused', () => {
  const policy = { root: 'G:\\project', allowedDrives: ['G'] }
  assert.throws(() => resolveLocalPath('D:\\data\\x', policy), /not in allowedDrives/)
})

test('UNC paths are refused', () => {
  const policy = { root: 'G:\\project', allowedDrives: ['G'] }
  assert.throws(() => resolveLocalPath('\\\\server\\share\\x', policy), /UNC paths/)
})

test('relative paths resolve under the approved root', () => {
  const policy = { root: 'G:\\project', allowedDrives: ['G'] }
  assert.equal(resolveLocalPath('mirrors\\a', policy), path.win32.normalize('G:\\project\\mirrors\\a'))
})

test('assertInside rejects traversal', () => {
  assert.throws(() => assertInside('G:\\root', 'G:\\other\\file'), /escapes allowed root/)
  assert.equal(assertInside('G:\\root', 'G:\\root\\file'), 'G:\\root\\file')
})

test('remoteJoin rejects traversal', () => {
  assert.equal(remoteJoin('/HDS', 'a', 'b.txt'), '/HDS/a/b.txt')
  assert.throws(() => remoteJoin('/HDS', '..', 'etc'), /traversal/)
})
