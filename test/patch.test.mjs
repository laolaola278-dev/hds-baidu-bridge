import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { yamlParse as parse, hasYaml, YAML_SKIP } from './helpers/optional-yaml.mjs'
import {
  JsExpression,
  mcpPatchEntries,
  quote,
  storageBackendPatchEntries,
  storageDomainSwitchEntries,
  toYamlPatch,
} from '../src/patch.mjs'

// Every test below asserts against a real YAML parser. Without the `yaml`
// devDependency installed they verify nothing, so skip rather than pretend.
const yaml = { skip: hasYaml ? false : YAML_SKIP }

test('backslashes survive single-quoted YAML', yaml, () => {
  const text = toYamlPatch([{ insert: [{ id: 'x', config: { root: 'G:\\project\\a b\\c' } }] }])
  const parsed = parse(text)
  assert.equal(parsed[0].insert[0].config.root, 'G:\\project\\a b\\c')
})

test('embedded single quotes are doubled', yaml, () => {
  assert.equal(quote("it's"), "'it''s'")
  const parsed = parse(toYamlPatch([{ insert: [{ id: 'x', name: "a'b" }] }]))
  assert.equal(parsed[0].insert[0].name, "a'b")
})

test('MCP patch round-trips through a YAML parser', yaml, () => {
  const text = toYamlPatch(mcpPatchEntries({
    node: 'D:\\前端\\nodejs\\node.exe',
    server: 'G:\\project\\hds-baidu-bridge\\mcp-server.mjs',
    configPath: 'G:\\project\\hds-baidu-bridge\\config\\config.json',
  }))
  const parsed = parse(text)
  const config = parsed[0].insert[0].config
  assert.equal(parsed[0].insert[0].id, 'mcp-hds-baidu')
  assert.equal(parsed[0].insert[0].name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(config.command, 'D:\\前端\\nodejs\\node.exe')
  assert.deepEqual(config.args, ['G:\\project\\hds-baidu-bridge\\mcp-server.mjs'])
  assert.equal(config.env.HDS_BAIDU_CONFIG, 'G:\\project\\hds-baidu-bridge\\config\\config.json')
  assert.equal(config.toolCallTimeoutMs, 120000)
  assert.equal(config.failOnStartupError, false)
  assert.deepEqual(config.reconnect, { enabled: true })
})

test('the token is never captured into the profile patch', yaml, () => {
  const entries = mcpPatchEntries({ node: 'node', server: 's.mjs', configPath: 'c.json' })
  const env = entries[0].insert[0].config.env
  assert.deepEqual(Object.keys(env), ['HDS_BAIDU_CONFIG'])
  assert.equal(JSON.stringify(entries).includes('ACCESS_TOKEN'), false)
})

test('a js expression still emits as a tagged scalar', yaml, () => {
  const parsed = parse(toYamlPatch([{ insert: [{ id: 'x', config: { value: new JsExpression('1 + 1') } }] }]), {
    customTags: [{
      tag: 'tag:yaml.org,2002:js',
      resolve: value => ({ expression: value }),
    }],
  })
  assert.deepEqual(parsed[0].insert[0].config.value, { expression: '1 + 1' })
})

test('storage backend patch carries the approved drive only', yaml, () => {
  const parsed = parse(toYamlPatch(storageBackendPatchEntries({
    remoteRoot: '/HDS/dsh',
    cacheRoot: 'G:\\project\\var\\dsh-storage-cache',
  })))
  const config = parsed[0].insert[0].config
  assert.equal(parsed[0].insert[0].id, 'storage-baidu')
  assert.deepEqual(config.allowedDrives, ['G'])
  assert.equal(config.offlinePolicy, 'reject')
  assert.equal(config.accessTokenEnv, 'BAIDU_NETDISK_ACCESS_TOKEN')
})

test('the domain switch is an id override, not an insert', yaml, () => {
  const parsed = parse(toYamlPatch(storageDomainSwitchEntries()))
  assert.deepEqual(parsed, [{ id: 'storage-domain', config: { backend: 'baidu' } }])
})

test('empty arrays and objects emit valid YAML', yaml, () => {
  const parsed = parse(toYamlPatch([{ insert: [{ id: 'x', config: { list: [], map: {} } }] }]))
  assert.deepEqual(parsed[0].insert[0].config, { list: [], map: {} })
})

test('nested arrays of objects emit valid YAML', yaml, () => {
  const entries = [{ insert: [{ id: 'g', group: true, config: [{ id: 'a' }, { id: 'b', config: { deep: [{ k: 1 }] } }] }] }]
  const parsed = parse(toYamlPatch(entries))
  assert.deepEqual(parsed, entries)
})

test('an unsupported value is rejected instead of guessed', () => {
  assert.throws(() => toYamlPatch([{ insert: [{ id: 'x', when: new Date() }] }]), /cannot emit YAML value/)
})
