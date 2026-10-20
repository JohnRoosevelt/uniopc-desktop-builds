import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { getAppUpdateStatus, installAppUpdate, relaunchApp } from '../lib/appUpdate'
import { titlebarAppUpdateViewModel } from '../lib/appUpdateTitlebar'

export default function AppUpdateTitlebarControl({ channel = 'stable', rightClassName = 'right-[18px]' }) {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [confirmInstall, setConfirmInstall] = useState(false)

  useEffect(() => {
    let cancelled = false

    const refresh = async () => {
      try {
        const nextStatus = await getAppUpdateStatus({ channel })
        if (cancelled) return
        setStatus(prev => ({
          ...(prev || {}),
          ...nextStatus,
          currentVersion: nextStatus.currentVersion || prev?.currentVersion || '',
          latestVersion: nextStatus.latestVersion || nextStatus.version || prev?.latestVersion || '',
        }))
      } catch {}
    }

    getVersion()
      .then((currentVersion) => {
        if (cancelled) return
        setStatus(prev => ({
          ...(prev || {}),
          currentVersion,
          latestVersion: prev?.latestVersion || currentVersion,
          available: Boolean(prev?.available),
          update: prev?.update || null,
        }))
      })
      .catch(() => {})

    refresh()
    const interval = window.setInterval(refresh, 30 * 60 * 1000)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [channel])

  const view = titlebarAppUpdateViewModel({
    currentVersion: status?.currentVersion,
    latestVersion: status?.latestVersion || status?.version,
    available: status?.available,
    busy,
    installed,
  })

  if (!view.label) return null

  async function handleClick() {
    if (!view.actionable || view.disabled) return

    if (installed) {
      setBusy(true)
      try {
        await relaunchApp()
      } catch (error) {
        console.error('relaunch app failed', error)
        setBusy(false)
      }
      return
    }

    setConfirmInstall(true)
  }

  async function confirmAndInstall() {
    setConfirmInstall(false)

    setBusy(true)
    try {
      let nextStatus = status
      if (!nextStatus?.update) {
        nextStatus = await getAppUpdateStatus({ channel })
        setStatus(prev => ({
          ...(prev || {}),
          ...nextStatus,
          currentVersion: nextStatus.currentVersion || prev?.currentVersion || '',
          latestVersion: nextStatus.latestVersion || nextStatus.version || prev?.latestVersion || '',
        }))
      }
      await installAppUpdate(nextStatus?.update)
      setInstalled(true)
      await relaunchApp()
    } catch (error) {
      console.error('install app update failed', error)
    } finally {
      setBusy(false)
    }
  }

  const baseClassName = `pointer-events-auto absolute ${rightClassName} top-[12px] z-10 inline-flex items-center justify-center rounded-md px-2.5 text-xs font-semibold leading-none transition-colors`

  if (!view.actionable) {
    return (
      <div
        className={`${baseClassName} h-6 min-w-[64px] border border-black/8 bg-white/90 text-[#4b5563] backdrop-blur`}
        title={`当前版本 ${view.label}`}
        aria-label={`当前版本 ${view.label}`}
      >
        {view.label}
      </div>
    )
  }

  return (
    <>
    <button
      type="button"
      onClick={handleClick}
      disabled={view.disabled}
      title={view.kind === 'restarting' ? '正在重启以完成更新' : '下载并安装新版本'}
      aria-label={view.kind === 'restarting' ? '正在重启以完成更新' : '下载并安装新版本'}
      className={`${baseClassName} h-6 min-w-[68px] border border-transparent bg-[#3894f6] text-white hover:bg-surface-float disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {view.label}
    </button>
    {confirmInstall && (
      <div className="pointer-events-auto fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4" role="presentation">
        <section role="dialog" aria-modal="true" aria-labelledby="app-update-confirm-title" className="w-full max-w-md rounded-xl border border-border bg-surface-base p-5 text-primary shadow-xl">
          <h2 id="app-update-confirm-title" className="text-base font-semibold">安装 Uniopc 更新？</h2>
          <p className="mt-3 text-sm leading-6 text-secondary">安装更新会由应用更新器替换 Uniopc 程序。新版本引擎连接 Gateway 并通过健康检查后，才会清理旧版本运行文件；若启动失败，旧版本会保留以便恢复。账号设置、聊天记录和工作区会保留。</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="rounded-lg px-3 py-2 text-sm text-secondary hover:bg-state-hover" onClick={() => setConfirmInstall(false)}>稍后</button>
            <button type="button" className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50" onClick={confirmAndInstall} disabled={busy}>继续安装</button>
          </div>
        </section>
      </div>
    )}
    </>
  )
}
