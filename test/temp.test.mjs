import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { tempDirAudit, useApprovedTempDir } from '../src/temp.mjs'
import { makeTestRoot } from './helpers/fake-client.mjs'

test('C: is refused as a temporary root', async () => {
  await assert.rejects(
    useApprovedTempDir({ root: 'C:\\Windows\\Temp\\hds', allowedDrives: ['G'] }),
    /refusing a C: temporary root/,
  )
})

test('the temporary root is created on the approved drive', async () => {
  const root = await makeTestRoot('temp')
  const target = path.join(root.root, 'tmp')
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  try {
    await useApprovedTempDir({ root: target, allowedDrives: ['G'] })
    assert.equal(process.env.TEMP, target)
    const stat = await fsp.stat(target)
    assert.equal(stat.isDirectory(), true)
    assert.equal(tempDirAudit(['G']).TEMP.ok, true)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
