import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { AuthProvider, useAuth } from './hooks/useAuth'
import Layout from './components/Layout'
import Login from './pages/Login'
import Conversations from './pages/Conversations'
import { ActiveOpenClawProfileProvider, useActiveOpenClawProfile } from './hooks/useActiveOpenClawProfile'
import { ProfileWorkspaceProvider, profileWorkspaceNavigationState } from './hooks/useProfileWorkspace'
import { blockedAuthenticatedAppMessage, canEnterAuthenticatedApp } from './lib/authGate'
import { APP_MODES } from './lib/appModes'
import { hostWorkspaceHomePath } from './lib/hostWorkspaceEntry'
import { fetchOpenClawEmployees } from './lib/openclawEmployees'
import EngineStatusStrip from './components/EngineStatusStrip'
import LocalEngineBootstrap from './components/LocalEngineBootstrap'
import OfficialModelBootstrap from './components/OfficialModelBootstrap'
import { isGatewayAuthBlockedSnapshot } from './lib/gatewayErrors'
import { shouldRequireLocalOpenClawSetup } from './lib/openclawAccess'
import { LOCAL_ASSISTANT_LAUNCH_PATH, shouldOpenLocalAssistantLaunch } from './lib/localAssistantLaunch'
import { profileWorkspacePath } from './lib/profileWorkspace'
import {
  getGatewayConnectionSnapshot,
  isGatewayConnectionReady,
  refreshGatewayConnectionSnapshot,
  refreshOpenClawStatus,
  useRuntimeStatusStore,
} from './lib/runtimeStatus'
import { supabase } from './lib/supabase'
import { syncMyCloudAiEmployees } from './lib/cloudWorkspace'
import BootSplash from './components/BootSplash'
import { lazyPage } from './lib/lazyPage'

const Settings = lazyPage(() => import('./pages/Settings'))
const ModelSettings = lazyPage(() => import('./pages/ModelSettings'))
const CloudDocuments = lazyPage(() => import('./pages/CloudDocuments'))
const Automations = lazyPage(() => import('./pages/Automations'))
const MobileConnect = lazyPage(() => import('./pages/MobileConnect'))
const Operations = lazyPage(() => import('./pages/Operations'))
const OpenClawRuntime = lazyPage(() => import('./pages/OpenClawRuntime'))
const PlatformDiagnostics = lazyPage(() => import('./pages/PlatformDiagnostics'))
const HostPermissions = lazyPage(() => import('./pages/HostPermissions'))
const McpHub = lazyPage(() => import('./pages/McpHub'))
const Apps = lazyPage(() => import('./pages/Apps'))
const MontageApp = lazyPage(() => import('./pages/apps/MontageApp'))
const SuperIpApp = lazyPage(() => import('./pages/apps/SuperIpApp'))
const PublicTrafficApp = lazyPage(() => import('./pages/apps/PublicTrafficApp'))
const PrivateConversionApp = lazyPage(() => import('./pages/apps/PrivateConversionApp'))
const Employees = lazyPage(() => import('./pages/Employees'))
const CreateOrganization = lazyPage(() => import('./pages/CreateOrganization'))
const OpenClawSetupGate = lazyPage(() => import('./pages/OpenClawSetupGate'))
const LocalAssistantLaunch = lazyPage(() => import('./pages/LocalAssistantLaunch'))

const OPENCLAW_GUARD_PROFILE_STATUS_TIMEOUT_MS = 12000
// At cold boot the gateway is often mid-startup (sidecar child spawn,
// background warm-up provision): the first probe reads "connection refused"
// even though the port is a second away from binding. Give it a short grace
// window of re-probes before the guard concludes not-ready and redirects to
// the setup gate carrying that transient error.
const OPENCLAW_GUARD_PROBE_ATTEMPTS = 3
const OPENCLAW_GUARD_PROBE_RETRY_DELAY_MS = 1000
// Background observation cadence while the engine is not ready: fast for the
// first ~2 minutes (install/boot window), then a relaxed heartbeat.
const ENGINE_NOT_READY_POLL_FAST_MS = 2500
const ENGINE_NOT_READY_POLL_SLOW_MS = 15000
const ENGINE_NOT_READY_POLL_FAST_ATTEMPTS = 48

function guardProbeDelay(ms) {
  return new Promise(resolve => {
    globalThis.setTimeout(resolve, ms)
  })
}

