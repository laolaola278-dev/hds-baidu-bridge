import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { McpServer, TOOL_DEFINITIONS } from '../src/mcp-server.mjs'
import { makeTestRoot } from './helpers/fake-client.mjs'
import { Writable } from 'node:stream'

test('every tool has a unique name and an object schema', () => {
  const names = TOOL_DEFINITIONS.map(tool => tool.name)
  assert.equal(new Set(names).size, names.length)
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.inputSchema.type, 'object')
  }
  // The five requested capabilities must each have a tool.
  for (const required of [
    'hds_project_upload',
    'hds_project_download',
    'hds_project_sync_plan',
    'hds_project_sync_apply',
    'hds_backup',
    'hds_restore',
    'hds_mirror_status',
  ]) {
    assert.ok(names.includes(required), `missing tool: ${required}`)
  }
})

test('initialize and tools/list work without a token', async () => {
  const root = await makeTestRoot('mcp-list')
  const config = {
    ...root.config,
    remoteRoot: '/HDS',
    mcp: { allowDestructiveTools: false },
    storageBackend: { requestTimeoutMs: 1000 },
  }
  let output = ''
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString()
      callback()
    },
  })
  const server = new McpServer({ config, token: undefined, stdout })
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const messages = output.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(messages[0].result.serverInfo.name, 'hds-baidu-bridge')
  assert.ok(messages[1].result.tools.length >= 8)
})

test('status reports no token without leaking anything', async () => {
  const root = await makeTestRoot('mcp-status')
  const config = {
    ...root.config,
    remoteRoot: '/HDS',
    hds: { home: root.root, profile: 'test' },
    mcp: { allowDestructiveTools: false },
    storageBackend: { requestTimeoutMs: 1000 },
  }
  const server = new McpServer({ config, token: undefined })
  const status = await server.callTool('hds_baidu_status', {})
  assert.equal(status.tokenConfigured, false)
  await assert.rejects(server.callTool('hds_baidu_doctor', {}), /not configured/)
})

test('delete is disabled unless explicitly enabled', async () => {
  const root = await makeTestRoot('mcp-delete')
  const config = {
    ...root.config,
    remoteRoot: '/HDS',
    hds: { home: root.root, profile: 'test' },
    mcp: { allowDestructiveTools: false },
    storageBackend: { requestTimeoutMs: 1000 },
  }
  const server = new McpServer({ config, token: 'fake-token' })
  await assert.rejects(
    server.callTool('hds_baidu_delete', { paths: ['/HDS/x'], confirm: true }),
    /disabled/,
  )
})

test('C: paths are rejected before any Baidu call', async () => {
  const root = await makeTestRoot('mcp-cdrive')
  const config = {
    ...root.config,
    remoteRoot: '/HDS',
    hds: { home: root.root, profile: 'test' },
    mcp: { allowDestructiveTools: false },
    storageBackend: { requestTimeoutMs: 1000 },
  }
  const server = new McpServer({ config, token: 'fake-token' })
  await assert.rejects(
    server.callTool('hds_baidu_download', { remotePath: '/HDS/a', localPath: 'C:\\temp\\a' }),
    /refusing to touch C:/,
  )
})

test('a token that appears after startup is picked up without a restart', async () => {
  const root = await makeTestRoot('mcp-late-token')
  const config = {
    ...root.config,
    remoteRoot: '/HDS',
    hds: { home: root.root, profile: 'test' },
    mcp: { allowDestructiveTools: false },
    storageBackend: { requestTimeoutMs: 1000 },
  }
  // The server is constructed the way HDS constructs it — once, at app start,
  // before the user has logged in.
  const server = new McpServer({ config, token: undefined })
  const before = await server.callTool('hds_baidu_status', {})
  assert.equal(before.tokenConfigured, false)

  // `token login` writes the credential while the server is already running.
  await fsp.mkdir(config.local.stateDir, { recursive: true })
  await fsp.writeFile(
    path.join(config.local.stateDir, 'credentials.json'),
    `${JSON.stringify({ accessToken: 'late-token-1234567890' })}\n`,
  )

  const after = await server.callTool('hds_baidu_status', {})
  assert.equal(after.tokenConfigured, true, 'status must reflect the credential now on disk')
  // And a live tool must stop refusing to run.
  await assert.rejects(server.callTool('hds_baidu_list', { path: '/HDS' }), error => {
    assert.notEqual(error.code, 'token-missing', 'the late token must be used')
    return true
  })
})
