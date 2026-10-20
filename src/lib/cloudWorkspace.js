export function requireCloudOwnerId(ownerId) {
  const value = String(ownerId || '').trim()
  if (!value) throw new Error('missing_owner_id')
  return value
}

function requireId(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`missing_${name}`)
  return normalized
}

function requireProjectName(name) {
  const value = String(name || '').trim()
  if (!value) throw new Error('missing_project_name')
  return value
}

function normalizeDescription(description) {
  return String(description || '').trim()
}

function normalizeOptionalText(value) {
  return String(value || '').trim()
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeProfile(profile) {
  return String(profile || '').trim()
}

function normalizeRuntimeMode(value = '') {
  return 'member_local'
}

function normalizeProfileKey(profile) {
  const value = String(profile || '').trim().toLowerCase()
  const normalized = value
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized) throw new Error('missing_openclaw_profile')
  return normalized
}

export function buildMemberOpenClawProfileKey(member = {}) {
  const source = String(member.memberEmail || member.email || member.displayName || member.name || 'member')
    .split('@')[0]
    .trim()
    .toLowerCase()
  const prefix = source
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'member'
  const memberId = String(member.memberId || member.id || member.member_id || '').trim().toLowerCase()
  const suffix = memberId.replace(/[^a-z0-9]/g, '').slice(0, 8)
  return suffix ? `${prefix}-${suffix}` : prefix
}

function normalizeCloudWorkspaceProfile(row = {}) {
  if (Array.isArray(row)) return normalizeCloudWorkspaceProfile(row[0] || null)
  if (!row || typeof row !== 'object' || Object.keys(row).length === 0) {
    return {
      organizationId: null,
      organizationName: '',
      memberId: null,
      memberRole: 'unopened',
      openclawProfile: '',
      profileStatus: 'workspace_not_found',
      isOwner: false,
      isAdmin: false,
    }
  }
  const memberRole = normalizeOptionalText(row.member_role || row.role) || 'member'
  const openclawProfile = normalizeOptionalText(row.openclaw_profile || row.profile_key)
  const runtimeMode = normalizeRuntimeMode(row.runtime_mode || row.runtimeMode)
  const normalized = {
    organizationId: row.organization_id || row.id || null,
    organizationName: normalizeOptionalText(row.organization_name || row.name),
    organizationTypeId: row.organization_type_id || row.type_id || null,
    organizationTypeKey: normalizeOptionalText(row.organization_type_key || row.type_key),
    organizationTypeName: normalizeOptionalText(row.organization_type_name || row.type_name),
    memberId: row.member_id || null,
    memberRole,
    openclawProfile,
    profileStatus: normalizeOptionalText(row.profile_status || row.status) || 'active',
    runtimeMode,
    runtime_mode: runtimeMode,
    isOwner: memberRole === 'owner',
    isAdmin: memberRole === 'owner' || memberRole === 'admin',
  }
  if (row.openclaw_profile_id || row.profile_id) normalized.openclawProfileId = row.openclaw_profile_id || row.profile_id
  if ('gateway_status' in row) normalized.gatewayStatus = normalizeOptionalText(row.gateway_status) || 'offline'
  if ('gateway_status_message' in row || 'status_message' in row) {
    normalized.gatewayStatusMessage = normalizeOptionalText(row.gateway_status_message || row.status_message)
  }
  if ('gateway_port' in row) normalized.gatewayPort = row.gateway_port || null
  if ('gateway_url' in row) normalized.gatewayUrl = normalizeOptionalText(row.gateway_url) || null
  if ('host_id' in row) normalized.hostId = row.host_id || null
  if ('host_status' in row) normalized.hostStatus = normalizeOptionalText(row.host_status) || 'offline'
  return normalized
}

function normalizeOrganizationType(row = {}) {
  if (Array.isArray(row)) return normalizeOrganizationType(row[0] || {})
  return {
    id: row.id || row.organization_type_id || null,
    key: normalizeOptionalText(row.type_key || row.key || row.organization_type_key),
    name: normalizeOptionalText(row.name || row.organization_type_name),
    description: normalizeOptionalText(row.description),
    status: normalizeOptionalText(row.status) || 'active',
    sortOrder: Number(row.sort_order ?? row.sortOrder ?? 0),
  }
}

function normalizeOrganizationPluginEntitlement(row = {}) {
  if (Array.isArray(row)) return normalizeOrganizationPluginEntitlement(row[0] || {})
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  return {
    id: row.id || row.entitlement_id || null,
    organizationId: row.organization_id || null,
    pluginId: normalizeOptionalText(row.plugin_id || row.id),
    pluginName: normalizeOptionalText(row.plugin_name || row.name || row.plugin_id),
    pluginDescription: normalizeOptionalText(row.plugin_description || row.description),
    provider: normalizeOptionalText(row.provider) || 'Uniopc',
    status: normalizeOptionalText(row.entitlement_status || row.status) || 'active',
    grantedAt: row.granted_at || row.assigned_at || row.created_at || null,
    notes: normalizeOptionalText(row.notes),
    isGlobal: row.is_global === true || row.isGlobal === true || metadata.global_plugin === true,
    ...(metadata.default_entitlement === true || metadata.defaultEntitlement === true
      ? { defaultEntitlement: true }
      : {}),
    metadata,
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => normalizeOptionalText(item))
    .filter(Boolean)
}

function currentCatalogLanguage() {
  try {
    const saved = globalThis.localStorage?.getItem?.('imai.language')
    if (saved === 'en' || saved === 'zh') return saved
  } catch {}
  try {
    const documentLanguage = String(globalThis.document?.documentElement?.lang || '').toLowerCase()
    if (documentLanguage.startsWith('en')) return 'en'
    if (documentLanguage.startsWith('zh')) return 'zh'
  } catch {}
  try {
    const languages = Array.isArray(globalThis.navigator?.languages) && globalThis.navigator.languages.length > 0
      ? globalThis.navigator.languages
      : [globalThis.navigator?.language]
    const first = String(languages.find(Boolean) || '').toLowerCase()
    if (first.startsWith('en')) return 'en'
    if (first.startsWith('zh')) return 'zh'
  } catch {}
  return 'zh'
}

function localizedCatalogText(metadata = {}, key, fallback) {
  const i18n = metadata.i18n && typeof metadata.i18n === 'object' ? metadata.i18n : {}
  const language = currentCatalogLanguage()
  const languageCopy = i18n[language] && typeof i18n[language] === 'object' ? i18n[language] : {}
  const fallbackCopy = i18n.zh && typeof i18n.zh === 'object'
    ? i18n.zh
    : i18n.en && typeof i18n.en === 'object'
      ? i18n.en
      : {}
  return normalizeOptionalText(languageCopy[key] || fallbackCopy[key] || fallback)
}

