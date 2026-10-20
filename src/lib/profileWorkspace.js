function cleanText(value) {
  return String(value || '').trim()
}

function cleanRole(workspaceProfile = null) {
  return cleanText(workspaceProfile?.memberRole || workspaceProfile?.member_role)
}

function cleanBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return Boolean(value)
}

export function normalizeProfileWorkspaceRef(input = {}) {
  const isCurrentMember = cleanBoolean(
    input?.isCurrentMember
    ?? input?.is_current_member
    ?? (input?.isAdminSession === false || input?.is_admin_session === false),
  )
  return {
    profileId: cleanText(input?.profileId || input?.openclawProfileId || input?.profile_id || input?.openclaw_profile_id),
    profileKey: cleanText(input?.profileKey || input?.openclawProfile || input?.profile_key || input?.openclaw_profile),
    memberId: cleanText(input?.memberId || input?.organizationMemberId || input?.member_id || input?.organization_member_id),
    isCurrentMember,
  }
}

export function profileWorkspaceBasePath(input = {}) {
  const ref = normalizeProfileWorkspaceRef(input)
  if (ref.isCurrentMember) return '/profiles/me'
  if (ref.profileId) return `/profiles/${encodeURIComponent(ref.profileId)}`
  if (ref.profileKey) return `/profiles/key/${encodeURIComponent(ref.profileKey)}`
  return '/profiles/me'
}

export function profileWorkspacePath(input = {}, childPath = '') {
  const basePath = profileWorkspaceBasePath(input)
  const segments = cleanText(childPath)
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
  return segments.length > 0 ? `${basePath}/${segments.join('/')}` : basePath
}

// 工作区首页 = 对话,与 hostWorkspaceHomePath 保持同一个落点。
export function profileWorkspaceHomePath(input = {}, workspaceProfile = null) {
  return profileWorkspacePath(input, 'conversations')
}

export function organizationHomePath(workspaceProfile = null) {
  const role = cleanRole(workspaceProfile)
  if (role === 'owner' || role === 'admin' || role === 'member') return '/profiles/me/conversations'
  return '/setup/organization'
}
