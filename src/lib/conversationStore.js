// Legacy layout: one key holding every conversation *including* every message.
// Still read so an existing install keeps its history, and deleted once the
// split layout below has been written successfully.
const STORAGE_PREFIX = 'imai.conversations.v1'
// Split layout: a small index of conversation records without messages, plus
// one key per conversation for its messages. The old single blob was rewritten
// in full on every streaming update and silently blew past the ~5MB localStorage
// quota, after which nothing was persisted and nothing said so.
const INDEX_PREFIX = 'imai.conversation-index.v1'
const MESSAGES_PREFIX = 'imai.conversation-messages.v1'
// Only the most recently used conversations keep their transcript on disk; the
// rest reload from the gateway on open. Bounds total footprint without hiding
// any conversation from the list.
const HYDRATED_CONVERSATION_LIMIT = 30
const PERSISTED_MESSAGE_LIMIT = 200
const PENDING_MESSAGE_TIMEOUT_MS = 2 * 60 * 1000
const MESSAGE_MATCH_WINDOW_MS = 10 * 1000
const LEGACY_ASSISTANT_NOISE = new Set([
  'Uniopc 引擎 finished with no text.',
  '本轮对话已停止。',
])
const OPENCLAW_BOOTSTRAP_PENDING_MARKER = '[Bootstrap pending]'
const OPENCLAW_HEARTBEAT_POLL_MARKER = '[Uniopc 引擎 heartbeat poll]'
const OPENCLAW_STREAM_FAILURE_MARKER = '[assistant turn failed before producing content]'

// Stream recovery can leave more than one fallback prefix before an otherwise
// valid answer. Remove every leading copy when restoring cached messages so an
// old transport failure cannot survive in the UI or be re-merged into history.
function stripLeadingStreamFailureMarkers(content) {
  let remaining = String(content || '').trimStart()
  while (remaining.startsWith(OPENCLAW_STREAM_FAILURE_MARKER)) {
    remaining = remaining.slice(OPENCLAW_STREAM_FAILURE_MARKER.length).trimStart()
  }
  return remaining
}

function ownerScope(ownerId) {
  return ownerId || 'guest'
}

function getStorageKey(ownerId) {
  return `${STORAGE_PREFIX}:${ownerScope(ownerId)}`
}

function getIndexKey(ownerId) {
  return `${INDEX_PREFIX}:${ownerScope(ownerId)}`
}

function getMessagesKey(ownerId, conversationId) {
  return `${MESSAGES_PREFIX}:${ownerScope(ownerId)}:${conversationId}`
}

function storage() {
  if (typeof window === 'undefined' || !window.localStorage) return null
  return window.localStorage
}

function readJson(key) {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function removeKey(key) {
  const store = storage()
  if (!store || typeof store.removeItem !== 'function') return
  try {
    store.removeItem(key)
  } catch {
    // A store that refuses deletes is still usable for reads/writes.
  }
}

const storageErrorHandlers = new Set()

/// Reports that history could not be persisted. The old code swallowed this,
/// so a full quota looked exactly like a working app until a reload lost data.
export function subscribeConversationStorageError(handler) {
  if (typeof handler !== 'function') return () => {}
  storageErrorHandlers.add(handler)
  return () => storageErrorHandlers.delete(handler)
}

function reportStorageError(error) {
  const message = String(error?.message || error || 'unknown storage error')
  for (const handler of storageErrorHandlers) {
    try {
      handler(message)
    } catch {
      // A broken listener must not break persistence.
    }
  }
}

/// Skips the write when the stored value already matches, so a streaming update
/// touches only the active conversation's transcript instead of rewriting every
/// conversation on every frame. Compared against the store rather than an
/// in-memory cache: a cache goes stale the moment anything else clears storage.
function writeKey(key, payload) {
  const store = storage()
  if (!store) return false
  let existing = null
  try {
    existing = store.getItem(key)
  } catch {
    existing = null
  }
  if (existing === payload) return true
  store.setItem(key, payload)
  return true
}

function stripMessages(conversation) {
  const { messages: _messages, ...rest } = conversation || {}
  return rest
}

/// Newest transcripts first; anything past the limit keeps its index entry but
/// drops its stored messages.
function splitByRecency(items) {
  const ordered = [...items].sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0))
  return {
    hydrated: ordered.slice(0, HYDRATED_CONVERSATION_LIMIT),
    evicted: ordered.slice(HYDRATED_CONVERSATION_LIMIT),
  }
}

