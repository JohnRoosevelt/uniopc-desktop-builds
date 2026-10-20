function toTimestamp(value) {
  if (Number.isFinite(value)) return value
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

function latestMessageTimestamp(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  return messages.reduce((latest, message) => Math.max(
    latest,
    toTimestamp(message?.createdAt || message?.created_at),
  ), 0)
}

// An "inbound" message is one authored by the AI employee, not by me.
function isInboundMessage(message = {}) {
  return message?.role && message.role !== 'user'
}

function countInboundSince(messages = [], lastReadAt = 0) {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  const threshold = Number.isFinite(lastReadAt) ? lastReadAt : 0
  return messages.reduce((count, message) => {
    if (!isInboundMessage(message)) return count
    const stamp = toTimestamp(message?.createdAt || message?.created_at)
    return stamp > threshold ? count + 1 : count
  }, 0)
}

export function conversationTargetUnreadCount(type, targetId, conversations = [], lastReadAt = 0) {
  return (Array.isArray(conversations) ? conversations : []).reduce((count, record) => {
    if (!conversationBelongsToTarget(record, type, targetId)) return count
    return count + countInboundSince(record.messages, lastReadAt)
  }, 0)
}

function conversationBelongsToTarget(record = {}, type = '', targetId = '') {
  const id = String(targetId || '').trim()
  if (!id) return false

  const employeeId = String(record.employeeId || '').trim()
  if (!employeeId) return false
  return employeeId === id
}

export function conversationTargetUpdatedAt(type, targetId, conversations = []) {
  return (Array.isArray(conversations) ? conversations : []).reduce((latest, record) => {
    if (!conversationBelongsToTarget(record, type, targetId)) return latest
    const messageUpdatedAt = latestMessageTimestamp(record.messages)
    if (!messageUpdatedAt) return latest
    return Math.max(latest, messageUpdatedAt)
  }, 0)
}

function readMarkFor(readMarks, type, id) {
  if (!readMarks || typeof readMarks !== 'object') return 0
  const value = readMarks[`${type}:${String(id || '').trim()}`]
  return Number.isFinite(value) ? value : 0
}

export function buildConversationRoster({ employees = [], conversations = [], readMarks = null } = {}) {
  const rows = [
    ...(Array.isArray(employees) ? employees : []).map((employee, index) => ({
      type: 'employee',
      id: employee.id,
      employee,
      updatedAt: conversationTargetUpdatedAt('employee', employee.id, conversations),
      unreadCount: conversationTargetUnreadCount('employee', employee.id, conversations, readMarkFor(readMarks, 'employee', employee.id)),
      originalIndex: index,
    })),
  ].filter(item => item.id)

  return rows.sort((left, right) =>
    (right.updatedAt || 0) - (left.updatedAt || 0)
      || left.originalIndex - right.originalIndex,
  )
}
