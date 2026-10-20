import assert from 'node:assert/strict'
import test from 'node:test'

import {
  callUniopcAuthAction,
  uniopcAuthHeaders,
  uniopcAuthUrl,
} from './uniopcAuth.js'

const config = {
  serverBaseUrl: 'https://server-base.example.test',
  serverBaseAnonKey: 'server-base-gateway-anon',
}

test('Auth actions send the Server Base user token through u_token', () => {
  assert.equal(uniopcAuthUrl(config), 'https://server-base.example.test/functions/v1/auth')
  assert.deepEqual(uniopcAuthHeaders('server-base-user-token', config), {
    apikey: 'server-base-gateway-anon',
    Authorization: 'Bearer server-base-gateway-anon',
    'Content-Type': 'application/json',
    u_token: 'server-base-user-token',
  })
})

test('Auth actions return the trusted operator context from Server Base', async () => {
  const client = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: 'server-base-user-token' } } }
      },
    },
  }
  const request = async (url, init) => {
    assert.equal(url, 'https://server-base.example.test/functions/v1/auth')
    assert.equal(init.headers.u_token, 'server-base-user-token')
    assert.deepEqual(JSON.parse(init.body), { action: 'operator_get_access', payload: {} })
    return new Response(JSON.stringify({ user: { id: 'user-1' }, organization: { id: 'org-1' } }), { status: 200 })
  }

  const result = await callUniopcAuthAction('operator_get_access', {}, { client, config, request })

  assert.deepEqual(result, { user: { id: 'user-1' }, organization: { id: 'org-1' } })
})
