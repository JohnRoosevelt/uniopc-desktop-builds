import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as bootstrapModule from './bootstrap-openclaw-release-validation.mjs'

const {
  bootstrapReleaseValidation,
  createReleaseValidationInput,
  writeFixtureEnvironment,
} = bootstrapModule

const execFileAsync = promisify(execFile)

const input = {
  email: 'release-validation@example.invalid',
  organizationSlug: 'openclaw-release-validation',
  expectedModel: 'openai/gpt-5.6',
  expectedModelLabel: 'GPT 5.6',
  password: 'generated-test-password',
  failurePrompt: 'controlled upstream failure',
  failureExpectedText: 'upstream unavailable',
  localWorkspacePrompt: 'list the local workspace',
}

function freshApi() {
  const state = {
    user: null,
    organization: null,
    createdOrganizations: [],
    mutations: [],
  }
  return {
    ...state,
    get user() { return state.user },
    async findValidationUser() {
      return state.user
    },
    async ensureValidationUser({ email, password, marker, organizationSlug }) {
      state.user ??= { id: 'validation-user', email, password, marker, organizationSlug }
      return state.user
    },
    async findValidationOrganization() {
      return state.organization
    },
    async ensureMarkedOrganization({ slug, marker, ownerUserId }) {
      assert.equal(ownerUserId, 'validation-user')
      if (state.organization) return state.organization
      state.organization = { id: 'validation-org', slug, marker, ownerUserId }
      state.createdOrganizations.push(state.organization)
      return state.organization
    },
    async ensureOpenClawProfile({ organizationId, name }) {
      state.mutations.push('profile')
      assert.equal(organizationId, 'validation-org')
      return { name }
    },
    async ensureAgent({ profile, name }) {
      state.mutations.push('agent')
      assert.equal(profile, 'release-validation')
      return { id: 'release-agent', name }
    },
    async ensureSession({ profile, agentId, kind }) {
      state.mutations.push(`session:${kind}`)
      assert.equal(profile, 'release-validation')
      assert.equal(agentId, 'release-agent')
      return { key: `${kind}-session-key` }
    },
    async ensureModelBinding({ profile, sessionKey, model }) {
      state.mutations.push('binding')
      assert.equal(profile, 'release-validation')
      assert.equal(sessionKey, 'main-session-key')
      assert.equal(model, input.expectedModel)
    },
  }
}

test('creates once and reuses only marked fixture resources', async () => {
  const api = freshApi()

  const first = await bootstrapReleaseValidation(api, input)
  const second = await bootstrapReleaseValidation(api, input)

  assert.deepEqual(second, first)
  assert.equal(api.createdOrganizations.length, 1)
  assert.equal(api.user?.password, input.password)
  assert.notEqual(first.IMAI_E2E_MAIN_SESSION_KEY, first.IMAI_E2E_CRON_SESSION_KEY)
})

test('refuses customer-owned organization before mutating fixture resources', async () => {
  const mutations = []
  const customerApi = {
    async findValidationUser() { return null },
    async ensureValidationUser() {
      return {
        id: 'validation-user',
        marker: 'uniopc-openclaw-release-validation-v1',
        organizationSlug: input.organizationSlug,
      }
    },
    async findValidationOrganization() { return null },
    async ensureMarkedOrganization() { throw new Error('fixture_ownership_mismatch') },
    async ensureOpenClawProfile() { mutations.push('profile') },
  }

  await assert.rejects(() => bootstrapReleaseValidation(customerApi, input), /fixture_ownership_mismatch/)
  assert.deepEqual(mutations, [])
})

test('rejects an adapter that returns an unmarked organization', async () => {
  const api = freshApi()
  const original = api.ensureMarkedOrganization
  api.ensureMarkedOrganization = async request => ({
    ...(await original(request)),
    marker: 'customer-owned',
  })

  await assert.rejects(() => bootstrapReleaseValidation(api, input), /fixture_ownership_mismatch/)
})

test('rejects a same-marker foreign organization before fixture mutations', async () => {
  const api = freshApi()
  const mutations = api.mutations
  api.ensureMarkedOrganization = async () => ({
    id: 'customer-org',
    slug: input.organizationSlug,
    marker: 'uniopc-openclaw-release-validation-v1',
    ownerUserId: 'customer-user',
  })

  await assert.rejects(() => bootstrapReleaseValidation(api, input), /fixture_ownership_mismatch/)
  assert.deepEqual(mutations, [])
})

test('rejects a same-owner organization with a foreign slug before fixture mutations', async () => {
  const api = freshApi()
  const mutations = api.mutations
  api.ensureMarkedOrganization = async () => ({
    id: 'customer-org',
    slug: 'customer-organization',
    marker: 'uniopc-openclaw-release-validation-v1',
    ownerUserId: 'validation-user',
  })

  await assert.rejects(() => bootstrapReleaseValidation(api, input), /fixture_ownership_mismatch/)
  assert.deepEqual(mutations, [])
})

