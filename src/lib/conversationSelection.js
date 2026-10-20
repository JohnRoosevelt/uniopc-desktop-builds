// Extension required: node --test resolves this import too (Vite is lax).
import { buildSessionKey } from './conversationKeys.js'

function hasId(items, id) {
  if (!id) return false
  return Array.isArray(items) && items.some(item => item?.id === id)
}

function sessionRecencyMillis(session) {
  const updated = Number(session?.updatedAt)
  if (Number.isFinite(updated) && updated > 0) return updated
  const created = Number(session?.createdAt)
  if (Number.isFinite(created) && created > 0) return created
  return 0
}

// Newest first, as a frontend guarantee: the gateway's `sessions.list` order is
// an implementation detail we never controlled — the picker just rendered it
// verbatim. Stable sort, so entries without timestamps keep the gateway's
// relative order (after all timestamped ones).
export function sortConversationSessionsByRecency(sessions) {
  if (!Array.isArray(sessions)) return []
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) =>
      sessionRecencyMillis(b.session) - sessionRecencyMillis(a.session) || a.index - b.index,
    )
    .map(({ session }) => session)
}

export function sessionKeyBelongsToEmployee({ employeeId, sessionKey } = {}) {
  const id = String(employeeId || '').trim()
  const key = String(sessionKey || '').trim()
  return Boolean(id && key.startsWith(`agent:${id}:`))
}

function sessionBelongsToEmployee(session, employeeId) {
  if (!session) return false
  if (session.agentId && session.agentId === employeeId) return true
  return sessionKeyBelongsToEmployee({
    employeeId,
    sessionKey: session.sessionKey || session.key,
  })
}

function sessionKindIsInteractive(session) {
  const kind = String(session?.kind || '').trim()
  return !kind || kind === 'main' || kind === 'interactive'
}

// Default selection = the newest session in the picker, not the hardcoded
// `agent:<id>:main` (that main session is usually the OLDEST one — defaulting
// to it made the check mark sit on the bottom row while a fresher session sat
// on top). The employee guard matters: the sessions list refreshes async, so
// right after switching employees it can still hold the previous employee's
// rows — never derive a default from those. Falls back to `:main` while the
// list is empty or foreign.
export function defaultConversationSessionKey({ employeeId, sessions } = {}) {
  const id = String(employeeId || '').trim()
  if (!id) return ''
  const list = Array.isArray(sessions) ? sessions : []
  const newestOwn = list.find(
    session => sessionKindIsInteractive(session) && sessionBelongsToEmployee(session, id),
  )
  const key = newestOwn ? String(newestOwn.sessionKey || newestOwn.key || '').trim() : ''
  return key || buildSessionKey(id)
}

export function resolveActiveConversationTarget({
  employeeIdFromUrl = '',
  employees = [],
  roster = [],
} = {}) {
  if (hasId(employees, employeeIdFromUrl)) {
    return { type: 'employee', id: employeeIdFromUrl }
  }
  const rosterTarget = Array.isArray(roster)
    ? roster.find(item => {
        if (item?.type === 'employee') return hasId(employees, item.id)
        return false
      })
    : null
  if (rosterTarget) {
    return { type: rosterTarget.type, id: rosterTarget.id }
  }
  if (Array.isArray(employees) && employees[0]?.id) {
    return { type: 'employee', id: employees[0].id }
  }
  return null
}
