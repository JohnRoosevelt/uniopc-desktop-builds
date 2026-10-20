#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const desktopRoot = path.resolve(__dirname, '..')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_BASE_PORT = 9223
const DEFAULT_PORT_SCAN_COUNT = 100
const DEFAULT_CONNECT_TIMEOUT_MS = 120_000
const DEFAULT_ACTION_TIMEOUT_MS = 20_000

export const DEFAULT_SMOKE_CASES = [
  {
    id: 'app-shell',
    label: 'App shell renders without a blank screen',
    path: null,
    expected: ['Uniopc', 'Uniopc', '登录', '正在检查', '正在完成', 'Conversations', '对话'],
  },
  {
    id: 'auth-workspace-bootstrap',
    label: 'Auth and workspace bootstrap surface exposes login or resolved workspace state',
    path: null,
    expected: ['登录', '正在检查', '正在完成', '组织', 'Workspace', 'Profile', '对话'],
  },
  {
    id: 'conversations',
    label: 'Conversations page is reachable',
    path: '/conversations',
    expected: ['对话', 'Conversations', 'OpenClaw', '模型', '发送', '输入'],
  },
  {
    id: 'cloud-workbench',
    label: 'Cloud workbench page is reachable',
    path: '/cloud-workbench',
    expected: ['工作台', '项目', 'Cloud', 'Workbench'],
  },
  {
    id: 'cloud-project-flow',
    label: 'Cloud project workflow exposes project, task, and member context',
    path: '/cloud-workbench',
    expected: ['项目', '任务', '成员', '员工', 'Project', 'Task', 'Member'],
  },
  {
    id: 'cloud-documents',
    label: 'Cloud documents page is reachable',
    path: '/cloud-documents',
    expected: ['文档', 'Documents', '项目'],
  },
  {
    id: 'cloud-document-flow',
    label: 'Cloud document workflow exposes project-scoped document actions',
    path: '/cloud-documents',
    expected: ['文档', 'Documents', '项目', '新建', '打开', '权限'],
  },
  {
    id: 'app-center',
    label: 'App center home is reachable',
    path: '/apps',
    expected: ['应用', 'App', '私域', '社媒'],
  },
  {
    id: 'employees',
    label: 'Employees page is reachable',
    path: '/employees',
    expected: ['员工', 'Employees', '成员', '技能'],
  },
  {
    id: 'employees-permissions',
    label: 'Employee directory exposes profile and permission management context',
    path: '/employees',
    expected: ['员工', 'Employees', '成员', '权限', '技能', 'Profile'],
  },
  {
    id: 'plugins',
    label: 'Plugins page is reachable',
    path: '/plugins',
    expected: ['插件', 'Plugin', '应用', 'App'],
  },
  {
    id: 'mcp-hub',
    label: 'MCP Hub exposes bundled presets',
    path: '/mcphub',
    expected: ['MCP', 'Playwriter', 'TikHub'],
  },
  {
    id: 'public-traffic',
    label: 'Public traffic app center page is reachable',
    path: '/workbench/public',
    expected: ['公域', '流量', 'Public', 'Traffic'],
  },
  {
    id: 'socials-transcript',
    label: 'Socials transcript page is reachable',
    path: '/workbench/socials/transcript',
    expected: ['转写', 'Transcript', '内容', 'Social'],
  },
  {
    id: 'socials-leads',
    label: 'Socials leads page is reachable',
    path: '/workbench/socials/leads',
    expected: ['线索', 'Leads', '客户', 'Social'],
  },
  {
    id: 'socials-tracker',
    label: 'Socials tracker page is reachable',
    path: '/workbench/socials/tracker',
    expected: ['追踪', 'Tracker', 'Social'],
  },
  {
    id: 'xiaohongshu-home',
    label: 'Xiaohongshu home page is reachable',
    path: '/workbench/socials/xiaohongshu',
    expected: ['小红书', 'Xiaohongshu', '笔记'],
  },
  {
    id: 'xiaohongshu-transcript',
    label: 'Xiaohongshu transcript page is reachable',
    path: '/workbench/socials/xiaohongshu/transcript',
    expected: ['小红书', '转写', 'Transcript'],
  },
  {
    id: 'xiaohongshu-tracker',
    label: 'Xiaohongshu tracker page is reachable',
    path: '/workbench/socials/xiaohongshu/tracker',
    expected: ['小红书', '追踪', 'Tracker'],
  },
  {
    id: 'xiaohongshu-leads',
    label: 'Xiaohongshu leads page is reachable',
    path: '/workbench/socials/xiaohongshu/leads',
    expected: ['小红书', '线索', 'Leads'],
  },
  {
    id: 'douyin-home',
    label: 'Douyin home page is reachable',
    path: '/workbench/socials/douyin',
    expected: ['抖音', 'Douyin', '视频'],
  },
  {
    id: 'douyin-transcript',
    label: 'Douyin transcript page is reachable',
    path: '/workbench/socials/douyin/transcript',
    expected: ['抖音', '转写', 'Transcript'],
  },
  {
    id: 'douyin-tracker',
    label: 'Douyin tracker page is reachable',
    path: '/workbench/socials/douyin/tracker',
    expected: ['抖音', '追踪', 'Tracker'],
  },
  {
    id: 'admin',
    label: 'Admin page is reachable for non-member accounts',
    path: '/admin',
    expected: ['组织', '成员', 'Admin', '权限'],
    optional: true,
  },
  {
    id: 'operations',
    label: 'Operations page is reachable',
    path: '/operations',
    expected: ['运营', '任务', 'Operations', '自动化'],
  },
  {
    id: 'models',
    label: 'Models page is reachable',
    path: '/models',
    expected: ['模型', 'Models', 'OpenAI', 'Provider'],
  },
  {
    id: 'model-provider-settings',
    label: 'Model provider settings expose provider auth and profile model state',
    path: '/models',
    expected: ['模型', 'Models', 'OpenAI', 'Provider', 'Profile', '默认'],
  },
  {
    id: 'openclaw-gateway-readiness',
    label: 'OpenClaw Gateway readiness path exposes runtime recovery entrypoints',
    path: '/operations',
    required: ['OpenClaw', 'Profile 模型', 'OpenClaw 版本管理'],
    expected: ['Gateway', '运行', '连接', 'Browser Runtime'],
  },
  {
    id: 'conversation-stream',
    label: 'Conversation stream path exposes send and runtime context',
    path: '/conversations',
    required: ['对话', 'OpenClaw'],
    expected: ['发送', '输入', '模型', 'Conversations'],
  },
  {
    id: 'plugin-mcp-tool-sync',
    label: 'Plugin and MCP tool sync surfaces expose managed capability catalogs',
    path: '/mcphub',
    required: ['MCP', 'TikHub'],
    expected: ['Playwriter', 'Telegram', '工具', 'Server'],
  },
  {
    id: 'settings',
    label: 'Settings page is reachable',
    path: '/settings',
    expected: ['设置', 'Settings', '主题', '语言'],
  },
  {
    id: 'settings-persistence',
    label: 'Settings surface exposes persisted user preferences',
    path: '/settings',
    expected: ['设置', 'Settings', '主题', '语言', 'Theme', 'Language'],
  },
  {
    id: 'desktop-release-readiness',
    label: 'Desktop release surface exposes settings or update readiness markers',
    path: '/settings',
    expected: ['设置', 'Settings', '版本', '更新', 'Update', 'Release'],
  },
]