function normalizeCloudPluginCatalogItem(row = {}) {
  if (Array.isArray(row)) return normalizeCloudPluginCatalogItem(row[0] || {})
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const id = normalizeOptionalText(row.plugin_id || row.pluginId || row.id)
  const catalogSection = normalizeOptionalText(metadata.catalog_section || metadata.catalogSection) || 'official'
  const runtimePluginId = normalizeOptionalText(metadata.runtime_plugin_id || metadata.runtimePluginId)
  const managementRoute = normalizeOptionalText(metadata.management_route || metadata.managementRoute)
  const installCommand = normalizeOptionalText(metadata.install_command || metadata.installCommand)
  const installSpec = normalizeOptionalText(metadata.install_spec || metadata.installSpec)
  const installKind = normalizeOptionalText(metadata.install_kind || metadata.installKind)
  const installHint = normalizeOptionalText(metadata.install_hint || metadata.installHint)
  const commandHint = normalizeOptionalText(metadata.command_hint || metadata.commandHint)
  const configPath = normalizeOptionalText(metadata.config_path || metadata.configPath)
  const docsUrl = normalizeOptionalText(metadata.docs_url || metadata.docsUrl)
  const externalService = normalizeOptionalText(metadata.external_service || metadata.externalService)
  const defaultProvider = normalizeOptionalText(metadata.default_provider || metadata.defaultProvider)
  const marketplaceSource = normalizeOptionalText(metadata.marketplace_source || metadata.marketplaceSource)
  const marketplaceChannel = normalizeOptionalText(metadata.marketplace_channel || metadata.marketplaceChannel)
  const latestVersion = normalizeOptionalText(metadata.latest_version || metadata.latestVersion)
  const releaseState = normalizeOptionalText(metadata.release_state || metadata.releaseState)
    || (latestVersion ? 'published' : '')
  const verificationTier = normalizeOptionalText(metadata.verification_tier || metadata.verificationTier)
  // First-class distribution tier + origin label from the catalog columns,
  // with metadata fallbacks for rows created before the migration.
  const origin = normalizeOptionalText(row.origin)
    || (catalogSection === 'third-party' ? 'third_party' : 'official')
  const distribution = normalizeOptionalText(row.distribution)
    || (metadata.bundled === false ? 'cloud' : 'bundled')
  const item = {
    id,
    title: localizedCatalogText(metadata, 'name', row.name || row.title || id),
    provider: normalizeOptionalText(row.provider) || 'Uniopc',
    description: localizedCatalogText(metadata, 'description', row.description),
    pluginKind: normalizeOptionalText(row.plugin_kind || row.pluginKind) || 'openclaw_plugin',
    catalogSection: origin === 'third_party' ? 'third-party' : catalogSection,
    origin,
    distribution,
    bundled: distribution === 'bundled',
    required: metadata.required === true || metadata.foundation === true,
    removable: metadata.removable === true,
    localFirst: metadata.local_first === true || metadata.localFirst === true,
    userManagedCredentials: metadata.user_managed_credentials === true || metadata.userManagedCredentials === true,
    isGlobal: row.is_global === true || row.isGlobal === true || metadata.is_global === true || metadata.global_plugin === true,
    ...(metadata.default_entitlement === true || metadata.defaultEntitlement === true
      ? { defaultEntitlement: true }
      : {}),
    tags: normalizeStringArray(metadata.tags),
    // Main user-facing category (scene taxonomy). See
    // uniopc-supabase/docs/plugin-taxonomy.md. Falls back through legacy keys;
    // unknown/empty is treated as 'other' by the UI grouping.
    sceneCategory: normalizeOptionalText(metadata.scene_category || metadata.sceneCategory || metadata.category) || '',
    // Ops fields (docs/plugin-system-v2.md §2). pricing is a display-layer
    // marker only — the actual gate stays the entitlement three-path check.
    pricing: normalizeOptionalText(metadata.pricing) || 'free',
    metadata,
  }
  if (metadata.featured === true) {
    item.featured = true
    const featuredOrder = Number(metadata.featured_order ?? metadata.featuredOrder)
    if (Number.isFinite(featuredOrder)) item.featuredOrder = featuredOrder
  }
  if (metadata.force_update === true || metadata.forceUpdate === true) item.forceUpdate = true
  if (metadata.preinstall === true) item.preinstall = true
  // Cloud-agent 插件的 Edge Function 路径(如 'socials')。有此字段 = 该插件
  // 走平台托管 host-credential 链路;新插件靠它免去桌面端逐个登记。
  const functionPath = normalizeOptionalText(metadata.function_path || metadata.functionPath)
  if (functionPath) item.functionPath = functionPath
  if (runtimePluginId) item.runtimePluginId = runtimePluginId
  const aliases = normalizeStringArray(metadata.aliases)
  if (aliases.length > 0) item.aliases = aliases
  if (managementRoute) item.managementRoute = managementRoute
  if (installSpec) item.installSpec = installSpec
  if (installCommand) item.installCommand = installCommand
  if (installKind) item.installKind = installKind
  if (installHint) item.installHint = installHint
  if (commandHint) item.commandHint = commandHint
  if (configPath) item.configPath = configPath
  if (docsUrl) item.docsUrl = docsUrl
  if (marketplaceSource) item.marketplaceSource = marketplaceSource
  if (marketplaceChannel) item.marketplaceChannel = marketplaceChannel
  if (latestVersion) item.latestVersion = latestVersion
  if (releaseState) item.releaseState = releaseState
  if (verificationTier) item.verificationTier = verificationTier
  if (metadata.is_openclaw_official === true || metadata.isOpenClawOfficial === true) item.isOpenClawOfficial = true
  if (metadata.requires_api_key === true || metadata.requiresApiKey === true) item.requiresApiKey = true
  if (metadata.read_only === true || metadata.readOnly === true) item.readOnly = true
  if (externalService) item.externalService = externalService
  if (defaultProvider) item.defaultProvider = defaultProvider
  const observedStatus = normalizeOptionalText(row.observed_status || row.observedStatus)
  if (observedStatus) item.observedStatus = observedStatus
  const observedVersion = normalizeOptionalText(row.observed_version || row.observedVersion)
  if (observedVersion) item.observedVersion = observedVersion
  if ('observed_enabled' in row || 'observedEnabled' in row) item.observedEnabled = row.observed_enabled ?? row.observedEnabled
  const driftStatus = normalizeOptionalText(row.drift_status || row.driftStatus)
  if (driftStatus) item.driftStatus = driftStatus
  const observedAt = row.observed_at || row.observedAt || null
  if (observedAt) item.observedAt = observedAt
  const assignmentStatus = normalizeOptionalText(row.assignment_status || row.assignmentStatus)
  if (assignmentStatus) item.assignmentStatus = assignmentStatus
  return item
}

export function normalizeCloudPluginCatalogRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map(normalizeCloudPluginCatalogItem)
}

function cachedProfilePluginStatus(plugin = {}) {
  const observedStatus = normalizeOptionalText(plugin.observedStatus || plugin.observed_status)
  const observedEnabled = plugin.observedEnabled ?? plugin.observed_enabled ?? null
  if (observedStatus === 'installed') {
    return {
      installed: true,
      enabled: observedEnabled !== false,
      status: observedEnabled === false ? 'disabled' : 'ready',
    }
  }
  if (observedStatus === 'disabled') return { installed: true, enabled: false, status: 'disabled' }
  if (observedStatus === 'failed') return { installed: true, enabled: observedEnabled !== false, status: 'runtime_inspect_failed' }
  if (observedStatus === 'missing') return { installed: false, enabled: false, status: 'not_installed' }
  return null
}

export function buildCachedProfilePluginSnapshot(profile, cloudPluginCatalog = []) {
  const profileKey = normalizeProfile(profile)
  return {
    profile: profileKey,
    plugins: (Array.isArray(cloudPluginCatalog) ? cloudPluginCatalog : [])
      .map(plugin => {
        const cached = cachedProfilePluginStatus(plugin)
        if (!cached) return null
        const id = normalizeOptionalText(
          plugin.id ||
          plugin.pluginId ||
          plugin.plugin_id ||
          plugin.runtimePluginId ||
          plugin.runtime_plugin_id ||
          plugin.openclawPluginId ||
          plugin.openclaw_plugin_id,
        )
        if (!id) return null
        return {
          id,
          title: normalizeOptionalText(plugin.title || plugin.name || id),
          description: normalizeOptionalText(plugin.description),
          enabled: cached.enabled,
          installed: cached.installed,
          status: cached.status,
          pluginPath: '',
          missingEnv: [],
          toolBridgeEnabled: true,
          cached: true,
        }
      })
      .filter(Boolean),
  }
}

function normalizeCloudProfilePluginAssignment(row = {}) {
  if (Array.isArray(row)) return normalizeCloudProfilePluginAssignment(row[0] || {})
  return {
    id: row.id || row.assignment_id || null,
    organizationId: row.organization_id || row.organizationId || null,
    memberId: row.member_id || row.memberId || null,
    openclawProfileId: row.openclaw_profile_id || row.openclawProfileId || null,
    pluginId: normalizeOptionalText(row.plugin_id || row.pluginId),
    desiredVersion: normalizeOptionalText(row.desired_version || row.desiredVersion) || 'latest',
    desiredEnabled: row.desired_enabled === true || row.desiredEnabled === true,
    observedVersion: normalizeOptionalText(row.observed_version || row.observedVersion),
    observedEnabled: row.observed_enabled ?? row.observedEnabled ?? null,
    observedStatus: normalizeOptionalText(row.observed_status || row.observedStatus) || 'unknown',
    observedSha256: normalizeOptionalText(row.observed_sha256 || row.observedSha256),
    driftStatus: normalizeOptionalText(row.drift_status || row.driftStatus) || 'unknown',
    status: normalizeOptionalText(row.status) || 'active',
    lastError: normalizeOptionalText(row.last_error || row.lastError),
    observedAt: row.observed_at || row.observedAt || null,
  }
}

