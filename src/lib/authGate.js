import { APP_MODES } from './appModes.js'

function normalizeWorkspaceRole(workspaceProfile = null) {
  return String(workspaceProfile?.memberRole || workspaceProfile?.member_role || '').trim()
}

function normalizeWorkspaceStatus(workspaceProfile = null) {
  return String(workspaceProfile?.profileStatus || workspaceProfile?.profile_status || '').trim()
}

function hasKnownWorkspaceProfile(workspaceProfile = null) {
  if (!workspaceProfile) return false
  return Boolean(
    normalizeWorkspaceRole(workspaceProfile) ||
    normalizeWorkspaceStatus(workspaceProfile) ||
    workspaceProfile.organizationId ||
    workspaceProfile.organization_id ||
    workspaceProfile.memberId ||
    workspaceProfile.member_id
  )
}

export function canEnterAuthenticatedApp({ user, workspaceProfile = null, appMode = APP_MODES.HOST } = {}) {
  if (!user) return false
  if (!hasKnownWorkspaceProfile(workspaceProfile)) return true
  const memberRole = normalizeWorkspaceRole(workspaceProfile)
  const profileStatus = normalizeWorkspaceStatus(workspaceProfile)
  if (profileStatus === 'organization_suspended') return false
  if (memberRole === 'unopened' || profileStatus === 'imai_admin_not_found' || profileStatus === 'workspace_not_found') {
    if (memberRole === 'setup_required') return true
    return false
  }
  return memberRole === 'owner' || memberRole === 'admin' || memberRole === 'member'
}

export function shouldRedirectLoggedInUserFromLogin({ user, workspaceProfile = null, appMode = APP_MODES.HOST } = {}) {
  return canEnterAuthenticatedApp({ user, workspaceProfile, appMode })
}

export function blockedAuthenticatedAppMessage({ workspaceProfile = null, appMode = APP_MODES.HOST } = {}) {
  const profileStatus = normalizeWorkspaceStatus(workspaceProfile)
  if (profileStatus === 'organization_suspended') return '组织已停用，请联系 Uniopc 平台管理员'

  return '查不到用户，请联系 Uniopc 管理员开通'
}
