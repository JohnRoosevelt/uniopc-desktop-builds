function normalizeText(value) {
  return String(value || '').trim()
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase()
}

function employeeSource(employee = {}) {
  const row = employee || {}
  const nested = row.employee || {}
  return { row, nested }
}

export function employeeOwnership(employee = {}) {
  const { row, nested } = employeeSource(employee)
  return {
    ownerId: normalizeKey(
      row.owner_id ||
      row.ownerId ||
      nested.owner_id ||
      nested.ownerId,
    ),
    memberId: normalizeKey(
      row.organization_member_id ||
      row.organizationMemberId ||
      row.member_id ||
      row.memberId ||
      nested.organization_member_id ||
      nested.organizationMemberId ||
      nested.member_id ||
      nested.memberId,
    ),
    profileId: normalizeKey(
      row.openclaw_profile_id ||
      row.openclawProfileId ||
      row.profile_id ||
      row.profileId ||
      nested.openclaw_profile_id ||
      nested.openclawProfileId ||
      nested.profile_id ||
      nested.profileId,
    ),
    profile: normalizeKey(
      row.openclaw_profile ||
      row.openclawProfile ||
      row.profile_key ||
      row.profileKey ||
      nested.openclaw_profile ||
      nested.openclawProfile ||
      nested.profile_key ||
      nested.profileKey,
    ),
  }
}

export function workspaceOwnership({ workspaceProfile = null, activeProfile = '' } = {}) {
  return {
    ownerId: normalizeKey(workspaceProfile?.ownerId || workspaceProfile?.owner_id),
    userId: normalizeKey(workspaceProfile?.userId || workspaceProfile?.user_id),
    memberId: normalizeKey(workspaceProfile?.memberId || workspaceProfile?.member_id),
    profileId: normalizeKey(
      workspaceProfile?.openclawProfileId ||
      workspaceProfile?.openclaw_profile_id ||
      workspaceProfile?.profileId ||
      workspaceProfile?.profile_id,
    ),
    profile: normalizeKey(
      activeProfile ||
      workspaceProfile?.openclawProfile ||
      workspaceProfile?.openclaw_profile ||
      workspaceProfile?.profileKey ||
      workspaceProfile?.profile_key,
    ),
  }
}

export function hasEmployeeOwnershipMarker(employee = {}) {
  const ownership = employeeOwnership(employee)
  return Boolean(ownership.ownerId || ownership.memberId || ownership.profileId || ownership.profile)
}

export function isOwnAiEmployee(employee = {}, options = {}) {
  const ownership = employeeOwnership(employee)
  const workspace = workspaceOwnership(options)
  const currentUserId = normalizeKey(options.userId || options.currentUserId || workspace.userId || workspace.ownerId)

  if (ownership.ownerId && currentUserId && ownership.ownerId === currentUserId) return true
  if (ownership.memberId && workspace.memberId && ownership.memberId === workspace.memberId) return true
  if (ownership.profileId && workspace.profileId && ownership.profileId === workspace.profileId) return true
  if (ownership.profile && workspace.profile && ownership.profile === workspace.profile) return true

  return Boolean(options.allowUnscoped && !hasEmployeeOwnershipMarker(employee))
}

export function filterOwnAiEmployees(employees = [], options = {}) {
  return (Array.isArray(employees) ? employees : []).filter(employee => isOwnAiEmployee(employee, options))
}
