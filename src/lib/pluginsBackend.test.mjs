import assert from 'node:assert/strict'
import test from 'node:test'

import {
  callPluginsFunction,
  pluginsFunctionUrl,
  pluginsRequestHeaders,
} from './pluginsBackend.js'

const config = {
  pluginsUrl: 'https://plugins.example.test',
  pluginsAnonKey: 'plugins-gateway-anon',
}

test('Plugins requests keep the gateway credential separate from the Server Base user token', () => {
  assert.equal(
    pluginsFunctionUrl('private-conversion', config),
    'https://plugins.example.test/functions/v1/private-conversion',
  )
  assert.deepEqual(pluginsRequestHeaders('server-base-user-token', config), {
    apikey: 'plugins-gateway-anon',
    Authorization: 'Bearer plugins-gateway-anon',
    'Content-Type': 'application/json',
    u_token: 'server-base-user-token',
  })
})

test('Plugins requests refresh the Server Base session once after an unauthorized response', async () => {
  const requests = []
  let refreshes = 0
  const client = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: 'expired-server-base-token' } } }
      },
      async refreshSession() {
        refreshes += 1
        return { data: { session: { access_token: 'fresh-server-base-token' } }, error: null }
      },
    },
  }
  const request = async (url, init) => {
    requests.push({ url, headers: init.headers })
    if (requests.length === 1) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    return new Response(JSON.stringify({ channels: [] }), { status: 200 })
  }

  const result = await callPluginsFunction(
    'private-conversion',
    { action: 'operator_list_org_channels', payload: { channelType: 'video' } },
    { client, config, request },
  )

  assert.deepEqual(result, { channels: [] })
  assert.equal(refreshes, 1)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].headers.Authorization, 'Bearer plugins-gateway-anon')
  assert.equal(requests[0].headers.u_token, 'expired-server-base-token')
  assert.equal(requests[1].headers.u_token, 'fresh-server-base-token')
})
