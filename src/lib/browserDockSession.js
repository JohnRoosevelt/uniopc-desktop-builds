export function selectBrowserDockTab(tabs, selectedTargetId) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null
  return tabs.find(tab => (tab.id || tab.targetId) === selectedTargetId)
    || tabs.find(tab => tab.type === 'page')
    || tabs[0]
}

export function resolveBrowserDockTab(tabs, targetRef) {
  if (!Array.isArray(tabs) || !targetRef) return null
  const tab = tabs.find(item => [item.id, item.targetId, item.tabId].includes(targetRef))
  return tab ? (tab.id || tab.targetId || tab.tabId) : null
}

function collectTargetRefs(value, refs, field = 'targetId') {
  if (typeof value === 'string') {
    try { collectTargetRefs(JSON.parse(value), refs, field); return } catch { /* inspect embedded JSON fragments below */ }
    for (const match of value.matchAll(/"(targetId|tabId)"\s*:\s*"([^"]+)"/g)) if (match[1] === field) refs.push(match[2])
    return
  }
  if (Array.isArray(value)) { value.forEach(item => collectTargetRefs(item, refs, field)); return }
  if (!value || typeof value !== 'object') return
  if (typeof value[field] === 'string' && value[field]) refs.push(value[field])
  Object.values(value).forEach(item => collectTargetRefs(item, refs, field))
}

function hasNonLocalRoute(value) {
  if (typeof value === 'string') {
    try { return hasNonLocalRoute(JSON.parse(value)) } catch { return false }
  }
  if (Array.isArray(value)) return value.some(hasNonLocalRoute)
  if (!value || typeof value !== 'object') return false
  const localRoutes = new Set(['openclaw', 'default', 'local', 'host', 'local-auto'])
  for (const key of ['profile', 'browserProfile', 'route', 'target']) {
    if (typeof value[key] === 'string' && !localRoutes.has(value[key].trim().toLowerCase())) return true
  }
  return Object.values(value).some(hasNonLocalRoute)
}

/** Extract only explicit browser-tool tab identifiers from the active chat's event. */
export function browserDockAgentTargetCandidate(payload, activeSessionKey, localManaged) {
  if (!localManaged || !activeSessionKey || payload?.sessionKey !== activeSessionKey) return null
  if (payload?.toolName !== 'browser' || payload?.toolIsError || !String(payload?.state || '').startsWith('tool_')) return null
  if (hasNonLocalRoute(payload.toolArgs)) return null
  const resultRefs = []
  const argumentRefs = []
  // A result can identify a newly-opened target; otherwise honor the target
  // explicitly named by the browser action arguments.
  collectTargetRefs(payload.toolResultPreview, resultRefs)
  collectTargetRefs(payload.toolArgs, argumentRefs)
  if (argumentRefs.length === 0) collectTargetRefs(payload.toolArgs, argumentRefs, 'tabId')
  if (argumentRefs.length > 0) return argumentRefs[0]
  // Official open results include both the native targetId and a short tabId
  // alias for that same tab. Prefer native IDs; a tabs-list with several native
  // targets remains ambiguous and must not override a manual choice.
  if (resultRefs.length === 0) collectTargetRefs(payload.toolResultPreview, resultRefs, 'tabId')
  const uniqueResults = [...new Set(resultRefs)]
  return uniqueResults.length === 1 ? uniqueResults[0] : null
}

/** Serializes CDP calls so consecutive user keystrokes are applied in order. */
export function createBrowserDockActionQueue() {
  let tail = Promise.resolve()
  return task => {
    const operation = tail.then(task, task)
    tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}
