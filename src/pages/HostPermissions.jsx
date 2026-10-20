import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

const FALLBACK_PERMISSION_ROWS = [
  {
    id: 'appleScript',
    title: 'Automation (AppleScript)',
    subtitle: 'Control other apps (e.g. Terminal) for automation actions',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    subtitle: 'Show desktop alerts for agent activity',
  },
  {
    id: 'accessibility',
    title: 'Accessibility',
    subtitle: 'Control UI elements when an action requires it',
  },
  {
    id: 'screenRecording',
    title: 'Screen Recording',
    subtitle: 'Capture the screen for context or screenshots',
  },
  {
    id: 'microphone',
    title: 'Microphone',
    subtitle: 'Allow Voice Wake and audio capture',
  },
  {
    id: 'speechRecognition',
    title: 'Speech Recognition',
    subtitle: 'Transcribe Voice Wake trigger phrases on-device',
  },
  {
    id: 'camera',
    title: 'Camera',
    subtitle: 'Capture photos and video from the camera',
  },
  {
    id: 'location',
    title: 'Location',
    subtitle: 'Share location when requested by the agent',
  },
]

function PermissionGlyph({ id, granted }) {
  const icons = {
    appleScript: '⌁',
    notifications: '♢',
    accessibility: '✋',
    screenRecording: '▣',
    microphone: '◌',
    speechRecognition: '≋',
    camera: '▢',
    location: '⌖',
  }
  return (
    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base font-semibold ${
      granted ? 'bg-emerald-400/14 text-success-text' : 'bg-surface-overlay text-tertiary'
    }`}>
      {icons[id] || '•'}
    </span>
  )
}

function PermissionStatusPill({ granted, pending }) {
  if (pending) {
    return <span className="text-xs font-medium text-secondary">Checking...</span>
  }
  return (
    <span className={`text-xs font-semibold ${granted ? 'text-success-text' : 'text-tertiary'}`}>
      {granted ? 'Granted' : 'Request access'}
    </span>
  )
}

function PermissionRow({ permission, pending, onRequest }) {
  return (
    <div className="flex items-center gap-4 border-b border-subtle px-4 py-4 last:border-b-0">
      <PermissionGlyph id={permission.id} granted={permission.granted} />
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold text-primary">{permission.title}</div>
        <div className="mt-1 text-sm leading-5 text-secondary">{permission.subtitle}</div>
      </div>
      <div className="flex min-w-[128px] shrink-0 flex-col items-end gap-1">
        {permission.granted ? (
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-400/14 text-success-text">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </span>
        ) : (
          <button
            type="button"
            onClick={onRequest}
            disabled={pending || permission.supported === false}
            className="inline-flex h-8 min-w-[76px] items-center justify-center rounded-lg border border-default bg-surface-overlay px-3 text-sm font-medium text-primary transition-colors hover:bg-state-hover disabled:opacity-50"
          >
            {pending ? '...' : 'Grant'}
          </button>
        )}
        <PermissionStatusPill granted={permission.granted} pending={pending} />
      </div>
    </div>
  )
}

export default function HostPermissions() {
  const [permissionStatus, setPermissionStatus] = useState(null)
  const [permissionLoading, setPermissionLoading] = useState(false)
  const [permissionPendingId, setPermissionPendingId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    refreshPermissions({ silent: true })
  }, [])

  async function refreshPermissions(options = {}) {
    const silent = Boolean(options?.silent)
    if (!silent) {
      setPermissionLoading(true)
      setError('')
      setMessage('')
    }
    try {
      const status = await invoke('mac_permissions_status')
      setPermissionStatus(status)
    } catch (err) {
      setError(String(err?.message || err || '读取 macOS 权限状态失败'))
    } finally {
      if (!silent) setPermissionLoading(false)
    }
  }

  async function requestPermission(permissionId) {
    setPermissionPendingId(permissionId)
    setError('')
    setMessage('')
    try {
      const status = await invoke('mac_permissions_request', { capability: permissionId })
      setPermissionStatus(status)
      setMessage('权限请求已打开。请在 macOS 系统设置中完成授权，然后刷新状态。')
      for (const delay of [500, 1500, 3000]) {
        window.setTimeout(() => {
          refreshPermissions({ silent: true }).catch(() => null)
        }, delay)
      }
    } catch (err) {
      setError(String(err?.message || err || '请求 macOS 权限失败'))
    } finally {
      setPermissionPendingId('')
    }
  }

  return (
    <section className="mx-auto max-w-[1080px]">
      {(message || error) && (
        <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${error ? 'border-rose-400/20 bg-rose-500/10 text-danger-text' : 'border-emerald-400/18 bg-emerald-400/10 text-success-text'}`}>
          {error || message}
        </div>
      )}

      <h1 className="text-3xl font-semibold tracking-[0] text-primary">本机权限</h1>
      <p className="mt-2 text-base leading-6 text-secondary">
        这台 Mac 上的 Uniopc 引擎/Uniopc macOS access for notifications, capture, voice, and device context.
      </p>

      <div className="mt-6 rounded-xl border border-default bg-surface-raised p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${permissionStatus?.granted === permissionStatus?.total && permissionStatus?.total ? 'bg-emerald-400/14 text-success-text' : 'bg-amber-400/14 text-warning-text'}`}>
              <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3.75l7.25 2.7v5.3c0 4.35-2.9 7.05-7.25 8.5-4.35-1.45-7.25-4.15-7.25-8.5v-5.3L12 3.75z" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="text-lg font-semibold text-primary">
                {permissionStatus?.total
                  ? permissionStatus.granted === permissionStatus.total
                    ? 'All access granted'
                    : `${permissionStatus.granted} of ${permissionStatus.total} permissions granted`
                  : 'Checking permissions'}
              </div>
              <div className="mt-1 text-sm leading-5 text-secondary">
                Uniopc only asks for macOS capabilities when a feature needs them. Applies to all workspaces on this Mac.
              </div>
            </div>
          </div>
          <button type="button" onClick={() => refreshPermissions()} disabled={permissionLoading} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-default bg-surface-overlay px-3 text-sm font-medium text-primary transition-colors hover:bg-state-hover disabled:opacity-50">
            <svg className={`h-4 w-4 ${permissionLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={1.9} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8.1 8.1 0 00-15.5-2M4 5v4h4M4 13a8.1 8.1 0 0015.5 2M20 19v-4h-4" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-default bg-surface-raised">
        {(permissionStatus?.permissions?.length ? permissionStatus.permissions : FALLBACK_PERMISSION_ROWS.map(item => ({
          ...item,
          granted: false,
          supported: true,
        }))).map(permission => (
          <PermissionRow
            key={permission.id}
            permission={permission}
            pending={permissionPendingId === permission.id}
            onRequest={() => requestPermission(permission.id)}
          />
        ))}
      </div>

      {permissionStatus?.supported === false && (
        <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm text-warning-text">
          macOS permissions are only available in the macOS desktop app.
        </div>
      )}
    </section>
  )
}