export const E2E_TEST_DIMENSIONS = [
  {
    id: 'app-shell',
    label: 'App startup and shell navigation',
    scope: [
      'App launches without a blank screen.',
      'Primary routes and navigation chrome remain reachable after route changes.',
    ],
    smokeCases: ['app-shell', 'conversations', 'settings'],
  },
  {
    id: 'auth-workspace',
    label: 'Auth and workspace bootstrap',
    scope: [
      'Anonymous users see login or bootstrap progress.',
      'Authenticated users resolve organization, workspace profile, and role-specific entry points.',
    ],
    smokeCases: ['auth-workspace-bootstrap', 'admin', 'employees'],
  },
  {
    id: 'local-openclaw-runtime',
    label: 'Local OpenClaw runtime readiness',
    scope: [
      'Owner/admin machines expose local Gateway startup and recovery controls.',
      'Runtime readiness is represented through GatewayConnectionSnapshot instead of stale CLI state.',
    ],
    smokeCases: ['models', 'operations', 'openclaw-gateway-readiness'],
  },
  {
    id: 'remote-gateway',
    label: 'Remote Gateway connection modes',
    scope: [
      'Member devices can be guided through direct, Tailscale, or SSH tunnel configuration.',
      'Unsafe or stale remote endpoint handoff is rejected or clearly surfaced.',
    ],
    smokeCases: ['openclaw-gateway-readiness', 'employees-permissions'],
  },
  {
    id: 'conversation',
    label: 'Conversation send and stream path',
    scope: [
      'Conversation pages expose send input, model context, and OpenClaw-backed transport.',
      'Gateway session subscribe, abort, and history paths stay wired through backend IPC.',
    ],
    smokeCases: ['conversations', 'conversation-stream'],
  },
  {
    id: 'employees-permissions',
    label: 'AI employees and member permissions',
    scope: [
      'Admins can manage member profiles, Gateway assignment, and authorized agents.',
      'Ordinary members only see employees and capabilities granted through their workspace profile.',
    ],
    smokeCases: ['employees', 'employees-permissions', 'admin'],
  },
  {
    id: 'plugins-mcp',
    label: 'Plugin and MCP capability sync',
    scope: [
      'Organization plugin entitlements determine visible plugin actions.',
      'Managed MCP tools and OpenClaw tool capabilities remain visible to conversations.',
    ],
    smokeCases: ['plugins', 'mcp-hub', 'plugin-mcp-tool-sync'],
  },
  {
    id: 'cloud-workbench-documents',
    label: 'Cloud projects, tasks, and documents',
    scope: [
      'Project and task workbench routes expose cloud workspace state.',
      'Cloud documents remain project-scoped and permission-aware.',
    ],
    smokeCases: ['cloud-workbench', 'cloud-project-flow', 'cloud-documents', 'cloud-document-flow'],
  },
  {
    id: 'app-center-business',
    label: 'App Center business workflows',
    scope: [
      'App Center and workbench verticals remain routable.',
      'Public traffic transcript, lead, and tracker pages keep their expected business surfaces.',
    ],
    smokeCases: [
      'app-center',
      'public-traffic',
      'socials-transcript',
      'socials-leads',
      'socials-tracker',
      'xiaohongshu-home',
      'douyin-home',
    ],
  },
  {
    id: 'models-providers',
    label: 'Models and provider auth',
    scope: [
      'Profile-scoped model settings stay reachable.',
      'Provider auth and default model state do not block unrelated app entry.',
    ],
    smokeCases: ['models', 'model-provider-settings'],
  },
  {
    id: 'settings-persistence',
    label: 'Settings and persisted preferences',
    scope: [
      'Settings routes expose theme and language preferences.',
      'Preference storage can be validated separately from business feature flows.',
    ],
    smokeCases: ['settings', 'settings-persistence'],
  },
  {
    id: 'security-policy',
    label: 'Security policy and secret hygiene',
    scope: [
      'Reports redact credentials and avoid leaking auth secrets.',
      'Gateway, setup-code, plugin, and IPC surfaces retain explicit policy guardrails.',
    ],
    smokeCases: ['auth-workspace-bootstrap', 'openclaw-gateway-readiness', 'plugin-mcp-tool-sync'],
  },
  {
    id: 'packaging-update',
    label: 'Packaging, helper binaries, and updater readiness',
    scope: [
      'Release builds include required helper binaries and resources.',
      'Updater and release readiness markers are checked separately from route smoke.',
    ],
    smokeCases: ['desktop-release-readiness'],
  },
]

export const RELEASE_BEHAVIOR_CASES = [
  {
    id: 'release-model-identity',
    label: 'Displayed conversation model matches the Gateway session model',
    commands: ['conversation_load_history'],
    requiredEnv: [
      'IMAI_E2E_PROFILE',
      'IMAI_E2E_MAIN_SESSION_KEY',
      'IMAI_E2E_EXPECTED_MODEL',
      'IMAI_E2E_EXPECTED_MODEL_LABEL',
    ],
  },
  {
    id: 'release-session-ownership',
    label: 'Main and cron sessions retain distinct engine ownership',
    commands: ['conversation_list_sessions'],
    requiredEnv: [
      'IMAI_E2E_PROFILE',
      'IMAI_E2E_AGENT_ID',
      'IMAI_E2E_MAIN_SESSION_KEY',
      'IMAI_E2E_CRON_SESSION_KEY',
    ],
  },
  {
    id: 'release-plugin-catalog',
    label: 'Local workspace plugin is installed, enabled, healthy, and tool-ready',
    commands: ['openclaw_profile_tool_capabilities_list'],
    requiredEnv: ['IMAI_E2E_PROFILE'],
  },
  {
    id: 'release-local-workspace-tool',
    label: 'Conversation invokes the local workspace list tool and returns fixture evidence',
    commands: [
      'local_document_create',
      'local_documents_list',
      'conversation_send_turn',
      'conversation_load_history',
      'local_document_archive',
    ],
    requiredEnv: [
      'IMAI_E2E_PROFILE',
      'IMAI_E2E_AGENT_ID',
      'IMAI_E2E_MAIN_SESSION_KEY',
      'IMAI_E2E_EXPECTED_MODEL',
    ],
  },
  {
    id: 'release-truthful-error',
    label: 'Authentication or upstream failure is rendered as a truthful product error',
    commands: ['conversation_send_turn'],
    requiredEnv: [
      'IMAI_E2E_PROFILE',
      'IMAI_E2E_MAIN_SESSION_KEY',
      'IMAI_E2E_FAILURE_KIND',
      'IMAI_E2E_FAILURE_PROMPT',
      'IMAI_E2E_FAILURE_EXPECTED_TEXT',
    ],
  },
]

const RELEASE_BEHAVIOR_ENV = [
  ['profile', 'IMAI_E2E_PROFILE'],
  ['agentId', 'IMAI_E2E_AGENT_ID'],
  ['mainSessionKey', 'IMAI_E2E_MAIN_SESSION_KEY'],
  ['cronSessionKey', 'IMAI_E2E_CRON_SESSION_KEY'],
  ['expectedModel', 'IMAI_E2E_EXPECTED_MODEL'],
  ['expectedModelLabel', 'IMAI_E2E_EXPECTED_MODEL_LABEL'],
  ['failureKind', 'IMAI_E2E_FAILURE_KIND'],
  ['failurePrompt', 'IMAI_E2E_FAILURE_PROMPT'],
  ['failureExpectedText', 'IMAI_E2E_FAILURE_EXPECTED_TEXT'],
]

export function releaseBehaviorFixtureFromEnv(env = process.env) {
  const fixture = Object.fromEntries(RELEASE_BEHAVIOR_ENV.map(([field, name]) => [
    field,
    String(env[name] || '').trim(),
  ]))
  fixture.localWorkspacePrompt = String(env.IMAI_E2E_LOCAL_WORKSPACE_PROMPT || '').trim()
    || '请调用 uniopc_local_documents_list，并逐字返回文档标题。'
  fixture.missing = RELEASE_BEHAVIOR_ENV
    .filter(([, name]) => !String(env[name] || '').trim())
    .map(([, name]) => name)
  fixture.configured = fixture.missing.length === 0
  return fixture
}

function releaseEvidence(condition, message) {
  if (!condition) throw new Error(message)
}

function responseField(value, camel, snake = camel) {
  return value?.[camel] ?? value?.[snake]
}

function historyModelRef(history) {
  const model = String(responseField(history, 'model') || '').trim()
  const provider = String(responseField(history, 'modelProvider', 'model_provider') || '').trim()
  if (!model || model.includes('/') || !provider) return model
  return `${provider}/${model}`
}

function normalizedSessionKey(session) {
  return String(session?.key || session?.sessionKey || session?.session_key || '').trim()
}