export function mergeCloudPluginCatalogObservations(catalogRows = [], assignmentRows = []) {
  const assignmentsByPluginId = new Map()
  for (const assignment of Array.isArray(assignmentRows) ? assignmentRows : []) {
    const normalized = normalizeCloudProfilePluginAssignment(assignment)
    if (normalized.pluginId && !assignmentsByPluginId.has(normalized.pluginId)) {
      assignmentsByPluginId.set(normalized.pluginId, normalized)
    }
  }
  return (Array.isArray(catalogRows) ? catalogRows : []).map(plugin => {
    const assignment = assignmentsByPluginId.get(normalizeOptionalText(plugin.id || plugin.pluginId || plugin.plugin_id))
    if (!assignment) return plugin
    return {
      ...plugin,
      assignmentStatus: assignment.status,
      observedStatus: assignment.observedStatus,
      observedVersion: assignment.observedVersion,
      observedEnabled: assignment.observedEnabled,
      driftStatus: assignment.driftStatus,
      observedAt: assignment.observedAt,
      lastError: assignment.lastError,
    }
  })
}

function normalizeWorkspacePluginPolicyBootstrap(row = {}) {
  if (Array.isArray(row)) return normalizeWorkspacePluginPolicyBootstrap(row[0] || {})
  const workspace = normalizeCloudWorkspaceProfile(row)
  const policyVersion = Number(row.policy_version ?? row.policyVersion ?? 0)
  const plugins = Array.isArray(row.plugins)
    ? row.plugins.map(normalizeOrganizationPluginEntitlement)
    : []
  return {
    ...workspace,
    policyVersion,
    plugins,
  }
}

function normalizeOpenClawProfileAccess(row = {}) {
  if (Array.isArray(row)) return normalizeOpenClawProfileAccess(row[0] || {})
  const runtimeMode = normalizeRuntimeMode(row.runtime_mode || row.runtimeMode)
  return {
    organizationId: row.organization_id || null,
    memberId: row.organization_member_id || row.member_id || null,
    openclawProfileId: row.openclaw_profile_id || row.profile_id || null,
    openclawProfile: normalizeOptionalText(row.openclaw_profile || row.profile_key),
    runtimeMode,
    runtime_mode: runtimeMode,
    hostId: row.host_id || null,
    hostStatus: normalizeOptionalText(row.host_status) || 'offline',
    profileStatus: normalizeOptionalText(row.profile_status || row.status) || 'missing',
    gatewayStatus: normalizeOptionalText(row.gateway_status) || 'offline',
    gatewayStatusMessage: normalizeOptionalText(row.gateway_status_message || row.status_message),
    expiresAt: row.expires_at || null,
  }
}

function normalizeOpenClawProfilePairingSetup(row = {}) {
  if (Array.isArray(row)) return normalizeOpenClawProfilePairingSetup(row[0] || {})
  return {
    openclawProfileId: row.openclaw_profile_id || row.profile_id || null,
    openclawProfile: normalizeOptionalText(row.openclaw_profile || row.profile_key),
    setupCode: normalizeOptionalText(row.setup_code || row.setupCode),
    gatewayUrl: normalizeOptionalText(row.gateway_url || row.gatewayUrl),
    transport: normalizeOptionalText(row.transport || row.remote_transport) || '',
    sshTarget: normalizeOptionalText(row.ssh_target || row.sshTarget),
    sshRemoteHost: normalizeOptionalText(row.ssh_remote_host || row.sshRemoteHost),
    sshRemotePort: row.ssh_remote_port ?? row.sshRemotePort ?? null,
    sshLocalPort: row.ssh_local_port ?? row.sshLocalPort ?? null,
    pairingStatus: normalizeOptionalText(row.pairing_status || row.pairingStatus) || 'missing',
    expiresAt: row.expires_at || row.expiresAt || null,
  }
}

function normalizeMemberDevice(row = {}) {
  if (Array.isArray(row)) return normalizeMemberDevice(row[0] || {})
  if (!row || typeof row !== 'object') return null
  const id = normalizeOptionalText(row.id || row.device_id)
  if (!id) return null
  return {
    id,
    organizationId: row.organization_id || null,
    memberId: row.member_id || row.organization_member_id || null,
    userId: row.user_id || null,
    deviceType: normalizeOptionalText(row.device_type || row.deviceType) || 'desktop',
    deviceName: normalizeOptionalText(row.device_name || row.deviceName),
    devicePlatform: normalizeOptionalText(row.device_platform || row.devicePlatform),
    deviceFingerprint: normalizeOptionalText(row.device_fingerprint || row.deviceFingerprint),
    status: normalizeOptionalText(row.status) || 'pending',
    lastSeenAt: row.last_seen_at || row.lastSeenAt || null,
  }
}

function normalizeGatewayAssignment(row = {}) {
  if (Array.isArray(row)) return normalizeGatewayAssignment(row[0] || {})
  if (!row || typeof row !== 'object') return null
  const id = normalizeOptionalText(row.id || row.assignment_id)
  if (!id) return null
  return {
    id,
    organizationId: row.organization_id || null,
    memberId: row.member_id || row.organization_member_id || null,
    deviceId: row.device_id || null,
    hostId: row.host_id || null,
    openclawProfileId: row.openclaw_profile_id || row.profile_id || null,
    openclawProfile: normalizeOptionalText(row.openclaw_profile || row.profile_key),
    gatewayUrl: normalizeOptionalText(row.gateway_url || row.gatewayUrl),
    gatewayStatus: normalizeOptionalText(row.gateway_status || row.gatewayStatus) || 'offline',
    accessMode: normalizeOptionalText(row.access_mode || row.accessMode) || 'direct',
    transport: normalizeOptionalText(row.transport || row.remote_transport) || 'direct',
    sshTarget: normalizeOptionalText(row.ssh_target || row.sshTarget),
    sshRemoteHost: normalizeOptionalText(row.ssh_remote_host || row.sshRemoteHost),
    sshRemotePort: row.ssh_remote_port ?? row.sshRemotePort ?? null,
    sshLocalPort: row.ssh_local_port ?? row.sshLocalPort ?? null,
    status: normalizeOptionalText(row.status) || 'active',
    expiresAt: row.expires_at || row.expiresAt || null,
  }
}

function shouldTreatMemberClientAgentAsOnline(row = {}, gatewayAssignment = null) {
  const agentId = normalizeOptionalText(row.openclaw_agent_id || row.agent_id || row.id)
  return gatewayAssignment?.gatewayStatus === 'online' &&
    agentId === 'main' &&
    row.can_chat !== false
}

function normalizeMemberClientAgent(row = {}, gatewayAssignment = null) {
  const inferredOnline = shouldTreatMemberClientAgentAsOnline(row, gatewayAssignment)
  const employee = normalizeCloudAiEmployee({
    ...row,
    runtime_status: inferredOnline ? 'online' : row.runtime_status,
    source: 'member-client',
    id: row.openclaw_agent_id || row.agent_id || row.id,
  })
  return {
    ...employee,
    source: 'member-client',
    permission_id: row.permission_id || row.permissionId || row.id || null,
    can_chat: row.can_chat !== false,
    can_run_tasks: row.can_run_tasks !== false,
    can_read_documents: row.can_read_documents !== false,
    can_write_documents: row.can_write_documents === true,
    can_use_tools: row.can_use_tools === true,
    capabilities: row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : {},
  }
}

