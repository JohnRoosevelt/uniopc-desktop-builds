const FOUNDATION_PLUGIN_IDS = new Set(['uniopc-cloud-workspace'])
const BUNDLED_LOCAL_WORKSPACE_PRESET = {
  id: 'uniopc-local-workspace',
  title: '本地工作区',
  description: '让 AI 员工在当前桌面 profile 内读取和编辑本地文档。',
  tags: ['Plugin', 'Local', 'Workspace'],
  catalogSection: 'official',
  sceneCategory: 'workspace',
  defaultEntitlement: true,
  required: true,
  isGlobal: true,
}
const HIDDEN_STALE_OFFICIAL_PLUGIN_IDS = new Set([
  'imai-short-drama-core',
  'imai-media-generation',
])

function entitlementPluginId(entitlement = {}) {
  return String(entitlement.pluginId || entitlement.plugin_id || entitlement.id || '').trim()
}

function activeEntitlementIds(entitlements) {
  if (!Array.isArray(entitlements)) return null
  return new Set(
    entitlements
      .filter(item => String(item?.status || item?.entitlement_status || 'active') === 'active')
      .map(entitlementPluginId)
      .filter(Boolean),
  )
}

export function entitlementByPluginId(entitlements = []) {
  return new Map(
    (Array.isArray(entitlements) ? entitlements : [])
      .map(item => [entitlementPluginId(item), item])
      .filter(([id]) => Boolean(id)),
  )
}

export function profilePluginById(profilePlugins = []) {
  return new Map(
    (Array.isArray(profilePlugins) ? profilePlugins : [])
      .map(item => [String(item?.id || item?.pluginId || item?.plugin_id || '').trim(), item])
      .filter(([id]) => Boolean(id)),
  )
}

export function pluginEntitlementStatus(plugin = {}, entitlements = []) {
  const id = String(plugin?.id || plugin?.pluginId || plugin?.plugin_id || '').trim()
  const entitlement = entitlementByPluginId(entitlements).get(id)
  const status = String(entitlement?.status || entitlement?.entitlement_status || '').trim()
  const pluginMetadata = plugin?.metadata && typeof plugin.metadata === 'object' ? plugin.metadata : {}
  const entitlementMetadata = entitlement?.metadata && typeof entitlement.metadata === 'object' ? entitlement.metadata : {}
  const defaultEntitlement = plugin?.defaultEntitlement === true ||
    pluginMetadata.default_entitlement === true ||
    pluginMetadata.defaultEntitlement === true ||
    entitlement?.defaultEntitlement === true ||
    entitlementMetadata.default_entitlement === true ||
    entitlementMetadata.defaultEntitlement === true
  if (status === 'active') {
    if (entitlement?.isGlobal) return { state: 'active', label: '全局授权' }
    return { state: 'active', label: defaultEntitlement ? '默认授权' : '已授权' }
  }
  if (status === 'suspended') return { state: 'suspended', label: '权限暂停' }
  if (status === 'revoked') return { state: 'revoked', label: '权限撤销' }
  if (plugin?.isGlobal || plugin?.global) return { state: 'active', label: '全局授权' }
  if (defaultEntitlement || plugin?.required) return { state: 'active', label: '默认授权' }
  return { state: 'missing', label: '没有权限' }
}

// 把 catalog + entitlement 推导成 uniopc-gatekeeper 授权快照的云端状态输入
// (Rust `uniopc_plugin_grants_write` 会与本地已装 manifest 的工具清单合并)。
// v1 只把显式 suspended/revoked 物化为拦截状态:'missing'(从无授权行)按
// active 下发,避免对存量技能包用户产生新的误杀 —— 云插件的最终门仍在云端
// 逐请求 entitlement 复查,本地快照只负责"撤权即断"。
export function buildPluginGrantStatuses(catalogRows = [], entitlements = []) {
  return (Array.isArray(catalogRows) ? catalogRows : [])
    .filter(row => String(row?.id || '').trim().startsWith('uniopc-'))
    .map(row => {
      const { state } = pluginEntitlementStatus(row, entitlements)
      const status = state === 'suspended' || state === 'revoked' ? state : 'active'
      return {
        pluginId: String(row.id).trim(),
        status,
        name: String(row?.title || row?.name || row.id).trim(),
      }
    })
}

// Engine startup noise that leaks into CLI/doctor stderr and would otherwise
// land in the App Center error banner: the packaged runtime's bundled
// imessage/telegram channel entries are broken upstream (missing generated
// module), and the engine's probe chain then complains about their
// package.json (extensions field / hook pack). None of it is actionable for
// Uniopc plugins — strip it so real errors stay readable.
const ENGINE_STARTUP_NOISE_PATTERNS = [
  /\[channels\] failed to load bundled channel setup entry \S+: missing generated module for bundled channel \S+\s*/g,
  /package\.json missing openclaw\.extensions[\s\S]*?missing-openclaw-extensions\s*/g,
  /Also not a valid hook pack: Error: package\.json missing openclaw\.hooks\.?\s*/g,
]

