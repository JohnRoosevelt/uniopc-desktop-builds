import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Modal from '../components/Modal'
import { AsyncActionState } from '../components/AsyncActionState'
import { MessageBar } from '../components/AppsUI'
import { ACTION, SURFACE, TEXT } from '../lib/theme'
import { engineClient } from '../lib/engine/client.js'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { useProfileWorkspace } from '../hooks/useProfileWorkspace'
import {
  buildCustomPluginPresets,
  buildKnownPluginIds,
  buildPluginGrantStatuses,
  mergeBuiltInPluginPresets,
  isPluginActionBusy,
  pluginTabCountLabel,
  pluginEntitlementStatus,
  pluginForceUpdateRequired,
  pluginGatewayStatus,
  pluginUpdateStatus,
  resolveCloudPluginLifecycleIds,
  apiKeyCredentialState,
  connectorNeedsCredentialInput,
  resolvePluginReadiness,
  stripEngineStartupNoise,
} from '../lib/appCenterPlugins'
import { APP_MODES, isHostAppMode } from '../lib/appModes'
import {
  authorizeCloudPluginInstall,
  buildCachedProfilePluginSnapshot,
  downloadCloudPluginArtifactBase64,
  listMyOrganizationPluginEntitlements,
  normalizeCloudPluginCatalogRows,
  reportCloudProfilePluginObservation,
} from '../lib/cloudWorkspace'
import {
  beginCloudAgentCatalogRequest,
  cloudAgentRuntimePluginId,
  commitCloudAgentCatalogRequest,
  currentCloudAgentRuntimeAuthEnv,
  invalidateCloudAgentCatalogRequests,
  isCloudAgentHostCredentialResetRequiredError,
  isCloudAgentPluginId,
  replaceCloudAgentPluginCatalog,
} from '../lib/cloudWorkspacePluginAuth'
import { attributeInstallFailure } from '../lib/pluginInstallAttribution'
import {
  disconnectPluginConnector,
  pluginConnectorOauthStatus,
  startPluginConnectorOauth,
  waitForPluginConnectorOauth,
} from '../lib/pluginOauthConnectors'
import { checkProfilePluginConsistency } from '../lib/profilePluginConsistency'
import { profileWorkspacePath } from '../lib/profileWorkspace'
import {
  normalizeTrustedServiceError,
  trustedCatalogRowsForCurrentResponse,
  fetchTrustedPluginCatalog,
  directFetch,
  supabase,
} from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import {
  getGatewayConnectionSnapshot,
  getGatewayConnectionReadiness,
  isGatewayConnectionReady,
  isGatewayConnectionLoading,
  refreshGatewayConnectionSnapshot,
  useRuntimeStatusStore,
} from '../lib/runtimeStatus'
import {
  MCP_TRANSPORTS,
  buildMcpConfigFromForm,
  configToForm,
  emptyMcpForm,
  keyValueTextToRows,
} from '../lib/mcpConfig'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'stdio', label: 'Stdio' },
  { id: 'sse', label: 'SSE / HTTP' },
  { id: 'streamable-http', label: 'Streamable HTTP' },
]

const PLUGIN_TABS = [
  { id: 'official', label: '官方' },
  { id: 'third-party', label: '第三方' },
  { id: 'custom', label: '自定义' },
  { id: 'installed', label: '已安装' },
]

const PLUGIN_TAB_IDS = new Set(PLUGIN_TABS.map(tab => tab.id))

// Scene taxonomy (main user-facing category). Order is the display order;
// `other` is always last. See uniopc-supabase/docs/plugin-taxonomy.md.
const SCENE_CATEGORIES = [
  { slug: 'content-creation', label: '内容创作' },
  { slug: 'marketing-growth', label: '营销获客' },
  { slug: 'ecommerce', label: '电商经营' },
  { slug: 'workspace', label: '办公协作' },
  { slug: 'data-insights', label: '数据洞察' },
  { slug: 'product-development', label: '产品开发' },
  { slug: 'integrations', label: '连接集成' },
  { slug: 'vertical', label: '行业方案' },
  { slug: 'other', label: '其他' },
]
const SCENE_SLUGS = new Set(SCENE_CATEGORIES.filter(c => c.slug !== 'other').map(c => c.slug))

// Resolve a preset's scene category, folding unknown/empty slugs into 'other'.
function presetSceneCategory(preset) {
  const slug = String(preset?.sceneCategory || '').trim()
  return SCENE_SLUGS.has(slug) ? slug : 'other'
}

// Two-phase install model (see uniopc-supabase/docs/plugin-taxonomy.md):
// phase 1 provisions resources for every plugin; phase 2 is credential
// acquisition, present only for plugins that declare it (auto for official
// cloud plugins, api-key form for connector plugins). Blocking by default.
const INSTALL_PHASES = [
  { id: 'init', label: '初始化资源' },
  { id: 'auth', label: '账号授权' },
]

const HUB_MODE_TABS = [
  { id: 'plugins', label: '插件', childPath: 'plugins' },
  { id: 'mcp', label: 'MCP', childPath: 'mcphub' },
]

const HUB_TABS = [
  ...PLUGIN_TABS,
  { id: 'mine', label: 'MCP' },
]

const PLUGIN_ACTION_TIMEOUT_MS = 45000
const OPENCLAW_PLUGIN_WRITE_TIMEOUT_MS = 210000

function cloudPluginObservedStatus(plugin = {}) {
  const status = String(plugin.status || '').trim()
  if (!plugin.installed || status === 'not_installed') return 'missing'
  if (!plugin.enabled || status === 'disabled') return 'disabled'
  if (status === 'ready') return 'installed'
  return 'failed'
}

function cloudPluginObservationError(plugin = {}, observedStatus = '') {
  if (observedStatus !== 'failed') return ''
  const reasons = []
  const status = String(plugin.status || '').trim()
  if (status) reasons.push(`status:${status}`)
  if (plugin.toolBridgeEnabled === false) reasons.push('bridge_disabled')
  for (const key of Array.isArray(plugin.missingEnv) ? plugin.missingEnv : []) {
    reasons.push(`missing_env:${key}`)
  }
  return reasons.join(', ')
}

function withPluginActionTimeout(promise, label = '插件操作', timeoutMs = PLUGIN_ACTION_TIMEOUT_MS) {
  let timeoutId = null
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label}超时，请刷新状态后重试。`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId)
  })
}

function transportLabel(transport) {
  return MCP_TRANSPORTS.find(item => item.id === transport)?.label || transport || '未知'
}

function mcpGatewayErrorMessage(error, connectionSnapshot) {
  const raw = String(error?.message || error || '读取应用中心失败')
  const readiness = getGatewayConnectionReadiness(connectionSnapshot)
  if (!readiness.ready) return raw
  if (raw.includes('超时') || raw.toLowerCase().includes('timeout')) {
    return `Gateway Connection 已连接，但读取 MCP 配置超时：${raw}`
  }
  return raw
}

// api-key connector form rendered inside the install stepper's 账号授权
// phase. Submitting writes the values into the plugin env and enables the
// plugin (blocking install completes only after this succeeds).
function ConnectorAuthForm({ connector, busy, values = {}, onValuesChange, onSubmit, onSkip }) {
  const fields = Array.isArray(connector?.fields) ? connector.fields : []
  const isWechatOfficialAccount = connector?.id === 'wechat-mp'
  const [egressIp, setEgressIp] = useState('')
  const [egressIpState, setEgressIpState] = useState(isWechatOfficialAccount ? 'loading' : 'idle')
  const [copiedEgressIp, setCopiedEgressIp] = useState(false)

  useEffect(() => {
    if (!isWechatOfficialAccount) return undefined
    let cancelled = false
    setEgressIpState('loading')
    directFetch('https://api.ipify.org?format=json', { headers: { accept: 'application/json' } })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(payload => {
        const ip = String(payload?.ip || '').trim()
        if (!cancelled) {
          setEgressIp(ip)
          setEgressIpState(ip ? 'ready' : 'unavailable')
        }
      })
      .catch(() => {
        if (!cancelled) setEgressIpState('unavailable')
      })
    return () => { cancelled = true }
  }, [isWechatOfficialAccount])

  async function copyEgressIp() {
    if (!egressIp || !navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(egressIp)
      setCopiedEgressIp(true)
      window.setTimeout(() => setCopiedEgressIp(false), 1600)
    } catch {
      setCopiedEgressIp(false)
    }
  }

  const hasMissingFields = Array.isArray(connector?.missingFields)
  const missingFields = new Set(hasMissingFields
    ? connector.missingFields
    : fields.filter(field => field.required !== false).map(field => field.key))
  const missingRequired = fields.some(field => (
    field.required !== false
    && missingFields.has(field.key)
    && !String(values[field.key] || '').trim()
  ))
  return (
    <div className="rounded-lg border border-subtle bg-surface-overlay px-3 py-3">
      <div className="text-sm font-medium text-primary">连接 {connector.name || connector.id}</div>
      {connector.customDescription && (
        <div className="mt-1.5 text-xs leading-5 text-secondary [&_a]:text-violet-500 [&_a]:underline [&_code]:rounded [&_code]:bg-surface-raised [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{connector.customDescription}</ReactMarkdown>
        </div>
      )}
      {connector.getLinkUrl && (
        <a href={connector.getLinkUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-violet-500 hover:underline">
          {isWechatOfficialAccount ? '打开微信公众号后台 ↗' : '去获取凭据 ↗'}
        </a>
      )}
      {isWechatOfficialAccount && (
        <div className="mt-2 rounded-md border border-violet-400/20 bg-violet-500/5 px-2.5 py-2 text-xs leading-5 text-secondary">
          {egressIpState === 'ready' ? (
            <>
              <span>这台电脑当前出口 IP：<code className="rounded bg-surface-raised px-1 text-primary">{egressIp}</code>。请将它加入微信公众平台的 IP 白名单。</span>
              <button type="button" onClick={copyEgressIp} className="ml-2 font-medium text-violet-500 hover:underline">
                {copiedEgressIp ? '已复制' : '复制'}
              </button>
            </>
          ) : egressIpState === 'loading' ? '正在检测这台电脑的出口 IP…' : '暂时无法自动检测出口 IP。完成连接后，插件会在 40164 错误中显示微信实际看到的出口 IP。'}
        </div>
      )}
      <div className="mt-2.5 space-y-2">
        {fields.map(field => (
          <label key={field.key} className="block">
            <span className="mb-1 block text-xs font-medium text-secondary">
              {field.label || field.key}{field.required !== false && <span className="text-red-400"> *</span>}
            </span>
            <input
              type={field.type === 'password' ? 'password' : 'text'}
              value={values[field.key] || ''}
              onChange={event => onValuesChange({ ...values, [field.key]: event.target.value })}
              placeholder={missingFields.has(field.key) ? (field.placeholder || '') : '已保存，留空不修改'}
              className={SURFACE.input}
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSubmit(values)}
          disabled={busy || missingRequired}
          className={ACTION.primary}
        >
          {busy ? '连接中...' : '连接并完成安装'}
        </button>
        {onSkip && (
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            className={ACTION.secondary}
            title="先启用插件，凭据稍后在此补全"
          >
            暂时跳过
          </button>
        )}
      </div>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-secondary">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs leading-5 text-tertiary">{hint}</span>}
    </label>
  )
}

function KeyValueRowsEditor({ label, hint, value, onChange, defaultNames = [], valuePlaceholder = 'Value' }) {
  const [visibleRows, setVisibleRows] = useState({})
  const defaultNamesKey = defaultNames.join('\n')
  const [rows, setRows] = useState(() => keyValueTextToRows(value, defaultNames))

  useEffect(() => {
    setRows(keyValueTextToRows(value, defaultNames))
  }, [value, defaultNamesKey])

  function rowsToDraftText(nextRows) {
    return nextRows
      .map(row => ({
        name: String(row?.name || '').trim(),
        value: String(row?.value || '').trim(),
      }))
      .filter(row => row.name || row.value)
      .map(row => `${row.name}=${row.value}`)
      .join('\n')
  }

  function updateRow(index, patch) {
    const nextRows = rows.map((row, rowIndex) => (
      rowIndex === index ? { ...row, ...patch } : row
    ))
    setRows(nextRows)
    onChange(rowsToDraftText(nextRows))
  }

  function addRow() {
    const nextRows = [...rows, { name: '', value: '' }]
    setRows(nextRows)
    onChange(rowsToDraftText(nextRows))
  }

  function removeRow(index) {
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index)
    setRows(nextRows)
    onChange(rowsToDraftText(nextRows))
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-secondary">{label}</div>
        <button
          type="button"
          onClick={addRow}
          className="h-8 rounded-lg border border-default bg-surface-overlay px-2.5 text-xs font-medium text-secondary transition-colors hover:bg-state-hover hover:text-primary"
        >
          添加一项
        </button>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => {
          const visible = Boolean(visibleRows[index])
          return (
            <div key={`${index}-${row.name}`} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <input
                value={row.name}
                onChange={event => updateRow(index, { name: event.target.value })}
                className={SURFACE.input}
                placeholder="Name"
              />
              <div className="flex rounded-lg border border-default bg-surface-sunken focus-within:border-violet-400/40">
                <input
                  type={visible ? 'text' : 'password'}
                  value={row.value}
                  onChange={event => updateRow(index, { value: event.target.value })}
                  className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-primary outline-none placeholder:text-tertiary"
                  placeholder={valuePlaceholder}
                />
                <button
                  type="button"
                  onClick={() => setVisibleRows(prev => ({ ...prev, [index]: !prev[index] }))}
                  className="flex h-10 w-10 shrink-0 items-center justify-center text-tertiary transition-colors hover:text-primary"
                  aria-label={visible ? '隐藏 Value' : '显示 Value'}
                >
                  {visible ? (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.5 12c2.25 4.5 5.75 6.75 10.5 6.75 1.55 0 2.97-.24 4.26-.73M6.228 6.228A10.877 10.877 0 0112 5.25c4.75 0 8.25 2.25 10.5 6.75a11.66 11.66 0 01-2.25 3.123M6.228 6.228L3 3m3.228 3.228l11.544 11.544M17.772 17.772L21 21" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12S5.75 5.25 12 5.25 21.75 12 21.75 12 18.25 18.75 12 18.75 2.25 12 2.25 12z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  )}
                </button>
              </div>
              <button
                type="button"
                onClick={() => removeRow(index)}
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-default bg-surface-overlay text-tertiary transition-colors hover:bg-rose-500/10 hover:text-rose-500"
                aria-label="删除这一项"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12h12" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>
      {hint && (
        <div className="mt-1 text-xs leading-5 text-tertiary">
          {hint}
        </div>
      )}
    </div>
  )
}

function MarketplaceIcon({ kind = 'plugin', label = '' }) {
  const initials = String(label || '')
    .split(/\s+/)
    .map(part => part.trim()[0])
    .filter(Boolean)
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'AI'
  const tone = {
    imai: 'bg-violet-400/10 text-violet-600',
    mcp: 'bg-emerald-400/10 text-emerald-600',
    plugin: 'bg-surface-raised text-secondary',
  }[kind] || 'bg-surface-raised text-secondary'

  return (
    <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ${tone}`}>
      {initials}
    </div>
  )
}

