import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase, callSupabaseFunction } from '../lib/supabase'
import { invoke } from '@tauri-apps/api/core'
import { buildProfileFromAuthUser, normalizeAuthUser, syncLocalUserBestEffort } from '../lib/authProfile'
import { assertPhoneRegistrationAllowed } from '../lib/registrationGate'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(false)
  const currentUidRef = useRef(null)
  const profileRef = useRef(null)
  const authVersionRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true

    const checkAuth = async () => {
      try {
        const { data } = await supabase.auth.getSession()
        await applySessionUser(data.session?.user || null)
      } catch (e) {
        if (mountedRef.current) setLoading(false)
      }
    }

    checkAuth()

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      const sessionUser = session?.user || null
      setTimeout(() => {
        applySessionUser(sessionUser).catch(() => {
          if (mountedRef.current) setLoading(false)
        })
      }, 0)
    })

    return () => {
      mountedRef.current = false
      authVersionRef.current += 1
      authListener?.subscription?.unsubscribe()
    }
  }, [])

  async function applySessionUser(sessionUser) {
    if (!mountedRef.current) return
    if (!sessionUser) {
      clearCurrentUser()
      setUser(null)
      profileRef.current = null
      setProfile(null)
      setLoading(false)
      return
    }

    const nextUser = normalizeAuthUser(sessionUser)
    const hasCurrentProfile =
      currentUidRef.current === nextUser.uid && profileRef.current?.uid === nextUser.uid
    if (!hasCurrentProfile) setLoading(true)
    const authVersion = setCurrentUser(nextUser)
    await loadOrCreateProfile(nextUser, authVersion)
    if (isCurrentAuth(nextUser.uid, authVersion)) {
      setLoading(false)
    }
  }

  function setCurrentUser(nextUser) {
    const sameUser = currentUidRef.current === nextUser.uid
    currentUidRef.current = nextUser.uid
    authVersionRef.current += 1
    if (!sameUser) {
      profileRef.current = null
      setProfile(null)
    }
    setUser(nextUser)
    return authVersionRef.current
  }

  function clearCurrentUser() {
    currentUidRef.current = null
    authVersionRef.current += 1
  }

  function isCurrentAuth(expectedUid, authVersion) {
    return mountedRef.current && currentUidRef.current === expectedUid && authVersionRef.current === authVersion
  }

  async function syncLocalUser(p) {
    await syncLocalUserBestEffort(invoke, p)
  }

  async function loadProfile(authUser, authVersion = authVersionRef.current) {
    const p = buildProfileFromAuthUser(authUser)
    if (!isCurrentAuth(p.uid, authVersion)) return null

    profileRef.current = p
    setProfile(p)
    void syncLocalUser(p)
    return p
  }

  async function loadOrCreateProfile(authUser, authVersion = authVersionRef.current) {
    return await loadProfile(authUser, authVersion)
  }

  // 手机号 + 短信验证码：先按已有账号登录，避免 GoTrue 对已注册手机号再次
  // 执行 handle_new_user。只有明确不存在时才检查新用户注册门禁。
  async function requestPhoneOtp(phone) {
    try {
      const loginAttempt = await supabase.auth.signInWithOtp({
        phone,
        options: { shouldCreateUser: false },
      })
      if (!loginAttempt.error) return { error: null }

      const loginErrorText = String(loginAttempt.error.message || '').toLowerCase()
      if (!/user.*not.*found|not.*registered|signup/i.test(loginErrorText)) {
        throw loginAttempt.error
      }

      await assertPhoneRegistrationAllowed(supabase, phone)
      const { error } = await supabase.auth.signInWithOtp({
        phone,
        options: { shouldCreateUser: true },
      })
      if (error) throw error
      return { error: null }
    } catch (e) {
      return { error: e }
    }
  }

  // 手机号 + 短信验证码：校验验证码完成登录/注册
  async function verifyPhoneOtp(phone, token) {
    try {
      const { data, error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' })
      if (error) throw error
      const nextUser = normalizeAuthUser(data.user)
      const authVersion = setCurrentUser(nextUser)
      const nextProfile = await loadOrCreateProfile(nextUser, authVersion)
      return { error: null, profile: nextProfile }
    } catch (e) {
      return { error: e }
    }
  }

  async function signOut() {
    clearCurrentUser()
    // Stop the logged-out account's local engine and forget the active marker
    // before clearing the session: otherwise the gateway child keeps running on
    // the previous account's state/<key> and active-profile.json still points at
    // it until the next login's warmup respawns. Best-effort — a failure (or
    // running outside the Tauri shell) must not block the auth sign-out.
    try {
      await invoke('openclaw_logout_active_profile')
    } catch {}
    await supabase.auth.signOut({ scope: 'local' })
    setUser(null)
    profileRef.current = null
    setProfile(null)
  }

  async function refreshUpdatedSessionUser(expectedUid) {
    try {
      const { data, error } = await supabase.auth.refreshSession()
      if (error) return null
      const sessionUser = data.session?.user
      if (sessionUser?.id !== expectedUid) return null
      return normalizeAuthUser(sessionUser)
    } catch {
      return null
    }
  }

  async function updateProfile(data) {
    const result = await callSupabaseFunction('update-profile', data)
    if (!result?.profile) throw new Error('资料更新失败')

    const nextProfile = { ...result.profile, uid: result.profile.id }
    if (currentUidRef.current !== nextProfile.uid || !mountedRef.current) {
      throw new Error('登录状态已变化，请重新操作')
    }

    const refreshedUser = await refreshUpdatedSessionUser(nextProfile.uid)
    const nextUserSource = result.user || refreshedUser
    const nextUser = nextUserSource?.id === nextProfile.uid ? normalizeAuthUser(nextUserSource) : refreshedUser
    if (nextUser) setUser(nextUser)

    profileRef.current = nextProfile
    setProfile(nextProfile)
    void syncLocalUser(nextProfile)
  }

  async function refreshProfile() {
    const currentUid = currentUidRef.current
    if (!currentUid) return null
    const { data } = await supabase.auth.getSession()
    const sessionUser = data.session?.user
    if (sessionUser?.id === currentUid) {
      return await loadProfile(sessionUser, authVersionRef.current)
    }
    return profileRef.current
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, requestPhoneOtp, verifyPhoneOtp, signOut, updateProfile, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