export function evaluateReleaseBehavior(id, evidence, fixture) {
  if (id === 'release-model-identity') {
    const route = String(evidence?.display?.route || '')
    const selectedSessionKey = String(evidence?.display?.selectedSessionKey || '').trim()
    const displayedModel = String(evidence?.display?.modelLabel || '').trim()
    const historySessionKey = String(responseField(evidence?.history, 'sessionKey', 'session_key') || '').trim()
    const actualModel = historyModelRef(evidence?.history)
    releaseEvidence(route.startsWith('/conversations'), 'Model identity evidence did not come from the conversations page.')
    releaseEvidence(selectedSessionKey === fixture.mainSessionKey, 'Displayed model did not come from the selected session under test.')
    releaseEvidence(displayedModel === fixture.expectedModelLabel, `Displayed model was ${displayedModel || '<empty>'}, expected ${fixture.expectedModelLabel}.`)
    releaseEvidence(historySessionKey === fixture.mainSessionKey, 'Actual model evidence came from the wrong Gateway session.')
    releaseEvidence(responseField(evidence?.history, 'gatewayAligned', 'gateway_aligned') === true, 'Actual model evidence was not Gateway-aligned.')
    releaseEvidence(actualModel === fixture.expectedModel, `Actual model was ${actualModel || '<empty>'}, expected ${fixture.expectedModel}.`)
    return { ok: true, displayedModel, actualModel, sessionKey: historySessionKey }
  }

  if (id === 'release-session-ownership') {
    const sessions = Array.isArray(evidence?.sessions) ? evidence.sessions : []
    const main = sessions.find(session => normalizedSessionKey(session) === fixture.mainSessionKey)
    const cron = sessions.find(session => normalizedSessionKey(session) === fixture.cronSessionKey)
    releaseEvidence(main, `Main session ${fixture.mainSessionKey} was not returned by the Gateway.`)
    releaseEvidence(cron, `Cron session ${fixture.cronSessionKey} was not returned by the Gateway.`)
    releaseEvidence(fixture.mainSessionKey !== fixture.cronSessionKey, 'Main and cron session keys must be distinct.')
    releaseEvidence(String(main.kind || '').toLowerCase() === 'main', 'Main session did not retain main session ownership.')
    releaseEvidence(String(cron.kind || '').toLowerCase() === 'cron', 'Cron session did not retain cron session ownership.')
    releaseEvidence(String(main.agentId || main.agent_id || '') === fixture.agentId, 'Main session belongs to the wrong agent.')
    releaseEvidence(String(cron.agentId || cron.agent_id || '') === fixture.agentId, 'Cron session belongs to the wrong agent.')
    return { ok: true, mainSessionKey: fixture.mainSessionKey, cronSessionKey: fixture.cronSessionKey }
  }

  if (id === 'release-plugin-catalog') {
    releaseEvidence(String(evidence?.profile || '') === fixture.profile, 'Plugin catalog belongs to the wrong profile.')
    releaseEvidence(responseField(evidence, 'gatewaySupportsToolConstraints', 'gateway_supports_tool_constraints') === true, 'Gateway tool constraints are not active.')
    const plugins = Array.isArray(evidence?.plugins) ? evidence.plugins : []
    const plugin = plugins.find(item => item?.id === 'uniopc-local-workspace')
    releaseEvidence(plugin, 'Local workspace plugin is absent from the runtime catalog.')
    const ready = plugin.enabled === true
      && plugin.installed === true
      && plugin.status === 'ready'
      && responseField(plugin, 'businessHealthState', 'business_health_state') === 'ready'
      && Array.isArray(responseField(plugin, 'readinessReasons', 'readiness_reasons'))
      && responseField(plugin, 'readinessReasons', 'readiness_reasons').length === 0
    releaseEvidence(ready, 'Local workspace plugin is present but not ready.')
    const tools = Array.isArray(plugin.tools) ? plugin.tools : []
    releaseEvidence(tools.some(tool => tool?.name === 'uniopc_local_documents_list'), 'Local workspace list tool is absent from the ready catalog.')
    return { ok: true, pluginId: plugin.id, toolName: 'uniopc_local_documents_list' }
  }

  if (id === 'release-local-workspace-tool') {
    const accepted = evidence?.accepted
    const history = evidence?.history
    const proofTitle = String(fixture.workspaceProofTitle || '').trim()
    const idempotencyKey = String(fixture.localWorkspaceIdempotencyKey || '').trim()
    const prompt = String(fixture.localWorkspacePrompt || '').trim()
    const acceptedSessionKey = String(responseField(accepted, 'gatewaySessionKey', 'gateway_session_key') || '').trim()
    const historySessionKey = String(responseField(history, 'sessionKey', 'session_key') || '').trim()
    const messages = Array.isArray(history?.messages) ? history.messages : []
    const previousAssistantIds = new Set(evidence?.previousAssistantIds || [])
    const boundUserIndex = messages.findIndex(message => (
      String(message?.role || '').toLowerCase() === 'user'
      && String(responseField(message, 'idempotencyKey', 'idempotency_key') || '') === idempotencyKey
    ))
    const resultMessage = messages.find((message, index) => (
      index > boundUserIndex
      && String(message?.role || '').toLowerCase() === 'assistant'
      && !previousAssistantIds.has(String(message?.id || ''))
      && String(message?.content || '').includes(proofTitle)
    ))
    const actualModel = historyModelRef(history)
    const beforeHistoryText = (evidence?.beforeHistory?.messages || [])
      .map(message => String(message?.content || ''))
      .join('\n')
    const beforeDisplayText = String(evidence?.beforeDisplayText || '')
    const workspaceDocument = evidence?.workspaceDocument
    releaseEvidence(proofTitle, 'Local workspace proof title is missing.')
    releaseEvidence(!prompt.includes(proofTitle), 'Local workspace proof title must not be present in the prompt.')
    releaseEvidence(!beforeHistoryText.includes(proofTitle), 'Local workspace proof title was already present in Gateway history.')
    releaseEvidence(!beforeDisplayText.includes(proofTitle), 'Local workspace proof title was already present in the displayed conversation.')
    releaseEvidence(
      String(workspaceDocument?.id || '').trim()
      && String(workspaceDocument?.title || '') === proofTitle,
      'Local workspace proof document was not created in the E2E profile.',
    )
    releaseEvidence(String(responseField(accepted, 'runId', 'run_id') || '').trim(), 'Local workspace tool turn was not accepted with a run id.')
    releaseEvidence(responseField(accepted, 'gatewayAligned', 'gateway_aligned') === true, 'Local workspace tool turn was not accepted by the Gateway.')
    releaseEvidence(acceptedSessionKey === fixture.mainSessionKey, 'Local workspace tool turn was accepted in the wrong session.')
    releaseEvidence(responseField(history, 'hasActiveRun', 'has_active_run') === false, 'Local workspace tool turn did not reach a terminal Gateway history state.')
    releaseEvidence(boundUserIndex >= 0, 'Local workspace result was not linked to the bound user turn.')
    releaseEvidence(resultMessage, 'Local workspace tool returned no new assistant result containing the unique workspace proof.')
    releaseEvidence(String(resultMessage.content || '').trim(), 'Local workspace tool returned a contentless successful recovery run.')
    releaseEvidence(responseField(history, 'gatewayAligned', 'gateway_aligned') === true, 'Local workspace tool history was not Gateway-aligned.')
    releaseEvidence(historySessionKey === fixture.mainSessionKey, 'Local workspace tool completed in the wrong session.')
    releaseEvidence(actualModel === fixture.expectedModel, `Local workspace tool turn used ${actualModel || '<empty>'}, expected ${fixture.expectedModel}.`)
    return {
      ok: true,
      sessionKey: historySessionKey,
      model: actualModel,
      runId: String(responseField(accepted, 'runId', 'run_id')),
      idempotencyKey,
      workspaceDocumentId: workspaceDocument.id,
    }
  }

  if (id === 'release-truthful-error') {
    const beforeErrorText = String(evidence?.beforeErrorText || '')
    const errorText = String(evidence?.errorText || '').trim()
    const ipcEvent = evidence?.ipcEvent
    const request = ipcEvent?.args?.req
    const kind = String(fixture.failureKind || '').toLowerCase()
    const idempotencyKey = String(fixture.failureIdempotencyKey || '').trim()
    const eventSequence = Number(ipcEvent?.sequence)
    const monitorBaseline = Number(fixture.failureMonitorBaseline)
    const expectedSequence = Number(fixture.failureEventSequence)
    releaseEvidence(['authentication', 'upstream'].includes(kind), `Unsupported release failure kind: ${kind || '<empty>'}.`)
    releaseEvidence(!beforeErrorText.includes(fixture.failureExpectedText), 'Expected truthful marker was already present before the new failure operation.')
    releaseEvidence(ipcEvent?.command === 'conversation_send_turn', 'Displayed failure was not linked to a new conversation_send_turn IPC event.')
    releaseEvidence(Number.isSafeInteger(eventSequence) && eventSequence > monitorBaseline, 'Displayed failure was not linked to an invoke after the failure monitor baseline.')
    releaseEvidence(Number.isSafeInteger(expectedSequence) && eventSequence === expectedSequence, 'Displayed failure was not linked to the same invoke event sequence captured at call start.')
    releaseEvidence(String(request?.profile || '') === fixture.profile, 'Failed operation used the wrong E2E profile.')
    releaseEvidence(String(request?.sessionKey || '') === fixture.mainSessionKey, 'Failed operation used the wrong Gateway session.')
    releaseEvidence(String(request?.input || '') === fixture.failurePrompt, 'Failed operation input did not match the submitted failure prompt.')
    releaseEvidence(idempotencyKey && String(request?.idempotencyKey || '') === idempotencyKey, 'Displayed failure was not linked to the bound failed operation.')
    releaseEvidence(ipcEvent?.status === 'rejected' && ipcEvent?.result == null && String(ipcEvent?.error || '').trim(), 'Bound failure IPC event was not rejected with a failure result.')
    releaseEvidence(!/CLIXML|FetchError|fetch failed|\bundefined\b|\bnull\b|\uFFFD|openclaw/i.test(errorText), 'Displayed failure contains a forbidden raw error.')
    releaseEvidence(errorText.includes(fixture.failureExpectedText), 'Displayed failure did not contain the expected truthful marker.')
    const semanticPattern = kind === 'authentication'
      ? /鉴权|认证|登录|授权|未授权|401/i
      : /上游|服务|连接|超时|暂时不可用|502|503/i
    releaseEvidence(semanticPattern.test(String(ipcEvent.error)), `Bound failed operation did not identify an ${kind} cause.`)
    releaseEvidence(semanticPattern.test(errorText), `Displayed ${kind} failure did not identify its cause.`)
    return { ok: true, failureKind: kind, idempotencyKey, eventSequence, expectedMarkerObserved: true }
  }

  throw new Error(`Unknown release behavior assertion: ${id}`)
}

