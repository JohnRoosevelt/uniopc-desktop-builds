import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { warmUpLocalGateway } from '../lib/gatewayWarmup'
import {
  localAssistantLaunchNeedsSetup,
  localAssistantReturnPath,
  localAssistantLaunchSteps,
} from '../lib/localAssistantLaunch'
import {
  getGatewayConnectionSnapshot,
  isGatewayConnectionReady,
  refreshGatewayConnectionSnapshot,
  refreshOpenClawStatus,
  useRuntimeStatusStore,
} from '../lib/runtimeStatus'
const STARTUP_DIAGNOSTIC_AFTER_MS = 20000
const STARTUP_STATUS_POLL_MS = 2500

function startWindowDrag(event) {
  if (event.button !== 0) return
  event.preventDefault()
  getCurrentWindow().startDragging().catch(() => {})
}

function LaunchStep({ index, label, detail, state, isLast }) {
  const complete = state === 'done'
  const active = state === 'active'
  const failed = state === 'failed'
  return (
    <li className="relative flex min-h-14 gap-3.5 last:min-h-0">
      <div className="relative flex w-6 shrink-0 justify-center">
        {!isLast && <span className={`absolute top-7 h-[calc(100%-11px)] w-px ${complete ? 'bg-emerald-300/60' : 'bg-default'}`} />}
        <span className={`relative z-10 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${complete
          ? 'bg-emerald-500/12 text-emerald-600'
          : active
            ? 'border border-violet-400/45 bg-violet-400/10 text-violet-600 shadow-[0_0_0_4px_rgba(139,49,245,0.06)]'
            : 'border border-subtle bg-surface-raised text-tertiary'}`}
        >
          {complete ? '✓' : failed ? '!' : active ? <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-violet-500" /> : index + 1}
        </span>
      </div>
      <div className="min-w-0 pb-4">
        <div className="flex items-center gap-2">
          <p className={`text-sm ${complete ? 'font-medium text-primary' : active ? 'font-semibold text-accent-text' : 'font-medium text-secondary'}`}>{label}</p>
          {active && <span className="rounded-full bg-violet-400/10 px-2 py-0.5 text-2xs font-medium text-violet-600">进行中</span>}
          {failed && <span className="text-xs text-danger-text">失败</span>}
        </div>
        <p className="mt-1 text-xs leading-5 text-tertiary">{detail}</p>
      </div>
    </li>
  )
}

export default function LocalAssistantLaunch() {
  const navigate = useNavigate()
  const location = useLocation()
  const runtime = useRuntimeStatusStore()
  const { activeProfile, workspaceProfile } = useActiveOpenClawProfile()
  const [elapsedMs, setElapsedMs] = useState(0)
  const gatewayPort = workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null
  const connectionSnapshot = getGatewayConnectionSnapshot(activeProfile, gatewayPort)
  const gatewayReady = isGatewayConnectionReady(connectionSnapshot)
  const runtimeStatus = runtime.openClaw.status
  const appReady = Boolean(runtimeStatus?.installed && runtimeStatus?.supported !== false && gatewayReady)
  const startupError = runtime.gatewayConnection.startupErrors[activeProfile]
  const destination = localAssistantReturnPath(location.state?.from)
  const setupState = useMemo(() => ({
    from: destination,
    gatewayError: connectionSnapshot?.error || connectionSnapshot?.lastError || startupError || '',
    gatewayErrorCode: connectionSnapshot?.lastErrorCode || '',
    profileWorkspace: location.state?.profileWorkspace || null,
  }), [connectionSnapshot?.error, connectionSnapshot?.lastError, connectionSnapshot?.lastErrorCode, destination, location.state?.profileWorkspace, startupError])

  useEffect(() => {
    if (!activeProfile || appReady) return undefined
    // A remount after failure is not an explicit retry.
    if (!startupError) warmUpLocalGateway({ profile: activeProfile, gatewayPort }).catch(() => null)
    let checking = false
    const poll = globalThis.setInterval(() => {
      if (checking) return
      checking = true
      Promise.allSettled([
        refreshOpenClawStatus({ silent: true }),
        refreshGatewayConnectionSnapshot({ profile: activeProfile, gatewayPort, silent: true }),
      ]).finally(() => { checking = false })
    }, STARTUP_STATUS_POLL_MS)
    return () => globalThis.clearInterval(poll)
  }, [activeProfile, appReady, gatewayPort, startupError])

  useEffect(() => {
    if (appReady) navigate(destination, { replace: true, state: location.state?.profileWorkspace ? { profileWorkspace: location.state.profileWorkspace } : null })
  }, [appReady, destination, location.state?.profileWorkspace, navigate])

  useEffect(() => {
    const startedAt = Date.now()
    const tick = () => setElapsedMs(Date.now() - startedAt)
    tick()
    const timer = globalThis.setInterval(tick, 1000)
    return () => globalThis.clearInterval(timer)
  }, [])

  if (localAssistantLaunchNeedsSetup({ status: runtimeStatus, connectionSnapshot })) {
    return <Navigate to="/setup/openclaw" replace state={setupState} />
  }

  const needsDiagnostic = Boolean(startupError) || elapsedMs >= STARTUP_DIAGNOSTIC_AFTER_MS
  const detail = startupError
    ? '本地服务暂未启动，请查看启动诊断。'
    : elapsedMs >= STARTUP_DIAGNOSTIC_AFTER_MS
      ? '启动时间较长，仍在等待本地服务完成准备。'
      : '首次启动需要准备运行组件与内置能力，完成后将自动进入工作台。'
  const steps = localAssistantLaunchSteps({ status: runtimeStatus, gatewayReady, startupError })
  const activeStep = Math.max(0, steps.findIndex(step => step.state === 'active' || step.state === 'failed'))

  return (
    <main className="relative min-h-screen overflow-hidden bg-surface-sunken px-5 py-8 text-primary sm:px-8">
      <div
        data-tauri-drag-region
        onMouseDown={startWindowDrag}
        className="absolute inset-x-0 top-0 z-10 h-[36px]"
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(ellipse_at_50%_-12%,rgba(147,80,255,0.18),transparent_64%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.28] [background-image:linear-gradient(rgba(120,96,170,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(120,96,170,0.045)_1px,transparent_1px)] [background-size:32px_32px]" />

      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-[610px] flex-col justify-center">
        <div className="mb-6 flex items-center gap-2.5 text-sm font-semibold text-secondary">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[linear-gradient(135deg,var(--ui-brand),var(--ui-brand-soft))] text-sm font-bold text-white shadow-[0_12px_26px_-15px_rgba(139,49,245,0.95)]">U</span>
          <span>Uniopc</span>
          <span className="h-3.5 w-px bg-default" />
          <span className="text-xs font-medium text-tertiary">本地工作台</span>
        </div>

        <section className="relative overflow-hidden rounded-[28px] border border-subtle bg-surface-raised shadow-[0_32px_90px_-58px_rgba(50,30,100,0.55)]">
          <div className="pointer-events-none absolute right-[-100px] top-[-120px] h-64 w-64 rounded-full bg-violet-400/[0.10] blur-3xl" />
          <div className="relative p-6 sm:p-8">
            <div className="mb-7 flex items-center justify-between gap-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-violet-400/18 bg-violet-400/[0.07] px-3 py-1.5 text-xs font-medium text-accent-text">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
                {startupError ? '本地助手启动失败' : '本地助手正在启动'}
              </div>
              <span className="shrink-0 text-xs font-medium tabular-nums text-tertiary">第 {activeStep + 1} / {steps.length} 步</span>
            </div>

            <div className="flex items-start gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-violet-400/20 bg-[linear-gradient(145deg,rgba(168,104,255,0.18),rgba(139,49,245,0.06))]">
                {startupError ? <span className="text-danger-text">!</span> : <span className="h-5 w-5 animate-spin rounded-full border-2 border-violet-400/25 border-t-violet-600 motion-reduce:animate-none" aria-hidden="true" />}
              </span>
              <div className="min-w-0">
                <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.03em] text-primary">准备就绪后，即刻开始工作</h1>
                <p className="mt-2 max-w-[460px] text-sm leading-6 text-secondary">{detail}</p>
              </div>
            </div>

            <div className="mt-8 rounded-2xl border border-subtle bg-surface-sunken/[0.55] p-5">
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-primary">启动进度</h2>
                <span className="text-xs text-tertiary">{startupError ? '请查看诊断，或重试启动' : '无需操作，将自动继续'}</span>
              </div>
              <ol aria-label="本地助手启动进度">
                {steps.map((step, index) => (
                  <LaunchStep key={step.label} index={index} isLast={index === steps.length - 1} {...step} />
                ))}
              </ol>
            </div>

            {needsDiagnostic && (
              <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.08] p-3.5">
                <p className="select-text text-xs leading-5 text-warning-text">{startupError || '启动时间较长，你可以查看当前启动状态。'}</p>
                {startupError && <button type="button" onClick={() => warmUpLocalGateway({ profile: activeProfile, gatewayPort }).catch(() => null)} className="shrink-0 text-xs font-medium text-primary">重试启动</button>}
                <button
                  type="button"
                  onClick={() => navigate('/setup/openclaw', { state: { ...setupState, diagnosticsOnly: true } })}
                  className="shrink-0 rounded-lg border border-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-state-hover"
                >
                  查看诊断
                </button>
              </div>
            )}
          </div>
          <div className="relative flex items-center gap-2 border-t border-subtle px-6 py-4 text-xs text-tertiary sm:px-8">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-400/[0.08] text-[11px] text-accent-text">✦</span>
            {startupError ? '启动未完成，错误信息已保留。' : '正在准备本机运行环境，完成后将自动打开你的工作台。'}
          </div>
        </section>
      </div>
    </main>
  )
}