test('refuses a pre-existing customer validation user before changing its password', async () => {
  let ensured = false
  const api = freshApi()
  api.findValidationUser = async () => ({
    id: 'customer-user',
    marker: 'customer-owned',
    organizationSlug: 'customer-organization',
  })
  api.ensureValidationUser = async () => {
    ensured = true
    throw new Error('must_not_run')
  }

  await assert.rejects(() => bootstrapReleaseValidation(api, input), /fixture_user_ownership_mismatch/)
  assert.equal(ensured, false)
})

test('refuses a foreign organization lookup before any fixture mutation', async () => {
  const mutations = []
  const api = {
    async findValidationUser() { return null },
    async ensureValidationUser() {
      mutations.push('user')
      return {
        id: 'validation-user',
        email: input.email,
        marker: 'uniopc-openclaw-release-validation-v1',
        organizationSlug: input.organizationSlug,
      }
    },
    async findValidationOrganization() {
      return {
        id: 'customer-org',
        marker: 'uniopc-openclaw-release-validation-v1',
        slug: input.organizationSlug,
        ownerUserId: 'customer-user',
      }
    },
    async ensureMarkedOrganization() { mutations.push('organization') },
    async ensureOpenClawProfile() { mutations.push('profile') },
    async ensureAgent() { mutations.push('agent') },
    async ensureSession() { mutations.push('session') },
    async ensureModelBinding() { mutations.push('binding') },
  }

  await assert.rejects(() => bootstrapReleaseValidation(api, input), /fixture_ownership_mismatch/)
  assert.deepEqual(mutations, [])
})

test('rejects an adapter without the mandatory organization lookup before fixture mutation', async () => {
  const mutations = []
  const api = {
    async findValidationUser() { return null },
    async ensureValidationUser() { mutations.push('user') },
    async ensureMarkedOrganization() { mutations.push('organization') },
  }

  await assert.rejects(
    () => bootstrapReleaseValidation(api, input),
    /fixture_api_invalid:findValidationOrganization/,
  )
  assert.deepEqual(mutations, [])
})

test('rejects an undefined user lookup result before fixture mutation', async () => {
  const api = freshApi()
  const mutations = api.mutations
  const ensureUser = api.ensureValidationUser
  const ensureOrganization = api.ensureMarkedOrganization
  api.findValidationUser = async () => undefined
  api.ensureValidationUser = async request => {
    mutations.push('user')
    return ensureUser(request)
  }
  api.ensureMarkedOrganization = async request => {
    mutations.push('organization')
    return ensureOrganization(request)
  }

  await assert.rejects(
    () => bootstrapReleaseValidation(api, input),
    /fixture_api_invalid:findValidationUser_result/,
  )
  assert.deepEqual(mutations, [])
})

test('rejects an undefined organization lookup result before fixture mutation', async () => {
  const api = freshApi()
  const mutations = api.mutations
  const ensureUser = api.ensureValidationUser
  const ensureOrganization = api.ensureMarkedOrganization
  api.findValidationOrganization = async () => undefined
  api.ensureValidationUser = async request => {
    mutations.push('user')
    return ensureUser(request)
  }
  api.ensureMarkedOrganization = async request => {
    mutations.push('organization')
    return ensureOrganization(request)
  }

  await assert.rejects(
    () => bootstrapReleaseValidation(api, input),
    /fixture_api_invalid:findValidationOrganization_result/,
  )
  assert.deepEqual(mutations, [])
})

test('exports the complete validation adapter contract for a fresh fixture', async () => {
  assert.deepEqual(Object.keys(bootstrapModule.VALIDATION_ADMIN_API_CONTRACT), [
    'findValidationUser',
    'findValidationOrganization',
    'ensureValidationUser',
    'ensureMarkedOrganization',
    'ensureOpenClawProfile',
    'ensureAgent',
    'ensureSession',
    'ensureModelBinding',
  ])
  assert.equal(bootstrapModule.VALIDATION_ADMIN_API_CONTRACT.findValidationOrganization.mutation, 'read-only')
  assert.match(bootstrapModule.VALIDATION_ADMIN_API_CONTRACT.findValidationOrganization.returns, /null/i)

  const fixture = await bootstrapReleaseValidation(freshApi(), input)
  assert.equal(fixture.IMAI_E2E_EMAIL, input.email)
})

test('refuses an ensure user identity switch before organization mutation', async () => {
  const mutations = []
  const api = freshApi()
  api.findValidationUser = async () => ({
    id: 'existing-validation-user',
    email: input.email,
    marker: 'uniopc-openclaw-release-validation-v1',
    organizationSlug: input.organizationSlug,
  })
  api.ensureValidationUser = async () => ({
    id: 'replacement-validation-user',
    email: input.email,
    marker: 'uniopc-openclaw-release-validation-v1',
    organizationSlug: input.organizationSlug,
  })
  api.ensureMarkedOrganization = async () => { mutations.push('organization') }
  api.ensureOpenClawProfile = async () => { mutations.push('profile') }

  await assert.rejects(() => bootstrapReleaseValidation(api, input), /fixture_user_ownership_mismatch/)
  assert.deepEqual(mutations, [])
})

