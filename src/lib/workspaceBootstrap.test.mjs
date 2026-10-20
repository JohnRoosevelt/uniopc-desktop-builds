import assert from 'node:assert/strict'
import test from 'node:test'

import { loadWorkspaceProfileWithSetup } from './workspaceBootstrap.js'

test('host bootstrap completes approved organization setup before returning the workspace role', async () => {
  const calls = []
  const profiles = [
    { memberRole: 'setup_required', profileStatus: 'workspace_not_found' },
    { memberRole: 'owner', profileStatus: 'active', openclawProfile: 'owner-profile' },
  ]
  const result = await loadWorkspaceProfileWithSetup({
    appMode: 'admin-host',
    ownerId: 'user-1',
    loadProfile: async (_client, ownerId) => {
      calls.push(['loadProfile', ownerId])
      return profiles.shift()
    },
    ensureOrganization: async (_client, ownerId) => {
      calls.push(['ensureOrganization', ownerId])
      return { memberRole: 'owner', profileStatus: 'active', openclawProfile: 'owner-profile' }
    },
  })

  assert.deepEqual(calls, [
    ['loadProfile', 'user-1'],
    ['ensureOrganization', 'user-1'],
    ['loadProfile', 'user-1'],
  ])
  assert.equal(result.workspaceProfile.memberRole, 'owner')
  assert.equal(result.organizationSetupCompleted, true)
})

test('legacy employee bootstrap mode uses the unified host organization bootstrap', async () => {
  const calls = []
  const profiles = [
    { memberRole: 'setup_required', profileStatus: 'workspace_not_found' },
    { memberRole: 'owner', profileStatus: 'active' },
  ]
  const result = await loadWorkspaceProfileWithSetup({
    appMode: 'employee',
    ownerId: 'user-1',
    loadProfile: async (_client, ownerId) => {
      calls.push(['loadProfile', ownerId])
      return profiles.shift()
    },
    ensureOrganization: async (_client, ownerId) => {
      calls.push(['ensureOrganization', ownerId])
      return { memberRole: 'owner', profileStatus: 'active' }
    },
  })

  assert.deepEqual(calls, [
    ['loadProfile', 'user-1'],
    ['ensureOrganization', 'user-1'],
    ['loadProfile', 'user-1'],
  ])
  assert.equal(result.workspaceProfile.memberRole, 'owner')
  assert.equal(result.organizationSetupCompleted, true)
})

test('self-service users fall through to manual organization setup instead of failing bootstrap', async () => {
  const calls = []
  const result = await loadWorkspaceProfileWithSetup({
    appMode: 'admin-host',
    ownerId: 'user-1',
    loadProfile: async (_client, ownerId) => {
      calls.push(['loadProfile', ownerId])
      return { memberRole: 'setup_required', profileStatus: 'workspace_not_found' }
    },
    ensureOrganization: async (_client, ownerId) => {
      calls.push(['ensureOrganization', ownerId])
      throw new Error('organization_type_required')
    },
  })

  assert.deepEqual(calls, [
    ['loadProfile', 'user-1'],
    ['ensureOrganization', 'user-1'],
  ])
  assert.equal(result.workspaceProfile.memberRole, 'setup_required')
  assert.equal(result.organizationSetupCompleted, false)
})

test('workspace profile bootstrap times out instead of checking forever', async () => {
  await assert.rejects(
    loadWorkspaceProfileWithSetup({
      appMode: 'admin-host',
      ownerId: 'user-1',
      timeoutMs: 5,
      loadProfile: async () => new Promise(() => {}),
    }),
    error => {
      assert.equal(error.code, 'workspace_bootstrap_timeout')
      assert.equal(error.status, 0)
      assert.match(error.message, /检查账号开通状态超时/)
      return true
    },
  )
})
