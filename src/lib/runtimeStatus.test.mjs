import assert from 'node:assert/strict'
import test from 'node:test'
import { loadModule, deferred } from './testHelpers/loadModule.mjs'
import { normalizeEngineResponse } from './engine/contracts.js'

function engineClientFromInvoke(invoke) {
  return {
    status: {
      profile: args => invoke('openclaw_profile_status', args),
      connection: args => invoke('openclaw_connection_snapshot', args),
      get: args => invoke('openclaw_status', args),
      bridge: args => invoke('conversation_bridge_status', args),
    },
  }
}

async function runtime(invoke, engineClient = engineClientFromInvoke(invoke)) {
  return loadModule(new URL('./runtimeStatus.js', import.meta.url), {
    '@tauri-apps/api/core': { invoke },
    './engine/client.js': { engineClient },
    './engine/contracts.js': { normalizeEngineResponse },
    react: { useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() },
  })
}

test('status refreshes use engineClient and store only camelCase snapshots', async () => {
  const calls = []
  const status = {
    profile: async args => {
      calls.push(['profile', args])
      return { profileExists: true, gatewayStatus: 'running' }
    },
    connection: async args => {
      calls.push(['connection', args])
      return { status: 'connected', endpointUrl: 'ws://127.0.0.1:19001' }
    },
    get: async args => {
      calls.push(['get', args])
      return { installed: true, providerReady: true, latestVersion: '2026.8.1' }
    },
    bridge: async args => {
      calls.push(['bridge', args])
      return { gatewayAligned: true }
    },
  }
  const mod = await runtime(
    () => { throw new Error('direct Tauri status invoke bypassed engineClient') },
    { status },
  )

  await mod.refreshOpenClawProfileStatus({ profile: 'alice', gatewayPort: 19001 })
  await mod.refreshGatewayConnectionSnapshot({ profile: 'alice', gatewayPort: 19001 })
  await mod.refreshOpenClawStatus()
  await mod.refreshConversationBridgeStatus({ profile: 'alice' })

  assert.deepEqual(calls, [
    ['profile', { input: { profile: 'alice', gatewayPort: 19001 } }],
    ['connection', { input: { profile: 'alice', gatewayPort: 19001 } }],
    ['get', {}],
    ['bridge', { profile: 'alice' }],
  ])
  const state = mod.useRuntimeStatusStore()
  assert.equal(state.openClaw.status.providerReady, true)
  assert.equal('provider_ready' in state.openClaw.status, false)
  assert.equal(state.conversationBridge.status.gatewayAligned, true)
})

test('runtime boundary exposes stable Gateway readiness details', async () => {
  const mod = await runtime(async () => null)

  assert.deepEqual(mod.getGatewayConnectionReadiness({ status: 'connected' }), {
    ready: true,
    status: 'connected',
    message: '',
  })
  assert.deepEqual(mod.getGatewayConnectionReadiness({ status: 'disconnected', message: 'offline' }), {
    ready: false,
    status: 'disconnected',
    message: 'offline',
  })
})

test('runtime setters normalize legacy observations before publishing them', async () => {
  const mod = await runtime(async () => null)

  mod.setOpenClawRuntimeStatus({ installed: true, provider_ready: true })
  mod.setGatewayConnectionRuntimeSnapshot(
    { profile: 'alice' },
    { status: 'connected', endpoint_url: 'ws://127.0.0.1:19001' },
  )

  const state = mod.useRuntimeStatusStore()
  assert.deepEqual(state.openClaw.status, { installed: true, providerReady: true })
  assert.equal(mod.getGatewayConnectionSnapshot('alice').endpointUrl, 'ws://127.0.0.1:19001')
})

test('a slow disconnected probe cannot overwrite the newer verified start snapshot', async () => {
  const pending = deferred()
  const mod = await runtime(() => pending.promise)
  const probe = mod.refreshGatewayConnectionSnapshot({ profile: 'alice' })
  const connected = { status: 'connected', endpointUrl: 'ws://127.0.0.1:19001' }
  assert.equal(typeof mod.setGatewayConnectionRuntimeSnapshot, 'function')
  mod.setGatewayConnectionRuntimeSnapshot({ profile: 'alice' }, connected)
  pending.resolve({ status: 'disconnected' })
  assert.deepEqual(await probe, connected)
  assert.deepEqual(mod.getGatewayConnectionSnapshot('alice'), connected)
  assert.equal(mod.getGatewayConnectionSnapshot('bob'), null)
})

test('new observations can report a real disconnect after a successful start', async () => {
  const disconnected = { status: 'disconnected' }
  const mod = await runtime(async () => disconnected)
  assert.equal(typeof mod.setGatewayConnectionRuntimeSnapshot, 'function')
  mod.setGatewayConnectionRuntimeSnapshot({ profile: 'alice' }, { status: 'connected' })
  await mod.refreshGatewayConnectionSnapshot({ profile: 'alice' })
  assert.equal(mod.getGatewayConnectionSnapshot('alice'), disconnected)
})

test('late probe errors cannot replace newer startup success or cross Profile boundaries', async () => {
  const pending = deferred()
  const mod = await runtime(() => pending.promise)
  const probe = mod.refreshGatewayConnectionSnapshot({ profile: 'alice' })
  assert.equal(typeof mod.setGatewayConnectionRuntimeSnapshot, 'function')
  mod.setGatewayConnectionRuntimeSnapshot({ profile: 'alice' }, { status: 'connected' })
  pending.reject(new Error('old probe'))
  await assert.rejects(probe)
  assert.equal(mod.useRuntimeStatusStore().gatewayConnection.errors.alice, null)
  assert.equal(mod.getGatewayConnectionSnapshot('alice').status, 'connected')
})

test('session invalidation removes cached readiness and ignores old pending probes', async () => {
  const pending = deferred()
  const mod = await runtime(() => pending.promise)
  mod.setGatewayConnectionRuntimeSnapshot({ profile: 'alice' }, { status: 'connected' })
  const probe = mod.refreshGatewayConnectionSnapshot({ profile: 'alice' })
  assert.equal(typeof mod.invalidateGatewayConnectionRuntimeSnapshot, 'function')
  mod.invalidateGatewayConnectionRuntimeSnapshot({ profile: 'alice' })
  assert.equal(mod.getGatewayConnectionSnapshot('alice'), null)
  pending.resolve({ status: 'connected' })
  assert.equal(await probe, null)
  assert.equal(mod.getGatewayConnectionSnapshot('alice'), null)
})
