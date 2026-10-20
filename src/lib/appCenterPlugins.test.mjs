import test from 'node:test'
import assert from 'node:assert/strict'
import * as appCenterPlugins from './appCenterPlugins.js'
import {
  buildPluginGrantStatuses,
  buildCustomPluginPresets,
  mergeBuiltInPluginPresets,
  isPluginActionBusy,
  pluginTabCountLabel,
  buildAuthorizedAppPresets,
  buildKnownPluginIds,
  buildOpenClawMarketplacePluginPresets,
  buildProfilePluginCapabilities,
  apiKeyCredentialState,
  connectorNeedsCredentialInput,
  derivePluginLifecycle,
  openClawMarketplaceInstallState,
  withOpenClawMarketplaceInstallStatus,
  pluginEntitlementStatus,
  pluginForceUpdateRequired,
  pluginGatewayStatus,
  pluginUpdateStatus,
  profileCapabilityActionLabel,
  stripEngineStartupNoise,
  profileCapabilityStatusLabel,
  resolvePluginReadiness,
  toolPluginDocsActionLabel,
  toolPluginInstallActionLabel,
  toolPluginInstallDetail,
} from './appCenterPlugins.js'

test('plugin cards remain disabled for install, download, and update actions', () => {
  assert.equal(isPluginActionBusy('uniopc-local-workspace', 'uniopc-local-workspace'), true)
  assert.equal(isPluginActionBusy('uniopc-local-workspace', 'uniopc-local-workspace:download'), true)
  assert.equal(isPluginActionBusy('uniopc-local-workspace', 'uniopc-local-workspace:update'), true)
  assert.equal(isPluginActionBusy('uniopc-local-workspace', 'uniopc-documents:update'), false)
})

test('plugin tab counts show a placeholder until the cloud catalog resolves', () => {
  assert.equal(pluginTabCountLabel(1, false), '…')
  assert.equal(pluginTabCountLabel(12, true), '12')
})

test('split cloud plugins install by artifact id while authenticating against the shared runtime', () => {
  const identity = typeof appCenterPlugins.resolveCloudPluginLifecycleIds === 'function'
    ? appCenterPlugins.resolveCloudPluginLifecycleIds({
        id: 'uniopc-superip-monologue',
        runtimePluginId: 'uniopc-superip',
      })
    : null

  assert.deepEqual(identity, {
    installPluginId: 'uniopc-superip-monologue',
    runtimePluginId: 'uniopc-superip',
  })
})

test('configured API-key connectors enable without reopening credential input', () => {
  assert.equal(connectorNeedsCredentialInput({ credentialState: 'configured' }), false)
  assert.equal(connectorNeedsCredentialInput({ credentialState: 'partially_configured' }), true)
  assert.equal(connectorNeedsCredentialInput({ credentialState: 'unconfigured' }), true)
  assert.equal(connectorNeedsCredentialInput({ credentialState: 'configured' }, { reconfigure: true }), true)
})

test('API-key credential state aggregates every declared connector', () => {
  assert.equal(apiKeyCredentialState([]), '')
  assert.equal(apiKeyCredentialState([{ authType: 'api-key', credentialState: 'configured' }]), 'configured')
  assert.equal(apiKeyCredentialState([
    { authType: 'api-key', credentialState: 'configured' },
    { authType: 'api-key', credentialState: 'partially_configured' },
  ]), 'partially_configured')
  assert.equal(apiKeyCredentialState([
    { authType: 'api-key', credentialState: 'configured' },
    { authType: 'api-key', credentialState: 'unconfigured' },
  ]), 'unconfigured')
})

test('saved API-key credentials turn an unknown engine state into direct enable', () => {
  const readiness = resolvePluginReadiness({ entitlementState: 'active', gatewayState: 'unknown' }, {
    entitlementState: 'active',
    gatewayState: 'unknown',
    credentialState: 'configured',
  })
  assert.equal(readiness.primaryAction, 'enable')
  assert.equal(readiness.primaryLabel, '启用插件')
  assert.deepEqual(readiness.statusItems.find(item => item.label === '凭据状态'), {
    label: '凭据状态', value: '凭据已保存',
  })
})

test('unpublished catalog plugins remain visible but cannot start an install flow', () => {
  const readiness = resolvePluginReadiness({
    releaseState: 'unpublished',
    entitlementState: 'active',
    gatewayState: 'not_installed',
  }, {
    entitlementState: 'active',
    gatewayState: 'not_installed',
  })

  assert.equal(readiness.state, 'unpublished')
  assert.equal(readiness.primaryLabel, '暂未发布')
  assert.equal(readiness.disabled, true)
  assert.deepEqual(readiness.statusItems.find(item => item.label === '发布状态'), {
    label: '发布状态', value: '未发布',
  })
})

