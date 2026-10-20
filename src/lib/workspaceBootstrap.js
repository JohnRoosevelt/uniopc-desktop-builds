import { APP_MODES, isHostAppMode } from './appModes.js'
import {
  ensureCloudOrganization,
  getMyCloudWorkspaceProfile,
} from './cloudWorkspace.js'

const DEFAULT_WORKSPACE_BOOTSTRAP_TIMEOUT_MS = 15_000

function normalizeRole(workspaceProfile = null) {
  return String(workspaceProfile?.memberRole || workspaceProfile?.member_role || '').trim()
}

function createWorkspaceBootstrapTimeoutError(timeoutMs) {
  const error = new Error(`检查账号开通状态超时，请确认网络或 Supabase 服务可用后刷新。`)
  error.code = 'workspace_bootstrap_timeout'
  error.status = 0
  error.timeoutMs = timeoutMs
  return error
}

function withBootstrapTimeout(promise, timeoutMs = DEFAULT_WORKSPACE_BOOTSTRAP_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise

  let timeoutId = null
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(createWorkspaceBootstrapTimeoutError(timeoutMs))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

export function shouldInitializeApprovedOrganization(workspaceProfile = null, appMode = APP_MODES.HOST) {
  return isHostAppMode(appMode) && normalizeRole(workspaceProfile) === 'setup_required'
}

export async function loadWorkspaceProfileWithSetup({
  client,
  ownerId,
  appMode = APP_MODES.HOST,
  loadProfile = getMyCloudWorkspaceProfile,
  ensureOrganization = ensureCloudOrganization,
  onStage = null,
  timeoutMs = DEFAULT_WORKSPACE_BOOTSTRAP_TIMEOUT_MS,
} = {}) {
  return await withBootstrapTimeout((async () => {
    const workspaceProfile = await loadProfile(client, ownerId)
    if (!shouldInitializeApprovedOrganization(workspaceProfile, appMode)) {
      return {
        workspaceProfile,
        organizationSetupCompleted: false,
      }
    }

    if (typeof onStage === 'function') onStage('initializing_organization')
    try {
      await ensureOrganization(client, ownerId)
    } catch (error) {
      // Self-service users have no approved opening request, so automatic
      // setup cannot pick an organization type. Route them to the
      // create-organization page instead of failing bootstrap.
      if (String(error?.message || error || '').includes('organization_type_required')) {
        return {
          workspaceProfile,
          organizationSetupCompleted: false,
        }
      }
      throw error
    }
    return {
      workspaceProfile: await loadProfile(client, ownerId),
      organizationSetupCompleted: true,
    }
  })(), timeoutMs)
}
