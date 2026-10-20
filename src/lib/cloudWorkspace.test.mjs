import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  addCloudProjectPerson,
  addCloudProjectEmployee,
  acceptRegisteredCloudOrganizationInvite,
  assignMemberGateway,
  authorizeCloudPluginInstall,
  buildCachedProfilePluginSnapshot,
  buildMemberOpenClawProfileKey,
  createCloudProject,
  deleteCloudProject,
  ensureCloudOrganization,
  getMyCloudWorkspaceProfile,
  getMemberClientAdminSummary,
  getMyMemberClientBootstrap,
  getMyWorkspacePluginPolicyBootstrap,
  inviteCloudOrganizationMember,
  getMyOpenClawProfileAccess,
  getMyOpenClawProfilePairingSetup,
  listCloudProfilePluginAssignments,
  listMyCloudAiEmployees,
  listCloudOrganizationMembers,
  normalizeCloudPluginCatalogRows,
  listCloudOrganizationTypes,
  listMyOrganizationPluginEntitlements,
  listCloudProjectEmployees,
  listCloudProjectMemberships,
  listCloudProjectPeople,
  listCloudProjects,
  listMyCloudAiEmployeeRequests,
  syncMyCloudAiEmployees,
  removeCloudProjectMember,
  removeCloudProjectEmployee,
  revokeMemberAgentPermission,
  revokeMemberGatewayAssignment,
  createMemberOpenClawProfile,
  grantMemberAgentPermission,
  reportCloudProfilePluginObservation,
  registerMemberDevice,
  mergeCloudPluginCatalogObservations,
  mergeProjectPeopleWithOwner,
  requestCloudAiEmployeeCreation,
  approveCloudAiEmployeeCreationRequest,
  registerOpenClawProfileHost,
  updateMyCloudOrganizationName,
  updateCloudProject,
} from './cloudWorkspace.js'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const supabaseRoot = process.env.UNIOPC_SUPABASE_DIR || path.resolve(repoRoot, '../uniopc-supabase/supabase')

const hasBackendSource = fs.existsSync(path.join(supabaseRoot, 'migrations'))
function testBackendSourceContract(name, fn) {
  test(name, { skip: !hasBackendSource && 'backend source checkout is not configured' }, fn)
}
const v2SupabaseRoot = path.resolve(repoRoot, '../uniopc-supabase/supabase')

test('trusted Rust catalog rows reuse the canonical cloud catalog normalizer', () => {
  const rows = normalizeCloudPluginCatalogRows([{
    plugin_id: 'uniopc-cloud-workspace',
    name: '工作区',
    metadata: { catalog_section: 'official' },
  }])

  assert.equal(rows[0].id, 'uniopc-cloud-workspace')
  assert.equal(rows[0].title, '工作区')
  assert.equal(rows[0].catalogSection, 'official')
})

test('catalog normalizer retains an unpublished row while exposing its release gate', () => {
  const [row] = normalizeCloudPluginCatalogRows([{
    plugin_id: 'uniopc-documents',
    name: '文档处理',
    metadata: { catalog_section: 'official', release_state: 'unpublished' },
  }])

  assert.equal(row.id, 'uniopc-documents')
  assert.equal(row.releaseState, 'unpublished')
  assert.equal(row.latestVersion, undefined)
})

testBackendSourceContract('catalog migration keeps active unpublished rows visible and marks them as non-installable', () => {
  const sql = fs.readFileSync(
    path.join(v2SupabaseRoot, 'migrations/202609250002_catalog_unpublished_plugins_visible.sql'),
    'utf8',
  )

  assert.match(sql, /left join lateral \(/)
  assert.match(sql, /'release_state', case when latest_version\.version is null then 'unpublished' else 'published' end/)
  assert.match(sql, /where c\.status = 'active'/)
  assert.match(sql, /and c\.distribution in \('bundled', 'cloud'\)/)
})

function read(relativePath) {
  if (relativePath.startsWith('supabase/')) {
    return fs.readFileSync(path.join(supabaseRoot, relativePath.slice('supabase/'.length)), 'utf8')
  }
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function createFakeSupabase(responses = {}) {
  const calls = []
  function builder(table) {
    const chain = {
      select(columns = '*') {
        calls.push({ table, op: 'select', columns })
        return chain
      },
      insert(payload) {
        calls.push({ table, op: 'insert', payload })
        return chain
      },
      upsert(payload, options) {
        calls.push({ table, op: 'upsert', payload, options })
        return chain
      },
      update(payload) {
        calls.push({ table, op: 'update', payload })
        return chain
      },
      delete() {
        calls.push({ table, op: 'delete' })
        return chain
      },
      eq(column, value) {
        calls.push({ table, op: 'eq', column, value })
        return chain
      },
      in(column, value) {
        calls.push({ table, op: 'in', column, value })
        return chain
      },
      order(column, options) {
        calls.push({ table, op: 'order', column, options })
        return Promise.resolve(responses[`${table}:list`] || { data: [], error: null })
      },
      single() {
        return Promise.resolve(responses[`${table}:single`] || { data: null, error: null })
      },
    }
    return chain
  }
  return {
    calls,
    client: {
      from(table) {
        return builder(table)
      },
      rpc(name, args) {
        calls.push({ op: 'rpc', name, args })
        return Promise.resolve(responses[`rpc:${name}`] || { data: null, error: null })
      },
    },
  }
}

// Test-only adapter for historical RPC-shaped fixtures. Production catalog
// transport is exclusively the Rust-owned trusted command.
async function normalizeCatalogRpcFixture(client) {
  const { data, error } = await client.rpc('list_my_cloud_plugin_catalog', {})
  assert.equal(error, null)
  return normalizeCloudPluginCatalogRows(data)
}

test('listCloudProjects reads RLS-visible cloud projects ordered by sort and update time', async () => {
  const fake = createFakeSupabase({
    'cloud_projects:list': {
      data: [{ id: 'project-1', name: 'Launch' }],
      error: null,
    },
  })

  const rows = await listCloudProjects(fake.client, 'user-1')

  assert.deepEqual(rows, [{ id: 'project-1', name: 'Launch' }])
  assert.deepEqual(fake.calls, [
    { table: 'cloud_projects', op: 'select', columns: '*' },
    { table: 'cloud_projects', op: 'order', column: 'sort_order', options: { ascending: true } },
  ])
})

test('listCloudProjectMemberships batches project people and AI employee hydration', async () => {
  const fake = createFakeSupabase({
    'cloud_project_members:list': {
      data: [
        {
          id: 'member-ai-1',
          project_id: 'project-1',
          member_type: 'ai_employee',
          cloud_employee_id: 'employee-1',
          openclaw_agent_id: 'agent-1',
          openclaw_profile: 'alice-profile',
          member_role: 'ai_employee',
        },
        {
          id: 'member-user-1',
          project_id: 'project-2',
          member_type: 'user',
          member_user_id: 'user-2',
          member_email: 'user2@example.com',
          member_name: 'User Two',
          member_role: 'member',
        },
      ],
      error: null,
    },
    'rpc:list_my_cloud_ai_employees': {
      data: [
        {
          id: 'employee-1',
          cloud_employee_id: 'employee-1',
          openclaw_agent_id: 'agent-1',
          openclaw_profile: 'alice-profile',
          name: 'Agent One',
          role: 'Researcher',
        },
      ],
      error: null,
    },
  })

  const memberships = await listCloudProjectMemberships(fake.client, 'owner-1', ['project-1', 'project-2'])

  assert.equal(memberships.get('project-1').employees[0].name, 'Agent One')
  assert.equal(memberships.get('project-2').people[0].name, 'User Two')
  assert.deepEqual(fake.calls, [
    { table: 'cloud_project_members', op: 'select', columns: '*' },
    { table: 'cloud_project_members', op: 'in', column: 'project_id', value: ['project-1', 'project-2'] },
    { table: 'cloud_project_members', op: 'order', column: 'created_at', options: { ascending: true } },
    { op: 'rpc', name: 'list_my_cloud_ai_employees', args: {} },
  ])
})

test('createCloudProject trims input and creates through the project RPC', async () => {
  const fake = createFakeSupabase({
    'rpc:create_cloud_project': {
      data: { id: 'project-1', owner_id: 'user-1', name: 'Launch' },
      error: null,
    },
  })

  const row = await createCloudProject(fake.client, 'user-1', {
    name: '  Launch  ',
    description: '  Go live  ',
  })

  assert.equal(row.name, 'Launch')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'create_cloud_project',
      args: {
        p_name: 'Launch',
        p_description: 'Go live',
      },
    },
  ])
})

test('updateCloudProject only updates editable fields on the owner project', async () => {
  const fake = createFakeSupabase({
    'cloud_projects:single': {
      data: { id: 'project-1', name: 'Launch v2' },
      error: null,
    },
  })

  await updateCloudProject(fake.client, 'user-1', 'project-1', {
    name: ' Launch v2 ',
    description: ' Updated ',
  })

  assert.deepEqual(fake.calls, [
    {
      table: 'cloud_projects',
      op: 'update',
      payload: {
        name: 'Launch v2',
        description: 'Updated',
      },
    },
    { table: 'cloud_projects', op: 'eq', column: 'id', value: 'project-1' },
    { table: 'cloud_projects', op: 'eq', column: 'owner_id', value: 'user-1' },
    { table: 'cloud_projects', op: 'select', columns: '*' },
  ])
})

test('deleteCloudProject deletes only the requested owner project', async () => {
  const fake = createFakeSupabase()

  await deleteCloudProject(fake.client, 'user-1', 'project-1')

  assert.deepEqual(fake.calls, [
    { table: 'cloud_projects', op: 'delete' },
    { table: 'cloud_projects', op: 'eq', column: 'id', value: 'project-1' },
    { table: 'cloud_projects', op: 'eq', column: 'owner_id', value: 'user-1' },
  ])
})

test('ensureCloudOrganization creates or returns the owner organization and default profile', async () => {
  const fake = createFakeSupabase({
    'rpc:ensure_cloud_organization': {
      data: [{
        organization_id: 'org-1',
        organization_name: 'Acme',
        member_id: 'member-owner',
        member_role: 'owner',
        openclaw_profile: 'imai',
        profile_status: 'active',
      }],
      error: null,
    },
  })

  const result = await ensureCloudOrganization(fake.client, 'owner-1', {
    name: ' Acme ',
  })

  assert.deepEqual(result, {
    organizationId: 'org-1',
    organizationName: 'Acme',
    organizationTypeId: null,
    organizationTypeKey: '',
    organizationTypeName: '',
    memberId: 'member-owner',
    memberRole: 'owner',
    openclawProfile: 'imai',
    profileStatus: 'active',
    runtimeMode: 'member_local',
    runtime_mode: 'member_local',
    isOwner: true,
    isAdmin: true,
  })
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'ensure_cloud_organization',
      args: {
        p_name: 'Acme',
        p_organization_type_id: null,
      },
    },
  ])
})

test('ensureCloudOrganization sends organization type when creating a workspace', async () => {
  const fake = createFakeSupabase({
    'rpc:ensure_cloud_organization': {
      data: {
        organization_id: 'org-1',
        organization_name: 'Drama Co',
        organization_type_id: 'type-1',
        organization_type_key: 'short_drama',
        organization_type_name: '短剧',
        member_id: 'member-1',
        member_role: 'owner',
        openclaw_profile_id: 'profile-1',
        openclaw_profile: 'member-profile',
        profile_status: 'active',
      },
      error: null,
    },
  })

  const profile = await ensureCloudOrganization(fake.client, 'owner-1', {
    name: 'Drama Co',
    organizationTypeId: 'type-1',
  })

  assert.equal(profile.organizationTypeId, 'type-1')
  assert.equal(profile.organizationTypeKey, 'short_drama')
  assert.equal(profile.organizationTypeName, '短剧')
  assert.deepEqual(fake.calls[0], {
    op: 'rpc',
    name: 'ensure_cloud_organization',
    args: { p_name: 'Drama Co', p_organization_type_id: 'type-1' },
  })
})

test('ensureCloudOrganization can auto-initialize from an approved agent opening request', async () => {
  const fake = createFakeSupabase({
    'rpc:ensure_cloud_organization': {
      data: {
        organization_id: 'org-1',
        organization_name: 'Agent Named Co',
        organization_type_id: 'type-1',
        organization_type_key: 'short_drama',
        organization_type_name: '短剧',
        member_id: 'member-1',
        member_role: 'owner',
        openclaw_profile_id: 'profile-1',
        openclaw_profile: 'owner-profile',
        profile_status: 'active',
      },
      error: null,
    },
  })

  const profile = await ensureCloudOrganization(fake.client, 'owner-1')

  assert.equal(profile.organizationName, 'Agent Named Co')
  assert.equal(profile.organizationTypeKey, 'short_drama')
  assert.deepEqual(fake.calls[0], {
    op: 'rpc',
    name: 'ensure_cloud_organization',
    args: { p_name: null, p_organization_type_id: null },
  })
})

test('updateMyCloudOrganizationName only sends a trimmed organization name to the RPC', async () => {
  const fake = createFakeSupabase({
    'rpc:update_my_cloud_organization_name': {
      data: {
        organization_id: 'org-1',
        organization_name: 'New Name',
        organization_type_id: 'type-1',
        organization_type_key: 'short_drama',
        organization_type_name: '短剧',
        member_id: 'member-1',
        member_role: 'owner',
        openclaw_profile_id: 'profile-1',
        openclaw_profile: 'owner-profile',
        profile_status: 'active',
      },
      error: null,
    },
  })

  const profile = await updateMyCloudOrganizationName(fake.client, 'owner-1', ' New Name ')

  assert.equal(profile.organizationName, 'New Name')
  assert.deepEqual(fake.calls[0], {
    op: 'rpc',
    name: 'update_my_cloud_organization_name',
    args: { p_name: 'New Name' },
  })
})

test('listCloudOrganizationTypes returns active organization type choices', async () => {
  const fake = createFakeSupabase({
    'rpc:list_cloud_organization_types': {
      data: [{ id: 'type-1', type_key: 'ecommerce', name: '电商', sort_order: 20 }],
      error: null,
    },
  })

  const rows = await listCloudOrganizationTypes(fake.client, 'owner-1')

  assert.deepEqual(rows, [{
    id: 'type-1',
    key: 'ecommerce',
    name: '电商',
    description: '',
    status: 'active',
    sortOrder: 20,
  }])
  assert.deepEqual(fake.calls, [{ op: 'rpc', name: 'list_cloud_organization_types', args: {} }])
})

