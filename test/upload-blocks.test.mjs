import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isVerifiableMd5, md5Blocks, planParts } from '../src/baidu-api.mjs'
import { makeTestRoot } from './helpers/fake-client.mjs'

test('md5Blocks hashes each 4 MiB part independently', async () => {
  const root = await makeTestRoot('blocks')
  const file = path.join(root.root, 'large.bin')
  const data = Buffer.alloc(10)
  for (let index = 0; index < data.length; index += 1) data[index] = index
  await fsp.writeFile(file, data)
  const blocks = await md5Blocks(file, data.length, 4)
  assert.equal(blocks.length, planParts(data.length, 4).length)
  assert.equal(blocks[0], createHash('md5').update(data.subarray(0, 4)).digest('hex'))
  assert.equal(blocks[1], createHash('md5').update(data.subarray(4, 8)).digest('hex'))
  assert.equal(blocks[2], createHash('md5').update(data.subarray(8, 10)).digest('hex'))
})

test('the obfuscated remote digest is not treated as a checksum', async () => {
  // Baidu's file_list/filemetas return a content-derived digest that contains
  // characters outside [0-9a-f] (observed i, n, p, s). Enforcing it as an MD5
  // would reject every correct download.
  assert.equal(isVerifiableMd5('af5e2eb4anc9ff37026f05a3ad10e297'), false)
  assert.equal(isVerifiableMd5('d555ad0cei2f34ee8115174535102cc0'), false)
  assert.equal(isVerifiableMd5('2e6232d8ae7d6bd324bb2f78034c40c4'), true)
  assert.equal(isVerifiableMd5('2E6232D8AE7D6BD324BB2F78034C40C4'), true)
  assert.equal(isVerifiableMd5(''), false)
  assert.equal(isVerifiableMd5(undefined), false)
  assert.equal(isVerifiableMd5(123), false)
  assert.equal(isVerifiableMd5('2e6232d8ae7d6bd324bb2f78034c40c'), false, '31 chars is not a digest')
})