function normalizeMemberClientBootstrap(row = {}) {
  if (Array.isArray(row)) return normalizeMemberClientBootstrap(row[0] || {})
  const status = normalizeOptionalText(row.status || row.client_status) || 'no_assignment'
  const memberRole = normalizeOptionalText(row.member_role || row.role) || 'member'
  const gatewayAssignment = normalizeGatewayAssignment(row.gateway_assignment || row.assignment || {})
  const agents = Array.isArray(row.agents)
    ? row.agents.map(agent => normalizeMemberClientAgent(agent, gatewayAssignment))
    : []
  return {
    status,
    organizationId: row.organization_id || null,
    organizationName: normalizeOptionalText(row.organization_name || row.name),
    memberId: row.member_id || row.organization_member_id || null,
    memberRole,
    isOwner: memberRole === 'owner',
    isAdmin: memberRole === 'owner' || memberRole === 'admin',
    device: normalizeMemberDevice(row.device || row.member_device || {}),
    gatewayAssignment,
    pairingSetup: normalizeOpenClawProfilePairingSetup(row.pairing_setup || row.pairingSetup || {}),
    agents,
    capabilities: row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : {},
  }
}

function normalizeMemberClientAdminSummary(row = {}) {
  if (Array.isArray(row)) return normalizeMemberClientAdminSummary(row[0] || {})
  return {
    memberId: row.member_id || row.organization_member_id || null,
    gatewayAssignment: normalizeGatewayAssignment(row.gateway_assignment || row.assignment || {}),
    agents: Array.isArray(row.agents) ? row.agents.map(normalizeMemberClientAgent) : [],
  }
}

function normalizeCloudAiEmployee(row = {}) {
  const agentId = normalizeOptionalText(row.openclaw_agent_id || row.agent_id || row.id)
  const cloudEmployeeId = row.cloud_employee_id || row.id || null
  return {
    ...row,
    id: agentId,
    cloud_employee_id: cloudEmployeeId,
    source: 'cloud',
    type: 'ai',
    openclaw_agent_id: agentId,
    name: normalizeOptionalText(row.name) || agentId || 'AI 员工',
    role: normalizeOptionalText(row.role || row.description) || 'AI 员工',
    description: normalizeOptionalText(row.description),
    emoji: normalizeOptionalText(row.emoji) || null,
    status: normalizeOptionalText(row.runtime_status || row.status) || 'offline',
    runtime_status: normalizeOptionalText(row.runtime_status || row.status) || 'offline',
    host_status: normalizeOptionalText(row.host_status) || 'offline',
    model: normalizeOptionalText(row.default_model || row.model) || null,
    default_model: normalizeOptionalText(row.default_model || row.model) || null,
    openclaw_profile: normalizeProfile(row.openclaw_profile || row.profile_key),
    openclaw_profile_id: row.openclaw_profile_id || null,
    organization_member_id: row.organization_member_id || row.member_id || null,
    is_default: Boolean(row.is_default),
  }
}

function normalizeCloudAiEmployeeRequest(row = {}) {
  if (Array.isArray(row)) return normalizeCloudAiEmployeeRequest(row[0] || {})
  return {
    ...row,
    id: row.id || null,
    organization_id: row.organization_id || null,
    organization_member_id: row.organization_member_id || row.member_id || null,
    openclaw_profile_id: row.openclaw_profile_id || null,
    openclaw_profile: normalizeProfile(row.openclaw_profile || row.profile_key),
    name: normalizeOptionalText(row.requested_name || row.name),
    role: normalizeOptionalText(row.requested_role || row.role) || '通用员工',
    description: normalizeOptionalText(row.requested_description || row.description),
    emoji: normalizeOptionalText(row.requested_emoji || row.emoji) || null,
    default_model: normalizeOptionalText(row.requested_default_model || row.default_model || row.model) || null,
    status: normalizeOptionalText(row.status) || 'pending',
    requested_by: row.requested_by || null,
    requester_email: normalizeEmail(row.requester_email || row.member_email || row.email),
    cloud_employee_id: row.cloud_employee_id || null,
    openclaw_agent_id: normalizeOptionalText(row.openclaw_agent_id || row.agent_id),
    failure_message: normalizeOptionalText(row.failure_message),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }
}

function normalizeCloudOrganizationMember(row = {}) {
  if (Array.isArray(row)) return normalizeCloudOrganizationMember(row[0] || {})
  const inviteStatus = normalizeHumanInviteStatus(row.invite_status, Boolean(row.user_id))
  const memberEmail = normalizeEmail(row.member_email || row.email)
  const displayName = normalizeOptionalText(row.display_name || row.member_name || row.name) || memberEmail || '成员'
  const memberRole = normalizeOptionalText(row.member_role) || 'member'
  const runtimeMode = normalizeRuntimeMode(row.runtime_mode || row.runtimeMode)
  return {
    ...row,
    id: row.member_id || row.id,
    organizationId: row.organization_id || null,
    organizationName: normalizeOptionalText(row.organization_name || row.name),
    memberId: row.member_id || row.id || null,
    userId: row.user_id || row.member_user_id || null,
    name: displayName,
    displayName,
    memberEmail,
    memberRole,
    role: memberRole === 'owner' ? '所有者' : memberRole === 'admin' ? '管理员' : '成员',
    inviteStatus,
    status: inviteStatus,
    statusLabel: humanInviteStatusLabel(inviteStatus, Boolean(row.user_id)),
    openclawProfile: normalizeOptionalText(row.openclaw_profile || row.profile_key),
    openclawProfileId: row.openclaw_profile_id || row.profile_id || null,
    profileStatus: normalizeOptionalText(row.profile_status) || 'missing',
    runtimeMode,
    runtime_mode: runtimeMode,
    gatewayStatus: normalizeOptionalText(row.gateway_status) || 'offline',
    gatewayStatusMessage: normalizeOptionalText(row.gateway_status_message || row.status_message),
    gatewayPort: row.gateway_port || null,
    gatewayUrl: normalizeOptionalText(row.gateway_url) || null,
    hostId: row.host_id || null,
    hostStatus: normalizeOptionalText(row.host_status) || 'offline',
  }
}

function resolveEmployeeAgentId(employee = {}) {
  return requireId(
    employee.openclaw_agent_id || employee.employee_id || employee.id,
    'openclaw_agent_id',
  )
}

function normalizeCloudEmployeePayload(ownerId, employee = {}, profile = '') {
  const openclawAgentId = resolveEmployeeAgentId(employee)
  const openclawProfile = normalizeProfile(employee.openclaw_profile || profile)
  if (!openclawProfile) throw new Error('missing_openclaw_profile')
  const payload = {
    owner_id: requireCloudOwnerId(ownerId),
    openclaw_profile: openclawProfile,
    openclaw_agent_id: openclawAgentId,
    name: normalizeOptionalText(employee.name) || openclawAgentId,
    role: normalizeOptionalText(employee.role),
    description: normalizeOptionalText(employee.description),
    emoji: normalizeOptionalText(employee.emoji) || null,
    default_model: normalizeOptionalText(employee.default_model || employee.model) || null,
    status: normalizeOptionalText(employee.status) || 'active',
  }
  if (employee.organization_id) payload.organization_id = employee.organization_id
  if (employee.openclaw_profile_id) payload.openclaw_profile_id = employee.openclaw_profile_id
  if (employee.organization_member_id || employee.member_id) {
    payload.organization_member_id = employee.organization_member_id || employee.member_id
  }
  if (employee.host_id) payload.host_id = employee.host_id
  if (employee.runtime_status) payload.runtime_status = normalizeOptionalText(employee.runtime_status)
  if (employee.last_seen_at) payload.last_seen_at = employee.last_seen_at
  if (typeof employee.is_default === 'boolean') payload.is_default = employee.is_default
  return payload
}