test('listMyOrganizationPluginEntitlements returns organization plugin grants', async () => {
  const fake = createFakeSupabase({
    'rpc:list_my_organization_plugin_entitlements': {
      data: [{
        plugin_id: 'uniopc-socials',
        plugin_name: '公域流量',
        entitlement_status: 'active',
        granted_at: '2026-05-20T00:00:00Z',
      }],
      error: null,
    },
  })

  const rows = await listMyOrganizationPluginEntitlements(fake.client, 'owner-1')

  assert.equal(rows[0].pluginId, 'uniopc-socials')
  assert.equal(rows[0].pluginName, '公域流量')
  assert.equal(rows[0].status, 'active')
  assert.deepEqual(fake.calls, [{ op: 'rpc', name: 'list_my_organization_plugin_entitlements', args: {} }])
})

test('normalizeCloudPluginCatalogRows maps an active trusted catalog response', async () => {
  const fake = createFakeSupabase({
    'rpc:list_my_cloud_plugin_catalog': {
      data: [{
        plugin_id: 'uniopc-cloud-workspace',
        name: '工作区',
        description: '云端项目、任务和文档。',
        provider: 'Uniopc',
        plugin_kind: 'openclaw_plugin',
        status: 'active',
        metadata: {
          catalog_section: 'official',
          required: true,
          is_global: true,
          scene_category: 'workspace',
          tags: ['Plugin', 'Cloud Workspace'],
        },
      }],
      error: null,
    },
  })

  const rows = await normalizeCatalogRpcFixture(fake.client)

  assert.deepEqual(rows, [{
    id: 'uniopc-cloud-workspace',
    title: '工作区',
    provider: 'Uniopc',
    description: '云端项目、任务和文档。',
    pluginKind: 'openclaw_plugin',
    catalogSection: 'official',
    origin: 'official',
    distribution: 'bundled',
    bundled: true,
    required: true,
    removable: false,
    localFirst: false,
    userManagedCredentials: false,
    isGlobal: true,
    tags: ['Plugin', 'Cloud Workspace'],
    sceneCategory: 'workspace',
    pricing: 'free',
    metadata: {
      catalog_section: 'official',
      required: true,
      is_global: true,
      scene_category: 'workspace',
      tags: ['Plugin', 'Cloud Workspace'],
    },
  }])
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'list_my_cloud_plugin_catalog', args: {} },
  ])
})

test('normalizeCloudPluginCatalogRows maps curated Uniopc 引擎 marketplace metadata', async () => {
  const fake = createFakeSupabase({
    'rpc:list_my_cloud_plugin_catalog': {
      data: [{
        plugin_id: '@openclaw/kitchen-sink',
        name: 'Uniopc 引擎 Kitchen Sink',
        description: 'Credential-free kitchen-sink Uniopc 引擎 plugin fixture.',
        provider: 'Uniopc 引擎',
        plugin_kind: 'openclaw_plugin',
        status: 'active',
        is_global: true,
        metadata: {
          catalog_section: 'third-party',
          marketplace_source: 'clawhub',
          marketplace_channel: 'official',
          runtime_plugin_id: 'openclaw-kitchen-sink',
          install_spec: '@openclaw/kitchen-sink',
          install_command: 'openclaw plugins install @openclaw/kitchen-sink',
          is_openclaw_official: true,
          latest_version: '0.2.10',
          verification_tier: 'source-linked',
          tags: ['Uniopc 引擎', 'Official'],
        },
      }],
      error: null,
    },
  })

  const rows = await normalizeCatalogRpcFixture(fake.client)

  assert.equal(rows[0].id, '@openclaw/kitchen-sink')
  assert.equal(rows[0].catalogSection, 'third-party')
  assert.equal(rows[0].marketplaceSource, 'clawhub')
  assert.equal(rows[0].marketplaceChannel, 'official')
  assert.equal(rows[0].runtimePluginId, 'openclaw-kitchen-sink')
  assert.equal(rows[0].installSpec, '@openclaw/kitchen-sink')
  assert.equal(rows[0].installCommand, 'openclaw plugins install @openclaw/kitchen-sink')
  assert.equal(rows[0].isOpenClawOfficial, true)
  assert.equal(rows[0].latestVersion, '0.2.10')
  assert.equal(rows[0].verificationTier, 'source-linked')
})

test('normalizeCloudPluginCatalogRows maps online observation fields from cloud catalog', async () => {
  const fake = createFakeSupabase({
    'rpc:list_my_cloud_plugin_catalog': {
      data: [{
        plugin_id: 'redmonkey-picturebook',
        name: 'Picturebook',
        description: 'Hosted plugin fixture.',
        provider: 'RedMonkey',
        plugin_kind: 'openclaw_plugin',
        status: 'active',
        is_global: true,
        metadata: {
          catalog_section: 'third-party',
          marketplace_source: 'uniopc_artifact',
          install_kind: 'cloud_artifact',
          runtime_plugin_id: 'redmonkey-picturebook',
          latest_version: '1.2.0',
        },
        observed_status: 'installed',
        observed_version: '1.0.0',
        observed_enabled: true,
        drift_status: 'version_mismatch',
        observed_at: '2026-07-01T00:00:00Z',
        assignment_status: 'active',
      }],
      error: null,
    },
  })

  const rows = await normalizeCatalogRpcFixture(fake.client)

  assert.equal(rows[0].observedStatus, 'installed')
  assert.equal(rows[0].observedVersion, '1.0.0')
  assert.equal(rows[0].observedEnabled, true)
  assert.equal(rows[0].driftStatus, 'version_mismatch')
  assert.equal(rows[0].observedAt, '2026-07-01T00:00:00Z')
  assert.equal(rows[0].assignmentStatus, 'active')
})

test('cached profile plugin snapshot treats cloud observation as stale local cache', () => {
  const snapshot = buildCachedProfilePluginSnapshot('lanjinyu01-32bb573f', [
    {
      id: 'uniopc-cloud-workspace',
      runtimePluginId: 'uniopc-cloud-workspace',
      title: '工作区',
      description: 'Cloud workspace',
      observedStatus: 'installed',
      observedVersion: '1.0.0',
      observedEnabled: true,
    },
    {
      id: 'redmonkey-picturebook',
      title: 'Picturebook',
      observedStatus: 'missing',
      observedEnabled: false,
    },
    {
      id: 'unobserved-cloud-plugin',
      title: 'Unobserved',
      observedStatus: 'unknown',
    },
  ])

  assert.equal(snapshot.profile, 'lanjinyu01-32bb573f')
  assert.deepEqual(snapshot.plugins.map(plugin => plugin.id), ['uniopc-cloud-workspace', 'redmonkey-picturebook'])
  assert.deepEqual(snapshot.plugins[0], {
    id: 'uniopc-cloud-workspace',
    title: '工作区',
    description: 'Cloud workspace',
    enabled: true,
    installed: true,
    status: 'ready',
    pluginPath: '',
    missingEnv: [],
    toolBridgeEnabled: true,
    cached: true,
  })
  assert.equal(snapshot.plugins[1].status, 'not_installed')
  assert.equal(snapshot.plugins[1].enabled, false)
})

test('cached split cloud plugin state remains attached to its installed artifact id', () => {
  const snapshot = buildCachedProfilePluginSnapshot('sales-owner-46f19d68b66f', [
    {
      id: 'uniopc-superip-monologue',
      runtimePluginId: 'uniopc-superip',
      title: '超级IP口播',
      observedStatus: 'installed',
      observedEnabled: true,
    },
  ])

  assert.deepEqual(snapshot.plugins, [{
    id: 'uniopc-superip-monologue',
    title: '超级IP口播',
    description: '',
    enabled: true,
    installed: true,
    status: 'ready',
    pluginPath: '',
    missingEnv: [],
    toolBridgeEnabled: true,
    cached: true,
  }])
})

test('listCloudProfilePluginAssignments reads current profile plugin observation cache', async () => {
  const fake = createFakeSupabase({
    'cloud_profile_plugin_assignments:list': {
      data: [{
        id: 'assignment-1',
        openclaw_profile_id: 'profile-1',
        plugin_id: 'uniopc-cloud-workspace',
        observed_status: 'failed',
        observed_version: '',
        observed_enabled: false,
        drift_status: 'failed_local',
        status: 'active',
        last_error: 'gateway install timed out',
        observed_at: '2026-07-01T00:00:00Z',
      }],
      error: null,
    },
  })

  const rows = await listCloudProfilePluginAssignments(fake.client, 'owner-1', 'profile-1')

  assert.deepEqual(rows.map(row => [row.pluginId, row.observedStatus, row.driftStatus]), [
    ['uniopc-cloud-workspace', 'failed', 'failed_local'],
  ])
  assert.equal(rows[0].lastError, 'gateway install timed out')
  assert.deepEqual(fake.calls, [
    {
      table: 'cloud_profile_plugin_assignments',
      op: 'select',
      columns: 'id, organization_id, member_id, openclaw_profile_id, plugin_id, desired_version, desired_enabled, observed_status, observed_version, observed_enabled, observed_sha256, drift_status, status, last_error, observed_at, updated_at',
    },
    { table: 'cloud_profile_plugin_assignments', op: 'eq', column: 'openclaw_profile_id', value: 'profile-1' },
    { table: 'cloud_profile_plugin_assignments', op: 'order', column: 'updated_at', options: { ascending: false } },
  ])
})

test('authorizeCloudPluginInstall creates a desired profile plugin assignment through cloud RPC', async () => {
  const fake = createFakeSupabase({
    'rpc:authorize_cloud_plugin_install': {
      data: {
        assignment_id: 'assignment-1',
        plugin_id: 'uniopc-socials',
        desired_version: '0.1.0',
        desired_enabled: true,
        status: 'authorized',
      },
      error: null,
    },
  })

  const row = await authorizeCloudPluginInstall(fake.client, 'owner-1', 'profile-1', 'uniopc-socials', 'latest')

  assert.equal(row.id, 'assignment-1')
  assert.equal(row.pluginId, 'uniopc-socials')
  assert.equal(row.desiredVersion, '0.1.0')
  assert.equal(row.desiredEnabled, true)
  assert.equal(row.status, 'authorized')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'authorize_cloud_plugin_install',
      args: {
        p_plugin_id: 'uniopc-socials',
        p_openclaw_profile_id: 'profile-1',
        p_version: 'latest',
      },
    },
  ])
})

test('mergeCloudPluginCatalogObservations fills stale RPC catalog rows from assignment cache', () => {
  const rows = mergeCloudPluginCatalogObservations([
    {
      id: 'uniopc-cloud-workspace',
      runtimePluginId: 'uniopc-cloud-workspace',
      observedStatus: 'unknown',
    },
  ], [
    {
      pluginId: 'uniopc-cloud-workspace',
      observedStatus: 'failed',
      observedEnabled: false,
      driftStatus: 'failed_local',
      observedAt: '2026-07-01T00:00:00Z',
      status: 'active',
    },
  ])

  assert.equal(rows[0].observedStatus, 'failed')
  assert.equal(rows[0].observedEnabled, false)
  assert.equal(rows[0].driftStatus, 'failed_local')
  assert.equal(rows[0].assignmentStatus, 'active')
})

test('reportCloudProfilePluginObservation writes local doctor results through the observation RPC', async () => {
  const fake = createFakeSupabase({
    'rpc:report_cloud_profile_plugin_observation': {
      data: {
        id: 'assignment-1',
        plugin_id: 'uniopc-socials',
        observed_status: 'installed',
        observed_enabled: true,
        drift_status: 'in_sync',
        status: 'active',
      },
      error: null,
    },
  })

  const row = await reportCloudProfilePluginObservation(fake.client, 'owner-1', 'profile-1', {
    pluginId: 'uniopc-socials',
    observedStatus: 'installed',
    observedEnabled: true,
    error: '',
  })

  assert.equal(row.pluginId, 'uniopc-socials')
  assert.equal(row.observedStatus, 'installed')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'report_cloud_profile_plugin_observation',
      args: {
        p_openclaw_profile_id: 'profile-1',
        p_plugin_id: 'uniopc-socials',
        p_observed_status: 'installed',
        p_observed_version: '',
        p_observed_enabled: true,
        p_observed_sha256: '',
        p_observed_device_id: null,
        p_error: '',
      },
    },
  ])
})

test('normalizeCloudPluginCatalogRows maps Uniopc 引擎 builtin install metadata', async () => {
  const originalLocalStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: key => key === 'imai.language' ? 'zh' : null }
  const fake = createFakeSupabase({
    'rpc:list_my_cloud_plugin_catalog': {
      data: [{
        plugin_id: 'openclaw-codex-computer-use',
        name: 'Codex Computer Use',
        description: 'Enable Codex computer-use workflows.',
        provider: 'Uniopc 引擎',
        plugin_kind: 'openclaw_plugin',
        status: 'active',
        is_global: true,
        metadata: {
          catalog_section: 'third-party',
          marketplace_source: 'openclaw_builtin',
          marketplace_channel: 'official',
          runtime_plugin_id: 'codex',
          install_spec: 'openclaw:codex-computer-use',
          install_kind: 'codex_computer_use',
          docs_url: 'https://docs.openclaw.ai/plugins/codex-computer-use',
          config_path: 'plugins.entries.codex.config.computerUse',
          command_hint: '/codex computer-use status',
          install_hint: '/codex computer-use install',
          is_openclaw_official: true,
          i18n: {
            zh: {
              name: 'Codex 电脑控制',
              description: '通过 Uniopc 引擎 Codex 应用服务和 MCP 集成启用 Codex 电脑控制流程。',
            },
            en: {
              name: 'Codex Computer Use',
              description: 'Enable Codex computer-use workflows.',
            },
          },
          tags: ['Uniopc 引擎', 'Official', 'Codex'],
        },
      }],
      error: null,
    },
  })

  try {
    const rows = await normalizeCatalogRpcFixture(fake.client)

    assert.equal(rows[0].title, 'Codex 电脑控制')
    assert.equal(rows[0].description, '通过 Uniopc 引擎 Codex 应用服务和 MCP 集成启用 Codex 电脑控制流程。')
    assert.equal(rows[0].marketplaceSource, 'openclaw_builtin')
    assert.equal(rows[0].installSpec, 'openclaw:codex-computer-use')
    assert.equal(rows[0].installKind, 'codex_computer_use')
    assert.equal(rows[0].docsUrl, 'https://docs.openclaw.ai/plugins/codex-computer-use')
    assert.equal(rows[0].configPath, 'plugins.entries.codex.config.computerUse')
    assert.equal(rows[0].commandHint, '/codex computer-use status')
    assert.equal(rows[0].installHint, '/codex computer-use install')
    assert.equal(rows[0].isOpenClawOfficial, true)
  } finally {
    if (originalLocalStorage === undefined) {
      delete globalThis.localStorage
    } else {
      globalThis.localStorage = originalLocalStorage
    }
  }
})

