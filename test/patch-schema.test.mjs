import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { yamlParse as parse, hasYaml, YAML_SKIP } from './helpers/optional-yaml.mjs'
import { mcpPatchEntries, storageBackendPatchEntries, toYamlPatch } from '../src/patch.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Validate the YAML we install against the REAL plugin config schemas.
 *
 * `patch.test.mjs` proves the emitter round-trips through a YAML parser. That
 * says nothing about whether DSH will actually accept the resulting rows: a
 * typo in a key, an unknown enum value or a bad `serverName` would only surface
 * when the profile is loaded, long after the patch was written. These tests
 * feed the generated rows through the packages' own Schemastery `Config`.
 *
 * The DSH packages are located relative to `DSH_HOME` when it is set, and via
 * `DSH_MCP_CLIENT_LIB` as an explicit override. Hard-coding a developer's
 * absolute path made every checkout elsewhere skip for the wrong reason and
 * leaked that layout into the repository.
 */
const HDS_HOME = process.env.DSH_HOME || undefined
const PROFILE_MODULES = HDS_HOME ? path.join(HDS_HOME, 'profiles', 'node_modules') : undefined
const MCP_CLIENT_LIB = process.env.DSH_MCP_CLIENT_LIB
  || (PROFILE_MODULES
    ? path.join(PROFILE_MODULES, '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js')
    : undefined)
const STORAGE_BAIDU_LIB = path.resolve(PROJECT_ROOT, 'plugin', 'dsh-storage-baidu', 'index.js')

async function loadConfigs() {
  if (!MCP_CLIENT_LIB) return undefined
  const mcpPresent = await fsp.stat(MCP_CLIENT_LIB).then(stat => stat.isFile(), () => false)
  if (!mcpPresent) return undefined
  const mcp = await import(pathToFileURL(MCP_CLIENT_LIB).href)
  return { mcp }
}

const real = await loadConfigs()
const skip = real
  ? (hasYaml ? false : YAML_SKIP)
  : 'set DSH_HOME or DSH_MCP_CLIENT_LIB to a DSH install to run this contract check'
const skipYaml = hasYaml ? false : YAML_SKIP

test('the installed MCP row satisfies the real mcp-client Config schema', { skip }, () => {
  const entries = mcpPatchEntries({
    node: process.execPath,
    server: path.resolve(PROJECT_ROOT, 'mcp-server.mjs'),
    configPath: path.resolve(PROJECT_ROOT, 'config', 'config.json'),
    serverName: 'hds-baidu',
  })
  const parsed = parse(toYamlPatch(entries))
  const row = parsed[0].insert[0]
  assert.equal(row.name, '@deepseek-ai/dsh-mcp-client')

  // Schemastery validates and fills defaults; a throw here means DSH would
  // reject the profile row at load time.
  const config = real.mcp.Config(row.config)
  assert.equal(config.transport, 'stdio')
  assert.equal(config.serverName, 'hds-baidu')
  assert.equal(config.command, process.execPath)
  assert.equal(config.failOnStartupError, false)
  assert.equal(config.reconnect.enabled, true)
  assert.equal(config.env.HDS_BAIDU_CONFIG, path.resolve(PROJECT_ROOT, 'config', 'config.json'))
  // The token must never be baked into the profile.
  assert.equal(Object.keys(config.env).includes('BAIDU_NETDISK_ACCESS_TOKEN'), false)
})

test('the generated serverName fits the real public tool-name budget', { skip }, () => {
  const entries = mcpPatchEntries({
    node: 'n',
    server: 's',
    configPath: 'G:\\c.json',
    serverName: 'hds-baidu',
  })
  const config = real.mcp.Config(parse(toYamlPatch(entries))[0].insert[0].config)
  // mcp__<serverName>__<rawName> must stay inside the host's tool-name limit.
  for (const tool of ['hds_baidu_status', 'hds_project_sync_apply', 'hds_mirror_status']) {
    const publicName = `mcp__${config.serverName}__${tool}`
    assert.ok(publicName.length <= 64, `tool name too long: ${publicName}`)
    assert.match(publicName, /^[A-Za-z0-9_-]+$/)
  }
})

test('a name that fails the real schema is rejected before it reaches the profile', { skip }, () => {
  // Guardrail against a future refactor that skips validation: the schema is
  // what stops a bad serverName, and our emitter must not paper over it.
  assert.throws(() => real.mcp.Config({ transport: 'stdio', serverName: 'bad name!', command: 'n' }))
})

test('the storage backend row keeps every key the plugin actually reads', { skip: skipYaml }, async () => {
  const entries = storageBackendPatchEntries({
    remoteRoot: '/HDS/dsh',
    cacheRoot: path.resolve(PROJECT_ROOT, 'var', 'dsh-storage-cache'),
    offlinePolicy: 'reject',
    allowedDrive: 'G',
  })
  const row = parse(toYamlPatch(entries))[0].insert[0]
  assert.equal(row.name, '@deepseek-ai/dsh-storage-baidu')

  // Cross-check against the plugin's own declared Config rather than a copy of
  // it, so the two cannot drift apart.
  const plugin = await import(pathToFileURL(STORAGE_BAIDU_LIB).href)
  const declared = Object.keys(plugin.Config.properties)
  for (const key of Object.keys(row.config)) {
    assert.ok(declared.includes(key), `plugin Config does not declare '${key}'`)
  }
  for (const required of plugin.Config.required ?? []) {
    assert.equal(typeof row.config[required], 'string', `required key '${required}' must be present`)
  }
  assert.equal(row.config.offlinePolicy, 'reject')
  assert.deepEqual(row.config.allowedDrives, ['G'])
  assert.equal(row.name, '@deepseek-ai/dsh-storage-baidu')
  assert.equal(row.id, 'storage-baidu')
})
