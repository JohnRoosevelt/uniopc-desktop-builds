import { convertFileSrc } from '@tauri-apps/api/core'
import { engineClient } from '../engine/client.js'
import { getGatewayClientReadiness } from './gatewayClient'
import {
  conversationImageAttachmentsToGateway,
  gatewayHistoryMediaToAttachments,
} from '../conversationAttachments'

export const CONVERSATION_RUNTIMES = {
  gateway_native: {
    mode: 'gateway_native',
    transport: 'gateway_websocket',
    gatewayAligned: true,
    label: 'Gateway 原生模式',
    summary: 'Uniopc 对话 UI 已接入 Uniopc 引擎 WebSocket 数据面。',
  },
}

export const CONVERSATION_RUNTIME = {
  ...CONVERSATION_RUNTIMES.gateway_native,
}

export function historyVideoMediaTokens(mediaPaths, mediaTypes) {
  const paths = Array.isArray(mediaPaths) ? mediaPaths : []
  const types = Array.isArray(mediaTypes) ? mediaTypes : []
  return paths.filter((path, index) => {
    const value = String(path || '').trim()
    const mimeType = String(types[index] || '').trim().toLowerCase()
    return value.startsWith('/') && /\.(?:mp4|mov|webm|m4v)$/i.test(value) && mimeType.startsWith('video/')
  })
}

