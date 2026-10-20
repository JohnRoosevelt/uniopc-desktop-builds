import { useEffect, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { getAppUpdateStatus, installAppUpdate, relaunchApp, isVersionNewer } from '../lib/appUpdate'
import { createAppUpdateController, titlebarAppUpdateViewModel } from '../lib/appUpdateTitlebar'

export default function AppUpdateTitlebarControl({ channel = 'stable', rightClassName = 'right-[18px]' }) {
  const [state, setState] = useState({})
  const controller = useRef(null)
  useEffect(() => {
    const next = createAppUpdateController({
      check: () => getAppUpdateStatus({ channel }), install: installAppUpdate,
      relaunch: relaunchApp, isNewer: isVersionNewer, onChange: setState,
    })
    controller.current = next
    getVersion().then(next.setVersion).catch(() => {})
    next.refresh()
    const interval = window.setInterval(next.refresh, 30 * 60 * 1000)
    window.addEventListener('focus', next.refresh)
    return () => {
      next.dispose()
      window.clearInterval(interval)
      window.removeEventListener('focus', next.refresh)
    }
  }, [channel])
  const view = titlebarAppUpdateViewModel(state)
  return (
    <>
      <div className={`pointer-events-auto absolute ${rightClassName} top-[12px] z-10 flex flex-col items-end gap-1`}>
        <button type="button" onClick={() => controller.current?.click()} disabled={view.disabled}
          title={view.label} aria-label={view.label}
          className="inline-flex h-6 items-center justify-center rounded-md border border-black/8 bg-white/90 px-2.5 text-xs font-semibold text-[#4b5563] backdrop-blur transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60">
          {view.label}
        </button>
        {state.error && <p role="alert" className="max-w-xs rounded-md bg-surface-base p-2 text-xs text-red-600 shadow">{state.error}</p>}
      </div>
    {state.confirmInstall && (
      <div className="pointer-events-auto fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4" role="presentation">
        <section role="dialog" aria-modal="true" aria-labelledby="app-update-confirm-title" className="w-full max-w-md rounded-xl border border-border bg-surface-base p-5 text-primary shadow-xl">
          <h2 id="app-update-confirm-title" className="text-base font-semibold">安装 Uniopc 更新？</h2>
          <p className="mt-3 text-sm leading-6 text-secondary">安装更新会由应用更新器替换 Uniopc 程序。新版本引擎连接 Gateway 并通过健康检查后，才会清理旧版本运行文件；若启动失败，旧版本会保留以便恢复。账号设置、聊天记录和工作区会保留。</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="rounded-lg px-3 py-2 text-sm text-secondary hover:bg-state-hover" onClick={() => controller.current?.cancel()}>稍后</button>
            <button type="button" className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50" onClick={() => controller.current?.confirm()} disabled={view.disabled}>继续安装</button>
          </div>
        </section>
      </div>
    )}
    </>
  )
}
