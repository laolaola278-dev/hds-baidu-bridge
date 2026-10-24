import test from 'node:test'
import assert from 'node:assert/strict'
import { createExcludeMatcher } from '../src/exclude.mjs'

test('directory globs match descendants and the directory itself', () => {
  const excluded = createExcludeMatcher(['node_modules/**', '.git/**'])
  assert.equal(excluded('node_modules/pkg/index.js'), true)
  assert.equal(excluded('node_modules', true), true)
  assert.equal(excluded('src/node_modules/pkg/index.js'), false)
  assert.equal(excluded('src/index.js'), false)
})

test('file extension globs match at any depth', () => {
  const excluded = createExcludeMatcher(['**/*.pyc'])
  assert.equal(excluded('a.pyc'), true)
  assert.equal(excluded('deep/path/a.pyc'), true)
  assert.equal(excluded('deep/path/a.py'), false)
})

test('single star does not cross a slash', () => {
  const excluded = createExcludeMatcher(['build/*.log'])
  assert.equal(excluded('build/a.log'), true)
  assert.equal(excluded('build/nested/a.log'), false)
})

test('question mark matches one non-slash character', () => {
  const excluded = createExcludeMatcher(['temp-?.txt'])
  assert.equal(excluded('temp-a.txt'), true)
  assert.equal(excluded('temp-ab.txt'), false)
})
