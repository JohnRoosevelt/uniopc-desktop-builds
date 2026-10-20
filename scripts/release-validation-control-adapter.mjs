import { basename, parse, resolve } from 'node:path'

import { createLiveValidationDependencies as createBoundedLiveValidationDependencies } from './validate-openclaw-release-live.mjs'

export const RELEASE_VALIDATION_MARKER = 'uniopc-openclaw-release-validation-v1'
export const RELEASE_VALIDATION_ORGANIZATION_SLUG = 'openclaw-release-validation'
export const RELEASE_VALIDATION_PROFILE = 'release-validation'
export const RELEASE_VALIDATION_AGENT = 'release-validation-agent'
export const RELEASE_VALIDATION_EMAIL = 'openclaw-release-validation@invalid.uniopc'
export const RELEASE_VALIDATION_CONTROL_URL = 'https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/release-validation-control'

const CONTROL_ACTIONS = Object.freeze([
  'find-user', 'find-organization', 'ensure-user', 'ensure-organization',
  'ensure-profile', 'ensure-employee', 'bootstrap-spec',
])

function requiredText(value, code) {
  const text = String(value || '').trim()
  if (!text || /[\r\n\0]/.test(text)) throw new Error(code)
  return text
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function validControlConfiguration(environment) {
  const url = requiredText(environment?.UNIOPC_RELEASE_VALIDATION_CONTROL_URL, 'release_validation_control_configuration_invalid')
  const token = requiredText(environment?.UNIOPC_RELEASE_VALIDATION_CONTROL_TOKEN, 'release_validation_control_configuration_invalid')
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('release_validation_control_configuration_invalid') }
  if (url !== RELEASE_VALIDATION_CONTROL_URL || parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || token.length < 16) {
    throw new Error('release_validation_control_configuration_invalid')
  }
  return { url, token }
}

function validIdentity(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).sort().join('\0') === fields.map(([name]) => name).sort().join('\0')
    && fields.every(([name, expected]) => String(value[name] || '') === String(expected || ''))
}

function validationRequestBody(action, payload) {
  if (!CONTROL_ACTIONS.includes(action)) {
    throw new Error('release_validation_control_request_invalid')
  }
  if (action === 'ensure-user') {
    if (!exactKeys(payload, ['email', 'password'])
      || requiredText(payload.email, 'release_validation_control_request_invalid') !== RELEASE_VALIDATION_EMAIL
      || !requiredText(payload.password, 'release_validation_control_request_invalid')) {
      throw new Error('release_validation_control_request_invalid')
    }
    return {
      schemaVersion: 1,
      action,
      marker: RELEASE_VALIDATION_MARKER,
      slug: RELEASE_VALIDATION_ORGANIZATION_SLUG,
      payload: { email: payload.email, password: payload.password },
    }
  }
  if (payload !== undefined) throw new Error('release_validation_control_request_invalid')
  return { schemaVersion: 1, action, marker: RELEASE_VALIDATION_MARKER, slug: RELEASE_VALIDATION_ORGANIZATION_SLUG }
}

function createControlClient({ environment, fetchFn }) {
  const configuration = validControlConfiguration(environment)
  if (typeof fetchFn !== 'function') throw new Error('release_validation_control_configuration_invalid')
  return async function callControl(action, payload) {
    const response = await fetchFn(configuration.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-release-validation-control-token': configuration.token,
      },
      body: JSON.stringify(validationRequestBody(action, payload)),
    }).catch(() => { throw new Error('release_validation_control_request_failed') })
    let body
    try { body = await response.json() } catch { throw new Error('release_validation_control_response_invalid') }
    if (!response?.ok || !exactKeys(body, ['ok', 'result']) || body.ok !== true) {
      throw new Error('release_validation_control_response_invalid')
    }
    return body.result
  }
}

function requireProfile(value, organizationId) {
  if (!validIdentity(value, [
    ['id', requiredText(value?.id, 'release_validation_control_response_invalid')],
    ['marker', RELEASE_VALIDATION_MARKER],
    ['organizationId', organizationId],
    ['name', RELEASE_VALIDATION_PROFILE],
  ])) throw new Error('release_validation_control_response_invalid')
  return value
}

function requireSessionResult(value) {
  const key = requiredText(value?.sessionKey, 'release_validation_ipc_response_invalid')
  return { key }
}

function requireAgentResult(value) {
  return { id: requiredText(value?.id, 'release_validation_ipc_response_invalid') }
}

function releaseSessionLabel(kind) {
  if (kind !== 'main' && kind !== 'cron') throw new Error('release_validation_ipc_request_invalid')
  return `${RELEASE_VALIDATION_PROFILE}-${kind}`
}

function invokeRequired(invoke, command, args) {
  if (typeof invoke !== 'function') throw new Error('release_validation_ipc_unavailable')
  return invoke(command, args).catch(() => { throw new Error('release_validation_ipc_failed') })
}

