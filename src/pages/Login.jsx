import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { buildStartupFailureReport } from '../lib/startupDiagnostics'
import { errorMessage } from '../lib/errorMessage'
import { shouldRedirectLoggedInUserFromLogin } from '../lib/authGate'
import { APP_MODES, isHostAppMode } from '../lib/appModes'
import AppUpdateTitlebarControl from '../components/AppUpdateTitlebarControl'

// 登录页跟随应用主题（appearanceTheme 的 light/dark/system），不自己钉死 ——
// 否则会出现"登录页深色、进去变浅色"的割裂。氛围层走 --ui-auth-* token，
// 两个主题各一套，保证品牌氛围在浅色下也成立而不是糊成脏灰。
//
// 它此前硬涂深色背景却仍继承 light 主题，于是 text-white 被浅色补丁改写成
// 近黑压在紫色渐变 CTA 上 —— 对比度 2.3:1。现在 CTA 是真白压品牌紫。
const SHELL_INPUT =
  'w-full rounded-xl border border-default bg-surface-sunken px-4 py-2.5 text-base text-primary transition-[border-color,box-shadow] duration-200 ease-out placeholder:text-tertiary focus:border-brand/60 focus:outline-none focus:ring-4 focus:ring-brand/20'

const SHELL_LABEL = 'mb-1.5 block text-2xs font-semibold uppercase tracking-[0.12em] text-tertiary'
// CTA 上的白字是真白 —— 它压在饱和品牌渐变上，两个主题都该是白的。
const SHELL_BUTTON =
  'w-full rounded-xl bg-[linear-gradient(100deg,var(--ui-brand),var(--ui-brand-soft))] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_14px_34px_-24px_rgba(139,49,245,0.9)] transition-[filter,opacity] duration-200 ease-out hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40'