function completedVideoPathsFromAssistantText(content) {
  const source = String(content || '')
  const matches = source.match(/\/[^\n`]+?\/state-v8\/(?:uniopc|openclaw)-[^/\s]+(?:\/[^/\s]+)*\/media\/uniopc-(?:montage|superip)\/[^/\s]+?\.(?:mp4|mov|webm|m4v)/gi) || []
  return [...new Set(matches.map(path => path.trim()))]
}

// Rust emits this only after a `chat.send` transport path ended without a
// Gateway response. The request may already be in durable Gateway custody.
export function isConversationDeliveryUnconfirmedError(error) {
  return String(error?.message || error || '').includes('delivery_unconfirmed:')
}

export function resolveConversationRuntime(meta = null) {
  const mode = meta?.runtimeMode
  if (mode && CONVERSATION_RUNTIMES[mode]) {
    return CONVERSATION_RUNTIMES[mode]
  }
  return CONVERSATION_RUNTIMES.gateway_native
}

export function getConversationRuntimeStatus(openClawStatus = null, connectionSnapshot = null) {
  const gateway = getGatewayClientReadiness(openClawStatus, connectionSnapshot)

  return {
    current: CONVERSATION_RUNTIME,
    target: CONVERSATION_RUNTIMES.gateway_native,
    gateway,
    targetReady: gateway.connectionReady,
    nextStep: gateway.connectionReady
      ? 'Gateway WebSocket 对话通道已就绪。'
      : '需要先启动 Uniopc 引擎，Uniopc 才能发起原生 Gateway 对话。',
  }
}

export async function sendConversationTurn({
  agentId,
  input,
  attachments = [],
  conversationId,
  sessionKey,
  profile = null,
  idempotencyKey = null,
  mentions = [],
  toolInvocations = [],
  approvalMode = null,
  modelOverride = null,
  thinkingOverride = null,
}) {
  const text = String(input || '').trim()
  const gatewayAttachments = conversationImageAttachmentsToGateway(attachments)
  if (!text && gatewayAttachments.length === 0) throw new Error('缺少用户输入，无法发起对话。')

  const res = await engineClient.sessions.sendTurn({
    req: {
      agentId,
      conversationId,
      sessionKey,
      profile,
      idempotencyKey,
      mentions,
      toolInvocations,
      approvalMode,
      modelOverride,
      thinkingOverride,
      input: text,
      attachments: gatewayAttachments,
    },
  })

  return {
    content: res.content || '',
    meta: {
      providerType: res.providerType || 'openclaw',
      model: res.model || '',
      dataFlow: res.dataFlow || '',
      runId: res.runId || idempotencyKey || null,
      runtimeMode: res.runtimeMode || CONVERSATION_RUNTIME.mode,
      transport: res.transport || CONVERSATION_RUNTIME.transport,
      gatewaySessionKey: res.gatewaySessionKey || null,
      gatewaySessionId: res.gatewaySessionId || null,
      gatewayAligned: Boolean(res.gatewayAligned),
    },
  }
}

export async function abortConversationTurn({ sessionKey, runId = null, profile = null }) {
  const normalized = String(sessionKey || '').trim()
  if (!normalized) throw new Error('缺少 Gateway session key，无法停止对话。')
  return engineClient.sessions.abortTurn({
    req: {
      sessionKey: normalized,
      runId,
      profile,
    },
  })
}

export async function subscribeConversationSession(sessionKey, profile = null) {
  const normalized = String(sessionKey || '').trim()
  if (!normalized) return { ok: false, sessionKey: null }
  const res = await engineClient.sessions.subscribe({ sessionKey: normalized, profile })
  return {
    ok: Boolean(res.ok),
    sessionKey: res.sessionKey || normalized,
    transport: res.transport || 'gateway_websocket',
    gatewayAligned: Boolean(res.gatewayAligned),
  }
}

/// `includeSessionMeta: false` drops the model / thinking-level lookup, which
/// costs a second gateway round trip over 200 sessions. Use it for refreshes
/// that only need the transcript (post-turn, lost-run probe).
export async function loadConversationHistory(sessionKey, profile = null, { includeSessionMeta = true } = {}) {
  const normalized = String(sessionKey || '').trim()
  if (!normalized) {
    return {
      sessionKey: null,
      messages: [],
      meta: null,
    }
  }

  const res = await engineClient.sessions.loadHistory({
    sessionKey: normalized,
    profile,
    includeSessionMeta,
  })
  return {
    sessionKey: res.sessionKey || normalized,
    messages: Array.isArray(res.messages)
      ? res.messages.map(message => {
          const attachments = gatewayHistoryMediaToAttachments(
            message.mediaPaths,
            message.mediaTypes,
            convertFileSrc,
          )
          // Assistant video blocks are persisted by the engine as a local
          // delivery path plus a gateway-relative URL. The latter is not
          // directly playable in the WebView, while the local path is. Carry
          // it through the established MEDIA renderer so generated videos stay
          // playable after the terminal stream reloads history.
          const videoPaths = [
            ...historyVideoMediaTokens(message.mediaPaths, message.mediaTypes),
            ...(message.role === 'assistant' ? completedVideoPathsFromAssistantText(message.content) : []),
          ]
          const content = videoPaths.length > 0
            ? `${message.content || ''}${videoPaths.map(path => `\n\nMEDIA:${path}`).join('')}`.trim()
            : message.content
          return {
            id: message.id,
            role: message.role,
            content,
            createdAt: message.createdAt || Date.now(),
            ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
            ...(attachments.length ? { attachments } : {}),
          }
        })
      : [],
    meta: {
      providerType: res.providerType || 'openclaw',
      sessionId: res.sessionId || null,
      // Engine truth about this session's turn state (chat.history
      // sessionInfo.hasActiveRun / inFlightRun). `null` means the gateway did
      // not report it, which must not be read as "idle".
      // A full history page means older messages exist that the gateway did not
      // return — they must not be mistaken for deleted.
      truncated: Boolean(res.messagesTruncated),
      hasActiveRun: typeof res.hasActiveRun === 'boolean' ? res.hasActiveRun : null,
      inFlightRunId: res.inFlightRunId || null,
      inFlightText: typeof res.inFlightText === 'string' ? res.inFlightText : '',
      modelProvider: res.modelProvider || null,
      model: res.model || null,
      thinkingLevel: res.thinkingLevel || null,
      reasoningLevel: res.reasoningLevel || null,
      thinkingDefault: res.thinkingDefault || null,
      thinkingLevels: Array.isArray(res.thinkingLevels) ? res.thinkingLevels : [],
      dataFlow: res.dataFlow || 'openclaw.gateway.history',
      transport: res.transport || 'gateway_websocket',
      gatewayAligned: Boolean(res.gatewayAligned),
    },
  }
}

// Engine-derived touched files for one session (`sessions.files.list`): the
// gateway replays the transcript's write/edit/apply_patch calls, so `kind:
// "modified"` entries are the authoritative in-workspace write set. Returns []
// on any failure — the caller merges this with the local artifact index, which
// keeps working when the gateway is down.
export async function listConversationSessionFiles(sessionKey, profile = null) {
  const normalizedKey = String(sessionKey || '').trim()
  if (!normalizedKey) return []
  try {
    const res = await engineClient.sessions.files({
      req: { sessionKey: normalizedKey, profile },
    })
    const files = Array.isArray(res?.files) ? res.files : []
    return files
      .filter(file => file && typeof file.path === 'string' && !file.missing)
      .map(file => ({
        path: file.path,
        name: file.name || file.path.split('/').pop() || file.path,
        kind: file.kind === 'modified' ? 'modified' : 'read',
        size: Number.isFinite(file.size) ? file.size : 0,
        updatedAtMs: Number.isFinite(file.updatedAtMs) ? file.updatedAtMs : 0,
      }))
  } catch {
    return []
  }
}

export async function listConversationSessions({
  agentId,
  profile = null,
  search = '',
  offset = 0,
  limit = 40,
} = {}) {
  const normalizedAgentId = String(agentId || '').trim()
  if (!normalizedAgentId) {
    return {
      sessions: [],
      total: 0,
      offset: 0,
      nextOffset: null,
    }
  }
  const res = await engineClient.sessions.list({
    req: {
      agentId: normalizedAgentId,
      profile,
      search,
      offset,
      limit,
    },
  })
  return {
    sessions: Array.isArray(res.sessions)
      ? res.sessions.map(session => ({
          key: session.key,
          sessionKey: session.key,
          sessionId: session.sessionId || null,
          agentId: session.agentId || normalizedAgentId,
          kind: session.kind || 'interactive',
          title: session.title || session.key,
          summary: session.summary || '',
          updatedAt: session.updatedAt || null,
          createdAt: session.createdAt || null,
          modelProvider: session.modelProvider || null,
          model: session.model || null,
          permissionMode: session.permissionMode || null,
          thinkingDefault: session.thinkingDefault || null,
          thinkingLevels: Array.isArray(session.thinkingLevels) ? session.thinkingLevels : [],
          archived: Boolean(session.archived),
          pinned: Boolean(session.pinned),
          unread: Boolean(session.unread),
        }))
      : [],
    total: Number.isFinite(res.total) ? res.total : 0,
    offset: Number.isFinite(res.offset) ? res.offset : offset,
    nextOffset: Number.isFinite(res.nextOffset) ? res.nextOffset : null,
  }
}

export async function createConversationSession({ agentId, profile = null, title = '' } = {}) {
  const normalizedAgentId = String(agentId || '').trim()
  if (!normalizedAgentId) throw new Error('缺少 Uniopc 引擎 agent id，无法创建新聊天。')
  const res = await engineClient.sessions.create({
    req: {
      agentId: normalizedAgentId,
      profile,
    },
  })
  return {
    sessionKey: res.sessionKey || '',
    sessionId: res.sessionId || null,
    title: res.title || title || '新聊天',
  }
}

export async function renameConversationSession({ sessionKey, profile = null, label = '' } = {}) {
  const normalizedSessionKey = String(sessionKey || '').trim()
  const normalizedLabel = String(label || '').trim()
  if (!normalizedSessionKey) throw new Error('缺少 Gateway session key，无法重命名聊天。')
  if (!normalizedLabel) throw new Error('聊天名称不能为空。')
  const res = await engineClient.sessions.rename({
    req: {
      sessionKey: normalizedSessionKey,
      profile,
      label: normalizedLabel,
    },
  })
  return {
    sessionKey: res.sessionKey || normalizedSessionKey,
    label: res.label || normalizedLabel,
    title: res.title || res.label || normalizedLabel,
  }
}

export async function setConversationSessionPermission({ sessionKey, profile = null, permissionMode = 'default' } = {}) {
  const normalizedSessionKey = String(sessionKey || '').trim()
  const normalizedMode = String(permissionMode || 'default').trim() || 'default'
  if (!normalizedSessionKey) throw new Error('缺少 Gateway session key，无法设置权限。')
  await engineClient.sessions.setPermission({
    req: {
      sessionKey: normalizedSessionKey,
      profile,
      permissionMode: normalizedMode,
    },
  })
  return { sessionKey: normalizedSessionKey, permissionMode: normalizedMode, gatewayAligned: true }
}

export async function patchConversationSessionState({ sessionKey, sessionId = null, profile = null, action } = {}) {
  const normalizedSessionKey = String(sessionKey || '').trim()
  const normalizedAction = String(action || '').trim()
  if (!normalizedSessionKey) throw new Error('缺少 Gateway session key，无法更新会话。')
  if (!normalizedAction) throw new Error('缺少会话操作。')
  await engineClient.sessions.patchState({
    req: {
      sessionKey: normalizedSessionKey,
      sessionId: sessionId || null,
      profile,
      action: normalizedAction,
    },
  })
  return { sessionKey: normalizedSessionKey, action: normalizedAction, gatewayAligned: true }
}

export async function setConversationSessionReasoning({ sessionKey, profile = null, reasoningLevel = 'off' } = {}) {
  const normalizedSessionKey = String(sessionKey || '').trim()
  const normalizedReasoningLevel = String(reasoningLevel || 'off').trim() || 'off'
  if (!normalizedSessionKey) throw new Error('缺少 Gateway session key，无法切换 reasoning。')
  const res = await engineClient.sessions.setReasoning({
    req: {
      sessionKey: normalizedSessionKey,
      profile,
      reasoningLevel: normalizedReasoningLevel,
    },
  })
  return {
    sessionKey: res.sessionKey || normalizedSessionKey,
    reasoningLevel: res.reasoningLevel || normalizedReasoningLevel,
    gatewayAligned: Boolean(res.gatewayAligned),
  }
}

export async function setConversationSessionModel({ sessionKey, profile = null, model = null } = {}) {
  const normalizedSessionKey = String(sessionKey || '').trim()
  const normalizedModel = String(model || '').trim()
  if (!normalizedSessionKey) throw new Error('缺少 Gateway session key，无法切换模型。')
  const res = await engineClient.sessions.setModel({
    req: {
      sessionKey: normalizedSessionKey,
      profile,
      model: normalizedModel || null,
    },
  })
  return {
    sessionKey: res.sessionKey || normalizedSessionKey,
    model: res.model || normalizedModel || null,
    gatewayAligned: Boolean(res.gatewayAligned),
  }
}

export async function setConversationSessionThinking({ sessionKey, profile = null, thinkingLevel = null } = {}) {
  const normalizedSessionKey = String(sessionKey || '').trim()
  const normalizedThinkingLevel = String(thinkingLevel || '').trim()
  if (!normalizedSessionKey) throw new Error('缺少 Gateway session key，无法切换 thinking。')
  const res = await engineClient.sessions.setThinking({
    req: {
      sessionKey: normalizedSessionKey,
      profile,
      thinkingLevel: normalizedThinkingLevel || null,
    },
  })
  return {
    sessionKey: res.sessionKey || normalizedSessionKey,
    thinkingLevel: res.thinkingLevel || normalizedThinkingLevel || null,
    gatewayAligned: Boolean(res.gatewayAligned),
  }
}
