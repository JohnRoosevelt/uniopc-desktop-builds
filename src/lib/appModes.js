export const APP_MODES = Object.freeze({
  HOST: 'admin-host',
})

export const OPENCLAW_HOST_ENVIRONMENTS = Object.freeze({
  OWNER: 'owner_host',
  MEMBER: 'member_host',
})

export const OPENCLAW_ACCESS_MODES = Object.freeze({
  OWNER_HOST: 'owner_host',
  MEMBER_HOST: 'member_host',
  MISSING_PROFILE: 'missing_profile',
})

export function isHostAppMode(appMode = APP_MODES.HOST) {
  return true
}

export function hostEnvironmentForWorkspaceRole(role = '') {
  return String(role || '').trim() === 'member'
    ? OPENCLAW_HOST_ENVIRONMENTS.MEMBER
    : OPENCLAW_HOST_ENVIRONMENTS.OWNER
}

export function hostEnvironmentLabel(role = '') {
  return hostEnvironmentForWorkspaceRole(role) === OPENCLAW_HOST_ENVIRONMENTS.MEMBER
    ? 'Member Local Uniopc 引擎'
    : 'Owner Host environment'
}
