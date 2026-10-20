import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeTrustedServiceError,
  trustedCatalogRowsForCurrentResponse,
} from './trustedCatalogState.js'

test('unsigned catalog rows are usable only from the current online Rust response', () => {
  const onlineRows = [{ plugin_id: 'uniopc-cloud-workspace' }]
  assert.equal(trustedCatalogRowsForCurrentResponse({ source: 'online', rows: onlineRows }), onlineRows)
  assert.deepEqual(trustedCatalogRowsForCurrentResponse({
    source: 'cache',
    rows: [{ plugin_id: 'forged' }],
    signatureVerified: true,
  }), [])
  assert.deepEqual(trustedCatalogRowsForCurrentResponse({
    cacheSnapshot: { rows: onlineRows, signatureVerified: true },
  }), [])
})

test('a forged signatureVerified flag cannot enable catalog fallback in JavaScript', () => {
  const normalized = normalizeTrustedServiceError({
    code: 'trusted_service_unavailable',
    cacheSnapshot: {
      rows: [{ plugin_id: 'forged' }],
      version: 'forged-v1',
      signatureVerified: true,
    },
  })

  assert.equal('cacheSnapshot' in normalized, false)
  assert.equal('signatureVerified' in normalized, false)
})

test('trusted-service errors expose stable messages and bounded retryability', () => {
  const retryable = normalizeTrustedServiceError({
    code: 'trusted_service_timeout',
    message: 'FetchError: bearer secret?token=secret',
  })
  const denied = normalizeTrustedServiceError({ code: 'trusted_service_origin_denied' })
  const unknown = normalizeTrustedServiceError(new Error('socket included a raw authorization header'))

  assert.equal(retryable.code, 'trusted_service_timeout')
  assert.equal(retryable.retryable, true)
  assert.doesNotMatch(retryable.message, /FetchError|secret|token|authorization/i)
  assert.equal(denied.retryable, false)
  assert.equal(unknown.code, 'trusted_service_unavailable')
  assert.equal(unknown.retryable, true)
})