const catalog = [
  {
    id: 'uniopc-socials',
    title: '公域流量',
    provider: '',
    description: 'Catalog description',
    tags: ['Plugin'],
  },
  {
    id: '@openclaw/codex',
    title: 'Uniopc 引擎 Codex',
    provider: 'Uniopc 引擎',
    description: 'Codex plugin',
  },
  {
    id: 'uniopc-cloud-workspace',
    title: '工作区',
    provider: '',
    description: 'Cloud workspace plugin',
  },
  {
    id: 'uniopc-private-conversion',
    title: '私域转化',
    provider: '',
    description: 'Private conversion plugin',
    managementRoute: 'workbench/private-conversion',
  },
]

test('profile plugin capabilities only include enabled profile plugins', () => {
  assert.deepEqual(
    buildProfilePluginCapabilities([
      { id: 'uniopc-socials', enabled: true, status: 'ready' },
      { id: '@openclaw/codex', enabled: false, status: 'disabled' },
    ], catalog).map(plugin => plugin.id).sort(),
    ['uniopc-cloud-workspace', 'uniopc-socials'],
  )
})

test('authorized app presets only include active organization entitlements', () => {
  const presets = buildAuthorizedAppPresets([
    { pluginId: 'uniopc-cloud-workspace', status: 'active' },
    { pluginId: 'uniopc-socials', status: 'active' },
    { pluginId: 'uniopc-private-conversion', status: 'active' },
    { pluginId: '@openclaw/codex', status: 'suspended' },
  ], catalog)

  assert.deepEqual(presets.map(plugin => plugin.id), ['uniopc-socials', 'uniopc-cloud-workspace', 'uniopc-private-conversion'])
})

test('plugin entitlement status distinguishes visible but unauthorized plugins', () => {
  assert.deepEqual(
    pluginEntitlementStatus({ id: 'uniopc-socials' }, [{ pluginId: 'uniopc-socials', status: 'active' }]),
    { state: 'active', label: '已授权' },
  )
  assert.deepEqual(
    pluginEntitlementStatus({ id: '@openclaw/codex' }, [{ pluginId: 'uniopc-socials', status: 'active' }]),
    { state: 'missing', label: '没有权限' },
  )
  assert.deepEqual(
    pluginEntitlementStatus({ id: 'uniopc-documents', defaultEntitlement: true }, []),
    { state: 'active', label: '默认授权' },
  )
})

test('plugin gateway status uses Uniopc 引擎 profile snapshot as installation source', () => {
  const status = pluginGatewayStatus({ id: 'uniopc-socials' }, [
    { id: 'uniopc-socials', enabled: true, status: 'ready', pluginPath: '/plugins/uniopc-socials' },
  ])

  assert.deepEqual(status, {
    state: 'ready',
    label: '可用',
    detail: '/plugins/uniopc-socials',
  })
})

test('plugin gateway status uses the single Uniopc cloud workspace id', () => {
  const status = pluginGatewayStatus({ id: 'uniopc-cloud-workspace' }, [
    { id: 'uniopc-cloud-workspace', enabled: true, status: 'ready', pluginPath: '/plugins/uniopc-cloud-workspace' },
  ])

  assert.deepEqual(status, {
    state: 'ready',
    label: '可用',
    detail: '/plugins/uniopc-cloud-workspace',
  })
})

test('a split plugin does not inherit the legacy runtime plugin local state', () => {
  const status = pluginGatewayStatus({
    id: 'uniopc-superip-monologue',
    runtimePluginId: 'uniopc-superip',
    managementRoute: 'workbench/super-ip',
  }, [
    { id: 'uniopc-superip', enabled: true, status: 'ready', pluginPath: '/plugins/uniopc-superip' },
  ])

  assert.deepEqual(status, { state: 'cloud_action', label: '待启用' })
})

test('plugin gateway status maps MCP server configuration', () => {
  const status = pluginGatewayStatus({ id: 'tikhub-xiaohongshu', requiredMcpServerIds: ['tikhub-xiaohongshu'] }, [], [
    { name: 'tikhub-xiaohongshu' },
  ])

  assert.deepEqual(status, { state: 'ready', label: 'MCP 已配置' })
})

test('custom plugin presets exclude known catalog plugins', () => {
  const presets = buildCustomPluginPresets([
    { id: 'uniopc-socials', title: '公域流量' },
    { id: 'custom-research', title: 'Custom Research' },
  ], ['uniopc-socials'])

  assert.deepEqual(presets.map(item => item.id), ['custom-research'])
  assert.equal(presets[0].provider, '自定义')
})

