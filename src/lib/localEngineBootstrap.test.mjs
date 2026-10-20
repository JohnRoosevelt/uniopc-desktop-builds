import assert from 'node:assert/strict'
import test from 'node:test'
import { loadModule, deferred } from './testHelpers/loadModule.mjs'
import { normalizeEngineResponse } from './engine/contracts.js'

async function component({ user = { uid: 'alice' }, activeProfile = 'profile-alice' } = {}) {
  const effects = []
  const starts = []
  const pending = deferred()
  let refreshes = 0
  const mod = await loadModule(new URL('../components/LocalEngineBootstrap.jsx', import.meta.url), {
    react: { useEffect: effect => effects.push(effect) },
    '../hooks/useAuth': { useAuth: () => ({ user }) },
    '../hooks/useActiveOpenClawProfile': { useActiveOpenClawProfile: () => ({ activeProfile, workspaceProfile: { gatewayPort: 19001 } }) },
    '../lib/gatewayWarmup': { invalidateGatewayWarmup: () => {}, warmUpLocalGateway: scope => { starts.push(scope); return pending.promise } },
    '../lib/runtimeStatus': { refreshOpenClawStatus: async () => { refreshes++ } },
  })
  mod.default()
  const cleanups = effects.map(effect => effect())
  return { starts, pending, cleanup: () => cleanups.forEach(fn => fn?.()), refreshes: () => refreshes }
}

test('login starts a known local Profile without waiting on runtime status or page readiness', async () => {
  const boot = await component()
  assert.deepEqual(boot.starts, [{ profile: 'profile-alice', gatewayPort: 19001 }])
  assert.equal(boot.refreshes(), 0)
  boot.pending.resolve({ status: 'connected' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(boot.refreshes(), 1)
  boot.cleanup()
})

test('logout cancels follow-up work and signing in again can start the same Profile', async () => {
  const first = await component()
  first.cleanup()
  first.pending.resolve({ status: 'connected' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(first.refreshes(), 0)
  const second = await component()
  assert.equal(second.starts.length, 1)
  second.cleanup()
})

test('no local start without both a signed-in account and known Profile', async () => {
  assert.equal((await component({ user: null })).starts.length, 0)
  assert.equal((await component({ activeProfile: '' })).starts.length, 0)
})

test('rapid same-Profile re-login starts a fresh attempt and ignores the old completion', async () => {
  const runtime = await loadModule(new URL('./runtimeStatus.js', import.meta.url), {
    '@tauri-apps/api/core': { invoke: async () => null },
    './engine/client.js': { engineClient: { status: {} } },
    './engine/contracts.js': { normalizeEngineResponse },
    react: { useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() },
  })
  const pending = [deferred(), deferred()]
  let calls = 0
  const warmup = await loadModule(new URL('./gatewayWarmup.js', import.meta.url), {
    '@tauri-apps/api/core': { invoke: () => pending[calls++].promise },
    './runtimeStatus': runtime,
  })
  const mount = async () => {
    let effect
    const mod = await loadModule(new URL('../components/LocalEngineBootstrap.jsx', import.meta.url), {
      react: { useEffect: callback => { effect = callback } },
      '../hooks/useAuth': { useAuth: () => ({ user: { uid: 'alice' } }) },
      '../hooks/useActiveOpenClawProfile': { useActiveOpenClawProfile: () => ({ activeProfile: 'profile-alice', workspaceProfile: null }) },
      '../lib/gatewayWarmup': warmup,
      '../lib/runtimeStatus': { refreshOpenClawStatus: async () => null },
    })
    mod.default()
    return effect()
  }
  runtime.setGatewayConnectionRuntimeSnapshot({ profile: 'profile-alice' }, { status: 'connected' })
  const logout = await mount()
  assert.equal(calls, 1)
  logout()
  assert.equal(runtime.getGatewayConnectionSnapshot('profile-alice'), null)
  const nextLogout = await mount()
  assert.equal(calls, 2)
  pending[0].resolve({ status: 'connected', message: 'obsolete session' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.getGatewayConnectionSnapshot('profile-alice'), null)
  assert.equal(warmup.isGatewayWarmupInFlight({ profile: 'profile-alice' }), true)
  pending[1].resolve({ status: 'connected', message: 'current session' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.getGatewayConnectionSnapshot('profile-alice').message, 'current session')
  nextLogout()
})
