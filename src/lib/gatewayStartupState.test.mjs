import test from 'node:test'
import assert from 'node:assert/strict'
import { gatewayStartupState } from './gatewayStartupState.js'

test('gateway startup only reports started after a connected snapshot', () => {
  assert.deepEqual(gatewayStartupState({ status: 'connected' }), {
    ready: true,
    keepPolling: false,
    message: 'Gateway 已启动，马上进入 Uniopc。',
  })

  for (const status of ['starting', 'connecting', 'disconnected', 'unavailable']) {
    const state = gatewayStartupState({ status })
    assert.equal(state.ready, false)
    assert.equal(state.keepPolling, true)
    assert.equal(state.message.includes('Gateway 已启动'), false)
  }
})

test('missing startup snapshot is an explicit failure', () => {
  assert.deepEqual(gatewayStartupState(null), {
    ready: false,
    keepPolling: false,
    message: null,
    error: 'Gateway 启动命令未返回状态，请重试。',
  })
})
