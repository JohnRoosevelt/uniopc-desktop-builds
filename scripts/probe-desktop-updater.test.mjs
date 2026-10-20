import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { probeDesktopUpdater } from './probe-desktop-updater.mjs'

function contractSha256(status, offeredVersion) {
  return createHash('sha256')
    .update(JSON.stringify({ offeredVersion, status }))
    .digest('hex')
}

test('returns only the updater compatibility contract and drops delivery secrets', async () => {
  const requests = []
  const result = await probeDesktopUpdater({
    endpoint: 'https://server.example/functions/v1/desktop-updater',
    currentVersion: '0.3.0',
    fetch: async (url, init) => {
      requests.push({ url, init })
      return Response.json({
        version: '0.4.0',
        url: 'https://signed.example/private-artifact',
        signature: 'delivery-signature',
      })
    },
  })

  assert.match(requests[0].url, /current_version=0.3.0/)
  assert.equal(requests[0].init.method, 'GET')
  assert.deepEqual(result, {
    status: 200,
    offeredVersion: '0.4.0',
    contractSha256: contractSha256(200, '0.4.0'),
  })
  assert.doesNotMatch(JSON.stringify(result), /signed\.example|delivery-signature/)
})

test('uses the empty offer contract for a 204 updater response', async () => {
  const result = await probeDesktopUpdater({
    endpoint: 'https://server.example/functions/v1/desktop-updater',
    currentVersion: '0.4.0',
    fetch: async () => new Response(null, { status: 204 }),
  })

  assert.deepEqual(result, {
    status: 204,
    offeredVersion: '',
    contractSha256: contractSha256(204, ''),
  })
})

test('refuses non-HTTPS endpoints before making a request', async () => {
  let requested = false
  await assert.rejects(() => probeDesktopUpdater({
    endpoint: 'http://server.example/functions/v1/desktop-updater',
    currentVersion: '0.3.0',
    fetch: async () => { requested = true; return Response.json({}) },
  }), /updater_endpoint_https_required/)
  assert.equal(requested, false)
})