test('getMyWorkspacePluginPolicyBootstrap returns profile identity, policy version, and plugins', async () => {
  const fake = createFakeSupabase({
    'rpc:get_my_workspace_plugin_policy_bootstrap': {
      data: [{
        organization_id: 'org-1',
        organization_name: 'Acme',
        member_id: 'member-1',
        member_role: 'admin',
        openclaw_profile_id: 'profile-1',
        openclaw_profile: 'acme-admin',
        profile_status: 'active',
        policy_version: 7,
        plugins: [
          {
            plugin_id: 'uniopc-cloud-workspace',
            plugin_name: '云端工作区',
            entitlement_status: 'active',
            is_global: true,
            metadata: { global_plugin: true },
          },
        ],
      }],
      error: null,
    },
  })

  const result = await getMyWorkspacePluginPolicyBootstrap(fake.client, 'user-1')

  assert.equal(result.organizationId, 'org-1')
  assert.equal(result.openclawProfile, 'acme-admin')
  assert.equal(result.policyVersion, 7)
  assert.deepEqual(result.plugins.map(plugin => [plugin.pluginId, plugin.status, plugin.isGlobal]), [
    ['uniopc-cloud-workspace', 'active', true],
  ])
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'get_my_workspace_plugin_policy_bootstrap', args: {} },
  ])
})

testBackendSourceContract('plugin entitlement migration treats cloud workspace as a default grant for every organization', () => {
  const sql = read('supabase/migrations/202605210004_default_cloud_workspace_plugin_entitlement.sql')

  assert.equal(sql.includes('create or replace function public.list_my_organization_plugin_entitlements'), true)
  assert.equal(sql.includes("'uniopc-cloud-workspace'"), true)
  assert.equal(sql.includes('left join public.cloud_organization_plugin_entitlements'), true)
  assert.equal(sql.includes("coalesce(e.status, 'active')"), true)
  assert.equal(sql.includes('c.plugin_id = any'), true)
  assert.equal(sql.includes('create or replace function public.list_platform_organizations'), true)
  assert.equal(sql.includes('cloud_plugin_catalog default_plugin'), true)
})

testBackendSourceContract('workspace plugin policy version migration bumps on entitlement changes', () => {
  const sql = read('supabase/migrations/202605250002_workspace_plugin_policy_versions.sql')
  assert.equal(sql.includes('create table if not exists public.cloud_workspace_policy_versions'), true)
  assert.equal(sql.includes('create or replace function public.bump_cloud_workspace_policy_version'), true)
  assert.equal(sql.includes('create trigger cloud_organization_plugin_entitlements_policy_version'), true)
  assert.equal(sql.includes('after insert or update or delete on public.cloud_organization_plugin_entitlements'), true)
  assert.equal(sql.includes('create or replace function public.bump_all_cloud_workspace_plugin_policy_versions'), true)
  assert.equal(sql.includes('create trigger cloud_plugin_catalog_policy_version'), true)
  assert.equal(sql.includes('after insert or update or delete on public.cloud_plugin_catalog'), true)
})

testBackendSourceContract('workspace plugin policy bootstrap rpc returns profile and plugin policy', () => {
  const sql = read('supabase/migrations/202605250002_workspace_plugin_policy_versions.sql')
  assert.equal(sql.includes('create or replace function public.get_my_workspace_plugin_policy_bootstrap'), true)
  assert.equal(sql.includes('policy_version bigint'), true)
  assert.equal(sql.includes('plugins jsonb'), true)
  assert.equal(sql.includes('jsonb_agg'), true)
  assert.equal(sql.includes('cloud_workspace_policy_versions'), true)
  assert.equal(sql.includes('on conflict (organization_id) do nothing'), true)
  assert.equal(sql.includes('set updated_at = public.cloud_workspace_policy_versions.updated_at'), false)
})

testBackendSourceContract('cloud agent host credential migration stores one hashed credential per profile plugin', () => {
  const baseSql = read('supabase/migrations/202605220001_cloud_agent_runtime_tokens.sql')
  const hostSql = read('supabase/migrations/20260607190131_host_profile_plugin_credentials.sql')

  assert.equal(baseSql.includes('create table if not exists public.cloud_agent_install_credentials'), true)
  assert.equal(baseSql.includes('credential_hash text not null unique'), true)
  assert.equal(baseSql.includes("cloud_agent_install_credentials_status_check"), true)
  assert.equal(baseSql.includes('revoke all on table public.cloud_agent_install_credentials from anon, authenticated'), true)
  assert.equal(hostSql.includes('add column if not exists plugin_id text not null default'), true)
  assert.equal(hostSql.includes('cloud_agent_install_credentials_profile_plugin_uidx'), true)
  assert.equal(hostSql.includes('openclaw_profile_id, plugin_id'), true)
  assert.equal(hostSql.includes("status = 'revoked'"), true)
})

test('getMyCloudWorkspaceProfile returns the current member profile route', async () => {
  const fake = createFakeSupabase({
    'rpc:get_my_cloud_workspace_profile': {
      data: [{
        organization_id: 'org-1',
        organization_name: 'Acme',
        member_id: 'member-1',
        member_role: 'member',
        openclaw_profile: 'alice',
        profile_status: 'active',
        runtime_mode: 'owner_hosted',
        host_status: 'online',
        gateway_status: 'online',
        gateway_status_message: 'ready',
      }],
      error: null,
    },
  })

  const result = await getMyCloudWorkspaceProfile(fake.client, 'user-1')

  assert.equal(result.openclawProfile, 'alice')
  assert.equal(result.runtimeMode, 'member_local')
  assert.equal(result.hostStatus, 'online')
  assert.equal(result.gatewayStatus, 'online')
  assert.equal(result.gatewayStatusMessage, 'ready')
  assert.equal(result.isOwner, false)
  assert.equal(result.isAdmin, false)
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'get_my_cloud_workspace_profile', args: {} },
  ])
})

test('getMyCloudWorkspaceProfile refreshes an expired session before its RPC', async () => {
  const fake = createFakeSupabase({
    'rpc:get_my_cloud_workspace_profile': {
      data: [{ member_role: 'owner', openclaw_profile: 'owner-workspace', profile_status: 'active' }],
      error: null,
    },
  })
  let refreshCalls = 0
  fake.client.auth = {
    async getSession() {
      return { data: { session: { expires_at: 1 } }, error: null }
    },
    async refreshSession() {
      refreshCalls += 1
      return { data: { session: { access_token: 'renewed', expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }
    },
  }

  const result = await getMyCloudWorkspaceProfile(fake.client, 'user-1')

  assert.equal(refreshCalls, 1)
  assert.equal(result.openclawProfile, 'owner-workspace')
  assert.deepEqual(fake.calls, [{ op: 'rpc', name: 'get_my_cloud_workspace_profile', args: {} }])
})

test('getMyCloudWorkspaceProfile reports a refresh that never returns as an expired login', async () => {
  const fake = createFakeSupabase()
  fake.client.auth = {
    async getSession() {
      return { data: { session: { expires_at: 1 } }, error: null }
    },
    async refreshSession() {
      return await new Promise(() => {})
    },
  }

  const startedAt = Date.now()
  await assert.rejects(
    () => getMyCloudWorkspaceProfile(fake.client, 'user-1'),
    error => error?.code === 'workspace_session_refresh_timeout' && error?.status === 401,
  )
  assert.ok(Date.now() - startedAt < 8_500)
})

test('workspace profile normalization exposes local-only runtime mode', async () => {
  const fake = createFakeSupabase({
    'rpc:get_my_cloud_workspace_profile': {
      data: {
        organization_id: 'org-1',
        organization_name: 'Acme',
        member_id: 'member-alice',
        member_role: 'member',
        openclaw_profile_id: 'profile-alice',
        openclaw_profile: 'alice',
        profile_status: 'active',
        runtime_mode: 'member_local',
      },
      error: null,
    },
  })

  const result = await getMyCloudWorkspaceProfile(fake.client, 'user-1')

  assert.equal(result.runtimeMode, 'member_local')
  assert.equal(result.runtime_mode, 'member_local')
})

test('acceptRegisteredCloudOrganizationInvite claims an email invite for the current user', async () => {
  const fake = createFakeSupabase({
    'rpc:accept_registered_cloud_organization_invite': {
      data: {
        id: 'alice-user',
        email: 'alice@example.com',
        nickname: 'Alice',
        invite_accepted_at: '2026-05-17T15:00:00.000Z',
      },
      error: null,
    },
  })

  const profile = await acceptRegisteredCloudOrganizationInvite(fake.client, 'alice-user')

  assert.equal(profile.uid, 'alice-user')
  assert.equal(profile.invite_accepted_at, '2026-05-17T15:00:00.000Z')
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'accept_registered_cloud_organization_invite', args: {} },
  ])
})

test('getMyOpenClawProfileAccess requests only the current users profile access', async () => {
  const fake = createFakeSupabase({
    'rpc:get_my_openclaw_profile_access': {
      data: [{
        organization_id: 'org-1',
        organization_member_id: 'member-alice',
        openclaw_profile_id: 'profile-alice',
        openclaw_profile: 'alice',
        runtime_mode: 'owner_hosted',
        host_id: 'host-1',
        host_status: 'online',
        profile_status: 'active',
      }],
      error: null,
    },
  })

  const access = await getMyOpenClawProfileAccess(fake.client, 'alice-user')

  assert.equal(access.memberId, 'member-alice')
  assert.equal(access.openclawProfile, 'alice')
  assert.equal(access.runtimeMode, 'member_local')
  assert.equal(access.hostStatus, 'online')
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'get_my_openclaw_profile_access', args: {} },
  ])
})

test('listMyCloudAiEmployees reads only the current members owner-hosted profile directory', async () => {
  const fake = createFakeSupabase({
    'rpc:list_my_cloud_ai_employees': {
      data: [
        {
          id: 'cloud-employee-1',
          organization_member_id: 'member-alice',
          openclaw_profile_id: 'profile-alice',
          openclaw_profile: 'alice',
          openclaw_agent_id: 'sales',
          name: '销售助理',
          role: '销售',
          default_model: 'openai/gpt-5.4',
          is_default: true,
          runtime_status: 'online',
          host_status: 'online',
        },
      ],
      error: null,
    },
  })

  const employees = await listMyCloudAiEmployees(fake.client, 'alice-user')

  assert.deepEqual(employees.map(item => [
    item.id,
    item.cloud_employee_id,
    item.openclaw_profile,
    item.openclaw_agent_id,
    item.name,
    item.is_default,
    item.status,
    item.source,
  ]), [
    ['sales', 'cloud-employee-1', 'alice', 'sales', '销售助理', true, 'online', 'cloud'],
  ])
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'list_my_cloud_ai_employees', args: {} },
  ])
})

test('syncMyCloudAiEmployees publishes the Gateway agent snapshot to the current cloud profile', async () => {
  const fake = createFakeSupabase({
    'rpc:sync_my_cloud_ai_employees': {
      data: [
        {
          id: 'cloud-main',
          organization_member_id: 'member-alice',
          openclaw_profile_id: 'profile-alice',
          openclaw_profile: 'alice',
          openclaw_agent_id: 'main',
          name: 'Elon',
          role: 'AI 员工',
          description: '持续对话',
          emoji: '🤖',
          default_model: 'openai-codex/gpt-5.5',
          status: 'active',
          runtime_status: 'online',
        },
      ],
      error: null,
    },
  })

  const rows = await syncMyCloudAiEmployees(fake.client, 'alice-user', [
    {
      id: ' main ',
      name: ' Elon ',
      role: ' AI 员工 ',
      description: ' 持续对话 ',
      emoji: '🤖',
      model: 'openai-codex/gpt-5.5',
      is_default: true,
      status: 'active',
    },
  ])

  assert.deepEqual(rows.map(item => [item.cloud_employee_id, item.openclaw_agent_id, item.name, item.status]), [
    ['cloud-main', 'main', 'Elon', 'online'],
  ])
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'sync_my_cloud_ai_employees',
      args: {
        p_agents: [
          {
            openclaw_agent_id: 'main',
            name: 'Elon',
            role: 'AI 员工',
            description: '持续对话',
            emoji: '🤖',
            default_model: 'openai-codex/gpt-5.5',
            is_default: true,
            runtime_status: 'online',
          },
        ],
      },
    },
  ])
})

test('registerMemberDevice registers desktop member clients without exposing profile details', async () => {
  const fake = createFakeSupabase({
    'rpc:register_member_device': {
      data: {
        id: 'device-1',
        organization_id: 'org-1',
        member_id: 'member-alice',
        user_id: 'alice-user',
        device_type: 'desktop',
        device_name: 'Alice MacBook',
        device_platform: 'macos',
        device_fingerprint: 'fingerprint-1',
        status: 'active',
        last_seen_at: '2026-05-18T10:00:00.000Z',
      },
      error: null,
    },
  })

  const device = await registerMemberDevice(fake.client, 'alice-user', {
    deviceType: ' mobile ',
    deviceName: ' Alice MacBook ',
    devicePlatform: ' macos ',
    deviceFingerprint: ' fingerprint-1 ',
  })

  assert.deepEqual(device, {
    id: 'device-1',
    organizationId: 'org-1',
    memberId: 'member-alice',
    userId: 'alice-user',
    deviceType: 'desktop',
    deviceName: 'Alice MacBook',
    devicePlatform: 'macos',
    deviceFingerprint: 'fingerprint-1',
    status: 'active',
    lastSeenAt: '2026-05-18T10:00:00.000Z',
  })
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'register_member_device',
      args: {
        p_device_type: 'desktop',
        p_device_name: 'Alice MacBook',
        p_device_platform: 'macos',
        p_device_fingerprint: 'fingerprint-1',
      },
    },
  ])
})