test('the bundled local workspace is always an official default-authorized preset', () => {
  const presets = mergeBuiltInPluginPresets([])
  const workspace = presets.find(item => item.id === 'uniopc-local-workspace')

  assert.deepEqual(workspace, {
    id: 'uniopc-local-workspace',
    title: '本地工作区',
    description: '让 AI 员工在当前桌面 profile 内读取和编辑本地文档。',
    tags: ['Plugin', 'Local', 'Workspace'],
    catalogSection: 'official',
    sceneCategory: 'workspace',
    defaultEntitlement: true,
    required: true,
    isGlobal: true,
  })
  assert.equal(pluginEntitlementStatus(workspace, []).state, 'active')
  assert.deepEqual(
    buildCustomPluginPresets([{ id: 'uniopc-local-workspace' }], buildKnownPluginIds(presets)),
    [],
  )
})

test('official plugin display metadata uses the Uniopc brand without changing plugin identity', () => {
  const [workspace, plugin] = mergeBuiltInPluginPresets([{
    id: 'uniopc-socials',
    title: 'OpenClaw 公域流量',
    description: '系统内置 OpenClaw 插件，也称小龙虾插件。',
    provider: 'OpenClaw',
    runtimePluginId: 'openclaw-socials',
  }])
  assert.equal(workspace.id, 'uniopc-local-workspace')
  assert.equal(plugin.title, 'Uniopc 公域流量')
  assert.equal(plugin.description, '系统内置 Uniopc 插件，也称Uniopc插件。')
  assert.equal(plugin.provider, 'Uniopc')
  assert.equal(plugin.runtimePluginId, 'openclaw-socials')
})

test('custom plugin presets hide removed or stale official plugins', () => {
  const presets = buildCustomPluginPresets([
    { id: 'imai-short-drama-core', title: 'Uniopc Short Drama Core' },
    { id: 'imai-media-generation', title: 'Uniopc Media Generation' },
    { id: 'custom-research', title: 'Custom Research' },
  ], [])

  assert.deepEqual(presets.map(item => item.id), ['custom-research'])
})

test('custom plugin presets exclude the known official runtime id without aliases', () => {
  const knownPluginIds = buildKnownPluginIds([
    {
      id: 'uniopc-cloud-workspace',
    },
  ])
  const presets = buildCustomPluginPresets([
    { id: 'uniopc-cloud-workspace', title: '云端工作区' },
    { id: 'custom-research', title: 'Custom Research' },
  ], knownPluginIds)

  assert.deepEqual(presets.map(item => item.id), ['custom-research'])
})

test('openclaw marketplace presets map official search results to third-party cards', () => {
  const presets = buildOpenClawMarketplacePluginPresets({
    results: [
      {
        package: {
          name: '@openclaw/kitchen-sink',
          displayName: 'Uniopc 引擎 Kitchen Sink',
          summary: 'Kitchen sink plugin for testing Uniopc 引擎 capabilities.',
          channel: 'official',
          isOfficial: true,
          latestVersion: '0.2.10',
          ownerHandle: 'openclaw',
          runtimeId: 'openclaw-kitchen-sink',
          categories: ['tools'],
          topics: ['testing', 'images'],
          verificationTier: 'source-linked',
        },
      },
    ],
    installedPlugins: [
      {
        id: 'openclaw-kitchen-sink',
        name: '@openclaw/kitchen-sink',
        enabled: false,
        status: 'disabled',
      },
    ],
  }, ['nativekids-picturebook'])

  assert.equal(presets.length, 1)
  assert.equal(presets[0].id, '@openclaw/kitchen-sink')
  assert.equal(presets[0].runtimePluginId, 'openclaw-kitchen-sink')
  assert.equal(presets[0].title, 'Uniopc 引擎 Kitchen Sink')
  assert.equal(presets[0].provider, 'Uniopc 引擎')
  assert.equal(presets[0].catalogSection, 'third-party')
  assert.equal(presets[0].marketplaceSource, 'clawhub')
  assert.equal(presets[0].installSpec, '@openclaw/kitchen-sink')
  assert.equal(presets[0].installState, 'installed_disabled')
  assert.equal(presets[0].actionLabel, '状态')
  assert.deepEqual(presets[0].tags, ['Official', 'tools', 'testing', 'images'])
})

test('openclaw marketplace presets skip entries already owned by cloud catalog', () => {
  const presets = buildOpenClawMarketplacePluginPresets({
    results: [
      {
        package: {
          name: 'nativekids-picturebook',
          displayName: 'Native Kids',
          summary: 'Duplicate catalog row.',
          runtimeId: 'nativekids-picturebook',
        },
      },
    ],
    installedPlugins: [],
  }, ['nativekids-picturebook'])

  assert.deepEqual(presets, [])
})

