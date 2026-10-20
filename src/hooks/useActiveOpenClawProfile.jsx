import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { APP_MODES } from '../lib/appModes'
import { supabase } from '../lib/supabase'
import { loadWorkspaceProfileWithSetup } from '../lib/workspaceBootstrap'
import { useAuth } from './useAuth'

const ActiveOpenClawProfileContext = createContext(null)

// Identity cache (stale-while-revalidate): the cloud bootstrap answers
// "which org / role / profile is this user" — an answer that changes rarely
// but used to serially block every cold start on a Supabase round-trip (and
// dead-end the app on one network hiccup). Returning users now enter with
// the cached identity instantly while the bootstrap revalidates in the
// background; a genuine role change corrects the UI when it lands.
const WORKSPACE_PROFILE_CACHE_PREFIX = 'uniopc.workspaceProfile.v1.'

function readCachedWorkspaceBootstrap(userId) {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(`${WORKSPACE_PROFILE_CACHE_PREFIX}${userId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && parsed.workspaceProfile ? parsed : null
  } catch {
    return null
  }
}

function writeCachedWorkspaceBootstrap(userId, entry) {
  if (!userId) return
  try {
    if (entry?.workspaceProfile) {
      localStorage.setItem(`${WORKSPACE_PROFILE_CACHE_PREFIX}${userId}`, JSON.stringify(entry))
    } else {
      localStorage.removeItem(`${WORKSPACE_PROFILE_CACHE_PREFIX}${userId}`)
    }
  } catch {}
}

function usableProfile(workspaceProfile) {
  const profile = String(workspaceProfile?.openclawProfile || '').trim()
  if (!profile) return ''
  if (workspaceProfile?.profileStatus && workspaceProfile.profileStatus !== 'active') return ''
  return profile
}

function isMissingWorkspaceRpc(error) {
  const status = Number(error?.status || error?.code || 0)
  const message = String(error?.message || error || '').toLowerCase()
  return status === 404
    || message.includes('could not find the function')
    || message.includes('schema cache')
}

function isWorkspaceNetworkError(error) {
  const status = Number(error?.status || 0)
  const message = String(error?.message || error || '').toLowerCase()
  return status === 0
    || message.includes('load failed')
    || message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('network error')
    || message.includes('tls error')
    || message.includes('secure connection')
}

function useActiveOpenClawProfileState(appMode = APP_MODES.HOST) {
  const { user } = useAuth()
  const [workspaceProfile, setWorkspaceProfile] = useState(null)
  const [activeProfile, setActiveProfile] = useState('')
  const [loading, setLoading] = useState(true)
  const [bootstrapStage, setBootstrapStage] = useState('loading_profile')
  const [organizationSetupCompleted, setOrganizationSetupCompleted] = useState(false)
  const [error, setError] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function loadWorkspaceProfile() {
      if (!user?.uid) {
        setWorkspaceProfile(null)
        setActiveProfile('')
        setBootstrapStage('ready')
        setOrganizationSetupCompleted(false)
        setError('')
        setLoading(false)
        return
      }

      const cached = readCachedWorkspaceBootstrap(user.uid)
      if (cached) {
        // Returning user: enter instantly on the cached identity and
        // revalidate against the cloud in the background.
        setWorkspaceProfile(cached.workspaceProfile)
        setActiveProfile(usableProfile(cached.workspaceProfile))
        setOrganizationSetupCompleted(Boolean(cached.organizationSetupCompleted))
        setBootstrapStage('ready')
        setError('')
        setLoading(false)
      } else {
        setLoading(true)
        setBootstrapStage('loading_profile')
        setOrganizationSetupCompleted(false)
        setError('')
      }
      // First-ever bootstrap gets one silent quick retry — the webview's
      // first request through a cold system proxy fails deterministically
      // on some setups; a 2s retry absorbs it without showing the error page.
      let result = null
      let lastError = null
      for (let attempt = 0; attempt < (cached ? 1 : 2); attempt += 1) {
        try {
          result = await loadWorkspaceProfileWithSetup({
            client: supabase,
            ownerId: user.uid,
            appMode,
            onStage: stage => {
              if (!cancelled && !cached) setBootstrapStage(stage)
            },
          })
          lastError = null
          break
        } catch (err) {
          lastError = err
          if (cancelled) return
          if (!cached && attempt === 0 && isWorkspaceNetworkError(err)) {
            await new Promise(resolve => setTimeout(resolve, 2000))
            if (cancelled) return
            continue
          }
          break
        }
      }
      if (cancelled) return
      if (result) {
        const next = result.workspaceProfile
        setWorkspaceProfile(next)
        setActiveProfile(usableProfile(next))
        setOrganizationSetupCompleted(Boolean(result.organizationSetupCompleted))
        setBootstrapStage('ready')
        setError('')
        writeCachedWorkspaceBootstrap(user.uid, {
          workspaceProfile: next,
          organizationSetupCompleted: Boolean(result.organizationSetupCompleted),
        })
      } else if (cached) {
        // Background revalidation failed — keep serving the cached identity.
        console.warn('workspace bootstrap revalidation failed; keeping cached identity', lastError)
      } else {
        const err = lastError
        setWorkspaceProfile(null)
        setActiveProfile('')
        const networkFailed = isWorkspaceNetworkError(err)
        setBootstrapStage(networkFailed ? 'network_failed' : 'failed')
        setOrganizationSetupCompleted(false)
        setError(isMissingWorkspaceRpc(err)
          ? ''
          : networkFailed
            ? '当前账号暂未获得 Uniopc 引擎访问权限。请联系平台管理员为账号开通组织与引擎权限；授权完成后点击“重试”重新检查。'
            : String(err?.message || err || '读取 Uniopc 引擎 profile 失败'))
      }
      if (!cancelled) setLoading(false)
    }

    loadWorkspaceProfile()

    return () => {
      cancelled = true
    }
  }, [appMode, refreshNonce, user?.uid])

  const refreshWorkspaceProfile = useCallback(() => {
    setRefreshNonce(value => value + 1)
  }, [])

  return useMemo(() => ({
    activeProfile,
    workspaceProfile,
    loading,
    bootstrapStage,
    organizationSetupCompleted,
    error,
    refreshWorkspaceProfile,
    hasProfile: Boolean(activeProfile),
    isOwner: Boolean(workspaceProfile?.isOwner),
    isAdmin: Boolean(workspaceProfile?.isAdmin),
  }), [
    activeProfile,
    bootstrapStage,
    error,
    loading,
    organizationSetupCompleted,
    refreshWorkspaceProfile,
    workspaceProfile,
  ])
}

export function ActiveOpenClawProfileProvider({ children, appMode = APP_MODES.HOST }) {
  const value = useActiveOpenClawProfileState(appMode)
  return (
    <ActiveOpenClawProfileContext.Provider value={value}>
      {children}
    </ActiveOpenClawProfileContext.Provider>
  )
}

export function useActiveOpenClawProfile() {
  return useContext(ActiveOpenClawProfileContext) || useActiveOpenClawProfileState()
}
