import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useAuth } from '../hooks/useAuth'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { profileWorkspaceNavigationState, useProfileWorkspace } from '../hooks/useProfileWorkspace'
import { profileWorkspacePath } from '../lib/profileWorkspace'
import { sanitizeBrand } from '../lib/brandSanitizer'
import { engineClient } from '../lib/engine/client.js'
import { ACTION, FORM, HEADING, LAYOUT, SURFACE, TEXT } from '../lib/theme'
import {
  ensureOpenClawStatus,
  getGatewayConnectionSnapshot,
  isGatewayConnectionReady,
  refreshGatewayConnectionSnapshot,
  refreshOpenClawStatus,
  setOpenClawRuntimeStatus,
  useRuntimeStatusStore,
} from '../lib/runtimeStatus'
import {
  availableModelChoicesFromSnapshot,
  formatOpenClawModelLabel,
  providerReadyFromAuthProfiles,
} from '../lib/openclawModels'
import {
  UNIOPC_OFFICIAL_PROVIDER,
  connectUniopcOfficialModel,
  fetchLlmCreditBalance,
  maybeBootstrapUniopcOfficialModel,
} from '../lib/uniopcOfficialModel'

function statusTone(ok) {
  return ok
    ? 'border border-emerald-400/18 bg-emerald-400/10 text-success-text'
    : 'border border-amber-400/18 bg-amber-400/10 text-warning-text'
}


function ProviderStatus({ status, connectionSnapshot, providerSourceCount = 0, modelCount = 0 }) {
  const installed = Boolean(status?.installed)
  const runtimeCompatReady = status?.runtimeCompatReady ?? true
  const gatewayRunning = isGatewayConnectionReady(connectionSnapshot)
  const providerReady = providerSourceCount > 0
  const providerLabel = `${providerSourceCount} 个来源`
  const providerDetail = runtimeCompatReady === false ? '版本需更新' : `${modelCount} 个模型可用`

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className={`${SURFACE.panelSoft} p-4`}>
        <div className="text-sm font-semibold text-primary">Uniopc 引擎</div>
        <span className={`mt-3 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(installed)}`}>
          {installed ? '已安装' : '未安装'}
        </span>
      </div>
      <div className={`${SURFACE.panelSoft} p-4`}>
        <div className="text-sm font-semibold text-primary">Provider</div>
        <span className={`mt-3 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(runtimeCompatReady !== false && providerReady)}`}>
          {providerLabel}
        </span>
        <div className={`mt-3 truncate text-xs ${TEXT.secondary}`}>
          {providerDetail}
        </div>
      </div>
      <div className={`${SURFACE.panelSoft} p-4`}>
        <div className="text-sm font-semibold text-primary">Gateway</div>
        <span className={`mt-3 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(gatewayRunning)}`}>
          {gatewayRunning ? '运行中' : '未启动'}
        </span>
      </div>
    </div>
  )
}

function providerFromModelRef(modelRef) {
  const raw = String(modelRef || '')
  const index = raw.indexOf('/')
  return index > 0 ? raw.slice(0, index) : ''
}

function statusFromActiveModelSnapshot(snapshot, fallbackStatus) {
  const fallback = fallbackStatus || {}
  const resolvedDefaultModel = snapshot?.resolvedDefaultModel || fallback.resolvedDefaultModel
  const defaultModel = snapshot?.primaryModel || fallback.defaultModel
  const currentProviderId = providerFromModelRef(resolvedDefaultModel || defaultModel)
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
  const currentProvider = providers.find(provider => provider?.id === currentProviderId)
  const readyProvider = currentProvider || providers.find(provider => provider?.ready)
  const fallbackProviderMode = fallback.providerMode
  const runtimeCompatReady = snapshot?.runtimeCompatReady ?? fallback.runtimeCompatReady ?? true
  const runtimeCompatMessage = snapshot?.runtimeCompatMessage || fallback.runtimeCompatMessage || null
  const authLabelsStatus = {
    authProfileLabels: snapshot?.authProfileLabels || fallback.authProfileLabels || [],
  }
  const authProviderReady = currentProviderId
    ? runtimeCompatReady !== false && providerReadyFromAuthProfiles(authLabelsStatus, currentProviderId)
    : false
  const providerReady = currentProvider
    ? Boolean(runtimeCompatReady !== false && (currentProvider.ready || authProviderReady))
    : Boolean(runtimeCompatReady !== false && (readyProvider?.ready || authProviderReady || fallback.providerReady))

  return {
    ...fallback,
    defaultModel,
    resolvedDefaultModel,
    providerMode: currentProvider?.id || readyProvider?.id || fallbackProviderMode,
    providerStatus: currentProvider?.status || readyProvider?.status || fallback.providerStatus,
    providerReady,
    authProfileLabels: authLabelsStatus.authProfileLabels,
    runtimeCompatReady,
    runtimeCompatMessage,
  }
}

