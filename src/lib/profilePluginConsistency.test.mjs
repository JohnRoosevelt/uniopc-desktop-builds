import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPluginDoctorRequest,
  buildPluginReconcileRequest,
  checkProfilePluginConsistency,
  reconcileProfilePluginConsistency,
  shouldRunPluginReconcile,
  subscribeWorkspacePolicyVersion,
} from './profilePluginConsistency.js'

test('plugin doctor checks run through the engine client boundary', async () => {
  const calls = []
  const report = await checkProfilePluginConsistency({
    bootstrap: {
      openclawProfile: 'member-a',
      policyVersion: 4,
      plugins: [{ pluginId: 'uniopc-socials', status: 'active' }],
    },
    client: {
      plugins: {
        doctorCheck(args) {
          calls.push(args)
          return { status: 'ok' }
        },
      },
    },
  })

  assert.deepEqual(report, { status: 'ok' })
  assert.deepEqual(calls, [{
    req: {
      profile: 'member-a',
      policyVersion: 4,
      plugins: [{ pluginId: 'uniopc-socials', status: 'active', isGlobal: false }],
    },
  }])
})

test('buildPluginDoctorRequest maps bootstrap plugins to tauri request shape', () => {
  const request = buildPluginDoctorRequest({
    openclawProfile: 'member-a',
    policyVersion: 9,
    plugins: [
      { pluginId: 'uniopc-socials', status: 'active', isGlobal: false },
      { plugin_id: 'uniopc-private-conversion', entitlement_status: 'suspended', is_global: false },
    ],
  })

  assert.deepEqual(request, {
    profile: 'member-a',
    policyVersion: 9,
    plugins: [
      { pluginId: 'uniopc-socials', status: 'active', isGlobal: false },
      { pluginId: 'uniopc-private-conversion', status: 'suspended', isGlobal: false },
    ],
  })
})

test('shouldRunPluginReconcile compares policy version and report status', () => {
  assert.equal(shouldRunPluginReconcile({ policyVersion: 3 }, 2, { status: 'ok' }), true)
  assert.equal(shouldRunPluginReconcile({ policyVersion: 3 }, 3, { status: 'needs_repair' }), true)
  assert.equal(shouldRunPluginReconcile({ policyVersion: 3 }, 3, { status: 'ok' }), false)
})

test('buildPluginReconcileRequest includes cloud agent auth rows', () => {
  const request = buildPluginReconcileRequest({
    openclawProfile: 'member-a',
    policyVersion: 9,
    plugins: [{ pluginId: 'uniopc-cloud-workspace', status: 'active', isGlobal: true }],
  }, {
    'uniopc-cloud-workspace': {
      cloudAgentApiUrl: 'https://example.test/functions/v1/uniopc-cloud-workspace',
      cloudAgentHostCredential: 'imai_hc_workspace',
    },
  })

  assert.deepEqual(request.cloudAgentAuth, [{
    pluginId: 'uniopc-cloud-workspace',
    cloudAgentApiUrl: 'https://example.test/functions/v1/uniopc-cloud-workspace',
    cloudAgentHostCredential: 'imai_hc_workspace',
  }])
})

