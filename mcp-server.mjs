#!/usr/bin/env node
/**
 * Write-capable stdio MCP bridge for Baidu Netdisk and HDS sync/backup.
 *
 * Unlike the read-only audit bridge, this server exposes upload and download
 * tools, but:
 *   - local paths are restricted to approved drives and C: is always refused;
 *   - remote writes stay under the configured remote root;
 *   - destructive remote deletion is disabled by default and needs confirm.
 */
import { startMcpServer } from './src/mcp-server.mjs'

startMcpServer().catch(error => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error?.code ?? 'error',
    message: error?.message ?? String(error),
  })}\n`)
  process.exitCode = 1
})