test('openclaw marketplace install state distinguishes installed, disabled, and missing plugins', () => {
  assert.deepEqual(
    openClawMarketplaceInstallState({ runtimeId: 'plugin-a' }, [{ id: 'plugin-a', enabled: true, status: 'ready' }]),
    { state: 'installed_ready', label: '已安装' },
  )
  assert.deepEqual(
    openClawMarketplaceInstallState({ name: '@openclaw/plugin-b' }, [{ name: '@openclaw/plugin-b', enabled: false, status: 'disabled' }]),
    { state: 'installed_disabled', label: '已安装未启用' },
  )
  assert.deepEqual(
    openClawMarketplaceInstallState({ name: '@openclaw/plugin-c' }, []),
    { state: 'not_installed', label: '可安装' },
  )
})

test('plugin gateway status reads clawhub marketplace install state locally', () => {
  assert.deepEqual(
    pluginGatewayStatus({
      id: '@openclaw/kitchen-sink',
      marketplaceSource: 'clawhub',
      installState: 'not_installed',
      installStatusLabel: '可安装',
    }),
    { state: 'not_installed', label: '可安装' },
  )
  assert.deepEqual(
    pluginGatewayStatus({
      id: '@openclaw/kitchen-sink',
      marketplaceSource: 'clawhub',
      installState: 'installed_ready',
      installStatusLabel: '已安装',
    }),
    { state: 'ready', label: '已安装' },
  )
})

test('curated clawhub catalog presets get local Uniopc 引擎 install status without marketplace search rows', () => {
  const preset = withOpenClawMarketplaceInstallStatus({
    id: '@openclaw/kitchen-sink',
    runtimePluginId: 'openclaw-kitchen-sink',
    marketplaceSource: 'clawhub',
    installSpec: '@openclaw/kitchen-sink',
  }, [
    {
      id: 'openclaw-kitchen-sink',
      name: '@openclaw/kitchen-sink',
      enabled: true,
      status: 'ready',
    },
  ])

  assert.equal(preset.installState, 'installed_ready')
  assert.equal(preset.installStatusLabel, '已安装')
  assert.equal(preset.actionLabel, '状态')
})

test('tool plugin detail copy distinguishes ClawHub packages from Uniopc 引擎 builtin capabilities', () => {
  assert.equal(toolPluginDocsActionLabel({ marketplaceSource: 'clawhub' }), '打开 ClawHub')
  assert.equal(toolPluginInstallActionLabel({
    marketplaceSource: 'clawhub',
    installState: 'not_installed',
  }), '安装到 Uniopc 引擎')
  assert.deepEqual(
    toolPluginInstallDetail({
      marketplaceSource: 'clawhub',
      installCommand: 'openclaw plugins install @openclaw/kitchen-sink',
    }),
    {
      title: '安装命令',
      body: 'openclaw plugins install @openclaw/kitchen-sink',
      mono: true,
    },
  )

  assert.equal(toolPluginDocsActionLabel({ marketplaceSource: 'openclaw_builtin' }), '打开文档')
  assert.equal(toolPluginInstallActionLabel({
    marketplaceSource: 'openclaw_builtin',
    installKind: 'codex_computer_use',
  }), '初始化')
  assert.equal(toolPluginInstallActionLabel({
    marketplaceSource: 'openclaw_builtin',
    installKind: 'bundled_codex_config',
  }), '启用')
  assert.equal(toolPluginInstallActionLabel({
    marketplaceSource: 'openclaw_builtin',
    installKind: 'unknown_builtin',
  }), '')
  assert.deepEqual(
    toolPluginInstallDetail({
      marketplaceSource: 'openclaw_builtin',
      installKind: 'codex_computer_use',
      configPath: 'plugins.entries.codex.config.computerUse',
      installHint: '/codex computer-use install',
    }),
    {
      title: '内置配置',
      body: 'Uniopc 引擎 内置 Codex 能力，可通过 /codex computer-use install 初始化；配置路径 plugins.entries.codex.config.computerUse。',
      mono: false,
    },
  )
})

test('profile plugin capabilities hide stale profile plugins outside organization entitlements', () => {
  const plugins = buildProfilePluginCapabilities([
    { id: 'uniopc-socials', enabled: true, status: 'ready' },
    { id: '@openclaw/codex', enabled: true, status: 'ready' },
  ], catalog, [
    { pluginId: 'uniopc-cloud-workspace', status: 'active' },
    { pluginId: 'uniopc-socials', status: 'active' },
  ])

  assert.deepEqual(plugins.map(plugin => plugin.id), ['uniopc-cloud-workspace', 'uniopc-socials'])
})

