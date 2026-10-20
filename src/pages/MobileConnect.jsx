import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import QRCode from 'qrcode'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { profileWorkspaceNavigationState, useProfileWorkspace } from '../hooks/useProfileWorkspace'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { publishOpenClawProfilePairingSetup } from '../lib/cloudWorkspace'
import { HEADING, LAYOUT, SURFACE, TEXT } from '../lib/theme'

const DEFAULT_GATEWAY_PORT = 18790
const PAIRING_POLL_INTERVAL_MS = 4000

// Local direct-connect: the phone reaches this desktop's gateway over the LAN /
// loopback, no cloud relay. The simulator shares the host network stack so
// 127.0.0.1 works as-is; a real phone uses the desktop's LAN IP (added with the
// LAN-bind work). This is our structural edge over cloud-relayed peers: the
// phone is just another OpenClaw node on the gateway.
function localGatewayUrl(gatewayPort) {
  const port = Number(gatewayPort) || DEFAULT_GATEWAY_PORT
  return `ws://127.0.0.1:${port}`
}

// Brand-purple pill switch (no shared component exists yet). Mirrors the Accio
// "keep these settings on" rows, but drives our direct-connect flow.
function Switch({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-150',
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
        checked ? 'bg-brand' : 'bg-surface-sunken border border-default',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-150',
          checked ? 'translate-x-[22px]' : 'translate-x-[2px]',
        ].join(' ')}
      />
    </button>
  )
}

