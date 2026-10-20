import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { warmUpLocalGateway } from '../lib/gatewayWarmup'
import { canAutoStartFromSetup } from '../lib/localAssistantLaunch'
import { gatewayStartupState } from '../lib/gatewayStartupState'
import { isGatewayAuthBlockedSnapshot } from '../lib/gatewayErrors'
import { profileWorkspacePath } from '../lib/profileWorkspace'
import {
  getGatewayConnectionSnapshot,
  getOpenClawSetupStage,
  isGatewayConnectionReady,
  refreshGatewayConnectionSnapshot,
  refreshOpenClawStatus,
  setOpenClawRuntimeStatus,
  useRuntimeStatusStore,
} from '../lib/runtimeStatus'
import { maybeBootstrapUniopcOfficialModel } from '../lib/uniopcOfficialModel'
import { ACTION, SURFACE, TEXT } from '../lib/theme'
import BootSplash from '../components/BootSplash'
import AppUpdateTitlebarControl from '../components/AppUpdateTitlebarControl'

// Auto-start bookkeeping survives gate remounts, isolated per profile so one
// profile's attempt never blocks another profile's auto-start.
const gatewayAutoStartAttemptedProfiles = new Set()
const GATEWAY_STARTUP_SLOW_MS = 180_000
const GATEWAY_READY_CONFIRMATIONS_REQUIRED = 2
// Best-effort budget for connecting the official model before entering the
// app. On timeout we enter anyway — OfficialModelBootstrap retries inside.
const MODEL_BOOTSTRAP_TIMEOUT_MS = 8000

function stringifyGatewayDiagnostic(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message || String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// Connection snapshots carry a structured `lastErrorCode` classified on the
// Rust side — trust only that for snapshots. The text fallback exists solely
// for thrown command errors and our own relayed messages; it deliberately
// does NOT match bare "unauthorized" so unrelated cloud/API 401 text can
// never trip the circuit breaker.
function isGatewayAuthMismatch(value) {
  if (value && typeof value === 'object' && !(value instanceof Error)) {
    if ('lastErrorCode' in value || 'status' in value) {
      return isGatewayAuthBlockedSnapshot(value)
    }
  }
  const message = stringifyGatewayDiagnostic(value).toLowerCase()
  return message.includes('token_mismatch') ||
    message.includes('token mismatch') ||
    message.includes('auth-mismatch') ||
    message.includes('gateway auth token') ||
    message.includes('认证 token 不一致')
}

function gatewayAuthMismatchMessage(profile) {
  return [
    `Uniopc 引擎 认证 token 不一致，Uniopc 已停止自动重启${profile ? ` profile ${profile}` : ''}，避免反复进入/退出 App。`,
    '请先刷新状态；如果仍失败，需要重新同步或修复该 Uniopc 引擎 profile 的 Gateway token。',
  ].join('\n')
}

function shouldBypassGatewayAuthMismatchInDev(value) {
  return import.meta.env.DEV && isGatewayAuthMismatch(value)
}

function withModelBootstrapTimeout(promise, timeoutMs) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => {
      reject(new Error('官方模型接入超时'))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) globalThis.clearTimeout(timer)
  })
}

function StepChip({ step, label, state }) {
  const base = 'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium'
  if (state === 'done') {
    return (
      <span className={`${base} border-emerald-400/20 bg-emerald-400/10 text-success-text`}>
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-300/18 text-2xs">✓</span>
        {label}
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span className={`${base} border-violet-400/25 bg-violet-400/12 text-accent-text`}>
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-violet-300/35 text-2xs">{step}</span>
        {label}
      </span>
    )
  }
  return (
    <span className={`${base} border-subtle bg-surface-raised text-secondary`}>
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-default text-2xs">{step}</span>
      {label}
    </span>
  )
}