export function credentialsFromEnv(env = process.env) {
  const email = String(env.IMAI_E2E_EMAIL || '').trim()
  const password = String(env.IMAI_E2E_PASSWORD || '')
  return {
    email,
    password,
    hasCredentials: Boolean(email && password),
  }
}

export function redactSecrets(value, credentials = credentialsFromEnv()) {
  const isSensitiveKey = key => /(?:credentials?|password|passwd|secrets?|tokens?|api[-_]?key|private[-_]?key)$/i.test(String(key || '').trim())
  let text = typeof value === 'string'
    ? value
    : JSON.stringify(value, (key, nestedValue) => (
        isSensitiveKey(key) ? '[redacted-secret]' : nestedValue
      ), 2)
  if (credentials.email) {
    text = text.split(credentials.email).join('[redacted-email]')
  }
  if (credentials.password) {
    text = text.split(credentials.password).join('[redacted-password]')
  }
  for (const sensitiveValue of credentials.sensitiveValues || []) {
    if (sensitiveValue) text = text.split(sensitiveValue).join('[redacted-fixture]')
  }
  text = text.replace(
    /(["']authorization["']\s*:\s*["'])[^"'\r\n]*(["'])/gi,
    '$1[redacted-authorization]$2',
  )
  text = text.replace(
    /(\bauthorization\b\s*[:=]\s*)(?!["'])(?:Bearer|Basic)\s+[^\s,;}]+/gi,
    '$1[redacted-authorization]',
  )
  text = text.replace(
    /(["'])([^"'\r\n]+)\1(\s*:\s*)(["'])[^"'\r\n]*\4/g,
    (match, keyQuote, key, separator, valueQuote) => (
      isSensitiveKey(key)
        ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[redacted-secret]${valueQuote}`
        : match
    ),
  )
  text = text.replace(
    /(\b[A-Za-z_][A-Za-z0-9_.-]*)(\s*[:=]\s*)(["'])[^"'\r\n]*\3/g,
    (match, key, separator, valueQuote) => (
      isSensitiveKey(key)
        ? `${key}${separator}${valueQuote}[redacted-secret]${valueQuote}`
        : match
    ),
  )
  text = text.replace(
    /(["'])([^"'\r\n]+)\1(\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s*[,}\]])/gi,
    (match, keyQuote, key, separator) => (
      isSensitiveKey(key)
        ? `${keyQuote}${key}${keyQuote}${separator}"[redacted-secret]"`
        : match
    ),
  )
  text = text.replace(
    /(\b(?:[A-Za-z_][A-Za-z0-9_.-]*)?(?:credentials?|password|passwd|secrets?|tokens?|api[-_]?key|private[-_]?key))(\s*[:=]\s*)(?!["'])[^\s,;}&]+/gi,
    (match, key, separator) => (
      isSensitiveKey(key) ? `${key}${separator}[redacted-secret]` : match
    ),
  )
  return text
}

export function buildSummary({
  startedAt,
  finishedAt,
  cases,
  reportDir,
  appStartedByRunner,
}) {
  const passed = cases.filter(item => item.status === 'passed').length
  const skipped = cases.filter(item => item.status === 'skipped').length
  const failed = cases.filter(item => item.status === 'failed').length
  const requiredEvidenceMissing = cases.filter(item => (
    item.requiredEvidence === true && item.status !== 'passed'
  )).length
  const durationMs = Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())

  return {
    status: failed > 0 ? 'failed' : requiredEvidenceMissing > 0 ? 'incomplete' : 'passed',
    startedAt,
    finishedAt,
    durationMs,
    total: cases.length,
    passed,
    failed,
    skipped,
    requiredEvidenceMissing,
    appStartedByRunner,
    artifacts: {
      reportDir,
      log: path.join(reportDir, 'run.log'),
      screenshots: path.join(reportDir, 'screenshots'),
      ipcEvents: path.join(reportDir, 'ipc-events.json'),
    },
    cases,
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function pathExists(value) {
  try {
    await fs.access(value)
    return true
  } catch {
    return false
  }
}

class E2ELogger {
  constructor({ logPath, credentials }) {
    this.logPath = logPath
    this.credentials = credentials
  }

  async write(message, data = null) {
    const payload = data == null ? message : `${message} ${JSON.stringify(data)}`
    const line = `[${new Date().toISOString()}] ${redactSecrets(payload, this.credentials)}\n`
    await fs.appendFile(this.logPath, line)
    console.log(line.trimEnd())
  }
}

class TauriBridgeClient {
  constructor({ host = DEFAULT_HOST, port, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS }) {
    this.host = host
    this.port = port
    this.timeoutMs = timeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.socket = null
  }

  get url() {
    return `ws://${this.host}:${this.port}`
  }

  connect() {
    if (typeof WebSocket !== 'function') {
      throw new Error('This E2E runner requires a Node.js runtime with global WebSocket support.')
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url)
      const timer = setTimeout(() => {
        try { socket.close() } catch {}
        reject(new Error(`Timed out connecting to ${this.url}`))
      }, 2_000)

      socket.addEventListener('open', () => {
        clearTimeout(timer)
        this.socket = socket
        resolve(this)
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`Unable to connect to ${this.url}`))
      })
      socket.addEventListener('message', event => {
        this.handleMessage(event.data)
      })
      socket.addEventListener('close', () => {
        for (const { reject: rejectPending, timer: pendingTimer } of this.pending.values()) {
          clearTimeout(pendingTimer)
          rejectPending(new Error('Tauri MCP bridge connection closed'))
        }
        this.pending.clear()
      })
    })
  }

  handleMessage(raw) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.events.push({ type: 'raw', raw })
      return
    }

    if (parsed?.id && this.pending.has(parsed.id)) {
      const pending = this.pending.get(parsed.id)
      this.pending.delete(parsed.id)
      clearTimeout(pending.timer)
      if (parsed.success === false) {
        pending.reject(new Error(parsed.error || `Bridge command ${pending.command} failed`))
      } else {
        pending.resolve(parsed)
      }
      return
    }

    this.events.push(parsed)
  }

  command(command, args = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Tauri MCP bridge is not connected')
    }
    const id = `e2e-${this.nextId++}`
    const payload = { id, command, args }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for bridge command ${command}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer, command })
      this.socket.send(JSON.stringify(payload))
    })
  }

  async executeJs(script) {
    const response = await this.command('execute_js', {
      script,
      windowLabel: 'main',
    })
    return response.data
  }

  async invoke(command, args = {}) {
    return this.executeJs(`window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`)
  }

  async screenshot({ filePath, maxWidth = 1400 }) {
    const response = await this.command('capture_native_screenshot', {
      format: 'png',
      maxWidth,
      windowLabel: 'main',
    })
    const dataUrl = response.data
    const match = typeof dataUrl === 'string' ? dataUrl.match(/^data:image\/png;base64,(.*)$/) : null
    if (!match) {
      throw new Error('Tauri screenshot did not return a PNG data URL')
    }
    await fs.writeFile(filePath, Buffer.from(match[1], 'base64'))
    return filePath
  }

  close() {
    try { this.socket?.close() } catch {}
  }
}

async function tryConnect(host, port) {
  const client = new TauriBridgeClient({ host, port })
  return client.connect()
}

function launcherExitError(child, phase, code = child?.exitCode, signal = child?.signalCode) {
  const detail = code != null ? `code ${code}` : signal ? `signal ${signal}` : 'an unknown status'
  return new Error(`Tauri launcher exited with ${detail} before ${phase}.`)
}

function throwIfLauncherExited(child, phase) {
  if (child && (child.exitCode != null || child.signalCode != null)) {
    throw launcherExitError(child, phase)
  }
}

async function withLauncherGuard(operation, child, phase) {
  throwIfLauncherExited(child, phase)
  if (!child?.once) return operation

  return new Promise((resolve, reject) => {
    let settled = false
    const onExit = (code, signal) => {
      if (settled) return
      settled = true
      reject(launcherExitError(child, phase, code, signal))
    }
    const finish = callback => value => {
      if (settled) return
      settled = true
      child.removeListener?.('exit', onExit)
      callback(value)
    }
    child.once('exit', onExit)
    Promise.resolve(operation).then(finish(resolve), finish(reject))
  })
}