test('getMyMemberClientBootstrap normalizes Gateway assignment and authorized agents for ordinary clients', async () => {
  const fake = createFakeSupabase({
    'rpc:get_my_member_client_bootstrap': {
      data: {
        status: 'ready',
        organization_id: 'org-1',
        organization_name: 'Acme',
        member_id: 'member-alice',
        member_role: 'member',
        device: {
          id: 'device-1',
          device_type: 'desktop',
          status: 'active',
        },
        gateway_assignment: {
          id: 'assignment-1',
          host_id: 'host-1',
          openclaw_profile_id: 'profile-alice',
          openclaw_profile: 'alice',
          gateway_url: 'wss://owner.example.ts.net',
          gateway_status: 'online',
          access_mode: 'direct',
          status: 'active',
        },
        pairing_setup: {
          openclaw_profile_id: 'profile-alice',
          openclaw_profile: 'alice',
          setup_code: 'setup-code-1',
          gateway_url: 'wss://owner.example.ts.net',
          pairing_status: 'pending',
          expires_at: '2026-05-18T10:30:00.000Z',
        },
        agents: [
          {
            id: 'perm-1',
            openclaw_agent_id: 'sales',
            openclaw_profile_id: 'profile-alice',
            openclaw_profile: 'alice',
            name: '销售助理',
            role: '销售',
            can_chat: true,
            can_use_tools: false,
            capabilities: { browser: false },
            runtime_status: 'online',
          },
          {
            id: 'perm-main',
            openclaw_agent_id: 'main',
            openclaw_profile_id: 'profile-alice',
            openclaw_profile: 'alice',
            name: 'main',
            role: 'AI 员工',
            can_chat: true,
            runtime_status: 'offline',
          },
        ],
        capabilities: {
          can_chat: true,
          can_use_tools: false,
        },
      },
      error: null,
    },
  })

  const bootstrap = await getMyMemberClientBootstrap(fake.client, 'alice-user', {
    deviceId: 'device-1',
  })

  assert.equal(bootstrap.status, 'ready')
  assert.equal(bootstrap.organizationName, 'Acme')
  assert.equal(bootstrap.memberRole, 'member')
  assert.equal(bootstrap.device.id, 'device-1')
  assert.deepEqual(bootstrap.gatewayAssignment, {
    id: 'assignment-1',
    organizationId: null,
    memberId: null,
    deviceId: null,
    hostId: 'host-1',
    openclawProfileId: 'profile-alice',
    openclawProfile: 'alice',
    gatewayUrl: 'wss://owner.example.ts.net',
    gatewayStatus: 'online',
    accessMode: 'direct',
    transport: 'direct',
    sshTarget: '',
    sshRemoteHost: '',
    sshRemotePort: null,
    sshLocalPort: null,
    status: 'active',
    expiresAt: null,
  })
  assert.deepEqual(bootstrap.pairingSetup, {
    openclawProfileId: 'profile-alice',
    openclawProfile: 'alice',
    setupCode: 'setup-code-1',
    gatewayUrl: 'wss://owner.example.ts.net',
    transport: '',
    sshTarget: '',
    sshRemoteHost: '',
    sshRemotePort: null,
    sshLocalPort: null,
    pairingStatus: 'pending',
    expiresAt: '2026-05-18T10:30:00.000Z',
  })
  assert.deepEqual(bootstrap.agents.map(agent => [
    agent.id,
    agent.openclaw_agent_id,
    agent.openclaw_profile,
    agent.name,
    agent.can_chat,
    agent.can_use_tools,
    agent.source,
    agent.status,
  ]), [
    ['sales', 'sales', 'alice', '销售助理', true, false, 'member-client', 'online'],
    ['main', 'main', 'alice', 'main', true, false, 'member-client', 'online'],
  ])
  assert.deepEqual(bootstrap.capabilities, {
    can_chat: true,
    can_use_tools: false,
  })
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'get_my_member_client_bootstrap',
      args: {
        p_device_id: 'device-1',
      },
    },
  ])
})

test('assignMemberGateway binds a member profile without storing local Gateway endpoints in cloud', async () => {
  const fake = createFakeSupabase({
    'rpc:assign_member_gateway': {
      data: {
        id: 'assignment-1',
        member_id: 'member-alice',
        host_id: 'host-1',
        openclaw_profile_id: 'profile-alice',
        openclaw_profile: 'alice',
        gateway_url: 'ws://127.0.0.1:18821',
        access_mode: 'direct',
        status: 'active',
      },
      error: null,
    },
  })

  const assignment = await assignMemberGateway(fake.client, 'owner-1', {
    memberId: 'member-alice',
    hostId: 'host-1',
    openclawProfileId: 'profile-alice',
    gatewayUrl: ' ws://127.0.0.1:18821 ',
  })

  assert.equal(assignment.openclawProfileId, 'profile-alice')
  assert.equal(assignment.gatewayUrl, 'ws://127.0.0.1:18821')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'assign_member_gateway',
      args: {
        p_member_id: 'member-alice',
        p_device_id: null,
        p_host_id: 'host-1',
        p_openclaw_profile_id: 'profile-alice',
        p_gateway_url: null,
        p_access_mode: 'direct',
        p_transport: 'direct',
        p_ssh_target: null,
        p_ssh_remote_host: null,
        p_ssh_remote_port: null,
        p_ssh_local_port: null,
      },
    },
  ])
})

test('assignMemberGateway keeps remote connection parameters local-only', async () => {
  const fake = createFakeSupabase({
    'rpc:assign_member_gateway': {
      data: {
        id: 'assignment-1',
        member_id: 'member-alice',
        host_id: 'host-1',
        openclaw_profile_id: 'profile-alice',
        openclaw_profile: 'alice',
        gateway_url: '',
        access_mode: 'direct',
        transport: 'direct',
        ssh_target: null,
        ssh_remote_host: null,
        ssh_remote_port: null,
        ssh_local_port: null,
        status: 'active',
      },
      error: null,
    },
  })

  const assignment = await assignMemberGateway(fake.client, 'owner-1', {
    memberId: 'member-alice',
    hostId: 'host-1',
    openclawProfileId: 'profile-alice',
    gatewayUrl: 'ws://127.0.0.1:18791',
    accessMode: 'ssh_tunnel',
    transport: 'ssh',
    sshTarget: 'owner@100.105.138.117',
    sshRemoteHost: '127.0.0.1',
    sshRemotePort: 18790,
    sshLocalPort: 18791,
  })

  assert.equal(assignment.gatewayUrl, '')
  assert.equal(assignment.transport, 'direct')
  assert.equal(assignment.sshTarget, '')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'assign_member_gateway',
      args: {
        p_member_id: 'member-alice',
        p_device_id: null,
        p_host_id: 'host-1',
        p_openclaw_profile_id: 'profile-alice',
        p_gateway_url: null,
        p_access_mode: 'direct',
        p_transport: 'direct',
        p_ssh_target: null,
        p_ssh_remote_host: null,
        p_ssh_remote_port: null,
        p_ssh_local_port: null,
      },
    },
  ])
})

test('grantMemberAgentPermission lets admins expose one agent with explicit capabilities', async () => {
  const fake = createFakeSupabase({
    'rpc:grant_member_agent_permission': {
      data: {
        id: 'permission-1',
        member_id: 'member-alice',
        openclaw_profile_id: 'profile-alice',
        openclaw_profile: 'alice',
        openclaw_agent_id: 'sales',
        can_chat: true,
        can_use_tools: true,
        capabilities: { browser: true },
        status: 'active',
      },
      error: null,
    },
  })

  const permission = await grantMemberAgentPermission(fake.client, 'owner-1', {
    memberId: 'member-alice',
    openclawProfileId: 'profile-alice',
    openclawAgentId: 'sales',
    canUseTools: true,
    capabilities: { browser: true },
  })

  assert.equal(permission.id, 'sales')
  assert.equal(permission.permission_id, 'permission-1')
  assert.equal(permission.can_use_tools, true)
  assert.deepEqual(permission.capabilities, { browser: true })
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'grant_member_agent_permission',
      args: {
        p_member_id: 'member-alice',
        p_openclaw_profile_id: 'profile-alice',
        p_openclaw_agent_id: 'sales',
        p_project_id: null,
        p_can_chat: true,
        p_can_run_tasks: true,
        p_can_read_documents: true,
        p_can_write_documents: false,
        p_can_use_tools: true,
        p_capabilities: { browser: true },
      },
    },
  ])
})

test('getMemberClientAdminSummary shows owner current Gateway assignment and granted agents', async () => {
  const fake = createFakeSupabase({
    'rpc:get_member_client_admin_summary': {
      data: {
        member_id: 'member-alice',
        gateway_assignment: {
          id: 'assignment-1',
          member_id: 'member-alice',
          host_id: 'host-1',
          openclaw_profile_id: 'profile-alice',
          openclaw_profile: 'alice',
          gateway_url: 'ws://127.0.0.1:18821',
          gateway_status: 'online',
          status: 'active',
        },
        agents: [
          {
            id: 'permission-1',
            permission_id: 'permission-1',
            openclaw_profile_id: 'profile-alice',
            openclaw_profile: 'alice',
            openclaw_agent_id: 'sales',
            name: '销售助理',
            can_chat: true,
            can_use_tools: false,
            status: 'active',
          },
        ],
      },
      error: null,
    },
  })

  const summary = await getMemberClientAdminSummary(fake.client, 'owner-1', 'member-alice')

  assert.equal(summary.memberId, 'member-alice')
  assert.equal(summary.gatewayAssignment.id, 'assignment-1')
  assert.equal(summary.agents[0].permission_id, 'permission-1')
  assert.equal(summary.agents[0].openclaw_agent_id, 'sales')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'get_member_client_admin_summary',
      args: { p_member_id: 'member-alice' },
    },
  ])
})

test('revokeMemberGatewayAssignment and revokeMemberAgentPermission call admin revoke RPCs', async () => {
  const fake = createFakeSupabase({
    'rpc:revoke_member_gateway_assignment': {
      data: {
        id: 'assignment-1',
        status: 'revoked',
      },
      error: null,
    },
    'rpc:revoke_member_agent_permission': {
      data: {
        id: 'permission-1',
        permission_id: 'permission-1',
        openclaw_agent_id: 'sales',
        status: 'revoked',
      },
      error: null,
    },
  })

  const assignment = await revokeMemberGatewayAssignment(fake.client, 'owner-1', 'assignment-1')
  const permission = await revokeMemberAgentPermission(fake.client, 'owner-1', 'permission-1')

  assert.equal(assignment.status, 'revoked')
  assert.equal(permission.status, 'revoked')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'revoke_member_gateway_assignment',
      args: { p_assignment_id: 'assignment-1' },
    },
    {
      op: 'rpc',
      name: 'revoke_member_agent_permission',
      args: { p_permission_id: 'permission-1' },
    },
  ])
})

testBackendSourceContract('cloud AI employee request migration records member requests without inventing agents', () => {
  const sql = read('supabase/migrations/202605181900_cloud_ai_employee_requests.sql')

  assert.equal(sql.includes('cloud_ai_employee_requests'), true)
  assert.equal(sql.includes('request_cloud_ai_employee_creation'), true)
  assert.equal(sql.includes('list_my_cloud_ai_employee_requests'), true)
  assert.equal(sql.includes('approve_cloud_ai_employee_creation_request'), true)
  assert.equal(sql.includes("openclaw_agent_id = 'main'"), false)
  assert.equal(sql.includes("'main' as openclaw_agent_id"), false)
})

testBackendSourceContract('member client Gateway MVP migration adds devices assignments permissions and bootstrap RPCs', () => {
  const sql = read('supabase/migrations/202605182030_member_client_gateway_mvp.sql')

  assert.equal(sql.includes('cloud_member_devices'), true)
  assert.equal(sql.includes('cloud_gateway_assignments'), true)
  assert.equal(sql.includes('cloud_member_agent_permissions'), true)
  assert.equal(sql.includes('register_member_device'), true)
  assert.equal(sql.includes('get_my_member_client_bootstrap'), true)
  assert.equal(sql.includes('assign_member_gateway'), true)
  assert.equal(sql.includes('grant_member_agent_permission'), true)
  assert.equal(sql.includes('get_member_client_admin_summary'), true)
  assert.equal(sql.includes('revoke_member_gateway_assignment'), true)
  assert.equal(sql.includes('revoke_member_agent_permission'), true)
  assert.equal(sql.includes("check (device_type = 'desktop')"), true)
  assert.equal(sql.includes("'mobile'"), false)
  assert.equal(sql.includes("check (access_mode in ('direct', 'relay_future'))"), true)
  assert.equal(sql.includes("openclaw_profile_id uuid not null references public.cloud_openclaw_profiles"), true)
})

testBackendSourceContract('member client bootstrap migration carries pairing setup for official remote pairing', () => {
  const sql = read('supabase/migrations/202605211430_member_bootstrap_pairing_setup.sql')

  assert.equal(sql.includes('create or replace function public.get_my_member_client_bootstrap'), true)
  assert.equal(sql.includes('cloud_openclaw_profile_pairing_setups'), true)
  assert.equal(sql.includes("'pairing_setup'"), true)
  assert.equal(sql.includes("'setup_code', v_pairing_setup.setup_code"), true)
  assert.equal(sql.includes("'gateway_url', coalesce(nullif(v_pairing_setup.gateway_url, '')"), true)
})

testBackendSourceContract('member remote Gateway transport migration carries direct and SSH assignment details', () => {
  const sql = read('supabase/migrations/202605280001_member_remote_gateway_transports.sql')

  assert.equal(sql.includes('add column if not exists transport'), true)
  assert.equal(sql.includes('add column if not exists ssh_target'), true)
  assert.equal(sql.includes("check (access_mode in ('direct', 'ssh_tunnel', 'local_tunnel', 'relay_future'))"), true)
  assert.equal(sql.includes('p_transport text default'), true)
  assert.equal(sql.includes('p_ssh_target text default null'), true)
  assert.equal(sql.includes("'transport', v_assignment.transport"), true)
  assert.equal(sql.includes("'ssh_target', v_assignment.ssh_target"), true)
  assert.equal(sql.includes("'transport', v_pairing_setup.transport"), true)
})

