import { createContext, useContext, useEffect, useMemo } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useActiveOpenClawProfile } from './useActiveOpenClawProfile'

const ProfileWorkspaceContext = createContext(null)
const PROFILE_WORKSPACE_CACHE_PREFIX = 'imai.profileWorkspace.v1'

function clean(value = '') {
  return String(value || '').trim()
}

function normalizeRuntimeMode(value = '') {
  return 'member_local'
}

function resolveRequestedProfileRef(params = {}, activeProfile = '') {
  const raw = clean(params.profileRef)
  if (!raw || raw === 'me') return { kind: 'current', value: clean(activeProfile) }
  return { kind: 'profile_id', value: raw }
}

function profileWorkspaceCacheKey(profileId = '') {
  const id = clean(profileId)
  return id ? `${PROFILE_WORKSPACE_CACHE_PREFIX}:${id}` : ''
}

function cacheableProfileWorkspaceState(state = null) {
  const targetOpenClawProfileId = clean(state?.targetOpenClawProfileId)
  const targetOpenClawProfile = clean(state?.targetOpenClawProfile)
  if (!targetOpenClawProfileId || !targetOpenClawProfile) return null
  return {
    targetMemberId: clean(state?.targetMemberId),
    targetUserId: clean(state?.targetUserId || state?.target_user_id),
    targetMemberRole: clean(state?.targetMemberRole),
    targetOpenClawProfileId,
    targetOpenClawProfile,
    targetRuntimeMode: normalizeRuntimeMode(state?.targetRuntimeMode || state?.runtimeMode || state?.runtime_mode),
    targetGatewayPort: state?.targetGatewayPort || null,
    targetDisplayName: clean(state?.targetDisplayName),
  }
}

function readCachedProfileWorkspaceState(profileId = '') {
  const key = profileWorkspaceCacheKey(profileId)
  if (!key || typeof window === 'undefined' || !window.sessionStorage) return null
  try {
    return cacheableProfileWorkspaceState(JSON.parse(window.sessionStorage.getItem(key) || 'null'))
  } catch {
    return null
  }
}

function writeCachedProfileWorkspaceState(state = null) {
  const cached = cacheableProfileWorkspaceState(state)
  if (!cached || typeof window === 'undefined' || !window.sessionStorage) return
  try {
    window.sessionStorage.setItem(
      profileWorkspaceCacheKey(cached.targetOpenClawProfileId),
      JSON.stringify(cached),
    )
  } catch {
    // ignore session storage failures
  }
}

