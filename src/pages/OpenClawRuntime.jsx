import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { ACTION, HEADING, LAYOUT, SURFACE, TEXT } from '../lib/theme'
import { supabase } from '../lib/supabase'
import { buildStartupFailureReport } from '../lib/startupDiagnostics'
import {
  refreshOpenClawStatus,
  setOpenClawRuntimeStatus,
  useRuntimeStatusStore,
} from '../lib/runtimeStatus'
import { sanitizeBrand } from '../lib/brandSanitizer'

function statusTone(kind) {
  if (kind === 'success') return 'border border-emerald-400/18 bg-emerald-400/10 text-success-text'
  if (kind === 'danger') return 'border border-rose-400/20 bg-rose-400/10 text-danger-text'
  return 'border border-amber-400/18 bg-amber-400/10 text-warning-text'
}

function normalizeVersion(value) {
  return String(value || '').replace(/^Uniopc 引擎\s*/i, '').trim()
}

function runtimeVersionLabel(status) {
  if (!status?.installed) return '未安装'
  return normalizeVersion(status.version) || '未知版本'
}

function compatibleVersionLabel(status) {
  return normalizeVersion(status?.latestVersion) || '未检测'
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return '—'
  if (value < 1000) return `${value} 毫秒`
  return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} 秒`
}

function formatRecordedAt(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function compatibilityState(status) {
  if (!status?.supported) return { tone: 'danger', label: '当前系统不支持' }
  if (!status?.installed) return { tone: 'warning', label: '未安装' }
  if (status.updateAvailable === true) return { tone: 'warning', label: '需要更新' }
  if (status.updateAvailable === false) return { tone: 'success', label: '版本兼容' }
  if (status.setupStage === 'unsupported_openclaw_version') return { tone: 'warning', label: '需要更新' }
  return { tone: 'warning', label: '未检测' }
}

function RuntimeCard({ title, value, detail, tone = 'warning' }) {
  return (
    <div className={`${SURFACE.panelSoft} min-h-[118px] p-4`}>
      <div className={`text-sm font-semibold ${TEXT.primary}`}>{title}</div>
      <div className="mt-3">
        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(tone)}`}>
          {value}
        </span>
      </div>
      {detail && <div className={`mt-3 break-all text-xs leading-5 ${TEXT.secondary}`}>{detail}</div>}
    </div>
  )
}