export function stripEngineStartupNoise(message = '') {
  let out = String(message || '')
  for (const pattern of ENGINE_STARTUP_NOISE_PATTERNS) out = out.replace(pattern, ' ')
  return out.replace(/\s{2,}/g, ' ').trim()
}

// Cloud-distributed catalog rows carry both the latest published version
// (metadata.latest_version, injected by list_my_cloud_plugin_catalog) and the
// installed copy's version (assignment observed_version). A mismatch while the
// assignment reports installed means an update is available.
export function pluginUpdateStatus(plugin = {}) {
  const latestVersion = String(plugin?.latestVersion || '').trim()
  // 本地已装 manifest 的 version(Rust 快照)优先于云端观测回报的
  // observed_version —— 后者依赖装机观测上报,老装机常为空/滞后。
  const observedVersion = String(plugin?.installedVersion || plugin?.observedVersion || '').trim()
  // 本地 manifest 有版本 = 实际已装(事实源);云端 observedStatus 兜底。
  const installed = Boolean(String(plugin?.installedVersion || '').trim())
    || String(plugin?.observedStatus || '').trim() === 'installed'
  const updateAvailable = Boolean(installed && latestVersion && observedVersion && observedVersion !== latestVersion)
  return { updateAvailable, latestVersion, observedVersion }
}

// Recall bit (catalog metadata.force_update): the client silently force-updates
// installed copies that lag the latest published version. See
// uniopc-supabase/docs/plugin-system-v2.md §2.
export function pluginForceUpdateRequired(plugin = {}) {
  const metadata = plugin?.metadata && typeof plugin.metadata === 'object' ? plugin.metadata : {}
  const flagged = plugin?.forceUpdate === true || metadata.force_update === true || metadata.forceUpdate === true
  return flagged && pluginUpdateStatus(plugin).updateAvailable
}

// The marketplace artifact id identifies the local OpenClaw package. Its
// runtime id may deliberately point to a shared cloud service and must not
// replace the local lifecycle id.
export function resolveCloudPluginLifecycleIds(plugin = {}) {
  const installPluginId = String(plugin?.id || plugin?.pluginId || plugin?.plugin_id || '').trim()
  const runtimePluginId = String(
    plugin?.runtimePluginId || plugin?.runtime_plugin_id ||
    plugin?.openclawPluginId || plugin?.openclaw_plugin_id || installPluginId,
  ).trim() || installPluginId
  return { installPluginId, runtimePluginId }
}

export function pluginGatewayStatus(plugin = {}, profilePlugins = [], mcpServers = []) {
  const { installPluginId: id } = resolveCloudPluginLifecycleIds(plugin)
  if (plugin?.marketplaceSource === 'clawhub') {
    if (plugin.installState === 'installed_ready') return { state: 'ready', label: plugin.installStatusLabel || '已安装' }
    if (plugin.installState === 'installed_disabled') return { state: 'disabled', label: plugin.installStatusLabel || '已安装未启用' }
    return { state: 'not_installed', label: plugin.installStatusLabel || '可安装' }
  }
  const profilePluginsById = profilePluginById(profilePlugins)
  const profilePlugin = profilePluginsById.get(id)
  if (profilePlugin) {
    return {
      state: profilePlugin.status || (profilePlugin.enabled ? 'ready' : 'disabled'),
      label: profileCapabilityStatusLabel(profilePlugin),
      detail: profilePlugin.pluginPath || profilePlugin.plugin_path || '',
    }
  }
  const requiredMcpServerIds = Array.isArray(plugin?.requiredMcpServerIds) ? plugin.requiredMcpServerIds : []
  const configureMcpPresetIds = Array.isArray(plugin?.configureMcpPresetIds) ? plugin.configureMcpPresetIds : []
  const mcpIds = [...requiredMcpServerIds, ...configureMcpPresetIds].filter(Boolean)
  if (plugin?.connectorAppId || plugin?.mcpTemplateId || mcpIds.length > 0) {
    const installed = mcpIds.length === 0
      ? (Array.isArray(mcpServers) && mcpServers.some(server => String(server?.name || '').includes(String(plugin?.connectorAppId || plugin?.mcpTemplateId || id))))
      : mcpIds.some(name => (Array.isArray(mcpServers) ? mcpServers : []).some(server => server?.name === name))
    return { state: installed ? 'ready' : 'not_configured', label: installed ? 'MCP 已配置' : '待连接账号' }
  }
  if (plugin?.managementRoute || plugin?.defaultProvider === 'official_cloud') {
    return { state: 'cloud_action', label: '待启用' }
  }
  return { state: 'unknown', label: '待检查' }
}

