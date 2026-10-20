import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('./McpHub.jsx', import.meta.url), 'utf8')
const engineClientSource = readFileSync(new URL('../lib/engine/client.js', import.meta.url), 'utf8')

test('plugin page uses one flat content surface without header status clutter', () => {
  assert.equal(source.includes("import { ACTION, SURFACE, TEXT } from '../lib/theme'"), true)
  assert.equal(source.includes('className={`${LAYOUT.board} min-h-full space-y-5`}'), false)
  assert.equal(source.includes('className="flex h-full min-h-0 flex-col overflow-hidden"'), true)
  assert.equal(source.includes('className="min-h-0 flex-1 overflow-y-auto px-5 py-3"'), true)

  assert.equal(source.includes('管理官方、第三方和自定义插件；授权由 Uniopc 控制，安装状态来自当前 Uniopc 引擎 Profile/Gateway。'), false)
  assert.equal(source.includes('{hubDescription}'), false)
  assert.equal(source.includes('<span>Profile</span>'), false)
  assert.equal(source.includes("Gateway {gatewayConnected ? '已连接' : '未连接'}"), false)
  assert.equal(source.includes('HEADING.page'), false)
})

test('plugin page follows compact workspace header spacing', () => {
  assert.equal(source.includes('className="flex flex-col gap-2 px-5 pb-2 pt-3 md:flex-row md:items-center md:justify-between"'), true)
  assert.equal(source.includes('className="flex flex-wrap items-center"'), true)
  assert.equal(source.includes('className="flex h-9 w-9 items-center justify-center rounded-lg'), false)
  assert.equal(source.includes('<h2 className={HEADING.page}>{hubTitle}</h2>'), false)
  assert.equal(source.includes('const HUB_MODE_TABS = ['), true)
  assert.equal(source.includes("{ id: 'plugins', label: '插件', childPath: 'plugins' }"), true)
  assert.equal(source.includes("{ id: 'mcp', label: 'MCP', childPath: 'mcphub' }"), true)
  assert.equal(source.includes('className="flex flex-wrap gap-1 border-b border-subtle px-5"'), true)
  assert.equal(source.includes('className={`relative h-8 px-3 text-sm font-medium transition-colors ${'), true)
  assert.equal(source.includes('className="flex flex-col gap-4 px-6 py-5 md:flex-row md:items-start md:justify-between"'), false)
  assert.equal(source.includes('className="flex h-10 w-10 items-center justify-center rounded-xl'), false)
  assert.equal(source.includes('className="min-h-0 flex-1 overflow-y-auto px-6 py-5"'), false)
  assert.equal(source.includes('className="flex flex-col gap-3 px-6 py-4 md:flex-row md:items-center md:justify-between"'), false)
  assert.equal(source.includes('className={`relative h-10 px-4 text-sm font-medium transition-colors ${'), false)
})

test('plugin catalog does not wrap plugin tabs in an extra section panel or description header', () => {
  assert.equal(source.includes("{ id: 'official', label: '官方', description:"), false)
  assert.equal(source.includes("{ id: 'third-party', label: '第三方', description:"), false)
  assert.equal(source.includes("{ id: 'custom', label: '自定义', description:"), false)
  assert.equal(source.includes('activePluginTab.description'), false)
  assert.equal(source.includes('PLUGIN_TAB_IDS.has(activeTab) && (\n        <section className={`${SURFACE.panel} overflow-hidden`}>'), false)
  assert.equal(source.includes('正在读取云端插件目录、组织授权、Uniopc 引擎 插件市场和 Profile/Gateway 状态...'), false)
  // 加载态从通栏品牌紫 banner 降级为一行带转圈的说明文字：
  // 「正在读取」是过程不是结果，不该比页面上任何真实内容都抢眼。
  assert.equal(source.includes('正在读取插件状态'), true)
  assert.equal(source.includes('bg-violet-500/10 px-4 py-3 text-sm text-violet-600'), false)
})

