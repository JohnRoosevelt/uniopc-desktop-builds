import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createAuthenticatedAdminApi,
  createLiveValidationDependencies,
} from './release-validation-control-adapter.mjs'

const endpoint = 'https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/release-validation-control'
const environment = {
  UNIOPC_RELEASE_VALIDATION_CONTROL_URL: endpoint,
  UNIOPC_RELEASE_VALIDATION_CONTROL_TOKEN: 'control-token-value',
}
const crossRepoFixture = JSON.parse(await readFile(new URL('./release-validation-control-contract-v1.fixture.json', import.meta.url), 'utf8'))

test('cross-repository v1 fixture is emitted and mapped without network', async () => {
  const requests = []
  const api = (await createAuthenticatedAdminApi({
    environment,
    fetchFn: async (_url, options) => {
      requests.push(JSON.parse(options.body))
      return Response.json(crossRepoFixture.ensureUser.response)
    },
    invoke: async () => ({}),
  })).api
  const result = await api.ensureValidationUser({
    email: crossRepoFixture.ensureUser.request.payload.email,
    password: crossRepoFixture.ensureUser.request.payload.password,
    marker: crossRepoFixture.ensureUser.request.marker,
    organizationSlug: crossRepoFixture.ensureUser.request.slug,
  })
  assert.deepEqual(requests, [crossRepoFixture.ensureUser.request])
  assert.deepEqual(result, crossRepoFixture.ensureUser.response.result)
})

test('uses the exact version-1 control envelope before canonical local IPC operations', async () => {
  const requests = []
  const invokes = []
  const responses = new Map([
    ['find-user', null],
    ['find-organization', null],
    ['ensure-user', { id: 'user-1', marker: 'uniopc-openclaw-release-validation-v1', organizationSlug: 'openclaw-release-validation', email: 'openclaw-release-validation@invalid.uniopc' }],
    ['ensure-organization', { id: 'org-1', marker: 'uniopc-openclaw-release-validation-v1', slug: 'openclaw-release-validation', ownerUserId: 'user-1' }],
    ['ensure-profile', { id: 'profile-1', marker: 'uniopc-openclaw-release-validation-v1', organizationId: 'org-1', name: 'release-validation' }],
    ['ensure-employee', { id: 'employee-1', marker: 'uniopc-openclaw-release-validation-v1', organizationId: 'org-1', profileName: 'release-validation' }],
    ['bootstrap-spec', { marker: 'uniopc-openclaw-release-validation-v1', organizationSlug: 'openclaw-release-validation', profileName: 'release-validation', employeeId: 'employee-1', gatewayBootstrap: { schemaVersion: 1, profileKey: 'openclaw-release-validation', organizationId: 'org-1', memberId: 'member-1', employeeId: 'employee-1', actions: ['create_agent', 'create_main_session', 'create_cron_session', 'bind_model'] } }],
  ])
  const api = (await createAuthenticatedAdminApi({
    environment,
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body)
      requests.push({ url, headers: options.headers, body })
      return Response.json({ ok: true, result: responses.get(body.action) })
    },
    invoke: async (command, args) => {
      invokes.push({ command, args })
      if (command === 'openclaw_agents_create') return { id: 'release-validation-agent' }
      if (command === 'conversation_list_sessions') return { sessions: [] }
      if (command === 'conversation_create_session') return { sessionKey: invokes.filter(item => item.command === command).length === 1 ? 'main-key' : 'cron-key' }
      if (command === 'conversation_rename_session') return { sessionKey: args.req.sessionKey, label: args.req.label }
      if (command === 'conversation_set_session_model') return { sessionKey: args.req.sessionKey, model: args.req.model }
      throw new Error(`unexpected command ${command}`)
    },
  })).api

  assert.equal(await api.findValidationUser('openclaw-release-validation@invalid.uniopc'), null)
  assert.equal(await api.findValidationOrganization('openclaw-release-validation'), null)
  const user = await api.ensureValidationUser({ email: 'openclaw-release-validation@invalid.uniopc', password: 'generated-password', marker: 'uniopc-openclaw-release-validation-v1', organizationSlug: 'openclaw-release-validation' })
  const organization = await api.ensureMarkedOrganization({ slug: 'openclaw-release-validation', marker: 'uniopc-openclaw-release-validation-v1', ownerUserId: user.id })
  const profile = await api.ensureOpenClawProfile({ organizationId: organization.id, name: 'release-validation' })
  const agent = await api.ensureAgent({ profile: profile.name, name: 'release-validation-agent' })
  const main = await api.ensureSession({ profile: profile.name, agentId: agent.id, kind: 'main' })
  const cron = await api.ensureSession({ profile: profile.name, agentId: agent.id, kind: 'cron' })
  await api.ensureModelBinding({ profile: profile.name, sessionKey: main.key, model: 'openai/gpt-5.6' })

  assert.deepEqual(requests.map(({ body }) => body.action), [
    'find-user', 'find-organization', 'ensure-user', 'ensure-organization',
    'ensure-profile', 'ensure-employee', 'bootstrap-spec',
  ])
  assert.equal(requests.every(({ url }) => url === endpoint), true)
  assert.equal(requests.every(({ headers }) => headers['x-release-validation-control-token'] === 'control-token-value'), true)
  assert.equal(requests.every(({ body }) => body.marker === 'uniopc-openclaw-release-validation-v1'), true)
  assert.deepEqual(requests.map(({ body }) => body), [
    { schemaVersion: 1, action: 'find-user', marker: 'uniopc-openclaw-release-validation-v1', slug: 'openclaw-release-validation' },
    { schemaVersion: 1, action: 'find-organization', marker: 'uniopc-openclaw-release-validation-v1', slug: 'openclaw-release-validation' },
    { schemaVersion: 1, action: 'ensure-user', marker: 'uniopc-openclaw-release-validation-v1', slug: 'openclaw-release-validation', payload: { email: 'openclaw-release-validation@invalid.uniopc', password: 'generated-password' } },
    { schemaVersion: 1, action: 'ensure-organization', marker: 'uniopc-openclaw-release-validation-v1', slug: 'openclaw-release-validation' },
    { schemaVersion: 1, action: 'ensure-profile', marker: 'uniopc-openclaw-release-validation-v1', slug: 'openclaw-release-validation' },
    { schemaVersion: 1, action: 'ensure-employee', marker: 'uniopc-openclaw-release-validation-v1', slug: 'openclaw-release-validation' },
    { schemaVersion: 1, action: 'bootstrap-spec', marker: 'uniopc-openclaw-release-validation-v1', slug: 'openclaw-release-validation' },
  ])
  assert.deepEqual(invokes, [
    { command: 'openclaw_agents_create', args: { req: { profile: 'release-validation', name: 'release-validation-agent', role: 'Release validation', description: 'Isolated OpenClaw release validation agent', emoji: '🧪' } } },
    { command: 'conversation_list_sessions', args: { req: { profile: 'release-validation', agentId: 'release-validation-agent', offset: 0, limit: 200 } } },
    { command: 'conversation_create_session', args: { req: { profile: 'release-validation', agentId: 'release-validation-agent' } } },
    { command: 'conversation_rename_session', args: { req: { profile: 'release-validation', sessionKey: 'main-key', label: 'release-validation-main' } } },
    { command: 'conversation_list_sessions', args: { req: { profile: 'release-validation', agentId: 'release-validation-agent', offset: 0, limit: 200 } } },
    { command: 'conversation_create_session', args: { req: { profile: 'release-validation', agentId: 'release-validation-agent' } } },
    { command: 'conversation_rename_session', args: { req: { profile: 'release-validation', sessionKey: 'cron-key', label: 'release-validation-cron' } } },
    { command: 'conversation_set_session_model', args: { req: { profile: 'release-validation', sessionKey: 'main-key', model: 'openai/gpt-5.6' } } },
  ])
  assert.deepEqual({ user, organization, profile, agent, main, cron }, {
    user: { id: 'user-1', marker: 'uniopc-openclaw-release-validation-v1', organizationSlug: 'openclaw-release-validation', email: 'openclaw-release-validation@invalid.uniopc' },
    organization: { id: 'org-1', marker: 'uniopc-openclaw-release-validation-v1', slug: 'openclaw-release-validation', ownerUserId: 'user-1' },
    profile: { id: 'profile-1', marker: 'uniopc-openclaw-release-validation-v1', organizationId: 'org-1', name: 'release-validation' },
    agent: { id: 'release-validation-agent' }, main: { key: 'main-key' }, cron: { key: 'cron-key' },
  })
})