export default function OpenClawSetupGate() {
  const navigate = useNavigate()
  const location = useLocation()
  const runtime = useRuntimeStatusStore()
  const activeOpenClaw = useActiveOpenClawProfile()
  const profileWorkspaceState = location.state?.profileWorkspace || null
  const activeProfile = profileWorkspaceState?.targetOpenClawProfile || activeOpenClaw.activeProfile
  const workspaceProfile = profileWorkspaceState
    ? {
        ...(activeOpenClaw.workspaceProfile || {}),
        memberId: profileWorkspaceState.targetMemberId || '',
        member_id: profileWorkspaceState.targetMemberId || '',
        memberRole: profileWorkspaceState.targetMemberRole || '',
        member_role: profileWorkspaceState.targetMemberRole || '',
        openclawProfileId: profileWorkspaceState.targetOpenClawProfileId || '',
        openclaw_profile_id: profileWorkspaceState.targetOpenClawProfileId || '',
        openclawProfile: profileWorkspaceState.targetOpenClawProfile || '',
        openclaw_profile: profileWorkspaceState.targetOpenClawProfile || '',
        runtimeMode: profileWorkspaceState.targetRuntimeMode || profileWorkspaceState.runtimeMode || profileWorkspaceState.runtime_mode || '',
        runtime_mode: profileWorkspaceState.targetRuntimeMode || profileWorkspaceState.runtimeMode || profileWorkspaceState.runtime_mode || '',
        gatewayPort: profileWorkspaceState.targetGatewayPort || null,
        gateway_port: profileWorkspaceState.targetGatewayPort || null,
      }
    : activeOpenClaw.workspaceProfile
  const [checked, setChecked] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)
  const [installing, setInstalling] = useState(false)
  const [updatingOpenClaw, setUpdatingOpenClaw] = useState(false)
  const [startingGateway, setStartingGateway] = useState(false)
  const [autoStartBlockedReason, setAutoStartBlockedReason] = useState('')
  const [gatewayReadyConfirmationCount, setGatewayReadyConfirmationCount] = useState(0)
  // 'pending' | 'running' | 'done' | 'skipped'
  const [modelStepState, setModelStepState] = useState('pending')
  const installAutoAttempted = useRef(false)
  const gatewayAutoStartAttempted = useRef(false)
  const gatewayReadyConfirmations = useRef(0)
  const confirmProbeInFlight = useRef(false)
  const enteringRef = useRef(false)

  const status = runtime.openClaw.status
  const redirectTo = profileWorkspacePath({ isCurrentMember: true }, 'conversations')
  const supported = status ? status.supported !== false : true
  const connectionProfile = activeProfile || ''
  const hasConnectionProfile = Boolean(connectionProfile)
  const gatewayPort = workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null
  const connectionSnapshot = getGatewayConnectionSnapshot(connectionProfile, gatewayPort)
  const connectionReady = isGatewayConnectionReady(connectionSnapshot)
  const gatewayReady = connectionReady
  const routeGatewayError = location.state?.gatewayError || ''
  const routeGatewayErrorCode = location.state?.gatewayErrorCode || ''
  const diagnosticsOnly = location.state?.diagnosticsOnly === true
  const mayAutoStart = canAutoStartFromSetup({ diagnosticsOnly, startupError: runtime.gatewayConnection.startupErrors[connectionProfile] })

  function setupReady(
    nextStatus = status,
    nextConnectionSnapshot = connectionSnapshot,
  ) {
    const nextGatewayReady = isGatewayConnectionReady(nextConnectionSnapshot)
    return Boolean(
      nextStatus?.installed &&
      nextStatus?.supported !== false &&
      nextGatewayReady,
    )
  }

  function resetGatewayReadyConfirmations() {
    gatewayReadyConfirmations.current = 0
    setGatewayReadyConfirmationCount(0)
  }

  function confirmGatewayReady(nextStatus, nextConnectionSnapshot) {
    if (!setupReady(nextStatus, nextConnectionSnapshot)) {
      resetGatewayReadyConfirmations()
      return false
    }
    gatewayReadyConfirmations.current += 1
    setGatewayReadyConfirmationCount(gatewayReadyConfirmations.current)
    return gatewayReadyConfirmations.current >= GATEWAY_READY_CONFIRMATIONS_REQUIRED
  }

  function blockGatewayAutoStart(reason) {
    const message = reason || gatewayAuthMismatchMessage(connectionProfile)
    gatewayAutoStartAttempted.current = true
    gatewayAutoStartAttemptedProfiles.add(connectionProfile)
    setAutoStartBlockedReason(message)
    setError(message)
    setProgress(prev => ({
      phase: 'failed',
      status: 'Uniopc 引擎 认证失败',
      detail: '检测到 Gateway token/auth 不一致，自动重启不会修复这个问题。',
      output_tail: prev?.output_tail || message,
      percent: null,
    }))
    setMessage(null)
    setStartingGateway(false)
  }

  async function refreshActiveConnectionSnapshot(options = {}) {
    if (!connectionProfile) return null
    return refreshGatewayConnectionSnapshot({ profile: connectionProfile, gatewayPort, ...options })
  }

  async function refreshSetupStatus(options = {}) {
    const nextStatus = await refreshOpenClawStatus(options)
    let nextConnectionSnapshot = connectionSnapshot
    if (connectionProfile) {
      try {
        nextConnectionSnapshot = await refreshActiveConnectionSnapshot(options)
      } catch {
        nextConnectionSnapshot = null
      }
    }
    return { status: nextStatus, connectionSnapshot: nextConnectionSnapshot }
  }

  useEffect(() => {
    let active = true

    // Resolve-then-unlisten so a cleanup that races the async listen() still
    // releases the listener instead of leaking it.
    const listenPromise = listen('openclaw-setup-progress', event => {
      if (!active) return
      setProgress(event.payload)
      if (event.payload?.phase === 'success' || event.payload?.phase === 'failed') {
        refreshSetupStatus({ silent: true }).catch(() => null)
      }
    })

    refreshSetupStatus()
      .catch(e => {
        if (!active) return
        if (isGatewayAuthMismatch(e)) {
          blockGatewayAutoStart(gatewayAuthMismatchMessage(connectionProfile))
          return
        }
        setError(typeof e === 'string' ? e : '检测 Uniopc 引擎 状态失败')
      })
      .finally(() => {
        if (active) setChecked(true)
      })

    return () => {
      active = false
      listenPromise.then(unlisten => unlisten()).catch(() => null)
    }
  }, [connectionProfile, gatewayPort])

  useEffect(() => {
    if (!routeGatewayError && !routeGatewayErrorCode) return
    if (connectionSnapshot?.mode === 'local') {
      // A route created by an older build may still carry a mismatch error.
      // Once the live snapshot proves this is the app-owned local gateway,
      // release that stale circuit breaker and let start_local repair it.
      setAutoStartBlockedReason('')
      setError(null)
      return
    }
    const routeSnapshot = {
      mode: connectionSnapshot?.mode,
      lastErrorCode: routeGatewayErrorCode,
    }
    if (
      isGatewayAuthBlockedSnapshot(routeSnapshot) ||
      (connectionSnapshot?.mode !== 'local' && isGatewayAuthMismatch(routeGatewayError))
    ) {
      blockGatewayAutoStart(gatewayAuthMismatchMessage(connectionProfile))
      return
    }
    if (!routeGatewayError) return
    // Non-auth guard errors (e.g. connection refused while the gateway is
    // still binding its port) are transient: show them, but never let them
    // trip the auto-start circuit breaker or outlive a ready probe.
    setError(String(routeGatewayError))
  }, [connectionProfile, connectionSnapshot?.mode, routeGatewayError, routeGatewayErrorCode])

  // Read-only, serialized probes also observe a late-ready child after a
  // failed startup attempt. Navigation/diagnostics never creates a new flight.
  useEffect(() => {
    if (!hasConnectionProfile || gatewayReady || autoStartBlockedReason) return undefined
    let active = true
    let checking = false
    const startedAt = Date.now()
    const timer = window.setInterval(async () => {
      if (checking) return
      checking = true
      try {
        const { status: nextStatus, connectionSnapshot: nextConnectionSnapshot } = await refreshSetupStatus({ silent: true })
        if (!active) return
        if (isGatewayAuthMismatch(nextConnectionSnapshot)) {
          blockGatewayAutoStart(gatewayAuthMismatchMessage(connectionProfile))
          return
        }
        if (confirmGatewayReady(nextStatus, nextConnectionSnapshot)) {
          setError(null)
          setProgress(null)
          setMessage('Gateway 已启动，马上进入 Uniopc。')
          setStartingGateway(false)
          return
        }
        if (startingGateway && Date.now() - startedAt >= GATEWAY_STARTUP_SLOW_MS) {
          setMessage('启动时间较长，后台仍在准备运行组件、内置能力或本地连接，请稍候。')
        }
      } catch {
        // Only the owned backend flight reports failure; polling is read-only.
      } finally {
        checking = false
      }
    }, startingGateway ? 2500 : 10000)
    return () => { active = false; window.clearInterval(timer) }
  }, [connectionProfile, gatewayPort, startingGateway, gatewayReady, autoStartBlockedReason, hasConnectionProfile])

  const globalSetupStage = getOpenClawSetupStage(status)
  const canConfigureConnection = Boolean(
    status?.installed &&
    supported &&
    globalSetupStage !== 'unsupported_openclaw_version' &&
    globalSetupStage !== 'unsupported',
  )
  const setupStage = canConfigureConnection && !hasConnectionProfile
    ? 'missing_profile'
    : canConfigureConnection && !gatewayReady
    ? 'missing_gateway'
    : canConfigureConnection && gatewayReady
      ? 'ready'
      : globalSetupStage
  const ready = setupReady(status, connectionSnapshot)
  const stableReady = ready && gatewayReadyConfirmationCount >= GATEWAY_READY_CONFIRMATIONS_REQUIRED
  const loading = runtime.openClaw.loading || !checked
  const busy = installing || updatingOpenClaw || startingGateway
  const platformHint = 'Gateway 作为 Uniopc 的子进程随 App 启动/退出，不安装常驻系统服务。'

  useEffect(() => {
    if (diagnosticsOnly) return
    if (shouldBypassGatewayAuthMismatchInDev(autoStartBlockedReason || error || connectionSnapshot || routeGatewayError)) {
      navigate(redirectTo, { replace: true })
      return
    }
    // A transient failure (e.g. probing during the provision-time gateway
    // restart) must not wedge the gate forever: once the connection probes
    // ready again, drop the stale error so the entry flow can proceed.
    // Auth-mismatch blocks live in autoStartBlockedReason and stay sticky.
    if (ready && error && !autoStartBlockedReason) {
      setError(null)
      return
    }
    if (!checked || loading || !ready || error) {
      if (!ready) resetGatewayReadyConfirmations()
      return
    }
    if (!stableReady) {
      // Confirm readiness with a real re-probe — never count the same
      // snapshot twice. Each completed probe bumps state, re-running this
      // effect until the required streak is reached (any failed probe
      // resets the streak via confirmGatewayReady). The in-flight guard
      // serializes probes; the confirmation itself always lands because it
      // is based on fresh probe results, not on this render's state.
      if (!confirmProbeInFlight.current) {
        confirmProbeInFlight.current = true
        refreshSetupStatus({ silent: true })
          .then(({ status: nextStatus, connectionSnapshot: nextConnectionSnapshot }) => {
            confirmGatewayReady(nextStatus, nextConnectionSnapshot)
          })
          .catch(() => null)
          .finally(() => {
            confirmProbeInFlight.current = false
          })
      }
      return
    }
    if (enteringRef.current) return
    enteringRef.current = true
    async function enterWhenReady() {
      // Gateway is confirmed up — connect the official model now (no-op when
      // the user already configured one) so the first conversation message
      // can send immediately after entering. Best-effort with a timeout:
      // failures never block entry, OfficialModelBootstrap retries in-app.
      if (connectionProfile) {
        setModelStepState('running')
        try {
          await withModelBootstrapTimeout(
            maybeBootstrapUniopcOfficialModel({ profile: connectionProfile }),
            MODEL_BOOTSTRAP_TIMEOUT_MS,
          )
          setModelStepState('done')
        } catch {
          setModelStepState('skipped')
        }
      }
      navigate(redirectTo, { replace: true })
    }
    void enterWhenReady()
  }, [
    autoStartBlockedReason,
    diagnosticsOnly,
    checked,
    connectionProfile,
    connectionSnapshot,
    error,
    gatewayReadyConfirmationCount,
    gatewayPort,
    loading,
    navigate,
    ready,
    redirectTo,
    routeGatewayError,
    stableReady,
  ])

  // Step 1 runs hands-free: detecting a missing Uniopc 引擎 install triggers the
  // official installer once. The button stays as the manual retry on failure.
  useEffect(() => {
    if (setupStage !== 'missing_openclaw') {
      installAutoAttempted.current = false
      return
    }
    if (!mayAutoStart || !checked || loading || !supported || busy || error || installAutoAttempted.current) return
    installAutoAttempted.current = true
    handleInstall({ auto: true })
  }, [busy, checked, error, loading, setupStage, supported, mayAutoStart])

  useEffect(() => {
    if (setupStage !== 'missing_gateway') {
      gatewayAutoStartAttempted.current = false
      gatewayAutoStartAttemptedProfiles.delete(connectionProfile)
      return
    }
    if (
      !mayAutoStart ||
      !checked ||
      loading ||
      !hasConnectionProfile ||
      !supported ||
      busy ||
      autoStartBlockedReason ||
      isGatewayAuthMismatch(connectionSnapshot) ||
      gatewayAutoStartAttempted.current ||
      gatewayAutoStartAttemptedProfiles.has(connectionProfile)
    ) return

    gatewayAutoStartAttempted.current = true
    gatewayAutoStartAttemptedProfiles.add(connectionProfile)
    handleStartGateway({ auto: true })
  }, [autoStartBlockedReason, busy, checked, connectionProfile, connectionSnapshot, hasConnectionProfile, loading, setupStage, supported, mayAutoStart])

  async function syncStatus(nextStatus) {
    if (nextStatus) {
      return setOpenClawRuntimeStatus(nextStatus)
    }
    const { status: refreshed } = await refreshSetupStatus()
    return refreshed
  }

  async function handleInstall({ auto = false } = {}) {
    setInstalling(true)
    setError(null)
    setMessage(auto ? '正在自动安装 Uniopc 引擎，完成后会继续连接 Gateway。' : null)
    try {
      const res = await invoke('openclaw_install')
      const nextStatus = await syncStatus(res?.status)
      setMessage(nextStatus?.installed
        ? 'Uniopc 引擎 安装完成，下一步连接 Gateway。'
        : 'Uniopc 引擎 安装流程已返回，请刷新状态继续检查。')
    } catch (e) {
      setError(typeof e === 'string' ? e : auto ? '自动安装 Uniopc 引擎 失败，你可以手动重试。' : '安装 Uniopc 引擎 失败')
    } finally {
      setInstalling(false)
    }
  }

  async function handleUpdateOpenClaw({ auto = false } = {}) {
    setUpdatingOpenClaw(true)
    setError(null)
    setMessage(auto ? '正在自动安装 Uniopc 引擎 兼容版本。' : null)
    try {
      const res = await invoke('openclaw_update')
      const nextStatus = await syncStatus(res?.status)
      setMessage(nextStatus?.updateMessage || 'Uniopc 引擎 兼容版本已安装，请继续完成运行环境检查。')
    } catch (e) {
      setError(typeof e === 'string' ? e : auto ? '自动安装兼容版本失败，你可以手动重试。' : '安装 Uniopc 引擎 兼容版本失败')
    } finally {
      setUpdatingOpenClaw(false)
    }
  }

  async function handleStartGateway({ auto = false } = {}) {
    if (!hasConnectionProfile) {
      setError('尚未读取到可用的 Uniopc 引擎 Profile，无法启动 Gateway。请刷新状态；若仍未读取到，请联系平台管理员修复该账号的授权。')
      return
    }
    let keepPolling = false
    resetGatewayReadyConfirmations()
    setStartingGateway(true)
    setAutoStartBlockedReason('')
    setError(null)
    setProgress(null)
    setMessage(auto ? 'Gateway 正在自动启动，完成后会直接进入 Uniopc。' : null)
    try {
      // Single-flight with the OpenClawGuard background warm-up: if the app
      // already kicked off this gateway at boot, reuse that attempt instead
      // of racing a second provision.
      const startupSnapshot = await warmUpLocalGateway({ profile: connectionProfile, gatewayPort: gatewayPort || null })
      const {
        status: nextStatus,
        connectionSnapshot: nextConnectionSnapshot,
      } = await refreshSetupStatus({ silent: true })
      if (isGatewayAuthMismatch(nextConnectionSnapshot)) {
        blockGatewayAutoStart(gatewayAuthMismatchMessage(connectionProfile))
        return
      }
      if (confirmGatewayReady(nextStatus, nextConnectionSnapshot)) {
        setMessage('Gateway 已启动，马上进入 Uniopc。')
      } else {
        const startup = gatewayStartupState(startupSnapshot)
        keepPolling = startup.keepPolling
        setMessage(startup.message)
        if (startup.error) setError(startup.error)
      }
    } catch (e) {
      try {
        const {
          status: nextStatus,
          connectionSnapshot: nextConnectionSnapshot,
        } = await refreshSetupStatus({ silent: true })
        if (isGatewayAuthMismatch(nextConnectionSnapshot) || isGatewayAuthMismatch(e)) {
          blockGatewayAutoStart(gatewayAuthMismatchMessage(connectionProfile))
          return
        }
        if (confirmGatewayReady(nextStatus, nextConnectionSnapshot)) {
          setMessage('Gateway 已启动，马上进入 Uniopc。')
          return
        }
      } catch {
        // Keep the original gateway startup error below.
      }
      if (isGatewayAuthMismatch(e)) {
        blockGatewayAutoStart(gatewayAuthMismatchMessage(connectionProfile))
        return
      }
      setMessage(null)
      setError(typeof e === 'string' ? e : auto ? '自动启动 Gateway 失败，你可以手动重试。' : '启动 Gateway 失败')
    } finally {
      if (!keepPolling) setStartingGateway(false)
    }
  }

  async function handleRefresh() {
    setError(null)
    setAutoStartBlockedReason('')
    resetGatewayReadyConfirmations()
    try {
      if (!hasConnectionProfile) {
        activeOpenClaw.refreshWorkspaceProfile()
        setMessage('正在重新读取 Uniopc 引擎 Profile…')
        return
      }
      const {
        status: nextStatus,
        connectionSnapshot: nextConnectionSnapshot,
      } = await refreshSetupStatus()
      if (isGatewayAuthMismatch(nextConnectionSnapshot)) {
        blockGatewayAutoStart(gatewayAuthMismatchMessage(connectionProfile))
        return
      }
      if (confirmGatewayReady(nextStatus, nextConnectionSnapshot)) {
        setMessage('Gateway 已就绪。')
      }
    } catch (e) {
      if (isGatewayAuthMismatch(e)) {
        blockGatewayAutoStart(gatewayAuthMismatchMessage(connectionProfile))
        return
      }
      setError(typeof e === 'string' ? e : '刷新 Uniopc 引擎 状态失败')
    }
  }

  const steps = [
    {
      step: 1,
      label: '安装 Uniopc 引擎',
      done: Boolean(status?.installed),
      active: setupStage === 'missing_openclaw',
    },
    {
      step: 2,
      label: '兼容版本',
      done: Boolean(status?.installed && setupStage !== 'unsupported_openclaw_version'),
      active: setupStage === 'unsupported_openclaw_version',
    },
    {
      step: 3,
      label: '连接 Gateway',
      done: Boolean(gatewayReady),
      active: setupStage === 'missing_gateway',
    },
    {
      step: 4,
      label: '接入官方模型',
      done: modelStepState === 'done',
      active: modelStepState === 'running',
    },
  ]

  if (loading) {
    return (
      <BootSplash
        title="正在准备运行环境"
        detail="我们正在检查 Uniopc 引擎 CLI、当前 profile 和 Gateway，准备好后会直接进入 Uniopc。"
      />
    )
  }

  return (
    <div className="relative min-h-screen bg-surface-raised px-4 py-8 md:px-8">
      <AppUpdateTitlebarControl />
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <section className={`${SURFACE.panel} p-6 md:p-7`}>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-[-0.02em] text-primary">
                先准备运行环境
              </h1>
              <p className={`mt-3 max-w-3xl text-sm leading-7 ${TEXT.secondary}`}>
                {diagnosticsOnly ? '当前仅查看启动状态，不会自动重新安装或启动。需要再次尝试时，请点击下方的启动或修复按钮。' : 'Uniopc 会自动完成：安装 Uniopc 引擎、连接 Uniopc 引擎、接入 Uniopc 官方模型（已配置过模型会自动跳过）。全部就绪后会直接进入 Uniopc。'}
              </p>
              <p className={`mt-2 max-w-3xl text-xs leading-6 ${TEXT.muted}`}>
                {platformHint}
              </p>
              <p className={`mt-2 max-w-3xl text-xs leading-6 ${TEXT.muted}`}>
                Uniopc 引擎 Profile：{activeProfile || '未读取到'}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {steps.map(item => (
                  <StepChip
                    key={item.label}
                    step={item.step}
                    label={item.label}
                    state={item.done ? 'done' : item.active ? 'active' : 'pending'}
                  />
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {diagnosticsOnly && gatewayReady && <button type="button" onClick={() => navigate(redirectTo)} className={ACTION.primary}>进入工作台</button>}
              <button type="button" onClick={handleRefresh} className={ACTION.secondary} disabled={loading}>
                {loading ? '检测中...' : '刷新状态'}
              </button>
            </div>
          </div>
        </section>

        {!supported && (
          <section className={`${SURFACE.panel} p-6`}>
            <p className={`text-sm ${TEXT.secondary}`}>
              当前系统暂不支持自动安装 Uniopc 引擎。你可以稍后在受支持环境里继续接入。
            </p>
          </section>
        )}

        {supported && setupStage === 'missing_openclaw' && (
          <section className={`${SURFACE.panel} p-6`}>
            <div className="space-y-3">
              <h2 className="text-2xl font-semibold text-primary">第 1 步：初始化 Uniopc 引擎 运行环境</h2>
              <p className={`text-sm ${TEXT.secondary}`}>
                Uniopc 优先使用安装包内置的 Uniopc 引擎 运行时，本地初始化只需几秒、无需联网；
                仅在内置运行时不可用时才回退到官方安装器在线安装。完成后会自动继续下一步。
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => handleInstall()} className={ACTION.primary} disabled={busy}>
                  {installing ? '安装中...' : '重试安装'}
                </button>
              </div>
            </div>
          </section>
        )}

        {supported && setupStage === 'unsupported_openclaw_version' && (
          <section className={`${SURFACE.panel} p-6`}>
            <div className="space-y-3">
              <h2 className="text-2xl font-semibold text-primary">第 2 步：安装兼容版本</h2>
              <p className={`text-sm ${TEXT.secondary}`}>
                当前 Uniopc 引擎 版本与 Uniopc 已验证的 Gateway/RPC 兼容版本不匹配。Uniopc 会优先用安装包
                内置的兼容运行时离线升级，必要时回退官方安装器，完成后继续启动 Gateway。
              </p>
              <p className={`rounded-lg border border-border bg-surface-sunken p-3 text-sm leading-6 ${TEXT.secondary}`}>
                新版本引擎连接 Gateway 并通过健康检查后，才会清理 Uniopc 专属目录中的旧版本运行文件；若启动失败，旧版本会保留以便恢复。账号设置、聊天记录和工作区会保留。清理失败不会阻止使用，应用会在后续成功启动时重试。
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => handleUpdateOpenClaw()} className={ACTION.primary} disabled={busy}>
                  {updatingOpenClaw ? '安装中...' : '确认并升级兼容版本'}
                </button>
              </div>
            </div>
          </section>
        )}

        {supported && setupStage === 'missing_gateway' && (
          <section className={`${SURFACE.panel} p-6`}>
            <div className="space-y-3">
              <h2 className="text-2xl font-semibold text-primary">第 3 步：连接 Uniopc Gateway</h2>
              <p className={`text-sm ${TEXT.secondary}`}>
                Uniopc 会以子进程方式启动本机 Gateway（随 App 生灭，不装常驻服务）。
                连接稳定后会接入官方模型并直接进入 Uniopc。
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => handleStartGateway()} className={ACTION.primary} disabled={busy}>
                  {startingGateway ? '启动中...' : '启动 Gateway'}
                </button>
              </div>
            </div>
          </section>
        )}

        {supported && setupStage === 'missing_profile' && (
          <section className={`${SURFACE.panel} p-6`}>
            <div className="space-y-3">
              <h2 className="text-2xl font-semibold text-primary">正在读取 Uniopc 引擎 Profile</h2>
              <p className={`text-sm ${TEXT.secondary}`}>
                Gateway 必须绑定到当前账号的 Uniopc 引擎 Profile。请刷新状态；若持续未读取到，说明该账号的云端授权尚未完成。
              </p>
            </div>
          </section>
        )}

        {modelStepState === 'running' && (
          <section className={`${SURFACE.panel} p-6`}>
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold text-primary">第 4 步：接入 Uniopc 官方模型</h2>
              <p className={`text-sm ${TEXT.secondary}`}>
                正在为你接入官方模型（含体验额度）。已配置过模型会自动跳过，完成后直接进入 Uniopc。
              </p>
            </div>
          </section>
        )}

        {(message || error || progress) && (
          <section className={`${SURFACE.panel} p-6`}>
            {message && <p className="text-sm text-success-text">{message}</p>}
            {error && <p className="select-text text-sm text-danger-text">{error}</p>}
            {progress && (
              <div className={`${message || error ? 'mt-3' : ''} space-y-2`}>
                <div className="text-sm font-medium text-primary">{progress.status}</div>
                {progress.detail && <div className={`select-text text-xs ${TEXT.secondary}`}>{progress.detail}</div>}
                {typeof progress.percent === 'number' && (
                  <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className="h-full rounded-full bg-violet-400 transition-[width]"
                      style={{ width: `${Math.max(6, Math.min(100, progress.percent))}%` }}
                    />
                  </div>
                )}
                {progress.output_tail && (
                  <pre className="max-h-48 overflow-auto rounded-2xl border border-subtle bg-surface-sunken p-3 text-2xs text-secondary">
                    {progress.output_tail}
                  </pre>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