export function buildKnownPluginIds(plugins = []) {
  const ids = new Set()
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    for (const value of [
      plugin?.id,
      plugin?.pluginId,
      plugin?.plugin_id,
      plugin?.runtimePluginId,
      plugin?.runtime_plugin_id,
      plugin?.openclawPluginId,
      plugin?.openclaw_plugin_id,
      ...(Array.isArray(plugin?.aliases) ? plugin.aliases : []),
    ]) {
      const id = String(value || '').trim()
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

export function mergeBuiltInPluginPresets(plugins = []) {
  const rows = Array.isArray(plugins) ? plugins : []
  const localWorkspace = rows.find(plugin => String(plugin?.id || '').trim() === BUNDLED_LOCAL_WORKSPACE_PRESET.id)
  const branded = [
    { ...(localWorkspace || {}), ...BUNDLED_LOCAL_WORKSPACE_PRESET },
    ...rows.filter(plugin => String(plugin?.id || '').trim() !== BUNDLED_LOCAL_WORKSPACE_PRESET.id),
  ]
  const visibleBrand = /(?:OpenClaw|小龙虾)/gi
  const identifierCharacter = /[A-Za-z0-9_]/
  return branded.map(plugin => {
    const result = { ...plugin }
    for (const key of ['title', 'description', 'provider']) {
      if (typeof result[key] === 'string') {
        // Inspect original neighboring characters so older WKWebView engines
        // need no lookbehind, including adjacent Chinese brand occurrences.
        result[key] = result[key].replace(visibleBrand, (match, offset, source) => {
          const before = source[offset - 1] || ''
          const after = source[offset + match.length] || ''
          return identifierCharacter.test(before) || identifierCharacter.test(after) ? match : 'Uniopc'
        })
      }
    }
    return result
  })
}

export function isPluginActionBusy(pluginId, actionId) {
  const id = String(pluginId || '').trim()
  const action = String(actionId || '').trim()
  return Boolean(id && action && (action === id || action.startsWith(`${id}:`)))
}

export function pluginTabCountLabel(count, catalogResolved = true) {
  return catalogResolved ? String(Number(count) || 0) : '…'
}

export function buildCustomPluginPresets(profilePlugins = [], knownPluginIds = []) {
  const known = new Set(knownPluginIds.map(id => String(id || '').trim()).filter(Boolean))
  return (Array.isArray(profilePlugins) ? profilePlugins : [])
    .filter(plugin => {
      const id = String(plugin?.id || plugin?.pluginId || '').trim()
      return id && id !== 'acpx' && !known.has(id) && !HIDDEN_STALE_OFFICIAL_PLUGIN_IDS.has(id)
    })
    .map(plugin => ({
      id: String(plugin.id || plugin.pluginId).trim(),
      title: plugin.title || plugin.id || 'Custom Plugin',
      provider: '自定义',
      description: plugin.description || '当前 Uniopc 引擎 profile/gateway 中发现的自定义插件。',
      tags: ['Plugin', 'Custom', 'Uniopc 引擎'],
      custom: true,
    }))
}

function marketplacePackageFromResult(result = {}) {
  return result?.package || result?.pkg || result
}

function normalizeMarketplaceId(value) {
  return String(value || '').trim()
}

function marketplacePluginIds(plugin = {}) {
  return [
    plugin?.id,
    plugin?.pluginId,
    plugin?.plugin_id,
    plugin?.name,
    plugin?.packageName,
    plugin?.package_name,
    plugin?.runtimeId,
    plugin?.runtime_id,
    plugin?.runtimePluginId,
    plugin?.runtime_plugin_id,
  ].map(normalizeMarketplaceId).filter(Boolean)
}

function findInstalledMarketplacePlugin(pkg = {}, installedPlugins = []) {
  const packageIds = new Set(marketplacePluginIds(pkg))
  return (Array.isArray(installedPlugins) ? installedPlugins : [])
    .find(plugin => marketplacePluginIds(plugin).some(id => packageIds.has(id)))
}

export function openClawMarketplaceInstallState(pkg = {}, installedPlugins = []) {
  const installed = findInstalledMarketplacePlugin(pkg, installedPlugins)
  if (!installed) return { state: 'not_installed', label: '可安装' }
  const status = String(installed?.status || '').trim()
  if (installed?.enabled === false || status === 'disabled') {
    return { state: 'installed_disabled', label: '已安装未启用' }
  }
  return { state: 'installed_ready', label: '已安装' }
}

export function buildOpenClawMarketplacePluginPresets(snapshot = {}, knownPluginIds = []) {
  const known = new Set((Array.isArray(knownPluginIds) ? knownPluginIds : [])
    .map(normalizeMarketplaceId)
    .filter(Boolean))
  const results = Array.isArray(snapshot?.results) ? snapshot.results : []
  const installedPlugins = Array.isArray(snapshot?.installedPlugins) ? snapshot.installedPlugins : []

  return results
    .map(marketplacePackageFromResult)
    .filter(pkg => {
      const ids = marketplacePluginIds(pkg)
      return ids.length > 0 && !ids.some(id => known.has(id))
    })
    .map(pkg => {
      const name = normalizeMarketplaceId(pkg.name || pkg.id)
      const runtimePluginId = normalizeMarketplaceId(pkg.runtimeId || pkg.runtime_id || pkg.runtimePluginId || pkg.runtime_plugin_id || name)
      const installState = openClawMarketplaceInstallState(pkg, installedPlugins)
      const official = pkg.isOfficial === true || pkg.is_official === true || pkg.channel === 'official'
      const owner = normalizeMarketplaceId(pkg.ownerHandle || pkg.owner_handle || pkg.owner || '')
      const tags = [
        official ? 'Official' : normalizeMarketplaceId(pkg.channel || 'Community'),
        ...(Array.isArray(pkg.categories) ? pkg.categories : []),
        ...(Array.isArray(pkg.topics) ? pkg.topics : []),
      ].map(normalizeMarketplaceId).filter(Boolean)
      return {
        id: name || runtimePluginId,
        title: pkg.displayName || pkg.display_name || pkg.title || name || runtimePluginId,
        provider: official ? 'Uniopc 引擎' : owner || 'Uniopc 引擎 Community',
        description: pkg.summary || pkg.description || 'Uniopc 引擎 marketplace 插件。',
        tags: [...new Set(tags)],
        catalogSection: 'third-party',
        marketplaceSource: 'clawhub',
        marketplaceChannel: pkg.channel || '',
        isOpenClawOfficial: official,
        isGlobal: true,
        runtimePluginId,
        installSpec: name || runtimePluginId,
        installCommand: `openclaw plugins install ${name || runtimePluginId}`,
        installState: installState.state,
        installStatusLabel: installState.label,
        actionLabel: installState.state === 'not_installed'
          ? '安装'
          : installState.state === 'installed_disabled'
            ? '状态'
            : '状态',
        latestVersion: pkg.latestVersion || pkg.latest_version || '',
        verificationTier: pkg.verificationTier || pkg.verification_tier || '',
        docsUrl: pkg.url || pkg.homepage || pkg.repositoryUrl || pkg.repository_url || '',
        requiresApiKey: Boolean(pkg.requiresApiKey || pkg.requires_api_key),
      }
    })
}

export function withOpenClawMarketplaceInstallStatus(preset = {}, installedPlugins = []) {
  if (preset?.marketplaceSource !== 'clawhub') return preset
  const installSpec = normalizeMarketplaceId(preset.installSpec || preset.id)
  const pkg = {
    id: preset.id,
    name: installSpec || preset.id,
    runtimeId: preset.runtimePluginId || preset.openclawPluginId || preset.id,
  }
  const installState = openClawMarketplaceInstallState(pkg, installedPlugins)
  return {
    ...preset,
    installState: installState.state,
    installStatusLabel: installState.label,
    actionLabel: installState.state === 'not_installed' ? '安装' : '状态',
  }
}

export function toolPluginDocsActionLabel(plugin = {}) {
  if (plugin?.marketplaceSource === 'clawhub') return '打开 ClawHub'
  return '打开文档'
}

export function toolPluginInstallActionLabel(plugin = {}) {
  if (plugin?.marketplaceSource === 'clawhub' && plugin?.installState === 'not_installed') {
    return '安装到 Uniopc 引擎'
  }
  if (plugin?.marketplaceSource === 'openclaw_builtin') {
    if (plugin?.installKind === 'codex_computer_use') return '初始化'
    if (plugin?.installKind === 'bundled_codex_config') return '启用'
  }
  return ''
}

export function toolPluginInstallDetail(plugin = {}) {
  if (plugin?.marketplaceSource === 'openclaw_builtin') {
    const installHint = normalizeMarketplaceId(plugin.installHint || plugin.metadata?.install_hint)
    const configPath = normalizeMarketplaceId(plugin.configPath || plugin.metadata?.config_path)
    const hintText = installHint ? `可通过 ${installHint} 初始化` : '随 Uniopc 引擎 内置能力提供'
    const configText = configPath ? `；配置路径 ${configPath}` : ''
    return {
      title: '内置配置',
      body: `Uniopc 引擎 内置 Codex 能力，${hintText}${configText}。`,
      mono: false,
    }
  }

  const installCommand = normalizeMarketplaceId(plugin.installCommand)
  return {
    title: '安装命令',
    body: installCommand || '可在 Uniopc 中安装到当前 Uniopc 引擎 Profile。',
    mono: Boolean(installCommand),
  }
}

export function profileCapabilityStatusLabel(plugin = {}) {
  if (plugin.status === 'not_installed') return '未安装'
  if (plugin.status === 'disabled') return '未启用'
  if (plugin.status === 'not_configured') return '待配置'
  if (plugin.status === 'cloud_action') return '待启用'
  if (plugin.status === 'runtime_blocked') return '运行受限'
  if (plugin.status === 'runtime_missing') return '运行缺失'
  if (plugin.status === 'runtime_inspect_failed') return '检查失败'
  if (!plugin?.enabled) return '未开通'
  if (plugin.status === 'ready') return '可用'
  if (plugin.status === 'missing_env') return '待管理员配置'
  if (plugin.status === 'sync_required') return '待同步'
  return '暂不可用'
}

export function profileCapabilityActionLabel(plugin = {}) {
  if (plugin.status === 'missing_env') return '联系管理员'
  return '查看'
}

// API-key connector credentials are managed independently from plugin enable
// state. A configured connector must not send ordinary enable/retry actions
// back through the credential form; an explicit edit action is the only path
// that asks for values again.
export function connectorNeedsCredentialInput(connector = {}, { reconfigure = false } = {}) {
  if (reconfigure) return true
  return String(connector?.credentialState || '').trim() !== 'configured'
}

export function apiKeyCredentialState(connectors = []) {
  const apiKeyConnectors = (Array.isArray(connectors) ? connectors : [])
    .filter(connector => connector?.authType === 'api-key')
  if (apiKeyConnectors.length === 0) return ''
  if (apiKeyConnectors.some(connector => connector?.credentialState === 'unconfigured')) return 'unconfigured'
  if (apiKeyConnectors.some(connector => connector?.credentialState === 'partially_configured')) return 'partially_configured'
  if (apiKeyConnectors.every(connector => connector?.credentialState === 'configured')) return 'configured'
  // Old native snapshots do not contain credentialState. Treat them as
  // requiring input rather than accidentally enabling with an unknown key.
  return 'unconfigured'
}

const UNCONFIGURED_GATEWAY_STATES = new Set(['cloud_action', 'missing_env', 'not_configured', 'sync_required', 'unknown'])
const UNHEALTHY_GATEWAY_STATES = new Set(['runtime_blocked', 'runtime_missing', 'runtime_inspect_failed'])

function readinessToolCapabilityLabel(state, label) {
  if (label) return label
  if (state === 'ready') return '可用'
  if (state === 'runtime_blocked') return '运行受限'
  if (state === 'runtime_missing') return '无可用工具'
  if (state === 'runtime_inspect_failed') return '服务异常'
  if (state === 'missing_env') return '待管理员配置'
  if (state === 'unauthorized') return '未授权'
  if (state === 'disabled') return '未启用'
  if (state === 'not_installed') return '未安装'
  return '未检查'
}

function readinessBusinessHealthLabel(state, label) {
  if (label) return label
  if (state === 'ready') return '可用'
  if (state === 'unauthorized') return '未授权'
  if (state === 'missing_env') return '待管理员配置'
  if (state === 'runtime_inspect_failed') return '服务异常'
  if (state === 'uniopc_socials_failed' || state === 'private_conversion_failed') return '服务异常'
  if (state) return '服务异常'
  return ''
}

function readinessEntitlementLayer(state, label) {
  if (state === 'active') return { state: 'authorized', label: label || '已授权' }
  if (state === 'suspended') return { state: 'suspended', label: label || '权限暂停' }
  if (state === 'revoked') return { state: 'revoked', label: label || '权限撤销' }
  return { state: 'unauthorized', label: label || '没有权限' }
}

function readinessConfigLayer(gatewayState, gatewayLabel, supported, hasActiveProfile, checkingGateway) {
  if (!hasActiveProfile) return { state: 'no_profile', label: '未创建 Profile' }
  if (!supported) return { state: 'unsupported', label: '当前版本不支持' }
  if (checkingGateway) return { state: 'checking', label: '检查中...' }
  if (gatewayState === 'ready' || gatewayState === 'disabled' || UNHEALTHY_GATEWAY_STATES.has(gatewayState)) {
    return { state: 'written', label: '已写入 Uniopc 引擎' }
  }
  if (gatewayState === 'missing_env') return { state: 'credential_missing', label: '缺少授权凭证' }
  if (gatewayState === 'sync_required') return { state: 'sync_required', label: '待同步 Uniopc 引擎' }
  if (gatewayState === 'cloud_action' || gatewayState === 'not_configured' || !gatewayState) {
    return { state: 'missing', label: '未写入 Uniopc 引擎' }
  }
  return { state: 'unknown', label: gatewayLabel || '待检查' }
}

function effectiveGatewayStateFromCapabilities(gatewayState, gatewayLabel, toolCapabilityState, toolCapabilityLabel) {
  if (toolCapabilityState !== 'ready') return { state: gatewayState, label: gatewayLabel }
  if (gatewayState === 'ready') return { state: gatewayState, label: gatewayLabel }
  if (UNCONFIGURED_GATEWAY_STATES.has(gatewayState) || !gatewayState) {
    return { state: 'ready', label: toolCapabilityLabel || gatewayLabel || '可用' }
  }
  return { state: gatewayState, label: gatewayLabel }
}

function readinessRuntimeLayer(gatewayState, gatewayLabel, configState, toolCapabilityState, toolCapabilityLabel, businessHealthState, businessHealthLabel) {
  if (configState === 'checking') return { state: 'checking', label: '检查中...' }
  // The local profile snapshot is the source of truth for whether a cloud
  // artifact exists on disk. A stale runtime-capability response may still
  // name a previously installed plugin, but cannot make an absent extension
  // runnable; preserve the install action so it can be downloaded again.
  if (gatewayState === 'not_installed') return { state: 'missing', label: gatewayLabel || '未安装' }
  if (businessHealthState && businessHealthState !== 'ready') {
    if (businessHealthState === 'unauthorized' || businessHealthState === 'missing_env') {
      return { state: 'blocked', label: readinessBusinessHealthLabel(businessHealthState, businessHealthLabel) }
    }
    return { state: 'failed', label: readinessBusinessHealthLabel(businessHealthState, businessHealthLabel) }
  }
  if (toolCapabilityState) {
    if (toolCapabilityState === 'ready') return { state: 'ready', label: readinessToolCapabilityLabel(toolCapabilityState, toolCapabilityLabel) }
    if (toolCapabilityState === 'disabled') return { state: 'disabled', label: readinessToolCapabilityLabel(toolCapabilityState, toolCapabilityLabel) }
    if (toolCapabilityState === 'not_installed') return { state: 'missing', label: readinessToolCapabilityLabel(toolCapabilityState, toolCapabilityLabel) }
    if (toolCapabilityState === 'missing_env' || toolCapabilityState === 'unauthorized') {
      return { state: 'blocked', label: readinessToolCapabilityLabel(toolCapabilityState, toolCapabilityLabel) }
    }
    return { state: 'failed', label: readinessToolCapabilityLabel(toolCapabilityState, toolCapabilityLabel) }
  }
  if (gatewayState === 'ready') return { state: 'ready', label: '可用' }
  if (gatewayState === 'disabled') return { state: 'disabled', label: '未启用' }
  if (gatewayState === 'not_installed') return { state: 'missing', label: '未安装' }
  if (UNHEALTHY_GATEWAY_STATES.has(gatewayState)) {
    return { state: 'failed', label: gatewayLabel || '运行异常' }
  }
  if (gatewayState === 'missing_env') return { state: 'blocked', label: gatewayLabel || '待管理员配置' }
  if (configState === 'unsupported') return { state: 'blocked', label: '无法运行' }
  return { state: 'unchecked', label: '未检查' }
}

// Official cloud plugins carry an account-authorization handshake (they mint a
// scoped host credential). Surfacing that as an explicit "重新授权" action lets
// the user re-run just the authorization instead of the whole install, and — on
// an unhealthy runtime — separates re-auth from restarting the engine.
function withReauthorizeSecondary(action, supportsReauthorize) {
  if (!supportsReauthorize) return action
  return {
    ...action,
    secondaryAction: 'reauthorize',
    secondaryLabel: '重新授权',
    secondaryBusyLabel: '授权中...',
  }
}

function readinessAction(plugin, entitlement, config, runtime, options = {}) {
  const actionBusy = Boolean(options.actionBusy)
  const disabledBase = actionBusy || options.hasActiveProfile === false
  const supportsReauthorize = Boolean(options.supportsReauthorize)
  const credentialState = String(options.credentialState || plugin?.credentialState || '').trim()
  const needsCredentialInput = credentialState === 'unconfigured' || credentialState === 'partially_configured'
  // A catalogue row can be active before its first plugin artifact is
  // published. Keep it visible, but never let the desktop begin an install
  // flow that cannot resolve a verifiable package.
  if (plugin?.releaseState === 'unpublished') {
    return {
      state: 'unpublished',
      primaryAction: 'unpublished',
      primaryLabel: '暂未发布',
      busyLabel: '暂未发布',
      disabled: true,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }
  if (entitlement.state !== 'authorized') {
    return {
      state: 'no_permission',
      primaryAction: 'contact_admin',
      primaryLabel: '联系管理员',
      busyLabel: '处理中...',
      disabled: true,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }
  if (config.state === 'unsupported') {
    return {
      state: 'unsupported',
      primaryAction: 'update_app',
      primaryLabel: '更新应用',
      busyLabel: '更新中...',
      disabled: true,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }
  if (config.state === 'checking' || runtime.state === 'checking') {
    return {
      state: 'checking',
      primaryAction: 'wait_for_check',
      primaryLabel: '检查中...',
      busyLabel: '检查中...',
      disabled: true,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }
  if (needsCredentialInput) {
    return {
      state: 'needs_credential',
      primaryAction: 'configure_enable',
      primaryLabel: credentialState === 'partially_configured' ? '补全凭证并启用' : '填写凭证并启用',
      busyLabel: '启用中...',
      disabled: disabledBase,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }
  if (runtime.state === 'ready') {
    return withReauthorizeSecondary({
      state: 'ready',
      primaryAction: plugin?.managementRoute ? 'open_management' : 'restart',
      primaryLabel: plugin?.managementRoute ? '打开' : '重启',
      busyLabel: plugin?.managementRoute ? '打开中...' : '重启中...',
      disabled: disabledBase,
      canUninstall: true,
      uninstallLabel: '卸载插件',
    }, supportsReauthorize)
  }
  if (runtime.state === 'missing') {
    // Not installed yet: this is an install, not a repair. Cloud-distributed
    // plugins download the artifact and install through the Uniopc 引擎 CLI;
    // bundled plugins install from the app resources on the same click.
    const cloud = plugin?.distribution === 'cloud'
    return {
      state: 'not_installed',
      primaryAction: 'install',
      primaryLabel: cloud ? '下载并安装' : '安装并启用',
      busyLabel: '安装中...',
      disabled: disabledBase,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }
  if (runtime.state === 'failed' || runtime.state === 'blocked') {
    if (supportsReauthorize) {
      // Official cloud plugins land here mostly on an expired/mismatched host
      // credential or a just-restarted (cold) gateway — not a genuinely broken
      // install. Re-authorization (mint a fresh host credential) is the targeted
      // fix; restarting the engine is the fallback. Splitting the two ends the
      // "修复并重启" loop that only ever re-ran the same failing probe.
      return {
        state: 'runtime_unhealthy',
        primaryAction: 'reauthorize',
        primaryLabel: '重新授权',
        busyLabel: '授权中...',
        secondaryAction: 'repair_restart',
        secondaryLabel: '重启引擎',
        secondaryBusyLabel: '重启中...',
        disabled: disabledBase,
        canUninstall: true,
        uninstallLabel: '卸载插件',
      }
    }
    return {
      state: 'runtime_unhealthy',
      primaryAction: 'repair_restart',
      primaryLabel: '修复并重启',
      busyLabel: '重启中...',
      disabled: disabledBase,
      canUninstall: true,
      uninstallLabel: '卸载插件',
    }
  }
  if (runtime.state === 'disabled') {
    return {
      state: 'configured_stopped',
      primaryAction: 'start',
      primaryLabel: '启动',
      busyLabel: '启动中...',
      disabled: disabledBase,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }
  return {
    state: credentialState === 'configured' ? 'credential_saved_enable' : 'needs_configuration',
    primaryAction: credentialState === 'configured' ? 'enable' : 'configure_enable',
    primaryLabel: credentialState === 'configured'
      ? '启用插件'
      : config.state === 'credential_missing' ? '补全凭证并启用' : '配置并启用',
    busyLabel: '启用中...',
    disabled: disabledBase,
    canUninstall: false,
    uninstallLabel: '卸载插件',
  }
}

export function resolvePluginReadiness(plugin = {}, options = {}) {
  const entitlementState = String(options.entitlementState || plugin.entitlementState || '').trim()
  const entitlementLabel = String(options.entitlementLabel || plugin.entitlementLabel || '').trim()
  const gatewayState = String(options.gatewayState || plugin.gatewayState || plugin.status || '').trim()
  const gatewayLabel = String(options.gatewayLabel || plugin.gatewayLabel || plugin.statusLabel || '').trim()
  const toolCapabilityState = String(options.toolCapabilityState || plugin.toolCapabilityState || '').trim()
  const toolCapabilityLabel = String(options.toolCapabilityLabel || plugin.toolCapabilityLabel || '').trim()
  const businessHealthState = String(options.businessHealthState || plugin.businessHealthState || '').trim()
  const businessHealthLabel = String(options.businessHealthLabel || plugin.businessHealthLabel || '').trim()
  const credentialState = String(options.credentialState || plugin.credentialState || '').trim()
  const supported = options.supported !== false
  const hasActiveProfile = options.hasActiveProfile !== false
  const checkingGateway = Boolean(options.checkingGateway)
  const entitlement = readinessEntitlementLayer(entitlementState || 'missing', entitlementLabel)
  const effectiveGateway = effectiveGatewayStateFromCapabilities(gatewayState, gatewayLabel, toolCapabilityState, toolCapabilityLabel)
  const config = readinessConfigLayer(effectiveGateway.state, effectiveGateway.label, supported, hasActiveProfile, checkingGateway)
  const runtime = readinessRuntimeLayer(effectiveGateway.state, effectiveGateway.label, config.state, toolCapabilityState, toolCapabilityLabel, businessHealthState, businessHealthLabel)
  const action = readinessAction(plugin, entitlement, config, runtime, { ...options, credentialState })
  const credential = credentialState === 'configured'
    ? { state: 'configured', label: '凭据已保存' }
    : credentialState === 'partially_configured'
      ? { state: 'partially_configured', label: '凭据未填完整' }
      : credentialState === 'unconfigured'
        ? { state: 'unconfigured', label: '待填写凭据' }
        : null
  const release = plugin?.releaseState === 'unpublished'
    ? { state: 'unpublished', label: '未发布' }
    : plugin?.releaseState === 'published'
      ? { state: 'published', label: '已发布' }
      : null
  return {
    ...action,
    entitlement,
    config,
    runtime,
    statusItems: [
      ...(release ? [{ label: '发布状态', value: release.label }] : []),
      { label: '授权状态', value: entitlement.label },
      ...(credential ? [{ label: '凭据状态', value: credential.label }] : []),
      { label: '配置状态', value: config.label },
      { label: '运行状态', value: runtime.label },
    ],
  }
}

export function derivePluginLifecycle(plugin = {}, options = {}) {
  const entitlementState = String(options.entitlementState || plugin.entitlementState || '').trim()
  const gatewayState = String(options.gatewayState || plugin.gatewayState || plugin.status || '').trim()
  const hasActiveProfile = options.hasActiveProfile !== false
  const supported = options.supported !== false
  const actionBusy = Boolean(options.actionBusy)
  const disabled = actionBusy || !hasActiveProfile

  if (entitlementState && entitlementState !== 'active') {
    return {
      state: 'no_permission',
      primaryAction: 'contact_admin',
      primaryLabel: '联系管理员',
      busyLabel: '处理中...',
      disabled: true,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }

  if (!supported) {
    return {
      state: 'unsupported',
      primaryAction: 'update_app',
      primaryLabel: '更新应用',
      busyLabel: '更新中...',
      disabled: true,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }

  if (gatewayState === 'ready') {
    return {
      state: 'running_ready',
      primaryAction: 'restart',
      primaryLabel: '重启',
      busyLabel: '重启中...',
      disabled,
      canUninstall: true,
      uninstallLabel: '卸载插件',
    }
  }

  if (gatewayState === 'not_installed') {
    return {
      state: 'not_installed',
      primaryAction: 'install',
      primaryLabel: plugin?.distribution === 'cloud' ? '下载并安装' : '安装并启用',
      busyLabel: '安装中...',
      disabled,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }

  if (UNHEALTHY_GATEWAY_STATES.has(gatewayState)) {
    return {
      state: 'running_unhealthy',
      primaryAction: 'repair_restart',
      primaryLabel: '修复并重启',
      busyLabel: '重启中...',
      disabled,
      canUninstall: true,
      uninstallLabel: '卸载插件',
    }
  }

  if (gatewayState === 'disabled') {
    return {
      state: 'configured_stopped',
      primaryAction: 'start',
      primaryLabel: '启动',
      busyLabel: '启动中...',
      disabled,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }

  if (UNCONFIGURED_GATEWAY_STATES.has(gatewayState) || !gatewayState) {
    return {
      state: 'not_configured',
      primaryAction: 'configure_enable',
      primaryLabel: '配置并启用',
      busyLabel: '启用中...',
      disabled,
      canUninstall: false,
      uninstallLabel: '卸载插件',
    }
  }

  return {
    state: 'running_unhealthy',
    primaryAction: 'repair_restart',
    primaryLabel: '修复并重启',
    busyLabel: '重启中...',
    disabled,
    canUninstall: true,
    uninstallLabel: '卸载插件',
  }
}

export function buildAuthorizedAppPresets(entitlements = [], catalogPresets = []) {
  const allowedIds = activeEntitlementIds(entitlements) || new Set()
  return catalogPresets.filter(preset => preset?.id && allowedIds.has(preset.id))
}

export function buildProfilePluginCapabilities(profilePlugins = [], catalogPresets = [], entitlements = null) {
  const allowedIds = activeEntitlementIds(entitlements)
  const catalogById = new Map(
    catalogPresets
      .filter(item => item?.id)
      .map(item => [item.id, item]),
  )
  const profileById = new Map(
    profilePlugins
      .filter(item => item?.id)
      .map(item => [item.id, item]),
  )
  const orderedIds = [
    ...[...FOUNDATION_PLUGIN_IDS]
      .filter(id => (!allowedIds || allowedIds.has(id)) && (catalogById.has(id) || profileById.has(id))),
    ...(allowedIds
      ? [...allowedIds].filter(id => !FOUNDATION_PLUGIN_IDS.has(id))
      : profilePlugins
        .filter(plugin => plugin?.id && plugin?.enabled && !FOUNDATION_PLUGIN_IDS.has(plugin.id))
        .map(plugin => plugin.id)),
  ]

  return [...new Set(orderedIds)]
    .map(id => {
      const preset = catalogById.get(id) || {}
      const plugin = profileById.get(id) || {}
      const isFoundationPlugin = FOUNDATION_PLUGIN_IDS.has(id)
      const profileEnabled = plugin.enabled === true
      if (allowedIds && !allowedIds.has(id)) return null
      if (!isFoundationPlugin && !profileEnabled && !allowedIds) return null
      const merged = {
        ...preset,
        ...plugin,
        id,
        enabled: isFoundationPlugin || Boolean(allowedIds) ? true : profileEnabled,
        status: profileEnabled ? plugin.status : 'sync_required',
        title: preset.title || plugin.title || id,
        provider: preset.provider || plugin.provider || '',
        description: preset.description || plugin.description || '',
        tags: preset.tags || plugin.tags || [],
      }
      return {
        ...merged,
        statusLabel: profileCapabilityStatusLabel(merged),
        actionLabel: profileCapabilityActionLabel(merged),
      }
    })
    .filter(Boolean)
}