function normalizeGatewayAgentSyncPayload(agent = {}) {
  const openclawAgentId = normalizeOptionalText(agent.openclaw_agent_id || agent.agent_id || agent.id)
  if (!openclawAgentId) return null
  const runtimeStatus = normalizeOptionalText(agent.runtime_status || agent.runtimeStatus || agent.status)
  return {
    openclaw_agent_id: openclawAgentId,
    name: normalizeOptionalText(agent.name) || openclawAgentId,
    role: normalizeOptionalText(agent.role) || 'AI 员工',
    description: normalizeOptionalText(agent.description),
    emoji: normalizeOptionalText(agent.emoji) || null,
    default_model: normalizeOptionalText(agent.default_model || agent.model) || null,
    is_default: agent.is_default === true || agent.isDefault === true,
    runtime_status: ['online', 'offline', 'degraded'].includes(runtimeStatus)
      ? runtimeStatus
      : 'online',
  }
}

function throwIfSupabaseError(error) {
  if (error) throw error
}

const WORKSPACE_SESSION_REFRESH_TIMEOUT_MS = 7_000

function createWorkspaceSessionRefreshTimeoutError(timeoutMs) {
  const error = new Error('登录状态已过期且无法自动刷新，请返回登录页重新登录。')
  error.code = 'workspace_session_refresh_timeout'
  error.status = 401
  error.timeoutMs = timeoutMs
  return error
}

