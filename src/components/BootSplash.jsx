import { getCurrentWindow } from '@tauri-apps/api/window'

function startWindowDrag(event) {
  if (event.button !== 0) return
  event.preventDefault()
  getCurrentWindow().startDragging().catch(() => {})
}

export default function BootSplash({
  title = '正在准备 Uniopc',
  detail = '正在检查运行环境，请稍候…',
  actions = null,
}) {
  const actionItems = Array.isArray(actions) ? actions.filter(Boolean) : []
  return (
    <div className="relative min-h-screen bg-surface-raised px-6 py-10">
      <div
        data-tauri-drag-region
        onMouseDown={startWindowDrag}
        className="absolute inset-x-0 top-0 z-10 h-[36px]"
      />
      <div className="mx-auto flex min-h-[70vh] max-w-4xl flex-col items-center justify-center text-center">
        <div className="relative mb-8 h-36 w-36">
          <div className="absolute inset-0 rounded-full bg-violet-400/10 blur-2xl" />
          <div className="absolute inset-4 animate-ping rounded-full border border-violet-300/20" />
          <div className="absolute inset-1 animate-[spin_6s_linear_infinite] rounded-full border border-dashed border-violet-300/25" />
          <div className="absolute inset-5 animate-[spin_9s_linear_infinite_reverse] rounded-full border border-default" />
          <div className="absolute inset-[34px] rounded-full bg-gradient-to-br from-violet-400 via-sky-500 to-blue-600 shadow-[0_0_80px_-20px_rgba(34,211,238,0.8)]" />
          <div className="absolute inset-[54px] rounded-full border border-strong bg-surface-sunken backdrop-blur-sm" />
        </div>

        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-[#f8fafc]">
            {title}
          </h1>
          <p className="max-w-xl text-sm leading-7 text-[#a8a29e]">
            {detail}
          </p>
          {actionItems.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              {actionItems.map(action => (
                <button
                  key={action.key || action.label}
                  type="button"
                  onClick={action.onClick}
                  disabled={action.disabled}
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-default bg-white px-4 text-sm font-medium text-[#1f1d1d] shadow-sm transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