export function listStoredConversations(ownerId) {
  const store = storage()
  if (!store) return []

  const index = readJson(getIndexKey(ownerId))
  const records = Array.isArray(index) ? index : readJson(getStorageKey(ownerId))
  if (!Array.isArray(records)) return []

  return records
    .map(record => {
      if (!record || typeof record !== 'object') return record
      // Legacy records carry their messages inline; split records look them up.
      if (Array.isArray(record.messages)) return record
      const messages = readJson(getMessagesKey(ownerId, record.id))
      return { ...record, messages: Array.isArray(messages) ? messages : [] }
    })
    .map(normalizeConversationRecord)
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export function saveStoredConversations(ownerId, items) {
  const store = storage()
  if (!store) return
  const records = Array.isArray(items) ? items.filter(item => item && item.id) : []
  const { hydrated, evicted } = splitByRecency(records)

  try {
    for (const conversation of hydrated) {
      const messages = Array.isArray(conversation.messages) ? conversation.messages : []
      writeKey(
        getMessagesKey(ownerId, conversation.id),
        JSON.stringify(messages.slice(-PERSISTED_MESSAGE_LIMIT)),
      )
    }
    for (const conversation of evicted) {
      const key = getMessagesKey(ownerId, conversation.id)
      removeKey(key)
    }
    writeKey(getIndexKey(ownerId), JSON.stringify(records.map(stripMessages)))
    // The split layout is now authoritative; the old blob is pure dead weight
    // against the quota.
    removeKey(getStorageKey(ownerId))

    // Let the global 产物 hub (GlobalArtifactsControl) re-read fresh artifacts
    // without coupling it to the Conversations page's React state.
    window.dispatchEvent(new CustomEvent('imai:conversations-updated'))
  } catch (error) {
    // Typically QuotaExceededError. Drop the oldest transcripts and retry once
    // with the index alone, so at least the conversation list survives.
    for (const conversation of records.slice(HYDRATED_CONVERSATION_LIMIT / 2)) {
      const key = getMessagesKey(ownerId, conversation.id)
      removeKey(key)
    }
    try {
      writeKey(getIndexKey(ownerId), JSON.stringify(records.map(stripMessages)))
      window.dispatchEvent(new CustomEvent('imai:conversations-updated'))
      reportStorageError('本地聊天记录空间不足，已清理较早的会话缓存。')
    } catch (retryError) {
      reportStorageError(retryError)
    }
  }
}

export function createConversationRecord(options = {}) {
  const now = Date.now()
  const id = crypto.randomUUID()
  const normalized = typeof options === 'string' ? { title: options } : (options || {})
  return normalizeConversationRecord({
    id: normalized.id || id,
    sessionId: normalized.sessionId || normalized.id || id,
    gatewaySessionKey: normalized.gatewaySessionKey ?? null,
    gatewaySessionId: null,
    employeeId: normalized.employeeId || null,
    employeeName: normalized.employeeName || null,
    employeeRole: normalized.employeeRole || null,
    title: normalized.title || '新的对话',
    summary: normalized.summary || '',
    messages: Array.isArray(normalized.messages) ? normalized.messages : [],
    createdAt: now,
    updatedAt: now,
    meta: normalized.meta ?? null,
  })
}

export function deriveConversationTitle(messages) {
  const visibleMessages = messages.filter(message => message.status !== 'failed')
  const firstUser = visibleMessages.find(message => message.role === 'user' && message.content?.trim())
  if (!firstUser) return '新的对话'
  const compact = firstUser.content.trim().replace(/\s+/g, ' ')
  return compact.length > 18 ? `${compact.slice(0, 18)}...` : compact
}

export function deriveConversationSummary(messages) {
  const visibleMessages = messages.filter(message => message.status !== 'failed')
  const lastAssistant = [...visibleMessages].reverse().find(message => message.role === 'assistant' && message.content?.trim())
  const source = lastAssistant || [...visibleMessages].reverse().find(message => message.role === 'user' && message.content?.trim())
  if (!source) return ''
  const compact = source.content.trim().replace(/\s+/g, ' ')
  return compact.length > 42 ? `${compact.slice(0, 42)}...` : compact
}

export function isPendingMessageStale(message, now = Date.now()) {
  if (!['sending', 'streaming'].includes(message?.status)) return false
  const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : now
  return now - createdAt > PENDING_MESSAGE_TIMEOUT_MS
}

// The gateway does not store the key we sent verbatim — it derives a per-row key
// by appending the role, so a turn sent as `<uuid>` comes back on the user row as
// `<uuid>:user`. Comparing raw keys made every optimistic bubble mismatch its own
// server record and show the message twice.
const IDEMPOTENCY_ROLE_SUFFIX = /:(user|assistant|system|tool)$/

function normalizedIdempotencyKey(message) {
  const key = String(message?.idempotencyKey || '').trim()
  if (!key) return null
  return key.replace(IDEMPOTENCY_ROLE_SUFFIX, '') || null
}

/// Exact identity when both sides carry the key the gateway persisted with the
/// canonical user row. Two different keys are *definitively* different messages,
/// which is what lets the same text sent twice stay two bubbles.
function idempotencyVerdict(left, right) {
  const leftKey = normalizedIdempotencyKey(left)
  const rightKey = normalizedIdempotencyKey(right)
  if (!leftKey || !rightKey) return null
  return leftKey === rightKey
}

function messagesLikelyMatch(left, right) {
  if (!left || !right) return false
  if (left.role !== right.role) return false
  const byKey = idempotencyVerdict(left, right)
  if (byKey !== null) return byKey
  // Fallback for rows that predate the key, and for assistant turns (the engine
  // only persists the key on the user row). Same text inside a short window is
  // a guess, not an identity — hence the key path above.
  if (String(left.content || '').trim() !== String(right.content || '').trim()) return false
  const leftCreatedAt = Number.isFinite(left.createdAt) ? left.createdAt : 0
  const rightCreatedAt = Number.isFinite(right.createdAt) ? right.createdAt : 0
  return Math.abs(leftCreatedAt - rightCreatedAt) <= MESSAGE_MATCH_WINDOW_MS
}

export function dedupeConversationMessages(messages = []) {
  const rows = Array.isArray(messages) ? messages : []
  const deduped = []
  for (const message of rows) {
    if (isLegacyNoiseMessage(message)) continue
    if (
      message?.role === 'assistant'
        && String(message.content || '').trim()
        && deduped.some(candidate => candidate.role === 'assistant' && messagesLikelyMatch(candidate, message))
    ) {
      continue
    }
    deduped.push(message)
  }
  return deduped
}

/// Reconciles the canonical user row that OpenClaw broadcasts immediately
/// after persistence through `sessions.messages.subscribe`. This must not wait
/// for an assistant reply: the idempotency key is already the exact identity
/// link to the optimistic bubble.
export function reconcileConversationSessionMessage(currentMessages = [], sessionMessage = {}) {
  const current = Array.isArray(currentMessages)
    ? currentMessages.filter(message => !isLegacyNoiseMessage(message))
    : []
  const role = typeof sessionMessage.role === 'string' ? sessionMessage.role.trim() : ''
  if (role !== 'user') return current

  const content = typeof sessionMessage.content === 'string' ? sessionMessage.content : ''
  const canonical = {
    id: typeof sessionMessage.id === 'string' && sessionMessage.id
      ? sessionMessage.id
      : `gateway-session-user-${sessionMessage.createdAt || Date.now()}`,
    role,
    content,
    createdAt: Number.isFinite(sessionMessage.createdAt) ? sessionMessage.createdAt : Date.now(),
    status: 'sent',
    ...(typeof sessionMessage.idempotencyKey === 'string' && sessionMessage.idempotencyKey
      ? { idempotencyKey: sessionMessage.idempotencyKey }
      : {}),
  }
  const pending = current.find(message =>
    message?.role === 'user'
      && ['sending', 'failed', 'sent'].includes(message.status)
      && messagesLikelyMatch(message, canonical),
  )
  const merged = pending
    ? current.map(message => {
      if (message !== pending) return message
      return {
        ...canonical,
        // A `session.message` can acknowledge persistence before the gateway
        // includes displayable text. Keep the optimistic text in that case;
        // otherwise the user bubble flashes empty until history reloads.
        ...(String(canonical.content || '').trim() || !String(pending.content || '').trim()
          ? {}
          : { content: pending.content }),
        // Retain the local React key so confirming a sent message cannot cause
        // a remove/reinsert flash in the transcript.
        id: pending.id,
        ...(canonical.attachments?.length || !pending.attachments?.length
          ? {}
          : { attachments: pending.attachments }),
      }
    })
    : [...current, canonical]

  return dedupeConversationMessages(merged).sort((left, right) =>
    (left.createdAt || 0) - (right.createdAt || 0)
      || String(left.id || '').localeCompare(String(right.id || '')),
  )
}

/// Keeps a locally accepted user turn in a rendering-only layer. Once history
/// has its canonical row, the merge folds both representations into one bubble.
export function mergeConversationOptimisticMessages(historyMessages = [], optimisticMessages = []) {
  const history = Array.isArray(historyMessages)
    ? historyMessages.filter(message => !isLegacyNoiseMessage(message))
    : []
  const optimistic = Array.isArray(optimisticMessages)
    ? optimisticMessages.filter(message => message?.role === 'user' && !isLegacyNoiseMessage(message))
    : []
  const matched = new Set()
  const merged = history.map(message => {
    if (message?.role !== 'user') return message
    const pendingIndex = optimistic.findIndex(candidate => messagesLikelyMatch(candidate, message))
    if (pendingIndex < 0) return message
    matched.add(pendingIndex)
    const pending = optimistic[pendingIndex]
    return {
      ...message,
      id: pending.id,
      status: 'sent',
      ...(String(message.content || '').trim() || !String(pending.content || '').trim()
        ? {}
        : { content: pending.content }),
      ...(message.attachments?.length || !pending.attachments?.length
        ? {}
        : { attachments: pending.attachments }),
      ...(normalizedIdempotencyKey(message) || !normalizedIdempotencyKey(pending)
        ? {}
        : { idempotencyKey: pending.idempotencyKey }),
    }
  })
  for (const [index, message] of optimistic.entries()) {
    if (!matched.has(index)) merged.push(message)
  }
  return dedupeConversationMessages(merged).sort((left, right) =>
    (left.createdAt || 0) - (right.createdAt || 0)
      || String(left.id || '').localeCompare(String(right.id || '')),
  )
}

export function mergeConversationHistoryMessages(
  currentMessages = [],
  historyMessages = [],
  now = Date.now(),
  { historyTruncated = false } = {},
) {
  const sanitizeAssistantStreamFailure = message => (
    message?.role === 'assistant'
      ? { ...message, content: stripLeadingStreamFailureMarkers(message.content) }
      : message
  )
  const current = Array.isArray(currentMessages)
    ? currentMessages.map(sanitizeAssistantStreamFailure).filter(message => !isLegacyNoiseMessage(message))
    : []
  const history = Array.isArray(historyMessages)
    ? historyMessages.map(sanitizeAssistantStreamFailure).filter(message => !isLegacyNoiseMessage(message))
    : []
  // An image with no caption is a real user turn with empty content, so the
  // text check alone would drop it here and it would vanish until history
  // catches up.
  const localOptimisticUsers = current.filter(message =>
    message?.role === 'user'
      && ['sending', 'failed', 'sent'].includes(message.status)
      && (String(message.content || '').trim() || message.attachments?.length),
  )

  // The history version replaces the optimistic one wholesale, so anything the
  // optimistic message alone knows has to be carried across explicitly.
  // Attachments are the case that bit us: history carries engine media paths,
  // the optimistic message carries a local data URL, and whichever side is
  // missing must inherit from the other instead of blanking the bubble.
  const withPending = (message, pending, status) => ({
    ...message,
    id: pending.id,
    // Keep the key even when only the local side had it: the next merge then
    // still has an exact link, instead of degrading to the content guess.
    ...(normalizedIdempotencyKey(message) || !normalizedIdempotencyKey(pending)
      ? {}
      : { idempotencyKey: pending.idempotencyKey }),
    ...(message.attachments?.length || !pending.attachments?.length
      ? {}
      : { attachments: pending.attachments }),
    status,
  })

  const merged = history.map(message => {
    if (message.role !== 'user') return message
    const pending = localOptimisticUsers.find(candidate => messagesLikelyMatch(candidate, message))
    if (!pending) return message

    const hasAssistantAfter = history.some(candidate =>
      candidate.role === 'assistant'
        && Number.isFinite(candidate.createdAt)
        && candidate.createdAt >= message.createdAt,
    )
    if (hasAssistantAfter) return withPending(message, pending, 'sent')
    if (pending.status === 'sending' && !isPendingMessageStale(pending, now)) {
      return withPending(message, pending, 'sending')
    }
    return withPending(message, pending, 'failed')
  })

  for (const pending of localOptimisticUsers) {
    if (!merged.some(message => messagesLikelyMatch(message, pending))) {
      merged.push({
        ...pending,
        status: isPendingMessageStale(pending, now) ? 'failed' : pending.status,
      })
    }
  }

  // `chat.history` returns a fixed-size window with no offset. When it came back
  // full, everything the client already had from *before* that window is still
  // real history the gateway simply did not send — dropping it is how a long
  // conversation used to lose its beginning on every refresh. When the page was
  // NOT full the engine gave us everything it has, so a missing message really
  // is gone (reset/compact) and must not be resurrected.
  if (historyTruncated && history.length > 0) {
    const oldestHistoryAt = history.reduce(
      (oldest, message) => (Number.isFinite(message.createdAt) ? Math.min(oldest, message.createdAt) : oldest),
      Number.POSITIVE_INFINITY,
    )
    if (Number.isFinite(oldestHistoryAt)) {
      const beforeWindow = current.filter(message =>
        Number.isFinite(message.createdAt)
          && message.createdAt < oldestHistoryAt
          && !localOptimisticUsers.includes(message),
      )
      merged.unshift(...beforeWindow)
    }
  }

  return dedupeConversationMessages(merged).sort((left, right) =>
    (left.createdAt || 0) - (right.createdAt || 0)
      || String(left.id || '').localeCompare(String(right.id || '')),
  )
}

function normalizeMessageRecord(item, index) {
  if (!item || typeof item !== 'object') return null
  const role = typeof item.role === 'string' && item.role.trim() ? item.role : 'assistant'
  const rawContent = typeof item.content === 'string' ? item.content : ''
  const content = role === 'assistant'
    ? stripLeadingStreamFailureMarkers(rawContent)
    : rawContent
  const rawStatus = ['sending', 'streaming', 'sent', 'failed'].includes(item.status) ? item.status : undefined
  const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
  const status = ['sending', 'streaming'].includes(rawStatus) && isPendingMessageStale({ ...item, createdAt })
    ? 'failed'
    : rawStatus
  if (isLegacyNoiseMessage({ role, content, status })) return null
  const attachments = normalizePersistedAttachments(item.attachments)
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `legacy-message-${index}`,
    ...(typeof item.runId === 'string' && item.runId ? { runId: item.runId } : {}),
    // Must survive a reload, or a message sent just before the reload loses its
    // identity link and falls back to the content+time guess.
    ...(typeof item.idempotencyKey === 'string' && item.idempotencyKey
      ? { idempotencyKey: item.idempotencyKey }
      : {}),
    role,
    content,
    createdAt,
    ...(attachments.length ? { attachments } : {}),
    ...(status ? { status } : {}),
  }
}

