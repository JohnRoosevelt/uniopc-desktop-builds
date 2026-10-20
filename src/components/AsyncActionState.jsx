import { sanitizeBrand } from '../lib/brandSanitizer'
import { FeedbackCard, InlineButton } from './AppsUI'

function StateDetail({ children, tone = 'muted' }) {
  if (!children) return null
  const textClass = tone === 'error' ? 'text-danger-text' : 'text-tertiary'
  return <p className={`mt-1 break-words text-xs ${textClass}`}>{children}</p>
}

export function AsyncActionState({
  state,
  title,
  detail,
  onRetry,
  retryLabel = '重试',
  className = '',
  children,
}) {
  const safeDetail = typeof detail === 'string' ? sanitizeBrand(detail) : ''
  let feedback = null

  if (state === 'loading') {
    feedback = (
      <FeedbackCard className={className} role="status" aria-live="polite" aria-atomic="true">
        <p className="text-sm font-medium text-secondary">{title || '正在加载…'}</p>
        <StateDetail>{safeDetail}</StateDetail>
      </FeedbackCard>
    )
  } else if (state === 'empty') {
    feedback = (
      <FeedbackCard className={className} tone="empty" role="status" aria-live="polite" aria-atomic="true">
        {title ? <p className="text-sm font-medium text-secondary">{title}</p> : null}
        <StateDetail>{safeDetail}</StateDetail>
      </FeedbackCard>
    )
  } else if (state === 'error') {
    feedback = (
      <FeedbackCard className={className} tone="error" role="status" aria-live="polite" aria-atomic="true">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-danger-text">{title || '操作失败'}</p>
            <StateDetail tone="error">{safeDetail}</StateDetail>
          </div>
          {typeof onRetry === 'function' ? (
            <InlineButton onClick={onRetry}>{retryLabel}</InlineButton>
          ) : null}
        </div>
      </FeedbackCard>
    )
  }

  return (
    <>
      {feedback}
      {children}
    </>
  )
}
