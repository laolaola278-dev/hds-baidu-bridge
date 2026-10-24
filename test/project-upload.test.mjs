import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { ProjectUploader, spawnGitBundle } from '../src/project-upload.mjs'
import { FakeBaiduClient, makeTestRoot } from './helpers/fake-client.mjs'

async function setup(label) {
  const root = await makeTestRoot(label)
  const project = path.join(root.root, 'project')
  await fsp.mkdir(project, { recursive: true })
  await fsp.writeFile(path.join(project, 'README.md'), '# demo\n')
  await fsp.mkdir(path.join(project, 'src'), { recursive: true })
  await fsp.writeFile(path.join(project, 'src', 'main.js'), 'console.log(1)\n')
  await fsp.mkdir(path.join(project, 'node_modules', 'x'), { recursive: true })
  await fsp.writeFile(path.join(project, 'node_modules', 'x', 'index.js'), 'ignored\n')
  const config = {
    ...root.config,
    local: { ...root.config.local, root: root.root },
  }
  return { root, project, config, client: new FakeBaiduClient() }
}

test('a project plan excludes node_modules and reports the sync surface', async () => {
  const { project, config, client, root } = await setup('upload-plan')
  const uploader = new ProjectUploader({ client, config })
  const plan = await uploader.plan({ project, remoteDir: `${root.remoteRoot}/demo` })
  assert.equal(plan.syncPlan.summary.uploads, 2)
  assert.equal(plan.bundle.enabled, false)
  assert.equal(plan.bundle.reason, 'not-a-git-repository')
})

test('a project apply uploads the tree to the remote directory', async () => {
  const { project, config, client, root } = await setup('upload-apply')
  const uploader = new ProjectUploader({ client, config })
  const plan = await uploader.plan({ project, remoteDir: `${root.remoteRoot}/demo` })
  const result = await uploader.apply(plan)
  assert.equal(result.ok, true)
  assert.equal(result.sync.counts.uploaded, 2)
  const paths = client.snapshot().map(item => item.remotePath).sort()
  assert.deepEqual(paths, [`${root.remoteRoot}/demo/README.md`, `${root.remoteRoot}/demo/src/main.js`])
})

test('a missing git produces a partial-but-successful upload', async () => {
  const { project, config, client, root } = await setup('upload-git-missing')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await fsp.writeFile(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const uploader = new ProjectUploader({
    client,
    config,
    execFile: async () => {
      const error = new Error('spawn git ENOENT')
      error.code = 'ENOENT'
      throw error
    },
  })
  const plan = await uploader.plan({ project, remoteDir: `${root.remoteRoot}/demo` })
  assert.equal(plan.bundle.enabled, true)
  const result = await uploader.apply(plan)
  assert.equal(result.bundle.ok, false)
  assert.equal(result.bundle.code, 'git-unavailable')
  assert.equal(result.sync.counts.uploaded, 2)
})

test('a git bundle is uploaded under _git and removed from staging', async () => {
  const { project, config, client, root } = await setup('upload-git-bundle')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await fsp.writeFile(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const uploader = new ProjectUploader({
    client,
    config,
    execFile: async (_file, args) => {
      await fsp.writeFile(args[2], 'bundle-bytes')
      return { stdout: '', stderr: '' }
    },
  })
  const plan = await uploader.plan({ project, remoteDir: `${root.remoteRoot}/demo` })
  const result = await uploader.apply(plan)
  assert.equal(result.ok, true)
  assert.equal(result.bundle.ok, true)
  assert.equal(client.snapshot().some(item => item.remotePath === `${root.remoteRoot}/demo/_git/project.bundle`), true)
  const staging = await fsp.readdir(path.join(config.local.stagingDir, 'bundles')).catch(() => [])
  assert.deepEqual(staging, [])
})

test('a failing git command is reported without leaking the command line', async () => {
  const { project, config, client, root } = await setup('upload-git-fail')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await fsp.writeFile(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const uploader = new ProjectUploader({
    client,
    config,
    execFile: async () => {
      const error = new Error('bundle failed')
      error.stderr = 'fatal: ambiguous argument --all'
      throw error
    },
  })
  const result = await uploader.apply(await uploader.plan({ project, remoteDir: `${root.remoteRoot}/demo` }))
  assert.equal(result.bundle.ok, false)
  assert.equal(result.bundle.code, 'git-bundle-failed')
  assert.match(result.bundle.message, /ambiguous argument/)
})

test('spawnGitBundle rejects a non-repository before spawning', async () => {
  const { project } = await setup('upload-not-repo')
  await assert.rejects(spawnGitBundle(project, path.join(project, 'x.bundle')), /not a git repository/)
})