export async function createAuthenticatedAdminApi({
  environment = process.env,
  fetchFn = globalThis.fetch,
  invoke,
} = {}) {
  const callControl = createControlClient({ environment, fetchFn })
  const api = {
    async findValidationUser(email) {
      if (requiredText(email, 'release_validation_control_request_invalid') !== RELEASE_VALIDATION_EMAIL) {
        throw new Error('release_validation_control_request_invalid')
      }
      const result = await callControl('find-user')
      if (result === null) return null
      if (!validIdentity(result, [
        ['id', requiredText(result?.id, 'release_validation_control_response_invalid')],
        ['marker', RELEASE_VALIDATION_MARKER],
        ['organizationSlug', RELEASE_VALIDATION_ORGANIZATION_SLUG], ['email', RELEASE_VALIDATION_EMAIL],
      ])) throw new Error('release_validation_control_response_invalid')
      return result
    },
    async findValidationOrganization(slug) {
      if (requiredText(slug, 'release_validation_control_request_invalid') !== RELEASE_VALIDATION_ORGANIZATION_SLUG) {
        throw new Error('release_validation_control_request_invalid')
      }
      const result = await callControl('find-organization')
      if (result === null) return null
      if (!validIdentity(result, [
        ['id', requiredText(result?.id, 'release_validation_control_response_invalid')],
        ['marker', RELEASE_VALIDATION_MARKER],
        ['slug', RELEASE_VALIDATION_ORGANIZATION_SLUG],
        ['ownerUserId', requiredText(result?.ownerUserId, 'release_validation_control_response_invalid')],
      ])) throw new Error('release_validation_control_response_invalid')
      return result
    },
    async ensureValidationUser(input) {
      if (!input || input.marker !== RELEASE_VALIDATION_MARKER || input.organizationSlug !== RELEASE_VALIDATION_ORGANIZATION_SLUG) {
        throw new Error('release_validation_control_request_invalid')
      }
      const email = requiredText(input.email, 'release_validation_control_request_invalid')
      const result = await callControl('ensure-user', { email, password: requiredText(input.password, 'release_validation_control_request_invalid') })
      if (!validIdentity(result, [
        ['id', requiredText(result?.id, 'release_validation_control_response_invalid')],
        ['marker', RELEASE_VALIDATION_MARKER], ['organizationSlug', RELEASE_VALIDATION_ORGANIZATION_SLUG], ['email', email],
      ])) throw new Error('release_validation_control_response_invalid')
      return result
    },
    async ensureMarkedOrganization(input) {
      if (!input || input.marker !== RELEASE_VALIDATION_MARKER || input.slug !== RELEASE_VALIDATION_ORGANIZATION_SLUG) {
        throw new Error('release_validation_control_request_invalid')
      }
      const ownerUserId = requiredText(input.ownerUserId, 'release_validation_control_request_invalid')
      const result = await callControl('ensure-organization')
      if (!validIdentity(result, [
        ['id', requiredText(result?.id, 'release_validation_control_response_invalid')],
        ['marker', RELEASE_VALIDATION_MARKER], ['slug', RELEASE_VALIDATION_ORGANIZATION_SLUG], ['ownerUserId', ownerUserId],
      ])) throw new Error('release_validation_control_response_invalid')
      return result
    },
    async ensureOpenClawProfile(input) {
      if (!input || requiredText(input.name, 'release_validation_control_request_invalid') !== RELEASE_VALIDATION_PROFILE) {
        throw new Error('release_validation_control_request_invalid')
      }
      const organizationId = requiredText(input.organizationId, 'release_validation_control_request_invalid')
      const profile = requireProfile(await callControl('ensure-profile'), organizationId)
      const employee = await callControl('ensure-employee')
      if (!validIdentity(employee, [
        ['id', requiredText(employee?.id, 'release_validation_control_response_invalid')], ['marker', RELEASE_VALIDATION_MARKER],
        ['organizationId', organizationId], ['profileName', RELEASE_VALIDATION_PROFILE],
      ])) throw new Error('release_validation_control_response_invalid')
      const spec = await callControl('bootstrap-spec')
      if (!validIdentity(spec, [
        ['marker', RELEASE_VALIDATION_MARKER], ['organizationSlug', RELEASE_VALIDATION_ORGANIZATION_SLUG],
        ['profileName', RELEASE_VALIDATION_PROFILE], ['employeeId', employee.id],
        ['gatewayBootstrap', spec?.gatewayBootstrap],
      ]) || !validIdentity(spec.gatewayBootstrap, [
        ['schemaVersion', '1'], ['profileKey', 'openclaw-release-validation'], ['organizationId', organizationId],
        ['memberId', requiredText(spec?.gatewayBootstrap?.memberId, 'release_validation_control_response_invalid')],
        ['employeeId', employee.id], ['actions', spec?.gatewayBootstrap?.actions],
      ]) || JSON.stringify(spec.gatewayBootstrap.actions) !== JSON.stringify([
        'create_agent', 'create_main_session', 'create_cron_session', 'bind_model',
      ])) throw new Error('release_validation_control_response_invalid')
      return profile
    },
    async ensureAgent(input) {
      if (!input || requiredText(input.profile, 'release_validation_ipc_request_invalid') !== RELEASE_VALIDATION_PROFILE
        || requiredText(input.name, 'release_validation_ipc_request_invalid') !== RELEASE_VALIDATION_AGENT) {
        throw new Error('release_validation_ipc_request_invalid')
      }
      return requireAgentResult(await invokeRequired(invoke, 'openclaw_agents_create', {
        req: { profile: RELEASE_VALIDATION_PROFILE, name: RELEASE_VALIDATION_AGENT, role: 'Release validation', description: 'Isolated OpenClaw release validation agent', emoji: '🧪' },
      }))
    },
    async ensureSession(input) {
      if (!input || requiredText(input.profile, 'release_validation_ipc_request_invalid') !== RELEASE_VALIDATION_PROFILE) {
        throw new Error('release_validation_ipc_request_invalid')
      }
      const agentId = requiredText(input.agentId, 'release_validation_ipc_request_invalid')
      const label = releaseSessionLabel(input.kind)
      const listed = await invokeRequired(invoke, 'conversation_list_sessions', {
        req: { profile: RELEASE_VALIDATION_PROFILE, agentId, offset: 0, limit: 200 },
      })
      if (!Array.isArray(listed?.sessions)) throw new Error('release_validation_ipc_response_invalid')
      const existing = listed.sessions.find(session => String(session?.label || session?.title || '') === label)
      if (existing) return { key: requiredText(existing.sessionKey || existing.key, 'release_validation_ipc_response_invalid') }
      const session = requireSessionResult(await invokeRequired(invoke, 'conversation_create_session', {
        req: { profile: RELEASE_VALIDATION_PROFILE, agentId },
      }))
      const renamed = await invokeRequired(invoke, 'conversation_rename_session', {
        req: { profile: RELEASE_VALIDATION_PROFILE, sessionKey: session.key, label },
      })
      if (requiredText(renamed?.sessionKey, 'release_validation_ipc_response_invalid') !== session.key
        || requiredText(renamed?.label, 'release_validation_ipc_response_invalid') !== label) {
        throw new Error('release_validation_ipc_response_invalid')
      }
      return session
    },
    async ensureModelBinding(input) {
      if (!input || requiredText(input.profile, 'release_validation_ipc_request_invalid') !== RELEASE_VALIDATION_PROFILE) {
        throw new Error('release_validation_ipc_request_invalid')
      }
      const sessionKey = requiredText(input.sessionKey, 'release_validation_ipc_request_invalid')
      const model = requiredText(input.model, 'release_validation_ipc_request_invalid')
      const result = await invokeRequired(invoke, 'conversation_set_session_model', {
        req: { profile: RELEASE_VALIDATION_PROFILE, sessionKey, model },
      })
      if (requiredText(result?.sessionKey, 'release_validation_ipc_response_invalid') !== sessionKey
        || requiredText(result?.model, 'release_validation_ipc_response_invalid') !== model) {
        throw new Error('release_validation_ipc_response_invalid')
      }
    },
  }
  return { authenticated: true, api }
}

