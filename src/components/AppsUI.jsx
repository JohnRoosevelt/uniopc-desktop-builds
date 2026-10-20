/**
 * 「应用」下各个子应用共用的小构件。
 * 只用 lib/theme 的 token 常量和 index.css 的语义 utility，不写 hex、不写任意值。
 */
import { Link } from 'react-router-dom'
import { ACTION, FORM, HEADING, TEXT } from '../lib/theme'

/** 子应用页头：面包屑（返回应用广场）+ 标题 + 副标题 + 右侧操作 */
export function AppPageHeader({ title, subtitle, actions = null, icon = null }) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {icon ? (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-subtle bg-surface-overlay text-accent-text">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-tertiary">
            <Link to="/apps" className="transition-colors duration-[120ms] ease-out hover:text-primary">应用</Link>
            <span>/</span>
            <span className="text-secondary">{title}</span>
          </div>
          <h2 className={`${HEADING.page} mt-1 truncate`}>{title}</h2>
          {subtitle ? <p className={`mt-1 text-sm ${TEXT.secondary}`}>{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** 提示条：错误红、普通信息中性。空字符串不渲染。 */
export function MessageBar({ message, tone = 'info', onDismiss = null }) {
  if (!message) return null
  const toneClass = tone === 'error'
    ? 'border-default bg-danger-surface text-danger-text'
    : tone === 'success'
      ? 'border-default bg-success-surface text-success-text'
      : 'border-subtle bg-surface-overlay text-secondary'
  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${toneClass}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="shrink-0 text-xs opacity-70 hover:opacity-100">关闭</button>
      ) : null}
    </div>
  )
}

export function EmptyState({ children }) {
  return (
    <div className="rounded-xl border border-dashed border-subtle bg-surface-overlay px-4 py-10 text-center text-sm text-tertiary">
      {children}
    </div>
  )
}

/** 非阻塞状态卡：只统一视觉容器，状态语义和恢复动作由调用方提供。 */
export function FeedbackCard({ children, tone = 'info', className = '', ...props }) {
  const toneClass = tone === 'error'
    ? 'border-default bg-danger-surface'
    : tone === 'empty'
      ? 'border-dashed border-subtle bg-surface-overlay'
      : 'border-subtle bg-surface-overlay'
  return (
    <div {...props} className={`rounded-xl border px-4 py-3 ${toneClass} ${className}`}>
      {children}
    </div>
  )
}

export function Field({ label, hint = '', children }) {
  return (
    <label className="block">
      {label ? <span className={FORM.label}>{label}</span> : null}
      {children}
      {hint ? <span className={FORM.hint}>{hint}</span> : null}
    </label>
  )
}

/** 开关：小程序 <switch> 的桌面对应物 */
export function Toggle({ label, checked, onChange, disabled = false }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-subtle bg-surface-overlay px-3 py-2.5">
      <span className="text-sm text-secondary">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-[120ms] ease-out disabled:opacity-50 ${
          checked ? 'bg-brand' : 'bg-surface-sunken border border-default'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-surface-float ui-elevation-raised transition-transform duration-[120ms] ease-out ${
            checked ? 'translate-x-[19px]' : 'translate-x-[3px]'
          }`}
        />
      </button>
    </div>
  )
}

/** 分段 tab 条 */
export function TabBar({ tabs, active, onChange }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-xl border border-subtle bg-surface-overlay p-1">
      {tabs.map(tab => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors duration-[120ms] ease-out ${
            active === tab.key
              ? 'bg-state-selected text-accent-text'
              : 'text-tertiary hover:bg-state-hover hover:text-primary'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export function InlineButton({ children, onClick, disabled = false, tone = 'secondary', title = '' }) {
  const cls = tone === 'primary' ? ACTION.primary : tone === 'danger' ? ACTION.danger : ACTION.secondary
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled} className={`${cls} h-8 px-3 text-xs`}>
      {children}
    </button>
  )
}