test('plugin catalog disables fallback until Rust has a real signed envelope verifier', () => {
  assert.equal(source.includes('localStorage'), false)
  assert.equal(source.includes('CLOUD_PLUGIN_CATALOG_CACHE_PREFIX'), false)
  assert.equal(source.includes('readCachedCloudPluginCatalog'), false)
  assert.equal(source.includes('writeCachedCloudPluginCatalog'), false)
  assert.equal(source.includes('normalizeTrustedServiceError'), true)
  assert.equal(source.includes('fetchTrustedPluginCatalog'), true)
  assert.equal(source.includes('listCloudPluginCatalog'), false)
  assert.match(source, /replaceCloudAgentPluginCatalog\(rows\)/)
  assert.match(source, /catch \(err\) \{[\s\S]*commitCurrentRequest\(\(\) => \{\s*replaceCloudAgentPluginCatalog\(\[\]\)/)
  assert.match(source, /beginCloudAgentCatalogRequest\(requestScope\)/)
  assert.match(source, /commitCloudAgentCatalogRequest\(request, commit\)/)
  assert.match(source, /catalogRequestScopeRef\.current !== requestScope/)
  assert.match(source, /return \(\) => \{\s*invalidateCloudAgentCatalogRequests\(\)/)
  assert.match(source, /\}, \[user\?\.uid, activeOpenClaw\.loading, activeOpenClawProfileId, activeProfile\]\)/)
  assert.equal(source.includes('cloudPluginCatalogCacheState'), false)
  assert.equal(source.includes('normalizeTrustedCatalogSnapshot'), false)
  assert.equal(source.includes('cacheSnapshot'), false)
  assert.equal(source.includes('signatureVerified'), false)
})

test('plugin catalog errors are stable retryable UI states and never raw FetchError details', () => {
  assert.equal(source.includes('setCloudPluginCatalogError(catalogError)'), true)
  assert.equal(source.includes("catalogError.code === 'trusted_service_unavailable'"), false)
  assert.equal(source.includes('FetchError'), false)
  assert.equal(source.includes("String(err?.message || err || '读取云端插件目录失败')"), false)
})

test('plugin create button is always visible in the page header actions', () => {
  const headerActionsStart = source.indexOf('<div className="flex flex-wrap items-center justify-start gap-2 md:max-w-[560px] md:justify-end">')
  const tabsStart = source.indexOf('<div className="flex flex-wrap gap-1 border-b border-subtle px-5">')
  const pluginSectionStart = source.indexOf('{PLUGIN_TAB_IDS.has(activeTab) && (')
  const pluginGridStart = source.indexOf('<PluginCatalogGrid')

  assert.notEqual(headerActionsStart, -1)
  assert.notEqual(tabsStart, -1)
  assert.notEqual(pluginSectionStart, -1)
  assert.notEqual(pluginGridStart, -1)

  const headerActions = source.slice(headerActionsStart, tabsStart)
  const pluginSectionChrome = source.slice(pluginSectionStart, pluginGridStart)

  assert.equal(headerActions.includes("activeTab === 'custom'"), false)
  assert.equal(headerActions.includes('onClick={openCreateModal}'), true)
  assert.equal(headerActions.includes('<span>{createActionLabel}</span>'), true)
  assert.equal(pluginSectionChrome.includes('onClick={openCreateModal}'), false)
})

test('MCP form validation stays visible in the configuration dialog', () => {
  assert.equal(source.includes("const [formError, setFormError] = useState('')"), true)
  assert.equal(source.includes("setFormError('请填写 MCP server 名称。')"), true)
  assert.equal(source.includes('role="alert"'), true)
  assert.equal(source.includes('请检查 MCP 配置'), true)
  assert.equal(source.includes('setFormError(String(err?.message || err || \'MCP 配置格式无效\'))'), true)
})

test('plugin tabs show counts inline and the list does not repeat the count', () => {
  const tabsStart = source.indexOf('<div className="flex flex-wrap gap-1 border-b border-subtle px-5">')
  const pluginSectionStart = source.indexOf('{PLUGIN_TAB_IDS.has(activeTab) && (')
  const pluginGridStart = source.indexOf('<PluginCatalogGrid')

  assert.notEqual(tabsStart, -1)
  assert.notEqual(pluginSectionStart, -1)
  assert.notEqual(pluginGridStart, -1)

  const tabsSource = source.slice(tabsStart, pluginSectionStart)
  const pluginSectionChrome = source.slice(pluginSectionStart, pluginGridStart)

  assert.equal(source.includes('const pluginTabCounts = useMemo('), true)
  assert.equal(tabsSource.includes("{tab.label}{PLUGIN_TAB_IDS.has(tab.id) ? `（${pluginTabCountLabel(pluginTabCounts[tab.id], cloudPluginCatalogResolved)}）` : ''}"), true)
  assert.equal(pluginSectionChrome.includes('{activePluginList.length} 个'), false)
})

test('cloud plugin actions apply the returned Uniopc 引擎 snapshot immediately', () => {
  assert.equal(source.includes('function applyProfilePluginSnapshot(snapshot)'), true)
  // 安装/启用走 openclaw_profile_plugin_set,卸载走 uniopc_cloud_plugin_uninstall,
  // 两者都要把返回的快照立即应用到 UI(否则状态要等下一次轮询才对)。
  assert.match(source, /engineClient\.plugins\.setProfile\(/)
  assert.match(source, /const pluginSnapshot = await engineClient\.plugins\.uninstallCloud\(/)
  assert.equal(source.includes('applyProfilePluginSnapshot(pluginSnapshot)'), true)
})

test('Uniopc 引擎 profile plugin write timeouts are owned by engineClient', () => {
  assert.equal(source.includes('const PLUGIN_ACTION_TIMEOUT_MS = 45000'), true)
  assert.equal(engineClientSource.includes('const PLUGIN_WRITE_TIMEOUT_MS = 210_000'), true)
  assert.match(source, /function withPluginActionTimeout\(promise, label = '插件操作', timeoutMs = PLUGIN_ACTION_TIMEOUT_MS\)/)
  assert.match(engineClientSource, /setProfile: commandMethod\(call, ENGINE_COMMANDS\.plugins\.setProfile, PLUGIN_WRITE_TIMEOUT_MS\)/)
  assert.match(engineClientSource, /uninstallCloud: commandMethod\(call, ENGINE_COMMANDS\.plugins\.uninstallCloud, PLUGIN_WRITE_TIMEOUT_MS\)/)
  assert.doesNotMatch(source, /withPluginActionTimeout\(\s*engineClient\./)
})

test('system plugin detail footer relies on the modal close icon instead of a fixed close button', () => {
  const footerStart = source.indexOf('footer={(')
  const stopButtonStart = source.indexOf('selectedSystemPluginLifecycle?.canUninstall', footerStart)

  assert.notEqual(footerStart, -1)
  assert.notEqual(stopButtonStart, -1)

  const fixedFooterActions = source.slice(footerStart, stopButtonStart)
  assert.equal(fixedFooterActions.includes('onClick={closeMarketDetailModal}'), false)
  assert.equal(fixedFooterActions.includes('关闭'), false)
})

test('third-party hosted plugins use the same managed lifecycle details as official plugins', () => {
  const gridStart = source.indexOf('<PluginCatalogGrid')
  const gridEnd = source.indexOf("{activeTab === 'mine' && (", gridStart)
  assert.notEqual(gridStart, -1)
  assert.notEqual(gridEnd, -1)

  const gridSource = source.slice(gridStart, gridEnd)
  // Third-party hosted plugins render the same SystemPluginCard + managed
  // details as official; only official adds scene grouping around it.
  assert.equal(gridSource.includes("activeTab === 'third-party' ? ("), true)
  assert.equal(gridSource.includes('onDetails={openSystemPluginDetails}'), true)
  assert.equal(gridSource.includes('onDetails={openToolPluginDetails}'), false)
  assert.equal(source.includes('const managedPlugins = useMemo('), true)
  assert.equal(source.includes('managedPlugins.find(preset => preset.id === selectedSystemPluginId)'), true)
})

test('official plugin tab groups by scene taxonomy (9 categories, other last)', () => {
  // Scene grouping is driven by SCENE_CATEGORIES; other must be last.
  assert.equal(source.includes("{ slug: 'content-creation', label: '内容创作' }"), true)
  assert.equal(source.includes("{ slug: 'product-development', label: '产品开发' }"), true)
  assert.equal(source.includes("{ slug: 'other', label: '其他' }"), true)
  const sceneStart = source.indexOf('const SCENE_CATEGORIES = [')
  const otherIdx = source.indexOf("slug: 'other'", sceneStart)
  const closeIdx = source.indexOf(']', sceneStart)
  assert.ok(otherIdx !== -1 && otherIdx < closeIdx, 'other must be inside SCENE_CATEGORIES, last entry')
  // Official tab renders per-scene groups; unknown/empty folds into other.
  assert.equal(source.includes("activeTab === 'official' ? ("), true)
  assert.equal(source.includes('presetSceneCategory(preset) === scene.slug'), true)
})

test('plugin center UI no longer exposes legacy ClawHub marketplace install branches', () => {
  assert.equal(source.includes('openclaw_plugin_marketplace_install'), false)
  assert.equal(source.includes('installOpenClawMarketplacePlugin'), false)
  assert.equal(source.includes('openToolPluginDetails'), false)
  assert.equal(source.includes("marketDetailModal === 'tool-plugin'"), false)
  assert.equal(source.includes('通过 ClawHub 安装'), false)
  assert.equal(source.includes('打开 ClawHub'), false)
  assert.equal(source.includes('安装到 Uniopc 引擎'), false)
  assert.equal(source.includes('安装中...'), false)
})

test('credential repair is folded into the system plugin primary action instead of a standing footer button', () => {
  const footerStart = source.indexOf('footer={(')
  const footerEnd = source.indexOf('</div>\n        )}', footerStart)
  assert.notEqual(footerStart, -1)
  assert.notEqual(footerEnd, -1)

  const systemFooter = source.slice(footerStart, footerEnd)
  assert.equal(systemFooter.includes('重置授权凭证'), false)
  assert.equal(systemFooter.includes('确认重置'), false)
  assert.equal(systemFooter.includes('resetSystemPluginCredential'), false)
  assert.equal(source.includes('resetHostCredential: true'), true)
  assert.equal(source.includes('重新授权并启用'), true)
})

test('official plugins expose an explicit re-authorization action distinct from restarting the engine', () => {
  // Official (cloud-agent) plugins carry a host-credential handshake, so the
  // readiness state machine is told they support re-authorization.
  assert.equal(source.includes('supportsReauthorize: isCloudAgentPluginId(preset.id)'), true)
  // A dedicated re-auth entry point re-mints the host credential (forced reset).
  assert.equal(source.includes('function reauthorizeSystemPlugin('), true)
  // The modal renders the contextual secondary action alongside the primary one.
  assert.equal(source.includes('function runSystemPluginSecondaryAction('), true)
  assert.equal(source.includes('selectedSystemPluginLifecycle?.secondaryAction'), true)
  assert.equal(source.includes('runSystemPluginSecondaryAction(selectedSystemPlugin)'), true)
})

test('plugin page automatically refreshes local profile plugin status after catalog and entitlement changes', () => {
  assert.equal(source.includes('const pluginCatalogSignature = useMemo('), true)
  assert.equal(source.includes('refreshProfilePluginStatusFromLocal()\n  }, [canManageMcpServers, activeOpenClaw.loading, activeProfile, organizationEntitlementSignature, pluginCatalogSignature])'), true)
})

test('plugin configuration snapshot survives a runtime health-check failure', () => {
  const refreshStart = source.indexOf('async function refreshProfilePluginStatusFromLocal()')
  const refreshEnd = source.indexOf('\n  async function loadSupportedPlugins()', refreshStart)
  assert.notEqual(refreshStart, -1)
  assert.notEqual(refreshEnd, -1)
  const refresh = source.slice(refreshStart, refreshEnd)

  // API-key state must come from the lightweight config snapshot. Runtime
  // inspection is best-effort; a failed probe must not erase an already
  // saved credential and send the user back to "配置并启用".
  assert.match(refresh, /engineClient\.plugins\.listProfile\(\{ profile: activeProfile \}\)/)
  assert.equal(refresh.includes("} catch (err) {\n      setProfilePluginSnapshot(null)"), false)
})

test('artifact metadata safely overrides a stale bundled distribution tier', () => {
  // A historical catalog row marked cloud-workspace as both bundled and a
  // cloud artifact. The installer must use the artifact whenever one is
  // declared; otherwise it reaches enable with no local plugin installed.
  assert.equal(source.includes("preset?.distribution === 'cloud' || preset?.installKind === 'cloud_artifact'"), true)
})

test('cloud-distributed plugins (skill packs included) get an install authorization', () => {
  // The authorize gate must cover every cloud-distributed plugin, not just
  // cloud-agent plugins — otherwise skill packs skip the artifact download
  // and "配置并启用" tries to enable an uninstalled plugin.
  assert.equal(source.includes('if (isCloudAgentPluginId(preset.id) || isCloudDistributedPlugin(preset)) {'), true)
})

test('plugin install pauses for capability review before account authorization', () => {
  // Steps append as each phase actually runs; skipped phases never render.
  assert.equal(source.includes('const [installProgress, setInstallProgress] = useState(null)'), true)
  assert.equal(source.includes('async function runInstallStep(label, group, task)'), true)
  assert.equal(source.includes("{ id: 'init', label: '初始化资源' }"), true)
  assert.equal(source.includes("{ id: 'auth', label: '账号授权' }"), true)
  // Phase 1 初始化资源: authorize → download → review → reviewed install.
  for (const [label, group] of [['安装授权', 'init'], ['下载安装包', 'init'], ['分析插件能力', 'init'], ['写入已确认插件能力', 'init']]) {
    assert.equal(source.includes(`runInstallStep('${label}', '${group}'`), true, `missing step: ${label}`)
  }
  assert.equal(source.includes('enable: false,'), true)
  // Phase 2 账号授权: auto host credential for cloud-agent plugins, api-key
  // connector form (blocking) for third-party, plain enable for skill packs.
  assert.equal(source.includes("runInstallStep('配置官方云凭证（自动）', 'auth'"), true, 'missing step: 配置官方云凭证')
  // 两种凭据并存(不是 if/else):混合插件——如公众号,借我们固定 IP 的云函数
  // 转发、但用户自己的 AppID/AppSecret——既要自动铸造 host credential,又要弹
  // api-key 表单。此前的 if/else 会让云插件永不弹表单。
  assert.equal(source.includes('const needsHostCredential = isCloudAgentPluginId(preset.id)'), true)
  assert.equal(source.includes("const enableLabel = needsHostCredential\n      ? '启用插件'"), true, 'missing step: 启用插件')
  assert.equal(source.includes('const connectorRequiresInput = connectorNeedsCredentialInput(connector, { reconfigure: reconfigureConnector })'), true)
  assert.equal(source.includes("needsHostCredential || (connector && connectorRequiresInput) ? 'auth' : 'init'"), true)
  // authEnv(平台托管)与 pluginEnv(用户自有)必须能进同一次 plugin_set。
  assert.equal(source.includes('...(authEnv || {}),'), true)
  assert.equal(source.includes("return 'pending_connector'"), true)
  assert.equal(source.includes('function ConnectorAuthForm'), true)
  assert.equal(source.includes('onSubmit={finishConnectorAuth}'), true)
  assert.equal(source.includes('values={pendingConnectorAuth.values || {}}'), true, 'credential form values must survive an engine-write retry')
  assert.equal(source.includes('connectorValues: pendingConnectorAuth.values || {}'), true, 'retry must reuse the entered credentials')
  assert.equal(source.includes('pluginEnv'), true)
  // Failed steps keep the modal open with the error inline; closing clears progress.
  assert.equal(source.includes("markInstallStep(label, 'failed'"), true)
  assert.equal(source.includes('installProgress?.pluginId === selectedSystemPlugin.id'), true)
  const closeStart = source.indexOf('function closeMarketDetailModal')
  const closeEnd = source.indexOf('}', closeStart)
  assert.equal(source.slice(closeStart, closeEnd).includes('setInstallProgress(null)'), true)
  assert.equal(source.slice(closeStart, closeEnd).includes('setPendingConnectorAuth(null)'), true)
})

test('confirming plugin capabilities keeps the detail install action locked', () => {
  const retryStart = source.indexOf('async function retryPluginCapabilityReview(pending)')
  const retryEnd = source.indexOf('\n  async function confirmPluginCapabilityReview()', retryStart)
  assert.notEqual(retryStart, -1)
  assert.notEqual(retryEnd, -1)

  const retry = source.slice(retryStart, retryEnd)
  assert.match(retry, /setPluginActionId\(pending\.preset\.id\)/)
  assert.match(retry, /finally \{\s*setPluginActionId\(''\)\s*\}/)
})

test('plugin health is taken from the runtime status, never re-derived from tool count', () => {
  // 回归护栏:无工具插件——技能包(documents/presentations/shopify,能力走 "/"
  // 调用技能)与角色模板包(employee-roles,只提供 agentTemplates)——引擎报
  // status=ready + tools=[] 正是它们的健康状态。
  //
  // "零工具是否异常"只有 Rust 侧知道(apply_runtime_tool_verification 对未声明
  // 工具的插件放行,只有声明了却运行时缺失才置 runtime_missing)。前端一旦按
  // 工具数量二次推导,必然漏掉各类无工具插件——技能包和角色包先后被误判成
  // "运行异常"。所以两处都必须直接采用 status,不得再引入 tools.length 判据。
  assert.equal(source.includes("const toolCapabilityState = toolCapability?.status || ''"), true)
  assert.equal(source.includes("if (status === 'ready') return '可用'"), true)
  assert.equal(source.includes("? 'runtime_missing'"), false)
  assert.equal(source.includes('toolCapability.tools.length === 0'), false)
})

test('plugin lifecycle offers uninstall, not disable — no "装着但关着" state', () => {
  // 产品决策(对齐 Accio):市场插件只有卸载,没有停用。云端分发让重装成本极低,
  // 而"装着但关着"会留下配置残留和含糊状态(用户记不住当初为什么关的)。
  // 引擎侧的 enabled=false 仍保留,但只供组织策略 reconcile 内部使用。
  assert.equal(source.includes('uninstallSystemPlugin'), true)
  assert.equal(source.includes('stopSystemPlugin'), false)
  assert.equal(source.includes('engineClient.plugins.uninstallCloud('), true)
  // 卸载是不可逆动作(删磁盘文件),必须二次确认,并说明连接器凭据会一并清除。
  const fnStart = source.indexOf('async function uninstallSystemPlugin(preset)')
  const fnEnd = source.indexOf('\n  }\n', fnStart)
  const fn = source.slice(fnStart, fnEnd)
  assert.equal(fn.includes('window.confirm('), true)
  assert.equal(fn.includes('随时可以在应用中心重新安装'), true)
  assert.equal(fn.includes('账号授权'), true)
})

test('unpublished catalog entries are guarded before the install flow begins', () => {
  assert.equal(source.includes("if (preset.releaseState === 'unpublished')"), true)
  assert.equal(source.includes("showError('该插件尚未发布可安装版本。')"), true)
})

test('plugin review displays backend-owned API compatibility without comparing versions in React', () => {
  assert.match(source, /review\?\.pluginApiRequirement/u)
  assert.match(source, /review\?\.hostVersion/u)
  assert.doesNotMatch(source, /semver|\.satisfies\s*\(/u)
})
