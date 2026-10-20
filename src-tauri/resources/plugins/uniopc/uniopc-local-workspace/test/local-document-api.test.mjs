import test from 'node:test'
import assert from 'node:assert/strict'

import { callLocalDocument } from '../src/local-document-api.js'

const env = {
  UNIOPC_LOCAL_DOCUMENTS_URL: 'http://127.0.0.1:43191/documents',
  UNIOPC_LOCAL_DOCUMENTS_TOKEN: 'test-loopback-secret',
  UNIOPC_OPENCLAW_PROFILE: 'profile-from-env',
}

const runtimeContext = {
  agentId: 'agent-7',
  sessionKey: 'session-9',
}

test('loopback calls preserve the request body and propagate cancellation', async () => {
  const requests = []
  const controller = new AbortController()
  const result = await callLocalDocument('uniopc_local_document_update', {
    id: 'doc-1',
    title: '更新后的纪要',
    category: 'meeting',
    markdown: '# 更新后的纪要',
    metadata: { source: 'meeting' },
    baseHash: 'current-hash',
  }, {
    env,
    runtimeContext,
    signal: controller.signal,
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({ document: { id: 'doc-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  assert.deepEqual(result, { document: { id: 'doc-1' } })
  assert.equal(requests[0].url, 'http://127.0.0.1:43191/documents')
  assert.equal(requests[0].init.signal, controller.signal)
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-loopback-secret')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    action: 'uniopc_local_document_update',
    payload: {
      id: 'doc-1',
      title: '更新后的纪要',
      category: 'meeting',
      markdown: '# 更新后的纪要',
      metadata: { source: 'meeting' },
      baseHash: 'current-hash',
    },
    agent: {
      openclawProfile: 'profile-from-env',
      openclawAgentId: 'agent-7',
    },
    session: { key: 'session-9' },
  })
  assert.doesNotMatch(requests[0].init.body, /test-loopback-secret/)
  assert.doesNotMatch(JSON.stringify(result), /test-loopback-secret/)
})

test('runtime-facing errors use neutral product language', async () => {
  await assert.rejects(
    callLocalDocument('uniopc_local_documents_list', {}, {
      env: { ...env, UNIOPC_OPENCLAW_PROFILE: '' },
      runtimeContext: { sessionKey: 'session-9' },
      fetchImpl: async () => { throw new Error('fetch must not run') },
    }),
    (error) => {
      assert.doesNotMatch(error.message, /openclaw/i)
      assert.match(error.message, /profile/i)
      return true
    },
  )
})