testBackendSourceContract('organization humans migration makes human membership visible to registered members without broadening AI scope', () => {
  const sql = read('supabase/migrations/202605182100_org_humans_visible_to_members.sql')

  assert.equal(sql.includes('create or replace function public.list_cloud_organization_members()'), true)
  assert.equal(sql.includes('create or replace function public.list_cloud_human_employees()'), true)
  assert.equal(sql.includes('m.user_id = v_user'), true)
  assert.equal(sql.includes("m.invite_status = 'registered'"), true)
  assert.equal(sql.includes('from public.cloud_organization_members m'), true)
  assert.equal(sql.includes('insert into public.cloud_human_employees'), true)
  assert.equal(sql.includes('on conflict on constraint cloud_human_employees_owner_id_member_email_key'), true)
  assert.equal(sql.includes('h.organization_id = v_workspace.organization_id'), true)
  assert.equal(sql.includes('list_my_cloud_ai_employees'), false)
  assert.equal(sql.includes('is_cloud_org_admin'), false)
})

testBackendSourceContract('invite organization member migration matches the expanded member list return shape', () => {
  const sql = read('supabase/migrations/202605200014_fix_invite_org_member_return_shape.sql')

  assert.equal(sql.includes('drop function if exists public.invite_cloud_organization_member(text, text)'), true)
  assert.equal(sql.includes('openclaw_profile_id uuid'), true)
  assert.equal(sql.includes('runtime_mode text'), true)
  assert.equal(sql.includes('gateway_status text'), true)
  assert.equal(sql.includes('select rows.*'), true)
  assert.equal(sql.includes('from public.list_cloud_organization_members() rows'), true)
  assert.equal(sql.includes('grant execute on function public.invite_cloud_organization_member(text, text) to authenticated'), true)
})

testBackendSourceContract('member runtime mode migration defaults organization members to member-local profiles', () => {
  const sql = read('supabase/migrations/202606290001_member_runtime_modes.sql')

  assert.equal(sql.includes("runtime_mode in ('member_local')"), true)
  assert.equal(sql.includes("select 'member_local'"), true)
  assert.equal(sql.includes('create or replace function public.invite_cloud_organization_member'), true)
  assert.equal(sql.includes('p_runtime_mode text default'), true)
  assert.equal(sql.includes('create or replace function public.create_member_openclaw_profile'), true)
  assert.equal(sql.includes('member_local'), true)
  assert.equal(sql.includes('Member local setup pending'), true)
  assert.equal(sql.includes('create or replace function public.register_openclaw_profile_host'), true)
  assert.equal(sql.includes("and runtime_mode = 'member_local'"), true)
  assert.equal(sql.includes('create or replace function public.register_owner_openclaw_profile_host'), false)
  assert.equal(sql.includes("v_profile.runtime_mode <> 'owner_hosted'"), false)
  assert.equal(sql.includes("raise exception 'member_local_profile_requires_member_host'"), false)
  assert.equal(sql.includes('alter column runtime_mode set not null'), true)
})

testBackendSourceContract('human conversation avatars migration returns profile avatars with human employees', () => {
  const sql = read('supabase/migrations/202605182230_human_conversation_avatars.sql')

  assert.equal(sql.includes('drop function if exists public.list_cloud_human_employees()'), true)
  assert.equal(sql.includes('avatar_url text'), true)
  assert.equal(sql.includes('left join public.profiles mp on mp.id = h.member_user_id'), true)
  assert.equal(sql.includes('coalesce(mp.avatar_url'), true)
})

testBackendSourceContract('human employee names migration uses profile nickname before cached display names', () => {
  const sql = read('supabase/migrations/202605191330_human_employee_names_use_profile_nickname.sql')

  assert.equal(sql.includes('drop function if exists public.list_cloud_human_employees()'), true)
  assert.equal(sql.includes('update public.cloud_organization_members m'), true)
  assert.equal(sql.includes('set display_name = p.nickname'), true)
  assert.equal(sql.includes('update public.cloud_human_employees h'), true)
  assert.equal(sql.includes('set member_name = p.nickname'), true)
  assert.equal(sql.includes('update public.cloud_project_members pm'), true)
  assert.equal(sql.includes("pm.member_type = 'user'"), true)
  assert.equal(sql.includes('update public.cloud_human_messages msg'), true)
  assert.equal(sql.includes('set sender_name = p.nickname'), true)
  assert.equal(sql.includes('profiles_select_cloud_colleagues'), true)
  assert.equal(sql.includes('target.user_id = profiles.id'), true)
  assert.equal(sql.includes("viewer.invite_status = 'registered'"), true)
  assert.equal(sql.includes('left join public.profiles p on p.id = m.user_id'), true)
  assert.equal(sql.includes("coalesce(nullif(p.nickname, ''), nullif(m.display_name, ''), m.member_email)"), true)
  assert.equal(sql.includes("coalesce(nullif(mp.nickname, ''), nullif(m.display_name, ''), h.member_name, h.member_email) as counterpart_name"), true)
  assert.equal(sql.includes('grant execute on function public.list_cloud_human_employees() to authenticated'), true)
})

testBackendSourceContract('human pair conversations migration lets organization members chat without reusing one owner row', () => {
  const sql = read('supabase/migrations/202605182245_org_human_pair_conversations.sql')

  assert.equal(sql.includes('drop constraint if exists cloud_human_conversations_human_employee_id_key'), true)
  assert.equal(sql.includes('cloud_human_conversations_human_participant_idx'), true)
  assert.equal(sql.includes('on public.cloud_human_conversations(human_employee_id, participant_user_id)'), true)
  assert.equal(sql.includes('m.organization_id = h.organization_id'), true)
  assert.equal(sql.includes("m.invite_status = 'registered'"), true)
  assert.equal(sql.includes('h.member_user_id is distinct from v_user'), true)
  assert.equal(sql.includes('c.human_employee_id = v_self_human.id'), true)
  assert.equal(sql.includes('or auth.uid() = h.member_user_id'), true)
})

testBackendSourceContract('cloud org admin helper is executable by authenticated clients for RLS checks', () => {
  const sql = read('supabase/migrations/202605191128_fix_cloud_org_admin_execute_grant.sql')

  assert.equal(sql.includes('grant execute on function public.is_cloud_org_admin(uuid, uuid) to authenticated'), true)
})

testBackendSourceContract('platform admin org type and plugin entitlement migration adds core tables and RPCs', () => {
  const sql = read('supabase/migrations/202605200002_platform_admin_org_types_plugins.sql')
  assert.equal(sql.includes('create table if not exists public.imai_platform_admins'), true)
  assert.equal(sql.includes('create table if not exists public.cloud_organization_types'), true)
  assert.equal(sql.includes('create table if not exists public.cloud_plugin_catalog'), true)
  assert.equal(sql.includes('create table if not exists public.cloud_organization_plugin_entitlements'), true)
  assert.equal(sql.includes('alter table public.cloud_organizations'), true)
  assert.equal(sql.includes('organization_type_id'), true)
  assert.equal(sql.includes('create or replace function public.ensure_cloud_organization'), true)
  assert.equal(sql.includes('p_organization_type_id uuid default null'), true)
  assert.equal(sql.includes('organization_type_required'), true)
  assert.equal(sql.includes('organization_type_immutable'), true)
  assert.equal(sql.includes('create or replace function public.list_cloud_organization_types'), true)
  assert.equal(sql.includes('create or replace function public.list_my_organization_plugin_entitlements'), true)
  assert.equal(sql.includes('create or replace function public.list_platform_organizations'), true)
  assert.equal(sql.includes('create or replace function public.set_platform_organization_plugin_entitlement'), true)
  assert.match(sql, /'imai-short-drama-core', 'Uniopc Short Drama Core'/)
  assert.match(sql, /'imai-media-generation', 'Uniopc Media Generation'/)
  assert.match(sql, /'imai-growth-socials', 'Uniopc Growth Socials'/)
  assert.match(sql, /"applies_to_org_types": \["short_drama"\]/)
  assert.match(sql, /"plugin_role": "industry"/)
  assert.match(sql, /"plugin_role": "capability"/)
})

testBackendSourceContract('socials plugin merge migration folds growth Socials into 公域流量', () => {
  const sql = read('supabase/migrations/202606140002_merge_growth_socials_into_socials.sql')

  assert.match(sql, /insert into public\.cloud_organization_plugin_entitlements/)
  assert.match(sql, /'imai-growth-socials'/)
  assert.match(sql, /'uniopc-socials'/)
  assert.match(sql, /delete from public\.cloud_plugin_catalog/)
})

testBackendSourceContract('private conversion unification migration preserves historical Uniopc entitlements', () => {
  const sql = read('supabase/migrations/202606140001_unify_private_conversion_plugin.sql')

  assert.match(sql, /'uniopc-private-conversion'/)
  assert.match(sql, /'uniopc-private-conversion'/)
  assert.match(sql, /insert into public\.cloud_organization_plugin_entitlements/)
  assert.match(sql, /delete from public\.cloud_plugin_catalog/)
})

testBackendSourceContract('deferred official plugin cleanup removes unfinished plugin catalog entries', () => {
  const sql = read('supabase/migrations/202606140003_remove_deferred_official_plugins.sql')

  for (const pluginId of ['imai-short-drama-core', 'imai-media-generation', 'imai-telegram', 'imai-twitter']) {
    assert.match(sql, new RegExp(`'${pluginId}'`))
  }
  assert.match(sql, /delete from public\.cloud_organization_type_plugin_defaults/)
  assert.match(sql, /delete from public\.cloud_organization_plugin_entitlements/)
  assert.match(sql, /delete from public\.cloud_plugin_catalog/)
})

