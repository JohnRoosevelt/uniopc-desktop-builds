// Durable local send queue. Messages typed while the engine starts or a turn is running, and messages
// whose send failed, used to live only in React state: switching conversation or
// reloading dropped them with no trace (a failed user bubble is also filtered
// out of the transcript on reload). Both cases are user input, so both are
// persisted here and survive a restart.
const OUTBOX_PREFIX = 'imai.conversation-outbox.v1'
// A base64 image can be 10MB; localStorage holds ~5MB in total. Entries above
// this keep their text but not their images, and say so rather than silently
// resurrecting a message with its attachments missing.
const PERSISTED_ATTACHMENT_BYTES_LIMIT = 1_500_000
const MAX_ENTRIES_PER_CONVERSATION = 10

export const OUTBOX_STATUS = {
  queued: 'queued',
  sending: 'sending',
  // `chat.send` has either been handed to the Gateway or its acknowledgement
  // was lost. Keep the original idempotency key and wait for canonical history;
  // an ACK alone is not proof that the user row was persisted.
  confirming: 'confirming',
  failed: 'failed',
}

function storage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage || null
  } catch {
    return null
  }
}

function getOutboxKey(ownerId) {
  return `${OUTBOX_PREFIX}:${ownerId || 'guest'}`
}

// `sending` is repaired to `queued` exactly once per owner, on the first read of
// a session. Doing it on every read would undo the flag the drain loop just set
// and let two sends start for one entry.
const revivedOwners = new Set()
// Keep full attachments for this process, plus accepted input when storage is
// full. The disk representation alone applies the attachment size budget.
const sessionEntries = new Map()