export function ProfileWorkspaceProvider({ children }) {
  const params = useParams()
  const location = useLocation()
  const active = useActiveOpenClawProfile()
  const profileWorkspaceState = location.state?.profileWorkspace || null
  const requested = useMemo(
    () => resolveRequestedProfileRef(params, active.activeProfile),
    [active.activeProfile, params.profileRef],
  )
  const cachedProfileWorkspaceState = useMemo(
    () => requested.kind === 'profile_id' ? readCachedProfileWorkspaceState(requested.value) : null,
    [requested],
  )
  useEffect(() => {
    writeCachedProfileWorkspaceState(profileWorkspaceState)
  }, [profileWorkspaceState])
  const value = useMemo(() => {
    const workspaceProfile = active.workspaceProfile
    const isAdminSession = requested.kind !== 'current'
    const operatorMemberId = clean(workspaceProfile?.memberId || workspaceProfile?.member_id)
    const operatorOrganizationId = clean(workspaceProfile?.organizationId || workspaceProfile?.organization_id)
    const operatorOrganizationName = clean(workspaceProfile?.organizationName || workspaceProfile?.organization_name)
    const operatorOrganizationTypeId = clean(workspaceProfile?.organizationTypeId || workspaceProfile?.organization_type_id)
    const operatorOrganizationTypeKey = clean(workspaceProfile?.organizationTypeKey || workspaceProfile?.organization_type_key)
    const operatorOrganizationTypeName = clean(workspaceProfile?.organizationTypeName || workspaceProfile?.organization_type_name)
    const operatorOwnerId = clean(workspaceProfile?.ownerId || workspaceProfile?.owner_id)
    const operatorUserId = clean(workspaceProfile?.userId || workspaceProfile?.user_id)
    const operatorOpenClawProfileId = clean(workspaceProfile?.openclawProfileId || workspaceProfile?.openclaw_profile_id)
    const operatorOpenClawProfile = clean(active.activeProfile || workspaceProfile?.openclawProfile || workspaceProfile?.openclaw_profile)

    const currentTarget = {
      targetMemberId: operatorMemberId,
      targetUserId: operatorUserId,
      targetMemberRole: clean(workspaceProfile?.memberRole || workspaceProfile?.member_role),
      targetOpenClawProfileId: operatorOpenClawProfileId,
      targetOpenClawProfile: operatorOpenClawProfile,
      targetRuntimeMode: normalizeRuntimeMode(workspaceProfile?.runtimeMode || workspaceProfile?.runtime_mode),
      targetGatewayPort: workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null,
      targetDisplayName: clean(
        workspaceProfile?.displayName
        || workspaceProfile?.display_name
        || workspaceProfile?.memberEmail
        || workspaceProfile?.member_email,
      ),
    }
    const adminTarget = {
      targetMemberId: clean(profileWorkspaceState?.targetMemberId || cachedProfileWorkspaceState?.targetMemberId),
      targetUserId: clean(profileWorkspaceState?.targetUserId || profileWorkspaceState?.target_user_id || cachedProfileWorkspaceState?.targetUserId),
      targetMemberRole: clean(profileWorkspaceState?.targetMemberRole || cachedProfileWorkspaceState?.targetMemberRole),
      targetOpenClawProfileId: clean(profileWorkspaceState?.targetOpenClawProfileId || cachedProfileWorkspaceState?.targetOpenClawProfileId)
        || (requested.kind === 'profile_id' ? requested.value : ''),
      targetOpenClawProfile: clean(profileWorkspaceState?.targetOpenClawProfile)
        || clean(cachedProfileWorkspaceState?.targetOpenClawProfile)
        || (requested.kind === 'profile_id' && requested.value === operatorOpenClawProfileId
          ? operatorOpenClawProfile
          : ''),
      targetRuntimeMode: normalizeRuntimeMode(
        profileWorkspaceState?.targetRuntimeMode
        || cachedProfileWorkspaceState?.targetRuntimeMode
        || profileWorkspaceState?.runtimeMode
        || profileWorkspaceState?.runtime_mode,
      ),
      targetGatewayPort: profileWorkspaceState?.targetGatewayPort || cachedProfileWorkspaceState?.targetGatewayPort || null,
      targetDisplayName: clean(profileWorkspaceState?.targetDisplayName || cachedProfileWorkspaceState?.targetDisplayName),
    }
    const target = isAdminSession ? adminTarget : currentTarget

    return {
      requested,
      activeProfile: isAdminSession ? target.targetOpenClawProfile : active.activeProfile,
      workspaceProfile,
      loading: active.loading,
      error: active.error,
      isAdminSession,
      operatorMemberId,
      operatorOpenClawProfileId,
      operatorOpenClawProfile,
      organizationId: operatorOrganizationId,
      organization_id: operatorOrganizationId,
      organizationName: operatorOrganizationName,
      organization_name: operatorOrganizationName,
      organizationTypeId: operatorOrganizationTypeId,
      organization_type_id: operatorOrganizationTypeId,
      organizationTypeKey: operatorOrganizationTypeKey,
      organization_type_key: operatorOrganizationTypeKey,
      organizationTypeName: operatorOrganizationTypeName,
      organization_type_name: operatorOrganizationTypeName,
      ownerId: operatorOwnerId,
      owner_id: operatorOwnerId,
      userId: operatorUserId,
      user_id: operatorUserId,
      memberId: target.targetMemberId,
      targetUserId: target.targetUserId,
      memberRole: target.targetMemberRole,
      runtimeMode: target.targetRuntimeMode,
      runtime_mode: target.targetRuntimeMode,
      openclawProfileId: target.targetOpenClawProfileId,
      openclawProfile: target.targetOpenClawProfile,
      gateway_port: target.targetGatewayPort,
      targetMemberId: target.targetMemberId,
      memberUserId: target.targetUserId,
      member_user_id: target.targetUserId,
      targetMemberRole: target.targetMemberRole,
      targetOpenClawProfileId: target.targetOpenClawProfileId,
      targetOpenClawProfile: target.targetOpenClawProfile,
      targetRuntimeMode: target.targetRuntimeMode,
      targetGatewayPort: target.targetGatewayPort,
      gatewayPort: target.targetGatewayPort,
      targetDisplayName: target.targetDisplayName,
    }
  }, [
    active.activeProfile,
    active.error,
    active.loading,
    active.workspaceProfile,
    cachedProfileWorkspaceState,
    profileWorkspaceState,
    requested,
  ])

  return (
    <ProfileWorkspaceContext.Provider value={value}>
      {children}
    </ProfileWorkspaceContext.Provider>
  )
}

export function useProfileWorkspace() {
  return useContext(ProfileWorkspaceContext)
}

export function profileWorkspaceNavigationState(profileWorkspace = null) {
  if (!profileWorkspace?.isAdminSession) return undefined
  return {
    profileWorkspace: {
      targetMemberId: profileWorkspace.targetMemberId || profileWorkspace.memberId || '',
      targetUserId: profileWorkspace.targetUserId || profileWorkspace.memberUserId || profileWorkspace.member_user_id || '',
      targetMemberRole: profileWorkspace.targetMemberRole || profileWorkspace.memberRole || '',
      targetOpenClawProfileId: profileWorkspace.targetOpenClawProfileId || profileWorkspace.openclawProfileId || '',
      targetOpenClawProfile: profileWorkspace.targetOpenClawProfile || profileWorkspace.openclawProfile || '',
      targetRuntimeMode: normalizeRuntimeMode(profileWorkspace.targetRuntimeMode || profileWorkspace.runtimeMode || profileWorkspace.runtime_mode),
      targetGatewayPort: profileWorkspace.targetGatewayPort || profileWorkspace.gatewayPort || null,
      targetDisplayName: profileWorkspace.targetDisplayName || '',
    },
  }
}