function assertValidationRoot(validationRoot) {
  const root = resolve(requiredText(validationRoot, 'release_validation_root_invalid'))
  if (root === parse(root).root || basename(root).toLowerCase() !== 'release-validation') {
    throw new Error('release_validation_root_invalid')
  }
  return root
}

export function createLiveValidationDependencies({ validationRoot, runtime } = {}) {
  const root = assertValidationRoot(validationRoot)
  if (!runtime || typeof runtime !== 'object') throw new Error('release_validation_adapter_invalid')
  const requireRoot = operation => async (payload = {}) => {
    if (resolve(String(payload.validationRoot || '')) !== root) throw new Error('release_validation_root_invalid')
    return operation(payload)
  }
  if (!runtime.processController || !runtime.networkController || !runtime.documentController) {
    throw new Error('release_validation_adapter_invalid')
  }
  return createBoundedLiveValidationDependencies({
    processController: {
      snapshot: requireRoot(runtime.processController.snapshot),
      cleanup: requireRoot(runtime.processController.cleanup),
    },
    networkController: {
      snapshot: requireRoot(runtime.networkController.snapshot),
      apply: requireRoot(runtime.networkController.apply),
      restore: requireRoot(runtime.networkController.restore),
    },
    documentController: { archivePhaseDocuments: requireRoot(runtime.documentController.archivePhaseDocuments) },
    runCase: requireRoot(runtime.runCase),
    runCommand: requireRoot(runtime.runCommand),
    phaseTimeoutMs: runtime.phaseTimeoutMs,
    cleanupTimeoutMs: runtime.cleanupTimeoutMs,
  })
}