testBackendSourceContract('plugin app center cloud catalog migration carries UI and runtime metadata', () => {
  const sql = read('supabase/migrations/20260616041700_plugin_app_center_cloud_catalog.sql')

  assert.match(sql, /'uniopc-cloud-workspace'/)
  assert.doesNotMatch(sql, /'runtime_plugin_id', 'uniopc-cloud-workspace'/)
  assert.doesNotMatch(sql, /'aliases', jsonb_build_array\('uniopc-cloud-workspace'\)/)
  assert.match(sql, /'uniopc-cloud-workspace'[\s\S]*'Uniopc'[\s\S]*'uniopc-socials'[\s\S]*'Uniopc'[\s\S]*'uniopc-private-conversion'[\s\S]*'Uniopc'/)
  assert.match(sql, /Uniopc 云端调用公域流量/)
  assert.match(sql, /Uniopc 云端业务插件/)
  assert.doesNotMatch(sql, /通过 Supabase 云端调用公域流量/)
  assert.match(sql, /'uniopc-socials'[\s\S]*'default_entitlement', true/)
  assert.match(sql, /'management_route', 'workbench\/private-conversion'/)
  assert.doesNotMatch(sql, /'catalog_section', 'third-party'/)
  assert.match(sql, /delete from public\.cloud_plugin_catalog/)
  assert.match(sql, /'imai-short-drama-core'/)
  assert.doesNotMatch(sql, /where plugin_id in \([\s\S]*'uniopc-cloud-workspace'/)
  assert.match(sql, /'uniopc-private-conversion'/)
  assert.match(sql, /'imai-private-video-channel'/)
  assert.match(sql, /'xhs-insights-openclaw-plugin'/)
  assert.match(sql, /'@openclaw\/codex'/)
  assert.match(sql, /coalesce\(c\.metadata->>'catalog_section', ''\) in \('official', 'third-party'\)/)
  assert.match(sql, /create or replace function public\.list_my_cloud_plugin_catalog\(\)/)
  assert.match(sql, /grant execute on function public\.list_my_cloud_plugin_catalog\(\) to authenticated/)
})

testBackendSourceContract('cloud workspace plugin id forward migration rewrites deployed imai ids to uniopc ids', () => {
  const sql = read('supabase/migrations/202607010002_unify_cloud_workspace_plugin_id.sql')

  assert.match(sql, /v_old_plugin_id text := 'imai-cloud-workspace'/)
  assert.match(sql, /v_new_plugin_id text := 'uniopc-cloud-workspace'/)
  assert.match(sql, /'工作区'/)
  assert.match(sql, /'Uniopc'/)
  assert.match(sql, /Uniopc Cloud Agent API/)
  assert.doesNotMatch(sql, /coalesce\(old_plugin\.provider/)
  assert.doesNotMatch(sql, /coalesce\(old_plugin\.description/)
  assert.match(sql, /insert into public\.cloud_plugin_catalog/)
  assert.match(sql, /on conflict \(plugin_id\) do update/)
  assert.match(sql, /delete from public\.cloud_organization_plugin_entitlements old_row/)
  assert.match(sql, /delete from public\.cloud_organization_type_plugin_defaults old_row/)
  assert.match(sql, /delete from public\.cloud_profile_plugin_assignments old_row/)
  assert.match(sql, /update public\.cloud_plugin_versions/)
  assert.match(sql, /update public\.cloud_plugin_install_events/)
  assert.match(sql, /update public\.cloud_agent_install_credentials/)
  assert.match(sql, /update public\.cloud_agent_runtime_tokens/)
  assert.match(sql, /allowed_plugin_ids/)
  assert.match(sql, /alter table public\.cloud_agent_install_credentials/)
  assert.match(sql, /set default 'uniopc-cloud-workspace'/)
  assert.match(sql, /delete from public\.cloud_plugin_catalog/)
  assert.match(sql, /plugin_id = v_old_plugin_id/)
  assert.match(sql, /notify pgrst, 'reload schema'/)
})

testBackendSourceContract('official plugin provider brand forward migration rewrites deployed IMAI catalog rows', () => {
  const sql = read('supabase/migrations/20260701061617_unify_official_plugin_provider_brand.sql')

  assert.match(sql, /set provider = 'Uniopc'/)
  assert.match(sql, /'uniopc-cloud-workspace'/)
  assert.match(sql, /'uniopc-socials'/)
  assert.match(sql, /'uniopc-private-conversion'/)
  assert.match(sql, /Uniopc 云端调用公域流量/)
  assert.match(sql, /Uniopc 云端业务插件/)
  assert.doesNotMatch(sql, /provider = 'IMAI'/)
  assert.doesNotMatch(sql, /IMAI Cloud Agent API/)
  assert.match(sql, /notify pgrst, 'reload schema'/)
})

testBackendSourceContract('official plugin catalog runtime repair aligns managed pages with Uniopc 引擎 runtime plugins', () => {
  const sql = read('supabase/migrations/202606260001_unify_official_cloud_plugin_runtime_metadata.sql')

  assert.match(sql, /'uniopc-private-conversion'/)
  assert.match(sql, /'runtime_plugin_id', 'uniopc-private-conversion'/)
  assert.match(sql, /'aliases', jsonb_build_array\('uniopc-private-conversion'\)/)
  assert.match(sql, /'management_route', 'workbench\/private-conversion'/)
  assert.match(sql, /'uniopc-socials'/)
  assert.match(sql, /'aliases', jsonb_build_array\('uniopc-socials'\)/)
  assert.match(sql, /notify pgrst, 'reload schema'/)
})

testBackendSourceContract('plugin app center cloud catalog repair migration prunes stale catalog rows and filters app-center entries', () => {
  const sql = read('supabase/migrations/20260616041700_plugin_app_center_cloud_catalog.sql')

  assert.match(sql, /delete from public\.cloud_plugin_catalog/)
  assert.match(sql, /'imai-media-generation'/)
  assert.match(sql, /'imai-short-drama-core'/)
  assert.match(sql, /'imai-telegram'/)
  assert.match(sql, /'uniopc-cloud-workspace'/)
  assert.match(sql, /'uniopc-private-conversion'/)
  assert.match(sql, /'imai-private-redbook-channel'/)
  assert.match(sql, /'imai-private-live-channel'/)
  assert.match(sql, /'imai-private-video-channel'/)
  assert.match(sql, /'xhs-insights-openclaw-plugin'/)
  assert.match(sql, /'@openclaw\/codex'/)
  assert.match(sql, /coalesce\(c\.metadata->>'catalog_section', ''\) in \('official', 'third-party'\)/)
  assert.match(sql, /notify pgrst, 'reload schema'/)
})

testBackendSourceContract('global plugins migration adds catalog flag and treats global plugins as default entitlements', () => {
  const sql = read('supabase/migrations/202605240001_global_plugins.sql')

  assert.equal(sql.includes('add column if not exists is_global boolean not null default false'), true)
  assert.equal(sql.includes("set is_global = true"), true)
  assert.equal(sql.includes("plugin_id = 'uniopc-cloud-workspace'"), true)
  assert.equal(sql.includes('create or replace function public.list_my_organization_plugin_entitlements()'), true)
  assert.equal(sql.includes('c.is_global'), true)
  assert.equal(sql.includes("c.metadata || jsonb_build_object('global_plugin', true"), true)
  assert.equal(sql.includes('create or replace function public.upsert_platform_plugin'), true)
  assert.equal(sql.includes('p_is_global boolean default false'), true)
  assert.equal(sql.includes('grant execute on function public.upsert_platform_plugin(text, text, text, text, text, text, jsonb, boolean) to authenticated'), true)
})

testBackendSourceContract('global plugins migration removes organization counts dependency on global plugin entitlement rows', () => {
  const sql = read('supabase/migrations/202605240001_global_plugins.sql')

  assert.equal(sql.includes('where default_plugin.status = \'active\''), true)
  assert.equal(sql.includes('default_plugin.is_global'), true)
  assert.equal(sql.includes('or e.status = \'active\''), true)
})

testBackendSourceContract('agent-approved organization creation migration moves name edits to a dedicated RPC', () => {
  const sql = read('supabase/migrations/202605210001_agent_approved_org_initialization.sql')

  assert.equal(sql.includes('create or replace function public.member_openclaw_profile_key'), true)
  assert.equal(sql.includes("raise exception 'organization_opening_request_required'"), true)
  assert.equal(sql.includes('v_name := v_request.organization_name'), true)
  assert.equal(sql.includes('create or replace function public.update_my_cloud_organization_name'), true)
  assert.equal(sql.includes('p_name text'), true)
  assert.equal(sql.includes("raise exception 'organization_name_required'"), true)
  assert.equal(sql.includes('set name = v_name'), true)
  assert.equal(sql.includes('p_organization_type_id is not null'), true)
  assert.equal(sql.includes("raise exception 'organization_type_immutable'"), true)
  assert.equal(sql.includes('grant execute on function public.update_my_cloud_organization_name(text) to authenticated'), true)
})

testBackendSourceContract('agent approval organization migration creates or reuses orgs and blocks duplicate requests', () => {
  const sql = read('supabase/migrations/202605210002_agent_approval_org_idempotency.sql')

  assert.equal(sql.includes('create or replace function public.submit_platform_organization_opening_request'), true)
  assert.equal(sql.includes("r.status in ('pending_review', 'approved')"), true)
  assert.equal(sql.includes("raise exception 'organization_opening_request_exists'"), true)
  assert.equal(sql.includes("raise exception 'organization_already_exists'"), true)
  assert.equal(sql.includes('create or replace function public.review_platform_organization_opening_request'), true)
  assert.equal(sql.includes('pg_advisory_xact_lock'), true)
  assert.equal(sql.includes('where lower(email) = lower(v_request.owner_email)'), true)
  assert.equal(sql.includes('insert into public.cloud_organizations (owner_id, name, organization_type_id, agent_id, opening_request_id)'), true)
  assert.equal(sql.includes('set organization_id = v_org.id'), true)
  assert.equal(sql.includes('create or replace function public.ensure_cloud_organization'), true)
  assert.equal(sql.includes("and r.status = 'approved'"), true)
  assert.equal(sql.includes('for update'), true)
})

test('requestCloudAiEmployeeCreation submits a pending request for the current members profile', async () => {
  const fake = createFakeSupabase({
    'rpc:request_cloud_ai_employee_creation': {
      data: {
        id: 'request-1',
        openclaw_profile: 'alice',
        requested_name: '客服小云',
        requested_role: '客服员工',
        status: 'pending',
      },
      error: null,
    },
  })

  const request = await requestCloudAiEmployeeCreation(fake.client, 'alice-user', {
    name: '客服小云',
    role: '客服员工',
    description: '处理售后问题',
    emoji: '☁️',
    model: 'openai/gpt-5.4',
  })

  assert.equal(request.id, 'request-1')
  assert.equal(request.name, '客服小云')
  assert.equal(request.status, 'pending')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'request_cloud_ai_employee_creation',
      args: {
        p_name: '客服小云',
        p_role: '客服员工',
        p_description: '处理售后问题',
        p_emoji: '☁️',
        p_default_model: 'openai/gpt-5.4',
      },
    },
  ])
})

test('listMyCloudAiEmployeeRequests reads pending requests visible to the current user', async () => {
  const fake = createFakeSupabase({
    'rpc:list_my_cloud_ai_employee_requests': {
      data: [
        {
          id: 'request-1',
          requested_name: '客服小云',
          requested_role: '客服员工',
          requested_description: '处理售后问题',
          requested_emoji: '☁️',
          requested_default_model: 'openai/gpt-5.4',
          status: 'pending',
        },
      ],
      error: null,
    },
  })

  const requests = await listMyCloudAiEmployeeRequests(fake.client, 'owner-1')

  assert.equal(requests[0].name, '客服小云')
  assert.equal(requests[0].role, '客服员工')
  assert.equal(requests[0].default_model, 'openai/gpt-5.4')
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'list_my_cloud_ai_employee_requests', args: {} },
  ])
})

test('approveCloudAiEmployeeCreationRequest links a request to a real Uniopc 引擎 agent snapshot', async () => {
  const fake = createFakeSupabase({
    'rpc:approve_cloud_ai_employee_creation_request': {
      data: {
        id: 'request-1',
        status: 'approved',
        openclaw_agent_id: 'support',
        cloud_employee_id: 'cloud-employee-1',
      },
      error: null,
    },
  })

  const request = await approveCloudAiEmployeeCreationRequest(fake.client, 'owner-1', {
    requestId: 'request-1',
    cloudEmployeeId: 'cloud-employee-1',
    openclawAgentId: 'support',
  })

  assert.equal(request.status, 'approved')
  assert.equal(request.openclaw_agent_id, 'support')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'approve_cloud_ai_employee_creation_request',
      args: {
        p_request_id: 'request-1',
        p_cloud_employee_id: 'cloud-employee-1',
        p_openclaw_agent_id: 'support',
        p_failure_message: null,
      },
    },
  ])
})

test('createMemberOpenClawProfile lets an admin assign exactly one profile to a member', async () => {
  const fake = createFakeSupabase({
    'rpc:create_member_openclaw_profile': {
      data: [{
        organization_id: 'org-1',
        organization_name: 'Acme',
        member_id: 'member-2',
        member_role: 'member',
        openclaw_profile: 'alice',
        profile_status: 'active',
      }],
      error: null,
    },
  })

  const result = await createMemberOpenClawProfile(fake.client, 'owner-1', 'member-2', {
    profile: ' Alice ',
  })

  assert.equal(result.memberId, 'member-2')
  assert.equal(result.openclawProfile, 'alice')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'create_member_openclaw_profile',
      args: {
        p_member_id: 'member-2',
        p_profile_key: 'alice',
        p_runtime_mode: 'member_local',
      },
    },
  ])
})

test('buildMemberOpenClawProfileKey uses readable member text plus stable member id suffix', () => {
  assert.equal(
    buildMemberOpenClawProfileKey({
      memberId: '6ccfa8c9-0832-4db9-a7cb-4de41f12c345',
      memberEmail: 'EurisBlue@example.com',
      displayName: 'Euris',
    }),
    'eurisblue-6ccfa8c9',
  )
  assert.equal(
    buildMemberOpenClawProfileKey({
      memberId: '83e28a1d-7cab-4878-b5e1-53a0474d99f0',
      memberEmail: 'EurisBlue@example.com',
      displayName: 'Euris',
    }),
    'eurisblue-83e28a1d',
  )
})

test('createMemberOpenClawProfile sends stable generated key when profile input is omitted', async () => {
  const fake = createFakeSupabase({
    'rpc:create_member_openclaw_profile': {
      data: [{
        organization_id: 'org-1',
        organization_name: 'Acme',
        member_id: '6ccfa8c9-0832-4db9-a7cb-4de41f12c345',
        member_role: 'member',
        openclaw_profile_id: 'profile-1',
        openclaw_profile: 'eurisblue-6ccfa8c9',
        profile_status: 'active',
      }],
      error: null,
    },
  })

  const result = await createMemberOpenClawProfile(
    fake.client,
    'owner-1',
    '6ccfa8c9-0832-4db9-a7cb-4de41f12c345',
    { memberEmail: 'EurisBlue@example.com', displayName: 'Euris' },
  )

  assert.equal(result.openclawProfileId, 'profile-1')
  assert.equal(result.openclawProfile, 'eurisblue-6ccfa8c9')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'create_member_openclaw_profile',
      args: {
        p_member_id: '6ccfa8c9-0832-4db9-a7cb-4de41f12c345',
        p_profile_key: 'eurisblue-6ccfa8c9',
        p_runtime_mode: 'member_local',
      },
    },
  ])
})

test('createMemberOpenClawProfile sends selected runtime mode', async () => {
  const fake = createFakeSupabase({
    'rpc:create_member_openclaw_profile': {
      data: {
        organization_id: 'org-1',
        organization_name: 'Acme',
        member_id: 'member-alice',
        member_role: 'member',
        openclaw_profile_id: 'profile-alice',
        openclaw_profile: 'alice',
        profile_status: 'active',
        runtime_mode: 'member_local',
      },
      error: null,
    },
  })

  const row = await createMemberOpenClawProfile(fake.client, 'owner-1', 'member-alice', {
    profile: 'alice',
    runtimeMode: 'member_local',
  })

  assert.equal(row.runtimeMode, 'member_local')
  assert.deepEqual(fake.calls, [{
    op: 'rpc',
    name: 'create_member_openclaw_profile',
    args: {
      p_member_id: 'member-alice',
      p_profile_key: 'alice',
      p_runtime_mode: 'member_local',
    },
  }])
})

test('registerOpenClawProfileHost records host provisioning status for any profile', async () => {
  const fake = createFakeSupabase({
    'rpc:register_openclaw_profile_host': {
      data: {
        openclaw_profile_id: 'profile-1',
        openclaw_profile: 'alice',
        runtime_mode: 'member_local',
        gateway_status: 'online',
        gateway_status_message: 'ready',
        gateway_port: 18845,
        gateway_url: 'ws://127.0.0.1:18845',
      },
      error: null,
    },
  })

  const result = await registerOpenClawProfileHost(fake.client, 'owner-1', {
    openclawProfileId: 'profile-1',
    hostName: 'alice-mac',
    gatewayPort: 18845,
    gatewayUrl: 'ws://127.0.0.1:18845',
    gatewayStatus: 'online',
    statusMessage: 'ready',
  })

  assert.equal(result.runtimeMode, 'member_local')
  assert.equal(result.gatewayStatus, 'online')
  assert.equal(result.gatewayUrl, 'ws://127.0.0.1:18845')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'register_openclaw_profile_host',
      args: {
        p_openclaw_profile_id: 'profile-1',
        p_host_name: 'alice-mac',
        p_gateway_port: 18845,
        p_gateway_url: 'ws://127.0.0.1:18845',
        p_gateway_status: 'online',
        p_status_message: 'ready',
      },
    },
  ])
})

testBackendSourceContract('owner host status reconciliation migration preserves offline and records status message', () => {
  const sql = read('supabase/migrations/202605180730_owner_host_profile_status_reconcile.sql')

  assert.equal(sql.includes('register_owner_openclaw_profile_host'), true)
  assert.equal(sql.includes('#variable_conflict use_column'), true)
  assert.equal(sql.includes('on conflict (organization_id, owner_id, (lower(host_name)))'), true)
  assert.equal(sql.includes('p_status_message text default null'), true)
  assert.equal(sql.includes('gateway_status_message'), true)
  assert.equal(sql.includes('get_my_cloud_workspace_profile'), true)
  assert.equal(sql.includes('host_status text'), true)
  assert.equal(sql.includes("when v_gateway_status = 'online' then 'online'"), true)
  assert.equal(sql.includes("when v_gateway_status = 'degraded' then 'degraded'"), true)
  assert.equal(sql.includes("else 'offline'"), true)
})