test('profile plugin capabilities always include cloud workspace as the foundation app', () => {
  const plugins = buildProfilePluginCapabilities([], catalog)

  assert.deepEqual(plugins.map(plugin => plugin.id), ['uniopc-cloud-workspace'])
  assert.equal(plugins[0].statusLabel, '待同步')
  assert.equal(plugins[0].actionLabel, '查看')
})

test('profile plugin capabilities merge profile runtime status with catalog copy', () => {
  const plugins = buildProfilePluginCapabilities([
    {
      id: 'uniopc-socials',
      enabled: true,
      status: 'missing_env',
      missingEnv: ['UNIOPC_SOCIALS_HOST_CREDENTIAL'],
    },
  ], catalog)
  const plugin = plugins.find(item => item.id === 'uniopc-socials')

  assert.equal(plugin.title, '公域流量')
  assert.equal(plugin.description, 'Catalog description')
  assert.equal(plugin.statusLabel, '待管理员配置')
  assert.equal(plugin.actionLabel, '联系管理员')
  assert.deepEqual(plugin.missingEnv, ['UNIOPC_SOCIALS_HOST_CREDENTIAL'])
})

test('profile plugin capability labels stay member-facing', () => {
  assert.equal(profileCapabilityStatusLabel({ enabled: true, status: 'ready' }), '可用')
  assert.equal(profileCapabilityStatusLabel({ enabled: true, status: 'sync_required' }), '待同步')
  assert.equal(profileCapabilityStatusLabel({ enabled: true, status: 'bridge_disabled' }), '暂不可用')
  assert.equal(profileCapabilityActionLabel({ status: 'ready' }), '查看')
  assert.equal(profileCapabilityActionLabel({ status: 'missing_env' }), '联系管理员')
})

test('plugin lifecycle maps unconfigured plugins to configure and enable', () => {
  const lifecycle = derivePluginLifecycle({
    id: 'uniopc-cloud-workspace',
    entitlementState: 'active',
    gatewayState: 'missing_env',
  }, { hasActiveProfile: true })

  assert.equal(lifecycle.state, 'not_configured')
  assert.equal(lifecycle.primaryAction, 'configure_enable')
  assert.equal(lifecycle.primaryLabel, '配置并启用')
  assert.equal(lifecycle.busyLabel, '启用中...')
  assert.equal(lifecycle.canUninstall, false)
})

test('plugin lifecycle maps stopped plugins to start', () => {
  const lifecycle = derivePluginLifecycle({
    id: 'uniopc-socials',
    entitlementState: 'active',
    gatewayState: 'disabled',
  }, { hasActiveProfile: true })

  assert.equal(lifecycle.state, 'configured_stopped')
  assert.equal(lifecycle.primaryAction, 'start')
  assert.equal(lifecycle.primaryLabel, '启动')
  assert.equal(lifecycle.busyLabel, '启动中...')
})

test('plugin lifecycle maps unhealthy running plugins to repair and restart', () => {
  const lifecycle = derivePluginLifecycle({
    id: 'uniopc-socials',
    entitlementState: 'active',
    gatewayState: 'runtime_blocked',
  }, { hasActiveProfile: true })

  assert.equal(lifecycle.state, 'running_unhealthy')
  assert.equal(lifecycle.primaryAction, 'repair_restart')
  assert.equal(lifecycle.primaryLabel, '修复并重启')
  assert.equal(lifecycle.busyLabel, '重启中...')
  assert.equal(lifecycle.canUninstall, true)
})

test('plugin lifecycle maps not-installed cloud plugins to a download+install action, not repair', () => {
  const lifecycle = derivePluginLifecycle({
    id: 'uniopc-socials',
    entitlementState: 'active',
    gatewayState: 'not_installed',
    distribution: 'cloud',
  }, { hasActiveProfile: true })

  assert.equal(lifecycle.state, 'not_installed')
  assert.equal(lifecycle.primaryAction, 'install')
  assert.equal(lifecycle.primaryLabel, '下载并安装')
  assert.equal(lifecycle.busyLabel, '安装中...')
  assert.equal(lifecycle.canUninstall, false)
})

test('plugin readiness maps a not-installed plugin to install rather than repair_restart', () => {
  const readiness = resolvePluginReadiness({
    id: 'uniopc-socials',
    distribution: 'cloud',
  }, {
    entitlementState: 'active',
    entitlementLabel: '已授权',
    gatewayState: 'not_installed',
    supported: true,
    hasActiveProfile: true,
  })

  assert.equal(readiness.runtime.state, 'missing')
  assert.equal(readiness.primaryAction, 'install')
  assert.equal(readiness.primaryLabel, '下载并安装')
  assert.equal(readiness.canUninstall, false)
})

