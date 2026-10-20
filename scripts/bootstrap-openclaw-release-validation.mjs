#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, open, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FIXTURE_MARKER = 'uniopc-openclaw-release-validation-v1'
const FIXTURE_SLUG = 'openclaw-release-validation'
const FIXTURE_KEYS = [
  'IMAI_E2E_EMAIL',
  'IMAI_E2E_PASSWORD',
  'IMAI_E2E_PROFILE',
  'IMAI_E2E_AGENT_ID',
  'IMAI_E2E_MAIN_SESSION_KEY',
  'IMAI_E2E_CRON_SESSION_KEY',
  'IMAI_E2E_EXPECTED_MODEL',
  'IMAI_E2E_EXPECTED_MODEL_LABEL',
  'IMAI_E2E_FAILURE_KIND',
  'IMAI_E2E_FAILURE_PROMPT',
  'IMAI_E2E_FAILURE_EXPECTED_TEXT',
  'IMAI_E2E_LOCAL_WORKSPACE_PROMPT',
]

export const VALIDATION_ADMIN_API_CONTRACT = Object.freeze({
  findValidationUser: Object.freeze({
    mutation: 'read-only',
    input: 'email',
    returns: 'null when absent, otherwise the fixture user identity { id, marker, organizationSlug, email? }',
  }),
  findValidationOrganization: Object.freeze({
    mutation: 'read-only',
    input: 'organizationSlug',
    returns: 'null when absent, otherwise the fixture organization identity { id, marker, slug, ownerUserId }',
  }),
  ensureValidationUser: Object.freeze({ mutation: 'mutating' }),
  ensureMarkedOrganization: Object.freeze({ mutation: 'mutating' }),
  ensureOpenClawProfile: Object.freeze({ mutation: 'mutating' }),
  ensureAgent: Object.freeze({ mutation: 'mutating' }),
  ensureSession: Object.freeze({ mutation: 'mutating' }),
  ensureModelBinding: Object.freeze({ mutation: 'mutating' }),
})

function requireText(value, code) {
  const text = String(value || '').trim()
  if (!text || /[\r\n\0]/.test(text)) throw new Error(code)
  return text
}

function opaqueInput() {
  return randomBytes(32).toString('base64url')
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

async function callApi(api, method, ...arguments_) {
  if (typeof api?.[method] !== 'function') throw new Error(`fixture_api_invalid:${method}`)
  return api[method](...arguments_)
}

function requireLookupResult(value, method) {
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(`fixture_api_invalid:${method}_result`)
  }
  return value
}

function runIcacls(args) {
  return new Promise((resolvePromise, reject) => {
    execFile('icacls', args, { windowsHide: true }, error => {
      if (error) reject(new Error('fixture_file_permissions_invalid'))
      else resolvePromise()
    })
  })
}

async function restrictToOwner(outputPath) {
  if (process.platform === 'win32') {
    const domain = requireText(process.env.USERDOMAIN, 'fixture_file_permissions_invalid')
    const username = requireText(process.env.USERNAME, 'fixture_file_permissions_invalid')
    await runIcacls([outputPath, '/inheritance:r', '/grant:r', `${domain}\\${username}:(F)`])
    return 0o600
  }
  await chmod(outputPath, 0o600)
  const mode = (await stat(outputPath)).mode & 0o777
  if (mode !== 0o600) throw new Error('fixture_file_permissions_invalid')
  return mode
}

export function createReleaseValidationInput({ email, expectedModel, expectedModelLabel, failureExpectedText } = {}) {
  return {
    email: requireText(email, 'fixture_input_invalid'),
    organizationSlug: FIXTURE_SLUG,
    expectedModel: requireText(expectedModel, 'fixture_input_invalid'),
    expectedModelLabel: requireText(expectedModelLabel || expectedModel, 'fixture_input_invalid'),
    password: opaqueInput(),
    failurePrompt: opaqueInput(),
    failureExpectedText: requireText(failureExpectedText || 'upstream', 'fixture_input_invalid'),
    localWorkspacePrompt: opaqueInput(),
  }
}

