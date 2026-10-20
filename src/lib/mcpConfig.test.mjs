import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildMcpConfigFromForm,
  configToForm,
  maskSecretValue,
  mcpConfigEquivalent,
  keyValueRowsToText,
  keyValueTextToRows,
  parseKeyValueLines,
} from './mcpConfig.js'

test('parseKeyValueLines converts KEY=value lines into an object', () => {
  assert.deepEqual(parseKeyValueLines('A=1\nB=two'), { A: '1', B: 'two' })
})

test('parseKeyValueLines rejects malformed lines', () => {
  assert.throws(() => parseKeyValueLines('BROKEN'), /KEY=value/)
})

test('key value row helpers preserve default names and skip empty values for config output', () => {
  assert.deepEqual(keyValueTextToRows('', ['x-dune-api-key']), [
    { name: 'x-dune-api-key', value: '' },
  ])
  assert.deepEqual(keyValueTextToRows('A=1\nB='), [
    { name: 'A', value: '1' },
    { name: 'B', value: '' },
  ])
  assert.equal(
    keyValueRowsToText([
      { name: 'x-dune-api-key', value: '' },
      { name: 'Authorization', value: 'Bearer token' },
    ]),
    'Authorization=Bearer token',
  )
})

test('key value row helpers reject values without names', () => {
  assert.throws(
    () => keyValueRowsToText([{ name: '', value: 'secret' }]),
    /Name/,
  )
})

test('buildMcpConfigFromForm builds stdio config', () => {
  assert.deepEqual(
    buildMcpConfigFromForm({
      transport: 'stdio',
      command: 'uvx',
      argsText: 'context7-mcp',
      envText: 'TOKEN=abc',
      url: '',
      headersText: '',
      connectionTimeoutMs: '',
      cwd: '',
    }),
    {
      command: 'uvx',
      args: ['context7-mcp'],
      env: { TOKEN: 'abc' },
    },
  )
})

test('buildMcpConfigFromForm builds streamable http config', () => {
  assert.deepEqual(
    buildMcpConfigFromForm({
      transport: 'streamable-http',
      command: '',
      argsText: '',
      envText: '',
      url: 'https://mcp.example.com/stream',
      headersText: 'Authorization=Bearer token',
      connectionTimeoutMs: '10000',
      cwd: '',
    }),
    {
      url: 'https://mcp.example.com/stream',
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer token' },
      connectionTimeoutMs: 10000,
    },
  )
})

test('buildMcpConfigFromForm ignores empty env and header placeholder rows', () => {
  assert.deepEqual(
    buildMcpConfigFromForm({
      transport: 'streamable-http',
      command: '',
      argsText: '',
      envText: '',
      url: 'https://api.dune.com/mcp/v1',
      headersText: 'x-dune-api-key=',
      connectionTimeoutMs: '',
      cwd: '',
    }),
    {
      url: 'https://api.dune.com/mcp/v1',
      transport: 'streamable-http',
    },
  )
  assert.deepEqual(
    buildMcpConfigFromForm({
      transport: 'stdio',
      command: 'uvx',
      argsText: 'context7-mcp',
      envText: 'API_KEY=\nCACHE_TOKEN=hash',
      url: '',
      headersText: '',
      connectionTimeoutMs: '',
      cwd: '',
    }),
    {
      command: 'uvx',
      args: ['context7-mcp'],
      env: { CACHE_TOKEN: 'hash' },
    },
  )
})

test('configToForm infers stdio and masks secret-like values', () => {
  const form = configToForm({
    command: 'uvx',
    args: ['context7-mcp'],
    env: { API_KEY: 'secret' },
  })

  assert.equal(form.transport, 'stdio')
  assert.equal(form.command, 'uvx')
  assert.equal(form.argsText, 'context7-mcp')
  assert.equal(maskSecretValue('Authorization', 'Bearer token'), 'Bearer ******')
})

test('MCP config module does not expose local marketplace presets', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const config = fs.readFileSync(path.join(repoRoot, 'src/lib/mcpConfig.js'), 'utf8')
  const hub = fs.readFileSync(path.join(repoRoot, 'src/pages/McpHub.jsx'), 'utf8')

  assert.equal(config.includes('MCP_MARKET_PRESETS'), false)
  assert.equal(config.includes('TikHub'), false)
  assert.equal(config.includes('HeyGen MCP'), false)
  assert.equal(config.includes('Playwriter MCP'), false)
  assert.equal(hub.includes('engineClient.plugins.listMcpServers({ profile: activeProfile })'), true)
  assert.equal(hub.includes("invoke('openclaw_mcp_servers_list'"), false)
  assert.equal(hub.includes('MCP_MARKET_PRESETS'), false)
})

test('removed social media plugins are not bundled in the desktop repository', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  // 插件源码树已整体迁至 uniopc-plugins 仓(2026-07-30),桌面仓不再有 plugins/。
  assert.equal(fs.existsSync(path.join(repoRoot, 'plugins')), false)
})

test('Uniopc socials manifest contract now lives in the uniopc-plugins repo', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  // manifest 契约(contracts.tools 与云函数 action 对齐)随源码迁至
  // ../uniopc-plugins/uniopc-socials/,由该仓 npm test 的打包契约测试守护;
  // 桌面仓只保证不再持有第二份会漂移的副本。
  assert.equal(fs.existsSync(path.join(repoRoot, 'plugins/openclaw/uniopc-socials')), false)
})

test('mcpConfigEquivalent ignores object key order', () => {
  assert.equal(
    mcpConfigEquivalent(
      { command: 'npx', env: { B: '2', A: '1' } },
      { env: { A: '1', B: '2' }, command: 'npx' },
    ),
    true,
  )
})