// Only engine-backed attachments survive a reload. They carry a `path` into
// state/<profile>/media/inbound/ plus the short asset URL derived from it — a
// few dozen bytes each. An optimistic attachment is a base64 data URL of up to
// 10MB, and localStorage caps out around 5MB: persisting even one would throw
// inside saveStoredConversations, whose catch is silent, and take the entire
// conversation list down with it. Those are dropped here; the engine's copy
// comes back on the next history load anyway.
function normalizePersistedAttachments(attachments) {
  if (!Array.isArray(attachments)) return []
  return attachments
    .map(attachment => {
      const path = String(attachment?.path || '').trim()
      const dataUrl = String(attachment?.dataUrl || '').trim()
      if (!path || dataUrl.startsWith('data:')) return null
      return {
        id: String(attachment.id || `media-${path}`),
        name: String(attachment.name || ''),
        mimeType: String(attachment.mimeType || ''),
        path,
        dataUrl,
      }
    })
    .filter(Boolean)
}

function isLegacyNoiseMessage(message) {
  const content = String(message.content || '').trim()
  if (
    content.startsWith(OPENCLAW_BOOTSTRAP_PENDING_MARKER)
      || (content.includes('Please read BOOTSTRAP.md') && content.includes('Do not use a generic first greeting'))
  ) {
    return true
  }
  if (message.role === 'user' && content === OPENCLAW_HEARTBEAT_POLL_MARKER) return true
  if (message.role === 'assistant' && LEGACY_ASSISTANT_NOISE.has(content)) return true
  if (
    message.role === 'assistant'
      && message.status === 'failed'
      && content.includes('Uniopc 引擎 运行仍未结束')
  ) {
    return true
  }
  if (message.role === 'assistant' && message.status === 'failed' && !content) return true
  if (message.role === 'user' && message.status === 'failed') return true
  return false
}