async function beforeDeadline(operation, remainingMs, message) {
  if (remainingMs <= 0) throw new Error(message)
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), remainingMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function connectToBridge({
  host,
  basePort,
  scanCount,
  timeoutMs,
  logger,
  child = null,
  tryConnectFn = tryConnect,
  sleepFn = sleep,
  nowFn = Date.now,
}) {
  const deadline = nowFn() + timeoutMs
  let lastError = null
  while (nowFn() < deadline) {
    for (let port = basePort; port < basePort + scanCount; port++) {
      if (nowFn() >= deadline) break
      try {
        const client = await beforeDeadline(
          withLauncherGuard(tryConnectFn(host, port), child, 'the MCP bridge became reachable'),
          deadline - nowFn(),
          `Timed out connecting to the Tauri MCP bridge near ${host}:${basePort}.`,
        )
        await logger.write('Connected to Tauri MCP bridge', { host, port })
        return client
      } catch (err) {
        if (/Tauri launcher exited/.test(err.message)) throw err
        lastError = err
      }
    }
    if (nowFn() < deadline) {
      await beforeDeadline(
        withLauncherGuard(sleepFn(1_000), child, 'the MCP bridge became reachable'),
        deadline - nowFn(),
        `Timed out connecting to the Tauri MCP bridge near ${host}:${basePort}.`,
      )
    }
  }
  throw new Error(`Could not connect to Tauri MCP bridge near ${host}:${basePort}. ${lastError?.message || ''}`)
}

export async function waitForMainWindow({
  client,
  child = null,
  timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
  pollIntervalMs = 250,
  sleepFn = sleep,
  nowFn = Date.now,
}) {
  const deadline = nowFn() + timeoutMs
  let mainWindowFound = false
  while (nowFn() < deadline) {
    throwIfLauncherExited(child, 'the main window became ready')
    if (!mainWindowFound) {
      const response = await beforeDeadline(
        withLauncherGuard(client.command('list_windows', {}), child, 'the main window became ready'),
        deadline - nowFn(),
        'Timed out waiting for the Tauri main window.',
      )
      mainWindowFound = (response?.data || []).some(window => (
        window?.label === 'main' || window?.isMain === true
      ))
    }
    if (mainWindowFound) {
      const domReady = await beforeDeadline(
        withLauncherGuard(
          client.executeJs('Boolean(document.body && document.documentElement && document.readyState !== "loading")'),
          child,
          'the main window DOM became ready',
        ),
        deadline - nowFn(),
        'Timed out waiting for the Tauri main window DOM.',
      )
      if (domReady === true) return true
    }
    await beforeDeadline(
      withLauncherGuard(sleepFn(pollIntervalMs), child, 'the main window became ready'),
      deadline - nowFn(),
      'Timed out waiting for the Tauri main window DOM.',
    )
  }
  throw new Error('Timed out waiting for the Tauri main window and DOM to become ready.')
}

export function tauriDevCommandForPlatform({
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
} = {}) {
  const args = ['run', 'tauri:dev', '--', '--config', 'src-tauri/tauri.e2e.conf.json']
  if (platform !== 'win32') return { command: 'npm', args }

  const npmCli = env.npm_execpath
    || path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return { command: execPath, args: [npmCli, ...args] }
}

function startTauriDev({ logger }) {
  // Production builds ship withGlobalTauri=false; the e2e driver still needs
  // window.__TAURI__, so re-enable it via a merged config override here only.
  const launch = tauriDevCommandForPlatform()
  const child = spawn(launch.command, launch.args, {
    cwd: desktopRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FORCE_COLOR: '0',
    },
  })

  child.stdout.on('data', data => {
    void logger.write(`[tauri:dev] ${String(data).trimEnd()}`)
  })
  child.stderr.on('data', data => {
    void logger.write(`[tauri:dev] ${String(data).trimEnd()}`)
  })

  return child
}

function processHasExited(child) {
  return child?.exitCode != null || child?.signalCode != null
}