function AuthShell({ title, children, versionLabel = '', wide = false, brandName = 'Uniopc', logoSrc = '/uniopc-logo.png', logoAlt = 'Uniopc', appUpdateSlot = null }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-surface-sunken px-4 py-8 md:px-8 md:py-10">
      <div className="absolute inset-0 bg-[image:var(--ui-auth-wash)]" />
      <div className="absolute inset-0 bg-[image:linear-gradient(var(--ui-auth-grid)_1px,transparent_1px),linear-gradient(90deg,var(--ui-auth-grid)_1px,transparent_1px)] [background-size:52px_52px]" />
      <div className="absolute inset-x-0 top-0 h-px bg-[image:linear-gradient(90deg,transparent,var(--ui-auth-hairline),transparent)]" />
      <div className="absolute left-0 top-[18%] h-px w-full bg-[image:linear-gradient(90deg,transparent,var(--ui-auth-hairline),transparent)] opacity-40" />
      <div className="absolute bottom-[18%] left-0 h-px w-full bg-[image:linear-gradient(90deg,transparent,var(--ui-auth-hairline),transparent)] opacity-30" />
      <div className="absolute inset-0 bg-[image:var(--ui-auth-vignette)]" />
      {appUpdateSlot}

      <div className={`relative z-10 mx-auto flex min-h-[calc(100vh-4rem)] w-full ${wide ? 'max-w-[1040px]' : 'max-w-[1100px]'} flex-col lg:flex-row`}>
        <div className="relative flex flex-1 flex-col justify-center overflow-hidden px-4 py-8 sm:px-7 lg:px-9 xl:px-10">
          <div className="inline-flex w-fit items-center gap-3">
            <img src={logoSrc} alt={logoAlt} className="h-8 w-8 rounded-lg object-contain shadow-[0_0_26px_-10px_rgba(139,49,245,0.95)]" />
            <div className="text-left">
              <div className="text-2xl font-semibold tracking-tight text-primary">{brandName}</div>
            </div>
            {versionLabel && (
              <div className="rounded-md border border-brand/20 bg-brand/8 px-2 py-1 text-2xs font-semibold text-accent-text/80">
                {versionLabel}
              </div>
            )}
          </div>

          <div className="mt-8 max-w-[540px]">
            <h1 className="text-[28px] font-semibold leading-[1.14] tracking-[-0.02em] text-primary sm:text-[32px] lg:text-[38px]">{title}</h1>
            <div className="mt-5 h-px w-36 bg-gradient-to-r from-brand/70 via-brand-soft/30 to-transparent" />
          </div>
        </div>

        <div className="flex w-full shrink-0 items-center justify-center px-1 py-5 sm:px-3 lg:w-[420px] lg:px-3 xl:w-[460px]">
          <div className="w-full rounded-3xl border border-brand/20 bg-[linear-gradient(180deg,rgba(176,108,255,0.20),rgba(139,49,245,0.08))] p-[1px] shadow-[0_34px_90px_-58px_rgba(139,49,245,0.95)]">
            {/* 卡片抬升靠 elevation token：深色下是内高光 + 阴影，浅色下白之上
                没有更白，只能靠阴影 —— 原来那条 inset 高光在浅色里完全不可见。 */}
            <div className="ui-elevation-modal w-full rounded-3xl border border-subtle bg-surface-raised p-6 md:p-7">
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function AuthCard({ eyebrow, title, description, children, wide = false }) {
  return (
    <div className={`mx-auto ${wide ? 'max-w-[520px]' : 'max-w-[340px]'}`}>
      <div className="mb-5">
        {eyebrow && <div className="ui-text-eyebrow text-accent-text/72">{eyebrow}</div>}
        <h2 className={`ui-text-h1 text-primary ${eyebrow ? 'mt-3' : ''}`}>{title}</h2>
        {description && <p className="ui-text-body-sm mt-2 text-tertiary">{description}</p>}
      </div>
      {children}
    </div>
  )
}

function Field({ label, hint = null, children }) {
  return (
    <div>
      <label className={SHELL_LABEL}>{label}</label>
      {children}
      {hint && <p className="mt-2 text-xs leading-5 text-tertiary">{hint}</p>}
    </div>
  )
}

function ErrorBanner({ message }) {
  if (!message) return null
  return (
    <div className="rounded-2xl border border-rose-300/20 bg-rose-500/10 px-4 py-3 text-sm text-danger-text">
      {message}
    </div>
  )
}

function AnonymousStartupDiagnostics({ loginFailure = '' }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [consent, setConsent] = useState(false)
  const [report, setReport] = useState(null)
  const [message, setMessage] = useState('')

  async function prepareReport() {
    if (loading) return
    setOpen(value => !value)
    if (open) return
    setLoading(true)
    setMessage('')
    setConsent(false)
    try {
      const [metrics, events, version] = await Promise.all([
        invoke('openclaw_startup_metrics').catch(() => []),
        invoke('openclaw_startup_events').catch(() => null),
        getVersion().catch(() => 'unknown'),
      ])
      const summary = buildStartupFailureReport({
        startupMetrics: metrics,
        startupEvents: events,
        appVersion: version,
        platform: navigator.platform,
        submissionMode: 'anonymous',
        loginFailure,
      })
      setReport(summary)
      if (!summary) setMessage('本机没有找到可发送的启动失败摘要。')
    } catch (err) {
      setReport(null)
      setMessage(String(err?.message || err || '读取本机启动诊断失败。'))
    } finally {
      setLoading(false)
    }
  }

  async function sendReport() {
    if (!report || !consent || sending) return
    setSending(true)
    setMessage('')
    try {
      const { error: submitError } = await supabase.functions.invoke('desktop-diagnostics', {
        body: { ...report, consentedAt: new Date().toISOString() },
      })
      if (submitError) throw submitError
      setMessage(`匿名诊断摘要已发送，编号 ${report.clientReportId}`)
      setReport(null)
      setConsent(false)
    } catch (err) {
      setMessage(String(err?.message || err || '发送失败，请稍后重试。'))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mt-5 border-t border-subtle pt-4">
      <button type="button" className="text-xs font-medium text-accent-text hover:underline" onClick={prepareReport}>
        {open ? '收起匿名诊断' : '登录遇到问题？发送匿名诊断摘要'}
      </button>
      {open && (
        <div className="mt-3 rounded-xl border border-default bg-surface-sunken p-3">
          <p className="text-xs leading-5 text-secondary">
            不需要登录。仅在你勾选同意后发送版本、系统、失败阶段/类别、耗时和阶段摘要；不包含手机号、账号、Profile 名称、错误原文或完整日志。服务端只临时使用网络来源信息限频，不保存来源 IP。
          </p>
          {loading ? <div className="mt-3 text-xs text-tertiary">正在读取本机记录...</div> : report ? (
            <>
              <div className="mt-3 text-xs leading-5 text-primary">
                将发送：Uniopc {report.appVersion} · {report.operatingSystem} · {report.failureStage} · {report.failureCategory} · {report.durationMs} ms · {report.events.length} 条阶段摘要
              </div>
              {report.events.length > 0 && (
                <details className="mt-2 text-xs text-secondary">
                  <summary className="cursor-pointer">展开查看阶段摘要</summary>
                  <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap">{JSON.stringify(report.events, null, 2)}</pre>
                </details>
              )}
              <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-secondary">
                <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
                我已查看摘要，并同意匿名发送给 Uniopc 用于故障排查。
              </label>
              <button type="button" onClick={sendReport} disabled={!consent || sending} className="mt-3 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
                {sending ? '发送中...' : '同意并匿名发送'}
              </button>
            </>
          ) : null}
          {message && <div className="mt-2 text-xs text-secondary">{message}</div>}
        </div>
      )}
    </div>
  )
}

export default function Login({ appMode = APP_MODES.HOST }) {
  const { t } = useTranslation()
  const { user, profile, loading, requestPhoneOtp, verifyPhoneOtp } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const isHostApp = isHostAppMode(appMode)
  const [authError, setAuthError] = useState(() => {
    const routeError = typeof location.state?.authError === 'string' ? location.state.authError : ''
    try {
      const storedError = sessionStorage.getItem('imai.auth.modeError') || ''
      if (storedError) sessionStorage.removeItem('imai.auth.modeError')
      return routeError || storedError
    } catch {
      return routeError
    }
  })
  const [phone, setPhone] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [smsCountdown, setSmsCountdown] = useState(0)
  const [smsSending, setSmsSending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-base text-sm text-tertiary">
        {t('common.loading')}
      </div>
    )
  }
  if (shouldRedirectLoggedInUserFromLogin({ user, profile, appMode })) {
    return <Navigate to={isHostApp ? '/' : '/conversations'} replace />
  }

  function normalizePhone(value) {
    const digits = String(value || '').replace(/\D/g, '')
    if (digits.startsWith('86') && digits.length === 13) return digits.slice(2)
    return digits
  }

  const phoneReady = normalizePhone(phone).length === 11

  async function handleSendSms() {
    if (smsSending || smsCountdown > 0 || !phoneReady) return
    setError('')
    setNotice('')
    setSmsSending(true)
    const { error: err } = await requestPhoneOtp(normalizePhone(phone))
    setSmsSending(false)
    if (err) {
      setError(errorMessage(err, '验证码发送失败，请稍后重试'))
      return
    }
    setNotice('验证码已发送，请查收短信')
    setSmsCountdown(60)
    const timer = setInterval(() => {
      setSmsCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  async function handlePhoneSubmit(e) {
    e.preventDefault()
    if (submitting || !phoneReady || smsCode.trim().length < 4) return
    setError('')
    setAuthError('')
    setNotice('')
    setSubmitting(true)
    const { error: err, profile: nextProfile } = await verifyPhoneOtp(normalizePhone(phone), smsCode.trim())
    if (err) {
      setError(errorMessage(err, '验证码校验失败，请重试'))
      setSubmitting(false)
      return
    }
    setSubmitting(false)
    if (nextProfile) {
      navigate(isHostApp ? '/' : '/conversations', { replace: true })
    }
  }

  return (
    <AuthShell
      title="Uniopc 一人公司操作系统"
      versionLabel={isHostApp && 'Host 版本'}
      logoSrc="/uniopc-logo.png"
      logoAlt="Uniopc"
      appUpdateSlot={<AppUpdateTitlebarControl />}
    >
      <AuthCard
        title="手机号登录 / 注册"
      >
        <form onSubmit={handlePhoneSubmit} className="space-y-4">
          <Field label="手机号">
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              required
              autoFocus
              className={SHELL_INPUT}
              placeholder="11 位手机号"
            />
          </Field>
          <Field label="短信验证码" hint="未注册的手机号验证后自动完成注册">
            <div className="flex gap-2">
              <input
                type="text"
                value={smsCode}
                onChange={e => setSmsCode(e.target.value)}
                required
                className={SHELL_INPUT}
                placeholder="6 位验证码"
              />
              <button
                type="button"
                onClick={handleSendSms}
                disabled={smsSending || smsCountdown > 0 || !phoneReady}
                className="shrink-0 rounded-xl border border-brand/30 px-4 text-sm font-medium text-accent-text transition-colors hover:bg-brand/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {smsCountdown > 0 ? `${smsCountdown}s` : smsSending ? '发送中…' : '发送验证码'}
              </button>
            </div>
          </Field>
          <ErrorBanner message={error || authError} />
          {notice && (
            <div className="rounded-2xl border border-emerald-300/20 bg-emerald-500/10 px-4 py-3 text-sm text-success-text">
              {notice}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting || !phoneReady || smsCode.trim().length < 4}
            className={SHELL_BUTTON}
          >
            {submitting ? t('common.processing') : '验证并登录 / 注册'}
          </button>
        </form>
        <AnonymousStartupDiagnostics loginFailure={error || authError} />
      </AuthCard>
    </AuthShell>
  )
}
