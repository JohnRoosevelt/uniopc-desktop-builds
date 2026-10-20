export function normalizeAuthUser(authUser) {
  return {
    ...authUser,
    uid: authUser.id,
    email: authUser.email || authUser.user_metadata?.email || '',
    displayName: authUser.user_metadata?.display_name || authUser.email || '',
  }
}

export function buildProfileFromAuthUser(authUser = {}) {
  const user = normalizeAuthUser(authUser)
  const metadata = user.user_metadata || {}
  const email = user.email || ''
  const nickname = metadata.nickname || metadata.display_name || email || 'user'
  return {
    ...user,
    id: user.uid,
    uid: user.uid,
    email,
    nickname,
    avatar_url: metadata.avatar_url || metadata.picture || null,
    phone: user.phone || metadata.phone || null,
    invited_by: metadata.invited_by || null,
  }
}

export function buildLocalUserPayload(profile = {}) {
  return {
    uid: profile.uid || profile.id,
    nickname: profile.nickname || profile.email || 'user',
    phone: profile.phone || null,
    invitedBy: profile.invited_by || null,
  }
}

export async function syncLocalUserBestEffort(invokeFn, profile, options = {}) {
  void invokeFn
  void profile
  void options
  return null
}