function waitForProcessExit(child, timeoutMs, label) {
  if (processHasExited(child)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener?.('exit', onExit)
      child.removeListener?.('close', onExit)
      child.removeListener?.('error', onError)
    }
    const onExit = () => {
      cleanup()
      resolve()
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    child.once('exit', onExit)
    child.once('close', onExit)
    child.once('error', onError)
    timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${label} to exit.`))
    }, timeoutMs)
  })
}

export async function stopProcess(child, logger, {
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = 5_000,
} = {}) {
  if (!child || processHasExited(child)) return
  const pid = Number(child.pid)
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Cannot clean up the Tauri launcher without its owned child PID.')
  }

  await logger.write('Stopping Tauri dev process tree', { pid })
  if (platform === 'win32') {
    const taskkill = spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await waitForProcessExit(taskkill, timeoutMs, 'taskkill')
    await waitForProcessExit(child, timeoutMs, `Tauri launcher PID ${pid}`)
    return
  }

  child.kill('SIGTERM')
  try {
    await waitForProcessExit(child, Math.min(1_000, Math.max(1, Math.floor(timeoutMs / 2))), `Tauri launcher PID ${pid}`)
  } catch {
    child.kill('SIGKILL')
    await waitForProcessExit(child, timeoutMs, `Tauri launcher PID ${pid}`)
  }
}

export function e2eDomHelpersSource() {
  return String.raw`
(() => {
  const textOf = () => document.body ? document.body.innerText : '';
  const visible = element => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const fire = (element, type, init = {}) => {
    element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
  };
  const pointer = (element, type) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      view: window,
    }));
  };
  const click = element => {
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    pointer(element, 'mouseover');
    pointer(element, 'mousemove');
    pointer(element, 'mousedown');
    element.focus?.();
    pointer(element, 'mouseup');
    pointer(element, 'click');
    return true;
  };
  const typeInto = (element, value) => {
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    element.value = '';
    fire(element, 'input');
    for (const char of String(value)) {
      element.value += char;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
    }
    fire(element, 'change');
    return true;
  };
  const findByText = (text, selector = 'button,a,[role="button"],input,textarea,[tabindex]') => {
    const needle = String(text).toLowerCase();
    return [...document.querySelectorAll(selector)]
      .find(element => visible(element) && String(element.innerText || element.value || element.getAttribute('aria-label') || element.title || '').toLowerCase().includes(needle));
  };
  const smallestVisibleTextBlock = expected => {
    const needle = String(expected || '');
    if (!needle) return null;
    return [...document.querySelectorAll('div,section,aside,p,span')]
      .filter(element => visible(element) && String(element.innerText || '').includes(needle))
      .sort((left, right) => String(left.innerText || '').length - String(right.innerText || '').length)[0] || null;
  };
  const failureMonitorKey = '__IMAI_E2E_FAILURE_INVOKE_MONITOR__';
  const installFailureInvokeMonitor = ({ maxEvents = 20 } = {}) => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return false;
    const boundedMaxEvents = Math.max(1, Math.min(100, Math.floor(Number(maxEvents) || 20)));
    const existing = window[failureMonitorKey];
    if (existing && internals.invoke === existing.wrappedInvoke) {
      existing.maxEvents = boundedMaxEvents;
      existing.events.splice(0, Math.max(0, existing.events.length - boundedMaxEvents));
      return true;
    }
    const state = {
      events: [],
      maxEvents: boundedMaxEvents,
      originalInvoke: internals.invoke,
      sequence: 0,
      wrappedInvoke: null,
    };
    const finish = (event, status, value) => {
      event.status = status;
      if (status === 'rejected') event.error = String(value?.message || value || 'unknown invoke error');
      return value;
    };
    state.wrappedInvoke = function (command, args, options) {
      let event = null;
      if (command === 'conversation_send_turn') {
        const request = args?.req || {};
        event = {
          sequence: ++state.sequence,
          command,
          args: {
            req: {
              profile: String(request.profile || ''),
              sessionKey: String(request.sessionKey || ''),
              input: String(request.input || ''),
              idempotencyKey: String(request.idempotencyKey || ''),
            },
          },
          status: 'pending',
          result: null,
          error: null,
        };
        state.events.push(event);
        state.events.splice(0, Math.max(0, state.events.length - state.maxEvents));
      }
      let outcome;
      try {
        outcome = state.originalInvoke.apply(this, arguments);
      } catch (error) {
        if (event) finish(event, 'rejected', error);
        throw error;
      }
      if (!event) return outcome;
      if (!outcome || typeof outcome.then !== 'function') {
        finish(event, 'fulfilled', outcome);
        return outcome;
      }
      return Promise.resolve(outcome).then(
        result => {
          finish(event, 'fulfilled', result);
          return result;
        },
        error => {
          finish(event, 'rejected', error);
          throw error;
        },
      );
    };
    window[failureMonitorKey] = state;
    internals.invoke = state.wrappedInvoke;
    return true;
  };
  const failureInvokeBaseline = () => Number(window[failureMonitorKey]?.sequence || 0);
  const failureInvokeEventsAfter = baseline => {
    const state = window[failureMonitorKey];
    if (!state) return [];
    return state.events
      .filter(event => event.sequence > Number(baseline || 0))
      .map(event => ({
        sequence: event.sequence,
        command: event.command,
        args: { req: { ...event.args.req } },
        status: event.status,
        result: event.result,
        error: event.error,
      }));
  };
  const restoreFailureInvokeMonitor = () => {
    const state = window[failureMonitorKey];
    if (!state) return true;
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || internals.invoke !== state.wrappedInvoke) return false;
    internals.invoke = state.originalInvoke;
    delete window[failureMonitorKey];
    return true;
  };
  window.__IMAI_E2E__ = {
    textOf,
    route: () => window.location.hash.replace(/^#/, '') || '/',
    navigate: path => {
      window.location.hash = path;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return window.__IMAI_E2E__.route();
    },
    snapshot: () => ({
      route: window.__IMAI_E2E__.route(),
      title: document.title,
      text: textOf().slice(0, 8000),
      inputCount: document.querySelectorAll('input,textarea').length,
      buttonCount: document.querySelectorAll('button,a,[role="button"]').length,
    }),
    clickText: text => click(findByText(text)),
    typeEmail: value => typeInto(document.querySelector('input[type="email"], input[name="email"]'), value),
    typePassword: value => typeInto(document.querySelector('input[type="password"], input[name="password"]'), value),
    submitLogin: () => click(document.querySelector('form button[type="submit"]') || findByText('登录') || findByText('Sign in')),
    selectConversationSession: sessionKey => {
      const expected = String(sessionKey || '');
      const active = document.querySelector('[data-e2e-active-session-key]');
      if (String(active?.dataset?.e2eActiveSessionKey || '') === expected) return true;
      const target = [...document.querySelectorAll('[data-e2e-session-key]')]
        .find(element => String(element.dataset.e2eSessionKey || '') === expected);
      if (target) return click(target);
      if (active?.getAttribute('aria-expanded') !== 'true') click(active);
      return false;
    },
    releaseSnapshot: expectedFailureText => {
      const modelControl = [...document.querySelectorAll('button')]
        .find(element => visible(element) && String(element.innerText || '').includes('⚡'));
      const sessionControl = document.querySelector('[data-e2e-active-session-key]');
      const failureBlock = smallestVisibleTextBlock(expectedFailureText);
      return {
        route: window.__IMAI_E2E__.route(),
        selectedSessionKey: String(sessionControl?.dataset?.e2eActiveSessionKey || ''),
        modelLabel: String(modelControl?.innerText || '').replace(/[⚡⌄]/g, '').trim(),
        modelTitle: String(modelControl?.title || '').trim(),
        errorText: String(failureBlock?.innerText || '').trim(),
      };
    },
    typeConversation: value => {
      const input = [...document.querySelectorAll('textarea')].find(visible);
      return typeInto(input, value);
    },
    submitConversation: () => {
      const button = [...document.querySelectorAll('button[title="发送"]')]
        .find(element => visible(element) && !element.disabled);
      return click(button);
    },
    installFailureInvokeMonitor,
    failureInvokeBaseline,
    failureInvokeEventsAfter,
    restoreFailureInvokeMonitor,
  };
  return true;
})()
`
}

async function installDomHelpers(client) {
  await client.executeJs(e2eDomHelpersSource())
}

async function waitForCondition(client, predicateSource, {
  timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
  intervalMs = 400,
  sleepFn = sleep,
  nowFn = Date.now,
} = {}) {
  const deadline = nowFn() + timeoutMs
  while (nowFn() < deadline) {
    const result = await client.executeJs(`(() => Boolean((${predicateSource})()))()`)
    if (result === true || result?.value === true) return true
    await sleepFn(intervalMs)
  }
  return false
}

async function selectReleaseSession(client, fixture, { sleepFn = sleep, nowFn = Date.now } = {}) {
  await client.executeJs(`window.__IMAI_E2E__.navigate(${JSON.stringify('/conversations')})`)
  await sleepFn(900)
  await installDomHelpers(client)
  await client.executeJs(
    `window.__IMAI_E2E__.selectConversationSession(${JSON.stringify(fixture.mainSessionKey)})`,
  )
  const selected = await waitForCondition(
    client,
    `() => {
      const active = document.querySelector('[data-e2e-active-session-key]');
      if (String(active?.dataset?.e2eActiveSessionKey || '') === ${JSON.stringify(fixture.mainSessionKey)}) return true;
      window.__IMAI_E2E__.selectConversationSession(${JSON.stringify(fixture.mainSessionKey)});
      return false;
    }`,
    { timeoutMs: DEFAULT_ACTION_TIMEOUT_MS, sleepFn, nowFn },
  )
  releaseEvidence(selected, `Could not select Gateway session ${fixture.mainSessionKey} in the conversation UI.`)
}

async function loadGatewayHistory(client, fixture) {
  return client.invoke('conversation_load_history', {
    sessionKey: fixture.mainSessionKey,
    profile: fixture.profile,
    includeSessionMeta: true,
  })
}

async function waitForCompletedGatewayTurn(client, fixture, previousAssistantIds, timeoutMs, {
  sleepFn = sleep,
  nowFn = Date.now,
} = {}) {
  const deadline = nowFn() + timeoutMs
  let lastHistory = null
  while (nowFn() < deadline) {
    lastHistory = await loadGatewayHistory(client, fixture)
    const messages = Array.isArray(lastHistory?.messages) ? lastHistory.messages : []
    const boundUserIndex = messages.findIndex(message => (
      String(message?.role || '').toLowerCase() === 'user'
      && String(responseField(message, 'idempotencyKey', 'idempotency_key') || '') === fixture.localWorkspaceIdempotencyKey
    ))
    const completed = messages.some((message, index) => (
      index > boundUserIndex
      && String(message?.role || '').toLowerCase() === 'assistant'
      && !previousAssistantIds.has(String(message?.id || ''))
      && String(message?.content || '').includes(fixture.workspaceProofTitle)
    ))
    if (
      boundUserIndex >= 0
      && completed
      && responseField(lastHistory, 'hasActiveRun', 'has_active_run') === false
    ) return lastHistory
    await sleepFn(500)
  }
  throw new Error(
    `Timed out waiting for a new terminal local-workspace result in ${fixture.mainSessionKey}.`,
  )
}

async function snapshot(client) {
  return client.executeJs('window.__IMAI_E2E__.snapshot()')
}

async function ensureAuthenticated({ client, credentials, logger }) {
  await installDomHelpers(client)
  let state = await snapshot(client)
  const text = state?.text || ''
  const onLogin = state?.route?.startsWith('/login') || /登录|sign in/i.test(text)
  if (!onLogin) {
    await logger.write('Login screen not detected; continuing with current session')
    return { attempted: false, reason: 'already-authenticated-or-guarded' }
  }
  if (!credentials.hasCredentials) {
    await logger.write('Login screen detected but IMAI_E2E_EMAIL/IMAI_E2E_PASSWORD are not set; continuing unauthenticated')
    return { attempted: false, reason: 'missing-credentials' }
  }

  await logger.write('Login screen detected; signing in with provided E2E account')
  await client.executeJs(`window.__IMAI_E2E__.typeEmail(${JSON.stringify(credentials.email)})`)
  await client.executeJs(`window.__IMAI_E2E__.typePassword(${JSON.stringify(credentials.password)})`)
  await client.executeJs('window.__IMAI_E2E__.submitLogin()')
  const navigated = await waitForCondition(
    client,
    String.raw`() => {
      const text = window.__IMAI_E2E__.textOf();
      const route = window.__IMAI_E2E__.route();
      return !route.startsWith('/login') || /登录失败|sign in failed|组织开通未完成|正在检查账号开通状态|workspace/i.test(text);
    }`,
    { timeoutMs: 45_000 },
  )
  state = await snapshot(client)
  if (!navigated || /登录失败|sign in failed/i.test(state?.text || '')) {
    throw new Error('E2E account sign-in did not reach an authenticated or setup state')
  }
  return { attempted: true, reason: 'submitted' }
}

function caseMatchedText(text, expected = []) {
  return expected.find(item => new RegExp(escapeForRegExp(item), 'i').test(text))
}

export function evaluateSmokeText(text, smokeCase) {
  const required = smokeCase?.required || []
  const missingRequired = required.filter(item => !new RegExp(escapeForRegExp(item), 'i').test(text))
  const matched = caseMatchedText(text, smokeCase?.expected || [])
  const ok = missingRequired.length === 0 && (required.length > 0 || Boolean(matched))
  return {
    ok,
    matched,
    missingRequired,
  }
}

async function runSmokeCase({ client, smokeCase, screenshotsDir, logger }) {
  const started = Date.now()
  if (smokeCase.path) {
    await client.executeJs(`window.__IMAI_E2E__.navigate(${JSON.stringify(smokeCase.path)})`)
    await sleep(900)
  }
  await installDomHelpers(client)
  await waitForCondition(client, '() => document.body && document.body.innerText.trim().length > 0', { timeoutMs: 10_000 })
  const state = await snapshot(client)
  const screenshot = path.join(screenshotsDir, `${smokeCase.id}.png`)
  await client.screenshot({ filePath: screenshot })

  const text = `${state?.route || ''}\n${state?.title || ''}\n${state?.text || ''}`
  const evaluated = evaluateSmokeText(text, smokeCase)
  if (!evaluated.ok && smokeCase.optional) {
    await logger.write(`Skipped optional case ${smokeCase.id}; expected markers not visible`, {
      route: state?.route,
    })
    return {
      id: smokeCase.id,
      label: smokeCase.label,
      status: 'skipped',
      durationMs: Date.now() - started,
      route: state?.route,
      screenshot,
      expected: smokeCase.expected,
      required: smokeCase.required,
      missingRequired: evaluated.missingRequired,
    }
  }
  if (!evaluated.ok) {
    const requiredMessage = evaluated.missingRequired.length
      ? `Missing required [${evaluated.missingRequired.join(', ')}]. `
      : ''
    throw new Error(`${requiredMessage}Expected one of [${(smokeCase.expected || []).join(', ')}] on ${smokeCase.path || 'current route'}, got route ${state?.route}`)
  }

  return {
    id: smokeCase.id,
    label: smokeCase.label,
    status: 'passed',
    durationMs: Date.now() - started,
    route: state?.route,
    matched: evaluated.matched,
    missingRequired: evaluated.missingRequired,
    screenshot,
  }
}

async function waitForFailureInvokeEvent(client, fixture, monitorBaseline, {
  idempotencyKey = '',
  expectedSequence = null,
  requireRejected = false,
  timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
  intervalMs = 100,
  sleepFn = sleep,
  nowFn = Date.now,
} = {}) {
  const deadline = nowFn() + timeoutMs
  do {
    const events = await client.executeJs(
      `window.__IMAI_E2E__.failureInvokeEventsAfter(${JSON.stringify(monitorBaseline)})`,
    )
    const event = (Array.isArray(events) ? events : []).find(candidate => {
      const request = candidate?.args?.req
      const sequence = Number(candidate?.sequence)
      return candidate?.command === 'conversation_send_turn'
        && Number.isSafeInteger(sequence)
        && sequence > monitorBaseline
        && (expectedSequence == null || sequence === expectedSequence)
        && String(request?.profile || '') === fixture.profile
        && String(request?.sessionKey || '') === fixture.mainSessionKey
        && String(request?.input || '') === fixture.failurePrompt
        && String(request?.idempotencyKey || '').trim()
        && (!idempotencyKey || String(request.idempotencyKey) === idempotencyKey)
        && (!requireRejected || (
          candidate?.status === 'rejected'
          && candidate?.result == null
          && String(candidate?.error || '').trim()
        ))
    })
    if (event) return event
    if (nowFn() < deadline) await sleepFn(intervalMs)
  } while (nowFn() < deadline)
  const phase = requireRejected ? 'rejected' : 'started'
  const sequenceDetail = expectedSequence == null ? '' : ` and invoke sequence ${expectedSequence}`
  throw new Error(`No ${phase} conversation_send_turn invoke matched the failure prompt, E2E profile, session${sequenceDetail}.`)
}

export async function runReleaseBehaviorAssertions({
  client,
  fixture,
  logger,
  behaviorCases = RELEASE_BEHAVIOR_CASES,
  randomUUIDFn = randomUUID,
  sleepFn = sleep,
  nowFn = Date.now,
}) {
  const cases = []

  for (const behavior of behaviorCases) {
    const missing = behavior.requiredEnv.filter(name => fixture.missing.includes(name))
    if (missing.length > 0) {
      cases.push({
        id: behavior.id,
        label: behavior.label,
        status: 'skipped',
        requiredEvidence: true,
        durationMs: 0,
        reason: `Missing release fixture inputs: ${missing.join(', ')}`,
      })
      continue
    }

    const started = nowFn()
    try {
      let evidence
      let evidenceFixture = fixture
      if (behavior.id === 'release-model-identity') {
        await selectReleaseSession(client, fixture, { sleepFn, nowFn })
        const display = await client.executeJs('window.__IMAI_E2E__.releaseSnapshot()')
        const history = await client.invoke('conversation_load_history', {
          sessionKey: fixture.mainSessionKey,
          profile: fixture.profile,
          includeSessionMeta: true,
        })
        evidence = { display, history }
      } else if (behavior.id === 'release-session-ownership') {
        const response = await client.invoke('conversation_list_sessions', {
          req: {
            agentId: fixture.agentId,
            profile: fixture.profile,
            offset: 0,
            limit: 200,
          },
        })
        evidence = { sessions: Array.isArray(response?.sessions) ? response.sessions : [] }
      } else if (behavior.id === 'release-plugin-catalog') {
        evidence = await client.invoke('openclaw_profile_tool_capabilities_list', {
          profile: fixture.profile,
        })
      } else if (behavior.id === 'release-local-workspace-tool') {
        await selectReleaseSession(client, fixture, { sleepFn, nowFn })
        const beforeDisplay = await snapshot(client)
        const before = await loadGatewayHistory(client, fixture)
        const previousAssistantIds = new Set(
          (Array.isArray(before?.messages) ? before.messages : [])
            .filter(message => String(message?.role || '').toLowerCase() === 'assistant')
            .map(message => String(message?.id || '')),
        )
        const workspaceProofTitle = `Uniopc E2E workspace proof ${randomUUIDFn()}`
        const localWorkspaceIdempotencyKey = `e2e-local-workspace-${randomUUIDFn()}`
        const localFixture = {
          ...fixture,
          workspaceProofTitle,
          localWorkspaceIdempotencyKey,
        }
        evidenceFixture = localFixture
        let workspaceDocument = null
        try {
          const created = await client.invoke('local_document_create', {
            input: {
              profile: fixture.profile,
              title: workspaceProofTitle,
              category: 'testing',
              blocksuiteBody: `E2E release validation workspace proof: ${workspaceProofTitle}`,
              markdownProjection: `# ${workspaceProofTitle}`,
              metadata: { e2eReleaseValidation: true },
            },
          })
          workspaceDocument = created?.document
          releaseEvidence(String(workspaceDocument?.id || '').trim(), 'Could not create the unique local workspace proof document.')
          const listed = await client.invoke('local_documents_list', {
            input: { profile: fixture.profile },
          })
          releaseEvidence(
            (listed?.documents || []).some(document => (
              String(document?.id || '') === String(workspaceDocument.id)
              && String(document?.title || '') === workspaceProofTitle
            )),
            'The unique local workspace proof document was not observable in the E2E profile.',
          )
          const accepted = await client.invoke('conversation_send_turn', {
            req: {
              agentId: fixture.agentId,
              conversationId: 'e2e-release-validation',
              sessionKey: fixture.mainSessionKey,
              profile: fixture.profile,
              idempotencyKey: localWorkspaceIdempotencyKey,
              input: fixture.localWorkspacePrompt,
              attachments: [],
              mentions: [{
                kind: 'plugin',
                name: 'uniopc-local-workspace',
                label: 'Uniopc Local Workspace',
                trigger: 'slash',
              }],
              toolInvocations: [{
                pluginId: 'uniopc-local-workspace',
                toolName: 'uniopc_local_documents_list',
                trigger: 'slash',
              }],
              modelOverride: fixture.expectedModel,
            },
          })
          const history = await waitForCompletedGatewayTurn(
            client,
            localFixture,
            previousAssistantIds,
            Number(process.env.IMAI_E2E_TOOL_TIMEOUT_MS || 120_000),
            { sleepFn, nowFn },
          )
          evidence = {
            accepted,
            history,
            previousAssistantIds: [...previousAssistantIds],
            beforeDisplayText: beforeDisplay?.text || '',
            beforeHistory: before,
            workspaceDocument,
          }
        } finally {
          if (workspaceDocument?.id) {
            await client.invoke('local_document_archive', {
              input: { profile: fixture.profile, id: workspaceDocument.id },
            })
          }
        }
      } else if (behavior.id === 'release-truthful-error') {
        await selectReleaseSession(client, fixture, { sleepFn, nowFn })
        const beforeDisplay = await client.executeJs(
          `window.__IMAI_E2E__.releaseSnapshot(${JSON.stringify(fixture.failureExpectedText)})`,
        )
        let operationError = null
        let monitorInstalled = false
        try {
          monitorInstalled = await client.executeJs(
            'window.__IMAI_E2E__.installFailureInvokeMonitor({ maxEvents: 20 })',
          )
          releaseEvidence(monitorInstalled === true, 'Could not install the production Tauri invoke failure monitor.')
          const monitorBaseline = await client.executeJs('window.__IMAI_E2E__.failureInvokeBaseline()')
          releaseEvidence(Number.isSafeInteger(monitorBaseline), 'Failure invoke monitor returned an invalid baseline.')
          const typed = await client.executeJs(`window.__IMAI_E2E__.typeConversation(${JSON.stringify(fixture.failurePrompt)})`)
          releaseEvidence(typed === true, 'Could not type the failure probe into the conversation composer.')
          const submitted = await client.executeJs('window.__IMAI_E2E__.submitConversation()')
          releaseEvidence(submitted === true, 'Could not submit the failure probe from the conversation composer.')
          const startedEvent = await waitForFailureInvokeEvent(client, fixture, monitorBaseline, {
            timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
            sleepFn,
            nowFn,
          })
          const failureIdempotencyKey = String(startedEvent?.args?.req?.idempotencyKey || '')
          releaseEvidence(failureIdempotencyKey, 'Failure invoke did not bind an idempotency key at call start.')
          const failureEventSequence = Number(startedEvent?.sequence)
          releaseEvidence(
            Number.isSafeInteger(failureEventSequence) && failureEventSequence > monitorBaseline,
            'Failure invoke did not bind a safe event sequence after the monitor baseline.',
          )
          const rendered = await waitForCondition(
            client,
            `() => document.body && document.body.innerText.includes(${JSON.stringify(fixture.failureExpectedText)})`,
            { timeoutMs: 45_000, sleepFn, nowFn },
          )
          releaseEvidence(rendered, 'Expected authentication/upstream failure was not rendered before timeout.')
          const display = await client.executeJs(
            `window.__IMAI_E2E__.releaseSnapshot(${JSON.stringify(fixture.failureExpectedText)})`,
          )
          const ipcEvent = await waitForFailureInvokeEvent(client, fixture, monitorBaseline, {
            idempotencyKey: failureIdempotencyKey,
            expectedSequence: failureEventSequence,
            requireRejected: true,
            timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
            sleepFn,
            nowFn,
          })
          evidenceFixture = {
            ...fixture,
            failureIdempotencyKey,
            failureEventSequence,
            failureMonitorBaseline: monitorBaseline,
          }
          evidence = {
            beforeErrorText: beforeDisplay?.errorText || '',
            errorText: display?.errorText || '',
            ipcEvent,
          }
        } catch (error) {
          operationError = error
        }
        if (monitorInstalled) {
          try {
            const restored = await client.executeJs('window.__IMAI_E2E__.restoreFailureInvokeMonitor()')
            releaseEvidence(restored === true, 'Could not restore the production Tauri invoke function after failure evidence capture.')
          } catch (restoreError) {
            if (operationError) {
              throw new AggregateError(
                [operationError, restoreError],
                `${operationError.message} Failure invoke monitor restoration also failed: ${restoreError.message}`,
              )
            }
            throw restoreError
          }
        }
        if (operationError) throw operationError
      }

      const result = evaluateReleaseBehavior(behavior.id, evidence, evidenceFixture)
      const passed = {
        id: behavior.id,
        label: behavior.label,
        status: 'passed',
        requiredEvidence: true,
        durationMs: nowFn() - started,
        evidence: result,
      }
      cases.push(passed)
      await logger.write(`Release behavior ${behavior.id} passed`, passed)
    } catch (error) {
      const failed = {
        id: behavior.id,
        label: behavior.label,
        status: 'failed',
        requiredEvidence: true,
        durationMs: nowFn() - started,
        error: String(error?.message || error),
      }
      cases.push(failed)
      await logger.write(`Release behavior ${behavior.id} failed`, failed)
    }
  }

  return cases
}