testBackendSourceContract('workspace profile migration requires an active Uniopc admin grant before auto-provisioning owners', () => {
  const sql = read('supabase/migrations/202605200001_imai_admin_account_opening_gate.sql')

  assert.equal(sql.includes('imai_admin_accounts'), true)
  assert.equal(sql.includes('ensure_imai_admin_account_opened'), true)
  assert.equal(sql.includes("'imai_admin_not_found'::text as profile_status"), true)
  assert.equal(sql.includes('from public.ensure_cloud_organization(null) e'), true)
})

test('getMyOpenClawProfilePairingSetup reads the current members one-time Uniopc 引擎 setup code', async () => {
  const fake = createFakeSupabase({
    'rpc:get_my_openclaw_profile_pairing_setup': {
      data: {
        openclaw_profile_id: 'profile-1',
        openclaw_profile: 'eurisblue',
        setup_code: 'setup-code-1',
        gateway_url: 'wss://owner.example.ts.net',
        pairing_status: 'pending_member',
        expires_at: '2026-05-18T08:00:00.000Z',
      },
      error: null,
    },
  })

  const result = await getMyOpenClawProfilePairingSetup(fake.client, 'member-1')

  assert.equal(result.openclawProfile, 'eurisblue')
  assert.equal(result.setupCode, 'setup-code-1')
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'get_my_openclaw_profile_pairing_setup', args: {} },
  ])
})

testBackendSourceContract('pairing setup migration uses RLS-friendly RPC handoff and does not persist device tokens', () => {
  const sql = read('supabase/migrations/202605180700_openclaw_profile_pairing_setups.sql')
  const restrictionSql = read('supabase/migrations/202605180815_restrict_openclaw_pairing_setups_to_members.sql')

  assert.equal(sql.includes('cloud_openclaw_profile_pairing_setups'), true)
  assert.equal(sql.includes('setup_code text not null'), true)
  assert.equal(sql.includes('publish_openclaw_profile_pairing_setup'), true)
  assert.equal(sql.includes('get_my_openclaw_profile_pairing_setup'), true)
  assert.equal(sql.includes('device_token'), false)
  assert.equal(sql.includes('on conflict (openclaw_profile_id)'), false)
  assert.equal(restrictionSql.includes('on conflict (openclaw_profile_id)'), false)
  assert.equal(restrictionSql.includes('update public.cloud_openclaw_profile_pairing_setups as s'), true)
  assert.equal(restrictionSql.includes("v_member.member_role <> 'member'"), true)
  assert.equal(restrictionSql.includes('pairing_setup_only_allowed_for_members'), true)
})

test('listCloudOrganizationMembers maps members with their profile state for admin pages', async () => {
  const fake = createFakeSupabase({
    'rpc:list_cloud_organization_members': {
      data: [
        {
          organization_id: 'org-1',
          member_id: 'member-owner',
          user_id: 'owner-1',
          member_email: 'owner@example.com',
          display_name: 'Owner',
          member_role: 'owner',
          invite_status: 'registered',
          openclaw_profile: 'imai',
          profile_status: 'active',
        },
        {
          organization_id: 'org-1',
          member_id: 'member-2',
          user_id: null,
          member_email: 'alice@example.com',
          display_name: 'Alice',
          member_role: 'member',
          invite_status: 'pending_registration',
          openclaw_profile: '',
          profile_status: 'missing',
        },
      ],
      error: null,
    },
  })

  const rows = await listCloudOrganizationMembers(fake.client, 'owner-1')

  assert.deepEqual(rows.map(item => [item.id, item.name, item.memberRole, item.openclawProfile, item.profileStatus]), [
    ['member-owner', 'Owner', 'owner', 'imai', 'active'],
    ['member-2', 'Alice', 'member', '', 'missing'],
  ])
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'list_cloud_organization_members', args: {} },
  ])
})

test('inviteCloudOrganizationMember invites a human into the current organization', async () => {
  const fake = createFakeSupabase({
    'rpc:invite_cloud_organization_member': {
      data: [{
        organization_id: 'org-1',
        member_id: 'member-2',
        member_email: 'alice@example.com',
        display_name: 'Alice',
        member_role: 'member',
        invite_status: 'pending_registration',
        openclaw_profile: '',
        profile_status: 'missing',
      }],
      error: null,
    },
  })

  const row = await inviteCloudOrganizationMember(fake.client, 'owner-1', {
    name: ' Alice ',
    email: ' Alice@Example.com ',
  })

  assert.equal(row.id, 'member-2')
  assert.equal(row.memberEmail, 'alice@example.com')
  assert.equal(row.statusLabel, '待注册')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'invite_cloud_organization_member',
      args: {
        p_email: 'alice@example.com',
        p_name: 'Alice',
        p_runtime_mode: 'member_local',
      },
    },
  ])
})

test('inviteCloudOrganizationMember sends selected member runtime mode', async () => {
  const fake = createFakeSupabase({
    'rpc:invite_cloud_organization_member': {
      data: {
        organization_id: 'org-1',
        organization_name: 'Acme',
        member_id: 'member-alice',
        member_email: 'alice@example.com',
        display_name: 'Alice',
        member_role: 'member',
        invite_status: 'pending_registration',
        openclaw_profile_id: 'profile-alice',
        openclaw_profile: 'alice',
        profile_status: 'active',
        runtime_mode: 'member_local',
      },
      error: null,
    },
  })

  const row = await inviteCloudOrganizationMember(fake.client, 'owner-1', {
    email: ' Alice@Example.com ',
    name: ' Alice ',
    runtimeMode: 'member_local',
  })

  assert.equal(row.runtimeMode, 'member_local')
  assert.deepEqual(fake.calls, [{
    op: 'rpc',
    name: 'invite_cloud_organization_member',
    args: {
      p_email: 'alice@example.com',
      p_name: 'Alice',
      p_runtime_mode: 'member_local',
    },
  }])
})

test('addCloudProjectEmployee snapshots an Uniopc 引擎 employee and links it to a cloud project', async () => {
  const fake = createFakeSupabase({
    'cloud_employees:single': {
      data: {
        id: 'cloud-employee-1',
        owner_id: 'user-1',
        organization_id: 'org-1',
        organization_member_id: 'member-owner',
        openclaw_profile_id: 'profile-1',
        openclaw_profile: 'imai',
        openclaw_agent_id: 'agent-1',
        name: 'Researcher',
        role: 'Analyst',
      },
      error: null,
    },
    'cloud_project_members:single': {
      data: {
        id: 'member-1',
        project_id: 'project-1',
        cloud_employee_id: 'cloud-employee-1',
      },
      error: null,
    },
  })

  const row = await addCloudProjectEmployee(fake.client, 'user-1', 'project-1', {
    id: 'agent-1',
    name: ' Researcher ',
    role: ' Analyst ',
    description: ' Reads market docs ',
    emoji: 'R',
    default_model: 'openai-codex/gpt-5.5',
    status: 'active',
  }, 'imai')

  assert.equal(row.cloud_employee_id, 'cloud-employee-1')
  assert.deepEqual(fake.calls, [
    {
      table: 'cloud_employees',
      op: 'upsert',
      payload: {
        owner_id: 'user-1',
        openclaw_profile: 'imai',
        openclaw_agent_id: 'agent-1',
        name: 'Researcher',
        role: 'Analyst',
        description: 'Reads market docs',
        emoji: 'R',
        default_model: 'openai-codex/gpt-5.5',
        status: 'active',
      },
      options: { onConflict: 'owner_id,openclaw_profile,openclaw_agent_id' },
    },
    { table: 'cloud_employees', op: 'select', columns: '*' },
    {
      table: 'cloud_project_members',
      op: 'upsert',
      payload: {
        owner_id: 'user-1',
        project_id: 'project-1',
        member_type: 'ai_employee',
        member_user_id: null,
        cloud_employee_id: 'cloud-employee-1',
        organization_id: 'org-1',
        organization_member_id: 'member-owner',
        openclaw_profile_id: 'profile-1',
        openclaw_profile: 'imai',
        openclaw_agent_id: 'agent-1',
        member_name: 'Researcher',
        member_role: 'ai_employee',
        access_level: 'write',
      },
      options: { onConflict: 'project_id,cloud_employee_id' },
    },
    { table: 'cloud_project_members', op: 'select', columns: '*' },
  ])
})

test('listCloudProjectEmployees returns project AI members with employee snapshots', async () => {
  const fake = createFakeSupabase({
    'cloud_project_members:list': {
      data: [
        {
          id: 'member-1',
          cloud_employee_id: 'cloud-employee-1',
          openclaw_agent_id: 'agent-1',
          created_at: '2026-05-17T00:00:00Z',
        },
      ],
      error: null,
    },
    'rpc:list_my_cloud_ai_employees': {
      data: [
        {
          id: 'cloud-employee-1',
          openclaw_profile: 'imai',
          openclaw_agent_id: 'agent-1',
          name: 'Researcher',
          role: 'Analyst',
        },
      ],
      error: null,
    },
  })

  const rows = await listCloudProjectEmployees(fake.client, 'user-1', 'project-1')

  assert.equal(rows[0].id, 'member-1')
  assert.equal(rows[0].cloud_employee_id, 'cloud-employee-1')
  assert.equal(rows[0].openclaw_agent_id, 'agent-1')
  assert.equal(rows[0].name, 'Researcher')
  assert.equal(rows[0].role, 'Analyst')
  assert.equal(rows[0].employee.id, 'agent-1')
  assert.equal(rows[0].employee.cloud_employee_id, 'cloud-employee-1')
  assert.equal(rows[0].employee.openclaw_agent_id, 'agent-1')
  assert.equal(rows[0].employee.name, 'Researcher')
  assert.equal(rows[0].employee.role, 'Analyst')
  assert.deepEqual(fake.calls, [
    { table: 'cloud_project_members', op: 'select', columns: '*' },
    { table: 'cloud_project_members', op: 'eq', column: 'project_id', value: 'project-1' },
    { table: 'cloud_project_members', op: 'eq', column: 'member_type', value: 'ai_employee' },
    { table: 'cloud_project_members', op: 'order', column: 'created_at', options: { ascending: true } },
    { op: 'rpc', name: 'list_my_cloud_ai_employees', args: {} },
  ])
})

test('listCloudProjectEmployees does not fallback match same agent id across Uniopc 引擎 profiles', async () => {
  const fake = createFakeSupabase({
    'cloud_project_members:list': {
      data: [
        {
          id: 'member-1',
          cloud_employee_id: 'cloud-bob-main',
          openclaw_profile: 'bob',
          openclaw_agent_id: 'main',
          created_at: '2026-05-17T00:00:00Z',
        },
      ],
      error: null,
    },
    'rpc:list_my_cloud_ai_employees': {
      data: [
        {
          id: 'cloud-alice-main',
          openclaw_profile: 'alice',
          openclaw_agent_id: 'main',
          name: 'Alice Main',
        },
      ],
      error: null,
    },
  })

  const rows = await listCloudProjectEmployees(fake.client, 'alice-user', 'project-1')

  assert.equal(rows[0].employee, null)
  assert.equal(rows[0].openclaw_profile, 'bob')
  assert.equal(rows[0].name, 'main')
})

test('listCloudProjectEmployees avoids direct cloud_employees Data API lookups', async () => {
  const fake = createFakeSupabase({
    'cloud_project_members:list': {
      data: [
        {
          id: 'member-1',
          cloud_employee_id: 'cloud-employee-1',
          openclaw_agent_id: 'agent-1',
          created_at: '2026-05-17T00:00:00Z',
        },
      ],
      error: null,
    },
    'rpc:list_my_cloud_ai_employees': {
      data: [],
      error: null,
    },
  })

  await listCloudProjectEmployees(fake.client, 'user-1', 'project-1')

  assert.equal(fake.calls.some(call => call.table === 'cloud_employees' && call.op === 'select'), false)
})

testBackendSourceContract('project AI visibility migration lets project readers see attached AI snapshots', () => {
  const source = read('supabase/migrations/202605191230_project_ai_visible_to_project_members.sql')

  assert.equal(source.includes('cloud_employees_project_member_select'), true)
  assert.equal(source.includes('private.can_read_cloud_project(cpm.project_id)'), true)
  assert.equal(source.includes('cpm.cloud_employee_id = cloud_employees.id'), true)
})

testBackendSourceContract('cloud AI employee sync migration reconciles Gateway agents into cloud_employees', () => {
  const source = read('supabase/migrations/202605250003_sync_cloud_ai_employees.sql')

  assert.equal(source.includes('create or replace function public.sync_my_cloud_ai_employees'), true)
  assert.equal(source.includes('jsonb_to_recordset'), true)
  assert.equal(
    source.includes('on conflict on constraint cloud_employees_owner_id_openclaw_profile_openclaw_agent_id_key'),
    true,
  )
  assert.equal(source.includes("runtime_status = 'offline'"), true)
})

testBackendSourceContract('cloud project creation migration uses an authenticated workspace RPC', () => {
  const source = read('supabase/migrations/20260526015545_create_cloud_project_rpc.sql')

  assert.equal(source.includes('create or replace function public.create_cloud_project'), true)
  assert.equal(source.includes('v_user uuid := auth.uid()'), true)
  assert.equal(source.includes('public.refresh_registered_human_invites()'), true)
  assert.equal(source.includes('insert into public.cloud_projects'), true)
  assert.equal(source.includes('v_member.organization_id'), true)
  assert.equal(source.includes('grant execute on function public.create_cloud_project(text, text) to authenticated'), true)
})

test('removeCloudProjectEmployee deletes only the requested cloud AI member', async () => {
  const fake = createFakeSupabase()

  await removeCloudProjectEmployee(fake.client, 'user-1', 'project-1', 'agent-1')

  assert.deepEqual(fake.calls, [
    { table: 'cloud_project_members', op: 'delete' },
    { table: 'cloud_project_members', op: 'eq', column: 'owner_id', value: 'user-1' },
    { table: 'cloud_project_members', op: 'eq', column: 'project_id', value: 'project-1' },
    { table: 'cloud_project_members', op: 'eq', column: 'member_type', value: 'ai_employee' },
    { table: 'cloud_project_members', op: 'eq', column: 'openclaw_agent_id', value: 'agent-1' },
  ])
})