function normalizeConversationRecord(item) {
  if (!item || typeof item !== 'object') return null
  const now = Date.now()
  const id = typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID()
  const messages = Array.isArray(item.messages)
    ? item.messages.map(normalizeMessageRecord).filter(Boolean)
    : []

  return {
    id,
    sessionId: typeof item.sessionId === 'string' && item.sessionId ? item.sessionId : id,
    gatewaySessionKey: typeof item.gatewaySessionKey === 'string' && item.gatewaySessionKey ? item.gatewaySessionKey : null,
    gatewaySessionId: typeof item.gatewaySessionId === 'string' && item.gatewaySessionId ? item.gatewaySessionId : null,
    employeeId: typeof item.employeeId === 'string' && item.employeeId ? item.employeeId : null,
    employeeName: typeof item.employeeName === 'string' && item.employeeName ? item.employeeName : null,
    employeeRole: typeof item.employeeRole === 'string' && item.employeeRole ? item.employeeRole : null,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : deriveConversationTitle(messages),
    summary: typeof item.summary === 'string' ? item.summary : deriveConversationSummary(messages),
    messages: dedupeConversationMessages(messages),
    createdAt: Number.isFinite(item.createdAt) ? item.createdAt : now,
    updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : now,
    meta: item.meta ?? null,
  }
}
