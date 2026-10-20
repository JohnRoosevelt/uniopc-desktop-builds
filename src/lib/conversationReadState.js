// Per-owner "last read" markers for the conversation roster.
//
// The roster (see conversationRoster.js) knows each target's latest message
// timestamp; comparing that against a stored read marker is what turns "there
// are messages" into "there are *unread* messages". Markers live in
// localStorage next to the cached conversations so unread badges survive a
// reload, and are namespaced per signed-in owner just like the conversations.

const STORAGE_PREFIX = 'imai.conversations.read.v1'

function getStorageKey(ownerId) {
  return `${STORAGE_PREFIX}:${ownerId || 'guest'}`
}

export function conversationTargetKey(type, id) {
  return `${type}:${String(id || '').trim()}`
}

export function readConversationReadMarks(ownerId) {
  if (typeof window === 'undefined' || !window.localStorage) return {}
  try {
    const raw = window.localStorage.getItem(getStorageKey(ownerId))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const marks = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (Number.isFinite(value)) marks[key] = value
    }
    return marks
  } catch {
    return {}
  }
}

export function writeConversationReadMarks(ownerId, marks) {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(getStorageKey(ownerId), JSON.stringify(marks || {}))
  } catch {
    // ignore desktop local storage failures
  }
}

// Returns the next marks object if `timestamp` advances the marker for the
// given target, otherwise returns the same reference so callers can skip a
// redundant state update.
export function markConversationTargetRead(marks, type, id, timestamp) {
  const key = conversationTargetKey(type, id)
  if (!key || key.endsWith(':')) return marks || {}
  const stamp = Number.isFinite(timestamp) ? timestamp : 0
  const current = marks && Number.isFinite(marks[key]) ? marks[key] : 0
  if (stamp <= current) return marks || {}
  return { ...(marks || {}), [key]: stamp }
}
