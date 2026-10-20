import assert from 'node:assert/strict'
import test from 'node:test'
import { loadModule, deferred } from './testHelpers/loadModule.mjs'
import { normalizeEngineResponse } from './engine/contracts.js'

async function harness(t) {
  const runtime = await loadModule(new URL('./runtimeStatus.js', import.meta.url), {
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    '@tauri-apps/api/core': { invoke: async () => { throw new Error('unexpected status RPC') } },
    './engine/client.js': { engineClient: { status: {} } },
    './engine/contracts.js': { normalizeEngineResponse },
  })
  const attempts = []
  const warmup = await loadModule(new URL('./gatewayWarmup.js', import.meta.url), {
    './runtimeStatus': runtime,
    '@tauri-apps/api/core': { invoke: () => { const pending = deferred(); attempts.push(pending); return pending.promise } },
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const preparing = profile => runtime.useRuntimeStatusStore().gatewayConnection.startupPreparing?.[profile] === true
  return { runtime, warmup, attempts, preparing }
}

test('pending startup appears after one second; a verified connection clears it immediately', async t => {
  const h = await harness(t)
  const task = h.warmup.warmUpLocalGateway({ profile: 'alice' })
  t.mock.timers.tick(999)
  assert.equal(h.preparing('alice'), false)
  t.mock.timers.tick(1)
  assert.equal(h.preparing('alice'), true)
  assert.equal(h.preparing('bob'), false)
  h.attempts[0].resolve({ status: 'connected' })
  await task
  assert.equal(h.preparing('alice'), false)
})

test('fast reuse never displays preparing and an independent connected event also hides it', async t => {
  const h = await harness(t)
  const task = h.warmup.warmUpLocalGateway({ profile: 'alice' })
  h.attempts[0].resolve({ status: 'connected' })
  await task
  t.mock.timers.tick(1500)
  assert.equal(h.preparing('alice'), false)
  const second = h.warmup.warmUpLocalGateway({ profile: 'bob' })
  t.mock.timers.tick(1000)
  assert.equal(h.preparing('bob'), true)
  h.runtime.setGatewayConnectionRuntimeSnapshot({ profile: 'bob' }, { status: 'connected' })
  assert.equal(h.preparing('bob'), false)
  h.attempts[1].resolve({ status: 'connected' })
  await second
})

test('failure replaces preparing with diagnosis and retry starts a fresh grace window', async t => {
  const h = await harness(t)
  const task = h.warmup.warmUpLocalGateway({ profile: 'alice' })
  t.mock.timers.tick(1000)
  assert.equal(h.preparing('alice'), true)
  h.attempts[0].reject(new Error('local startup failed'))
  await assert.rejects(task, /local startup failed/)
  assert.equal(h.preparing('alice'), false)
  assert.equal(h.runtime.useRuntimeStatusStore().gatewayConnection.startupErrors.alice, 'local startup failed')
  const retry = h.warmup.warmUpLocalGateway({ profile: 'alice' })
  assert.equal(h.runtime.useRuntimeStatusStore().gatewayConnection.startupErrors.alice, null)
  assert.equal(h.preparing('alice'), false)
  h.attempts[1].resolve({ status: 'connected' })
  await retry
})

test('logout removes preparing and stale timers or failures cannot change the next same-profile attempt', async t => {
  const h = await harness(t)
  const old = h.warmup.warmUpLocalGateway({ profile: 'alice' })
  t.mock.timers.tick(900)
  h.warmup.invalidateGatewayWarmup({ profile: 'alice' })
  const current = h.warmup.warmUpLocalGateway({ profile: 'alice' })
  t.mock.timers.tick(100)
  assert.equal(h.preparing('alice'), false)
  h.attempts[0].reject(new Error('obsolete failure'))
  await assert.rejects(old)
  t.mock.timers.tick(900)
  assert.equal(h.preparing('alice'), true)
  assert.equal(h.runtime.useRuntimeStatusStore().gatewayConnection.startupErrors.alice, null)
  h.warmup.invalidateGatewayWarmup({ profile: 'alice' })
  assert.equal(h.preparing('alice'), false)
  h.attempts[1].resolve({ status: 'connected' })
  await current
  assert.equal(h.runtime.getGatewayConnectionSnapshot('alice'), null)
})