function AvailableModels({ items }) {
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className={HEADING.section}>可用对话模型</h2>
        <span className={`text-xs ${TEXT.secondary}`}>{items.length} 个模型可用</span>
      </div>
      {items.length === 0 ? (
        <div className={`mt-3 rounded-2xl border border-amber-400/18 bg-amber-400/8 px-4 py-3 text-sm ${TEXT.secondary}`}>
          还没有检测到官方模型。请连接 Uniopc 官方模型；已有对话仍会继续沿用会话自己的模型设置。
        </div>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map(item => (
            <div key={item.id} className="rounded-2xl border border-subtle bg-surface-sunken p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-primary">{item.modelLabel}</div>
                  <div className={`mt-1 truncate text-xs ${TEXT.secondary}`}>
                    {item.providerLabel}
                  </div>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(true)}`}>
                  {item.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function capabilityFormFromSnapshot(snapshot) {
  return {
    imageModel: snapshot?.imageGenerationModel || '',
    videoModel: snapshot?.videoGenerationModel || '',
    ttsModel: snapshot?.ttsModel || '',
    ttsVoice: snapshot?.ttsVoice || '',
    sttModel: snapshot?.sttModel || '',
  }
}

function capabilityOverviewItems(currentModel, capabilityForm) {
  return [
    {
      id: 'chat',
      title: '对话模型',
      description: currentModel
        ? `当前默认：${formatOpenClawModelLabel(currentModel)}`
        : '还没有设置当前 Profile 的默认对话模型。',
      configKey: 'agents.defaults.model.primary',
      toolSurface: 'chat.send',
      ready: Boolean(currentModel),
      status: currentModel ? '已接入' : '待设置',
      fields: [],
    },
    {
      id: 'image',
      title: '图片生成',
      description: '由 Uniopc 引擎 读取图片模型配置，和员工、对话共享当前 Profile 授权。',
      configKey: 'agents.defaults.imageGenerationModel',
      toolSurface: 'image_generate',
      ready: Boolean(capabilityForm.imageModel),
      status: capabilityForm.imageModel ? '已设置' : '未设置',
      fields: [
        { key: 'imageModel', label: '图片模型', placeholder: 'provider/model' },
      ],
    },
    {
      id: 'video',
      title: '视频生成',
      description: '视频模型不需要新建独立顶层模块，按能力绑定到当前 Profile。',
      configKey: 'agents.defaults.videoGenerationModel',
      toolSurface: 'video_generate',
      ready: Boolean(capabilityForm.videoModel),
      status: capabilityForm.videoModel ? '已设置' : '未设置',
      fields: [
        { key: 'videoModel', label: '视频模型', placeholder: 'provider/model' },
      ],
    },
    {
      id: 'tts',
      title: '语音合成',
      description: 'TTS 走 Gateway 的消息语音配置，在这里设置默认模型和音色。',
      configKey: 'messages.tts',
      toolSurface: 'tts',
      ready: Boolean(capabilityForm.ttsModel || capabilityForm.ttsVoice),
      status: (capabilityForm.ttsModel || capabilityForm.ttsVoice) ? '已设置' : '未设置',
      fields: [
        { key: 'ttsModel', label: 'TTS 模型', placeholder: 'provider/model' },
        { key: 'ttsVoice', label: 'TTS 音色', placeholder: 'voice' },
      ],
    },
    {
      id: 'stt',
      title: '语音识别',
      description: 'STT 走 Gateway 媒体音频工具能力，和对话、员工调用共享当前 Profile 授权。',
      configKey: 'tools.media.audio',
      toolSurface: 'audio transcription',
      ready: Boolean(capabilityForm.sttModel),
      status: capabilityForm.sttModel ? '已设置' : '未设置',
      fields: [
        { key: 'sttModel', label: 'STT 模型', placeholder: 'provider/model' },
      ],
    },
  ]
}

function CapabilityOverview({
  currentModel,
  capabilityForm,
  capabilityDialogId,
  onCapabilityOpen,
  disabled,
}) {
  const items = capabilityOverviewItems(currentModel, capabilityForm)

  return (
    <div className="mt-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className={HEADING.section}>AI 能力</h2>
          <p className={`mt-1 text-sm ${TEXT.secondary}`}>
            能力配置和 Provider 授权都由 Uniopc 引擎 管理；这里按当前 Profile 补齐对话、图片、视频、语音入口。
          </p>
        </div>
        <span className={`text-xs ${TEXT.secondary}`}>不新增顶层 Tab</span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map(item => (
          <div
            key={item.id}
            className={`rounded-2xl border p-4 transition-colors ${capabilityDialogId === item.id ? 'border-sky-400/45 bg-sky-400/10' : 'border-default bg-surface-overlay'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-primary">{item.title}</div>
                <div className={`mt-2 text-xs leading-5 ${TEXT.secondary}`}>{item.description}</div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(item.ready)}`}>
                  {item.status}
                </span>
                <button
                  type="button"
                  className="inline-flex min-h-8 items-center justify-center rounded-full border border-default bg-surface-overlay px-3 py-1 text-xs font-medium text-secondary transition-colors hover:bg-state-hover hover:text-primary disabled:pointer-events-none disabled:opacity-60"
                  onClick={() => onCapabilityOpen(item.id)}
                  disabled={disabled && item.id !== 'chat'}
                >
                  配置{item.title}
                </button>
              </div>
            </div>
            <div className="mt-4 space-y-2 text-xs">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className={TEXT.secondary}>配置</span>
                <span className="max-w-[72%] truncate rounded-md bg-surface-sunken px-2 py-0.5 font-mono text-primary">{item.configKey}</span>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className={TEXT.secondary}>工具</span>
                <span className="max-w-[72%] truncate rounded-md bg-surface-sunken px-2 py-0.5 font-mono text-primary">{item.toolSurface}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CapabilityConfigDialog({
  capabilityDialog,
  capabilityForm,
  onCapabilityChange,
  onSaveCapabilities,
  onClose,
  disabled,
}) {
  if (!capabilityDialog) return null
  const inputClass = `${SURFACE.input} mt-2`
  const isChat = capabilityDialog.id === 'chat'

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-scrim-strong px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`${SURFACE.modal} max-h-[calc(100vh-48px)] w-full max-w-[560px] overflow-y-auto p-5`}
        role="dialog"
        aria-modal="true"
        aria-label={`配置${capabilityDialog.title}`}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-default pb-4">
          <div className="min-w-0">
            <h2 className={HEADING.section}>配置{capabilityDialog.title}</h2>
            <p className={`mt-2 text-sm leading-6 ${TEXT.secondary}`}>
              这里保存的是 Uniopc 引擎 的默认能力模型引用。
            </p>
          </div>
          <button
            type="button"
            className={`${ACTION.icon} shrink-0 whitespace-nowrap rounded-full text-base`}
            onClick={onClose}
            aria-label="关闭配置"
            title="关闭配置"
          >
            ×
          </button>
        </div>

        <div className={`${SURFACE.panelSoft} mt-4 px-3 py-2 text-xs`}>
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className={TEXT.secondary}>配置</span>
            <span className="max-w-[72%] truncate rounded-md bg-surface-sunken px-2 py-0.5 font-mono text-primary">{capabilityDialog.configKey}</span>
          </div>
          <div className="mt-2 flex min-w-0 items-center justify-between gap-3">
            <span className={TEXT.secondary}>工具</span>
            <span className="max-w-[72%] truncate rounded-md bg-surface-sunken px-2 py-0.5 font-mono text-primary">{capabilityDialog.toolSurface}</span>
          </div>
        </div>

        {isChat ? (
          <div className={`mt-4 rounded-xl border border-amber-400/18 bg-amber-400/10 px-3 py-3 text-sm ${TEXT.secondary}`}>
            对话默认模型统一由 Uniopc 官方模型提供。
          </div>
        ) : (
          <form className="mt-4" onSubmit={onSaveCapabilities}>
            <div className="grid gap-3 sm:grid-cols-2">
              {capabilityDialog?.fields?.map(field => (
                <label key={field.key} className="min-w-0">
                  <span className={FORM.label}>{field.label}</span>
                  <input
                    className={inputClass}
                    value={capabilityForm[field.key]}
                    onChange={event => onCapabilityChange(field.key, event.target.value)}
                    placeholder={field.placeholder}
                    disabled={disabled}
                  />
                </label>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button type="submit" className={ACTION.primary} disabled={disabled}>
                保存{capabilityDialog?.title || '能力'}配置
              </button>
              <span className={`text-xs ${TEXT.secondary}`}>留空会清空当前能力的默认配置。</span>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export default function ModelSettings({ embedded = false, profileWorkspaceOverride = null }) {
  const { user } = useAuth()
  const activeOpenClaw = useActiveOpenClawProfile()
  const routedProfileWorkspace = useProfileWorkspace()
  const profileWorkspace = profileWorkspaceOverride || routedProfileWorkspace
  const profileWorkspaceState = profileWorkspaceNavigationState(profileWorkspace)
  const profileRoutePath = childPath => profileWorkspace
    ? profileWorkspacePath(profileWorkspace, childPath)
    : profileWorkspacePath({ isCurrentMember: true }, childPath)
  const runtime = useRuntimeStatusStore()
  const [capabilityForm, setCapabilityForm] = useState(() => capabilityFormFromSnapshot(null))
  const [capabilityDialogId, setCapabilityDialogId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const [modelSnapshot, setModelSnapshot] = useState(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const openClawStatus = runtime.openClaw.status
  const activeProfile = profileWorkspace ? profileWorkspace.activeProfile : activeOpenClaw.activeProfile || ''
  const workspaceProfile = profileWorkspace || activeOpenClaw.workspaceProfile
  const gatewayPort = profileWorkspace ? profileWorkspace.gatewayPort : workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null
  const connectionSnapshot = getGatewayConnectionSnapshot(activeProfile, gatewayPort)
  const gatewayConnected = isGatewayConnectionReady(connectionSnapshot)
  const openClawBusy = busy || runtime.openClaw.loading
  const activeModelStatus = statusFromActiveModelSnapshot(modelSnapshot, openClawStatus)
  const runtimeCompatReady = activeModelStatus?.runtimeCompatReady ?? true
  const runtimeCompatMessage = activeModelStatus?.runtimeCompatMessage
  const profileDefaultModel = activeModelStatus?.resolvedDefaultModel || activeModelStatus?.defaultModel || ''
  const availableModels = availableModelChoicesFromSnapshot(modelSnapshot, profileDefaultModel)
    .filter(model => model.provider === UNIOPC_OFFICIAL_PROVIDER)
  const providerSourceCount = new Set(availableModels.map(model => model.provider).filter(Boolean)).size
  const capabilityDialog = capabilityDialogId
    ? capabilityOverviewItems(profileDefaultModel, capabilityForm).find(item => item.id === capabilityDialogId)
    : null
  const noticeFailed = Boolean(error || progress?.phase === 'failed')

  const [officialBalance, setOfficialBalance] = useState(null)
  const [officialBootstrapDone, setOfficialBootstrapDone] = useState(false)

  useEffect(() => {
    if (!user?.uid) return
    fetchLlmCreditBalance()
      .then(balance => {
        if (typeof balance === 'number') setOfficialBalance(balance)
      })
      .catch(() => null)
  }, [user?.uid])

  // New users with no configured model are auto-connected to the official model.
  // Users who already set up their own provider are left untouched. The shared
  // guard in uniopcOfficialModel.js also covers the login-time bootstrap, so
  // the two entry points can never double-mint.
  useEffect(() => {
    if (!activeProfile || !modelSnapshot || busy || officialBootstrapDone) return
    setOfficialBootstrapDone(true)
    maybeBootstrapUniopcOfficialModel({ snapshot: modelSnapshot, profile: activeProfile })
      .then(async ({ connected, balance }) => {
        if (!connected) return
        setOfficialBalance(balance)
        setMessage('已为你连接 Uniopc 官方模型（含体验额度）。')
        await refreshModelSnapshot()
        await refreshOpenClawStatus({ silent: true }).catch(() => null)
      })
      .catch(() => null)
  }, [modelSnapshot, activeProfile, busy, officialBootstrapDone])

  useEffect(() => {
    setCapabilityForm(capabilityFormFromSnapshot(modelSnapshot))
  }, [
    modelSnapshot?.imageGenerationModel,
    modelSnapshot?.videoGenerationModel,
    modelSnapshot?.ttsModel,
    modelSnapshot?.ttsVoice,
    modelSnapshot?.sttModel,
  ])

  useEffect(() => {
    load()
    // listen() resolves async: if the effect cleans up before it resolves, the
    // late-arriving unlisten must still run, or the handler leaks forever.
    let cancelled = false
    const listenPromise = listen('openclaw-setup-progress', event => {
      if (cancelled) return
      setProgress(event.payload)
      if (event.payload?.phase === 'success' || event.payload?.phase === 'failed') {
        refreshOpenClawStatus({ silent: true }).catch(() => null)
      }
    })

    return () => {
      cancelled = true
      listenPromise.then(unlisten => unlisten()).catch(() => null)
    }
  }, [activeProfile, user?.uid])

  async function load() {
    if (!user?.uid) return
    setLoading(true)
    setError(null)
    try {
      await ensureOpenClawStatus()
      if (activeProfile) {
        await refreshGatewayConnectionSnapshot({ profile: activeProfile, gatewayPort, silent: true }).catch(() => null)
      }
      await refreshModelSnapshot()
    } catch (e) {
      setError(typeof e === 'string' ? e : '加载 Uniopc 引擎 模型状态失败')
    } finally {
      setLoading(false)
    }
  }

  async function refreshOpenClaw() {
    setError(null)
    try {
      const refreshes = [refreshOpenClawStatus()]
      if (activeProfile) refreshes.push(refreshGatewayConnectionSnapshot({ profile: activeProfile, gatewayPort }))
      await Promise.all(refreshes)
      await refreshModelSnapshot()
    } catch (e) {
      setError(typeof e === 'string' ? e : '刷新 Uniopc 引擎 状态失败')
    }
  }

  async function refreshModelSnapshot() {
    if (!activeProfile) {
      setModelSnapshot(null)
      return null
    }
    try {
      const snapshot = await engineClient.models.snapshot({ profile: activeProfile })
      setModelSnapshot(snapshot)
      return snapshot
    } catch {
      setModelSnapshot(null)
      return null
    }
  }

  async function runOpenClawAction(action, fallback) {
    setBusy(true)
    setError(null)
    setMessage(null)
    setProgress(null)
    try {
      const result = await action()
      const nextStatus = result?.status ? setOpenClawRuntimeStatus(result.status) : null
      setMessage(result?.message || nextStatus?.updateMessage || fallback)
      return result
    } catch (e) {
      setError(typeof e === 'string' ? e : fallback)
      await refreshOpenClawStatus().catch(() => null)
      return null
    } finally {
      setBusy(false)
    }
  }

  function requireActiveProfile(message = '组织管理员尚未为你创建 Uniopc 引擎 profile。') {
    if (activeProfile) return activeProfile
    setError(message)
    return ''
  }

  async function connectOfficial() {
    const profile = requireActiveProfile('请先完成本机 Uniopc 引擎 Host 初始化，再连接官方模型。')
    if (!profile) return
    await runOpenClawAction(async () => {
      const { balance } = await connectUniopcOfficialModel({ profile })
      setOfficialBalance(balance)
      return { message: `已连接 Uniopc 官方模型 · 剩余 ${balance} credits` }
    }, '已连接 Uniopc 官方模型')
    await refreshModelSnapshot()
    await refreshOpenClawStatus({ silent: true }).catch(() => null)
  }

  function updateCapabilityField(field, value) {
    setCapabilityForm(prev => ({ ...prev, [field]: value }))
    setError(null)
    setMessage(null)
  }

  function openCapabilityDialog(id) {
    setCapabilityDialogId(id)
    setError(null)
    setMessage(null)
  }

  function closeCapabilityDialog() {
    setCapabilityDialogId(null)
  }

  async function saveMediaCapabilities(event) {
    event.preventDefault()
    const profile = requireActiveProfile('请先完成本机 Uniopc 引擎 Host 初始化，再保存能力配置。')
    if (!profile) return
    const result = await runOpenClawAction(
      async () => {
        const snapshot = await invoke('openclaw_media_capabilities_save', {
          req: {
            profile,
            imageModel: capabilityForm.imageModel,
            videoModel: capabilityForm.videoModel,
            ttsModel: capabilityForm.ttsModel,
            ttsVoice: capabilityForm.ttsVoice,
            sttModel: capabilityForm.sttModel,
          },
        })
        setModelSnapshot(snapshot)
        return snapshot
      },
      '能力配置已保存',
    )
    if (result) setCapabilityDialogId(null)
  }

  async function startGateway() {
    if (!requireActiveProfile('请先完成本机 Uniopc 引擎 Host 初始化，再启动 Gateway Connection。')) return
    await runOpenClawAction(
      () => invoke('openclaw_connection_start_local', { input: { profile: activeProfile, gatewayPort } }),
      'Gateway Connection 已启动',
    )
    await refreshGatewayConnectionSnapshot({ profile: activeProfile, gatewayPort, silent: true }).catch(() => null)
  }

  async function stopGateway() {
    if (!requireActiveProfile('请先完成本机 Uniopc 引擎 Host 初始化，再关闭 Gateway Connection。')) return
    await runOpenClawAction(
      () => invoke('openclaw_connection_stop_local', { input: { profile: activeProfile } }),
      'Gateway Connection 已关闭',
    )
    await refreshGatewayConnectionSnapshot({ profile: activeProfile, gatewayPort, silent: true }).catch(() => null)
  }

  return (
    <div className={embedded ? 'space-y-5' : LAYOUT.wide}>
      <section className={`${SURFACE.panel} p-5`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className={HEADING.page}>Profile 模型与能力</h1>
            <p className={`mt-2 max-w-3xl text-sm ${TEXT.secondary}`}>
              当前 Uniopc 引擎 Profile：{activeProfile || '未选择'}。每个 profile 的官方模型与媒体能力配置独立保存，不与组织或其他 profile 共享。
            </p>
          </div>
          <button type="button" className={ACTION.secondary} onClick={refreshOpenClaw} disabled={openClawBusy}>
            刷新状态
          </button>
        </div>

        <div className="mt-5">
          <ProviderStatus
            status={activeModelStatus}
            connectionSnapshot={connectionSnapshot}
            providerSourceCount={providerSourceCount}
            modelCount={availableModels.length}
          />
        </div>

        <CapabilityOverview
          currentModel={profileDefaultModel}
          capabilityForm={capabilityForm}
          capabilityDialogId={capabilityDialogId}
          onCapabilityOpen={openCapabilityDialog}
          disabled={openClawBusy || !openClawStatus?.installed}
        />

        <CapabilityConfigDialog
          capabilityDialog={capabilityDialog}
          capabilityForm={capabilityForm}
          onCapabilityChange={updateCapabilityField}
          onSaveCapabilities={saveMediaCapabilities}
          onClose={closeCapabilityDialog}
          disabled={openClawBusy || !openClawStatus?.installed}
        />

        <AvailableModels items={availableModels} />

        {runtimeCompatReady === false && (
          <div className={`mt-5 flex flex-col gap-3 rounded-2xl border border-amber-400/18 bg-amber-400/8 px-4 py-3 text-sm ${TEXT.secondary} md:flex-row md:items-center md:justify-between`}>
            <div>
              <div className="font-medium text-warning-text">Uniopc 引擎 与 Codex 插件版本不兼容</div>
              <div className="mt-1 text-xs leading-5 opacity-80">
                {sanitizeBrand(runtimeCompatMessage || '当前模型组件需要更新版本的 Uniopc 本地服务。请更新运行环境并重启本地服务。')}
              </div>
            </div>
            <Link to={profileRoutePath('openclaw-runtime')} state={profileWorkspaceState} className={ACTION.secondary}>
              去版本管理
            </Link>
          </div>
        )}

        {(message || error || progress) && (
          <div className={`mt-5 rounded-2xl border px-4 py-3 text-sm ${noticeFailed ? 'border-rose-400/20 bg-rose-400/10 text-danger-text' : 'border-emerald-400/18 bg-emerald-400/10 text-success-text'}`}>
            <div className="font-medium">{error || message || progress?.status}</div>
            {progress?.detail && <div className="mt-1 text-xs opacity-75">{progress.detail}</div>}
          </div>
        )}
      </section>

      <section className={`${SURFACE.panel} p-5`}>
        <h2 className={HEADING.section}>官方对话模型</h2>
        <p className={`mt-2 text-sm ${TEXT.secondary}`}>
          对话统一使用 Uniopc 官方模型和 credits，不支持第三方账号或密钥。
        </p>
        <button
          type="button"
          className={`${ACTION.primary} mt-4`}
          onClick={connectOfficial}
          disabled={openClawBusy || !openClawStatus?.installed}
        >
          连接官方模型
        </button>
      </section>

      <section className={`${SURFACE.panel} p-5`}>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 text-left"
          onClick={() => setAdvancedOpen(value => !value)}
        >
          <span>
            <span className={HEADING.section}>高级设置与诊断</span>
            <span className={`mt-1 block text-sm ${TEXT.secondary}`}>Gateway 模型目录和运行维护。Browser Runtime 请到运行中心管理。</span>
          </span>
          <span className={`text-sm ${TEXT.secondary}`}>{advancedOpen ? '收起' : '展开'}</span>
        </button>

        {advancedOpen && (
          <div className="mt-5 space-y-5">
            <div className={`${SURFACE.panelSoft} p-4`}>
              <h2 className={HEADING.section}>Uniopc 引擎 主链</h2>
              <p className={`mt-1 text-sm ${TEXT.secondary}`}>
                Uniopc 引擎 CLI 和兼容版本是这台 Mac 的全局运行时；profile 模型页只保留 Gateway 启停和连接诊断。
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" className={ACTION.secondary} onClick={startGateway} disabled={openClawBusy || !openClawStatus?.installed}>
                  启动 Gateway
                </button>
                <button type="button" className={ACTION.secondary} onClick={stopGateway} disabled={openClawBusy || !gatewayConnected}>
                  关闭 Gateway
                </button>
                <Link to={profileRoutePath('openclaw-runtime')} state={profileWorkspaceState} className={ACTION.secondary}>
                  Uniopc 引擎 版本管理
                </Link>
              </div>
            </div>

            {modelSnapshot && (
              <div className={`${SURFACE.panelSoft} p-4`}>
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <h2 className={HEADING.section}>Gateway 模型目录</h2>
                    <p className={`mt-1 text-sm ${TEXT.secondary}`}>
                      来自 Uniopc 引擎，员工模型选择会优先使用这份目录。
                    </p>
                  </div>
                  <div className={`text-sm ${TEXT.secondary}`}>
                    当前默认：{formatOpenClawModelLabel(modelSnapshot.resolvedDefaultModel || modelSnapshot.primaryModel)}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {(modelSnapshot.providers || []).filter(provider => provider.id === UNIOPC_OFFICIAL_PROVIDER).map(provider => (
                    <div key={provider.id} className="rounded-2xl border border-subtle bg-surface-sunken p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-primary">{provider.label || provider.id}</div>
                          <div className={`mt-1 truncate text-xs ${TEXT.secondary}`}>{provider.authKind || 'auth'} · {provider.recommendedModel || '未推荐模型'}</div>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(provider.ready)}`}>
                          {provider.ready ? '已就绪' : '未就绪'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 grid gap-2 text-sm md:grid-cols-2">
                  {(modelSnapshot.models || []).slice(0, 12).map(model => (
                    <div key={model.modelRef} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-subtle bg-surface-raised px-3 py-2">
                      <span className="truncate text-primary">{formatOpenClawModelLabel(model.modelRef)}</span>
                      <span className={`shrink-0 text-xs ${model.providerReady ? 'text-success-text' : TEXT.secondary}`}>
                        {model.providerReady ? 'ready' : model.providerStatus || 'not ready'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}
      </section>
    </div>
  )
}
