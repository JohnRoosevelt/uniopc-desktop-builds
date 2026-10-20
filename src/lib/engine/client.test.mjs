import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  ENGINE_COMMANDS,
  ENGINE_ERROR_CODES,
  EngineClientError,
} from './contracts.js'
import { createEngineClient } from './client.js'

function recordingClient(responses = new Map()) {
  const calls = []
  const client = createEngineClient({
    invoke: async (command, args) => {
      calls.push({ command, args })
      const response = responses.get(command)
      return typeof response === 'function' ? response(args) : response
    },
  })
  return { calls, client }
}

test('status, sessions, models, agents, and plugins use stable Tauri command names', async () => {
  const responses = new Map([
    [ENGINE_COMMANDS.status.get, { gateway_running: true, gateway_rpc_ok: true }],
    [ENGINE_COMMANDS.sessions.list, { sessions: [], next_offset: null }],
    [ENGINE_COMMANDS.models.snapshot, { primary_model: 'openai/gpt-5.5' }],
    [ENGINE_COMMANDS.agents.list, [{ id: 'researcher' }]],
    [ENGINE_COMMANDS.plugins.listProfile, { profile: 'owner', plugins: [] }],
  ])
  const { calls, client } = recordingClient(responses)

  const status = await client.status.get()
  const sessions = await client.sessions.list({ req: { agent_id: 'researcher', profile: 'owner' } })
  const models = await client.models.snapshot({ profile: 'owner' })
  const agents = await client.agents.list({ profile: 'owner' })
  const plugins = await client.plugins.listProfile({ profile: 'owner' })

  assert.deepEqual(calls, [
    { command: 'openclaw_status', args: {} },
    {
      command: 'conversation_list_sessions',
      args: { req: { agentId: 'researcher', profile: 'owner' } },
    },
    { command: 'openclaw_models_snapshot', args: { profile: 'owner' } },
    { command: 'openclaw_agents_list', args: { profile: 'owner' } },
    { command: 'openclaw_profile_plugins_list', args: { profile: 'owner' } },
  ])
  assert.deepEqual(status, { gatewayRunning: true, gatewayRpcOk: true })
  assert.deepEqual(sessions, { sessions: [], nextOffset: null })
  assert.deepEqual(models, { primaryModel: 'openai/gpt-5.5' })
  assert.deepEqual(agents, [{ id: 'researcher' }])
  assert.deepEqual(plugins, { profile: 'owner', plugins: [] })
})

test('every engineClient method is backed by its declared stable command', async () => {
  const { calls, client } = recordingClient()
  const expectedCommands = []

  for (const [domainName, commands] of Object.entries(ENGINE_COMMANDS)) {
    assert.deepEqual(
      Object.keys(client[domainName]).sort(),
      Object.keys(commands).sort(),
      `${domainName} methods must match its command contract`,
    )
    for (const [methodName, command] of Object.entries(commands)) {
      expectedCommands.push(command)
      await client[domainName][methodName]()
    }
  }

  assert.deepEqual(calls.map(call => call.command), expectedCommands)
})

test('request normalization preserves opaque engine config and credential maps', async () => {
  const { calls, client } = recordingClient(new Map([
    [ENGINE_COMMANDS.plugins.setMcpServer, { servers: [] }],
    [ENGINE_COMMANDS.plugins.setProfile, { plugins: [] }],
  ]))

  await client.plugins.setMcpServer({
    req: {
      profile: 'owner',
      name: 'private-db',
      config: {
        connection_timeout_ms: 5000,
        env: { private_api_key: 'secret' },
      },
    },
  })
  await client.plugins.setProfile({
    req: {
      profile: 'owner',
      plugin_id: 'private-db',
      enabled: true,
      plugin_env: { private_api_key: 'secret' },
    },
  })

  assert.deepEqual(calls[0].args, {
    req: {
      profile: 'owner',
      name: 'private-db',
      config: {
        connection_timeout_ms: 5000,
        env: { private_api_key: 'secret' },
      },
    },
  })
  assert.deepEqual(calls[1].args, {
    req: {
      profile: 'owner',
      pluginId: 'private-db',
      enabled: true,
      pluginEnv: { private_api_key: 'secret' },
    },
  })
})

