import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as gatewayErrors from './gatewayErrors.js'

import {
  GATEWAY_AUTH_TOKEN_MISMATCH,
  GATEWAY_AUTH_UNAUTHORIZED,
  GATEWAY_MODEL_CREDENTIALS_UNAVAILABLE,
  isGatewayModelCredentialsUnavailable,
  isGatewayAuthBlockedSnapshot,
} from './gatewayErrors.js'

test('local Gateway auth failures remain recoverable while remote failures stay blocked', () => {
  for (const lastErrorCode of [GATEWAY_AUTH_TOKEN_MISMATCH, GATEWAY_AUTH_UNAUTHORIZED]) {
    assert.equal(isGatewayAuthBlockedSnapshot({ mode: 'local', lastErrorCode }), false)
    assert.equal(isGatewayAuthBlockedSnapshot({ mode: 'remote_direct', lastErrorCode }), true)
    assert.equal(isGatewayAuthBlockedSnapshot({ mode: 'remote_ssh_tunnel', lastErrorCode }), true)
  }
})

test('provider auth or billing failures give a safe, actionable model message', () => {
  const error = {
    code: GATEWAY_MODEL_CREDENTIALS_UNAVAILABLE,
    recoveryAction: 'selectModel',
    messageKey: 'gateway.modelCredentialsUnavailable',
  }
  assert.equal(isGatewayModelCredentialsUnavailable(error), true)
  assert.equal(
    gatewayErrors.gatewayStreamErrorMessage(error),
    '当前模型凭据暂不可用（认证或计费异常）。请切换模型，或稍后再试。',
  )
  assert.equal(isGatewayModelCredentialsUnavailable({ code: 'GATEWAY_ERROR' }), false)
  assert.equal(isGatewayModelCredentialsUnavailable('当前模型凭据暂不可用（认证或计费异常）。请切换模型，或稍后再试。'), true)
})

test('stream Gateway errors map to white-label user copy instead of message keys', () => {
  assert.equal(typeof gatewayErrors.gatewayStreamErrorMessage, 'function')
  assert.equal(
    gatewayErrors.gatewayStreamErrorMessage({
      code: 'UNAVAILABLE',
      recoveryAction: 'retry',
      messageKey: 'gateway.unavailable',
    }),
    '连接暂时不可用，请稍后重试。',
  )
  assert.equal(
    gatewayErrors.gatewayStreamErrorMessage({
      code: 'UNAUTHORIZED',
      recoveryAction: 'reviewPermissions',
      messageKey: 'gateway.forbidden',
    }),
    '连接授权已失效，请重新授权后再试。',
  )
  assert.notEqual(
    gatewayErrors.gatewayStreamErrorMessage({ messageKey: 'gateway.unavailable' }),
    'gateway.unavailable',
  )
})

test('official-model recovery decisions use structured code and recovery action', () => {
  assert.equal(typeof gatewayErrors.shouldRecoverGatewayAuth, 'function')
  assert.equal(gatewayErrors.shouldRecoverGatewayAuth({
    code: 'UNAUTHORIZED',
    recoveryAction: 'reviewPermissions',
  }), true)
  assert.equal(gatewayErrors.shouldRecoverGatewayAuth({
    code: 'AUTH_TOKEN_MISMATCH',
    recoveryAction: 'reviewPermissions',
  }), true)
  assert.equal(gatewayErrors.shouldRecoverGatewayAuth({
    code: 'UNAVAILABLE',
    recoveryAction: 'retry',
  }), false)
  assert.equal(gatewayErrors.shouldRecoverGatewayAuth({
    message: '401 token=raw-secret',
  }), false)
})

test('2026.8.1 chat errors do not infer auth recovery from raw error text', () => {
  const fixture = JSON.parse(readFileSync(
    new URL('../../src-tauri/tests/fixtures/openclaw-2026.8.1/chat-error.json', import.meta.url),
    'utf8',
  ))
  assert.equal(fixture.event, 'chat')
  assert.equal(fixture.payload.state, 'error')
  assert.equal('error' in fixture.payload, false)

  const rustProjection = {
    code: 'GATEWAY_ERROR',
    recoveryAction: 'openRuntime',
    messageKey: 'gateway.unknown',
  }
  assert.equal(gatewayErrors.shouldRecoverGatewayAuth(rustProjection), false)
  assert.equal(
    gatewayErrors.gatewayStreamErrorMessage(rustProjection),
    'AI 服务本轮未能完成，请检查模型状态或引擎日志后重试。',
  )
  assert.equal(
    gatewayErrors.gatewayStreamErrorMessage(rustProjection).includes(fixture.payload.errorMessage),
    false,
  )
})
