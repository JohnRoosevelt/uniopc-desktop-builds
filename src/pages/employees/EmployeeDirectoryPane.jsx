import EmployeeListPane from '../../components/EmployeeListPane'

export default function EmployeeDirectoryPane({
  employees,
  roster,
  selectedEmployeeId,
  loading,
  onSelect,
  onCreate,
  onOpenChat,
  emptyDescription,
  addLabel,
  error,
  notice,
  requests,
  canManage,
  requestActionId,
  onApproveRequest,
}) {
  return (
    <EmployeeListPane
      mode="settings"
      employees={employees}
      roster={roster}
      loading={loading}
      activeEmployeeId={selectedEmployeeId}
      onAdd={onCreate}
      onOpenEmployeeSettings={onSelect}
      onOpenEmployeeChat={onOpenChat}
      emptyDescription={emptyDescription}
      addLabel={addLabel}
      beforeList={(
        <>
          {error && (
            <div className="m-3 rounded-xl border border-rose-400/18 bg-rose-400/10 px-3 py-2 text-sm leading-5 text-danger-text">
              {error}
            </div>
          )}

          {notice && (
            <div className="m-3 rounded-xl border border-violet-400/18 bg-violet-400/10 px-3 py-2 text-sm leading-5 text-accent-text">
              {notice}
            </div>
          )}

          {requests.length > 0 && (
            <div className="border-b border-subtle px-3.5 py-3">
              <div className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-tertiary">
                创建申请
              </div>
              <div className="grid gap-2">
                {requests.slice(0, 4).map(request => (
                  <div key={request.id} className="rounded-xl border border-subtle bg-surface-sunken p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-primary">{request.name || 'AI 员工'}</div>
                        <div className="mt-1 truncate text-xs text-tertiary">
                          {request.status === 'pending' ? '待批准' : request.status === 'failed' ? '创建失败' : '已处理'}
                          {request.requester_email ? ` · ${request.requester_email}` : ''}
                        </div>
                      </div>
                      {canManage && request.status === 'pending' && (
                        <button
                          type="button"
                          onClick={() => onApproveRequest(request)}
                          disabled={Boolean(requestActionId)}
                          className="shrink-0 rounded-lg border border-violet-400/20 bg-violet-400/10 px-2.5 py-1 text-xs font-medium text-accent-text transition-colors hover:bg-violet-400/15 disabled:opacity-50"
                        >
                          {requestActionId === request.id ? '批准中' : '批准'}
                        </button>
                      )}
                    </div>
                    {request.failure_message && (
                      <div className="mt-2 line-clamp-2 text-xs leading-5 text-danger-text">{request.failure_message}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    />
  )
}