test('backend error DTOs become typed stable client errors', async () => {
  const client = createEngineClient({
    invoke: async () => {
      throw {
        code: 'plugin_api_incompatible',
        message: 'Plugin API range is not supported',
        retryable: false,
        plugin_api_requirement: '>=2026.8.1',
        host_version: '2026.8.1',
      }
    },
  })

  await assert.rejects(
    client.plugins.prepareLifecycle({ req: { pluginId: 'sample' } }),
    error => {
      assert.ok(error instanceof EngineClientError)
      assert.equal(error.code, 'plugin_api_incompatible')
      assert.equal(error.command, 'uniopc_plugin_lifecycle_prepare')
      assert.equal(error.retryable, false)
      assert.equal(error.pluginApiRequirement, '>=2026.8.1')
      assert.equal(error.hostVersion, '2026.8.1')
      return true
    },
  )
})

test('a caller can cancel waiting for an in-flight engine command', async () => {
  const controller = new AbortController()
  const client = createEngineClient({ invoke: () => new Promise(() => {}) })
  const pending = client.models.snapshot(
    { profile: 'owner' },
    { signal: controller.signal },
  )

  controller.abort()

  await assert.rejects(
    pending,
    error => error instanceof EngineClientError
      && error.code === ENGINE_ERROR_CODES.cancelled
      && error.command === 'openclaw_models_snapshot',
  )
})

test('command timeouts reject with a typed retryable error', async () => {
  const client = createEngineClient({ invoke: () => new Promise(() => {}) })

  await assert.rejects(
    client.status.get({}, { timeoutMs: 5 }),
    error => error instanceof EngineClientError
      && error.code === ENGINE_ERROR_CODES.timeout
      && error.command === 'openclaw_status'
      && error.retryable
      && error.timeoutMs === 5,
  )
})

test('MCP writes recover a committed result when the command reply is lost', async () => {
  let setAttempts = 0
  const calls = []
  const client = createEngineClient({
    invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'openclaw_mcp_server_set') {
        setAttempts += 1
        throw {
          code: 'engine_transport_reply_lost',
          message: 'gateway restarted before reply',
          retryable: true,
        }
      }
      return {
        servers: [{
          name: 'private-db',
          config: { env: { TOKEN: 'secret' }, command: 'private-db' },
        }],
      }
    },
  })

  const snapshot = await client.plugins.setMcpServer({
    req: {
      profile: 'owner',
      name: 'private-db',
      config: { command: 'private-db', env: { TOKEN: 'secret' } },
    },
  })

  assert.equal(setAttempts, 1)
  assert.deepEqual(calls.map(call => call.command), [
    'openclaw_mcp_server_set',
    'openclaw_mcp_servers_list',
  ])
  assert.deepEqual(snapshot.servers.map(server => server.name), ['private-db'])
})

test('MCP writes do not confirm or mask a nonretryable rejection', async () => {
  const calls = []
  const client = createEngineClient({
    invoke: async command => {
      calls.push(command)
      throw {
        code: 'mcp_config_invalid',
        message: 'MCP config is invalid',
        retryable: false,
      }
    },
  })

  await assert.rejects(
    client.plugins.setMcpServer({
      req: { profile: 'owner', name: 'private-db', config: { command: 'private-db' } },
    }),
    error => error.code === 'mcp_config_invalid' && error.retryable === false,
  )
  assert.deepEqual(calls, ['openclaw_mcp_server_set'])
})