export default function OpenClawRuntime() {
  const runtime = useRuntimeStatusStore()
  const mountedRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [log, setLog] = useState(null)
  const [logBusy, setLogBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [startupMetrics, setStartupMetrics] = useState(null)
  const [startupMetricsLoading, setStartupMetricsLoading] = useState(false)
  const [startupEvents, setStartupEvents] = useState(null)
  const [startupEventsLoading, setStartupEventsLoading] = useState(false)
  const [diagnosticsPreview, setDiagnosticsPreview] = useState(false)
  const [diagnosticsConsent, setDiagnosticsConsent] = useState(false)
  const [diagnosticsSending, setDiagnosticsSending] = useState(false)
  const [diagnosticsMessage, setDiagnosticsMessage] = useState('')
  const [diagnosticsAppVersion, setDiagnosticsAppVersion] = useState('读取中...')
  const status = runtime.openClaw.status || {}
  const compatibility = compatibilityState(status)
  const canInstall = status.supported !== false && !busy
  const actionLabel = status.installed ? '安装兼容版本' : '安装 Uniopc 引擎'

  useEffect(() => {
    mountedRef.current = true
    refreshOpenClawStatus({ silent: true }).catch(() => null)
    loadStartupMetrics({ silent: true }).catch(() => null)
    loadStartupEvents({ silent: true }).catch(() => null)
    getVersion().then(version => {
      if (mountedRef.current) setDiagnosticsAppVersion(version)
    }).catch(() => {
      if (mountedRef.current) setDiagnosticsAppVersion('unknown')
    })
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function refresh() {
    setError('')
    setMessage('')
    try {
      await Promise.all([
        refreshOpenClawStatus(),
        loadStartupMetrics({ silent: true }),
        loadStartupEvents({ silent: true }),
      ])
      if (mountedRef.current) setMessage('Uniopc 引擎 Runtime 状态已刷新')
    } catch (err) {
      if (mountedRef.current) setError(typeof err === 'string' ? err : '刷新 Uniopc 引擎 Runtime 状态失败')
    }
  }

  async function checkUpdate() {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('正在检测 Uniopc 兼容版本...')
    try {
      const next = await invoke('openclaw_check_update')
      if (!mountedRef.current) return
      const nextStatus = setOpenClawRuntimeStatus(next)
      setMessage(nextStatus?.updateMessage || 'Uniopc 引擎 兼容版本检测完成')
    } catch (err) {
      if (mountedRef.current) setError(typeof err === 'string' ? err : '检测 Uniopc 引擎 兼容版本失败')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  async function installOrUpdate() {
    if (!canInstall) return
    setBusy(true)
    setError('')
    setMessage(status.installed ? '正在安装 Uniopc 引擎 兼容版本...' : '正在安装 Uniopc 引擎...')
    try {
      const result = await invoke(status.installed ? 'openclaw_update' : 'openclaw_install')
      if (!mountedRef.current) return
      if (result?.status) {
        const nextStatus = setOpenClawRuntimeStatus(result.status)
        setMessage(nextStatus?.updateMessage || result.message || `${actionLabel}完成`)
      } else {
        await refreshOpenClawStatus({ silent: true })
        setMessage(result?.message || `${actionLabel}完成`)
      }
    } catch (err) {
      if (mountedRef.current) setError(typeof err === 'string' ? err : `${actionLabel}失败`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  async function loadLog() {
    if (logBusy) return
    setLogBusy(true)
    setError('')
    try {
      const next = await invoke('openclaw_gateway_log_tail', {})
      if (mountedRef.current) setLog(next)
    } catch (err) {
      if (mountedRef.current) setError(typeof err === 'string' ? err : '读取 Uniopc 引擎 日志失败')
    } finally {
      if (mountedRef.current) setLogBusy(false)
    }
  }

  async function loadStartupMetrics(options = {}) {
    const silent = Boolean(options.silent)
    if (!silent) {
      setStartupMetricsLoading(true)
      setError('')
    }
    try {
      const next = await invoke('openclaw_startup_metrics')
      if (mountedRef.current) setStartupMetrics(Array.isArray(next) ? next : [])
    } catch (err) {
      if (!silent && mountedRef.current) setError(typeof err === 'string' ? err : '读取 Uniopc 引擎启动记录失败')
    } finally {
      if (!silent && mountedRef.current) setStartupMetricsLoading(false)
    }
  }

  async function loadStartupEvents(options = {}) {
    const silent = Boolean(options.silent)
    if (!silent) setStartupEventsLoading(true)
    try {
      const next = await invoke('openclaw_startup_events')
      if (mountedRef.current) setStartupEvents(next)
    } catch (err) {
      if (!silent && mountedRef.current) {
        setError(typeof err === 'string' ? err : '读取 Uniopc 启动阶段记录失败')
      }
    } finally {
      if (!silent && mountedRef.current) setStartupEventsLoading(false)
    }
  }

  async function copyDiagnostics() {
    try {
      const [latestLog, latestMetrics, latestEvents] = await Promise.all([
        invoke('openclaw_gateway_log_tail', {}),
        invoke('openclaw_startup_metrics'),
        invoke('openclaw_startup_events'),
      ])
      if (!mountedRef.current) return
      setLog(latestLog)
      setStartupMetrics(Array.isArray(latestMetrics) ? latestMetrics : [])
      setStartupEvents(latestEvents)
      const sections = [
        `Uniopc Gateway 日志\n${latestLog.path}\n${latestLog.content || '暂无 Gateway 子进程日志。'}`,
        `Uniopc 最近启动记录\n${JSON.stringify(latestMetrics, null, 2)}`,
        `Uniopc 启动阶段事件\n${latestEvents.path}\n${latestEvents.content || '暂无启动阶段事件。'}`,
      ]
      await navigator.clipboard.writeText(sections.join('\n\n---\n\n'))
      if (!mountedRef.current) return
      setCopied(true)
      setTimeout(() => {
        if (mountedRef.current) setCopied(false)
      }, 1500)
    } catch (err) {
      if (mountedRef.current) setError(typeof err === 'string' ? err : '复制 Uniopc 启动诊断信息失败')
    }
  }

  function currentFailureReport() {
    return buildStartupFailureReport({
      startupMetrics,
      startupEvents,
      appVersion: diagnosticsAppVersion,
      platform: navigator.platform,
    })
  }

  async function sendDiagnostics() {
    if (!diagnosticsConsent || diagnosticsSending) return
    const report = currentFailureReport()
    if (!report) {
      setDiagnosticsMessage('没有找到可发送的启动失败摘要，请先刷新启动记录。')
      return
    }
    setDiagnosticsSending(true)
    setDiagnosticsMessage('')
    try {
      const { error: submitError } = await supabase.functions.invoke('desktop-diagnostics', { body: report })
      if (submitError) throw submitError
      setDiagnosticsMessage(`诊断摘要已发送，编号 ${report.clientReportId}`)
      setDiagnosticsPreview(false)
      setDiagnosticsConsent(false)
    } catch (err) {
      setDiagnosticsMessage(String(err?.message || err || '发送失败，请检查网络后重试。'))
    } finally {
      setDiagnosticsSending(false)
    }
  }

  return (
    <div className={LAYOUT.wide}>
      <section className={`${SURFACE.panel} p-5`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className={HEADING.page}>Uniopc 引擎 版本管理</h1>
            <p className={`mt-2 max-w-3xl text-sm leading-6 ${TEXT.secondary}`}>
              这里管理这台设备上的全局 Uniopc 引擎 CLI、Node runtime 和插件兼容版本。所有本机 Uniopc 引擎 profile 共用这套运行时；profile 页面只管理自己的 Gateway、模型登录和 AI 员工。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={ACTION.secondary} onClick={refresh} disabled={busy || runtime.openClaw.loading}>
              刷新状态
            </button>
            <button type="button" className={ACTION.secondary} onClick={checkUpdate} disabled={busy || !status.installed}>
              检查兼容版本
            </button>
            <button type="button" className={ACTION.primary} onClick={installOrUpdate} disabled={!canInstall}>
              {busy ? '处理中...' : actionLabel}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <RuntimeCard
            title="Uniopc 本地服务"
            value={runtimeVersionLabel(status)}
            detail={sanitizeBrand(status.binaryPath) || '未检测到 Uniopc 本地服务'}
            tone={status.installed ? 'success' : 'warning'}
          />
          <RuntimeCard
            title="兼容版本"
            value={compatibleVersionLabel(status)}
            detail={status.updateMessage || '点击检查兼容版本后显示 Uniopc 验证版本。'}
            tone={compatibility.tone}
          />
          <RuntimeCard
            title="Node Runtime"
            value={status.nodeVersion || '未检测'}
            detail="Uniopc 引擎 插件运行时依赖本机 Node 工具链。"
            tone={status.nodeVersion ? 'success' : 'warning'}
          />
          <RuntimeCard
            title="网络代理"
            value={status.proxySummary || '未配置代理（直连）'}
            detail="排查网络问题时先看这里：引擎联网走此代理；本地引擎连接不受代理影响。"
            tone="success"
          />
          <RuntimeCard
            title="Gateway 基础状态"
            value={status.gatewayRunning ? '运行中' : '未运行'}
            detail={status.gatewayStatusMessage || status.dashboardUrl || 'Gateway 由各 profile 页面启动和连接。'}
            tone={status.gatewayRunning ? 'success' : 'warning'}
          />
        </div>

        {(message || error || status.message) && (
          <div className={`mt-5 rounded-2xl border px-4 py-3 text-sm ${error ? statusTone('danger') : statusTone('success')}`}>
            <div className="font-medium">{error || message || status.message}</div>
            {status.message && (message || error) && (
              <div className="mt-1 text-xs opacity-75">{status.message}</div>
            )}
          </div>
        )}
      </section>

      <section className={`${SURFACE.panel} p-5`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={HEADING.section}>最近启动记录</h2>
            <p className={`mt-1 max-w-2xl text-sm leading-6 ${TEXT.secondary}`}>
              当前 profile 最近 20 次 Uniopc 引擎启动的阶段耗时。失败记录会保留失败原因，方便判断是准备、启动还是就绪阶段较慢。
            </p>
          </div>
          <button type="button" className={ACTION.secondary} onClick={() => loadStartupMetrics()} disabled={startupMetricsLoading}>
            {startupMetricsLoading ? '读取中...' : '刷新记录'}
          </button>
        </div>
        {startupMetrics === null ? (
          <div className={`mt-4 ${SURFACE.panelSoft} p-3 text-sm ${TEXT.secondary}`}>正在读取启动记录...</div>
        ) : startupMetrics.length === 0 ? (
          <div className={`mt-4 ${SURFACE.panelSoft} p-3 text-sm ${TEXT.secondary}`}>暂无启动记录。首次启动 Uniopc 引擎后会显示在这里。</div>
        ) : (
          <div className={`mt-4 overflow-x-auto ${SURFACE.panelSoft}`}>
            <table className="w-full min-w-[800px] text-left text-xs">
              <thead className={`border-b border-subtle ${TEXT.secondary}`}>
                <tr>
                  <th className="px-3 py-3 font-medium">时间</th>
                  <th className="px-3 py-3 font-medium">总耗时</th>
                  <th className="px-3 py-3 font-medium">运行环境准备</th>
                  <th className="px-3 py-3 font-medium">启动进程</th>
                  <th className="px-3 py-3 font-medium">引擎就绪</th>
                  <th className="px-3 py-3 font-medium">结果</th>
                </tr>
              </thead>
              <tbody className={TEXT.secondary}>
                {[...startupMetrics].reverse().map(metric => (
                  <tr key={`${metric.recordedAt}-${metric.totalMs}`} className="border-b border-subtle last:border-0">
                    <td className="whitespace-nowrap px-3 py-3">{formatRecordedAt(metric.recordedAt)}</td>
                    <td className={`whitespace-nowrap px-3 py-3 font-medium ${TEXT.primary}`}>{formatDuration(metric.totalMs)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{formatDuration(metric.runtimePreparationMs)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{formatDuration(metric.gatewaySpawnMs)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{formatDuration(metric.gatewayReadyMs)}</td>
                    <td className="max-w-sm px-3 py-3">{metric.failure ? sanitizeBrand(metric.failure) : '成功'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={`${SURFACE.panel} p-5`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={HEADING.section}>发送脱敏诊断摘要</h2>
            <p className={`mt-1 max-w-2xl text-sm leading-6 ${TEXT.secondary}`}>
              仅在启动失败后可发送。上传前由你确认；只包含应用版本、操作系统、失败阶段/类别、耗时和阶段结果，不包含账号、Profile 名称、文件路径、错误原文或完整日志。
            </p>
          </div>
          <button type="button" className={ACTION.secondary} onClick={() => {
            setDiagnosticsMessage('')
            setDiagnosticsConsent(false)
            setDiagnosticsPreview(value => !value)
          }}>
            {diagnosticsPreview ? '收起' : '查看并发送摘要'}
          </button>
        </div>
        {diagnosticsPreview && (
          <div className={`${SURFACE.panelSoft} mt-4 p-4`}>
            {(() => {
              const report = currentFailureReport()
              return report ? (
                <>
                  <div className={`text-sm leading-6 ${TEXT.primary}`}>
                    将发送：Uniopc {report.appVersion} · {report.operatingSystem} · {report.failureStage} · {report.failureCategory} · {formatDuration(report.durationMs)} · {report.events.length} 条阶段摘要
                  </div>
                  {report.events.length > 0 && (
                    <details className={`mt-2 text-xs ${TEXT.secondary}`}>
                      <summary className="cursor-pointer">展开查看阶段摘要</summary>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(report.events, null, 2)}</pre>
                    </details>
                  )}
                  <label className={`mt-3 flex items-start gap-2 text-sm leading-5 ${TEXT.secondary}`}>
                    <input type="checkbox" checked={diagnosticsConsent} onChange={event => setDiagnosticsConsent(event.target.checked)} />
                    我已查看上述字段，并同意将这份脱敏诊断摘要发送给 Uniopc 用于排查问题。
                  </label>
                  <button type="button" className={`${ACTION.primary} mt-3`} disabled={!diagnosticsConsent || diagnosticsSending} onClick={sendDiagnostics}>
                    {diagnosticsSending ? '发送中...' : '同意并发送'}
                  </button>
                </>
              ) : <div className={`text-sm ${TEXT.secondary}`}>当前没有可发送的失败摘要。刷新启动记录后再试。</div>
            })()}
          </div>
        )}
        {diagnosticsMessage && <div className={`mt-3 text-sm ${TEXT.secondary}`}>{diagnosticsMessage}</div>}
      </section>

      <section className={`${SURFACE.panel} p-5`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={HEADING.section}>启动阶段事件</h2>
            <p className={`mt-1 max-w-2xl text-sm leading-6 ${TEXT.secondary}`}>
              记录运行时准备、Profile 检查、Gateway 启动和首次连接探测结果。记录保留在 Uniopc 用户数据目录，桌面端重装不会清除。
            </p>
          </div>
          <button type="button" className={ACTION.secondary} onClick={() => loadStartupEvents()} disabled={startupEventsLoading}>
            {startupEventsLoading ? '读取中...' : '刷新事件'}
          </button>
        </div>
        {startupEvents?.exists && startupEvents.content ? (
          <div className="mt-4">
            <div className={`mb-2 break-all text-xs ${TEXT.secondary}`}>{startupEvents.path}</div>
            <pre className={`${SURFACE.panelSoft} max-h-80 overflow-auto p-3 text-xs leading-5 ${TEXT.secondary}`} style={{ whiteSpace: 'pre-wrap' }}>
              {startupEvents.content}
            </pre>
          </div>
        ) : (
          <div className={`mt-4 ${SURFACE.panelSoft} p-3 text-sm ${TEXT.secondary}`}>
            {startupEventsLoading ? '正在读取启动事件...' : '暂无启动阶段事件。下一次启动后会自动记录。'}
          </div>
        )}
      </section>

      <section className={`${SURFACE.panel} p-5`}>
        <h2 className={HEADING.section}>管理边界</h2>
        <div className={`mt-4 grid gap-3 text-sm ${TEXT.secondary} md:grid-cols-3`}>
          <div className={SURFACE.panelSoft + ' p-4'}>
            <div className={`font-semibold ${TEXT.primary}`}>全局 Runtime</div>
            <div className="mt-2 leading-6">Uniopc 引擎 CLI、安装脚本、全局 Node 工具链和兼容版本在这里统一管理。</div>
          </div>
          <div className={SURFACE.panelSoft + ' p-4'}>
            <div className={`font-semibold ${TEXT.primary}`}>Profile Gateway</div>
            <div className="mt-2 leading-6">每个 profile 的端口、Gateway 连接和 Dashboard 仍在成员详情中管理。</div>
          </div>
          <div className={SURFACE.panelSoft + ' p-4'}>
            <div className={`font-semibold ${TEXT.primary}`}>Profile 模型与能力</div>
            <div className="mt-2 leading-6">Codex/OpenAI 登录、默认模型和 provider 状态只属于当前 profile，不提升为组织全局配置。</div>
          </div>
        </div>
      </section>

      <section className={`${SURFACE.panel} p-5`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={HEADING.section}>引擎日志</h2>
            <p className={`mt-1 max-w-2xl text-sm leading-6 ${TEXT.secondary}`}>
              Gateway 日志、启动耗时和阶段事件保存在 Uniopc 用户数据目录中，桌面端卸载重装后仍可用于排查首次启动问题。复制诊断信息会同时包含这些记录。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={ACTION.secondary} onClick={loadLog} disabled={logBusy}>
              {logBusy ? '读取中...' : '查看日志'}
            </button>
            <button type="button" className={ACTION.secondary} onClick={copyDiagnostics}>
              {copied ? '已复制' : '复制诊断信息'}
            </button>
          </div>
        </div>
        {log && (
          <div className="mt-4">
            <div className={`mb-2 break-all text-xs ${TEXT.secondary}`}>{log.path}</div>
            {log.exists && log.content ? (
              <pre
                className={`${SURFACE.panelSoft} max-h-80 overflow-auto p-3 text-xs leading-5 ${TEXT.secondary}`}
                style={{ whiteSpace: 'pre-wrap' }}
              >
                {log.content}
              </pre>
            ) : (
              <div className={`${SURFACE.panelSoft} p-3 text-xs ${TEXT.secondary}`}>
                暂无日志（引擎尚未在本账号下启动，或日志已轮转）。
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