function SettingRow({ icon, title, description, children, last }) {
  return (
    <div className={`flex items-center justify-between gap-4 px-5 py-4 ${last ? '' : 'border-b border-subtle'}`}>
      <div className="flex items-start gap-3 min-w-0">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-overlay text-secondary">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-primary">{title}</div>
          <div className={`text-xs ${TEXT.muted} mt-0.5`}>{description}</div>
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Step({ n, title, children }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-white">{n}</span>
        <span className="text-sm font-medium text-primary">{title}</span>
      </div>
      <div className={`mt-2 text-xs ${TEXT.body} leading-relaxed`}>{children}</div>
    </div>
  )
}

export default function MobileConnect() {
  const { user } = useAuth()
  const activeOpenClaw = useActiveOpenClawProfile()
  const profileWorkspace = useProfileWorkspace()
  const profileWorkspaceState = profileWorkspaceNavigationState(profileWorkspace)
  const activeProfile = profileWorkspace ? profileWorkspace.activeProfile : activeOpenClaw.activeProfile || ''
  const gatewayPort = profileWorkspace ? profileWorkspace.gatewayPort : activeOpenClaw.workspaceProfile?.gatewayPort || activeOpenClaw.workspaceProfile?.gateway_port || null
  const ownerId = user?.uid || user?.id || null
  const openclawProfileId = activeOpenClaw.workspaceProfile?.openclawProfileId
    || activeOpenClaw.workspaceProfile?.openclaw_profile_id
    || profileWorkspace?.openclawProfileId
    || null

  const [allowConnect, setAllowConnect] = useState(false)
  const [lanUrl, setLanUrl] = useState('')
  // The port the local engine actually bound (from openclaw_mobile_lan_status →
  // local_gateway_port). The cloud-stored gatewayPort can be a stale fallback
  // port from a prior run, so the setup code must never be built from it.
  const [realPort, setRealPort] = useState(null)
  const [togglingLan, setTogglingLan] = useState(false)
  const [keepAwake, setKeepAwake] = useState(false)
  const [setupCode, setSetupCode] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)
  const [pairing, setPairing] = useState(null)
  const [approving, setApproving] = useState(false)
  const pollTimer = useRef(null)

  const generateSetupCode = useCallback(async () => {
    if (!activeProfile) {
      setError('组织管理员尚未为该工作区创建 Uniopc 引擎 profile。')
      return
    }
    setGenerating(true)
    setError(null)
    setMessage(null)
    try {
      // Prefer the LAN URL (from the enable toggle) so a real phone on the same
      // Wi-Fi can reach us; else loopback on the engine's ACTUAL bound port.
      // realPort (local_gateway_port) is authoritative; the cloud gatewayPort is
      // a last-resort fallback and may be a stale port from a prior run.
      const loopbackPort = realPort || gatewayPort
      const url = lanUrl || localGatewayUrl(loopbackPort)
      const setup = await invoke('openclaw_profile_remote_setup_code', {
        input: { profile: activeProfile, gatewayUrl: url },
      })
      const code = setup?.setupCode || setup?.setup_code || ''
      if (!code) throw new Error('Uniopc 引擎 没有返回连接码。')
      setSetupCode(code)
      setQrDataUrl(await QRCode.toDataURL(code, { margin: 1, width: 220, errorCorrectionLevel: 'M' }))
      // Publish to the cloud so a signed-in phone can auto-fetch this code and
      // connect directly (login-discovery). Best-effort: scanning still works if
      // this fails, so a cloud hiccup must not clobber the local QR flow.
      if (ownerId && openclawProfileId) {
        try {
          await publishOpenClawProfilePairingSetup(supabase, ownerId, {
            openclawProfileId,
            setupCode: code,
            gatewayUrl: url,
            expiresInMinutes: 30,
          })
          setMessage('连接码已生成，并已同步到云端——登录后的手机可自动连接。')
        } catch (pubErr) {
          console.warn('[mobile-connect] publish setup code failed', pubErr?.message || pubErr)
          setMessage('连接码已生成（云端同步失败，可改用扫码连接）。')
        }
      }
    } catch (err) {
      setError(String(err?.message || err || '生成连接码失败'))
      setSetupCode('')
      setQrDataUrl('')
    } finally {
      setGenerating(false)
    }
  }, [activeProfile, gatewayPort, lanUrl, realPort, ownerId, openclawProfileId])

  const refreshPairing = useCallback(async () => {
    if (!activeProfile) return
    try {
      setPairing(await invoke('openclaw_profile_pairing_status', { input: { profile: activeProfile } }) || null)
    } catch {
      // Transient gateway hiccups must not clobber a generated code.
    }
  }, [activeProfile])

  async function approvePairing() {
    if (!activeProfile) return
    setApproving(true)
    setError(null)
    setMessage(null)
    try {
      const result = await invoke('openclaw_profile_approve_latest_pairing', { input: { profile: activeProfile } })
      setMessage(result?.output_preview || (result?.approved ? '配对已批准，手机已连接。' : '当前没有待批准的配对请求。'))
      await refreshPairing()
    } catch (err) {
      setError(String(err?.message || err || '批准配对失败'))
    } finally {
      setApproving(false)
    }
  }

  async function copySetupCode() {
    if (!setupCode) return
    try {
      await navigator.clipboard?.writeText(setupCode)
      setMessage('连接码已复制。')
    } catch {
      setError('复制失败，请手动选择文本。')
    }
  }

  // Flip LAN mobile access on the gateway (binds LAN + restarts) and capture the
  // LAN URL to encode into the setup code. Backed by the Rust command, not just
  // local state, so the gateway actually re-binds.
  async function handleToggleLan(next) {
    if (!activeProfile || togglingLan) return
    setTogglingLan(true)
    setError(null)
    setMessage(null)
    try {
      const state = await invoke('openclaw_mobile_lan_set_enabled', {
        input: { profile: activeProfile, enabled: next },
      })
      if (state?.recoveryRequired || state?.recovery_required) {
        throw { message: '移动端连接配置不一致，需要恢复。', recoveryRequired: true }
      }
      const enabled = Boolean(state?.enabled)
      setLanUrl(state?.gateway_url || state?.gatewayUrl || '')
      if (state?.port) setRealPort(state.port)
      setAllowConnect(enabled)
      if (enabled && !(state?.gateway_url || state?.gatewayUrl)) {
        setError('已开启，但未找到局域网地址——请确认此电脑已连接 Wi-Fi。')
      }
    } catch (err) {
      setError(String(err?.message || err || '切换失败'))
      const authoritativeEnabled = err?.authoritativeEnabled ?? err?.authoritative_enabled
      const recoveryRequired = err?.recoveryRequired ?? err?.recovery_required
      if (!recoveryRequired && typeof authoritativeEnabled === 'boolean') {
        setAllowConnect(authoritativeEnabled)
        if (!authoritativeEnabled) setLanUrl('')
      } else {
        try {
          const state = await invoke('openclaw_mobile_lan_status', {
            input: { profile: activeProfile },
          })
          if (state?.recoveryRequired || state?.recovery_required) {
            setError(`${String(err?.message || err || '切换失败')}；配置恢复未完成，请重试或打开引擎设置修复。`)
          } else {
            setAllowConnect(Boolean(state?.enabled))
            setLanUrl(state?.gateway_url || state?.gatewayUrl || '')
            if (state?.port) setRealPort(state.port)
          }
        } catch {
          // Keep the last confirmed UI value when authoritative state cannot be read.
        }
      }
    } finally {
      setTogglingLan(false)
    }
  }

  // On profile change, read the current LAN state to init the toggle + URL, and
  // clear any stale code/pairing (a code is profile-scoped).
  useEffect(() => {
    setSetupCode('')
    setQrDataUrl('')
    setPairing(null)
    setError(null)
    setMessage(null)
    if (!activeProfile) {
      setAllowConnect(false)
      setLanUrl('')
      setRealPort(null)
      return
    }
    invoke('openclaw_mobile_lan_status', { input: { profile: activeProfile } })
      .then(state => {
        if (state?.recoveryRequired || state?.recovery_required) {
          setError('移动端连接配置不一致，请重试开关或打开引擎设置修复。')
        } else {
          setAllowConnect(Boolean(state?.enabled))
          setLanUrl(state?.gateway_url || state?.gatewayUrl || '')
          setRealPort(state?.port || null)
        }
      })
      .catch(() => {
        setAllowConnect(false)
        setLanUrl('')
        setRealPort(null)
      })
  }, [activeProfile])

  // Turning on "allow connect" generates the code and starts watching for a
  // pairing request; turning off clears the code (feature off = no QR).
  useEffect(() => {
    if (!allowConnect) {
      setSetupCode('')
      setQrDataUrl('')
      if (pollTimer.current) window.clearInterval(pollTimer.current)
      return undefined
    }
    generateSetupCode()
    refreshPairing()
    pollTimer.current = window.setInterval(refreshPairing, PAIRING_POLL_INTERVAL_MS)
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    }
  }, [allowConnect, generateSetupCode, refreshPairing])

  // The status command returns pending_requests (a plural array — device + node
  // pairing merged); take the first. Reading the old singular keys left the
  // 批准 button gated on a field that never existed, so it never appeared.
  const pendingRequests = pairing?.pending_requests || pairing?.pendingRequests || []
  const pendingRequest = pendingRequests[0] || pairing?.pendingRequest || pairing?.pending_request || null
  const pairedDevices = pairing?.pairedDevices || pairing?.paired_devices || pairing?.devices || []
  const deviceIcon = (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
      <rect x="2.5" y="4.5" width="14" height="10" rx="1.5" /><path strokeLinecap="round" d="M6 18.5h7" />
      <rect x="16.5" y="8.5" width="5" height="11" rx="1.2" />
    </svg>
  )
  const sunIcon = (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" /><path strokeLinecap="round" d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )

  return (
    <div className={LAYOUT.narrow}>
      <div className="flex flex-col items-center pt-2 pb-1 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-state-selected text-brand">
          <svg className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <rect x="2.5" y="4.5" width="14" height="10.5" rx="1.5" /><path strokeLinecap="round" d="M6 18.5h7" />
            <rect x="16" y="8" width="5.5" height="12" rx="1.3" />
          </svg>
        </div>
        <h1 className={HEADING.page}>连接移动端</h1>
        <p className={`mt-2 max-w-[440px] text-sm ${TEXT.body}`}>
          在手机上接收更新、继续任务，随时开始新工作。手机以 node 身份直连本机引擎，无需云端中转。
        </p>
      </div>

      {!activeProfile && (
        <div className={`${SURFACE.panel} p-5 text-sm ${TEXT.body}`}>
          {profileWorkspaceState?.message || '当前工作区尚未就绪，无法开启移动端连接。'}
        </div>
      )}

      {activeProfile && (
        <>
          <div className="space-y-3">
            <h2 className={`text-sm font-medium ${TEXT.muted} px-1`}>保持以下设置开启</h2>
            <div className={SURFACE.panel}>
              <SettingRow
                icon={deviceIcon}
                title="允许手机连接此电脑"
                description="同账号 / 局域网内的已授权设备可直连此电脑引擎"
              >
                <Switch checked={allowConnect} onChange={handleToggleLan} disabled={togglingLan || generating} />
              </SettingRow>
              <SettingRow
                icon={sunIcon}
                title="保持此电脑唤醒"
                description="插电且开启连接时阻止电脑进入休眠（即将支持）"
                last
              >
                <Switch checked={keepAwake} onChange={setKeepAwake} disabled />
              </SettingRow>
            </div>
          </div>

          <div className="space-y-3">
            <h2 className={`text-sm font-medium ${TEXT.muted} px-1`}>连接移动设备</h2>
            <div className={`${SURFACE.panel} p-6`}>
              {!allowConnect ? (
                <p className={`text-sm ${TEXT.muted} text-center py-6`}>开启上方「允许手机连接此电脑」后，这里会显示连接二维码。</p>
              ) : (
                <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
                  <div className="flex flex-col items-center gap-3 shrink-0">
                    <div className="flex h-[220px] w-[220px] items-center justify-center rounded-xl border border-subtle bg-white">
                      {qrDataUrl
                        ? <img src={qrDataUrl} alt="连接二维码" width={220} height={220} />
                        : <span className={`text-xs ${TEXT.muted}`}>{generating ? '生成中…' : '连接码不可用'}</span>}
                    </div>
                    {setupCode && (
                      <button type="button" onClick={copySetupCode} className={`text-xs ${TEXT.muted} hover:text-primary transition-colors`}>
                        复制连接码
                      </button>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 space-y-5">
                    <Step n={1} title="下载并打开 Uniopc 手机 App">
                      在 iPhone / Android 上安装 Uniopc App 并打开。
                    </Step>
                    <Step n={2} title="扫描二维码直接连接">
                      在 App 里扫描左侧二维码即可直连本机引擎，<span className="text-primary font-medium">无需登录账号</span>。
                    </Step>
                    <Step n={3} title="在此电脑确认配对">
                      首次连接会在下方出现配对请求，点「批准」即可。之后自动重连。
                    </Step>

                    <div className={`${SURFACE.inset} p-3`}>
                      {pendingRequest ? (
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-primary">待批准的配对请求</div>
                            <div className={`truncate text-xs ${TEXT.muted}`}>
                              {pendingRequest.deviceName || pendingRequest.device_name || pendingRequest.appDeviceName || '未知设备'}
                            </div>
                          </div>
                          <button type="button" onClick={approvePairing} disabled={approving}
                            className="shrink-0 inline-flex h-8 items-center rounded-lg bg-brand px-3 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50">
                            {approving ? '批准中…' : '批准'}
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-3">
                          <span className={`text-sm ${TEXT.muted}`}>
                            {pairedDevices.length > 0 ? `已连接 ${pairedDevices.length} 台设备` : '等待手机扫码…'}
                          </span>
                          {pairedDevices.length === 0 && (
                            <button type="button" onClick={approvePairing} disabled={approving}
                              className={`shrink-0 text-xs ${TEXT.muted} hover:text-primary disabled:opacity-50`}>
                              {approving ? '批准中…' : '手动批准最新'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {message && <div className={`${SURFACE.panelSoft} p-3 text-sm text-accent-text`}>{message}</div>}
      {error && <div className={`${SURFACE.panelSoft} p-3 text-sm text-danger-text`}>{error}</div>}
    </div>
  )
}
