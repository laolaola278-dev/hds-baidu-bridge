import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { BaiduNetdiskClient } from '../src/baidu-api.mjs'
import { SyncEngine } from '../src/sync-engine.mjs'
import { BackupEngine } from '../src/backup-engine.mjs'
import { RestoreEngine, restorePlanDigest } from '../src/restore-engine.mjs'
import { createFakePan } from './helpers/fake-xpan-server.mjs'
import { makeTestRoot, TEST_BASE } from './helpers/fake-client.mjs'

/**
 * End-to-end acceptance run over real HTTP.
 *
 * Every other engine test injects `FakeBaiduClient`, which replaces the whole
 * transport. These tests use the production `BaiduNetdiskClient` — real fetch,
 * real form bodies, real multipart part uploads, real dlink download with Range
 * resume — pointed at an in-process XPAN implementation. If a request shape is
 * wrong, or the create/upload ordering is off, these fail; the in-memory fake
 * cannot catch that class of bug.
 */

async function withPan(run) {
  const pan = createFakePan({ token: 'acceptance-token' })
  const endpoint = await pan.listen()
  try {
    const client = new BaiduNetdiskClient({
      accessToken: 'acceptance-token',
      panBase: endpoint.base,
      pcsBase: endpoint.base,
    })
    await run({ client, pan, endpoint })
  } finally {
    await pan.close()
  }
}

test('a real client lists, creates directories and reports quota over HTTP', async () => {
  await withPan(async ({ client, endpoint }) => {
    await client.ensureDir('/HDS/a/b')
    const listing = await client.list('/HDS')
    assert.deepEqual(listing.map(entry => entry.server_filename), ['a'])
    const doctor = await client.doctor('/HDS')
    assert.equal(doctor.user.uk, 424242)
    assert.equal(doctor.remoteRoot, '/HDS')
    // `available` must be the real remainder, not the `free` free-tier field.
    // The fake server returns a deliberately mismatched `free` to lock this in.
    assert.equal(doctor.quota.total, 10 * 1024 ** 3)
    assert.equal(doctor.quota.used, 1024 ** 2)
    assert.equal(doctor.quota.available, 10 * 1024 ** 3 - 1024 ** 2)
    assert.equal(doctor.quota.freeAllowance, 5 * 1024 ** 3)
    assert.notEqual(doctor.quota.available, doctor.quota.freeAllowance)
    assert.equal(doctor.quota.expiresWithin7Days, false)
    assert.ok(endpoint.stats.uploads >= 0)
  })
})

