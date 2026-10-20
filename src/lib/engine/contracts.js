const OPAQUE_CONTRACT_FIELDS = new Set([
  'config',
  'env',
  'headers',
  'pluginEnv',
])

function freezeDomain(commands) {
  return Object.freeze(commands)
}

export const ENGINE_COMMANDS = Object.freeze({
  status: freezeDomain({
    get: 'openclaw_status',
    profile: 'openclaw_profile_status',
    bridge: 'conversation_bridge_status',
    connection: 'openclaw_connection_snapshot',
  }),
  sessions: freezeDomain({
    sendTurn: 'conversation_send_turn',
    abortTurn: 'conversation_abort_turn',
    subscribe: 'conversation_subscribe_session',
    loadHistory: 'conversation_load_history',
    files: 'conversation_session_files',
    list: 'conversation_list_sessions',
    create: 'conversation_create_session',
    rename: 'conversation_rename_session',
    setPermission: 'conversation_set_session_permission',
    patchState: 'conversation_patch_session_state',
    setReasoning: 'conversation_set_session_reasoning',
    setModel: 'conversation_set_session_model',
    setThinking: 'conversation_set_session_thinking',
    listPluginApprovals: 'conversation_list_plugin_approvals',
    resolvePluginApproval: 'conversation_resolve_plugin_approval',
    listExecApprovals: 'conversation_list_exec_approvals',
    resolveExecApproval: 'conversation_resolve_exec_approval',
  }),
  models: freezeDomain({
    snapshot: 'openclaw_models_snapshot',
  }),
  agents: freezeDomain({
    list: 'openclaw_agents_list',
    listTemplates: 'openclaw_agent_templates_list',
    create: 'openclaw_agents_create',
    update: 'openclaw_agents_update',
    delete: 'openclaw_agents_delete',
    setSkills: 'openclaw_agent_skills_set',
    listDocuments: 'openclaw_agent_documents_list',
    getDocument: 'openclaw_agent_document_get',
    saveDocument: 'openclaw_agent_document_save',
    skillhubSnapshot: 'openclaw_skillhub_snapshot',
    feishuOverview: 'openclaw_feishu_overview',
    saveFeishuAccount: 'openclaw_feishu_save_account',
    bindFeishu: 'openclaw_feishu_bind_employee',
    unbindFeishu: 'openclaw_feishu_unbind_employee',
    wechatOverview: 'openclaw_wechat_overview',
    installWechatPlugin: 'openclaw_wechat_install_plugin',
    startWechatQr: 'openclaw_wechat_qr_start',
    waitWechatQr: 'openclaw_wechat_qr_wait',
    listChannelPairingRequests: 'openclaw_channel_pairing_requests',
    bindChannel: 'openclaw_channel_bind_employee',
    unbindChannel: 'openclaw_channel_unbind_employee',
    approveChannelPairing: 'openclaw_channel_pairing_approve',
    setChannelPolicy: 'openclaw_channel_set_policy',
  }),
  plugins: freezeDomain({
    listMcpServers: 'openclaw_mcp_servers_list',
    setMcpServer: 'openclaw_mcp_server_set',
    unsetMcpServer: 'openclaw_mcp_server_unset',
    listProfile: 'openclaw_profile_plugins_list',
    listSupported: 'openclaw_supported_plugins_list',
    listToolCapabilities: 'openclaw_profile_tool_capabilities_list',
    doctorCheck: 'openclaw_profile_plugin_doctor_check',
    reconcile: 'openclaw_profile_plugin_reconcile',
    writeGrants: 'uniopc_plugin_grants_write',
    prepareLifecycle: 'uniopc_plugin_lifecycle_prepare',
    commitLifecycle: 'uniopc_plugin_lifecycle_commit',
    cancelLifecycle: 'uniopc_plugin_lifecycle_cancel',
    uninstallCloud: 'uniopc_cloud_plugin_uninstall',
    setProfile: 'openclaw_profile_plugin_set',
  }),
})

export const ENGINE_ERROR_CODES = Object.freeze({
  cancelled: 'engine_cancelled',
  timeout: 'engine_timeout',
  commandFailed: 'engine_command_failed',
})

function camelCaseKey(key) {
  return key.replace(/_([a-z0-9])/g, (_, character) => character.toUpperCase())
}

function cloneOpaqueValue(value) {
  if (Array.isArray(value)) return value.map(cloneOpaqueValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, cloneOpaqueValue(child)]),
  )
}

function normalizeContractValue(value) {
  if (Array.isArray(value)) return value.map(normalizeContractValue)
  if (!value || typeof value !== 'object') return value

  const result = {}
  for (const [rawKey, child] of Object.entries(value)) {
    if (child === undefined) continue
    const key = camelCaseKey(rawKey)
    result[key] = OPAQUE_CONTRACT_FIELDS.has(key)
      ? cloneOpaqueValue(child)
      : normalizeContractValue(child)
  }
  return result
}

export function normalizeEngineRequest(value = {}) {
  return normalizeContractValue(value)
}

export function normalizeEngineResponse(value) {
  return normalizeContractValue(value)
}

export class EngineClientError extends Error {
  constructor({ code, message, command, retryable = false, cause = null, ...details }) {
    super(message || 'Uniopc engine command failed', cause ? { cause } : undefined)
    this.name = 'EngineClientError'
    this.code = code || ENGINE_ERROR_CODES.commandFailed
    this.command = command || ''
    this.retryable = Boolean(retryable)
    Object.assign(this, details)
  }
}

export function normalizeEngineError(error, command) {
  if (error instanceof EngineClientError) return error
  const normalized = error && typeof error === 'object'
    ? normalizeEngineResponse(error)
    : null
  return new EngineClientError({
    ...(normalized || {}),
    code: normalized?.code || ENGINE_ERROR_CODES.commandFailed,
    message: normalized?.message || String(error?.message || error || 'Uniopc engine command failed'),
    command,
    retryable: normalized?.retryable ?? false,
    cause: error instanceof Error ? error : null,
  })
}