test('reconcileProfilePluginConsistency requests cloud agent auth for every active official cloud plugin', async () => {
  const authCalls = []
  const invokeCalls = []
  await reconcileProfilePluginConsistency({
    bootstrap: {
      openclawProfile: 'member-a',
      plugins: [
        { pluginId: 'uniopc-cloud-workspace', status: 'active' },
        { pluginId: 'uniopc-socials', status: 'active' },
        { pluginId: 'uniopc-private-conversion', status: 'active' },
        { pluginId: 'custom-plugin', status: 'active' },
      ],
    },
    authEnvForProfile: async input => {
      authCalls.push(input)
      return {
        cloudAgentApiUrl: `https://example.test/functions/v1/${input.pluginIds[0]}`,
        cloudAgentHostCredential: `imai_hc_${input.pluginIds[0]}`,
      }
    },
    client: {
      plugins: {
        reconcile: async payload => {
          invokeCalls.push({ name: 'openclaw_profile_plugin_reconcile', payload })
          return { status: 'ok' }
        },
      },
    },
  })

  assert.deepEqual(authCalls, [
    { profile: 'member-a', pluginIds: ['uniopc-cloud-workspace'] },
    { profile: 'member-a', pluginIds: ['uniopc-socials'] },
    { profile: 'member-a', pluginIds: ['uniopc-private-conversion'] },
  ])
  assert.deepEqual(
    invokeCalls[0].payload.req.cloudAgentAuth.map(item => [
      item.pluginId,
      item.cloudAgentApiUrl,
      item.cloudAgentHostCredential,
    ]),
    [
      [
        'uniopc-cloud-workspace',
        'https://example.test/functions/v1/uniopc-cloud-workspace',
        'imai_hc_uniopc-cloud-workspace',
      ],
      [
        'uniopc-socials',
        'https://example.test/functions/v1/uniopc-socials',
        'imai_hc_uniopc-socials',
      ],
      [
        'uniopc-private-conversion',
        'https://example.test/functions/v1/uniopc-private-conversion',
        'imai_hc_uniopc-private-conversion',
      ],
    ],
  )
  assert.deepEqual(
    invokeCalls[0].payload.req.cloudAgentAuth.map(item => item.pluginId),
    ['uniopc-cloud-workspace', 'uniopc-socials', 'uniopc-private-conversion'],
  )
})

test('reconcileProfilePluginConsistency covers catalog-declared cloud agent plugins via injected predicate', async () => {
  const authCalls = []
  const invokeCalls = []
  await reconcileProfilePluginConsistency({
    bootstrap: {
      openclawProfile: 'member-a',
      plugins: [
        { pluginId: 'uniopc-cloud-workspace', status: 'active' },
        // 不在静态内置表里的新云插件——由 catalog metadata.function_path 声明,
        // 调用方注入的谓词(isCloudAgentPluginId)负责识别它。
        { pluginId: 'uniopc-new-cloud-plugin', status: 'active' },
        { pluginId: 'custom-plugin', status: 'active' },
      ],
    },
    isCloudAgentPlugin: pluginId => pluginId === 'uniopc-new-cloud-plugin',
    authEnvForProfile: async input => {
      authCalls.push(input)
      return {
        cloudAgentApiUrl: `https://example.test/functions/v1/${input.pluginIds[0]}`,
        cloudAgentHostCredential: `imai_hc_${input.pluginIds[0]}`,
      }
    },
    client: {
      plugins: {
        reconcile: async payload => {
          invokeCalls.push({ name: 'openclaw_profile_plugin_reconcile', payload })
          return { status: 'ok' }
        },
      },
    },
  })

  // 静态表(cloud-workspace)与谓词命中(新插件)都签发;custom-plugin 不签发。
  assert.deepEqual(authCalls.map(input => input.pluginIds[0]), [
    'uniopc-cloud-workspace',
    'uniopc-new-cloud-plugin',
  ])
  assert.deepEqual(
    invokeCalls[0].payload.req.cloudAgentAuth.map(item => item.pluginId),
    ['uniopc-cloud-workspace', 'uniopc-new-cloud-plugin'],
  )
})

test('subscribeWorkspacePolicyVersion subscribes to organization version changes', () => {
  const calls = []
  const channel = {
    on(...args) {
      calls.push(['on', ...args])
      return channel
    },
    subscribe(callback) {
      calls.push(['subscribe'])
      callback?.('SUBSCRIBED')
      return channel
    },
  }
  const client = {
    channel(name) {
      calls.push(['channel', name])
      return channel
    },
    removeChannel(value) {
      calls.push(['removeChannel', value === channel])
    },
  }
  const unsubscribe = subscribeWorkspacePolicyVersion(client, 'org-1', () => {})

  assert.equal(calls[0][0], 'channel')
  assert.match(calls[0][1], /^workspace-policy:org-1:/)
  assert.equal(calls[1][1], 'postgres_changes')
  assert.deepEqual(calls[1][2], {
    event: 'UPDATE',
    schema: 'public',
    table: 'cloud_workspace_policy_versions',
    filter: 'organization_id=eq.org-1',
  })
  unsubscribe()
  assert.deepEqual(calls.at(-1), ['removeChannel', true])
})
