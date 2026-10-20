// Keep permission writes ordered per Gateway session, including explicit default
// (which clears an override). List snapshots taken before a write cannot undo it.
export function createConversationPermissionCoordinator() {
  const entries = new Map()
  let revision = 0
  const key = (profile, sessionKey) => JSON.stringify([profile, sessionKey])
  function entry(profile, sessionKey, fallback = 'default') {
    const id = key(profile, sessionKey)
    if (!entries.has(id)) entries.set(id, { mode: fallback, pending: 0, failed: false, revision: 0, tail: Promise.resolve() })
    return entries.get(id)
  }
  return {
    snapshot: () => revision,
    mode: (profile, sessionKey, fallback = 'default') => entries.get(key(profile, sessionKey))?.mode ?? fallback,
    blocked: (profile, sessionKey) => {
      const value = entries.get(key(profile, sessionKey))
      return Boolean(value?.pending || value?.failed)
    },
    observe(profile, sessions, startedAt) {
      return sessions.map(session => {
        const value = entry(profile, session.sessionKey || session.key)
        if (!value.pending && value.revision <= startedAt) {
          value.mode = session.permissionMode || 'default'
          // A failed downgrade must not silently release queued messages under
          // the old policy. A fresh read may confirm that the requested write
          // actually committed despite its failed/ambiguous response.
          value.failed = value.failed && value.mode !== value.requestedMode
        }
        return { ...session, permissionMode: value.mode === 'default' ? null : value.mode }
      })
    },
    async save(profile, sessionKey, mode, fallback, write) {
      const value = entry(profile, sessionKey, fallback)
      value.requestedMode = mode
      value.pending++
      value.revision = ++revision
      const operation = value.tail.then(write)
      value.tail = operation.catch(() => {})
      try {
        await operation
        value.mode = mode
        value.failed = false
      } catch (error) {
        value.failed = true
        throw error
      } finally {
        value.pending--
        // Mark completion too: a list started while this write was pending is stale.
        value.revision = ++revision
      }
      return value.mode
    },
  }
}