async function writeJson(filePath, value, credentials) {
  await fs.writeFile(filePath, `${redactSecrets(value, credentials)}\n`)
}

async function run() {
  const startedAt = new Date().toISOString()
  const credentials = credentialsFromEnv()
  const reportSecrets = {
    ...credentials,
    sensitiveValues: [
      process.env.IMAI_E2E_FAILURE_PROMPT,
      process.env.IMAI_E2E_LOCAL_WORKSPACE_PROMPT,
    ].map(value => String(value || '').trim()).filter(Boolean),
  }
  const reportDir = path.resolve(desktopRoot, 'reports', 'e2e-tauri', timestampForPath())
  const screenshotsDir = path.join(reportDir, 'screenshots')
  await fs.mkdir(screenshotsDir, { recursive: true })
  const logger = new E2ELogger({ logPath: path.join(reportDir, 'run.log'), credentials: reportSecrets })
  await logger.write('Starting Uniopc Tauri E2E smoke run')

  let child = null
  const useRunningApp = process.env.IMAI_E2E_USE_RUNNING_APP === '1'
  const appStartedByRunner = !useRunningApp
  const host = process.env.IMAI_E2E_TAURI_HOST || DEFAULT_HOST
  const basePort = Number(process.env.IMAI_E2E_TAURI_PORT || DEFAULT_BASE_PORT)

  try {
    if (!useRunningApp) {
      if (!(await pathExists(path.join(desktopRoot, 'node_modules')))) {
        throw new Error('node_modules is missing. Run npm install before E2E tests.')
      }
      child = startTauriDev({ logger })
    }

    const client = await connectToBridge({
      host,
      basePort,
      scanCount: DEFAULT_PORT_SCAN_COUNT,
      timeoutMs: Number(process.env.IMAI_E2E_CONNECT_TIMEOUT_MS || DEFAULT_CONNECT_TIMEOUT_MS),
      logger,
      child,
    })

    const cases = []
    try {
      await waitForMainWindow({
        client,
        child,
        timeoutMs: Number(process.env.IMAI_E2E_WINDOW_TIMEOUT_MS || DEFAULT_CONNECT_TIMEOUT_MS),
      })
      await installDomHelpers(client)
      await client.command('invoke_tauri', {
        command: 'plugin:mcp-bridge|start_ipc_monitor',
        args: { windowLabel: 'main' },
      })
      await ensureAuthenticated({ client, credentials, logger })

      for (const smokeCase of DEFAULT_SMOKE_CASES) {
        await logger.write(`Running case ${smokeCase.id}: ${smokeCase.label}`)
        try {
          const result = await runSmokeCase({ client, smokeCase, screenshotsDir, logger })
          cases.push(result)
          await logger.write(`Case ${smokeCase.id} ${result.status}`, result)
        } catch (err) {
          const screenshot = path.join(screenshotsDir, `${smokeCase.id}-failed.png`)
          try {
            await client.screenshot({ filePath: screenshot })
          } catch {}
          const failed = {
            id: smokeCase.id,
            label: smokeCase.label,
            status: 'failed',
            durationMs: 0,
            error: err.message,
            screenshot,
          }
          cases.push(failed)
          await logger.write(`Case ${smokeCase.id} failed`, failed)
        }
      }

      const releaseFixture = releaseBehaviorFixtureFromEnv()
      const releaseCases = await runReleaseBehaviorAssertions({
        client,
        fixture: releaseFixture,
        logger,
      })
      cases.push(...releaseCases)

      let ipcEvents = []
      try {
        const response = await client.command('invoke_tauri', {
          command: 'plugin:mcp-bridge|get_ipc_events',
          args: { windowLabel: 'main' },
        })
        ipcEvents = response.data || []
      } catch (err) {
        await logger.write('Could not read IPC events', { error: err.message })
      }
      await writeJson(path.join(reportDir, 'ipc-events.json'), ipcEvents, reportSecrets)
    } finally {
      client.close()
    }

    const finishedAt = new Date().toISOString()
    const summary = buildSummary({
      startedAt,
      finishedAt,
      cases,
      reportDir,
      appStartedByRunner,
    })
    await writeJson(path.join(reportDir, 'summary.json'), summary, reportSecrets)
    await logger.write('E2E summary written', summary)
    process.exitCode = summary.status === 'passed' ? 0 : 1
  } catch (err) {
    const finishedAt = new Date().toISOString()
    const summary = buildSummary({
      startedAt,
      finishedAt,
      cases: [{
        id: 'runner',
        label: 'E2E runner setup',
        status: 'failed',
        durationMs: 0,
        error: err.message,
      }],
      reportDir,
      appStartedByRunner,
    })
    await writeJson(path.join(reportDir, 'summary.json'), summary, reportSecrets)
    await logger.write('E2E runner failed', { error: err.stack || err.message })
    process.exitCode = 1
  } finally {
    await stopProcess(child, logger)
  }
}

if (process.argv[1] === __filename) {
  run()
}