test('removeCloudProjectEmployee can constrain deletion to the active Uniopc 引擎 profile', async () => {
  const fake = createFakeSupabase()

  await removeCloudProjectEmployee(fake.client, 'user-1', 'project-1', 'agent-1', {
    openclawProfile: 'alice',
  })

  assert.deepEqual(fake.calls, [
    { table: 'cloud_project_members', op: 'delete' },
    { table: 'cloud_project_members', op: 'eq', column: 'owner_id', value: 'user-1' },
    { table: 'cloud_project_members', op: 'eq', column: 'project_id', value: 'project-1' },
    { table: 'cloud_project_members', op: 'eq', column: 'member_type', value: 'ai_employee' },
    { table: 'cloud_project_members', op: 'eq', column: 'openclaw_agent_id', value: 'agent-1' },
    { table: 'cloud_project_members', op: 'eq', column: 'openclaw_profile', value: 'alice' },
  ])
})

test('addCloudProjectPerson stores a pending human member by email', async () => {
  const fake = createFakeSupabase({
    'rpc:add_cloud_project_human_member': {
      data: { id: 'member-1', member_email: 'teammate@example.com', invite_status: 'pending_registration' },
      error: null,
    },
  })

  await addCloudProjectPerson(fake.client, 'user-1', 'project-1', {
    name: ' Teammate ',
    email: ' Teammate@Example.com ',
  })

  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'add_cloud_project_human_member',
      args: {
        p_project_id: 'project-1',
        p_email: 'teammate@example.com',
        p_name: 'Teammate',
      },
    },
  ])
})

test.skip('retired human employee invitation', async () => {
  const fake = createFakeSupabase({
    'rpc:invite_cloud_human_employee': {
      data: {
        id: 'human-1',
        member_email: 'alice@example.com',
        member_name: 'Alice',
        member_user_id: 'profile-1',
        invite_status: 'registered',
      },
      error: null,
    },
  })

  const row = await inviteCloudHumanEmployee(fake.client, 'user-1', {
    name: ' Alice ',
    email: ' Alice@Example.com ',
  })

  assert.equal(row.statusLabel, '已注册')
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'invite_cloud_human_employee',
      args: {
        p_email: 'alice@example.com',
        p_name: 'Alice',
      },
    },
  ])
})

test.skip('retired human employee directory', async () => {
  const fake = createFakeSupabase({
    'rpc:list_cloud_human_employees': {
      data: [
        { id: 'human-1', member_name: 'Alice', member_email: 'alice@example.com', member_user_id: 'profile-1', invite_status: 'registered', direction: 'outgoing', avatar_url: 'https://example.com/alice.png' },
        { id: 'human-2', member_name: '', member_email: 'owner@example.com', member_user_id: 'user-1', invite_status: 'registered', counterpart_name: 'Owner', direction: 'incoming' },
        { id: 'human-3', member_name: 'Boo', member_email: 'bootiful.wtf@gmail.com', member_user_id: 'profile-3', invite_status: 'registered', direction: 'outgoing' },
      ],
      error: null,
    },
  })

  const rows = await listCloudHumanEmployees(fake.client, 'user-1')

  assert.deepEqual(rows.map(item => [item.id, item.name, item.statusLabel, item.avatarUrl || '']), [
    ['human-1', 'Alice', '已注册', 'https://example.com/alice.png'],
    ['human-2', 'Owner', '已注册', ''],
    ['human-3', 'Boo', '已注册', ''],
  ])
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'list_cloud_human_employees', args: {} },
  ])
})

test('cloud workspace frontend does not query profiles directly for human display data', () => {
  const source = read('src/lib/cloudWorkspace.js')

  assert.equal(source.includes(".from('profiles')"), false)
  assert.equal(source.includes('loadProfileDisplayMap'), false)
})

test.skip('retired human conversation creation', async () => {
  const fake = createFakeSupabase({
    'rpc:ensure_cloud_human_conversation': {
      data: { id: 'conversation-1', human_employee_id: 'human-1' },
      error: null,
    },
  })

  const row = await ensureCloudHumanConversation(fake.client, 'user-1', 'human-1')

  assert.equal(row.id, 'conversation-1')
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'ensure_cloud_human_conversation', args: { p_human_employee_id: 'human-1' } },
  ])
})

test.skip('retired human message listing', async () => {
  const fake = createFakeSupabase({
    'rpc:ensure_cloud_human_conversation': {
      data: { id: 'conversation-1', human_employee_id: 'human-1' },
      error: null,
    },
    'cloud_human_messages:list': {
      data: [
        { id: 'msg-1', conversation_id: 'conversation-1', sender_user_id: 'user-1', sender_name: 'Lan', content: 'Hi', attachments: [], created_at: '2026-05-17T00:00:00Z' },
        { id: 'msg-2', conversation_id: 'conversation-1', sender_user_id: 'user-2', sender_name: 'Alice', content: 'Hello', attachments: [], created_at: '2026-05-17T00:01:00Z' },
      ],
      error: null,
    },
  })

  const result = await listCloudHumanMessages(fake.client, 'user-1', 'human-1')

  assert.equal(result.conversation.id, 'conversation-1')
  assert.deepEqual(result.messages.map(item => [item.id, item.role, item.content, item.senderName]), [
    ['msg-1', 'user', 'Hi', 'Lan'],
    ['msg-2', 'assistant', 'Hello', 'Alice'],
  ])
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'ensure_cloud_human_conversation', args: { p_human_employee_id: 'human-1' } },
    { table: 'cloud_human_messages', op: 'select', columns: '*' },
    { table: 'cloud_human_messages', op: 'eq', column: 'conversation_id', value: 'conversation-1' },
    { table: 'cloud_human_messages', op: 'order', column: 'created_at', options: { ascending: true } },
  ])
})

test.skip('retired human message display names', async () => {
  const fake = createFakeSupabase({
    'rpc:ensure_cloud_human_conversation': {
      data: { id: 'conversation-1', human_employee_id: 'human-1' },
      error: null,
    },
    'cloud_human_messages:list': {
      data: [
        {
          id: 'msg-1',
          conversation_id: 'conversation-1',
          sender_user_id: 'profile-3',
          sender_name: 'Boo',
          content: 'hello',
          attachments: [],
          created_at: '2026-05-17T00:01:00Z',
        },
      ],
      error: null,
    },
  })

  const result = await listCloudHumanMessages(fake.client, 'user-1', 'human-1')

  assert.equal(result.messages[0].senderName, 'Boo')
  assert.deepEqual(fake.calls, [
    { op: 'rpc', name: 'ensure_cloud_human_conversation', args: { p_human_employee_id: 'human-1' } },
    { table: 'cloud_human_messages', op: 'select', columns: '*' },
    { table: 'cloud_human_messages', op: 'eq', column: 'conversation_id', value: 'conversation-1' },
    { table: 'cloud_human_messages', op: 'order', column: 'created_at', options: { ascending: true } },
  ])
})

test.skip('retired human message sender mapping', async () => {
  const fake = createFakeSupabase({
    'rpc:ensure_cloud_human_conversation': {
      data: { id: 'conversation-1', human_employee_id: 'human-1' },
      error: null,
    },
    'cloud_human_messages:list': {
      data: [
        { id: 'msg-1', conversation_id: 'conversation-1', sender_user_id: 'remote-user-id', sender_name: 'eurisblue@gmail.com', content: 'hey', attachments: [], created_at: '2026-05-17T00:00:00Z' },
        { id: 'msg-2', conversation_id: 'conversation-1', sender_user_id: 'other-user-id', sender_name: 'Bootiful', content: 'hi', attachments: [], created_at: '2026-05-17T00:01:00Z' },
      ],
      error: null,
    },
  })

  const result = await listCloudHumanMessages(fake.client, 'local-user-id', 'human-1', {
    uid: 'local-user-id',
    email: 'eurisblue@gmail.com',
  })

  assert.deepEqual(result.messages.map(item => [item.id, item.role, item.senderName]), [
    ['msg-1', 'user', 'eurisblue@gmail.com'],
    ['msg-2', 'assistant', 'Bootiful'],
  ])
})

test.skip('retired human message sending', async () => {
  const fake = createFakeSupabase({
    'rpc:send_cloud_human_message': {
      data: { id: 'msg-1', sender_user_id: 'user-1', sender_name: 'Lan', content: 'Hi', attachments: [{ id: 'img-1' }], created_at: '2026-05-17T00:00:00Z' },
      error: null,
    },
  })

  const message = await sendCloudHumanMessage(fake.client, 'user-1', 'human-1', {
    content: ' Hi ',
    attachments: [{ id: 'img-1' }],
  })

  assert.deepEqual([message.id, message.role, message.content], ['msg-1', 'user', 'Hi'])
  assert.deepEqual(fake.calls, [
    {
      op: 'rpc',
      name: 'send_cloud_human_message',
      args: {
        p_human_employee_id: 'human-1',
        p_content: 'Hi',
        p_attachments: [{ id: 'img-1' }],
      },
    },
  ])
})

test.skip('retired human invitation mail', () => {
  const registered = buildHumanInviteMailto({
    email: 'alice@example.com',
    name: 'Alice',
    invite_status: 'registered',
  }, {
    inviterName: 'Lan',
    appUrl: 'https://imai.example.com',
  })
  const pending = buildHumanInviteMailto({
    email: 'bob@example.com',
    name: 'Bob',
    invite_status: 'pending_registration',
  }, {
    inviterName: 'Lan',
    appUrl: 'https://imai.example.com',
  })

  assert.match(registered, /^mailto:alice%40example\.com\?/)
  assert.match(decodeURIComponent(registered), /登录 Uniopc/)
  assert.match(decodeURIComponent(pending), /注册或登录 Uniopc/)
})

test('listCloudProjectPeople reads pending human members', async () => {
  const fake = createFakeSupabase({
    'cloud_project_members:list': {
      data: [{ id: 'member-1', member_name: 'Teammate', member_email: 'teammate@example.com' }],
      error: null,
    },
  })

  const rows = await listCloudProjectPeople(fake.client, 'user-1', 'project-1')

  assert.deepEqual(rows, [
    {
      id: 'member-1',
      member_name: 'Teammate',
      member_email: 'teammate@example.com',
      name: 'Teammate',
      role: '成员',
      type: 'human',
      source: 'human',
      invite_status: 'pending_registration',
      status: 'pending_registration',
      statusLabel: '待注册',
    },
  ])
  assert.deepEqual(fake.calls, [
    { table: 'cloud_project_members', op: 'select', columns: '*' },
    { table: 'cloud_project_members', op: 'eq', column: 'project_id', value: 'project-1' },
    { table: 'cloud_project_members', op: 'eq', column: 'member_type', value: 'user' },
    { table: 'cloud_project_members', op: 'order', column: 'created_at', options: { ascending: true } },
  ])
})

test('mergeProjectPeopleWithOwner shows the current user as the project owner', () => {
  const rows = mergeProjectPeopleWithOwner([
    { id: 'member-1', member_email: 'alice@example.com', name: 'Alice', role: '成员' },
  ], {
    uid: 'owner-1',
    displayName: 'Lan',
    email: 'lan@example.com',
  })

  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 'owner-1')
  assert.equal(rows[0].member_user_id, 'owner-1')
  assert.equal(rows[0].member_email, 'lan@example.com')
  assert.equal(rows[0].name, 'Lan')
  assert.equal(rows[0].role, '所有者')
  assert.equal(rows[0].is_project_owner, true)
  assert.equal(rows[1].name, 'Alice')
})

test('mergeProjectPeopleWithOwner does not duplicate the owner when Supabase returns one', () => {
  const rows = mergeProjectPeopleWithOwner([
    { id: 'member-owner', member_user_id: 'owner-1', member_email: 'lan@example.com', name: 'Lan Row' },
    { id: 'member-1', member_email: 'alice@example.com', name: 'Alice' },
  ], {
    uid: 'owner-1',
    displayName: 'Lan',
    email: 'lan@example.com',
  })

  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 'owner-1')
  assert.equal(rows[0].role, '所有者')
  assert.equal(rows[1].id, 'member-1')
})

test('mergeProjectPeopleWithOwner uses the real project owner instead of the current viewer', () => {
  const rows = mergeProjectPeopleWithOwner([
    { id: 'member-1', member_user_id: 'member-1', member_email: 'alice@example.com', name: 'Alice', role: '成员' },
  ], {
    uid: 'member-1',
    displayName: 'Alice',
    email: 'alice@example.com',
  }, {
    userId: 'owner-1',
    name: 'Lan',
    memberEmail: 'lan@example.com',
  })

  assert.equal(rows.length, 2)
  assert.equal(rows[0].member_user_id, 'owner-1')
  assert.equal(rows[0].name, 'Lan')
  assert.equal(rows[0].role, '所有者')
  assert.equal(rows[1].member_user_id, 'member-1')
  assert.equal(rows[1].name, 'Alice')
})

test('mergeProjectPeopleWithOwner deduplicates organization owner against project member user id', () => {
  const rows = mergeProjectPeopleWithOwner([
    { id: 'project-owner-row', member_user_id: 'owner-user-1', member_email: '', name: 'Lan Row', role: '所有者' },
    { id: 'member-1', member_user_id: 'member-user-1', member_email: 'alice@example.com', name: 'Alice', role: '成员' },
  ], {
    uid: 'member-user-1',
    displayName: 'Alice',
    email: 'alice@example.com',
  }, {
    id: 'organization-member-1',
    userId: 'owner-user-1',
    name: 'Lan',
    memberEmail: 'lan@example.com',
  })

  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 'owner-user-1')
  assert.equal(rows[0].member_user_id, 'owner-user-1')
  assert.equal(rows[0].name, 'Lan')
  assert.equal(rows[1].id, 'member-1')
})

test('removeCloudProjectMember deletes one project member by id', async () => {
  const fake = createFakeSupabase()

  await removeCloudProjectMember(fake.client, 'user-1', 'member-1')

  assert.deepEqual(fake.calls, [
    { table: 'cloud_project_members', op: 'delete' },
    { table: 'cloud_project_members', op: 'eq', column: 'id', value: 'member-1' },
    { table: 'cloud_project_members', op: 'eq', column: 'owner_id', value: 'user-1' },
  ])
})