test('a large file round-trips through precreate, parts, create and dlink', async () => {
  await withPan(async ({ client, pan, endpoint }) => {
    const root = await makeTestRoot('acceptance-roundtrip')
    try {
      const localPath = path.join(root.root, 'payload.bin')
      // Two parts and a remainder, so the part boundary logic is exercised.
      const payload = Buffer.alloc(4 * 1024 * 1024 + 1234)
      for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251
      await fsp.writeFile(localPath, payload)

      const uploaded = await client.upload(localPath, '/HDS/data')
      assert.equal(uploaded.size, payload.length)
      assert.equal(endpoint.stats.uploads, 2, 'a 4 MiB+ file must upload as two parts')

      const remoteBytes = pan.read('/HDS/data/payload.bin')
      assert.ok(remoteBytes, 'the assembled remote object must exist')
      assert.deepEqual(remoteBytes, payload, 'assembled bytes must match the source exactly')

      const localCopy = path.join(root.root, 'downloaded.bin')
      const downloaded = await client.download('/HDS/data/payload.bin', localCopy)
      assert.equal(downloaded.size, payload.length)
      assert.deepEqual(await fsp.readFile(localCopy), payload)
    } finally {
      await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test('a truncated download resumes from the .part file with a Range request', async () => {
  await withPan(async ({ client, pan, endpoint }) => {
    const root = await makeTestRoot('acceptance-resume')
    try {
      const payload = Buffer.from('0123456789'.repeat(5000))
      const source = path.join(root.root, 'source.bin')
      await fsp.writeFile(source, payload)
      await client.upload(source, '/HDS/resume')

      const target = path.join(root.root, 'target.bin')
      // Simulate an interrupted transfer: a partial file already on disk.
      const partial = 20000
      await fsp.writeFile(`${target}.part`, payload.subarray(0, partial))
      const downloaded = await client.download('/HDS/resume/source.bin', target)
      assert.equal(downloaded.resumedFrom, partial)
      assert.deepEqual(await fsp.readFile(target), payload)
      // The server must have seen a Range request for the resume.
      assert.ok(endpoint.requests.some(entry => entry.bytes > 0))
    } finally {
      await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test('a corrupt remote object is rejected instead of being written locally', async () => {
  await withPan(async ({ client, pan }) => {
    const root = await makeTestRoot('acceptance-corrupt')
    try {
      const source = path.join(root.root, 'a.txt')
      await fsp.writeFile(source, 'good bytes')
      await client.upload(source, '/HDS/x')
      // Poison the stored bytes without updating the recorded md5: this is what
      // a proxy rewriting content or a partial remote write would look like.
      pan.files.get('/HDS/x/a.txt').data = Buffer.from('bad bytes!')
      const target = path.join(root.root, 'out.txt')
      await assert.rejects(client.download('/HDS/x/a.txt', target), /md5|corrupt/i)
      assert.equal(await fsp.stat(target).then(() => true, () => false), false, 'no final file may be left behind')
      assert.equal(await fsp.stat(`${target}.part`).then(() => true, () => false), false, '.part must be discarded')
    } finally {
      await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test('uploadAtomic never exposes a half-written final object', async () => {
  await withPan(async ({ client, pan }) => {
    const root = await makeTestRoot('acceptance-atomic')
    try {
      const first = path.join(root.root, 'v1.txt')
      const second = path.join(root.root, 'v2.txt')
      await fsp.writeFile(first, 'version one')
      await fsp.writeFile(second, 'version two, longer')
      await client.uploadAtomic(first, '/HDS/atomic/target.txt')
      assert.equal(pan.read('/HDS/atomic/target.txt').toString(), 'version one')
      await client.uploadAtomic(second, '/HDS/atomic/target.txt')
      assert.equal(pan.read('/HDS/atomic/target.txt').toString(), 'version two, longer')
      // The temp staging path must not linger as a visible file.
      const strays = pan.paths().filter(item => item.includes('.hds-tmp'))
      assert.deepEqual(strays, [], `staging objects must be moved away, saw: ${strays.join(', ')}`)
    } finally {
      await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test('the sync engine pushes and pulls real bytes over HTTP', async () => {
  await withPan(async ({ client, pan }) => {
    const workspace = await makeTestRoot('acceptance-sync')
    const local = path.join(workspace.root, 'local')
    await fsp.mkdir(path.join(local, 'src'), { recursive: true })
    await fsp.writeFile(path.join(local, 'README.md'), '# pushed\n')
    await fsp.writeFile(path.join(local, 'src', 'app.js'), 'export const x = 1\n')
    const config = { ...workspace.config, local: { ...workspace.config.local, root: workspace.root } }
    try {
      const engine = new SyncEngine({ client, config, localRoot: local, remoteRoot: '/HDS/projects/sync' })
      const pushPlan = await engine.plan({ direction: 'push' })
      const pushed = await engine.apply(pushPlan)
      assert.equal(pushed.counts.uploaded, 2)
      assert.equal(pan.read('/HDS/projects/sync/README.md').toString(), '# pushed\n')

      // A remote-only change must arrive on the next pull.
      pan.files.set('/HDS/projects/sync/from-cloud.txt', {
        data: Buffer.from('came from the cloud\n'),
        md5: '0'.repeat(32),
        mtime: Math.floor(Date.now() / 1000),
        fsId: 9999,
      })
      pan.files.get('/HDS/projects/sync/from-cloud.txt').md5 = (await import('node:crypto'))
        .createHash('md5').update(Buffer.from('came from the cloud\n')).digest('hex')
      const pullPlan = await engine.plan({ direction: 'pull' })
      await engine.apply(pullPlan)
      assert.equal(await fsp.readFile(path.join(local, 'from-cloud.txt'), 'utf8'), 'came from the cloud\n')
    } finally {
      await fsp.rm(workspace.root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test('a backup and a restore complete over real HTTP', async () => {
  await withPan(async ({ client }) => {
    const workspace = await makeTestRoot('acceptance-backup')
    const sessions = path.join(workspace.root, 'dsh', 'sessions', 'proj', 's1')
    await fsp.mkdir(sessions, { recursive: true })
    await fsp.writeFile(path.join(sessions, 'session.jsonl.zstd'), 'compressed session bytes')
    await fsp.mkdir(path.join(workspace.root, 'dsh', 'storages'), { recursive: true })
    await fsp.writeFile(path.join(workspace.root, 'dsh', 'storages', 'workspace.json'), '{"unit":{"name":"workspace","version":2},"tables":{}}')
    const config = {
      remoteRoot: '/HDS',
      local: { ...workspace.config.local, root: workspace.root },
      sync: workspace.config.sync,
      backup: {
        maxFileBytes: 64 * 1024 * 1024,
        sources: { sessions: true, workspaceRegistry: true, sessionProjectionCache: false, profileConfig: false },
        projects: [],
      },
      hds: {
        home: path.join(workspace.root, 'dsh'),
        profile: 'desktop',
        sessionsDir: path.join(workspace.root, 'dsh', 'sessions'),
        storagesDir: path.join(workspace.root, 'dsh', 'storages'),
      },
    }
    try {
      const backup = new BackupEngine({ client, config })
      const snapshot = await backup.apply(await backup.plan())
      assert.equal(snapshot.ok, true)
      assert.equal(snapshot.uploaded, 2)

      const catalog = await client.stat('/HDS/backups/catalog.json')
      assert.ok(catalog, 'catalog.json must exist remotely')
      const manifest = await client.stat(`/HDS/backups/snapshots/${snapshot.snapshotId}/manifest.json`)
      assert.ok(manifest, 'the snapshot manifest must exist remotely')

      const newHome = path.join(workspace.root, 'new-machine', 'dsh')
      const restore = new RestoreEngine({ client, config, backupEngine: backup })
      const plan = await restore.plan(snapshot.snapshotId, { mapping: { 'hds-home': newHome } })
      const digest = await restorePlanDigest(restore, plan)
      const result = await restore.apply(plan, { confirm: true, planDigest: digest })
      assert.equal(result.restored, 2)
      assert.equal(
        await fsp.readFile(path.join(newHome, 'sessions', 'proj', 's1', 'session.jsonl.zstd'), 'utf8'),
        'compressed session bytes',
      )
      assert.equal(
        await fsp.readFile(path.join(newHome, 'storages', 'workspace.json'), 'utf8'),
        '{"unit":{"name":"workspace","version":2},"tables":{}}',
      )
    } finally {
      await fsp.rm(workspace.root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test('an invalid token surfaces as an errno -6 error, not a silent success', async () => {
  await withPan(async ({ client }) => {
    const root = await makeTestRoot('acceptance-auth')
    try {
      const badClient = new BaiduNetdiskClient({
        accessToken: 'wrong-token',
        panBase: client.panBase,
        pcsBase: client.pcsBase,
      })
      await assert.rejects(badClient.list('/HDS'), error => {
        assert.equal(error.errno, -6)
        assert.equal(error.method, 'file_list')
        return true
      })
    } finally {
      await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test('uploadAtomic replaces an existing object instead of failing', async () => {
  await withPan(async ({ client, pan }) => {
    const root = await makeTestRoot('acceptance-replace')
    try {
      const first = path.join(root.root, 'v1.txt')
      const second = path.join(root.root, 'v2.txt')
      await fsp.writeFile(first, 'original contents')
      await fsp.writeFile(second, 'replacement contents, longer')
      await client.uploadAtomic(first, '/HDS/replace/doc.txt')
      // The real API answers errno 12 for a colliding move under every ondup,
      // so a second uploadAtomic has to delete the target first.
      const result = await client.uploadAtomic(second, '/HDS/replace/doc.txt')
      assert.equal(result.size, Buffer.byteLength('replacement contents, longer'))
      assert.equal(pan.read('/HDS/replace/doc.txt').toString(), 'replacement contents, longer')
      const strays = pan.paths().filter(item => item.includes('/.hds-tmp/'))
      assert.deepEqual(strays, [], `staging must be cleaned up, saw: ${strays.join(', ')}`)
    } finally {
      await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test('uploadAtomic refuses to replace a directory with a file', async () => {
  await withPan(async ({ client, pan }) => {
    const root = await makeTestRoot('acceptance-dir-guard')
    try {
      const source = path.join(root.root, 'f.txt')
      await fsp.writeFile(source, 'file contents')
      // A directory already occupies the destination path.
      await client.ensureDir('/HDS/guard/thing')
      pan.directories.add('/HDS/guard/thing')
      await assert.rejects(
        client.uploadAtomic(source, '/HDS/guard/thing'),
        error => {
          assert.equal(error.code, 'target-is-directory')
          return true
        },
      )
      // The directory and its contents must still be there.
      assert.equal(pan.directories.has('/HDS/guard/thing'), true, 'the directory must not be deleted')
    } finally {
      await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test('uploadAtomic leaves no .hds-tmp directory behind', async () => {
  await withPan(async ({ client, pan }) => {
    const root = await makeTestRoot('acceptance-tmp-clean')
    try {
      const source = path.join(root.root, 'a.txt')
      await fsp.writeFile(source, 'one')
      await client.uploadAtomic(source, '/HDS/clean/doc.txt')
      await fsp.writeFile(source, 'two')
      await client.uploadAtomic(source, '/HDS/clean/doc.txt')
      const leftovers = [...pan.directories].filter(item => item.endsWith('.hds-tmp'))
      assert.deepEqual(leftovers, [], `staging directories must be removed, saw: ${leftovers.join(', ')}`)
    } finally {
      await fsp.rm(root.root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