// 卡片状态徽章：从 readiness 里挑出唯一一条真正值得一眼看到的状态。
// 优先级：未授权/异常这些"要处理的"排在"已就绪"前面 —— 卡片上先说问题。
const STATUS_BADGE_TONE = {
  danger: 'bg-danger-surface text-danger-text',
  warning: 'bg-warning-surface text-warning-text',
  success: 'bg-success-surface text-success-text',
  neutral: 'bg-surface-raised text-tertiary',
}

function pluginCardStatusBadge(readiness = {}, pricing = '') {
  const state = readiness.state || ''
  if (state === 'unpublished') {
    return { tone: 'warning', label: '未发布' }
  }
  if (['no_permission', 'unauthorized', 'revoked', 'suspended'].includes(state)) {
    return { tone: 'danger', label: readiness.entitlement?.label || '未授权' }
  }
  if (['running_unhealthy', 'runtime_unhealthy', 'failed', 'blocked'].includes(state)) {
    return { tone: 'danger', label: '运行异常' }
  }
  if (['not_installed', 'needs_configuration', 'not_configured', 'sync_required'].includes(state)) {
    return { tone: 'warning', label: '待启用' }
  }
  if (['configured_stopped', 'disabled', 'installed_disabled'].includes(state)) {
    return { tone: 'warning', label: '已停用' }
  }
  if (['unsupported', 'no_profile', 'checking', 'unchecked', 'unknown'].includes(state)) {
    return { tone: 'neutral', label: readiness.runtime?.label || '待检查' }
  }
  // ready / running_ready / active / installed_ready
  return { tone: 'success', label: pricing === 'paid' ? '已启用 · 付费' : '已启用' }
}