function validateInput(input) {
  if (!input || input.organizationSlug !== FIXTURE_SLUG) throw new Error('fixture_organization_invalid')
  for (const key of ['email', 'expectedModel', 'expectedModelLabel', 'password', 'failurePrompt', 'failureExpectedText', 'localWorkspacePrompt']) {
    requireText(input[key], 'fixture_input_invalid')
  }
}

function fixtureEnvironment({ input, profile, agent, main, cron }) {
  const environment = {
    IMAI_E2E_EMAIL: input.email,
    IMAI_E2E_PASSWORD: input.password,
    IMAI_E2E_PROFILE: profile.name,
    IMAI_E2E_AGENT_ID: agent.id,
    IMAI_E2E_MAIN_SESSION_KEY: main.key,
    IMAI_E2E_CRON_SESSION_KEY: cron.key,
    IMAI_E2E_EXPECTED_MODEL: input.expectedModel,
    IMAI_E2E_EXPECTED_MODEL_LABEL: input.expectedModelLabel,
    IMAI_E2E_FAILURE_KIND: 'upstream',
    IMAI_E2E_FAILURE_PROMPT: input.failurePrompt,
    IMAI_E2E_FAILURE_EXPECTED_TEXT: input.failureExpectedText,
    IMAI_E2E_LOCAL_WORKSPACE_PROMPT: input.localWorkspacePrompt,
  }
  if (!exactKeys(environment, FIXTURE_KEYS)) throw new Error('fixture_environment_invalid')
  for (const value of Object.values(environment)) requireText(value, 'fixture_environment_invalid')
  return environment
}

function isFixtureUser(user, input) {
  return user && typeof user === 'object'
    && typeof user.id === 'string' && user.id.trim()
    && user.marker === FIXTURE_MARKER
    && user.organizationSlug === input.organizationSlug
    && (!Object.hasOwn(user, 'email') || user.email === input.email)
}

function isFixtureOrganization(organization, input, ownerUserId) {
  return organization && typeof organization === 'object'
    && typeof organization.id === 'string' && organization.id.trim()
    && organization.marker === FIXTURE_MARKER
    && organization.slug === input.organizationSlug
    && organization.ownerUserId === ownerUserId
}

export async function bootstrapReleaseValidation(api, input) {
  validateInput(input)

  const existingUser = requireLookupResult(
    await callApi(api, 'findValidationUser', input.email),
    'findValidationUser',
  )
  if (existingUser && !isFixtureUser(existingUser, input)) throw new Error('fixture_user_ownership_mismatch')

  const existingOrganization = requireLookupResult(
    await callApi(api, 'findValidationOrganization', input.organizationSlug),
    'findValidationOrganization',
  )
  if (existingOrganization && (!existingUser || !isFixtureOrganization(existingOrganization, input, existingUser.id))) {
    throw new Error('fixture_ownership_mismatch')
  }

  const user = await callApi(api, 'ensureValidationUser', {
    email: input.email,
    password: input.password,
    marker: FIXTURE_MARKER,
    organizationSlug: input.organizationSlug,
  })
  if (!isFixtureUser(user, input)) throw new Error('fixture_user_ownership_mismatch')
  if (existingUser && user.id !== existingUser.id) throw new Error('fixture_user_ownership_mismatch')

  const organization = await callApi(api, 'ensureMarkedOrganization', {
    slug: input.organizationSlug,
    marker: FIXTURE_MARKER,
    ownerUserId: user.id,
  })
  if (!isFixtureOrganization(organization, input, user.id)
    || (existingOrganization && organization.id !== existingOrganization.id)) {
    throw new Error('fixture_ownership_mismatch')
  }
  const profile = await callApi(api, 'ensureOpenClawProfile', { organizationId: organization.id, name: 'release-validation' })
  const profileName = requireText(profile?.name, 'fixture_profile_invalid')
  const agent = await callApi(api, 'ensureAgent', { profile: profileName, name: 'release-validation-agent' })
  const agentId = requireText(agent?.id, 'fixture_agent_invalid')
  const main = await callApi(api, 'ensureSession', { profile: profileName, agentId, kind: 'main' })
  const cron = await callApi(api, 'ensureSession', { profile: profileName, agentId, kind: 'cron' })
  if (requireText(main?.key, 'fixture_session_invalid') === requireText(cron?.key, 'fixture_session_invalid')) {
    throw new Error('fixture_session_collision')
  }
  await callApi(api, 'ensureModelBinding', { profile: profileName, sessionKey: main.key, model: input.expectedModel })
  return fixtureEnvironment({ input, profile: { ...profile, name: profileName }, agent: { ...agent, id: agentId }, main, cron })
}

