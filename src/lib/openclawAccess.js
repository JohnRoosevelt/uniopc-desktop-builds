import { APP_MODES, OPENCLAW_ACCESS_MODES, hostEnvironmentForWorkspaceRole, isHostAppMode } from './appModes.js'

function normalizeRole(workspaceProfile = null) {
  return String(workspaceProfile?.memberRole || workspaceProfile?.member_role || '').trim()
}

function normalizeRuntimeMode(workspaceProfile = null) {
  const role = normalizeRole(workspaceProfile)
  if (role === 'member') return 'member_local'
  return 'member_local'
}

function hasActiveProfile(workspaceProfile = null) {
  const profile = String(workspaceProfile?.openclawProfile || workspaceProfile?.openclaw_profile || '').trim()
  const status = String(workspaceProfile?.profileStatus || workspaceProfile?.profile_status || '').trim()
  return Boolean(profile && (!status || status === 'active'))
}

function normalizeStatus(value, fallback = '') {
  return String(value || fallback).trim()
}

function normalizeAssignment(bootstrap = null) {
  return bootstrap?.gatewayAssignment || bootstrap?.gateway_assignment || null
}

function normalizePairingSetup(bootstrap = null) {
  return bootstrap?.pairingSetup || bootstrap?.pairing_setup || null
}

function hasBootstrapProfile(bootstrap = null) {
  const assignment = normalizeAssignment(bootstrap)
  const setup = normalizePairingSetup(bootstrap)
  const profile = String(setup?.openclawProfile || setup?.openclaw_profile || assignment?.openclawProfile || assignment?.openclaw_profile || '').trim()
  return Boolean(profile)
}

function isLoopbackGatewayHost(host = '') {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' ||
    value === '::1' ||
    value === '0:0:0:0:0:0:0:1' ||
    value.startsWith('127.')
}

function isPrivateGatewayHost(host = '') {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!value) return false
  if (value.endsWith('.local')) return true
  if (value.startsWith('10.')) return true
  if (value.startsWith('192.168.')) return true
  if (value.startsWith('169.254.')) return true
  const ipv4 = value.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (ipv4) {
    const first = Number(ipv4[1])
    const second = Number(ipv4[2])
    if (first === 100 && second >= 64 && second <= 127) return true
    return first === 172 && second >= 16 && second <= 31
  }
  return value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')
}

export function remoteGatewayEndpointIssue(gatewayUrl = '', { accessMode = 'direct' } = {}) {
  const raw = String(gatewayUrl || '').trim()
  if (!raw) return 'missing'
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return 'invalid'
  }
  if (!['ws:', 'wss:'].includes(parsed.protocol)) return 'invalid_scheme'
  const mode = normalizeStatus(accessMode, 'direct')
  if (isLoopbackGatewayHost(parsed.hostname)) {
    return ['local_tunnel', 'ssh_tunnel', 'remote_ssh_tunnel', 'ssh'].includes(mode)
      ? ''
      : 'loopback_direct'
  }
  if (parsed.protocol === 'wss:') return ''
  return isPrivateGatewayHost(parsed.hostname) ? '' : 'remote_cleartext'
}

function remoteTargetSource(bootstrap = null) {
  const assignment = normalizeAssignment(bootstrap)
  const setup = normalizePairingSetup(bootstrap)
  return { assignment, setup }
}

export function memberRemoteConnectionTargetFromBootstrap(bootstrap = null) {
  const { assignment, setup } = remoteTargetSource(bootstrap)
  const openclawProfile = String(setup?.openclawProfile || setup?.openclaw_profile || assignment?.openclawProfile || assignment?.openclaw_profile || '').trim()
  if (!openclawProfile) return null
  return {
    transport: 'direct',
    openclawProfile,
    organizationId: assignment?.organizationId || assignment?.organization_id || '',
    openclawProfileId: assignment?.openclawProfileId || assignment?.openclaw_profile_id || '',
    hostId: assignment?.hostId || assignment?.host_id || '',
    memberId: assignment?.memberId || assignment?.member_id || '',
    assignmentId: assignment?.id || '',
    gatewayUrl: '',
    authToken: null,
    authPassword: null,
    sshTarget: '',
    sshRemoteHost: '127.0.0.1',
    sshRemotePort: 18790,
    sshLocalPort: 18791,
  }
}