function MarketplaceCard({
  title,
  description,
  provider,
  actionLabel,
  onAction,
  disabled = false,
  actionBusy = false,
  iconKind = 'plugin',
  iconLabel = '',
  status = null,
  badge = '',
}) {
  const actionTitle = actionLabel || '操作'

  return (
    <div className="group flex min-h-[104px] items-center gap-4 rounded-xl border border-subtle bg-surface-overlay px-5 py-4 transition-colors hover:border-default hover:bg-surface-raised">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <MarketplaceIcon kind={iconKind} label={iconLabel || title} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-base font-semibold text-primary">{title}</div>
            {badge && (
              <span className="shrink-0 rounded-full bg-brand/12 px-2 py-0.5 text-2xs font-medium text-accent-text">{badge}</span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-tertiary">
            {description}
          </p>
          <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-tertiary">
            {status && (
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${STATUS_BADGE_TONE[status.tone] || STATUS_BADGE_TONE.neutral}`}>
                {status.label}
              </span>
            )}
            {provider && <span className="truncate">{provider}</span>}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onAction}
        disabled={disabled}
        title={actionBusy ? `启用中 ${title}` : actionTitle}
        aria-label={actionBusy ? `启用中 ${title}` : `${actionTitle} ${title}`}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-subtle bg-surface-raised text-2xl leading-none text-secondary shadow-sm transition-colors hover:border-default hover:bg-surface-overlay hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {actionBusy ? (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-default border-t-violet-500" />
        ) : '+'}
      </button>
    </div>
  )
}

function SystemPluginCard({
  preset,
  onDetails,
  saving = false,
}) {
  const hasManagementRoute = Boolean(preset.managementRoute)
  const actionLabel = preset.actionLabel || (
    preset.gatewayState === 'ready'
      ? '查看'
      : hasManagementRoute || preset.connectorAppId
        ? '管理'
        : '启用'
  )
  const status = saving
    ? { tone: 'neutral', label: '启用中…' }
    : preset.statusBadge
  return (
    <MarketplaceCard
      title={preset.title}
      provider={preset.provider}
      description={preset.description}
      actionLabel={actionLabel}
      onAction={() => onDetails?.(preset)}
      disabled={saving}
      actionBusy={saving}
      iconKind="imai"
      iconLabel={preset.title.replace(/^Uniopc\s*/, '')}
      status={status}
      badge={preset.updateAvailable ? '可更新' : ''}
    />
  )
}

function PluginCatalogGrid({ plugins, renderPlugin }) {
  return (
    <div>
      {plugins.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {plugins.map(renderPlugin)}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-subtle bg-surface-overlay px-4 py-8 text-center text-sm text-tertiary">
          暂无插件
        </div>
      )}
    </div>
  )
}

function DetailSection({ title, children }) {
  return (
    <div className="rounded-xl border border-subtle bg-surface-overlay px-4 py-3">
      <div className="text-sm font-semibold text-primary">{title}</div>
      <div className="mt-2 text-sm leading-6 text-tertiary">
        {children}
      </div>
    </div>
  )
}

function PillList({ items = [] }) {
  if (!items.length) return null
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(item => (
        <span key={item} className="rounded-full border border-subtle bg-surface-raised px-2.5 py-1 text-xs text-secondary">
          {item}
        </span>
      ))}
    </div>
  )
}

export default function McpHub({ appMode = APP_MODES.HOST, mode = 'plugins' }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const activeOpenClaw = useActiveOpenClawProfile()
  const profileWorkspace = useProfileWorkspace()
  const runtime = useRuntimeStatusStore()
  const hubMode = mode
  const activeProfile = profileWorkspace ? profileWorkspace.activeProfile : activeOpenClaw.activeProfile || ''
  const workspaceProfile = profileWorkspace || activeOpenClaw.workspaceProfile
  const activeOpenClawProfileId = workspaceProfile?.openclawProfileId || workspaceProfile?.openclaw_profile_id || null
  const catalogRequestScope = JSON.stringify([
    String(user?.uid || ''),
    String(activeOpenClawProfileId || ''),
    String(activeProfile || ''),
  ])
  const catalogRequestScopeRef = useRef(catalogRequestScope)
  catalogRequestScopeRef.current = catalogRequestScope
  const gatewayPort = profileWorkspace ? profileWorkspace.gatewayPort : workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null
  const canManageMcpServers = isHostAppMode(appMode)
  const connectionSnapshot = getGatewayConnectionSnapshot(activeProfile, gatewayPort)
  const connectionLoading = isGatewayConnectionLoading(activeProfile, gatewayPort)
  const gatewayConnected = isGatewayConnectionReady(connectionSnapshot)
  const [servers, setServers] = useState([])
  const [selectedName, setSelectedName] = useState('')
  const [query, setQuery] = useState('')
  const [pluginQuery, setPluginQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [errorRetry, setErrorRetry] = useState(null)
  const [message, setMessage] = useState('')
  const [modalMode, setModalMode] = useState('')
  const [form, setForm] = useState(() => emptyMcpForm())
  const [formError, setFormError] = useState('')
  const [showAdvancedFields, setShowAdvancedFields] = useState(false)
  const [confirmDeleteName, setConfirmDeleteName] = useState('')
  const [activeTab, setActiveTab] = useState(() => (hubMode === 'mcp' ? 'mine' : 'official'))
  const [selectedSystemPluginId, setSelectedSystemPluginId] = useState('')
  const [marketDetailModal, setMarketDetailModal] = useState('')
  const [cloudPluginCatalog, setCloudPluginCatalog] = useState([])
  const [cloudPluginCatalogResolved, setCloudPluginCatalogResolved] = useState(false)
  // Install progress stepper: steps append as each phase actually runs
  // (Accio-style progressive checklist), so skipped phases never render.
  // { pluginId, steps: [{ label, status: 'running'|'done'|'failed', error }] }
  const [installProgress, setInstallProgress] = useState(null)
  const [pendingPluginReview, setPendingPluginReview] = useState(null)
  // Blocking connector auth: set when phase 1 finished but the plugin
  // declares an api-key connector that still needs user input.
  const [pendingConnectorAuth, setPendingConnectorAuth] = useState(null)
  const [loadingCloudPluginCatalog, setLoadingCloudPluginCatalog] = useState(false)
  const [cloudPluginCatalogError, setCloudPluginCatalogError] = useState(null)
  const [organizationPluginEntitlements, setOrganizationPluginEntitlements] = useState([])
  const [loadingOrganizationEntitlements, setLoadingOrganizationEntitlements] = useState(false)
  const [profilePluginSnapshot, setProfilePluginSnapshot] = useState(null)
  const [profileToolCapabilitiesSnapshot, setProfileToolCapabilitiesSnapshot] = useState(null)
  const [supportedPluginSnapshot, setSupportedPluginSnapshot] = useState(null)
  const [loadingProfilePlugins, setLoadingProfilePlugins] = useState(false)
  const [profilePluginStatusError, setProfilePluginStatusError] = useState('')
  const [pluginActionId, setPluginActionId] = useState('')

  function clearError() {
    setError('')
    setErrorRetry(null)
  }

  // The cloud catalog is only an optimistic first paint. A later catalog
  // response must not replace the authoritative local Profile snapshot,
  // otherwise installed plugins briefly (and sometimes permanently) appear
  // as uninstalled after a refresh.
  function applyCachedProfilePluginSnapshot(profile, catalog) {
    const profileKey = String(profile || '').trim()
    setProfilePluginSnapshot(current => {
      if (current && String(current.profile || '').trim() === profileKey) return current
      return buildCachedProfilePluginSnapshot(profileKey, catalog)
    })
  }

  function showError(detail, retry = null) {
    setError(detail)
    setErrorRetry(() => retry)
  }

  const selectedServer = servers.find(server => server.name === selectedName) || null
  const hasCurrentProfilePluginSnapshot = Boolean(
    profilePluginSnapshot &&
    String(profilePluginSnapshot.profile || '').trim() === activeProfile,
  )
  const profilePlugins = hasCurrentProfilePluginSnapshot ? profilePluginSnapshot?.plugins || [] : []
  const hasCurrentProfileToolCapabilitiesSnapshot = Boolean(
    profileToolCapabilitiesSnapshot &&
    String(profileToolCapabilitiesSnapshot.profile || '').trim() === activeProfile,
  )
  function applyProfilePluginSnapshot(snapshot) {
    if (!snapshot || String(snapshot.profile || '').trim() !== activeProfile) return
    setProfilePluginSnapshot(snapshot)
    setProfilePluginStatusError('')
  }
  const pluginCapabilityById = useMemo(() => {
    const entries = new Map()
    if (!hasCurrentProfileToolCapabilitiesSnapshot) return entries
    for (const plugin of profileToolCapabilitiesSnapshot?.plugins || []) {
      const id = String(plugin?.id || '').trim()
      if (id) entries.set(id, plugin)
    }
    return entries
  }, [hasCurrentProfileToolCapabilitiesSnapshot, profileToolCapabilitiesSnapshot])
  const supportedRuntimePluginIds = useMemo(() => {
    const ids = new Set()
    for (const plugin of supportedPluginSnapshot?.plugins || []) {
      if (plugin?.id) ids.add(plugin.id)
      for (const alias of plugin?.aliases || []) ids.add(alias)
    }
    return ids
  }, [supportedPluginSnapshot])
  const visibleTabIds = useMemo(
    () => hubMode === 'mcp' ? ['mine'] : PLUGIN_TABS.map(tab => tab.id),
    [hubMode],
  )
  const visibleTabs = useMemo(
    () => HUB_TABS.filter(tab => visibleTabIds.includes(tab.id)),
    [visibleTabIds],
  )
  useEffect(() => {
    if (hubMode === 'mcp' && activeTab !== 'mine') {
      setActiveTab('mine')
      return
    }
    if (hubMode !== 'mcp' && !PLUGIN_TAB_IDS.has(activeTab)) {
      setActiveTab('official')
    }
  }, [activeTab, hubMode])
  const organizationEntitlementSignature = useMemo(
    () => organizationPluginEntitlements.map(item => `${item.pluginId}:${item.status}`).join('|'),
    [organizationPluginEntitlements],
  )
  const pluginCatalog = useMemo(
    () => mergeBuiltInPluginPresets(cloudPluginCatalog),
    [cloudPluginCatalog],
  )
  const pluginCatalogSignature = useMemo(
    () => pluginCatalog.map(item => `${item.id}:${item.runtimePluginId || item.openclawPluginId || ''}:${item.observedStatus || ''}`).join('|'),
    [pluginCatalog],
  )
  const knownPluginIds = useMemo(
    () => buildKnownPluginIds(pluginCatalog),
    [pluginCatalog],
  )
  // 把云端授权状态物化成 per-profile 授权快照(uniopc-gatekeeper 在引擎进程内
  // 逐工具调用读它,撤权无需重启即断)。catalog / entitlement 任一变化即重写;
  // fire-and-forget:快照写失败不影响 App Center 本身,gatekeeper 缺快照时
  // 处于兼容放行模式,最终门仍在云端。
  useEffect(() => {
    if (!activeProfile) return
    const entitlements = buildPluginGrantStatuses(pluginCatalog, organizationPluginEntitlements)
    engineClient.plugins.writeGrants({ profile: activeProfile, entitlements })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile, pluginCatalog, pluginCatalogSignature, organizationEntitlementSignature])
  const toolCapabilityStatusLabel = useCallback((toolCapability) => {
    const status = String(toolCapability?.status || '').trim()
    // ready 就是可用。无工具插件(技能包走 "/" 调用技能、角色模板包只提供
    // agentTemplates)零工具即为健康,不能按工具数量改判——是否异常由 Rust
    // 侧判定并体现在 status 里,见 withPluginStatus 的注释。
    if (status === 'ready') return '可用'
    if (status === 'runtime_blocked') return '运行受限'
    if (status === 'runtime_missing') return '无可用工具'
    if (status === 'runtime_inspect_failed') return '服务异常'
    if (status === 'uniopc_socials_failed' || status === 'private_conversion_failed') return '服务异常'
    if (status === 'missing_env') return '待管理员配置'
    if (status === 'unauthorized') return '未授权'
    if (status === 'disabled') return '未启用'
    if (status === 'not_installed') return '未安装'
    return ''
  }, [])
  const withPluginStatus = useMemo(() => (preset, sourceLabel) => {
    const entitlement = pluginEntitlementStatus(preset, organizationPluginEntitlements)
    const gateway = pluginGatewayStatus(preset, profilePlugins, servers)
    const { installPluginId, runtimePluginId: declaredRuntimePluginId } = resolveCloudPluginLifecycleIds(preset)
    const runtimePluginId = cloudAgentRuntimePluginId(declaredRuntimePluginId)
    // "当前版本"的事实源是本地已装 manifest 的 version(Rust 快照
    // installedVersion);云端 assignment 的 observed_version 依赖观测回报,
    // 老装机常为空。
    const profileRecord = profilePlugins.find(item => item?.id === installPluginId) || null
    const credentialState = apiKeyCredentialState(profileRecord?.product?.connectors)
    const installedVersion = String(profileRecord?.installedVersion || '').trim()
    const update = pluginUpdateStatus(installedVersion ? { ...preset, installedVersion } : preset)
    const toolCapability = pluginCapabilityById.get(installPluginId) || null
    // 直接采用 Rust 上报的状态,不要在这里按"零工具"二次推导健康度。
    //
    // 判断"零工具是否异常"需要知道该插件是否本就声明了工具,这个信息只有
    // Rust 侧有:apply_runtime_tool_verification 对未声明工具的插件直接放行,
    // 只有"声明了却在运行时缺失"才置 runtime_missing。前端重复推导必然漏掉
    // 各类无工具插件——技能包(documents/presentations/shopify)和角色模板包
    // (employee-roles)都曾因此被误判成"运行异常"。
    const toolCapabilityState = toolCapability?.status || ''
    // 云制品插件(catalog install_kind=cloud_artifact)天然可装:桌面的集成
    // 契约是数据驱动的(requiredEnv 来自制品 manifest、凭据路由来自 catalog
    // function_path),不依赖 Rust 静态表预先认识——否则新发布的插件在安装前
    // 永远"当前版本不支持"(先有鸡先有蛋,gatekeeper 首发即踩中)。Rust 的
    // supported 快照只对"静态内置 + 已安装"有发言权。
    const cloudArtifactInstallable = preset.installKind === 'cloud_artifact'
      || preset.metadata?.install_kind === 'cloud_artifact'
    const supported = Boolean(preset.managementRoute ||
      cloudArtifactInstallable ||
      !supportedPluginSnapshot ||
      supportedRuntimePluginIds.has(runtimePluginId) ||
      supportedRuntimePluginIds.has(preset.id))
    const actionBusy = isPluginActionBusy(preset.id, pluginActionId)
    const readiness = resolvePluginReadiness({
      ...preset,
      entitlementState: entitlement.state,
      entitlementLabel: entitlement.label,
      gatewayState: gateway.state,
      gatewayLabel: gateway.label,
    }, {
      actionBusy,
      hasActiveProfile: Boolean(activeProfile),
      supported,
      // Official cloud plugins mint a host credential — expose an explicit
      // re-authorization action (the install already runs this handshake
      // automatically as the "配置官方云凭证（自动）" step).
      supportsReauthorize: isCloudAgentPluginId(preset.id),
      checkingGateway: loadingProfilePlugins && !hasCurrentProfilePluginSnapshot,
      toolCapabilityState,
      toolCapabilityLabel: toolCapabilityStatusLabel(toolCapability),
      businessHealthState: toolCapability?.businessHealthState || '',
      businessHealthLabel: toolCapability?.businessHealthLabel || '',
      credentialState,
    })
    const actionLabel = gateway.state === 'ready'
      ? '查看'
      : preset.actionLabel || undefined
    return {
      ...preset,
      ...(installedVersion ? { installedVersion } : {}),
      entitlementState: entitlement.state,
      gatewayState: gateway.state,
      updateAvailable: update.updateAvailable,
      readiness,
      lifecycle: readiness,
      actionLabel,
      statusItems: [
        { label: '来源', value: sourceLabel },
        ...(preset.pricing === 'paid' ? [{ label: '类型', value: '付费插件' }] : []),
        ...(update.updateAvailable
          ? [{ label: '版本', value: `v${update.observedVersion} → v${update.latestVersion}` }]
          : []),
        ...readiness.statusItems,
      ],
      // 卡片上只显示一枚状态徽章，不把四段系统词（来源/授权/配置/运行）
      // 拼成一行截断。完整的 statusItems 仍在，留给详情弹窗。
      statusBadge: pluginCardStatusBadge(readiness, preset.pricing),
    }
  }, [activeProfile, hasCurrentProfilePluginSnapshot, loadingProfilePlugins, organizationPluginEntitlements, pluginCapabilityById, profilePlugins, pluginActionId, servers, supportedPluginSnapshot, supportedRuntimePluginIds, toolCapabilityStatusLabel])
  const systemPlugins = useMemo(
    () => pluginCatalog
      .filter(preset => preset.catalogSection !== 'third-party')
      .map(preset => withPluginStatus(preset, '官方')),
    [pluginCatalog, withPluginStatus],
  )
  const thirdPartyPlugins = useMemo(
    () => pluginCatalog
      .filter(preset => preset.catalogSection === 'third-party')
      .map(preset => withPluginStatus(preset, '第三方')),
    [pluginCatalog, withPluginStatus],
  )
  // Featured section (catalog metadata.featured / featured_order): curated
  // subset pinned above the scene groups, ascending order, unset sorts last.
  const featuredPlugins = useMemo(
    () => systemPlugins
      .filter(preset => preset.featured === true)
      .sort((a, b) => (a.featuredOrder ?? Number.MAX_SAFE_INTEGER) - (b.featuredOrder ?? Number.MAX_SAFE_INTEGER)),
    [systemPlugins],
  )
  const featuredIds = useMemo(
    () => new Set(featuredPlugins.map(preset => preset.id)),
    [featuredPlugins],
  )
  // 搜索时不展示精选区（结果应当是完整的），此时场景分组也不能排除精选项。
  const featuredSectionVisible = activeTab === 'official' && !pluginQuery.trim() && featuredPlugins.length > 0
  const customOpenClawPlugins = useMemo(
    () => buildCustomPluginPresets(profilePlugins, knownPluginIds).map(preset => withPluginStatus(preset, '自定义')),
    [knownPluginIds, profilePlugins, withPluginStatus],
  )
  const customPlugins = useMemo(
    () => customOpenClawPlugins,
    [customOpenClawPlugins],
  )
  const managedPlugins = useMemo(
    () => [...systemPlugins, ...thirdPartyPlugins],
    [systemPlugins, thirdPartyPlugins],
  )
  // "已安装" view: local truth only — the plugin must actually exist in this
  // machine's gateway profile. A cloud-side observed_status of "installed"
  // from another machine/profile is history, not presence (it renders as
  // 未安装 in the card and would be misleading here).
  const installedManagedPlugins = useMemo(() => {
    const locallyPresent = new Set(['ready', 'disabled', 'missing_env', 'runtime_blocked', 'runtime_missing', 'runtime_inspect_failed', 'sync_required'])
    return managedPlugins.filter(preset => locallyPresent.has(preset.gatewayState))
  }, [managedPlugins])
  const activePluginList = activeTab === 'third-party'
    ? thirdPartyPlugins
    : activeTab === 'custom'
      ? customPlugins
      : activeTab === 'installed'
        ? installedManagedPlugins
        : systemPlugins
  // Plugin search filters the active tab by title/description/id/tags.
  const visiblePluginList = useMemo(() => {
    const needle = pluginQuery.trim().toLowerCase()
    if (!needle) return activePluginList
    return activePluginList.filter(preset =>
      `${preset.title || ''} ${preset.description || ''} ${preset.id || ''} ${(preset.tags || []).join(' ')}`
        .toLowerCase()
        .includes(needle))
  }, [activePluginList, pluginQuery])
  const pluginTabCounts = useMemo(() => ({
    official: systemPlugins.length,
    'third-party': thirdPartyPlugins.length,
    custom: customPlugins.length,
    installed: installedManagedPlugins.length,
  }), [customPlugins.length, installedManagedPlugins.length, systemPlugins.length, thirdPartyPlugins.length])
  const selectedSystemPlugin = managedPlugins.find(preset => preset.id === selectedSystemPluginId) || null
  const selectedSystemPluginLifecycle = selectedSystemPlugin?.readiness || selectedSystemPlugin?.lifecycle || null
  // Detail drawer "包含" data: product layer (skills/connectors) for installed
  // copies; catalog metadata.skills as the pre-install fallback so the drawer
  // can at least show a count placeholder (Accio 的「安装后展示技能列表」).
  const selectedPluginProduct = selectedSystemPlugin
    ? ((profilePluginSnapshot?.plugins || []).find(plugin =>
        plugin.id === resolveCloudPluginLifecycleIds(selectedSystemPlugin).installPluginId)?.product || null)
    : null
  // Product-layer skills are {id, displayName, description} (Rust camelCase);
  // catalog metadata fallback entries may be bare strings or {name,...}.
  const selectedPluginSkills = (selectedPluginProduct?.skills
    || (Array.isArray(selectedSystemPlugin?.metadata?.skills) ? selectedSystemPlugin.metadata.skills : []))
    .map(skill => (typeof skill === 'string' ? { id: skill } : skill))
  const selectedPluginConnectors = selectedPluginProduct?.connectors || []
  const selectedPluginReleaseNotes = String(selectedSystemPlugin?.metadata?.release_notes || '').trim()
  // OAuth connector state, keyed `${pluginId}:${connectorId}`:
  // { status: connected|authorizing|preparing|disconnected|error, authorizeUrl, accountLabel, busy }
  const [connectorOauth, setConnectorOauth] = useState({})
  const patchConnectorOauth = useCallback((key, patch) => {
    setConnectorOauth(prev => ({ ...prev, [key]: { ...(prev[key] || {}), ...patch } }))
  }, [])
  // Refresh cloud-side connection status for the drawer's oauth2 connectors.
  useEffect(() => {
    if (!selectedSystemPlugin) return
    const oauthConnectors = selectedPluginConnectors.filter(connector => connector.authType === 'oauth2')
    if (oauthConnectors.length === 0) return
    let cancelled = false
    for (const connector of oauthConnectors) {
      const key = `${selectedSystemPlugin.id}:${connector.id}`
      pluginConnectorOauthStatus(selectedSystemPlugin.id, connector.id)
        .then(status => {
          if (cancelled) return
          patchConnectorOauth(key, {
            status: status?.status || 'disconnected',
            accountLabel: status?.accountLabel || '',
          })
        })
        .catch(() => {
          // 状态查询失败保持 unknown，不阻塞抽屉。
        })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSystemPluginId, selectedPluginConnectors.length])

  // 连接账号：oauth_start → 系统浏览器授权 → 轮询到 connected。
  async function connectOauthConnector(preset, connector) {
    const key = `${preset.id}:${connector.id}`
    clearError()
    patchConnectorOauth(key, { busy: true, status: 'preparing', authorizeUrl: '' })
    try {
      const { authorizeUrl } = await startPluginConnectorOauth(preset.id, connector.id)
      patchConnectorOauth(key, { status: 'authorizing', authorizeUrl })
      try {
        await invoke('open_external_url', { url: authorizeUrl })
      } catch {
        // 浏览器没弹出也不算失败——UI 提供「复制链接手动打开」兜底。
      }
      const result = await waitForPluginConnectorOauth(preset.id, connector.id)
      patchConnectorOauth(key, { status: 'connected', accountLabel: result?.accountLabel || '', authorizeUrl: '' })
      setMessage(`${connector.name || connector.id} 已连接，凭据由云端安全托管。`)
    } catch (err) {
      patchConnectorOauth(key, { status: 'error' })
      showError(String(err?.message || err || '连接失败'), () => connectOauthConnector(preset, connector))
    } finally {
      patchConnectorOauth(key, { busy: false })
    }
  }

  async function disconnectOauthConnector(preset, connector) {
    const key = `${preset.id}:${connector.id}`
    clearError()
    patchConnectorOauth(key, { busy: true })
    try {
      await disconnectPluginConnector(preset.id, connector.id)
      patchConnectorOauth(key, { status: 'disconnected', accountLabel: '' })
      setMessage(`${connector.name || connector.id} 已断开，需重新连接才能再次使用。`)
    } catch (err) {
      showError(String(err?.message || err || '断开失败'), () => disconnectOauthConnector(preset, connector))
    } finally {
      patchConnectorOauth(key, { busy: false })
    }
  }
  const filteredServers = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return servers.filter(server => {
      if (filter !== 'all' && server.transport !== filter) return false
      if (!needle) return true
      return `${server.name} ${server.summary || ''} ${server.transport || ''}`.toLowerCase().includes(needle)
    })
  }, [filter, query, servers])

  async function loadServers() {
    if (!canManageMcpServers) {
      setServers([])
      setSelectedName('')
      setLoading(false)
      clearError()
      return
    }
    if (activeOpenClaw.loading || !activeProfile) {
      setServers([])
      setSelectedName('')
      setLoading(true)
      clearError()
      return
    }
    setLoading(true)
    clearError()
    let latestConnectionSnapshot = connectionSnapshot
    try {
      const snapshot = await refreshActiveConnectionSnapshot()
      latestConnectionSnapshot = snapshot
      const readiness = getGatewayConnectionReadiness(snapshot)
      if (!readiness.ready) {
        throw new Error(readiness.message || 'Gateway Connection 未连接。')
      }
      const result = await engineClient.plugins.listMcpServers({ profile: activeProfile })
      const nextServers = Array.isArray(result?.servers) ? result.servers : []
      setServers(nextServers)
      setSelectedName(prev => {
        if (prev && nextServers.some(server => server.name === prev)) return prev
        return nextServers[0]?.name || ''
      })
    } catch (err) {
      showError(mcpGatewayErrorMessage(err, latestConnectionSnapshot), loadServers)
      if (!getGatewayConnectionReadiness(latestConnectionSnapshot).ready) {
        setServers([])
        setSelectedName('')
      }
    } finally {
      setLoading(false)
    }
  }

  async function refreshActiveConnectionSnapshot() {
    if (!activeProfile) return null
    return refreshGatewayConnectionSnapshot({ profile: activeProfile, gatewayPort })
  }

  async function loadCloudPluginCatalog() {
    if (!user?.uid || activeOpenClaw.loading) {
      invalidateCloudAgentCatalogRequests()
      setCloudPluginCatalog([])
      setCloudPluginCatalogResolved(false)
      setCloudPluginCatalogError(null)
      setLoadingCloudPluginCatalog(Boolean(user?.uid && activeOpenClaw.loading))
      return
    }

    const requestScope = catalogRequestScope
    if (catalogRequestScopeRef.current !== requestScope) return
    const request = beginCloudAgentCatalogRequest(requestScope)
    setLoadingCloudPluginCatalog(true)
    setCloudPluginCatalogError(null)
    const commitCurrentRequest = commit => {
      if (catalogRequestScopeRef.current !== requestScope) return false
      return commitCloudAgentCatalogRequest(request, commit)
    }
    try {
      const catalogResponse = await fetchTrustedPluginCatalog()
      const rows = normalizeCloudPluginCatalogRows(
        trustedCatalogRowsForCurrentResponse(catalogResponse),
      )
      // 让凭据签发链路认识 catalog 声明的 cloud-agent 插件(metadata.function_path)
      // ——新插件因此不需要写进 CLOUD_AGENT_PLUGIN_IDS 静态表。
      commitCurrentRequest(() => {
        replaceCloudAgentPluginCatalog(rows)
        setCloudPluginCatalog(rows)
        setCloudPluginCatalogResolved(true)
        applyCachedProfilePluginSnapshot(activeProfile, rows)
        setProfileToolCapabilitiesSnapshot(null)
        setCloudPluginCatalogError(null)
      })
    } catch (err) {
      const catalogError = normalizeTrustedServiceError(err)
      commitCurrentRequest(() => {
        replaceCloudAgentPluginCatalog([])
        setCloudPluginCatalogResolved(true)
        setCloudPluginCatalogError(catalogError)
      })
    } finally {
      commitCurrentRequest(() => setLoadingCloudPluginCatalog(false))
    }
  }

  async function loadOrganizationPluginEntitlements() {
    if (!user?.uid || activeOpenClaw.loading || !activeOpenClaw.workspaceProfile?.organizationId) {
      setOrganizationPluginEntitlements([])
      setLoadingOrganizationEntitlements(Boolean(user?.uid && activeOpenClaw.loading))
      return
    }

    setLoadingOrganizationEntitlements(true)
    try {
      const rows = await listMyOrganizationPluginEntitlements(supabase, user.uid)
      setOrganizationPluginEntitlements(rows)
    } catch (err) {
      setOrganizationPluginEntitlements([])
      showError(String(err?.message || err || '读取组织插件授权失败'), () => {
        clearError()
        loadOrganizationPluginEntitlements()
      })
    } finally {
      setLoadingOrganizationEntitlements(false)
    }
  }

  async function refreshProfilePluginStatusFromLocal() {
    if (!canManageMcpServers || activeOpenClaw.loading || !activeProfile) {
      setProfilePluginSnapshot(null)
      setProfileToolCapabilitiesSnapshot(null)
      setProfilePluginStatusError('')
      setLoadingProfilePlugins(false)
      return
    }
    setLoadingProfilePlugins(true)
    setProfilePluginStatusError('')
    try {
      // Configuration is the source of truth for install/enable/API-key UI.
      // Do not couple it to the slower runtime doctor below: an inspect or
      // health-probe failure must never erase a successfully saved connector
      // and send the user back through the credential form.
      const snapshot = await engineClient.plugins.listProfile({ profile: activeProfile })
      setProfilePluginSnapshot(snapshot || null)
      setProfileToolCapabilitiesSnapshot(null)
      setProfilePluginStatusError('')

      // Runtime verification is supplementary. It only owns the runtime
      // status cell, while the local snapshot above continues to own config
      // and credential state if the engine cannot complete a health check.
      let report = null
      try {
        report = await checkProfilePluginConsistency({
          bootstrap: {
            openclawProfile: activeProfile,
            policyVersion: 0,
            plugins: organizationPluginEntitlements,
          },
        })
        setProfileToolCapabilitiesSnapshot(report?.capabilities || null)
      } catch (err) {
        setProfilePluginStatusError(
          stripEngineStartupNoise(String(err?.message || err)) || '读取插件运行状态失败',
        )
      }

      const observationSnapshot = report?.snapshot || snapshot
      if (user?.uid && activeOpenClawProfileId && Array.isArray(observationSnapshot?.plugins)) {
        const observations = observationSnapshot.plugins
          .filter(plugin => isCloudAgentPluginId(plugin.id))
          .map(plugin => {
            const observedStatus = cloudPluginObservedStatus(plugin)
            return reportCloudProfilePluginObservation(supabase, user.uid, activeOpenClawProfileId, {
              pluginId: plugin.id,
              observedStatus,
              observedVersion: '',
              observedEnabled: Boolean(plugin.enabled),
              error: cloudPluginObservationError(plugin, observedStatus),
            })
          })
        const results = await Promise.allSettled(observations)
        if (results.some(result => result.status === 'rejected')) {
          console.warn('Failed to report one or more profile plugin observations', results)
        }
      }
    } catch (err) {
      // Keep the last config snapshot visible. The next refresh can recover
      // it, and the user must not see "未写入" merely because a read timed out.
      setProfileToolCapabilitiesSnapshot(null)
      setProfilePluginStatusError(
        stripEngineStartupNoise(String(err?.message || err)) || '读取 Profile 插件状态失败',
      )
    } finally {
      setLoadingProfilePlugins(false)
    }
  }

  async function loadSupportedPlugins() {
    if (!canManageMcpServers || activeOpenClaw.loading) {
      setSupportedPluginSnapshot(null)
      return
    }
    try {
      const snapshot = await engineClient.plugins.listSupported()
      setSupportedPluginSnapshot(snapshot || null)
    } catch {
      setSupportedPluginSnapshot(null)
    }
  }

  useEffect(() => {
    loadServers()
  }, [canManageMcpServers, activeOpenClaw.loading, activeProfile, gatewayPort])

  useEffect(() => {
    loadSupportedPlugins()
  }, [canManageMcpServers, activeOpenClaw.loading])

  useEffect(() => {
    if (!visibleTabs.some(tab => tab.id === activeTab)) {
      setActiveTab(visibleTabs[0]?.id || 'official')
    }
  }, [activeTab, visibleTabs])

  useEffect(() => {
    loadOrganizationPluginEntitlements()
  }, [user?.uid, activeOpenClaw.loading, activeOpenClaw.workspaceProfile?.organizationId])

  useEffect(() => {
    loadCloudPluginCatalog()
    return () => {
      invalidateCloudAgentCatalogRequests()
    }
  }, [user?.uid, activeOpenClaw.loading, activeOpenClawProfileId, activeProfile])

  useEffect(() => {
    applyCachedProfilePluginSnapshot(activeProfile, cloudPluginCatalog)
    setProfileToolCapabilitiesSnapshot(null)
  }, [activeProfile, cloudPluginCatalog])

  useEffect(() => {
    refreshProfilePluginStatusFromLocal()
  }, [canManageMcpServers, activeOpenClaw.loading, activeProfile, organizationEntitlementSignature, pluginCatalogSignature])

  function openCreateModal() {
    if (!activeProfile) {
      showError('组织管理员尚未为该工作区创建 Uniopc 引擎 profile。')
      return
    }
    setForm(emptyMcpForm())
    setFormError('')
    setShowAdvancedFields(false)
    setModalMode('create')
    clearError()
    setMessage('')
  }

  function switchHubMode(nextMode) {
    if (nextMode === hubMode) return
    const tab = HUB_MODE_TABS.find(item => item.id === nextMode) || HUB_MODE_TABS[0]
    const targetPath = profileWorkspace
      ? profileWorkspacePath(profileWorkspace, tab.childPath)
      : `/${tab.childPath}`
    navigate(targetPath)
  }

  function navigateSystemPluginManagementRoute(preset) {
    if (!preset?.managementRoute) return false
    if (!profileWorkspace) {
      showError('请先进入成员 Workspace 后再打开该插件管理页。')
      return false
    }
    const [routePath, query = ''] = String(preset.managementRoute).split('?')
    const targetPath = profileWorkspacePath(profileWorkspace, routePath.replace(/^\//, ''))
    navigate(query ? `${targetPath}?${query}` : targetPath)
    return true
  }

  function openSystemPluginDetails(preset) {
    if (!preset?.id) return
    setSelectedSystemPluginId(preset.id)
    setMarketDetailModal('system-plugin')
    clearError()
    setMessage('')
  }

  function isCloudDistributedPlugin(preset) {
    // `distribution` is authoritative for healthy catalog rows.  However, old
    // rows can carry the historical contradiction "bundled + cloud_artifact".
    // A published artifact is actionable proof that this plugin must go
    // through the download/install lifecycle; preferring it here keeps older
    // desktop builds from authorizing a plugin and then trying to enable a
    // directory that was never installed. The server-side catalog contract
    // rejects new contradictory rows.
    return preset?.distribution === 'cloud' || preset?.installKind === 'cloud_artifact'
  }

  function localPluginRecord(installPluginId) {
    return (profilePluginSnapshot?.plugins || []).find(plugin => plugin.id === installPluginId) || null
  }

  function markInstallStep(label, status, error = '', group = 'init') {
    setInstallProgress(prev => {
      if (!prev) return prev
      const steps = [...prev.steps]
      const index = steps.findIndex(step => step.label === label)
      if (index === -1) steps.push({ label, status, error, group })
      else steps[index] = { label, status, error, group }
      return { ...prev, steps }
    })
  }

  async function runInstallStep(label, group, task) {
    markInstallStep(label, 'running', '', group)
    try {
      const result = await task()
      markInstallStep(label, 'done', '', group)
      return result
    } catch (err) {
      markInstallStep(label, 'failed', String(err?.message || err || '失败'), group)
      throw err
    }
  }

  function connectorEnvFromValues(connector, values) {
    const env = {}
    for (const field of connector?.fields || []) {
      const envKey = connector?.env?.[field.key]
      const value = String(values?.[field.key] || '').trim()
      if (envKey && value) env[envKey] = value
    }
    return env
  }

  // Return the next incomplete API-key connector declared by the installed
  // plugin. A connector whose state is already configured never blocks an
  // ordinary enable/retry action; multiple incomplete connectors are handled
  // one after another.
  function pluginApiKeyConnector(snapshot, installPluginId) {
    const record = (snapshot?.plugins || []).find(plugin => plugin.id === installPluginId)
    return (record?.product?.connectors || []).find(connector => (
      connector.authType === 'api-key' && connectorNeedsCredentialInput(connector)
    )) || null
  }

  async function applySystemPluginSetup(preset, { resetHostCredential = false, connectorValues = null, connectorOverride = null, forceReinstall = false, skipConnectorPrompt = false, reconfigureConnector = false, preparedReview = null } = {}) {
    const { installPluginId, runtimePluginId: declaredRuntimePluginId } = resolveCloudPluginLifecycleIds(preset)
    const runtimePluginId = cloudAgentRuntimePluginId(declaredRuntimePluginId)
    setInstallProgress({ pluginId: preset.id, steps: [] })
    // Keep an open credential form mounted while its engine-write retry is in
    // flight. On failure the typed values stay in memory instead of forcing a
    // customer to enter an API key again.
    if (!connectorValues) setPendingConnectorAuth(null)

    // ── 第一阶段：初始化资源（验身份验权限 → 下载 → 校验安装）────────────
    let authorization = null
    // Every cloud-distributed plugin needs the install authorization (it
    // carries artifactPath/sha for the download+install path) — skill packs
    // included, not just cloud-agent plugins.
    if (isCloudAgentPluginId(preset.id) || isCloudDistributedPlugin(preset)) {
      if (!activeOpenClawProfileId) throw new Error('缺少本地工作空间标识，无法登记插件安装授权。')
      authorization = await runInstallStep('安装授权', 'init', () => withPluginActionTimeout(
        authorizeCloudPluginInstall(
          supabase,
          user.uid,
          activeOpenClawProfileId,
          preset.id,
          preset.latestVersion || preset.version || 'latest',
        ),
        `${preset.title || preset.id} 安装授权`,
      ))
    }
    const localRecord = localPluginRecord(installPluginId)
    // forceReinstall drives the update path: reinstall over an installed copy
    // (the CLI install runs --force) so the freshly authorized artifact wins.
    const needsCloudInstall = isCloudDistributedPlugin(preset)
      && Boolean(authorization?.artifactPath)
      && (forceReinstall || localRecord?.installed !== true)
    let installSnapshot = null
    if (needsCloudInstall && !preparedReview) {
      // Cloud-distribution path: download the published artifact from
      // plugin-artifacts, then hand it to the official
      // `openclaw plugins install` lifecycle (sha256-verified in Rust).
      // Phase 1 installs WITHOUT enabling (enable: false) — enabling is the
      // final act of phase 2 (账号授权).
      const zipBase64 = await runInstallStep('下载安装包', 'init', () => withPluginActionTimeout(
        downloadCloudPluginArtifactBase64(supabase, authorization.artifactPath),
        `${preset.title || preset.id} 下载安装包`,
        OPENCLAW_PLUGIN_WRITE_TIMEOUT_MS,
      ))
      const review = await runInstallStep('分析插件能力', 'init', () => (
        engineClient.plugins.prepareLifecycle({
          req: {
            profile: activeProfile,
            pluginId: installPluginId,
            artifactSha256: authorization.artifactSha256,
            zipBase64,
          },
        })
      ))
      setPendingPluginReview({ preset, review, forceReinstall, skipConnectorPrompt, reconfigureConnector })
      return 'pending_review'
    }
    if (needsCloudInstall && preparedReview) {
      installSnapshot = await runInstallStep('写入已确认插件能力', 'init', () => (
        engineClient.plugins.commitLifecycle({
          req: {
            stageId: preparedReview.stageId,
            profile: activeProfile,
            pluginId: installPluginId,
            artifactSha256: preparedReview.artifactSha256,
            enable: false,
          },
        })
      ))
      applyProfilePluginSnapshot(installSnapshot)
    }

    // ── 第二阶段：账号授权 → 启用 ────────────────────────────────────────
    // 两种凭据可以并存，不是二选一：
    //   * 平台托管 host credential（catalog 声明 function_path）——自动铸造，无感；
    //   * 第三方 api-key 连接器（插件 connectors.json）——阻塞式表单。
    // 混合形态（如公众号：走我们固定 IP 的云函数转发，但用的是用户自己的
    // 公众号 AppID/AppSecret）两者都要，此前 if/else 会让云插件永不弹表单。
    let pluginSnapshot
    let finalGroup = 'init'
    const needsHostCredential = isCloudAgentPluginId(preset.id)
    // skipConnectorPrompt (update path): keep the already-configured plugin
    // env untouched instead of re-asking for credentials — treat the plugin
    // like one without a connector.
    const connector = skipConnectorPrompt
      ? null
      : connectorOverride
        || pluginApiKeyConnector(installSnapshot, installPluginId)
        || (localRecord?.product?.connectors || []).find(item => (
          item.authType === 'api-key' && connectorNeedsCredentialInput(item)
        ))
        || null

    let authEnv = null
    if (needsHostCredential) {
      finalGroup = 'auth'
      authEnv = await runInstallStep('配置官方云凭证（自动）', 'auth', () => withPluginActionTimeout(
        currentCloudAgentRuntimeAuthEnv({
          profile: activeProfile,
          pluginIds: [runtimePluginId],
          replaceExistingHostCredential: true,
          resetHostCredential,
        }),
        `${preset.title || preset.id} 授权`,
      ))
    }

    // 表单在 host credential 之后问：铸造失败就没必要让用户白填一遍密钥。
    const connectorRequiresInput = connectorNeedsCredentialInput(connector, { reconfigure: reconfigureConnector })
    if (connector && connectorRequiresInput && !connectorValues) {
      // 阻塞制：资源已就位，等待用户在弹窗内完成凭据连接后才启用并完成安装。
      markInstallStep(`连接 ${connector.name || connector.id}`, 'waiting', '', 'auth')
      setPendingConnectorAuth({ pluginId: preset.id, runtimePluginId, connector, values: {} })
      return 'pending_connector'
    }
    const pluginEnv = connector && connectorValues ? connectorEnvFromValues(connector, connectorValues) : null
    if (connector && connectorRequiresInput) finalGroup = 'auth'
    const enableLabel = needsHostCredential
      ? '启用插件'
      : connector && connectorRequiresInput
        ? `连接 ${connector.name || connector.id}`
        : '启用插件'
    pluginSnapshot = await runInstallStep(
      enableLabel,
      needsHostCredential || (connector && connectorRequiresInput) ? 'auth' : 'init',
      () => (
        engineClient.plugins.setProfile({
          req: {
            profile: activeProfile,
            pluginId: installPluginId,
            enabled: true,
            ...(authEnv || {}),
            ...(pluginEnv && Object.keys(pluginEnv).length > 0 ? { pluginEnv } : {}),
          },
        })
      ),
    )
    applyProfilePluginSnapshot(pluginSnapshot)
    const nextConnector = skipConnectorPrompt ? null : pluginApiKeyConnector(pluginSnapshot, installPluginId)
    if (nextConnector && nextConnector.id !== connector?.id) {
      markInstallStep(`连接 ${nextConnector.name || nextConnector.id}`, 'waiting', '', 'auth')
      setPendingConnectorAuth({ pluginId: preset.id, runtimePluginId, connector: nextConnector, values: {} })
      return 'pending_connector'
    }
    if (needsCloudInstall && user?.uid && activeOpenClawProfileId) {
      try {
        await reportCloudProfilePluginObservation(supabase, user.uid, activeOpenClawProfileId, {
          pluginId: preset.id,
          observedStatus: 'installed',
          observedVersion: authorization.version || '',
          observedEnabled: true,
          observedSha256: authorization.artifactSha256 || '',
        })
      } catch (err) {
        console.warn('Failed to report cloud plugin install observation', err)
      }
    }
    await runInstallStep('同步插件状态', finalGroup, async () => {
      await refreshProfilePluginStatusFromLocal()
      await loadCloudPluginCatalog()
    })
  }

  async function retryPluginCapabilityReview(pending) {
    if (!pending?.preset?.id) return
    // The first install pass releases its action lock while the user reviews
    // capabilities. Reacquire it for the confirmed pass so the detail footer
    // cannot start the download/install flow again while commit, enable, and
    // status sync are still running.
    setPluginActionId(pending.preset.id)
    clearError()
    try {
      await applySystemPluginSetup(pending.preset, {
        preparedReview: pending.review,
        forceReinstall: pending.forceReinstall,
        skipConnectorPrompt: pending.skipConnectorPrompt,
        reconfigureConnector: pending.reconfigureConnector,
      })
    } catch (reviewError) {
      showError(
        String(reviewError?.message || reviewError || '确认插件能力失败'),
        () => retryPluginCapabilityReview(pending),
      )
    } finally {
      setPluginActionId('')
    }
  }

  async function confirmPluginCapabilityReview() {
    const pending = pendingPluginReview
    if (!pending) return
    setPendingPluginReview(null)
    await retryPluginCapabilityReview(pending)
  }

  async function cancelPluginCapabilityReview() {
    const pending = pendingPluginReview
    setPendingPluginReview(null)
    if (!pending?.review || !activeProfile) return
    try {
      await engineClient.plugins.cancelLifecycle({
        req: {
          stageId: pending.review.stageId,
          profile: activeProfile,
          pluginId: pending.review.pluginId,
        },
      })
    } catch (cancelError) {
      console.warn('Failed to cancel plugin capability review', cancelError)
    }
  }

  async function continueSystemPluginSetup(preset, { actionId, resetHostCredential = false } = {}) {
    if (!preset?.id) return
    if (preset.releaseState === 'unpublished') {
      showError('该插件尚未发布可安装版本。')
      return
    }
    const entitlement = pluginEntitlementStatus(preset, organizationPluginEntitlements)
    if (entitlement.state !== 'active') {
      showError('当前组织没有该插件权限，请联系管理员开通。')
      return
    }
    if (!activeProfile) {
      showError('组织管理员尚未为该工作区创建 Uniopc 引擎 profile。')
      return
    }
    const title = preset.title || preset.id
    setPluginActionId(actionId || preset.id)
    clearError()
    setMessage(resetHostCredential
      ? `正在为 ${title} 重新授权（重新签发 Cloud Agent Host Credential）并同步 Uniopc 引擎...`
      : `正在启用 ${title}，准备 Cloud Agent Host Credential 并同步 Uniopc 引擎...`)
    const connectorRetry = pendingConnectorAuth?.pluginId === preset.id
      ? {
          connectorValues: pendingConnectorAuth.values || {},
          connectorOverride: pendingConnectorAuth.connector,
          reconfigureConnector: pendingConnectorAuth.reconfigure === true,
        }
      : {}
    try {
      const result = await applySystemPluginSetup(preset, { resetHostCredential, ...connectorRetry })
      if (result === 'pending_connector') {
        setMessage(`${title} 资源已就绪，请完成账号授权以完成安装。`)
        return
      }
      if (result === 'pending_review') {
        setMessage(`${title} 已完成制品校验，请确认其申请的能力。`)
        return
      }
      setMessage(resetHostCredential
        ? `${title} 已重新授权并启用。`
        : `${title} 已为当前 Profile 启用。`)
    } catch (err) {
      const message = stripEngineStartupNoise(String(err?.message || err)) || '启用 Uniopc 引擎 插件失败'
      // When we were not already forcing a reset, an expired/mismatched host
      // credential is auto-recoverable: re-run the setup once with a fresh mint.
      if (!resetHostCredential && isCloudAgentPluginId(preset.id) && isCloudAgentHostCredentialResetRequiredError(err)) {
        try {
          setMessage(`正在为 ${title} 重新授权并启用...`)
          await applySystemPluginSetup(preset, { resetHostCredential: true, ...connectorRetry })
          setMessage(`${title} 已重新授权并启用。`)
        } catch (resetErr) {
          showError(
            String(resetErr?.message || resetErr || '重新授权并启用 Uniopc 引擎 插件失败'),
            () => continueSystemPluginSetup(preset, { actionId, resetHostCredential: true }),
          )
        }
        return
      }
      showError(message, () => continueSystemPluginSetup(preset, { actionId, resetHostCredential }))
    } finally {
      setPluginActionId('')
    }
  }

  // Explicit account re-authorization for official cloud plugins: re-mint the
  // Cloud Agent Host Credential (forced reset) and re-enable. This is the
  // targeted fix when a plugin card shows "服务异常" because its host credential
  // expired or drifted from the cloud — as opposed to restarting the engine.
  function reauthorizeSystemPlugin(preset, { actionId } = {}) {
    return continueSystemPluginSetup(preset, { actionId, resetHostCredential: true })
  }

  // Update = re-run the cloud install pipeline with a forced reinstall. The
  // authorize step re-resolves the latest published artifact; existing plugin
  // env (api-key credentials) is preserved via skipConnectorPrompt.
  async function updateSystemPlugin(preset, { silent = false } = {}) {
    if (!preset?.id || !activeProfile) return
    const entitlement = pluginEntitlementStatus(preset, organizationPluginEntitlements)
    if (entitlement.state !== 'active') {
      if (!silent) showError('当前组织没有该插件权限，请联系管理员开通。')
      return
    }
    const title = preset.title || preset.id
    const targetVersion = preset.latestVersion ? `v${preset.latestVersion}` : '最新版本'
    setPluginActionId(`${preset.id}:update`)
    clearError()
    setMessage(silent
      ? `${title} 有必须安装的更新，正在自动更新到 ${targetVersion}...`
      : `正在更新 ${title} 到 ${targetVersion}...`)
    try {
      await applySystemPluginSetup(preset, { forceReinstall: true, skipConnectorPrompt: true })
      setMessage(`${title} 已更新到 ${targetVersion}。`)
    } catch (err) {
      if (silent) console.warn('Silent force update failed', preset.id, err)
      else showError(String(err?.message || err || '更新插件失败'), () => updateSystemPlugin(preset))
    } finally {
      setPluginActionId('')
    }
  }

  // 召回通道：catalog 标记 force_update 的插件在本机版本落后时静默强制升级
  // （目录/状态刷新触发，每插件每会话至多尝试一次，一次只跑一个），期间该
  // 插件的其它操作被 pluginActionId 拦截。
  const forceUpdateAttemptedRef = useRef(new Set())
  useEffect(() => {
    if (!activeProfile || pluginActionId || saving) return
    const target = systemPlugins.find(preset => pluginForceUpdateRequired(preset)
      && !forceUpdateAttemptedRef.current.has(preset.id))
    if (!target) return
    forceUpdateAttemptedRef.current.add(target.id)
    updateSystemPlugin(target, { silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile, pluginActionId, saving, systemPlugins])

  // Blocking connector auth submit: rerun setup with the user's credential
  // values — phase 1 steps no-op fast (already installed), phase 2 writes the
  // env and enables.
  async function finishConnectorAuth(values) {
    const pending = pendingConnectorAuth
    if (!pending) return
    const preset = managedPlugins.find(item => item.id === pending.pluginId)
      || { id: pending.pluginId, runtimePluginId: pending.runtimePluginId, title: pending.connector?.name || pending.pluginId }
    setPluginActionId(pending.pluginId)
    clearError()
    try {
      const result = await applySystemPluginSetup(preset, {
        connectorValues: values || pending.values || {},
        connectorOverride: pending.connector,
        reconfigureConnector: pending.reconfigure === true,
      })
      if (result !== 'pending_connector') {
        setPendingConnectorAuth(null)
        setMessage(`${preset.title || preset.id} 已连接并启用。`)
      }
    } catch (err) {
      showError(String(err?.message || err || '连接失败'), () => finishConnectorAuth(values))
    } finally {
      setPluginActionId('')
    }
  }

  // canSkipBlocking：blocking 连接器允许「暂时跳过」——先启用插件（保留/不写
  // 凭据 env），missing_env 链路自然把它标为「缺少授权凭证」，稍后在详情补全。
  async function skipConnectorAuth() {
    const pending = pendingConnectorAuth
    if (!pending) return
    const preset = managedPlugins.find(item => item.id === pending.pluginId)
      || { id: pending.pluginId, runtimePluginId: pending.runtimePluginId, title: pending.connector?.name || pending.pluginId }
    setPluginActionId(pending.pluginId)
    clearError()
    try {
      await applySystemPluginSetup(preset, { skipConnectorPrompt: true })
      setPendingConnectorAuth(null)
      setMessage(`${preset.title || preset.id} 已启用（已跳过账号授权，可稍后在插件详情中补全凭据）。`)
    } catch (err) {
      showError(String(err?.message || err || '启用失败'), skipConnectorAuth)
    } finally {
      setPluginActionId('')
    }
  }

  function reconfigureApiKeyConnector(preset, connector) {
    if (!preset?.id || !connector) return
    setInstallProgress({
      pluginId: preset.id,
      steps: [{ label: `修改 ${connector.name || connector.id}`, status: 'waiting', error: '', group: 'auth' }],
    })
    setPendingConnectorAuth({
      pluginId: preset.id,
      runtimePluginId: cloudAgentRuntimePluginId(preset.runtimePluginId || preset.id),
      connector,
      reconfigure: true,
      values: {},
    })
    clearError()
    setMessage('留空的已保存字段不会被修改。')
  }

  // 服务端预装清单（catalog metadata.preinstall）：有权限且未安装的预装插件
  // 静默安装（跳过凭据提示，稍后补全）。每插件每会话至多尝试一次，一次一个。
  const preinstallAttemptedRef = useRef(new Set())
  useEffect(() => {
    if (!activeProfile || pluginActionId || saving) return
    if (loadingProfilePlugins || !hasCurrentProfilePluginSnapshot) return
    const target = systemPlugins.find(preset => preset.preinstall === true
      && preset.entitlementState === 'active'
      && preset.readiness?.state === 'not_installed'
      && !preinstallAttemptedRef.current.has(preset.id))
    if (!target) return
    preinstallAttemptedRef.current.add(target.id)
    ;(async () => {
      setPluginActionId(target.id)
      try {
        await applySystemPluginSetup(target, { skipConnectorPrompt: true })
        setMessage(`${target.title || target.id} 已自动安装（预装插件）。`)
      } catch (err) {
        console.warn('Preinstall failed', target.id, err)
      } finally {
        setPluginActionId('')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile, pluginActionId, saving, loadingProfilePlugins, hasCurrentProfilePluginSnapshot, systemPlugins])

  // 卸载 = 停用条目 + 官方 CLI 删除插件目录。产品上不再提供"停用但保留"这一态:
  // 云端分发让重装成本极低,而"装着但关着"会留下配置残留与含糊状态(用户记不住
  // 当初为什么关的)。engine 侧的 enabled=false 仍保留,供组织策略 reconcile 使用。
  async function uninstallSystemPlugin(preset) {
    if (!preset?.id) return
    if (!activeProfile) {
      showError('组织管理员尚未为该工作区创建 Uniopc 引擎 profile。')
      return
    }
    const title = preset.title || preset.id
    const connectorNames = (localPluginRecord(resolveCloudPluginLifecycleIds(preset).installPluginId)?.product?.connectors || [])
      .map(item => item.name || item.id)
      .filter(Boolean)
    const extra = connectorNames.length > 0
      ? `\n\n已连接的账号授权(${connectorNames.join('、')})会一并清除,重装后需重新填写。`
      : ''
    if (!window.confirm(`确定卸载「${title}」吗?\n\n插件文件会从本机删除,随时可以在应用中心重新安装。${extra}`)) {
      return
    }
    const actionId = `${preset.id}:uninstall`
    setPluginActionId(actionId)
    clearError()
    setMessage(`正在卸载 ${title}...`)
    try {
      const { installPluginId } = resolveCloudPluginLifecycleIds(preset)
      const pluginSnapshot = await engineClient.plugins.uninstallCloud({
        req: { profile: activeProfile, pluginId: installPluginId },
      })
      applyProfilePluginSnapshot(pluginSnapshot)
      await refreshProfilePluginStatusFromLocal()
      await loadCloudPluginCatalog()
      setMessage(`${title} 已卸载。`)
    } catch (err) {
      showError(String(err?.message || err || '卸载 Uniopc 引擎 插件失败'), () => uninstallSystemPlugin(preset))
    } finally {
      setPluginActionId('')
    }
  }

  function runSystemPluginPrimaryAction(preset) {
    if (!preset) return
    const primaryAction = preset.readiness?.primaryAction || preset.lifecycle?.primaryAction
    if (primaryAction === 'open_management') {
      navigateSystemPluginManagementRoute(preset)
      return
    }
    if (primaryAction === 'reauthorize') {
      reauthorizeSystemPlugin(preset)
      return
    }
    continueSystemPluginSetup(preset)
  }

  function runSystemPluginSecondaryAction(preset) {
    if (!preset) return
    const secondaryAction = preset.readiness?.secondaryAction || preset.lifecycle?.secondaryAction
    if (!secondaryAction) return
    const actionId = `${preset.id}:${secondaryAction}`
    if (secondaryAction === 'reauthorize') {
      reauthorizeSystemPlugin(preset, { actionId })
      return
    }
    // repair_restart / restart: re-apply config and restart the engine without
    // forcing a host-credential reset.
    continueSystemPluginSetup(preset, { actionId })
  }

  function closeMarketDetailModal() {
    setMarketDetailModal('')
    setSelectedSystemPluginId('')
    setInstallProgress(null)
    setPendingConnectorAuth(null)
  }

  function openEditModal(server) {
    if (!server) return
    const nextForm = configToForm(server?.config || {}, server?.name || '')
    setForm(nextForm)
    setFormError('')
    setShowAdvancedFields(Boolean(
      nextForm.envText?.trim()
        || nextForm.cwd?.trim()
        || nextForm.headersText?.trim()
        || nextForm.connectionTimeoutMs?.trim(),
    ))
    setModalMode('edit')
    clearError()
    setMessage('')
  }

  async function saveServer() {
    if (saving) return
    if (!activeProfile) {
      showError('组织管理员尚未为该工作区创建 Uniopc 引擎 profile。')
      return
    }
    const name = form.name.trim()
    if (!name) {
      setFormError('请填写 MCP server 名称。')
      return
    }
    let config
    try {
      config = buildMcpConfigFromForm(form)
    } catch (err) {
      setFormError(String(err?.message || err || 'MCP 配置格式无效'))
      return
    }

    setSaving(true)
    setFormError('')
    clearError()
    setMessage('')
    try {
      const snapshot = await engineClient.plugins.setMcpServer({
        req: { profile: activeProfile, name, config },
      })
      const nextServers = Array.isArray(snapshot?.servers) ? snapshot.servers : []
      setServers(nextServers)
      setSelectedName(name)
      setActiveTab('mine')
      setModalMode('')
      setMessage(modalMode === 'edit' ? `已更新 ${name}` : `已添加 ${name}`)
    } catch (err) {
      const detail = String(err?.message || err || '保存 MCP server 失败')
      setFormError(detail)
      showError(detail, saveServer)
    } finally {
      setSaving(false)
    }
  }

  async function deleteServer(server) {
    if (!server || saving) return
    if (!activeProfile) {
      showError('组织管理员尚未为该工作区创建 Uniopc 引擎 profile。')
      return
    }
    if (confirmDeleteName !== server.name) {
      setConfirmDeleteName(server.name)
      return
    }
    setSaving(true)
    clearError()
    setMessage('')
    try {
      const snapshot = await engineClient.plugins.unsetMcpServer({
        req: { profile: activeProfile, name: server.name },
      })
      const nextServers = Array.isArray(snapshot?.servers) ? snapshot.servers : []
      setServers(nextServers)
      setSelectedName(nextServers[0]?.name || '')
      setConfirmDeleteName('')
      setMessage(`已删除 ${server.name}`)
    } catch (err) {
      showError(String(err || '删除 MCP server 失败'), () => deleteServer(server))
    } finally {
      setSaving(false)
    }
  }

  const createActionLabel = hubMode === 'mcp' ? 'MCP' : '插件'

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-col gap-2 px-5 pb-2 pt-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center">
          <div className="inline-flex rounded-lg border border-subtle bg-surface-overlay p-1">
            {HUB_MODE_TABS.map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => switchHubMode(tab.id)}
                className={`h-7 rounded-md px-3 text-sm font-medium transition-colors ${
                  hubMode === tab.id
                    ? 'bg-surface-raised text-primary shadow-sm'
                    : 'text-tertiary hover:text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-start gap-2 md:max-w-[560px] md:justify-end">
          {canManageMcpServers && (
            <>
              <button
                type="button"
                onClick={openCreateModal}
                disabled={saving || !activeProfile}
                className={`${ACTION.primary} whitespace-nowrap`}
              >
                <span className="mr-1 text-base leading-none">+</span>
                <span>{createActionLabel}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  loadCloudPluginCatalog()
                  loadOrganizationPluginEntitlements()
                  loadServers()
                  loadSupportedPlugins()
                  refreshProfilePluginStatusFromLocal()
                }}
                disabled={loading || loadingCloudPluginCatalog || loadingProfilePlugins || saving || connectionLoading}
                className={ACTION.icon}
                title={loading || loadingCloudPluginCatalog || loadingProfilePlugins || connectionLoading ? '刷新中' : '刷新'}
              >
                <svg className={`h-4 w-4 ${loading || loadingCloudPluginCatalog || loadingProfilePlugins || connectionLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8.1 8.1 0 00-15.5-2M4 5v4h4m-4 4a8.1 8.1 0 0015.5 2M20 19v-4h-4" />
                </svg>
                <span className="sr-only">{loading || loadingCloudPluginCatalog || loadingProfilePlugins || connectionLoading ? '刷新中' : '刷新'}</span>
              </button>
            </>
          )}
        </div>
      </div>

      <AsyncActionState
        state={error && errorRetry ? 'error' : null}
        title="操作失败"
        detail={error}
        onRetry={errorRetry || undefined}
        className="mx-5 mb-3"
      >
        <div className="mx-5 mb-3 empty:hidden">
          <MessageBar
            message={error && !errorRetry ? error : ''}
            tone="error"
            onDismiss={clearError}
          />
        </div>
        {!error && message ? (
          <div className="mx-5 mb-3 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-500">
            {message}
          </div>
        ) : null}
      </AsyncActionState>

      <div className="flex flex-wrap gap-1 border-b border-subtle px-5">
        {visibleTabs
          // 计数为 0 的可选 tab（第三方/自定义）不显示 —— 空 tab 只是占位噪音。
          // 例外：官方/已安装始终在；正停在某个空 tab 上时也不隐藏它，
          // 否则当前选中项会凭空消失。
          .filter(tab => {
            if (!PLUGIN_TAB_IDS.has(tab.id)) return true
            if (tab.id === 'official' || tab.id === 'installed') return true
            if (activeTab === tab.id) return true
            return (pluginTabCounts[tab.id] || 0) > 0
          })
          .map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`relative h-8 px-3 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-accent-text'
                : 'text-tertiary hover:text-primary'
            }`}
          >
            {tab.label}{PLUGIN_TAB_IDS.has(tab.id) ? `（${pluginTabCountLabel(pluginTabCounts[tab.id], cloudPluginCatalogResolved)}）` : ''}
            {tab.id === 'mine' && servers.length > 0 && (
              <span className="ml-2 rounded-full bg-surface-overlay px-2 py-0.5 text-xs text-tertiary">
                {servers.length}
              </span>
            )}
            {activeTab === tab.id && (
              <span className="absolute inset-x-2 bottom-[-1px] h-0.5 rounded-full bg-brand" />
            )}
          </button>
        ))}
      </div>

      {PLUGIN_TAB_IDS.has(activeTab) && (
        <section className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <input
                value={pluginQuery}
                onChange={event => setPluginQuery(event.target.value)}
                placeholder="搜索插件..."
                className="h-9 w-full rounded-lg border border-subtle bg-surface-overlay px-3 text-sm text-primary outline-none placeholder:text-tertiary focus:border-violet-400/40 lg:w-[280px]"
              />
              {pluginQuery.trim() && (
                <span className={`shrink-0 text-xs ${TEXT.secondary}`}>
                  找到 {visiblePluginList.length} 个插件
                </span>
              )}
            </div>
            {/* 加载态原来是一条通栏的品牌紫 banner，比页面上任何真实内容都抢眼 ——
                「正在读取」是过程，不是结果，不该有这个视觉权重。
                降级为一行安静的说明文字。 */}
            {(loadingCloudPluginCatalog || loadingOrganizationEntitlements || loadingProfilePlugins) && (
              <div className={`flex items-center gap-2 px-1 text-sm ${TEXT.muted}`}>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border border-brand/60 border-t-transparent" />
                正在读取插件状态
              </div>
            )}
            <AsyncActionState
              state={cloudPluginCatalogError ? 'error' : null}
              title="插件目录刷新失败"
              detail={cloudPluginCatalogError?.message || ''}
              onRetry={cloudPluginCatalogError?.retryable ? loadCloudPluginCatalog : undefined}
            />
            <AsyncActionState
              state={profilePluginStatusError ? 'error' : null}
              title="插件状态刷新失败"
              detail={profilePluginStatusError}
              onRetry={refreshProfilePluginStatusFromLocal}
            />
            {pluginQuery.trim() && visiblePluginList.length === 0 && (
              <div className="rounded-xl border border-dashed border-subtle bg-surface-overlay px-4 py-8 text-center text-sm text-tertiary">
                未找到匹配的插件。换个关键词，或
                <button type="button" onClick={() => setPluginQuery('')} className="text-violet-500 hover:underline">清除搜索</button>
                查看全部插件。
              </div>
            )}
            {featuredSectionVisible && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-primary">精选</span>
                  <span className={`text-xs ${TEXT.secondary}`}>{featuredPlugins.length}</span>
                </div>
                <PluginCatalogGrid
                  plugins={featuredPlugins}
                  renderPlugin={preset => (
                    <SystemPluginCard
                      key={preset.id}
                      preset={preset}
                      saving={saving || isPluginActionBusy(preset.id, pluginActionId)}
                      onDetails={openSystemPluginDetails}
                    />
                  )}
                />
              </div>
            )}
            {activeTab === 'official' ? (
              // Group official plugins by scene taxonomy; skip empty scenes,
              // `other` renders last (SCENE_CATEGORIES order).
              SCENE_CATEGORIES.map(scene => {
                // 精选区展示时要把已精选的排除掉，否则同一个插件会在
                // 「精选」和它的场景分组里各出现一次（文档处理就这么重复的）。
                const sceneGroup = visiblePluginList.filter(preset => (
                  presetSceneCategory(preset) === scene.slug
                  && !(featuredSectionVisible && featuredIds.has(preset.id))
                ))
                if (sceneGroup.length === 0) return null
                return (
                  <div key={scene.slug} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-primary">{scene.label}</span>
                      <span className={`text-xs ${TEXT.secondary}`}>{sceneGroup.length}</span>
                    </div>
                    <PluginCatalogGrid
                      plugins={sceneGroup}
                      renderPlugin={preset => (
                        <SystemPluginCard
                          key={preset.id}
                          preset={preset}
                          saving={saving || isPluginActionBusy(preset.id, pluginActionId)}
                          onDetails={openSystemPluginDetails}
                        />
                      )}
                    />
                  </div>
                )
              })
            ) : pluginQuery.trim() && visiblePluginList.length === 0 ? null : (
              <PluginCatalogGrid
                plugins={visiblePluginList}
                renderPlugin={preset => (
                  activeTab === 'installed' ? (
                    <SystemPluginCard
                      key={preset.id}
                      preset={preset}
                      saving={saving || isPluginActionBusy(preset.id, pluginActionId)}
                      onDetails={openSystemPluginDetails}
                    />
                  ) : activeTab === 'third-party' ? (
                    <SystemPluginCard
                      key={preset.id}
                      preset={preset}
                      saving={saving || isPluginActionBusy(preset.id, pluginActionId)}
                      onDetails={openSystemPluginDetails}
                    />
                  ) : (
                    <MarketplaceCard
                      key={preset.id}
                      title={preset.title}
                      provider={preset.provider}
                      description={preset.description}
                      actionLabel="状态"
                      onAction={() => {
                        setMessage(`${preset.title} 来自当前 Uniopc 引擎 profile/gateway。`)
                      }}
                      disabled={saving}
                      iconKind="plugin"
                      iconLabel={preset.id}
                      status={preset.statusBadge || pluginCardStatusBadge(preset.readiness || {}, preset.pricing)}
                    />
                  )
                )}
              />
            )}
          </div>
        </section>
      )}

      {activeTab === 'mine' && (
        <section className={`${SURFACE.panel} overflow-hidden`}>
          <div className="border-b border-subtle px-5 py-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-primary">已配置 MCP</h3>
                <p className={`mt-1 text-sm ${TEXT.secondary}`}>
                  {servers.length} 个已配置 server
                </p>
              </div>
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索 MCP server..."
                className="h-10 w-full rounded-lg border border-subtle bg-surface-overlay px-3 text-sm text-primary outline-none placeholder:text-tertiary focus:border-violet-400/40 lg:w-[280px]"
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {FILTERS.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  className={`h-8 rounded-full border px-3 text-xs font-medium transition-colors ${
                    filter === item.id
                      ? 'border-violet-400/30 bg-violet-400/12 text-violet-500'
                      : 'border-subtle bg-surface-overlay text-secondary hover:border-violet-400/20 hover:text-violet-500'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-[calc(100vh-315px)] min-h-[430px] overflow-y-auto p-5">
            {loading ? (
              <div className="flex h-72 items-center justify-center text-sm text-tertiary">正在读取 MCP servers</div>
            ) : servers.length === 0 ? (
              <div className="flex h-72 flex-col items-center justify-center text-center">
                <div className="text-lg font-semibold text-primary">还没有已配置 MCP</div>
                <p className="mt-2 max-w-md text-sm leading-6 text-tertiary">
                  当前 profile 还没有安装 MCP server。请先在 Uniopc 引擎 profile 中安装第三方 MCP server，然后刷新。
                </p>
              </div>
            ) : filteredServers.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-sm text-tertiary">没有匹配的 MCP server</div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {filteredServers.map(server => (
                  <div
                    key={server.name}
                    className={`flex min-h-[230px] flex-col rounded-xl border p-4 text-left transition-all ${
                      selectedName === server.name
                        ? 'border-violet-400/40 bg-violet-400/[0.08]'
                        : 'border-subtle bg-surface-overlay hover:border-violet-400/20 hover:bg-surface-raised'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedName(server.name)
                        setConfirmDeleteName('')
                      }}
                      className="block w-full text-left"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-primary">{server.name}</div>
                          <p className="mt-2 min-h-[48px] line-clamp-2 text-sm leading-6 text-tertiary">{server.summary || '没有摘要'}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="rounded-full border border-violet-400/20 bg-violet-400/10 px-2.5 py-1 text-xs font-medium text-violet-500">
                            {transportLabel(server.transport)}
                          </span>
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation()
                              setSelectedName(server.name)
                              setConfirmDeleteName('')
                              openEditModal(server)
                            }}
                            disabled={saving}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-subtle bg-surface-raised text-tertiary transition-colors hover:text-violet-500"
                            title="编辑"
                            aria-label={`编辑 ${server.name}`}
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 7.125L16.875 4.5M18 14v5.25A2.25 2.25 0 0115.75 21h-11A2.25 2.25 0 012.5 18.75v-11A2.25 2.25 0 014.75 5.5H10" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </button>
                    <div className="mt-4 flex items-center justify-between gap-3">
                      <span className="rounded-full border border-subtle bg-surface-raised px-2.5 py-1 text-xs text-secondary">
                        profile:{activeProfile}
                      </span>
                      <span className={`text-xs font-medium ${server.hasSecrets ? 'text-amber-500' : 'text-tertiary'}`}>
                        {server.hasSecrets ? '含密钥' : '无密钥'}
                      </span>
                    </div>
                    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-subtle pt-3">
                      <div className="text-xs leading-5 text-tertiary">
                        {confirmDeleteName === server.name ? '再次点击确认删除。' : '编辑可查看完整配置。'}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedName(server.name)
                          deleteServer(server)
                        }}
                        disabled={saving || !activeProfile}
                        className={confirmDeleteName === server.name ? ACTION.danger : ACTION.secondary}
                      >
                        {confirmDeleteName === server.name ? '确认删除' : '删除'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <Modal
        open={Boolean(marketDetailModal)}
        onClose={closeMarketDetailModal}
        title={selectedSystemPlugin?.title || '插件'}
        description={selectedSystemPlugin?.provider ? `由 ${selectedSystemPlugin.provider} 提供` : '托管插件'}
        size="xl"
        bodyClassName="space-y-4"
        footer={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            {selectedSystemPlugin
              && selectedSystemPluginLifecycle?.canUninstall
              && (
              <button
                type="button"
                onClick={() => uninstallSystemPlugin(selectedSystemPlugin)}
                disabled={Boolean(pluginActionId) || !activeProfile}
                className={ACTION.secondary}
              >
                {pluginActionId === `${selectedSystemPlugin.id}:uninstall`
                  ? '卸载中...'
                  : selectedSystemPluginLifecycle.uninstallLabel}
              </button>
            )}
            {selectedSystemPlugin?.updateAvailable && (
              <button
                type="button"
                onClick={() => updateSystemPlugin(selectedSystemPlugin)}
                disabled={Boolean(pluginActionId) || !activeProfile}
                className={ACTION.secondary}
              >
                {pluginActionId === `${selectedSystemPlugin.id}:update`
                  ? '更新中...'
                  : `更新到 v${selectedSystemPlugin.latestVersion || '最新'}`}
              </button>
            )}
            {selectedSystemPlugin
              && selectedSystemPluginLifecycle?.secondaryAction
              && (
              <button
                type="button"
                onClick={() => runSystemPluginSecondaryAction(selectedSystemPlugin)}
                disabled={Boolean(pluginActionId) || selectedSystemPluginLifecycle?.disabled}
                className={ACTION.secondary}
              >
                {pluginActionId === `${selectedSystemPlugin.id}:${selectedSystemPluginLifecycle.secondaryAction}`
                  ? (selectedSystemPluginLifecycle.secondaryBusyLabel || '处理中...')
                  : selectedSystemPluginLifecycle.secondaryLabel}
              </button>
            )}
            {selectedSystemPlugin
              && (
              <button
                type="button"
                onClick={() => runSystemPluginPrimaryAction(selectedSystemPlugin)}
                disabled={
                  Boolean(pluginActionId)
                  || selectedSystemPluginLifecycle?.disabled
                  || (selectedSystemPluginLifecycle?.primaryAction === 'open_management' && !profileWorkspace)
                }
                className={ACTION.primary}
              >
                {pluginActionId === selectedSystemPlugin.id
                  ? selectedSystemPluginLifecycle?.busyLabel || '处理中...'
                  : selectedSystemPluginLifecycle?.primaryLabel || '配置并启用'}
              </button>
            )}
          </div>
        )}
      >
        {selectedSystemPlugin ? (
          <div className="space-y-5">
            <div className="flex flex-col items-center text-center">
              <div className="text-2xl font-semibold text-primary">
                连接 {selectedSystemPlugin.title}
              </div>
              <div className={`mt-3 text-sm font-medium ${
                pluginEntitlementStatus(selectedSystemPlugin, organizationPluginEntitlements).state === 'active'
                  ? 'text-emerald-500'
                  : 'text-amber-500'
              }`}>
                {pluginEntitlementStatus(selectedSystemPlugin, organizationPluginEntitlements).state === 'active'
                  ? pluginEntitlementStatus(selectedSystemPlugin, organizationPluginEntitlements).label
                  : selectedSystemPlugin.pricing === 'paid'
                    ? '付费插件 · 请联系管理员开通'
                    : '没有权限'}
              </div>
              {(selectedPluginSkills.length > 0 || selectedPluginConnectors.length > 0 || selectedSystemPlugin.latestVersion || selectedSystemPlugin.observedVersion) && (
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  {selectedPluginSkills.length > 0 && (
                    <span className="rounded-full border border-subtle bg-surface-overlay px-2.5 py-0.5 text-xs text-secondary">
                      技能 {selectedPluginSkills.length}
                    </span>
                  )}
                  {selectedPluginConnectors.length > 0 && (
                    <span className="rounded-full border border-subtle bg-surface-overlay px-2.5 py-0.5 text-xs text-secondary">
                      应用授权 {selectedPluginConnectors.length}
                    </span>
                  )}
                  {/* 已装 = 本地 manifest 版本(installedVersion,事实源),
                      云端观测 observedVersion 兜底;最新 = 云端 published。
                      不一致时各出一枚,最新高亮呼应"更新到 vX"主按钮。 */}
                  {(() => {
                    const currentVersion = selectedSystemPlugin.installedVersion || selectedSystemPlugin.observedVersion
                    return (
                      <>
                        {currentVersion && (
                          <span className="rounded-full border border-subtle bg-surface-overlay px-2.5 py-0.5 text-xs text-secondary">
                            已装 v{currentVersion}
                          </span>
                        )}
                        {selectedSystemPlugin.latestVersion && selectedSystemPlugin.latestVersion !== currentVersion && (
                          <span className={currentVersion
                            ? 'rounded-full border border-brand/40 bg-brand/10 px-2.5 py-0.5 text-xs text-brand'
                            : 'rounded-full border border-subtle bg-surface-overlay px-2.5 py-0.5 text-xs text-secondary'}>
                            最新 v{selectedSystemPlugin.latestVersion}
                          </span>
                        )}
                      </>
                    )
                  })()}
                </div>
              )}
            </div>

            {selectedSystemPlugin.updateAvailable && selectedPluginReleaseNotes && (
              <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/8 px-4 py-3">
                <div className="text-xs font-semibold text-emerald-600">
                  更新说明 · v{selectedSystemPlugin.latestVersion}
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-secondary">
                  {selectedPluginReleaseNotes}
                </div>
              </div>
            )}

            {installProgress?.pluginId === selectedSystemPlugin.id && installProgress.steps.length > 0 && (
              <div className="rounded-xl border border-subtle bg-surface-raised px-4 py-3">
                <div className="space-y-3.5">
                  {INSTALL_PHASES.map(phase => {
                    const phaseSteps = installProgress.steps.filter(step => (step.group || 'init') === phase.id)
                    if (phaseSteps.length === 0) return null
                    return (
                      <div key={phase.id}>
                        <div className="mb-2 text-xs font-semibold text-secondary">{phase.label}</div>
                        <div className="space-y-2.5 pl-1">
                          {phaseSteps.map(step => (
                            <div key={step.label} className="flex items-start gap-2.5">
                              {step.status === 'running' && (
                                <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" aria-label="进行中" />
                              )}
                              {step.status === 'done' && (
                                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-2xs font-bold text-white" aria-label="完成">✓</span>
                              )}
                              {step.status === 'failed' && (
                                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-500 text-2xs font-bold text-white" aria-label="失败">✕</span>
                              )}
                              {step.status === 'waiting' && (
                                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-default text-2xs text-tertiary" aria-label="待授权">🔒</span>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className={`text-sm ${step.status === 'failed' ? 'text-red-500' : step.status === 'waiting' ? 'text-tertiary' : 'text-primary'}`}>{step.label}</div>
                                {step.status === 'failed' && step.error && (() => {
                                  const attribution = attributeInstallFailure(step.label, step.error)
                                  return (
                                    <div className="mt-1.5 rounded-lg border border-red-400/20 bg-red-500/5 px-2.5 py-2">
                                      <div className="text-xs font-medium leading-5 text-red-500">{attribution.title}</div>
                                      <div className="mt-0.5 text-xs leading-5 text-secondary">{attribution.detail}</div>
                                      <div className="mt-0.5 text-xs leading-5 text-secondary">建议：{attribution.action}</div>
                                      <div className="mt-1 break-words text-2xs leading-4 text-tertiary">{step.error}</div>
                                      <button
                                        type="button"
                                        onClick={() => continueSystemPluginSetup(selectedSystemPlugin)}
                                        disabled={Boolean(pluginActionId)}
                                        className="mt-1.5 rounded-md border border-red-400/30 px-2 py-0.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        重试
                                      </button>
                                    </div>
                                  )
                                })()}
                              </div>
                            </div>
                          ))}
                          {phase.id === 'auth' && pendingConnectorAuth?.pluginId === selectedSystemPlugin.id && (
                            <ConnectorAuthForm
                              connector={pendingConnectorAuth.connector}
                              busy={Boolean(pluginActionId)}
                              values={pendingConnectorAuth.values || {}}
                              onValuesChange={values => setPendingConnectorAuth(current => (
                                current ? { ...current, values } : current
                              ))}
                              onSubmit={finishConnectorAuth}
                              onSkip={pendingConnectorAuth.connector?.canSkipBlocking ? skipConnectorAuth : undefined}
                            />
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <DetailSection title="插件能力">
              <div>{selectedSystemPlugin.description}</div>
              <div className="mt-3">
                <PillList items={selectedSystemPlugin.tags || []} />
              </div>
            </DetailSection>
            {(selectedPluginSkills.length > 0 || selectedPluginConnectors.length > 0) && (
              <DetailSection title="包含">
                <div className="space-y-2">
                  {selectedPluginSkills.map((skill, index) => (
                    <div key={skill.id || skill.name || `skill-${index}`} className="rounded-lg border border-subtle bg-surface-raised px-3 py-2">
                      <div className="text-sm font-medium text-secondary">
                        {skill.displayName || skill.id || skill.name || `技能 ${index + 1}`}
                        <span className="ml-2 text-xs text-tertiary">技能</span>
                      </div>
                      {skill.description && (
                        <div className="mt-0.5 text-xs leading-5 text-tertiary">{skill.description}</div>
                      )}
                    </div>
                  ))}
                  {selectedPluginConnectors.map(connector => {
                    const oauthKey = `${selectedSystemPlugin.id}:${connector.id}`
                    const oauthState = connectorOauth[oauthKey] || {}
                    return (
                      <div key={connector.id} className="rounded-lg border border-subtle bg-surface-raised px-3 py-2">
                        <div className="text-sm font-medium text-secondary">
                          {connector.name || connector.id}
                          <span className="ml-2 text-xs text-tertiary">
                            {connector.authType === 'api-key' ? 'API Key 授权' : connector.authType === 'oauth2' ? 'OAuth 授权' : '应用授权'}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs leading-5 text-tertiary">
                          {connector.blocking ? '使用前需连接账号' : '可稍后连接账号'}
                        </div>
                        {connector.authType === 'api-key' && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <span className={`text-xs font-medium ${connector.credentialState === 'configured' ? 'text-emerald-500' : 'text-amber-500'}`}>
                              {connector.credentialState === 'configured'
                                ? '凭据已保存'
                                : connector.credentialState === 'partially_configured'
                                  ? '凭据未填完整'
                                  : '待填写凭据'}
                            </span>
                            {connector.credentialState === 'configured' && (
                              <button
                                type="button"
                                onClick={() => reconfigureApiKeyConnector(selectedSystemPlugin, connector)}
                                disabled={Boolean(pluginActionId)}
                                className="rounded-md border border-subtle px-2 py-0.5 text-xs text-secondary transition-colors hover:border-violet-400/40 hover:text-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                修改凭据
                              </button>
                            )}
                          </div>
                        )}
                        {connector.authType === 'oauth2' && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            {oauthState.status === 'connected' ? (
                              <>
                                <span className="text-xs font-medium text-emerald-500">
                                  已连接{oauthState.accountLabel ? ` · ${oauthState.accountLabel}` : ''}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => disconnectOauthConnector(selectedSystemPlugin, connector)}
                                  disabled={Boolean(oauthState.busy)}
                                  className="rounded-md border border-subtle px-2 py-0.5 text-xs text-secondary transition-colors hover:border-rose-400/40 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {oauthState.busy ? '断开中…' : '断开'}
                                </button>
                              </>
                            ) : oauthState.status === 'preparing' || oauthState.status === 'authorizing' ? (
                              <>
                                <span className="flex items-center gap-1.5 text-xs text-violet-500">
                                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
                                  {oauthState.status === 'preparing' ? '正在准备授权页面…' : '请在浏览器中完成授权…'}
                                </span>
                                {oauthState.authorizeUrl && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      navigator.clipboard?.writeText(oauthState.authorizeUrl)
                                      setMessage('授权链接已复制，可粘贴到浏览器手动打开。')
                                    }}
                                    className="text-xs text-violet-500 hover:underline"
                                  >
                                    页面没自动打开？复制链接手动打开
                                  </button>
                                )}
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => connectOauthConnector(selectedSystemPlugin, connector)}
                                disabled={Boolean(oauthState.busy)}
                                className="rounded-md border border-violet-400/30 bg-violet-400/10 px-2.5 py-0.5 text-xs font-medium text-violet-500 transition-colors hover:bg-violet-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {oauthState.status === 'error' ? '重新连接' : '连接账号'}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </DetailSection>
            )}
            <DetailSection title="当前状态">
              <div className="grid gap-2 sm:grid-cols-2">
                {(selectedSystemPlugin.statusItems || []).map(item => (
                  <div key={`${item.label}:${item.value || ''}`} className="rounded-lg border border-subtle bg-surface-raised px-3 py-2">
                    <div className="text-xs text-tertiary">{item.label}</div>
                    <div className="mt-1 text-sm font-medium text-secondary">{item.value || '已识别'}</div>
                  </div>
                ))}
                <div className="rounded-lg border border-subtle bg-surface-raised px-3 py-2">
                  <div className="text-xs text-tertiary">Profile</div>
                  <div className="mt-1 truncate text-sm font-medium text-secondary">{activeProfile || '未创建'}</div>
                </div>
                <div className="rounded-lg border border-subtle bg-surface-raised px-3 py-2">
                  <div className="text-xs text-tertiary">Gateway 连接</div>
                  <div className={`mt-1 text-sm font-medium ${gatewayConnected ? 'text-emerald-500' : 'text-amber-500'}`}>
                    {gatewayConnected ? '已连接' : '未连接'}
                  </div>
                </div>
              </div>
            </DetailSection>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(pendingPluginReview)}
        onClose={cancelPluginCapabilityReview}
        title={`确认 ${pendingPluginReview?.preset?.title || '插件'} 的能力`}
        description="Uniopc 已校验本次下载制品的 SHA-256。确认后才会把这些能力写入 Uniopc 本地服务的能力确认记录。"
        size="2xl"
        bodyClassName="space-y-4"
        footer={(
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={cancelPluginCapabilityReview} className={ACTION.secondary}>取消</button>
            <button type="button" onClick={confirmPluginCapabilityReview} className={ACTION.primary}>确认并安装</button>
          </div>
        )}
      >
        <div className="rounded-xl border border-subtle bg-surface-raised p-4 text-sm text-secondary">
          <div className="font-medium">来源：Uniopc 官方分发</div>
          <div className="mt-1 text-xs text-tertiary">版本 {pendingPluginReview?.review?.version || '未声明'} · 制品 {String(pendingPluginReview?.review?.artifactSha256 || '').slice(0, 16)}…</div>
          <div className="mt-1 text-xs text-tertiary">本地服务兼容要求 {pendingPluginReview?.review?.pluginApiRequirement} · 当前版本 {pendingPluginReview?.review?.hostVersion}</div>
        </div>
        <div className="space-y-3">
          {[
            ['工具', pendingPluginReview?.review?.capabilitySurface?.tools],
            ['插件契约', pendingPluginReview?.review?.capabilitySurface?.contracts],
            ['MCP 服务', pendingPluginReview?.review?.capabilitySurface?.mcpServers],
            ['Hook', pendingPluginReview?.review?.capabilitySurface?.hooks],
            ['Skills', pendingPluginReview?.review?.capabilitySurface?.skills],
            ['CLI 命令', pendingPluginReview?.review?.capabilitySurface?.cliCommands],
            ['危险配置', pendingPluginReview?.review?.capabilitySurface?.dangerousConfigFlags],
          ].filter(([, values]) => Array.isArray(values) && values.length > 0).map(([label, values]) => (
            <div key={label} className="rounded-xl border border-subtle p-3">
              <div className="text-sm font-medium text-secondary">{label}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">{values.map(value => <span key={value} className="rounded-md bg-violet-400/10 px-2 py-1 font-mono text-xs text-violet-600 dark:text-violet-300">{value}</span>)}</div>
            </div>
          ))}
          {pendingPluginReview?.review?.capabilitySurface && Object.values(pendingPluginReview.review.capabilitySurface).every(values => !Array.isArray(values) || values.length === 0) && (
            <div className="rounded-xl border border-subtle p-3 text-sm text-tertiary">该插件未声明额外的本地服务能力。</div>
          )}
        </div>
      </Modal>

      <Modal
        open={Boolean(modalMode)}
        onClose={() => !saving && setModalMode('')}
        title={modalMode === 'edit' ? `编辑 ${form.name}` : '添加 MCP server'}
        description="配置会保存到当前 Uniopc 引擎 profile 的 mcp.servers。"
        size="2xl"
        bodyClassName="space-y-4"
        footer={(
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setModalMode('')} disabled={saving} className={ACTION.secondary}>
              取消
            </button>
            <button type="button" onClick={saveServer} disabled={saving || !activeProfile} className={ACTION.primary}>
              {saving ? '保存中' : '保存'}
            </button>
          </div>
        )}
      >
        <>
        {formError && (
          <div className="rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2.5 text-sm leading-5 text-danger-text" role="alert">
            <div className="font-medium">请检查 MCP 配置</div>
            <div className="mt-0.5">{formError}</div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="名称" hint="可使用字母、数字、-、_、.、@、/。">
            <input
              value={form.name}
              onChange={event => {
                setForm(prev => ({ ...prev, name: event.target.value }))
                setFormError('')
              }}
              disabled={modalMode === 'edit'}
              className={SURFACE.input}
              placeholder="context7"
            />
          </Field>
          <Field label="Transport">
            <select
              value={form.transport}
              onChange={event => setForm(prev => ({ ...prev, transport: event.target.value }))}
              className={SURFACE.select}
            >
              {MCP_TRANSPORTS.map(item => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </Field>
        </div>

        {form.transport === 'stdio' ? (
          <div className="space-y-4">
            <Field label="Command">
              <input
                value={form.command}
                onChange={event => {
                  setForm(prev => ({ ...prev, command: event.target.value }))
                  setFormError('')
                }}
                className={SURFACE.input}
                placeholder="uvx"
              />
            </Field>
            <Field label="Args" hint="每行一个参数。">
              <textarea
                value={form.argsText}
                onChange={event => setForm(prev => ({ ...prev, argsText: event.target.value }))}
                rows={4}
                className={SURFACE.textarea}
                placeholder="context7-mcp"
              />
            </Field>
            <div className="rounded-xl border border-subtle bg-surface-overlay">
              <button
                type="button"
                onClick={() => setShowAdvancedFields(prev => !prev)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium text-secondary transition-colors hover:text-primary"
              >
                <span>高级配置</span>
                <span className="text-xs text-tertiary">
                  {showAdvancedFields ? '收起' : 'Env / Working directory'}
                </span>
              </button>
              {showAdvancedFields && (
                <div className="space-y-4 border-t border-subtle p-4">
                  <KeyValueRowsEditor
                    label="Env"
                    hint="Name 会保存为环境变量名；Value 为空的行不会写入配置。"
                    value={form.envText}
                    onChange={nextValue => setForm(prev => ({ ...prev, envText: nextValue }))}
                    valuePlaceholder="粘贴 Value"
                  />
                  <Field label="Working directory" hint="仅当 command 依赖特定目录时填写。">
                    <input
                      value={form.cwd}
                      onChange={event => setForm(prev => ({ ...prev, cwd: event.target.value }))}
                      className={`${SURFACE.input} max-w-[560px]`}
                      placeholder="可留空"
                    />
                  </Field>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="URL">
              <input
                value={form.url}
                onChange={event => {
                  setForm(prev => ({ ...prev, url: event.target.value }))
                  setFormError('')
                }}
                className={SURFACE.input}
                placeholder="https://mcp.example.com"
              />
            </Field>
            <div className="rounded-xl border border-subtle bg-surface-overlay">
              <button
                type="button"
                onClick={() => setShowAdvancedFields(prev => !prev)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium text-secondary transition-colors hover:text-primary"
              >
                <span>高级配置</span>
                <span className="text-xs text-tertiary">
                  {showAdvancedFields ? '收起' : 'Headers / Timeout'}
                </span>
              </button>
              {showAdvancedFields && (
                <div className="space-y-4 border-t border-subtle p-4">
                  <KeyValueRowsEditor
                    label="Headers"
                    hint="Name 会保存为 HTTP Header 名；Value 为空的行不会写入配置。"
                    value={form.headersText}
                    onChange={nextValue => setForm(prev => ({ ...prev, headersText: nextValue }))}
                    defaultNames={[]}
                    valuePlaceholder="粘贴 Value"
                  />
                  <Field label="Timeout" hint="单位是毫秒；慢查询或远程服务可以适当调高。">
                    <input
                      value={form.connectionTimeoutMs}
                      onChange={event => setForm(prev => ({ ...prev, connectionTimeoutMs: event.target.value }))}
                      className={`${SURFACE.input} max-w-[320px]`}
                      placeholder="10000"
                    />
                  </Field>
                </div>
              )}
            </div>
          </div>
        )}
          </>
      </Modal>
    </div>
  )
}