export async function writeFixtureEnvironment(outputPath, fixture, {
  openFile = open,
  restrictFile = restrictToOwner,
} = {}) {
  if (!exactKeys(fixture, FIXTURE_KEYS)) throw new Error('fixture_environment_invalid')
  const text = `${FIXTURE_KEYS.map(key => `${key}=${requireText(fixture[key], 'fixture_environment_invalid')}`).join('\n')}\n`
  const handle = await openFile(outputPath, 'wx', 0o600)
  try {
    const mode = await restrictFile(outputPath)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    return {
      mode,
      report: { fixture: 'openclaw-release-validation', written: true },
    }
  } finally {
    await handle.close()
  }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return { help: true }
    if (!['--adapter', '--output', '--email', '--expected-model', '--expected-model-label', '--failure-expected-text'].includes(option)) {
      throw new Error(`Unknown option: ${option}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${option}`)
    index += 1
    args[option.slice(2).replaceAll('-', '_')] = value
  }
  for (const key of ['adapter', 'output', 'email', 'expected_model']) {
    if (!args[key]) throw new Error(`Missing required option: --${key.replaceAll('_', '-')}`)
  }
  return args
}

async function loadAuthenticatedAdapter(adapterPath) {
  const module = await import(pathToFileURL(resolve(adapterPath)).href)
  if (typeof module.createAuthenticatedAdminApi !== 'function') throw new Error('fixture_adapter_invalid')
  const adapter = await module.createAuthenticatedAdminApi()
  if (!adapter || adapter.authenticated !== true || !adapter.api || (adapter.close !== undefined && typeof adapter.close !== 'function')) {
    throw new Error('fixture_adapter_unauthenticated')
  }
  return adapter
}

function usage() {
  return `Usage: npm run bootstrap:openclaw-release-validation -- \\
  --adapter /absolute/path/to/authenticated-admin-adapter.mjs \\
  --output /absolute/path/to/.env.release-validation \\
  --email release-validation@example.invalid \\
  --expected-model openai/gpt-5.6

The adapter is mandatory and must explicitly report authenticated=true. This
command never discovers browser, OS, or repository credentials.

Required read-only lookups before any fixture mutation:
  findValidationUser(email) is read-only and returns null when absent or { id, marker,
    organizationSlug, email? } for the exact fixture user.
  findValidationOrganization(organizationSlug) is read-only and returns null when absent or
    { id, marker, slug, ownerUserId } for the exact fixture organization.
Both existing identities must match each other and the requested fixture.`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  const adapter = await loadAuthenticatedAdapter(args.adapter)
  try {
    const fixture = await bootstrapReleaseValidation(adapter.api, createReleaseValidationInput({
      email: args.email,
      expectedModel: args.expected_model,
      expectedModelLabel: args.expected_model_label,
      failureExpectedText: args.failure_expected_text,
    }))
    const result = await writeFixtureEnvironment(resolve(args.output), fixture)
    console.log(JSON.stringify(result.report))
  } finally {
    await adapter.close?.()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.message || error)
    process.exitCode = 1
  })
}