test('plugin lifecycle maps ready plugins to restart and stop', () => {
  const lifecycle = derivePluginLifecycle({
    id: 'uniopc-socials',
    entitlementState: 'active',
    gatewayState: 'ready',
  }, { hasActiveProfile: true })

  assert.equal(lifecycle.state, 'running_ready')
  assert.equal(lifecycle.primaryAction, 'restart')
  assert.equal(lifecycle.primaryLabel, '重启')
  assert.equal(lifecycle.busyLabel, '重启中...')
  assert.equal(lifecycle.canUninstall, true)
  assert.equal(lifecycle.uninstallLabel, '卸载插件')
})

test('plugin readiness separates entitlement, config, runtime, and primary action', () => {
  const readiness = resolvePluginReadiness({
    id: 'uniopc-socials',
    title: '公域流量',
    managementRoute: '/public-traffic',
  }, {
    entitlementState: 'active',
    entitlementLabel: '已授权',
    gatewayState: 'cloud_action',
    gatewayLabel: '待启用',
    supported: true,
    hasActiveProfile: true,
  })

  assert.deepEqual(readiness.entitlement, {
    state: 'authorized',
    label: '已授权',
  })
  assert.deepEqual(readiness.config, {
    state: 'missing',
    label: '未写入 Uniopc 引擎',
  })
  assert.deepEqual(readiness.runtime, {
    state: 'unchecked',
    label: '未检查',
  })
  assert.equal(readiness.primaryAction, 'configure_enable')
  assert.equal(readiness.primaryLabel, '配置并启用')
  assert.equal(readiness.state, 'needs_configuration')
})

test('plugin readiness opens the management page when a configured plugin is ready', () => {
  const readiness = resolvePluginReadiness({
    id: 'uniopc-private-conversion',
    title: '私域转化',
    managementRoute: '/private-conversion',
  }, {
    entitlementState: 'active',
    entitlementLabel: '已授权',
    gatewayState: 'ready',
    gatewayLabel: '可用',
    supported: true,
    hasActiveProfile: true,
  })

  assert.equal(readiness.config.state, 'written')
  assert.equal(readiness.runtime.state, 'ready')
  assert.equal(readiness.primaryAction, 'open_management')
  assert.equal(readiness.primaryLabel, '打开')
  assert.equal(readiness.canUninstall, true)
})

test('plugin readiness trusts ready runtime capabilities over stale unchecked gateway state', () => {
  const readiness = resolvePluginReadiness({
    id: 'uniopc-cloud-workspace',
    title: '工作区',
  }, {
    entitlementState: 'active',
    entitlementLabel: '全局授权',
    gatewayState: 'unknown',
    gatewayLabel: '待检查',
    toolCapabilityState: 'ready',
    toolCapabilityLabel: '可用',
    supported: true,
    hasActiveProfile: true,
  })

  assert.deepEqual(readiness.config, {
    state: 'written',
    label: '已写入 Uniopc 引擎',
  })
  assert.deepEqual(readiness.runtime, {
    state: 'ready',
    label: '可用',
  })
  assert.equal(readiness.primaryAction, 'restart')
  assert.equal(readiness.primaryLabel, '重启')
})

test('plugin readiness shows a loading state while Gateway status is being checked', () => {
  const readiness = resolvePluginReadiness({
    id: 'uniopc-socials',
    title: '公域流量',
  }, {
    entitlementState: 'active',
    entitlementLabel: '全局授权',
    gatewayState: 'cloud_action',
    gatewayLabel: '待启用',
    supported: true,
    hasActiveProfile: true,
    checkingGateway: true,
  })

  assert.deepEqual(readiness.config, {
    state: 'checking',
    label: '检查中...',
  })
  assert.deepEqual(readiness.runtime, {
    state: 'checking',
    label: '检查中...',
  })
  assert.equal(readiness.primaryAction, 'wait_for_check')
  assert.equal(readiness.primaryLabel, '检查中...')
  assert.equal(readiness.disabled, true)
})

test('plugin readiness does not mark a plugin usable when runtime tools are unavailable', () => {
  const readiness = resolvePluginReadiness({
    id: 'uniopc-socials',
    title: '公域流量',
  }, {
    entitlementState: 'active',
    entitlementLabel: '全局授权',
    gatewayState: 'ready',
    gatewayLabel: '可用',
    toolCapabilityState: 'runtime_inspect_failed',
    toolCapabilityLabel: '服务异常',
    supported: true,
    hasActiveProfile: true,
  })

  assert.deepEqual(readiness.config, {
    state: 'written',
    label: '已写入 Uniopc 引擎',
  })
  assert.deepEqual(readiness.runtime, {
    state: 'failed',
    label: '服务异常',
  })
  assert.equal(readiness.primaryAction, 'repair_restart')
  assert.equal(readiness.primaryLabel, '修复并重启')
  // Without supportsReauthorize the card keeps the single repair action.
  assert.equal(readiness.secondaryAction, undefined)
})

