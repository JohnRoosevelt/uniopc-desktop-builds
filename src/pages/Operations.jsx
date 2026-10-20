import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { profileWorkspaceNavigationState, useProfileWorkspace } from '../hooks/useProfileWorkspace'
import { useAuth } from '../hooks/useAuth'
import { profileWorkspacePath } from '../lib/profileWorkspace'
import {
  getGatewayConnectionSnapshot,
  isGatewayConnectionReady,
  refreshGatewayConnectionSnapshot,
  useRuntimeStatusStore,
} from '../lib/runtimeStatus'
import { shouldRequireLocalOpenClawSetup } from '../lib/openclawAccess'
import { sanitizeBrand } from '../lib/brandSanitizer'
import { ACTION, CARD, HEADING, LAYOUT, PAGE, SURFACE, TEXT } from '../lib/theme'

const DEFAULT_DASHBOARD_PORT = 18790
const BROWSER_RUNTIME_RESTART_SETTLE_MS = 1800

function wait(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

export default function Operations({ embedded = false, profileWorkspaceOverride = null }) {
  const { user } = useAuth()
  const runtime = useRuntimeStatusStore()
  const activeOpenClaw = useActiveOpenClawProfile()
  const routedProfileWorkspace = useProfileWorkspace()
  const profileWorkspace = profileWorkspaceOverride || routedProfileWorkspace
  const profileWorkspaceState = profileWorkspaceNavigationState(profileWorkspace)
  const activeProfile = profileWorkspace ? profileWorkspace.activeProfile : activeOpenClaw.activeProfile || ''
  const workspaceProfile = profileWorkspace || activeOpenClaw.workspaceProfile
  const profileRoutePath = childPath => (profileWorkspace ? profileWorkspacePath(profileWorkspace, childPath) : `/${childPath}`)
  const requiresLocalOpenClaw = shouldRequireLocalOpenClawSetup(workspaceProfile)
  const gatewayPort = profileWorkspace ? profileWorkspace.gatewayPort : workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null
  const connectionSnapshot = getGatewayConnectionSnapshot(activeProfile, gatewayPort)
  const [pairingApproveLoading, setPairingApproveLoading] = useState(false)
  const [browserRuntime, setBrowserRuntime] = useState(null)
  const [browserRuntimeLoading, setBrowserRuntimeLoading] = useState(false)
  const [browserRuntimeMessage, setBrowserRuntimeMessage] = useState(null)
  const [browserRuntimeError, setBrowserRuntimeError] = useState(null)
  const [browserUrl, setBrowserUrl] = useState('https://example.com')
  const [browserProfile, setBrowserProfile] = useState('')

  useEffect(() => {
    setBrowserRuntime(null)
    setBrowserRuntimeMessage(null)
    setBrowserRuntimeError(null)
  }, [activeProfile])

  useEffect(() => {
    if (user?.uid && !activeOpenClaw.loading && activeProfile) {
      refreshGatewayConnectionSnapshot({ profile: activeProfile, gatewayPort, silent: true }).catch(() => null)
      refreshBrowserRuntime({ silent: true }).catch(() => null)
    }
  }, [activeOpenClaw.loading, activeProfile, gatewayPort, user?.uid])

  useEffect(() => {
    function handleRefreshRequest() {
      refreshAll().catch(() => null)
    }

    window.addEventListener('imai:refresh-operations', handleRefreshRequest)
    return () => window.removeEventListener('imai:refresh-operations', handleRefreshRequest)
  }, [activeOpenClaw.loading, activeProfile, gatewayPort, user?.uid])

  async function refreshAll() {
    if (!user?.uid || activeOpenClaw.loading || !activeProfile) return
    const tasks = [
      refreshGatewayConnectionSnapshot({ profile: activeProfile, gatewayPort }),
      refreshBrowserRuntime({ silent: true }),
    ]
    await Promise.all(tasks)
  }

  async function approveLatestPairing() {
    if (!activeProfile) {
      setBrowserRuntimeError('组织管理员尚未为该工作区创建 Uniopc 引擎 profile。')
      return
    }
    setPairingApproveLoading(true)
    setBrowserRuntimeError(null)
    setBrowserRuntimeMessage(null)
    try {
      const result = await invoke('openclaw_profile_approve_latest_pairing', { input: { profile: activeProfile } })
      await refreshBrowserRuntime({ silent: true })
      setBrowserRuntimeMessage(result?.output_preview || (result?.approved ? 'Browser Runtime scope upgrade 已批准。' : 'Browser Runtime scope upgrade 未完成。'))
    } catch (error) {
      setBrowserRuntimeError(String(error?.message || error || '批准 Browser Runtime scope upgrade 失败'))
    } finally {
      setPairingApproveLoading(false)
    }
  }

  async function refreshBrowserRuntime(options = {}) {
    if (!activeProfile) return null
    const silent = Boolean(options?.silent)
    if (!silent) {
      setBrowserRuntimeLoading(true)
      setBrowserRuntimeError(null)
      setBrowserRuntimeMessage(null)
    }
    try {
      const snapshot = await invoke('openclaw_browser_runtime_snapshot', {
        req: {
          profile: activeProfile,
          browserProfile: browserProfile || 'openclaw',
        },
      })
      setBrowserRuntime(snapshot)
      if (!silent) setBrowserRuntimeMessage(snapshot?.message || 'Browser Runtime 状态已刷新。')
      return snapshot
    } catch (error) {
      const text = String(error?.message || error || '读取 Browser Runtime 状态失败')
      if (!silent) setBrowserRuntimeError(text)
      return null
    } finally {
      if (!silent) setBrowserRuntimeLoading(false)
    }
  }

  async function setBrowserRuntimeEnabled(enabled) {
    if (!activeProfile) return
    setBrowserRuntimeLoading(true)
    setBrowserRuntimeError(null)
    setBrowserRuntimeMessage(null)
    try {
      const result = await invoke('openclaw_browser_runtime_set_enabled', {
        req: {
          profile: activeProfile,
          enabled,
        },
      })
      await wait(BROWSER_RUNTIME_RESTART_SETTLE_MS)
      const snapshot = await refreshBrowserRuntime({ silent: true })
      const restartError = result?.restartError || result?.restart_error
      if (restartError) {
        setBrowserRuntimeMessage(`浏览器配置已更新，但 Gateway 重启失败。请手动重启 Uniopc 引擎 后再试。${restartError}`)
      } else {
        setBrowserRuntimeMessage(snapshot?.message || (enabled ? '浏览器控制已开启。' : '浏览器控制已关闭。'))
      }
    } catch (error) {
      setBrowserRuntimeError(String(error?.message || error || '更新浏览器控制失败'))
    } finally {
      setBrowserRuntimeLoading(false)
    }
  }

  async function handleBrowserControlPrimaryAction() {
    if (browserRuntimeStatus === 'scope_upgrade_pending_approval') {
      await approveLatestPairing()
    } else if (browserRuntimeStatus === 'disabled' || browserRuntimeNeedsPolicyRepair || browserRuntimeGatewayUnsupported) {
      await setBrowserRuntimeEnabled(true)
    } else if (browserRuntimeStatus === 'stopped') {
      await runBrowserAction('start')
    } else if (browserRuntimeReady) {
      await setBrowserRuntimeEnabled(false)
    } else {
      await refreshBrowserRuntime()
    }
  }

  async function runBrowserAction(action, extra = {}) {
    if (!activeProfile) return
    setBrowserRuntimeLoading(true)
    setBrowserRuntimeError(null)
    setBrowserRuntimeMessage(null)
    try {
      const result = await invoke('openclaw_browser_action', {
        req: {
          profile: activeProfile,
          browserProfile: browserProfile || 'openclaw',
          action,
          ...extra,
        },
      })
      await refreshBrowserRuntime({ silent: true })
      setBrowserRuntimeMessage(result?.message || `${action} 已执行。`)
    } catch (error) {
      setBrowserRuntimeError(String(error?.message || error || `执行 browser ${action} 失败`))
    } finally {
      setBrowserRuntimeLoading(false)
    }
  }

  const gatewayConnected = isGatewayConnectionReady(connectionSnapshot)
  const connectionEndpointUrl = connectionSnapshot?.endpointUrl || connectionSnapshot?.endpoint_url || ''
  const currentGatewayUrl = connectionEndpointUrl ||
    `ws://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`
  const browserRuntimeStatus = browserRuntime?.status || 'unknown'
  const browserRuntimeReady = browserRuntimeStatus === 'ready'
  const browserRuntimeStopped = browserRuntimeStatus === 'stopped'
  const browserRuntimeNeedsPolicyRepair = ['browser_tool_policy_missing', 'browser_request_rejected'].includes(browserRuntimeStatus)
  const browserRuntimeNeedsScopeApproval = browserRuntimeStatus === 'scope_upgrade_pending_approval'
  const browserRuntimeGatewayUnsupported = browserRuntimeStatus === 'gateway_browser_rpc_unsupported'
  const browserRuntimeTone = browserRuntimeReady
    ? 'border border-emerald-400/18 bg-emerald-400/10 text-success-text'
    : browserRuntimeStatus === 'disabled'
      ? 'border border-subtle bg-surface-raised text-secondary'
    : browserRuntimeNeedsScopeApproval || browserRuntimeNeedsPolicyRepair
      ? 'border border-amber-400/18 bg-amber-400/10 text-warning-text'
      : 'border border-rose-400/18 bg-rose-400/10 text-danger-text'
  const browserRuntimeLabel = browserRuntimeReady
    ? '可用'
    : browserRuntimeStopped ? '待启动' : browserRuntimeStatus === 'disabled'
      ? '未开启'
      : browserRuntimeNeedsScopeApproval
        ? '需要授权'
        : browserRuntimeNeedsPolicyRepair
          ? '需要修复'
          : browserRuntimeGatewayUnsupported
            ? '需要修复'
          : browserRuntimeStatus === 'node_host_required'
            ? '需要远程主机'
            : browserRuntimeStatus === 'unknown'
              ? '未检测'
              : '不可用'
  const browserControlDescription = browserRuntimeReady
    ? 'AI 员工可以使用官方浏览器打开网页、读取页面并执行点击或输入。'
    : browserRuntimeStopped ? '专用浏览器尚未启动。可在这里启动，或直接在对话中让 AI 打开网页。' : browserRuntimeStatus === 'disabled'
      ? '当前 Uniopc 引擎 profile 还没有开启浏览器控制。'
      : browserRuntimeNeedsScopeApproval
        ? 'Gateway 正在等待批准浏览器权限升级。批准后，AI 员工才能继续使用官方浏览器。'
        : browserRuntimeNeedsPolicyRepair
          ? (browserRuntime?.message || 'AI 员工还不能使用浏览器，请修复并开启。')
          : browserRuntimeGatewayUnsupported
            ? '浏览器插件尚未提供控制接口。请修复并开启，然后重新检测。'
          : browserRuntimeStatus === 'node_host_required'
            ? '远程模式需要 Host 发布 browser capability 后，AI 员工才能使用浏览器。'
            : '还没有拿到可用的浏览器控制状态。'
  const browserControlPrimaryLabel = browserRuntimeReady
    ? '关闭浏览器控制'
    : browserRuntimeStatus === 'disabled'
      ? '开启浏览器控制'
      : browserRuntimeNeedsScopeApproval
        ? '批准浏览器权限'
        : browserRuntimeNeedsPolicyRepair
          ? '修复并开启'
          : browserRuntimeGatewayUnsupported
            ? '修复并开启'
          : browserRuntimeStatus === 'stopped' ? '启动专用浏览器' : '重新检测'
  const browserRuntimeExecutionLabel = browserRuntime?.executionTarget === 'host'
    ? '远程 Host'
    : browserRuntime?.executionTarget === 'this_mac'
      ? '这台 Mac'
      : requiresLocalOpenClaw ? '这台 Mac' : '远程 Host'
  const browserRuntimePendingScopes = (browserRuntime?.pendingRequests || browserRuntime?.pending_requests || [])
    .flatMap(item => Array.isArray(item?.scopes) ? item.scopes : [])
    .filter(Boolean)

  return (
    <div className={embedded ? 'space-y-5' : LAYOUT.wide}>
      {embedded ? null : (
        <section className="grid gap-5 lg:grid-cols-2">
          <div className={`${CARD.padded} space-y-3`}>
            <h2 className={HEADING.section}>系统操作</h2>
            <p className={`text-sm ${TEXT.secondary}`}>
              这里处理当前 profile 的 Uniopc 引擎 安装、Gateway 运行状态和连接恢复。模型登录和能力配置请进入当前 Profile 模型与能力页。
            </p>
            <div className={PAGE.actions}>
              <Link to={profileRoutePath('models')} state={profileWorkspaceState} className={ACTION.primary}>Profile 模型与能力</Link>
              <Link to={profileRoutePath('openclaw-runtime')} state={profileWorkspaceState} className={ACTION.secondary}>Uniopc 引擎 版本管理</Link>
              <Link to={profileRoutePath('cloud-documents')} state={profileWorkspaceState} className={ACTION.secondary}>文档</Link>
            </div>
          </div>

          <div className={`${CARD.padded} space-y-3`}>
            <h2 className={HEADING.section}>对话入口</h2>
            <p className={`text-sm ${TEXT.secondary}`}>
              这里确认底层主链是否健康；真正开始和 AI 员工协作时，直接回到对话或去配置员工即可。
            </p>
            <div className={PAGE.actions}>
              <Link to={profileRoutePath('conversations')} state={profileWorkspaceState} className={ACTION.primary}>回到对话</Link>
              <Link to={profileRoutePath('employees')} state={profileWorkspaceState} className={ACTION.secondary}>打开 AI 员工</Link>
            </div>
          </div>
        </section>
      )}

      <section className={`${SURFACE.panel} p-5`}>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={HEADING.section}>浏览器控制</h2>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${browserRuntimeTone}`}>
                {browserRuntimeLabel}
              </span>
              <span className="rounded-full border border-violet-400/18 bg-violet-400/10 px-2.5 py-1 text-xs font-medium text-accent-text">
                浏览器位置：{browserRuntimeExecutionLabel}
              </span>
            </div>
            <p className={`mt-2 text-sm ${TEXT.secondary}`}>
              {browserControlDescription}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={handleBrowserControlPrimaryAction} disabled={browserRuntimeLoading || pairingApproveLoading || !activeProfile} className={browserRuntimeReady ? ACTION.secondary : ACTION.primary}>
              {browserRuntimeLoading || pairingApproveLoading ? '处理中...' : browserControlPrimaryLabel}
            </button>
          </div>
        </div>

        {(browserRuntimeMessage || browserRuntimeError) && (
          <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            browserRuntimeError
              ? 'border-rose-400/20 bg-rose-400/10 text-danger-text'
              : 'border-subtle bg-surface-raised text-secondary'
          }`}>
            {sanitizeBrand(browserRuntimeError || browserRuntimeMessage)}
          </div>
        )}

        <details className="mt-5 rounded-xl border border-subtle bg-surface-raised p-4">
          <summary className={`cursor-pointer text-sm font-medium ${TEXT.primary}`}>高级诊断</summary>
          <div className={`mt-4 space-y-4 text-xs ${TEXT.secondary}`}>
            <div className="grid gap-2 md:grid-cols-2">
              <div>Browser profile：{sanitizeBrand(browserRuntime?.browserProfile || browserProfile || '默认浏览器环境')}</div>
              <div className="break-all">Gateway：{currentGatewayUrl}</div>
              <div>Status：{browserRuntimeStatus}</div>
              <div>Next action：{browserRuntime?.nextAction || 'none'}</div>
              {browserRuntime?.message && <div className="md:col-span-2">Message：{sanitizeBrand(browserRuntime.message)}</div>}
              {browserRuntimePendingScopes.length > 0 && (
                <div className="md:col-span-2">Requested scopes：{browserRuntimePendingScopes.join(' / ')}</div>
              )}
            </div>

            {browserRuntimeGatewayUnsupported ? (
              <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2.5 leading-5 text-warning-text">
                请先修复并开启浏览器插件并重启引擎，再重新检测控制接口。
              </div>
            ) : <>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => refreshBrowserRuntime()} disabled={browserRuntimeLoading || !gatewayConnected} className={ACTION.secondary}>
                  {browserRuntimeLoading ? '刷新中...' : '刷新'}
                </button>
                <button type="button" onClick={() => runBrowserAction('doctor')} disabled={browserRuntimeLoading || !gatewayConnected} className={ACTION.secondary}>
                  Doctor
                </button>
                <button type="button" onClick={() => runBrowserAction('start')} disabled={browserRuntimeLoading || !gatewayConnected} className={ACTION.secondary}>
                  Start
                </button>
                <button type="button" onClick={() => runBrowserAction('stop')} disabled={browserRuntimeLoading || !gatewayConnected} className={ACTION.secondary}>
                  Stop
                </button>
              </div>

              <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)_auto]">
                <input
                  className={SURFACE.input}
                  value={browserProfile}
                  onChange={event => setBrowserProfile(event.target.value)}
                  placeholder="默认浏览器环境"
                />
                <input
                  className={SURFACE.input}
                  value={browserUrl}
                  onChange={event => setBrowserUrl(event.target.value)}
                  placeholder="https://example.com"
                />
                <button
                  type="button"
                  onClick={() => runBrowserAction('open', { url: browserUrl, label: 'imai-browser-runtime' })}
                  disabled={browserRuntimeLoading || !gatewayConnected}
                  className={ACTION.primary}
                >
                  Open URL
                </button>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
              <div className={`${SURFACE.panelSoft} p-4`}>
                <div className={`text-sm font-semibold ${TEXT.primary}`}>Profiles</div>
                <div className={`mt-3 space-y-2 text-xs ${TEXT.secondary}`}>
                  {(browserRuntime?.profiles || []).length === 0 ? (
                    <div>暂无 profiles。运行 Doctor 或刷新后会显示。</div>
                  ) : browserRuntime.profiles.map(profile => (
                    <div key={profile.name || profile.id || JSON.stringify(profile)} className="flex items-center justify-between gap-3">
                      <span className="truncate text-primary">{profile.name || profile.id || 'browser'}</span>
                      <span className="shrink-0">{profile.driver || profile.transport || 'browser'} · {profile.running ? `${profile.tabCount || 0} tabs` : 'stopped'}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className={`${SURFACE.panelSoft} p-4`}>
                <div className={`text-sm font-semibold ${TEXT.primary}`}>Tabs</div>
                <div className={`mt-3 space-y-2 text-xs ${TEXT.secondary}`}>
                  {(browserRuntime?.tabs || []).length === 0 ? (
                    <div>暂无标签页。</div>
                  ) : browserRuntime.tabs.slice(0, 8).map(tab => (
                    <div key={tab.targetId || tab.tabId || tab.url} className="min-w-0">
                      <div className="truncate text-primary">{tab.title || tab.url || 'Untitled'}</div>
                      <div className="mt-0.5 truncate">{tab.targetId || tab.tabId || tab.suggestedTargetId} · {tab.url}</div>
                    </div>
                  ))}
                </div>
              </div>
              </div>
            </>}
          </div>
        </details>
      </section>

    </div>
  )
}
