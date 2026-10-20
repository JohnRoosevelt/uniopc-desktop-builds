export default function ConversationStatusBanner({
  error,
  notice,
  queuedMessageId,
  retryDisabled = false,
  onRetryQueuedMessage,
  onNavigateRecovery,
}) {
  if (queuedMessageId && onRetryQueuedMessage) {
    return (
      <button
        type="button"
        disabled={retryDisabled}
        onClick={() => onRetryQueuedMessage(queuedMessageId)}
        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-secondary transition-colors hover:bg-state-hover hover:text-primary"
        title="重新发送"
      >
        重试
      </button>
    )
  }

  return (
    <>
      {notice?.message && (
        <div className="mx-auto w-full max-w-[1180px] px-3 pb-3">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-400/20 bg-amber-400/10 px-3.5 py-2.5 text-sm text-warning-text">
            <span className="leading-5">{notice.message}</span>
            <button
              type="button"
              className="shrink-0 rounded-lg px-2 py-1 text-xs opacity-70 hover:opacity-100"
              onClick={notice.onDismiss}
            >
              知道了
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mx-auto w-full max-w-[1180px] px-3 pb-3">
          <div className={`rounded-xl border px-3.5 py-2.5 text-sm ${
            error.calm
              ? 'border-amber-400/20 bg-amber-400/10 text-warning-text'
              : 'border-rose-400/18 bg-rose-400/10 text-danger-text'
          }`}>
            <div className="font-medium">
              {error.title}
            </div>
            <div className="mt-1 leading-5 opacity-90">
              {error.description}
            </div>
            {error.rawMessage && (
              <div className="mt-1 truncate text-xs opacity-60" title={error.rawMessage}>
                {error.rawMessage}
              </div>
            )}
            {error.showRecovery && (
              <button
                type="button"
                onClick={onNavigateRecovery}
                className="mt-2 font-medium underline underline-offset-2"
              >
                {error.recoveryLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