function AuthGuard({ children }) {
  const { user, profile, loading } = useAuth()
  const { t } = useTranslation()
  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-400">{t('common.loading')}</div>
  if (!canEnterAuthenticatedApp({ user, profile })) return <Navigate to="/login" replace />
  return children
}

function WrongAppModeRedirect({ message }) {
  const { signOut } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    let active = true
    try { sessionStorage.setItem('imai.auth.modeError', message) } catch {}
    Promise.resolve(signOut()).finally(() => {
      if (active) navigate('/login', { replace: true, state: { authError: message } })
    })
    return () => {
      active = false
    }
  }, [])

  return (
    <BootSplash
      title="正在切换登录入口"
      detail={message}
    />
  )
}

function normalizeWorkspaceRole(workspaceProfile = null) {
  return String(workspaceProfile?.memberRole || workspaceProfile?.member_role || '').trim()
}

function clean(value = '') {
  return String(value || '').trim()
}

function isProfileWorkspacePath(pathname = '') {
  return String(pathname || '').startsWith('/profiles/')
}

function profileWorkspaceRefFromPath(pathname = '') {
  const match = String(pathname || '').match(/^\/profiles\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

function workspaceHomePath({ workspaceProfile = null } = {}) {
  return hostWorkspaceHomePath(workspaceProfile)
}

function HostHomeRedirect() {
  const { workspaceProfile } = useActiveOpenClawProfile()
  return <Navigate to={hostWorkspaceHomePath(workspaceProfile)} replace />
}

function ProfileWorkspaceRedirect({ childPath, query = '' }) {
  const location = useLocation()
  const search = query || location.search || ''
  const profileRef = profileWorkspaceRefFromPath(location.pathname)
  const workspaceRef = profileRef
    ? { isCurrentMember: profileRef === 'me', openclawProfileId: profileRef === 'me' ? '' : profileRef }
    : { isCurrentMember: true }
  const target = `${profileWorkspacePath(workspaceRef, childPath)}${search}`
  return <Navigate to={target} replace state={location.state} />
}

function profileWorkspaceElement(child) {
  return <ProfileWorkspaceProvider>{child}</ProfileWorkspaceProvider>
}

function ProfileSettingsRedirect() {
  const location = useLocation()
  const profileWorkspaceState = location.state?.profileWorkspace || null
  const profileRef = profileWorkspaceRefFromPath(location.pathname)
  const isCurrentMember = profileRef === 'me'
  const target = profileWorkspacePath({
    openclawProfileId: profileWorkspaceState?.targetOpenClawProfileId || (!isCurrentMember ? profileRef : ''),
    isCurrentMember,
  }, 'settings/general')
  const state = profileWorkspaceNavigationState({
    ...(profileWorkspaceState || {}),
    isAdminSession: !isCurrentMember,
  })

  return <Navigate to={target} replace state={state} />
}

function profileWorkspaceFallbackPath(workspaceProfile = null) {
  return normalizeWorkspaceRole(workspaceProfile) ? '/profiles/me/conversations' : '/setup/organization'
}

function WorkspaceBootstrap({ children, appMode }) {
  const activeOpenClaw = useActiveOpenClawProfile()
  const { signOut } = useAuth()
  const navigate = useNavigate()
  const [switchingAccount, setSwitchingAccount] = useState(false)

  async function returnToLogin() {
    if (switchingAccount) return
    setSwitchingAccount(true)
    try {
      await signOut()
    } finally {
      navigate('/login', { replace: true })
    }
  }

  function workspaceBootstrapTitle(activeOpenClaw) {
    if (String(activeOpenClaw.error || '').includes('登录状态已过期')) return '登录状态已过期'
    if (activeOpenClaw.bootstrapStage === 'network_failed') return '暂未获得访问权限'
    return '组织开通未完成'
  }

  if (activeOpenClaw.loading) {
    return (
      <BootSplash
        title={activeOpenClaw.bootstrapStage === 'initializing_organization'
          ? '正在完成组织开通'
          : '正在检查账号开通状态'}
        detail={activeOpenClaw.bootstrapStage === 'initializing_organization'
          ? '正在根据代理提交并由平台审核通过的信息，绑定组织空间和 Owner 身份。'
          : '正在确认当前账号是 Owner、Admin 还是 Member。'}
      />
    )
  }
  if (activeOpenClaw.error) {
    return (
      <BootSplash
        title={workspaceBootstrapTitle(activeOpenClaw)}
        detail={activeOpenClaw.error}
        actions={[
          {
            key: 'return-to-login',
            label: switchingAccount ? '正在返回登录页…' : '返回登录页',
            disabled: switchingAccount,
            onClick: returnToLogin,
          },
          {
            key: 'retry-workspace-bootstrap',
            label: '重试',
            onClick: () => activeOpenClaw.refreshWorkspaceProfile(),
          },
        ]}
      />
    )
  }
  return children
}

function WorkspaceRoleGuard({ children, appMode = APP_MODES.HOST }) {
  const location = useLocation()
  const { user } = useAuth()
  const activeOpenClaw = useActiveOpenClawProfile()
  const workspaceProfile = activeOpenClaw.workspaceProfile
  if (!canEnterAuthenticatedApp({ user, workspaceProfile, appMode })) {
    return (
      <WrongAppModeRedirect
        message={blockedAuthenticatedAppMessage({ workspaceProfile, appMode })}
      />
    )
  }

  if (location.pathname === '/create-organization') {
    return <Navigate to="/setup/organization" replace />
  }

  if (location.pathname === '/setup/organization') {
    const homePath = workspaceHomePath({ workspaceProfile })
    if (homePath !== '/setup/organization') {
      return <Navigate to={homePath} replace />
    }
  }

  return children
}

function openClawGuardTimeoutError(message) {
  const error = new Error(message)
  error.code = 'openclaw_guard_timeout'
  return error
}

function isOpenClawGuardTimeoutError(error) {
  return error?.code === 'openclaw_guard_timeout'
}

function withOpenClawGuardTimeout(promise, timeoutMs, message) {
  let timeoutId = null
  const timeout = new Promise((_, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      reject(openClawGuardTimeoutError(message))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) globalThis.clearTimeout(timeoutId)
  })
}

function isProfileOpenClawAppReady(status, connectionSnapshot) {
  return Boolean(
    status?.installed &&
    status?.supported !== false &&
    isGatewayConnectionReady(connectionSnapshot),
  )
}

function gatewayGuardErrorMessage(connectionSnapshot) {
  if (!connectionSnapshot) return ''
  const raw = [
    connectionSnapshot.error,
    connectionSnapshot.message,
    connectionSnapshot.statusMessage,
    connectionSnapshot.status_message,
  ].filter(Boolean).join('\n')
  return raw || ''
}

function shouldBypassGatewayGuardInDev(connectionSnapshot) {
  if (!import.meta.env.DEV) return false
  return isGatewayAuthBlockedSnapshot(connectionSnapshot)
}

function OpenClawGuard({ children, appMode = APP_MODES.HOST }) {
  const location = useLocation()
  const { user } = useAuth()
  const runtime = useRuntimeStatusStore()
  const activeOpenClaw = useActiveOpenClawProfile()
  const [checked, setChecked] = useState(false)
  const agentDirectorySyncInFlight = useRef('')
  const profileWorkspaceState = location.state?.profileWorkspace || null
  const profileWorkspaceRef = profileWorkspaceRefFromPath(location.pathname)
  // One machine, one engine: hosting another member's engine locally
  // (/profiles/<other>) is retired — member data lives on the member's own
  // machine; admins manage members through cloud data instead.
  const inRetiredAdminProfileWorkspace = Boolean(profileWorkspaceRef && profileWorkspaceRef !== 'me')
  const workspaceProfile = activeOpenClaw.workspaceProfile
  const requiresLocalOpenClaw = shouldRequireLocalOpenClawSetup(workspaceProfile, { appMode })
  const activeProfile = activeOpenClaw.activeProfile
  const gatewayPort = workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null
  const organizationId = workspaceProfile?.organizationId || workspaceProfile?.organization_id || ''
  const workspaceProfileStatus = workspaceProfile?.profileStatus || workspaceProfile?.profile_status || ''
  const connectionSnapshot = getGatewayConnectionSnapshot(activeProfile, gatewayPort)
  const openClawReady = isProfileOpenClawAppReady(runtime.openClaw.status, connectionSnapshot)
  const cachedGuardReady = requiresLocalOpenClaw ? openClawReady : true
  const profileWorkspaceNavState = profileWorkspaceNavigationState({
    ...(profileWorkspaceState || {}),
    isAdminSession: false,
  })

  useEffect(() => {
    let active = true
    setChecked(cachedGuardReady)
    if (!requiresLocalOpenClaw) {
      setChecked(true)
      return () => {
        active = false
      }
    }
    async function refreshOpenClawGuardStatus() {
      if (requiresLocalOpenClaw) {
        await refreshOpenClawStatus()
      }
      if (!activeProfile) return
      for (let attempt = 0; attempt < OPENCLAW_GUARD_PROBE_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await guardProbeDelay(OPENCLAW_GUARD_PROBE_RETRY_DELAY_MS)
        if (!active) return
        try {
          const snapshot = await withOpenClawGuardTimeout(
            refreshGatewayConnectionSnapshot({ profile: activeProfile, gatewayPort }),
            OPENCLAW_GUARD_PROFILE_STATUS_TIMEOUT_MS,
            `检测 Uniopc 引擎 profile ${activeProfile} 超时`,
          )
          if (isGatewayConnectionReady(snapshot)) return
          // Auth mismatch needs the gate's circuit breaker; re-probing only
          // delays that. Everything else gets the remaining grace attempts.
          if (isGatewayAuthBlockedSnapshot(snapshot)) return
        } catch (error) {
          if (isOpenClawGuardTimeoutError(error)) {
            return
          }
          throw error
        }
      }
    }

    refreshOpenClawGuardStatus()
      .catch(() => null)
      .finally(() => {
        if (active) setChecked(true)
      })
    return () => {
        active = false
      }
  }, [activeProfile, cachedGuardReady, gatewayPort, requiresLocalOpenClaw])

  const openClawSupported = runtime.openClaw.status?.supported !== false

  // While the engine is not ready the guard keeps observing in the background
  // so the status strip disappears the moment the gateway is confirmed.
  useEffect(() => {
    if (!requiresLocalOpenClaw || !activeProfile || openClawReady) return undefined
    let cancelled = false
    let timer = null
    let attempts = 0
    const poll = async () => {
      if (cancelled) return
      attempts += 1
      try {
        await refreshOpenClawStatus({ silent: true })
        if (cancelled) return
        await refreshGatewayConnectionSnapshot({ profile: activeProfile, gatewayPort, silent: true })
      } catch {
        // Keep observing; transient probe failures are the normal case here.
      }
      if (cancelled) return
      timer = globalThis.setTimeout(
        poll,
        attempts < ENGINE_NOT_READY_POLL_FAST_ATTEMPTS
          ? ENGINE_NOT_READY_POLL_FAST_MS
          : ENGINE_NOT_READY_POLL_SLOW_MS,
      )
    }
    timer = globalThis.setTimeout(poll, ENGINE_NOT_READY_POLL_FAST_MS)
    return () => {
      cancelled = true
      if (timer) globalThis.clearTimeout(timer)
    }
  }, [activeProfile, gatewayPort, openClawReady, requiresLocalOpenClaw])
  useEffect(() => {
    if (!user?.uid || !activeProfile || !openClawReady || !organizationId) return undefined
    if (workspaceProfileStatus && workspaceProfileStatus !== 'active') return undefined
    const syncKey = `${user.uid}:${activeProfile}:${organizationId}`
    if (agentDirectorySyncInFlight.current === syncKey) return undefined

    agentDirectorySyncInFlight.current = syncKey
    fetchOpenClawEmployees({
      profile: activeProfile,
      syncCloudEmployees: items => syncMyCloudAiEmployees(supabase, user.uid, items),
    }).catch(error => {
      console.warn('Failed to sync Uniopc 引擎 agents to cloud', error)
      if (agentDirectorySyncInFlight.current === syncKey) {
        agentDirectorySyncInFlight.current = ''
      }
    })
    return undefined
  }, [activeProfile, openClawReady, organizationId, supabase, user?.uid, workspaceProfileStatus])

  if (inRetiredAdminProfileWorkspace) {
    return <Navigate to={profileWorkspaceFallbackPath(workspaceProfile)} replace />
  }

  // Engine readiness never blocks entry (Accio-style): the app renders
  // immediately while local startup runs quietly in the background.
  // Full-screen setup remains only for states that genuinely need the user:
  // an incompatible runtime and the gateway auth circuit breaker.
  const engineAuthBlocked = isGatewayAuthBlockedSnapshot(connectionSnapshot)
  const engineUnsupported = Boolean(runtime.openClaw.status) && !openClawSupported
  if (
    requiresLocalOpenClaw &&
    checked &&
    !openClawReady &&
    (engineAuthBlocked || engineUnsupported) &&
    !shouldBypassGatewayGuardInDev(connectionSnapshot)
  ) {
    return (
      <Navigate
        to="/setup/openclaw"
        replace
        state={{
          from: `${location.pathname}${location.search}${location.hash}`,
          gatewayError: gatewayGuardErrorMessage(connectionSnapshot),
          gatewayErrorCode: connectionSnapshot?.lastErrorCode || '',
          ...profileWorkspaceNavState,
        }}
      />
    )
  }

  if (shouldOpenLocalAssistantLaunch({
    requiresLocalOpenClaw,
    ready: openClawReady,
    pathname: location.pathname,
  })) {
    return (
      <Navigate
        to={LOCAL_ASSISTANT_LAUNCH_PATH}
        replace
        state={{
          from: `${location.pathname}${location.search}${location.hash}`,
          ...profileWorkspaceNavState,
        }}
      />
    )
  }

  return children
}

function SignedInRuntime({ children, appMode }) {
  const { user } = useAuth()
  // Remount identity state immediately on account change, including logout.
  // No render may expose the previous account's cached Profile to consumers.
  return (
    <ActiveOpenClawProfileProvider key={user?.uid || 'signed-out'} appMode={appMode}>
      <LocalEngineBootstrap />
      <OfficialModelBootstrap />
      <EngineStatusStrip />
      {children}
    </ActiveOpenClawProfileProvider>
  )
}

export default function App() {
  const appMode = APP_MODES.HOST
  const workspaceShell = (children, { includeOpenClawGuard = true } = {}) => (
    <AuthGuard>
      <WorkspaceBootstrap appMode={appMode}>
        <WorkspaceRoleGuard appMode={appMode}>
          {includeOpenClawGuard
            ? <OpenClawGuard appMode={appMode}>{children}</OpenClawGuard>
            : children}
        </WorkspaceRoleGuard>
      </WorkspaceBootstrap>
    </AuthGuard>
  )
  return (
    <HashRouter>
      <AuthProvider>
        <SignedInRuntime appMode={appMode}>
          <Routes>
            <Route path="/login" element={<Login appMode={appMode} />} />
            <Route path="/setup/openclaw" element={workspaceShell(<OpenClawSetupGate />, { includeOpenClawGuard: false })} />
            <Route path={LOCAL_ASSISTANT_LAUNCH_PATH} element={workspaceShell(<LocalAssistantLaunch />, { includeOpenClawGuard: false })} />
            <Route path="/setup/organization" element={workspaceShell(<CreateOrganization />, { includeOpenClawGuard: false })} />
            <Route path="/create-organization" element={workspaceShell(<CreateOrganization />, { includeOpenClawGuard: false })} />
            <Route path="/platform/diagnostics" element={<AuthGuard><PlatformDiagnostics /></AuthGuard>} />
            <Route element={workspaceShell(<Layout appMode={appMode} />, { includeOpenClawGuard: false })}>
              <Route path="/admin" element={<Navigate to="/conversations" replace />} />
              <Route path="/admin/member/:memberId" element={<Navigate to="/conversations" replace />} />
              <Route path="/openclaw-runtime" element={<ProfileWorkspaceRedirect childPath="openclaw-runtime" />} />
              <Route path="/openclaw" element={<ProfileWorkspaceRedirect childPath="openclaw-runtime" />} />
              <Route path="/host-permissions" element={<ProfileWorkspaceRedirect childPath="host-permissions" />} />
              <Route path="/settings/permissions" element={<ProfileWorkspaceRedirect childPath="host-permissions" />} />
              <Route path="/profiles/:profileRef/settings/permissions" element={<ProfileWorkspaceRedirect childPath="host-permissions" />} />
              <Route path="/profiles/:profileRef/environment" element={profileWorkspaceElement(<OpenClawRuntime />)} />
              <Route path="/profiles/:profileRef/team" element={<ProfileWorkspaceRedirect childPath="conversations" />} />
              <Route path="/profiles/:profileRef/team/member/:memberId" element={<ProfileWorkspaceRedirect childPath="conversations" />} />
              <Route path="/profiles/:profileRef/openclaw-runtime" element={profileWorkspaceElement(<OpenClawRuntime />)} />
              <Route path="/profiles/:profileRef/host-permissions" element={profileWorkspaceElement(<HostPermissions />)} />
            </Route>
            <Route element={workspaceShell(<Layout appMode={appMode} />)}>
              <Route path="/" element={<HostHomeRedirect />} />
              <Route path="/home" element={<HostHomeRedirect />} />
              <Route path="/project" element={<Navigate to="/conversations" replace />} />
              <Route path="/workbench" element={<Navigate to="/conversations" replace />} />
              <Route path="/cloud-workbench" element={<Navigate to="/conversations" replace />} />
              <Route path="/profiles/:profileRef/cloud-workbench" element={<ProfileWorkspaceRedirect childPath="conversations" />} />
              <Route path="/cloud-project/:id" element={<Navigate to="/conversations" replace />} />
              <Route path="/profiles/:profileRef/cloud-project/:id" element={<ProfileWorkspaceRedirect childPath="conversations" />} />
              <Route path="/cloud-documents" element={<CloudDocuments />} />
              <Route path="/profiles/:profileRef/cloud-documents" element={profileWorkspaceElement(<CloudDocuments />)} />
              <Route path="/projects" element={<Navigate to="/conversations" replace />} />
              <Route path="/employees" element={<Employees />} />
              <Route path="/profiles/:profileRef/employees" element={profileWorkspaceElement(<Employees />)} />
              <Route path="/workshops" element={<Navigate to="/conversations" replace />} />
              <Route path="/conversations" element={<Conversations />} />
              <Route path="/profiles/:profileRef/conversations" element={profileWorkspaceElement(<Conversations />)} />
              <Route path="/automations" element={<Automations />} />
              <Route path="/profiles/:profileRef/automations" element={profileWorkspaceElement(<Automations />)} />
              <Route path="/mobile" element={<MobileConnect />} />
              <Route path="/profiles/:profileRef/mobile" element={profileWorkspaceElement(<MobileConnect />)} />
              <Route path="/skillhub" element={<Navigate to="/employees" replace />} />
              <Route path="/operations" element={<Operations />} />
              <Route path="/profiles/:profileRef/operations" element={profileWorkspaceElement(<Operations />)} />
              <Route path="/models" element={<ModelSettings />} />
              <Route path="/profiles/:profileRef/models" element={profileWorkspaceElement(<ModelSettings />)} />
              <Route path="/plugins" element={<McpHub mode="plugins" />} />
              <Route path="/profiles/:profileRef/plugins" element={profileWorkspaceElement(<McpHub mode="plugins" />)} />
              <Route path="/mcphub" element={<McpHub mode="mcp" />} />
              {/* 应用：与小程序「应用」tab 同一组入口（创作广场 + 超级IP + 公域三应用 + 私域转化） */}
              <Route path="/apps" element={<Apps />} />
              <Route path="/apps/montage" element={<MontageApp />} />
              <Route path="/apps/super-ip" element={<SuperIpApp />} />
              <Route path="/apps/public-traffic" element={<Navigate to="/apps/public-traffic/transcript" replace />} />
              <Route path="/apps/public-traffic/:mode" element={<PublicTrafficApp />} />
              <Route path="/apps/private-conversion" element={<PrivateConversionApp />} />
              <Route path="/apps/private-conversion/:channelId" element={<PrivateConversionApp />} />
              <Route path="/profiles/:profileRef/mcphub" element={profileWorkspaceElement(<McpHub mode="mcp" />)} />
              <Route path="/expert-console" element={<Navigate to="/operations" replace />} />
              <Route path="/guide" element={<Navigate to="/conversations" replace />} />
              <Route path="/dashboard" element={<Navigate to="/conversations" replace />} />
              <Route path="/projects/:id" element={<Navigate to="/conversations" replace />} />
              <Route path="/p/:id" element={<Navigate to="/conversations" replace />} />
              <Route path="/p/:id/overview" element={<Navigate to="/conversations" replace />} />
              <Route path="/p/:id/agents" element={<Navigate to="/employees" replace />} />
              <Route path="/p/:id/chat" element={<Navigate to="/conversations" replace />} />
              <Route path="/p/:id/docs" element={<Navigate to="/cloud-documents" replace />} />
              <Route path="/profile" element={<Navigate to="/settings/profile" replace />} />
              <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
              <Route path="/settings/:section" element={<Settings />} />
              <Route path="/profiles/:profileRef/settings" element={profileWorkspaceElement(<ProfileSettingsRedirect />)} />
              <Route path="/profiles/:profileRef/settings/:section" element={profileWorkspaceElement(<Settings />)} />
              <Route path="*" element={<HostHomeRedirect />} />
            </Route>
          </Routes>
        </SignedInRuntime>
      </AuthProvider>
    </HashRouter>
  )
}