function readAll(ownerId) {
  if (sessionEntries.has(ownerId)) return sessionEntries.get(ownerId)
  const store = storage()
  if (!store) return []
  let parsed = null
  try {
    const raw = store.getItem(getOutboxKey(ownerId))
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const entries = parsed.filter(entry => entry && entry.id)
  if (revivedOwners.has(ownerId)) return entries
  revivedOwners.add(ownerId)
  // A crash mid-send is not proof that the Gateway rejected the command. It may
  // already own the idempotency key, so restore it as `confirming` rather than
  // blindly replaying it on the next launch.
  const revived = entries.map(entry =>
    entry.status === OUTBOX_STATUS.sending ? { ...entry, status: OUTBOX_STATUS.confirming } : entry,
  )
  if (entries.some(entry => entry.status === OUTBOX_STATUS.sending)) {
    sessionEntries.set(ownerId, revived)
    persistEntries(ownerId, revived)
  }
  return revived
}

// Test seam: a fresh process starts with no revived owners.
export function __resetOutboxRevivalForTests() {
  revivedOwners.clear()
  sessionEntries.clear()
}

function attachmentBytes(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return 0
  try {
    return JSON.stringify(attachments).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function normalizeEntry(entry) {
  const attachments = Array.isArray(entry.attachments) ? entry.attachments : []
  const rawApprovalMode = String(entry.approvalMode || 'default')
  const approvalMode = rawApprovalMode === 'direct'
    ? 'full'
    : ['default', 'read-only', 'guarded', 'workspace', 'full'].includes(rawApprovalMode)
      ? rawApprovalMode
      : 'default'
  return {
    id: entry.id,
    conversationId: entry.conversationId,
    sessionKey: entry.sessionKey || null,
    employeeId: entry.employeeId || null,
    profile: entry.profile || null,
    idempotencyKey: entry.idempotencyKey || String(entry.id).replace(/^outbox-/, ''),
    approvalMode,
    text: String(entry.text || ''),
    attachments,
    // Sticky: once dropped, the entry stays flagged across every later read.
    attachmentsDropped: Boolean(entry.attachmentsDropped),
    status: Object.values(OUTBOX_STATUS).includes(entry.status)
      ? entry.status
      : OUTBOX_STATUS.queued,
    lastError: entry.lastError || '',
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
  }
}

function toPersisted(entry) {
  const normalized = normalizeEntry(entry)
  if (attachmentBytes(normalized.attachments) <= PERSISTED_ATTACHMENT_BYTES_LIMIT) return normalized
  return { ...normalized, attachments: [], attachmentsDropped: true }
}

function persistEntries(ownerId, entries) {
  const store = storage()
  if (!store) return false
  const payload = JSON.stringify(entries.map(toPersisted))
  try {
    store.setItem(getOutboxKey(ownerId), payload)
    return true
  } catch {
    // The combined image budget can exceed localStorage even when each image
    // fits. Persist every text first; keep full images in memory for this run.
    try {
      store.setItem(getOutboxKey(ownerId), JSON.stringify(entries.map(entry => ({
        ...toPersisted(entry), attachments: [],
        attachmentsDropped: Boolean(entry.attachmentsDropped || entry.attachments?.length),
      }))))
      return true
    } catch {
      return false
    }
  }
}

function write(ownerId, entries) {
  if (!persistEntries(ownerId, entries)) throw new Error('无法保存消息状态，请检查本地存储空间后重试。')
  sessionEntries.set(ownerId, entries)
  return entries
}

export function listConversationOutbox(ownerId) {
  return readAll(ownerId)
    .map(normalizeEntry)
    .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
}

export function outboxEntriesFor(entries, conversationId, profile = undefined) {
  if (!conversationId) return []
  return (Array.isArray(entries) ? entries : []).filter(entry => entry.conversationId === conversationId
    && (profile === undefined || entry.profile === profile))
}

/// Returns `{ entries, entry }`, or `{ entries, entry: null }` when the
/// conversation is already at its cap.
export function enqueueConversationOutbox(ownerId, entry) {
  const current = listConversationOutbox(ownerId)
  if (outboxEntriesFor(current, entry.conversationId, entry.profile).length >= MAX_ENTRIES_PER_CONVERSATION) {
    return { entries: current, entry: null }
  }
  const created = normalizeEntry({
    ...entry,
    id: entry.id || `outbox-${crypto.randomUUID()}`,
    createdAt: entry.createdAt || Date.now(),
    status: entry.status || OUTBOX_STATUS.queued,
  })
  const entries = [...current, created]
  if (!persistEntries(ownerId, entries)) {
    return { entries: current, entry: null, error: '无法保存待发送消息，请释放本地存储空间后重试；输入内容已保留。' }
  }
  sessionEntries.set(ownerId, entries)
  return { entries, entry: created }
}

export function updateConversationOutbox(ownerId, id, patch) {
  const entries = listConversationOutbox(ownerId).map(entry =>
    entry.id === id ? normalizeEntry({ ...entry, ...patch }) : entry,
  )
  return write(ownerId, entries)
}

export function removeConversationOutbox(ownerId, id) {
  const entries = listConversationOutbox(ownerId).filter(entry => entry.id !== id)
  return write(ownerId, entries)
}

// Gateway user rows use `<idempotencyKey>:user`. Keep this normalization local
// to the durable queue so both a stream event and a history reload can retire
// exactly the message the Gateway committed, without comparing text or time.
function normalizedIdempotencyKey(value) {
  return String(value || '').trim().replace(/:(user|assistant|system|tool)$/, '')
}

export function confirmConversationOutbox(ownerId, { profile, sessionKey, messages } = {}) {
  const confirmedKeys = new Set(
    (Array.isArray(messages) ? messages : [])
      .filter(message => message?.role === 'user')
      .map(message => normalizedIdempotencyKey(message?.idempotencyKey))
      .filter(Boolean),
  )
  if (!confirmedKeys.size) return listConversationOutbox(ownerId)

  const current = listConversationOutbox(ownerId)
  const entries = current.filter(entry => {
    const matchesTarget = entry.profile === profile && entry.sessionKey === sessionKey
    return !matchesTarget || !confirmedKeys.has(normalizedIdempotencyKey(entry.idempotencyKey))
  })
  if (entries.length === current.length) return current
  return write(ownerId, entries)
}

export function clearConversationOutbox(ownerId, conversationId) {
  const entries = listConversationOutbox(ownerId).filter(entry => entry.conversationId !== conversationId)
  return write(ownerId, entries)
}

/// The next entry to send for a conversation: strictly oldest-first, and only
/// when nothing is already in flight or awaiting canonical confirmation. Failed
/// entries wait for an explicit retry; confirmation prevents a later message
/// overtaking a request whose delivery result is still unknown.
export function nextQueuedOutboxEntry(entries, conversationId, profile = undefined) {
  const scoped = outboxEntriesFor(entries, conversationId, profile)
  if (scoped.some(entry => [OUTBOX_STATUS.sending, OUTBOX_STATUS.confirming].includes(entry.status))) return null
  return scoped.find(entry => entry.status === OUTBOX_STATUS.queued) || null
}

// Claim synchronously from the current stored queue, never a stale React render.
// Readiness allows execution, not input. The full route prevents a cached roster,
// navigation or account change from redirecting an already accepted message.
export function claimQueuedConversationOutbox(ownerId, {
  conversationId, profile, employeeId, sessionKey, ready, routeReady,
} = {}) {
  if (!ownerId || !profile || !employeeId || !sessionKey || !ready || !routeReady) return null
  const entries = listConversationOutbox(ownerId)
  const head = nextQueuedOutboxEntry(entries, conversationId, profile)
  if (!head || head.profile !== profile || head.employeeId !== employeeId || head.sessionKey !== sessionKey) return null
  if (head.attachmentsDropped) return null
  const claimed = { ...head, status: OUTBOX_STATUS.sending }
  write(ownerId, entries.map(entry => entry.id === head.id ? claimed : entry))
  return claimed
}

export { MAX_ENTRIES_PER_CONVERSATION, PERSISTED_ATTACHMENT_BYTES_LIMIT }

export function shouldQueueConversationSubmission({
  hasEmployee, fromQueue, turnInFlight, conversationModelReady,
} = {}) {
  return Boolean(hasEmployee && !fromQueue && (turnInFlight || !conversationModelReady))
}

// Explain the current blocker per entry: failed messages require user action.
export function conversationOutboxStatusLabel(entry, { gatewayReady, conversationModelReady, turnInFlight } = {}) {
  if (entry.status === OUTBOX_STATUS.failed) return '发送失败 · 请重试或编辑'
  if (entry.status === OUTBOX_STATUS.confirming) return '正在确认是否已发送 · 请等待或手动重试'
  if (entry.status === OUTBOX_STATUS.sending) return '正在发送'
  if (!gatewayReady) return '已保存 · 本地助手准备完成后发送'
  if (!conversationModelReady) return '已保存 · 等待对话配置就绪'
  if (turnInFlight) return '已保存 · 等待当前回复结束'
  return '已保存 · 按顺序发送'
}