test('plugin readiness offers re-authorization as the primary fix for an unhealthy official plugin', () => {
  const readiness = resolvePluginReadiness({
    id: 'uniopc-socials',
    title: '公域流量',
  }, {
    entitlementState: 'active',
    entitlementLabel: '全局授权',
    gatewayState: 'ready',
    gatewayLabel: '可用',
    toolCapabilityState: 'runtime_inspect_failed',
    toolCapabilityLabel: '服务异常',
    supported: true,
    hasActiveProfile: true,
    supportsReauthorize: true,
  })

  assert.deepEqual(readiness.runtime, {
    state: 'failed',
    label: '服务异常',
  })
  assert.equal(readiness.primaryAction, 'reauthorize')
  assert.equal(readiness.primaryLabel, '重新授权')
  assert.equal(readiness.secondaryAction, 'repair_restart')
  assert.equal(readiness.secondaryLabel, '重启引擎')
})

test('plugin readiness exposes re-authorization on a healthy official plugin', () => {
  const readiness = resolvePluginReadiness({
    id: 'uniopc-socials',
    title: '公域流量',
  }, {
    entitlementState: 'active',
    entitlementLabel: '全局授权',
    gatewayState: 'ready',
    gatewayLabel: '可用',
    toolCapabilityState: 'ready',
    toolCapabilityLabel: '可用',
    supported: true,
    hasActiveProfile: true,
    supportsReauthorize: true,
  })

  assert.equal(readiness.runtime.state, 'ready')
  assert.equal(readiness.primaryAction, 'restart')
  assert.equal(readiness.secondaryAction, 'reauthorize')
  assert.equal(readiness.secondaryLabel, '重新授权')
})

test('plugin readiness lets a missing local cloud install override stale runtime-missing tools', () => {
  const readiness = resolvePluginReadiness({
    id: 'uniopc-montage',
    title: '智能混剪',
    distribution: 'cloud',
  }, {
    entitlementState: 'active',
    entitlementLabel: '已授权',
    gatewayState: 'not_installed',
    gatewayLabel: '未安装',
    // An old runtime-capability snapshot can still mention the plugin after
    // its local extension directory has disappeared. The local installation
    // fact is authoritative, otherwise the user only gets "修复并重启" and
    // can never re-download the cloud artifact.
    toolCapabilityState: 'runtime_missing',
    toolCapabilityLabel: '无可用工具',
    supported: true,
    hasActiveProfile: true,
  })

  assert.deepEqual(readiness.runtime, {
    state: 'missing',
    label: '未安装',
  })
  assert.equal(readiness.primaryAction, 'install')
  assert.equal(readiness.primaryLabel, '下载并安装')
})

test('plugin readiness lets business health override visible runtime tools', () => {
  const readiness = resolvePluginReadiness({
    id: 'uniopc-socials',
    title: '公域流量',
  }, {
    entitlementState: 'active',
    entitlementLabel: '全局授权',
    gatewayState: 'ready',
    gatewayLabel: '可用',
    toolCapabilityState: 'ready',
    toolCapabilityLabel: '可用',
    businessHealthState: 'uniopc_socials_failed',
    businessHealthLabel: '服务异常',
    supported: true,
    hasActiveProfile: true,
  })

  assert.deepEqual(readiness.runtime, {
    state: 'failed',
    label: '服务异常',
  })
  assert.equal(readiness.primaryAction, 'repair_restart')
})

test('plugin update status flags installed copies that lag the latest published version', () => {
  assert.deepEqual(pluginUpdateStatus({
    latestVersion: '0.2.0',
    observedVersion: '0.1.0',
    observedStatus: 'installed',
  }), { updateAvailable: true, latestVersion: '0.2.0', observedVersion: '0.1.0' })

  // Same version, not installed, or missing data → no update.
  assert.equal(pluginUpdateStatus({ latestVersion: '0.2.0', observedVersion: '0.2.0', observedStatus: 'installed' }).updateAvailable, false)
  assert.equal(pluginUpdateStatus({ latestVersion: '0.2.0', observedVersion: '0.1.0', observedStatus: 'missing' }).updateAvailable, false)
  assert.equal(pluginUpdateStatus({ latestVersion: '0.2.0', observedStatus: 'installed' }).updateAvailable, false)
})

