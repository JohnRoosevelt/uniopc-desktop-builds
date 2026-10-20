import assert from 'node:assert/strict'
import test from 'node:test'

import { createAuthenticatedAdminApi } from './release-validation-operator-adapter.mjs'

test('opens only an explicitly configured loopback Tauri bridge and exposes a close hook', async () => {
  const calls = []
  let closed = 0
  const adapter = await createAuthenticatedAdminApi({
    environment: {
      UNIOPC_RELEASE_VALIDATION_CONTROL_URL: 'https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/release-validation-control',
      UNIOPC_RELEASE_VALIDATION_CONTROL_TOKEN: 'control-token-value',
      UNIOPC_RELEASE_VALIDATION_TAURI_BRIDGE_HOST: '127.0.0.1',
      UNIOPC_RELEASE_VALIDATION_TAURI_BRIDGE_PORT: '9223',
    },
    fetchFn: async () => Response.json({ ok: true, result: null }),
    connectToBridgeFn: async options => {
      calls.push(options)
      return { invoke: async () => ({}), close: () => { closed += 1 } }
    },
  })
  assert.equal(adapter.authenticated, true)
  assert.equal(typeof adapter.api.findValidationUser, 'function')
  assert.deepEqual(calls, [{
    host: '127.0.0.1', basePort: 9223, scanCount: 1, timeoutMs: 30_000,
    logger: { write: calls[0]?.logger?.write },
  }])
  await adapter.close()
  assert.equal(closed, 1)
})

test('refuses non-loopback or omitted operator bridge configuration before connecting', async () => {
  let connected = false
  for (const environment of [
    {},
    { UNIOPC_RELEASE_VALIDATION_TAURI_BRIDGE_HOST: '192.168.1.3', UNIOPC_RELEASE_VALIDATION_TAURI_BRIDGE_PORT: '9223' },
    { UNIOPC_RELEASE_VALIDATION_TAURI_BRIDGE_HOST: '127.0.0.1', UNIOPC_RELEASE_VALIDATION_TAURI_BRIDGE_PORT: '0' },
  ]) {
    await assert.rejects(() => createAuthenticatedAdminApi({
      environment,
      connectToBridgeFn: async () => { connected = true },
    }), /release_validation_operator_bridge_invalid/)
  }
  assert.equal(connected, false)
})