test('fails closed for malformed control responses and unsafe cleanup roots', async () => {
  await assert.rejects(() => createAuthenticatedAdminApi({
    environment: { ...environment, UNIOPC_RELEASE_VALIDATION_CONTROL_URL: 'https://spb-bp10i1915oj07495.supabase.opentrust.net/functions/v1/release-validation-control' },
    fetchFn: async () => Response.json({ ok: true, result: null }),
    invoke: async () => ({}),
  }), /release_validation_control_configuration_invalid/)
  await assert.rejects(() => createAuthenticatedAdminApi({
    environment: { ...environment, UNIOPC_RELEASE_VALIDATION_CONTROL_URL: 'https://token@spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/release-validation-control' },
    fetchFn: async () => Response.json({ ok: true, result: null }),
    invoke: async () => ({}),
  }), /release_validation_control_configuration_invalid/)

  const api = (await createAuthenticatedAdminApi({
    environment,
    fetchFn: async () => Response.json({ ok: true, result: { id: 'unmarked' } }),
    invoke: async () => ({}),
  })).api
  await assert.rejects(() => api.ensureValidationUser({ email: 'openclaw-release-validation@invalid.uniopc', password: 'password', marker: 'uniopc-openclaw-release-validation-v1', organizationSlug: 'openclaw-release-validation' }), /release_validation_control_response_invalid/)

  assert.throws(() => createLiveValidationDependencies({
    validationRoot: 'E:\\',
    runtime: {},
  }), /release_validation_root_invalid/)
})

test('refuses every live controller operation when a phase escapes the validation root', async () => {
  let invoked = 0
  const guarded = createLiveValidationDependencies({
    validationRoot: 'E:\\release-validation',
    runtime: {
      processController: {
        snapshot: async () => { invoked += 1; return {} },
        cleanup: async () => { invoked += 1; return true },
      },
      networkController: {
        snapshot: async () => { invoked += 1; return {} },
        apply: async () => { invoked += 1; return true },
        restore: async () => { invoked += 1; return true },
      },
      documentController: { archivePhaseDocuments: async () => { invoked += 1; return true } },
      runCase: async () => { invoked += 1; return { ok: true, artifacts: [] } },
      runCommand: async () => { invoked += 1; return { ok: true, artifacts: [] } },
    },
  })
  const result = await guarded.runBoundedPhase('updater-pre', { validationRoot: 'E:\\customer-data' })
  assert.equal(invoked, 0)
  assert.equal(result.cleanupVerified, false)
})