async function refreshWorkspaceSessionWithTimeout(auth, timeoutMs = WORKSPACE_SESSION_REFRESH_TIMEOUT_MS) {
  let timeoutId = null
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(createWorkspaceSessionRefreshTimeoutError(timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([auth.refreshSession(), timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

// WebKit may restore an expired persisted Supabase session after the desktop
// app has been suspended for a while. `getSession()` can return that stale
// token without rotating it before the first RPC, which makes an otherwise
// authorized organization look inaccessible. Refresh it proactively only
// when it is expired (or about to expire) before loading the workspace.
async function refreshWorkspaceSessionIfNeeded(client) {
  const auth = client?.auth
  if (!auth?.getSession || !auth?.refreshSession) return

  const { data, error } = await auth.getSession()
  throwIfSupabaseError(error)
  const expiresAt = Number(data?.session?.expires_at || 0)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return
  if (expiresAt > Math.floor(Date.now() / 1000) + 60) return

  const refreshed = await refreshWorkspaceSessionWithTimeout(auth)
  throwIfSupabaseError(refreshed?.error)
  if (!refreshed?.data?.session?.access_token) {
    const refreshError = new Error('登录状态已过期，请返回登录页重新登录。')
    refreshError.code = 'workspace_session_refresh_failed'
    refreshError.status = 401
    throw refreshError
  }
}

function normalizeHumanInviteStatus(status, hasUserId = false) {
  const value = normalizeOptionalText(status)
  if (value === 'registered' || value === 'pending_registration' || value === 'invited') return value
  return hasUserId ? 'registered' : 'pending_registration'
}

export function humanInviteStatusLabel(status, hasUserId = false) {
  const normalized = normalizeHumanInviteStatus(status, hasUserId)
  if (normalized === 'registered') return '已注册'
  if (normalized === 'invited') return '已邀请'
  return '待注册'
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim())
}

function firstHumanDisplayName(...values) {
  const normalized = values.map(value => normalizeOptionalText(value)).filter(Boolean)
  return normalized.find(value => !looksLikeEmail(value)) || normalized[0] || ''
}

function normalizeHumanEmployeeRow(row = {}) {
  const inviteStatus = normalizeHumanInviteStatus(row.invite_status, Boolean(row.member_user_id))
  const email = normalizeEmail(row.member_email || row.email)
  const direction = normalizeOptionalText(row.direction)
  const counterpartName = firstHumanDisplayName(row.counterpart_name, row.counterpart_nickname, row.counterpart_display_name)
  const counterpartEmail = normalizeEmail(row.counterpart_email)
  const name = firstHumanDisplayName(
    counterpartName,
    row.nickname,
    row.display_name,
    row.member_nickname,
    row.member_display_name,
    row.member_name,
    row.name,
  ) || (direction === 'incoming' ? counterpartEmail : email) || email || '成员'
  const normalized = {
    ...row,
    id: row.id,
    type: 'human',
    source: 'human',
    name,
    role: row.member_role === 'owner' ? '所有者' : '人类员工',
    member_name: name,
    member_email: email,
    invite_status: inviteStatus,
    status: inviteStatus,
    statusLabel: humanInviteStatusLabel(inviteStatus, Boolean(row.member_user_id)),
  }
  if (direction) normalized.direction = direction
  const avatarUrl = normalizeOptionalText(row.avatar_url || row.avatarUrl)
  if (avatarUrl) normalized.avatarUrl = avatarUrl
  return normalized
}

export function buildProjectOwnerPerson(user = {}) {
  const id = String(user?.uid || user?.userId || user?.user_id || user?.member_user_id || user?.id || '').trim()
  if (!id) return null
  const email = normalizeEmail(user.memberEmail || user.member_email || user.email)
  const name = normalizeOptionalText(user.displayName || user.display_name || user.name || user.member_name || user.phone || email) || '所有者'
  return {
    id,
    type: 'human',
    source: 'human',
    name,
    role: '所有者',
    member_name: name,
    member_email: email,
    member_user_id: id,
    member_role: 'owner',
    access_level: 'owner',
    invite_status: 'registered',
    status: 'registered',
    statusLabel: '已注册',
    is_project_owner: true,
  }
}

export function mergeProjectPeopleWithOwner(people = [], user = {}, projectOwner = user) {
  const owner = buildProjectOwnerPerson(projectOwner || user)
  const rows = Array.isArray(people) ? people : []
  if (!owner) return rows

  const ownerKeys = new Set([owner.member_user_id, owner.member_email].filter(Boolean).map(String))
  const merged = [owner]
  for (const person of rows) {
    const keys = [person?.member_user_id, person?.user_id, person?.member_email, person?.email, person?.id]
      .filter(Boolean)
      .map(String)
    if (keys.some(key => ownerKeys.has(key))) continue
    merged.push(person)
  }
  return merged
}

function normalizeJsonArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeCurrentUserIdentity(currentUser = '') {
  if (currentUser && typeof currentUser === 'object') {
    return {
      id: String(currentUser.uid || currentUser.id || '').trim(),
      email: normalizeEmail(currentUser.email),
    }
  }
  return {
    id: String(currentUser || '').trim(),
    email: '',
  }
}

function normalizeCloudHumanMessage(row = {}, currentUser = '') {
  const current = normalizeCurrentUserIdentity(currentUser)
  const senderId = String(row.sender_user_id || '').trim()
  const senderEmail = normalizeEmail(row.sender_email || row.email)
  const senderName = normalizeOptionalText(row.sender_name)
  const senderNameEmail = senderName.includes('@') ? normalizeEmail(senderName) : ''
  const mine = Boolean(
    (senderId && current.id && senderId === current.id) ||
    (current.email && senderEmail && senderEmail === current.email) ||
    (current.email && senderNameEmail && senderNameEmail === current.email),
  )
  const createdAt = row.created_at ? new Date(row.created_at).getTime() : Date.now()
  return {
    id: row.id || crypto.randomUUID(),
    role: mine ? 'user' : 'assistant',
    content: String(row.content || ''),
    attachments: normalizeJsonArray(row.attachments),
    createdAt: Number.isNaN(createdAt) ? Date.now() : createdAt,
    status: 'sent',
    senderUserId: senderId || null,
    senderName: senderName || (mine ? '你' : '对方'),
  }
}

function buildAppUrl(appUrl) {
  const explicit = normalizeOptionalText(appUrl)
  if (explicit) return explicit
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
  return 'Uniopc'
}

export function buildHumanInviteMailto(member = {}, options = {}) {
  const email = normalizeEmail(member.member_email || member.email)
  if (!email) throw new Error('missing_member_email')
  const name = normalizeOptionalText(member.member_name || member.name) || email
  const inviterName = normalizeOptionalText(options.inviterName) || 'Uniopc'
  const appUrl = buildAppUrl(options.appUrl)
  const inviteStatus = normalizeHumanInviteStatus(member.invite_status, Boolean(member.member_user_id))
  const actionText = inviteStatus === 'registered' ? '登录 Uniopc' : '注册或登录 Uniopc'
  const subject = `${inviterName} 邀请你加入 Uniopc`
  const body = [
    `${name}，你好：`,
    '',
    `${inviterName} 邀请你作为人类员工加入 Uniopc 工作空间。`,
    `请${actionText}后查看你的项目协作入口：${appUrl}`,
    '',
    '谢谢。',
  ].join('\n')
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export async function listCloudProjects(client, ownerId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client
    .from('cloud_projects')
    .select('*')
    .order('sort_order', { ascending: true })
  throwIfSupabaseError(error)
  return Array.isArray(data) ? data : []
}

export async function createCloudProject(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('create_cloud_project', {
    p_name: requireProjectName(input.name),
    p_description: normalizeDescription(input.description),
  })
  throwIfSupabaseError(error)
  return data
}

export async function updateCloudProject(client, ownerId, projectId, input = {}) {
  const owner = requireCloudOwnerId(ownerId)
  const id = requireId(projectId, 'project_id')
  const payload = {
    name: requireProjectName(input.name),
    description: normalizeDescription(input.description),
  }
  const { data, error } = await client
    .from('cloud_projects')
    .update(payload)
    .eq('id', id)
    .eq('owner_id', owner)
    .select('*')
    .single()
  throwIfSupabaseError(error)
  return data
}

export async function deleteCloudProject(client, ownerId, projectId) {
  const owner = requireCloudOwnerId(ownerId)
  const id = requireId(projectId, 'project_id')
  const { error } = await client
    .from('cloud_projects')
    .delete()
    .eq('id', id)
    .eq('owner_id', owner)
  throwIfSupabaseError(error)
}

export async function ensureCloudOrganization(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('ensure_cloud_organization', {
    p_name: normalizeOptionalText(input.name) || null,
    p_organization_type_id: normalizeOptionalText(input.organizationTypeId || input.organization_type_id) || null,
  })
  throwIfSupabaseError(error)
  return normalizeCloudWorkspaceProfile(data)
}

export async function listCloudOrganizationTypes(client, ownerId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('list_cloud_organization_types', {})
  throwIfSupabaseError(error)
  return (Array.isArray(data) ? data : []).map(normalizeOrganizationType)
}

export async function updateMyCloudOrganizationName(client, ownerId, name) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('update_my_cloud_organization_name', {
    p_name: normalizeOptionalText(name),
  })
  throwIfSupabaseError(error)
  return normalizeCloudWorkspaceProfile(data)
}

export async function listMyOrganizationPluginEntitlements(client, ownerId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('list_my_organization_plugin_entitlements', {})
  throwIfSupabaseError(error)
  return (Array.isArray(data) ? data : []).map(normalizeOrganizationPluginEntitlement)
}

export async function listCloudProfilePluginAssignments(client, ownerId, openclawProfileId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client
    .from('cloud_profile_plugin_assignments')
    .select('id, organization_id, member_id, openclaw_profile_id, plugin_id, desired_version, desired_enabled, observed_status, observed_version, observed_enabled, observed_sha256, drift_status, status, last_error, observed_at, updated_at')
    .eq('openclaw_profile_id', requireId(openclawProfileId, 'openclaw_profile_id'))
    .order('updated_at', { ascending: false })
  throwIfSupabaseError(error)
  return (Array.isArray(data) ? data : []).map(normalizeCloudProfilePluginAssignment)
}

export async function authorizeCloudPluginInstall(client, ownerId, openclawProfileId, pluginId, version = 'latest') {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('authorize_cloud_plugin_install', {
    p_plugin_id: requireId(pluginId, 'plugin_id'),
    p_openclaw_profile_id: requireId(openclawProfileId, 'openclaw_profile_id'),
    p_version: normalizeOptionalText(version) || 'latest',
  })
  throwIfSupabaseError(error)
  const row = Array.isArray(data) ? data[0] || {} : data || {}
  return {
    ...normalizeCloudProfilePluginAssignment(row),
    // Artifact coordinates for the cloud-distribution install: download the
    // package from plugin-artifacts and verify it against this sha256.
    version: normalizeOptionalText(row.version),
    artifactPath: normalizeOptionalText(row.artifact_path || row.artifactPath),
    artifactUrl: normalizeOptionalText(row.artifact_url || row.artifactUrl),
    artifactSha256: normalizeOptionalText(row.artifact_sha256 || row.artifactSha256),
  }
}

export async function downloadCloudPluginArtifactBase64(client, artifactPath) {
  const path = normalizeOptionalText(artifactPath)
  if (!path) throw new Error('缺少插件安装包路径 artifact_path')
  const { data, error } = await client.storage.from('plugin-artifacts').download(path)
  throwIfSupabaseError(error)
  if (!data) throw new Error('插件安装包下载失败')
  const buffer = new Uint8Array(await data.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export async function reportCloudProfilePluginObservation(client, ownerId, openclawProfileId, observation = {}) {
  requireCloudOwnerId(ownerId)
  const pluginId = requireId(observation.pluginId || observation.plugin_id, 'plugin_id')
  const observedStatus = normalizeOptionalText(observation.observedStatus || observation.observed_status) || 'unknown'
  const { data, error } = await client.rpc('report_cloud_profile_plugin_observation', {
    p_openclaw_profile_id: requireId(openclawProfileId, 'openclaw_profile_id'),
    p_plugin_id: pluginId,
    p_observed_status: observedStatus,
    p_observed_version: normalizeOptionalText(observation.observedVersion || observation.observed_version),
    p_observed_enabled: observation.observedEnabled ?? observation.observed_enabled ?? null,
    p_observed_sha256: normalizeOptionalText(observation.observedSha256 || observation.observed_sha256),
    p_observed_device_id: observation.observedDeviceId || observation.observed_device_id || null,
    p_error: normalizeOptionalText(observation.error || observation.lastError || observation.last_error),
  })
  throwIfSupabaseError(error)
  return normalizeCloudProfilePluginAssignment(data)
}

export async function getMyWorkspacePluginPolicyBootstrap(client, ownerId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('get_my_workspace_plugin_policy_bootstrap', {})
  throwIfSupabaseError(error)
  return normalizeWorkspacePluginPolicyBootstrap(data)
}

export async function getMyCloudWorkspaceProfile(client, ownerId) {
  requireCloudOwnerId(ownerId)
  await refreshWorkspaceSessionIfNeeded(client)
  const { data, error } = await client.rpc('get_my_cloud_workspace_profile', {})
  throwIfSupabaseError(error)
  return normalizeCloudWorkspaceProfile(data)
}

export async function acceptRegisteredCloudOrganizationInvite(client, ownerId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('accept_registered_cloud_organization_invite', {})
  throwIfSupabaseError(error)
  if (!data) return null
  return { ...data, uid: data.id }
}

export async function getMyOpenClawProfileAccess(client, ownerId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('get_my_openclaw_profile_access', {})
  throwIfSupabaseError(error)
  return normalizeOpenClawProfileAccess(data)
}

export async function createMemberOpenClawProfile(client, ownerId, memberId, input = {}) {
  requireCloudOwnerId(ownerId)
  const id = requireId(memberId, 'member_id')
  const { data, error } = await client.rpc('create_member_openclaw_profile', {
    p_member_id: id,
    p_profile_key: normalizeProfileKey(
      input.profile || input.profileKey || buildMemberOpenClawProfileKey({ ...input, memberId: id }),
    ),
    p_runtime_mode: normalizeRuntimeMode(input.runtimeMode || input.runtime_mode),
  })
  throwIfSupabaseError(error)
  return normalizeCloudWorkspaceProfile(data)
}

export async function registerOpenClawProfileHost(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('register_openclaw_profile_host', {
    p_openclaw_profile_id: requireId(input.openclawProfileId || input.openclaw_profile_id, 'openclaw_profile_id'),
    p_host_name: normalizeOptionalText(input.hostName || input.host_name) || null,
    p_gateway_port: input.gatewayPort || input.gateway_port || null,
    p_gateway_url: normalizeOptionalText(input.gatewayUrl || input.gateway_url) || null,
    p_gateway_status: normalizeOptionalText(input.gatewayStatus || input.gateway_status) || 'online',
    p_status_message: normalizeOptionalText(input.statusMessage || input.status_message || input.gatewayStatusMessage || input.gateway_status_message) || null,
  })
  throwIfSupabaseError(error)
  return normalizeCloudWorkspaceProfile(data)
}

export async function getMyOpenClawProfilePairingSetup(client, ownerId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('get_my_openclaw_profile_pairing_setup', {})
  throwIfSupabaseError(error)
  if (!data) return null
  return normalizeOpenClawProfilePairingSetup(data)
}

// Publish a freshly-minted setup code + reachable gateway URL to the cloud so a
// signed-in phone can fetch it (login-discovery) and connect directly. The code
// carries the one-time bootstrapToken; the cloud row expires (default 30 min).
export async function publishOpenClawProfilePairingSetup(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('publish_openclaw_profile_pairing_setup', {
    p_openclaw_profile_id: requireId(input.openclawProfileId || input.openclaw_profile_id, 'openclaw_profile_id'),
    p_setup_code: normalizeOptionalText(input.setupCode || input.setup_code) || '',
    p_gateway_url: normalizeOptionalText(input.gatewayUrl || input.gateway_url) || null,
    p_expires_in_minutes: input.expiresInMinutes || input.expires_in_minutes || 30,
  })
  throwIfSupabaseError(error)
  if (!data) return null
  return normalizeOpenClawProfilePairingSetup(data)
}

export async function registerMemberDevice(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('register_member_device', {
    p_device_type: 'desktop',
    p_device_name: normalizeOptionalText(input.deviceName || input.device_name) || null,
    p_device_platform: normalizeOptionalText(input.devicePlatform || input.device_platform) || null,
    p_device_fingerprint: normalizeOptionalText(input.deviceFingerprint || input.device_fingerprint) || null,
  })
  throwIfSupabaseError(error)
  return normalizeMemberDevice(data)
}

export async function getMyMemberClientBootstrap(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('get_my_member_client_bootstrap', {
    p_device_id: normalizeOptionalText(input.deviceId || input.device_id) || null,
  })
  throwIfSupabaseError(error)
  return normalizeMemberClientBootstrap(data)
}

export async function assignMemberGateway(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('assign_member_gateway', {
    p_member_id: requireId(input.memberId || input.member_id, 'member_id'),
    p_device_id: normalizeOptionalText(input.deviceId || input.device_id) || null,
    p_host_id: requireId(input.hostId || input.host_id, 'host_id'),
    p_openclaw_profile_id: requireId(input.openclawProfileId || input.openclaw_profile_id, 'openclaw_profile_id'),
    p_gateway_url: null,
    p_access_mode: 'direct',
    p_transport: 'direct',
    p_ssh_target: null,
    p_ssh_remote_host: null,
    p_ssh_remote_port: null,
    p_ssh_local_port: null,
  })
  throwIfSupabaseError(error)
  return normalizeGatewayAssignment(data)
}

export async function grantMemberAgentPermission(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('grant_member_agent_permission', {
    p_member_id: requireId(input.memberId || input.member_id, 'member_id'),
    p_openclaw_profile_id: requireId(input.openclawProfileId || input.openclaw_profile_id, 'openclaw_profile_id'),
    p_openclaw_agent_id: requireId(input.openclawAgentId || input.openclaw_agent_id, 'openclaw_agent_id'),
    p_project_id: normalizeOptionalText(input.projectId || input.project_id) || null,
    p_can_chat: input.canChat ?? input.can_chat ?? true,
    p_can_run_tasks: input.canRunTasks ?? input.can_run_tasks ?? true,
    p_can_read_documents: input.canReadDocuments ?? input.can_read_documents ?? true,
    p_can_write_documents: input.canWriteDocuments ?? input.can_write_documents ?? false,
    p_can_use_tools: input.canUseTools ?? input.can_use_tools ?? false,
    p_capabilities: input.capabilities && typeof input.capabilities === 'object' ? input.capabilities : {},
  })
  throwIfSupabaseError(error)
  return normalizeMemberClientAgent(data)
}

export async function getMemberClientAdminSummary(client, ownerId, memberId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('get_member_client_admin_summary', {
    p_member_id: requireId(memberId, 'member_id'),
  })
  throwIfSupabaseError(error)
  return normalizeMemberClientAdminSummary(data)
}

export async function revokeMemberGatewayAssignment(client, ownerId, assignmentId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('revoke_member_gateway_assignment', {
    p_assignment_id: requireId(assignmentId, 'assignment_id'),
  })
  throwIfSupabaseError(error)
  return normalizeGatewayAssignment(data)
}

export async function revokeMemberAgentPermission(client, ownerId, permissionId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('revoke_member_agent_permission', {
    p_permission_id: requireId(permissionId, 'permission_id'),
  })
  throwIfSupabaseError(error)
  return normalizeMemberClientAgent(data)
}

export async function listCloudOrganizationMembers(client, ownerId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('list_cloud_organization_members', {})
  throwIfSupabaseError(error)
  return (Array.isArray(data) ? data : []).map(normalizeCloudOrganizationMember)
}

export async function inviteCloudOrganizationMember(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const email = normalizeEmail(input.email)
  if (!email) throw new Error('missing_member_email')
  const { data, error } = await client.rpc('invite_cloud_organization_member', {
    p_email: email,
    p_name: normalizeOptionalText(input.name) || email,
    p_runtime_mode: normalizeRuntimeMode(input.runtimeMode || input.runtime_mode),
  })
  throwIfSupabaseError(error)
  return normalizeCloudOrganizationMember(data)
}

export async function listMyCloudAiEmployees(client, ownerId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('list_my_cloud_ai_employees', {})
  throwIfSupabaseError(error)
  return (Array.isArray(data) ? data : []).map(normalizeCloudAiEmployee)
}

export async function syncMyCloudAiEmployees(client, ownerId, agents = []) {
  requireCloudOwnerId(ownerId)
  const p_agents = (Array.isArray(agents) ? agents : [])
    .map(normalizeGatewayAgentSyncPayload)
    .filter(Boolean)
  const { data, error } = await client.rpc('sync_my_cloud_ai_employees', { p_agents })
  throwIfSupabaseError(error)
  return (Array.isArray(data) ? data : []).map(normalizeCloudAiEmployee)
}

export async function requestCloudAiEmployeeCreation(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('request_cloud_ai_employee_creation', {
    p_name: requireId(input.name, 'name'),
    p_role: normalizeOptionalText(input.role) || '通用员工',
    p_description: normalizeOptionalText(input.description),
    p_emoji: normalizeOptionalText(input.emoji) || null,
    p_default_model: normalizeOptionalText(input.default_model || input.model) || null,
  })
  throwIfSupabaseError(error)
  return normalizeCloudAiEmployeeRequest(data)
}

export async function listMyCloudAiEmployeeRequests(client, ownerId) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('list_my_cloud_ai_employee_requests', {})
  throwIfSupabaseError(error)
  return (Array.isArray(data) ? data : []).map(normalizeCloudAiEmployeeRequest)
}

export async function approveCloudAiEmployeeCreationRequest(client, ownerId, input = {}) {
  requireCloudOwnerId(ownerId)
  const { data, error } = await client.rpc('approve_cloud_ai_employee_creation_request', {
    p_request_id: requireId(input.requestId || input.id, 'request_id'),
    p_cloud_employee_id: input.cloudEmployeeId || input.cloud_employee_id || null,
    p_openclaw_agent_id: requireId(input.openclawAgentId || input.openclaw_agent_id, 'openclaw_agent_id'),
    p_failure_message: normalizeOptionalText(input.failureMessage || input.failure_message) || null,
  })
  throwIfSupabaseError(error)
  return normalizeCloudAiEmployeeRequest(data)
}

export async function upsertCloudEmployee(client, ownerId, employee = {}, profile = '') {
  const payload = normalizeCloudEmployeePayload(ownerId, employee, profile)
  const { data, error } = await client
    .from('cloud_employees')
    .upsert(payload, { onConflict: 'owner_id,openclaw_profile,openclaw_agent_id' })
    .select('*')
    .single()
  throwIfSupabaseError(error)
  return data
}

export async function addCloudProjectEmployee(client, ownerId, projectId, employee = {}, profile = '') {
  const owner = requireCloudOwnerId(ownerId)
  const id = requireId(projectId, 'project_id')
  const cloudEmployee = await upsertCloudEmployee(client, owner, employee, profile)
  const payload = {
    owner_id: owner,
    project_id: id,
    member_type: 'ai_employee',
    member_user_id: null,
    cloud_employee_id: cloudEmployee.id,
    organization_id: cloudEmployee.organization_id || null,
    organization_member_id: cloudEmployee.organization_member_id || null,
    openclaw_profile_id: cloudEmployee.openclaw_profile_id || null,
    openclaw_profile: cloudEmployee.openclaw_profile,
    openclaw_agent_id: cloudEmployee.openclaw_agent_id,
    member_name: cloudEmployee.name || cloudEmployee.openclaw_agent_id,
    member_role: 'ai_employee',
    access_level: 'write',
  }
  const { data, error } = await client
    .from('cloud_project_members')
    .upsert(payload, { onConflict: 'project_id,cloud_employee_id' })
    .select('*')
    .single()
  throwIfSupabaseError(error)
  return data
}

function cloudEmployeeMatchesProjectMember(row = {}, employee = {}) {
  const rowProfileId = normalizeOptionalText(row.openclaw_profile_id)
  const employeeProfileId = normalizeOptionalText(employee.openclaw_profile_id)
  if (rowProfileId || employeeProfileId) {
    return Boolean(rowProfileId && employeeProfileId && rowProfileId === employeeProfileId)
  }

  const rowProfile = normalizeOptionalText(row.openclaw_profile)
  const employeeProfile = normalizeOptionalText(employee.openclaw_profile)
  if (rowProfile || employeeProfile) {
    return Boolean(rowProfile && employeeProfile && rowProfile === employeeProfile)
  }

  return !row.cloud_employee_id
}

function attachCloudEmployeeToProjectMember(row = {}, employeeRows = []) {
  const employeesById = new Map(employeeRows.map(employee => [employee.cloud_employee_id || employee.id, employee]))
  const employeesByAgentId = new Map()
  for (const employee of employeeRows) {
    const key = employee.openclaw_agent_id
    if (!key) continue
    const existing = employeesByAgentId.get(key) || []
    existing.push(employee)
    employeesByAgentId.set(key, existing)
  }
  const exactEmployee = row.cloud_employee_id ? employeesById.get(row.cloud_employee_id) : null
  const fallbackEmployee = !exactEmployee
    ? (employeesByAgentId.get(row.openclaw_agent_id) || [])
      .find(candidate => cloudEmployeeMatchesProjectMember(row, candidate))
    : null
  const employee = exactEmployee || fallbackEmployee || null
  return {
    ...row,
    employee,
    organization_member_id: row.organization_member_id || employee?.organization_member_id || null,
    openclaw_profile_id: row.openclaw_profile_id || employee?.openclaw_profile_id || null,
    openclaw_profile: normalizeOptionalText(row.openclaw_profile || employee?.openclaw_profile),
    name: employee?.name || row.openclaw_agent_id || 'AI 员工',
    role: employee?.role || employee?.description || 'AI 员工',
  }
}

export async function listCloudProjectMemberships(client, ownerId, projectIds = []) {
  requireCloudOwnerId(ownerId)
  const ids = [...new Set((Array.isArray(projectIds) ? projectIds : [])
    .map(projectId => normalizeOptionalText(projectId))
    .filter(Boolean))]
  const empty = new Map(ids.map(projectId => [projectId, { employees: [], people: [] }]))
  if (ids.length === 0) return empty

  const { data, error } = await client
    .from('cloud_project_members')
    .select('*')
    .in('project_id', ids)
    .order('created_at', { ascending: true })
  throwIfSupabaseError(error)

  const rows = Array.isArray(data) ? data : []
  const aiRows = rows.filter(row => row.member_type === 'ai_employee')
  const needsEmployeeRows = aiRows.some(row => row.cloud_employee_id || row.openclaw_agent_id)
  const employeeRows = needsEmployeeRows ? await listMyCloudAiEmployees(client, ownerId) : []
  const grouped = new Map(empty)

  for (const row of rows) {
    const projectId = normalizeOptionalText(row.project_id)
    if (!projectId) continue
    const entry = grouped.get(projectId) || { employees: [], people: [] }
    if (row.member_type === 'ai_employee') {
      entry.employees.push(attachCloudEmployeeToProjectMember(row, employeeRows))
    } else if (row.member_type === 'user') {
      entry.people.push({
        ...normalizeHumanEmployeeRow(row),
        role: row.member_role === 'owner' ? '所有者' : '成员',
      })
    }
    grouped.set(projectId, entry)
  }

  return grouped
}

export async function listCloudProjectEmployees(client, ownerId, projectId) {
  requireCloudOwnerId(ownerId)
  const id = requireId(projectId, 'project_id')
  const { data: memberRows, error: memberError } = await client
    .from('cloud_project_members')
    .select('*')
    .eq('project_id', id)
    .eq('member_type', 'ai_employee')
    .order('created_at', { ascending: true })
  throwIfSupabaseError(memberError)

  const members = Array.isArray(memberRows) ? memberRows : []
  const employeeIds = [...new Set(members.map(row => row.cloud_employee_id).filter(Boolean))]
  const agentIds = [...new Set(members.map(row => row.openclaw_agent_id).filter(Boolean))]
  if (employeeIds.length === 0 && agentIds.length === 0) {
    return members.map(row => ({ ...row, employee: null }))
  }

  const employeeRows = await listMyCloudAiEmployees(client, ownerId)
  return members.map(row => attachCloudEmployeeToProjectMember(row, employeeRows))
}

export async function removeCloudProjectEmployee(client, ownerId, projectId, openclawAgentId, options = {}) {
  const owner = requireCloudOwnerId(ownerId)
  const id = requireId(projectId, 'project_id')
  const agentId = requireId(openclawAgentId, 'openclaw_agent_id')
  let query = client
    .from('cloud_project_members')
    .delete()
    .eq('owner_id', owner)
    .eq('project_id', id)
    .eq('member_type', 'ai_employee')
    .eq('openclaw_agent_id', agentId)
  const profile = normalizeOptionalText(options.openclawProfile || options.openclaw_profile)
  if (profile) query = query.eq('openclaw_profile', profile)
  const { error } = await query
  throwIfSupabaseError(error)
}

export async function addCloudProjectPerson(client, ownerId, projectId, input = {}) {
  requireCloudOwnerId(ownerId)
  const id = requireId(projectId, 'project_id')
  const email = normalizeEmail(input.email)
  if (!email) throw new Error('missing_member_email')
  const { data, error } = await client.rpc('add_cloud_project_human_member', {
    p_project_id: id,
    p_email: email,
    p_name: normalizeOptionalText(input.name) || email,
  })
  throwIfSupabaseError(error)
  return normalizeHumanEmployeeRow(data)
}

export async function listCloudProjectPeople(client, ownerId, projectId) {
  requireCloudOwnerId(ownerId)
  const id = requireId(projectId, 'project_id')
  const { data, error } = await client
    .from('cloud_project_members')
    .select('*')
    .eq('project_id', id)
    .eq('member_type', 'user')
    .order('created_at', { ascending: true })
  throwIfSupabaseError(error)
  return (Array.isArray(data) ? data : []).map(row => ({
    ...normalizeHumanEmployeeRow(row),
    role: row.member_role === 'owner' ? '所有者' : '成员',
  }))
}

export async function removeCloudProjectMember(client, ownerId, memberId) {
  const owner = requireCloudOwnerId(ownerId)
  const id = requireId(memberId, 'member_id')
  const { error } = await client
    .from('cloud_project_members')
    .delete()
    .eq('id', id)
    .eq('owner_id', owner)
  throwIfSupabaseError(error)
}
