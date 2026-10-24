import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { yamlParse as parse, hasYaml, YAML_SKIP } from './helpers/optional-yaml.mjs'
import { Installer } from '../src/installer.mjs'
import { makeTestRoot } from './helpers/fake-client.mjs'

// A few assertions below re-parse the generated patch with a real YAML parser.
// Without the `yaml` devDependency they verify nothing, so skip those only.
const yaml = { skip: hasYaml ? false : YAML_SKIP }

async function makeInstaller(label) {
  const root = await makeTestRoot(label)
  const hdsHome = path.join(root.root, 'dsh-home')
  const profileDir = path.join(hdsHome, 'profiles', 'desktop')
  await fsp.mkdir(profileDir, { recursive: true })
  await fsp.writeFile(path.join(profileDir, 'cordis.patch.yml'), '# user patch\n- id: permission\n  config:\n    defaultPreset: danger-full-access\n')
  const config = {
    remoteRoot: '/HDS',
    configPath: path.join(root.root, 'config.json'),
    local: { ...root.config.local, root: root.root },
    hds: { home: hdsHome, profile: 'desktop', sessionsDir: path.join(hdsHome, 'sessions'), storagesDir: path.join(hdsHome, 'storages') },
    storageBackend: { remoteRoot: '/HDS/dsh', cacheRoot: path.join(root.root, 'cache'), offlinePolicy: 'reject' },
    mcp: { serverName: 'hds-baidu' },
  }
  return { root, config, profileDir, installer: new Installer({ config }) }
}

test('mcp plan shows a dry run that does not touch the patch file', yaml, async () => {
  const { config, profileDir, installer } = await makeInstaller('install-plan')
  const plan = await installer.plan('mcp')
  assert.equal(plan.kind, 'mcp')
  assert.equal(plan.alreadyInstalled, false)
  assert.match(await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), /defaultPreset/)
  const parsed = parse(plan.yaml)
  assert.equal(parsed[0].insert[0].id, 'mcp-hds-baidu')
  assert.equal(parsed[0].insert[0].config.serverName, config.mcp.serverName)
})

test('applying mcp appends a row and keeps a backup', async () => {
  const { profileDir, installer } = await makeInstaller('install-apply')
  const plan = await installer.plan('mcp')
  const result = await installer.apply(plan)
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  const text = await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /defaultPreset/)
  assert.match(text, /mcp-hds-baidu/)
  const backup = await fsp.readFile(result.backup, 'utf8')
  assert.doesNotMatch(backup, /mcp-hds-baidu/)
  const again = await installer.plan('mcp')
  assert.equal(again.alreadyInstalled, true)
  const second = await installer.apply(again)
  assert.equal(second.changed, false)
})

test('the appended file is still valid YAML with both entries', yaml, async () => {
  const { profileDir, installer } = await makeInstaller('install-yaml')
  await installer.apply(await installer.plan('mcp'))
  const parsed = parse(await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8'))
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].id, 'permission')
  assert.equal(parsed[1].insert[0].id, 'mcp-hds-baidu')
})

test('storage plan reports the plugin link it would create', yaml, async () => {
  const { config, installer } = await makeInstaller('install-storage')
  const plan = await installer.plan('storage')
  assert.equal(plan.link.exists, false)
  assert.equal(plan.link.path, path.join(config.hds.home, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh-storage-baidu'))
  assert.match(plan.link.target, /plugin\\dsh-storage-baidu$/)
  const parsed = parse(plan.yaml)
  assert.equal(parsed[0].insert[0].id, 'storage-baidu')
})

test('the domain switch is a separate, explicit step', yaml, async () => {
  const { profileDir, installer } = await makeInstaller('install-domain')
  const plan = await installer.plan('domain')
  assert.deepEqual(parse(plan.yaml), [{ id: 'storage-domain', config: { backend: 'baidu' } }])
  await installer.apply(plan)
  const text = await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /backend: 'baidu'/)
  assert.equal(parse(text).some(entry => entry.id === 'storage-domain'), true)
})

test('rollback restores the newest patch backup', async () => {
  const { profileDir, installer } = await makeInstaller('install-rollback')
  const before = await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  const result = await installer.apply(await installer.plan('mcp'))
  assert.match(await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), /mcp-hds-baidu/)
  const rollback = await installer.rollback()
  assert.equal(rollback.ok, true)
  assert.equal(rollback.restoredFrom, result.backup)
  assert.equal(await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), before)
})
