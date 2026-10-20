import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LOCAL_ASSISTANT_LAUNCH_PATH,
  localAssistantLaunchNeedsSetup,
  localAssistantReturnPath,
  shouldOpenLocalAssistantLaunch,
  localAssistantLaunchSteps,
  canAutoStartFromSetup,
} from './localAssistantLaunch.js'

test('local assistant launch preserves an internal destination only', () => {
  assert.equal(localAssistantReturnPath('/profiles/me/conversations?focus=1'), '/profiles/me/conversations?focus=1')
  assert.equal(localAssistantReturnPath('//untrusted.example'), '/conversations')
  assert.equal(localAssistantReturnPath('/setup/openclaw'), '/conversations')
  assert.equal(localAssistantReturnPath(LOCAL_ASSISTANT_LAUNCH_PATH), '/conversations')
})

test('failed startup has a terminal step instead of an active spinner', () => {
  const failed = localAssistantLaunchSteps({ status: { installed: true }, gatewayReady: false, startupError: 'Access denied' })
  assert.deepEqual(failed.map(step => step.state), ['done', 'failed', 'pending'])
  assert.equal(failed.some(step => step.state === 'active'), false)
  assert.deepEqual(localAssistantLaunchSteps({ status: { installed: true }, gatewayReady: true }).map(step => step.state), ['done', 'done', 'active'])
})

test('viewing diagnostics or remounting after failure cannot authorize a retry', () => {
  assert.equal(canAutoStartFromSetup({ diagnosticsOnly: true }), false)
  assert.equal(canAutoStartFromSetup({ startupError: 'directory denied' }), false)
  assert.equal(canAutoStartFromSetup({}), true)
})

test('local assistant launch applies only to a not-ready normal app route', () => {
  assert.equal(shouldOpenLocalAssistantLaunch({ requiresLocalOpenClaw: true, ready: false, pathname: '/conversations' }), true)
  assert.equal(shouldOpenLocalAssistantLaunch({ requiresLocalOpenClaw: true, ready: true, pathname: '/conversations' }), false)
  assert.equal(shouldOpenLocalAssistantLaunch({ requiresLocalOpenClaw: true, ready: false, pathname: '/setup/openclaw' }), false)
  assert.equal(shouldOpenLocalAssistantLaunch({ requiresLocalOpenClaw: false, ready: false, pathname: '/conversations' }), false)
})

test('only actionable runtime states move from launch into setup', () => {
  assert.equal(localAssistantLaunchNeedsSetup({ status: { installed: false } }), true)
  assert.equal(localAssistantLaunchNeedsSetup({ status: { installed: true, supported: false } }), true)
  assert.equal(localAssistantLaunchNeedsSetup({ status: { installed: true, supported: true }, connectionSnapshot: { status: 'disconnected', mode: 'local' } }), false)
  assert.equal(localAssistantLaunchNeedsSetup({ connectionSnapshot: { status: 'disconnected', mode: 'remote', lastErrorCode: 'auth_token_mismatch' } }), true)
})
