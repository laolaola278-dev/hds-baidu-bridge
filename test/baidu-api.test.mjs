import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { hashFile, planParts } from '../src/baidu-api.mjs'
import { FakeBaiduClient, makeTestRoot } from './helpers/fake-client.mjs'

test('planParts uses 4 MiB slices and a final short slice', () => {
  assert.deepEqual(planParts(0, 4), [{ offset: 0, length: 0 }])
  assert.deepEqual(planParts(10, 4), [
    { offset: 0, length: 4 },
    { offset: 4, length: 4 },
    { offset: 8, length: 2 },
  ])
})

test('hashFile computes known MD5 and SHA-256', async () => {
  const root = await makeTestRoot('hash')
  const file = path.join(root.root, 'hello.txt')
  await fsp.writeFile(file, 'hello')
  assert.equal(await hashFile(file, 'md5'), '5d41402abc4b2a76b9719d911017c592')
  assert.equal(await hashFile(file, 'sha256'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
})

test('fake remote upload/download round-trips bytes and md5', async () => {
  const root = await makeTestRoot('roundtrip')
  const client = new FakeBaiduClient()
  const source = path.join(root.root, 'a.bin')
  const target = path.join(root.root, 'down', 'a.bin')
  const data = Buffer.from('HDS Baidu bridge')
  await fsp.writeFile(source, data)
  const uploaded = await client.uploadAtomic(source, `${root.remoteRoot}/a.bin`)
  assert.equal(uploaded.size, data.length)
  const downloaded = await client.download(`${root.remoteRoot}/a.bin`, target, { resume: false })
  assert.equal(downloaded.md5, uploaded.md5)
  assert.deepEqual(await fsp.readFile(target), data)
})