test('cancellation during MCP confirmation is propagated', async () => {
  const controller = new AbortController()
  let confirmationStarted
  const started = new Promise(resolve => { confirmationStarted = resolve })
  const client = createEngineClient({
    invoke: async command => {
      if (command === 'openclaw_mcp_server_set') {
        throw { code: 'engine_transport_reply_lost', retryable: true }
      }
      confirmationStarted()
      return new Promise(() => {})
    },
  })
  const pending = client.plugins.setMcpServer(
    { req: { profile: 'owner', name: 'private-db', config: { command: 'private-db' } } },
    { signal: controller.signal },
  )

  await started
  controller.abort()

  await assert.rejects(
    pending,
    error => error.code === ENGINE_ERROR_CODES.cancelled
      && error.command === 'openclaw_mcp_servers_list',
  )
})

test('conversation, plugin, and employee surfaces keep engine invokes behind engineClient', () => {
  const files = [
    '../../pages/Conversations.jsx',
    '../../pages/McpHub.jsx',
    '../../pages/Employees.jsx',
    '../../pages/AdminMemberDetail.jsx',
    '../../pages/conversations/InlineEmployeeSettingsPanel.jsx',
    '../conversations/client.js',
    '../openclawEmployees.js',
  ]
  const directEngineInvokes = []

  for (const relativePath of files) {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    for (const match of source.matchAll(/\b(?:invoke|invokeWithTimeout)\(\s*['"]([^'"]+)/g)) {
      const command = match[1]
      const isEngineCommand = command.startsWith('conversation_')
        || command.startsWith('uniopc_plugin_')
        || command.startsWith('uniopc_cloud_plugin_')
        || (command.startsWith('openclaw_') && command !== 'openclaw_open_external_url')
      if (isEngineCommand) directEngineInvokes.push(`${relativePath}:${command}`)
    }
  }

  assert.deepEqual(directEngineInvokes, [])
  const conversationClient = fs.readFileSync(
    new URL('../conversations/client.js', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(
    conversationClient,
    /\b(?:meta|res|message|session)\??\.[a-z][a-z0-9]*_[a-z0-9_]+/,
  )

  const conversationPage = fs.readFileSync(new URL('../../pages/Conversations.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(
    conversationPage,
    /\b(?:snapshot\?\.(?:resolved_default_model|primary_model)|sessionMeta\?\.(?:reasoning_level|model_provider|default_model)|runtimeOpenClawStatus\?\.(?:resolved_default_model|default_model)|activeEmployee\?\.(?:openclaw_agent_id|default_model)|[ab]\.is_default)/,
  )
  const employeePage = fs.readFileSync(new URL('../../pages/Employees.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(
    employeePage,
    /\b(?:created\.openclaw_agent_id|item\.relative_path|employeeDocumentDetail\?\.relative_path|employee\?\.(?:openclaw_agent_id|default_model)|[ab]\.is_default|selectedEmployee\?\.(?:workspace_path|bindings_count)|selectedEmployee\.is_default|openClawStatus\?\.(?:resolved_default_model|default_model))/,
  )
  const inlineEmployeePanel = fs.readFileSync(
    new URL('../../pages/conversations/InlineEmployeeSettingsPanel.jsx', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(
    inlineEmployeePanel,
    /\bemployee\??\.(?:openclaw_agent_id|default_model|is_default)/,
  )
  const employeeDetailPane = fs.readFileSync(
    new URL('../../pages/employees/EmployeeDetailPane.jsx', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(
    employeeDetailPane,
    /\bemployee\.(?:activation_error|employee_type|openclaw_profile|created_at|updated_at)/,
  )

  for (const relativePath of [
    '../../pages/ModelSettings.jsx',
    '../../pages/OpenClawRuntime.jsx',
    '../../pages/OpenClawSetupGate.jsx',
    '../openclawModels.js',
  ]) {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    assert.doesNotMatch(
      source,
      /\b(?:status|fallback|snapshot|activeModelStatus|item)(?:\?)?\.(?:latest_version|update_available|setup_stage|binary_path|update_message|node_version|proxy_summary|gateway_running|gateway_status_message|dashboard_url|resolved_default_model|default_model|provider_mode|provider_status|provider_ready|auth_profile_labels|runtime_compat_ready|runtime_compat_message|primary_model|model_ref|catalog_available)/,
      `${relativePath} must consume only stable camelCase engine fields`,
    )
  }
})