test('plugin force update requires both the recall bit and an available update', () => {
  const lagging = { latestVersion: '0.2.0', observedVersion: '0.1.0', observedStatus: 'installed' }
  assert.equal(pluginForceUpdateRequired({ ...lagging, metadata: { force_update: true } }), true)
  assert.equal(pluginForceUpdateRequired({ ...lagging, forceUpdate: true }), true)
  // Recall bit alone (already current) or lag alone (no bit) must not trigger.
  assert.equal(pluginForceUpdateRequired({ latestVersion: '0.2.0', observedVersion: '0.2.0', observedStatus: 'installed', metadata: { force_update: true } }), false)
  assert.equal(pluginForceUpdateRequired({ ...lagging, metadata: {} }), false)
})

test('engine startup noise is stripped from plugin error banners', () => {
  const noisy = '[channels] failed to load bundled channel setup entry imessage: missing generated module for bundled channel imessage [channels] failed to load bundled channel setup entry telegram: missing generated module for bundled channel telegram package.json missing openclaw.extensions; update the plugin package to include openclaw.extensions (for example ["./dist/index.js"]). See https://docs.openclaw.ai/help/troubleshooting#plugin-install-fails-with-missing-openclaw-extensions Also not a valid hook pack: Error: package.json missing openclaw.hooks'
  assert.equal(stripEngineStartupNoise(noisy), '')
  // Real errors survive, noise around them is removed.
  const mixed = `安装失败: sha256 校验不一致 ${noisy}`
  assert.equal(stripEngineStartupNoise(mixed), '安装失败: sha256 校验不一致')
  assert.equal(stripEngineStartupNoise('普通错误'), '普通错误')
})

test('grant statuses materialize only explicit suspended/revoked as blocking', () => {
  const catalog = [
    { id: 'uniopc-socials', title: '公域获客' },
    { id: 'uniopc-superip', title: '超级IP视频' },
    { id: 'uniopc-documents', title: '文档技能包' },
    { id: 'third-party-thing', title: '第三方' },
  ]
  const entitlements = [
    { pluginId: 'uniopc-socials', status: 'active' },
    { pluginId: 'uniopc-superip', status: 'revoked' },
  ]

  const statuses = buildPluginGrantStatuses(catalog, entitlements)

  assert.deepEqual(statuses.map(item => item.pluginId), ['uniopc-socials', 'uniopc-superip', 'uniopc-documents'])
  assert.equal(statuses[0].status, 'active')
  assert.equal(statuses[1].status, 'revoked')
  assert.equal(statuses[1].name, '超级IP视频')
  // 无授权行(missing)按 active 下发,不产生新的本地误杀;云端门仍兜底。
  assert.equal(statuses[2].status, 'active')
})

test('grant statuses propagate suspended distinctly from revoked', () => {
  const statuses = buildPluginGrantStatuses(
    [{ id: 'uniopc-wechat-mp', title: '公众号运营' }],
    [{ pluginId: 'uniopc-wechat-mp', status: 'suspended' }],
  )
  assert.equal(statuses[0].status, 'suspended')
})

test('update status prefers the locally installed manifest version over cloud observation', () => {
  // 老装机 observed_version 常为空:本地 manifest 有版本即可判定升级。
  assert.deepEqual(
    pluginUpdateStatus({ latestVersion: '0.1.2', installedVersion: '0.1.1', observedVersion: '' }),
    { updateAvailable: true, latestVersion: '0.1.2', observedVersion: '0.1.1' },
  )
  // 本地与云端观测并存时,以本地为准。
  assert.equal(
    pluginUpdateStatus({ latestVersion: '0.1.2', installedVersion: '0.1.2', observedVersion: '0.1.0' }).updateAvailable,
    false,
  )
})


test('plugin brand replacement preserves ASCII identifier boundaries without lookbehind', () => {
  const samples = [
    ['OpenClaw OPENCLAW openclaw', 'Uniopc Uniopc Uniopc'],
    ['OpenClawConfig xOpenClaw OpenClaw_ _OpenClaw 1OpenClaw OpenClaw2', 'OpenClawConfig xOpenClaw OpenClaw_ _OpenClaw 1OpenClaw OpenClaw2'],
    ['(OpenClaw),小龙虾。', '(Uniopc),Uniopc。'],
    ['小龙虾小龙虾', 'UniopcUniopc'],
    ['OpenClaw小龙虾 小龙虾OpenClaw', 'Uniopc小龙虾 小龙虾Uniopc'],
    ['x小龙虾 小龙虾x', 'x小龙虾 小龙虾x'],
  ]
  for (const [input, expected] of samples) {
    const [, plugin] = mergeBuiltInPluginPresets([{ id: 'boundary-test', title: input, description: input, provider: input }])
    for (const key of ['title', 'description', 'provider']) assert.equal(plugin[key], expected, `${key}: ${input}`)
  }
})
