import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStartupFailureReport } from './startupDiagnostics.js'

const startupEvent = (phase, outcome, recordedAt, detail = null) => ({
  phase,
  outcome,
  recordedAt,
  elapsedMs: 1200,
  detail,
})

test('startup diagnostic summary classifies a refused Gateway connection without copying its detail', () => {
  const report = buildStartupFailureReport({
    startupMetrics: [],
    startupEvents: {
      content: [
        startupEvent('startup_requested', 'started', '2026-10-16T01:00:00Z'),
        startupEvent('startup_finished', 'failed', '2026-10-16T01:00:02Z', 'connection refused 10061 at C:/private/user'),
      ].map(event => JSON.stringify(event)).join('\n'),
    },
    appVersion: '1.2.3',
    platform: 'Win32',
    submissionMode: 'anonymous',
  })

  assert.equal(report.failureCategory, 'connection_refused')
  assert.equal(report.failureStage, 'gateway_startup')
  assert.equal(report.operatingSystem, 'windows')
  assert.equal(report.submissionMode, 'anonymous')
  assert.equal(JSON.stringify(report).includes('private/user'), false)
})

test('a previous failed metric is not attached to a newer unfinished startup', () => {
  const report = buildStartupFailureReport({
    startupMetrics: [{ recordedAt: '2026-10-16T00:00:05Z', failure: '10061', totalMs: 5000 }],
    startupEvents: {
      content: JSON.stringify(startupEvent('startup_requested', 'started', '2026-10-16T01:00:00Z')),
    },
  })
  assert.equal(report, null)
})

test('a pre-login authentication error becomes an anonymous category without transmitting its text', () => {
  const sensitiveError = 'OTP request failed for 13800000000: network timeout'
  const report = buildStartupFailureReport({
    startupMetrics: [],
    startupEvents: null,
    appVersion: '1.2.3',
    platform: 'Win32',
    submissionMode: 'anonymous',
    loginFailure: sensitiveError,
  })
  assert.equal(report.failureStage, 'login')
  assert.equal(report.failureCategory, 'login_network_failed')
  assert.equal(report.events.length, 0)
  assert.equal(JSON.stringify(report).includes('13800000000'), false)
  assert.equal(JSON.stringify(report).includes(sensitiveError), false)
})