test('writes exact fixture fields to a new owner-only file and redacts the report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-fixture-'))
  const outputPath = join(root, '.env.release-validation')
  const fixture = await bootstrapReleaseValidation(freshApi(), input)

  const result = await writeFixtureEnvironment(outputPath, fixture)
  const saved = await readFile(outputPath, 'utf8')
  const savedMode = (await stat(outputPath)).mode & 0o777

  assert.equal(result.mode, 0o600)
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('icacls', [outputPath])
    assert.match(stdout, new RegExp(`${process.env.USERNAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\(F\\)`))
    assert.equal((stdout.match(/:/g) || []).length, 2)
  } else {
    assert.equal(savedMode, 0o600)
  }
  assert.match(saved, /^IMAI_E2E_EMAIL=release-validation@example\.invalid$/m)
  assert.match(saved, /^IMAI_E2E_MAIN_SESSION_KEY=main-session-key$/m)
  assert.doesNotMatch(JSON.stringify(result.report), /password|@example|profile-id|session-key/i)
  await assert.rejects(() => writeFixtureEnvironment(outputPath, fixture), /EEXIST/)
})

test('restricts fixture output before writing secret content', async () => {
  const events = []
  const fixture = await bootstrapReleaseValidation(freshApi(), input)
  const handle = {
    async writeFile() { events.push('write') },
    async sync() { events.push('sync') },
    async close() { events.push('close') },
  }

  await writeFixtureEnvironment('not-created', fixture, {
    openFile: async () => { events.push('open'); return handle },
    restrictFile: async () => { events.push('restrict'); return 0o600 },
  })
  assert.deepEqual(events, ['open', 'restrict', 'write', 'sync', 'close'])
})

test('does not write fixture secrets if secure ACL setup fails', async () => {
  const events = []
  const fixture = await bootstrapReleaseValidation(freshApi(), input)
  const handle = {
    async writeFile() { events.push('write') },
    async close() { events.push('close') },
  }

  await assert.rejects(() => writeFixtureEnvironment('not-created', fixture, {
    openFile: async () => { events.push('open'); return handle },
    restrictFile: async () => { events.push('restrict'); throw new Error('acl_failed') },
  }), /acl_failed/)
  assert.deepEqual(events, ['open', 'restrict', 'close'])
})

test('generates fresh opaque fixture inputs without accepting a different organization slug', () => {
  const generated = createReleaseValidationInput({
    email: 'release-validation@example.invalid',
    expectedModel: 'openai/gpt-5.6',
  })

  assert.equal(generated.organizationSlug, 'openclaw-release-validation')
  assert.equal(Buffer.from(generated.password, 'base64url').length, 32)
  assert.equal(Buffer.from(generated.failurePrompt, 'base64url').length, 32)
  assert.equal(Buffer.from(generated.localWorkspacePrompt, 'base64url').length, 32)
})

test('CLI refuses to load or invoke an adapter unless the operator names one explicitly', () => {
  const scriptPath = fileURLToPath(new URL('./bootstrap-openclaw-release-validation.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing required option: --adapter/)
  assert.equal(result.stdout, '')
})

test('CLI help documents both required read-only fixture lookups', () => {
  const scriptPath = fileURLToPath(new URL('./bootstrap-openclaw-release-validation.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /findValidationUser\(email\).*read-only/is)
  assert.match(result.stdout, /findValidationOrganization\(organizationSlug\).*read-only/is)
  assert.equal(result.stderr, '')
})

test('CLI closes an explicit operator adapter when bootstrap fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-bootstrap-close-'))
  const adapterPath = join(root, 'adapter.mjs')
  const closePath = join(root, 'closed')
  const outputPath = join(root, 'fixture.env')
  const scriptPath = fileURLToPath(new URL('./bootstrap-openclaw-release-validation.mjs', import.meta.url))
  await writeFile(adapterPath, `
import { writeFile } from 'node:fs/promises'
export async function createAuthenticatedAdminApi() {
  return {
    authenticated: true,
    api: { findValidationUser: async () => undefined },
    close: async () => writeFile(${JSON.stringify(closePath)}, 'closed'),
  }
}
`)
  const result = spawnSync(process.execPath, [scriptPath,
    '--adapter', adapterPath,
    '--output', outputPath,
    '--email', 'release-validation@example.invalid',
    '--expected-model', 'openai/gpt-5.6',
  ], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /fixture_api_invalid:findValidationUser_result/)
  assert.equal(await (await import('node:fs/promises')).readFile(closePath, 'utf8'), 'closed')
})
