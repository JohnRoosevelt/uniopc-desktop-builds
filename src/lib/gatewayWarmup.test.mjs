import assert from 'node:assert/strict'
import test from 'node:test'
import { loadModule, deferred } from './testHelpers/loadModule.mjs'

async function warmupModule(invoke) {
  const published = []
  const failures = []
  const mod = await loadModule(new URL('./gatewayWarmup.js', import.meta.url), {
    '@tauri-apps/api/core': { invoke },
    './cloudWorkspacePluginAuth': { optionalCloudAgentRuntimeAuthEnv: () => new Promise(() => {}) },
    './runtimeStatus': {
      getGatewayConnectionSnapshot: () => null,
      isGatewayConnectionReady: snapshot => snapshot?.status === 'connected',
      setGatewayConnectionStartupPreparing: () => {},
      invalidateGatewayConnectionRuntimeSnapshot: () => {},
      refreshGatewayConnectionSnapshot: async () => { throw new Error('redundant probe') },
      setGatewayConnectionRuntimeSnapshot: (scope, snapshot) => published.push({ scope, snapshot }),
      setGatewayConnectionStartupError: (scope, error) => failures.push({ scope, error }),
    },
  })
  return { ...mod, published, failures }
}

test('warmup invokes local start immediately without cloud plugin credentials', async () => {
  const pending = deferred()
  const calls = []
  const mod = await warmupModule((...args) => { calls.push(args); return pending.promise })
  const task = mod.warmUpLocalGateway({ profile: ' alice ' })
  assert.deepEqual(calls, [['openclaw_connection_start_local', { input: { profile: 'alice', gatewayPort: null } }]])
  const snapshot = { status: 'connected', endpointUrl: 'ws://127.0.0.1:19001' }
  pending.resolve(snapshot)
  assert.equal(await task, snapshot)
  assert.deepEqual(mod.published, [{ scope: { profile: 'alice', gatewayPort: null }, snapshot }])
})

test('warmup shares a Profile attempt across port hints and permits retry after failure', async () => {
  const pending = deferred()
  let attempts = 0
  const mod = await warmupModule(() => { attempts++; return attempts === 1 ? pending.promise : Promise.resolve({ status: 'disconnected' }) })
  const first = mod.warmUpLocalGateway({ profile: 'alice' })
  assert.equal(mod.warmUpLocalGateway({ profile: 'alice', gatewayPort: 19001 }), first)
  assert.equal(mod.isGatewayWarmupInFlight({ profile: ' alice ' }), true)
  pending.reject(new Error('extraction failed'))
  await assert.rejects(first, /extraction failed/)
  assert.equal(mod.isGatewayWarmupInFlight({ profile: 'alice' }), false)
  assert.equal(mod.failures.find(entry => entry.error)?.error.message, 'extraction failed')
  assert.equal((await mod.warmUpLocalGateway({ profile: 'alice' })).status, 'disconnected')
  assert.equal(attempts, 2)
})

test('empty Profile is rejected without invoking Tauri', async () => {
  let called = false
  const mod = await warmupModule(() => { called = true })
  await assert.rejects(mod.warmUpLocalGateway({ profile: '  ' }), /Profile/)
  assert.equal(called, false)
})

test('a canceled session failure cannot overwrite a newer session startup', async () => {
  const pending = [deferred(), deferred()]
  let calls = 0
  const mod = await warmupModule(() => pending[calls++].promise)
  const previous = mod.warmUpLocalGateway({ profile: 'alice' })
  mod.invalidateGatewayWarmup({ profile: 'alice' })
  const current = mod.warmUpLocalGateway({ profile: 'alice' })
  assert.notEqual(previous, current)
  pending[0].reject(new Error('old session canceled'))
  await assert.rejects(previous, /old session canceled/)
  assert.equal(mod.failures.filter(entry => entry.error).length, 0)
  assert.equal(mod.isGatewayWarmupInFlight({ profile: 'alice' }), true)
  pending[1].resolve({ status: 'connected' })
  await current
  assert.equal(mod.published.length, 1)
})
