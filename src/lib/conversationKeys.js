export function buildConversationRecordId(employeeId) {
  return String(employeeId || '').trim()
}

export function buildSessionKey(employeeId) {
  const id = buildConversationRecordId(employeeId)
  return id ? `agent:${id}:main` : ''
}

export function buildConversationSessionRecordId(employeeId, sessionKey) {
  const id = buildConversationRecordId(employeeId)
  const key = String(sessionKey || '').trim()
  if (!id) return ''
  if (!key || key === buildSessionKey(id)) return id
  return `session:${key}`
}