export function memberRemotePairingSetupFromBootstrap(bootstrap = null) {
  const assignment = normalizeAssignment(bootstrap)
  const setup = normalizePairingSetup(bootstrap)
  const openclawProfile = String(setup?.openclawProfile || setup?.openclaw_profile || assignment?.openclawProfile || assignment?.openclaw_profile || '').trim()
  const setupCode = String(setup?.setupCode || setup?.setup_code || '').trim()
  if (!openclawProfile || !setupCode) return null
  return {
    openclawProfile,
    setupCode,
    gatewayUrl: '',
    transport: 'direct',
    sshTarget: '',
    sshRemoteHost: '127.0.0.1',
    sshRemotePort: 18790,
    sshLocalPort: 18791,
    expiresAt: setup?.expiresAt || setup?.expires_at || null,
    source: 'member-gateway-assignment',
  }
}

export function shouldRequireLocalOpenClawSetup(workspaceProfile = null, { appMode = APP_MODES.HOST } = {}) {
  const role = normalizeRole(workspaceProfile)
  if (role === 'member') return normalizeRuntimeMode(workspaceProfile) === 'member_local' && hasActiveProfile(workspaceProfile)
  if (!isHostAppMode(appMode)) return false
  if (role === 'owner' || role === 'admin') return true
  return false
}

export function shouldDeferOpenClawDirectoryHydration({ userId = '', workspaceProfileLoading = false } = {}) {
  return Boolean(String(userId || '').trim() && workspaceProfileLoading)
}

export function memberClientStatusFromBootstrap(bootstrap = null) {
  if (!bootstrap) return 'no_assignment'
  const explicitStatus = normalizeStatus(bootstrap.status || bootstrap.client_status)
  const deviceStatus = normalizeStatus(bootstrap.device?.status || bootstrap.member_device?.status)
  if (explicitStatus === 'revoked' || deviceStatus === 'revoked') return 'revoked'
  if (explicitStatus === 'device_pending' || deviceStatus === 'pending') return 'device_pending'
  if (explicitStatus && !['ready', 'permission_empty'].includes(explicitStatus)) return explicitStatus

  const assignment = normalizeAssignment(bootstrap)
  if (!assignment?.id) return 'no_assignment'
  const assignmentStatus = normalizeStatus(assignment.status, 'active')
  if (assignmentStatus === 'revoked') return 'revoked'
  if (assignmentStatus === 'suspended') return 'no_assignment'

  return 'ready'
}

export function shouldUseCloudEmployeeDirectory(workspaceProfile = null, bootstrap = null, { appMode = APP_MODES.HOST } = {}) {
  return normalizeRole(workspaceProfile) === 'member' && hasActiveProfile(workspaceProfile)
}

export function canManageMemberOpenClawPairing(member = null) {
  const role = normalizeRole(member)
  const profileId = String(member?.openclawProfileId || member?.openclaw_profile_id || '').trim()
  return role === 'member' && Boolean(profileId) && hasActiveProfile(member)
}

export function resolveOpenClawAccessMode(workspaceProfile = null, bootstrap = null, { appMode = APP_MODES.HOST } = {}) {
  if (shouldRequireLocalOpenClawSetup(workspaceProfile, { appMode })) {
    const role = normalizeRole(workspaceProfile)
    return role === 'member' ? 'member_local' : hostEnvironmentForWorkspaceRole(role)
  }
  return OPENCLAW_ACCESS_MODES.MISSING_PROFILE
}
