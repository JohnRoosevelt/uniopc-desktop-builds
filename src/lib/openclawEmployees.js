import { engineClient } from './engine/client.js'
import { normalizeEngineResponse } from './engine/contracts.js'

const localEmployeeCache = new Map()
const inflightRuntimeRequests = new Map()

function normalizeEmployees(items) {
  return Array.isArray(items) ? normalizeEngineResponse(items) : []
}

function normalizeProfileKey(profile) {
  const value = typeof profile === 'string' ? profile.trim() : ''
  return value || 'default'
}

// Persist the last-known LOCAL agent list to disk so the chat roster paints
// instantly on launch/reload — before the gateway is even up — instead of
// flashing empty ("正在同步员工列表"). This is a snapshot of the LOCAL engine's
// agents (what is actually runnable here), NOT the cloud registry, so it's a
// meaningful "will be usable once the gateway is up" list, reconciled against
// the live runtime as soon as it responds.
function employeesStorageKey(profile) {
  return `uniopc.localEmployees.v1.${normalizeProfileKey(profile)}`
}

export function readPersistedLocalEmployees(profile = null) {
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    const raw = window.localStorage.getItem(employeesStorageKey(profile))
    const parsed = raw ? JSON.parse(raw) : []
    return normalizeEmployees(parsed)
  } catch {
    return []
  }
}

function persistLocalEmployees(profile, items) {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    const list = normalizeEmployees(items)
    if (list.length > 0) {
      window.localStorage.setItem(employeesStorageKey(profile), JSON.stringify(list))
    } else {
      window.localStorage.removeItem(employeesStorageKey(profile))
    }
  } catch {
    // best-effort cache; ignore quota/serialization errors
  }
}

export async function loadLocalEmployees(profile = null) {
  return fetchOpenClawEmployees({ profile })
}

export async function fetchOpenClawEmployees({
  force = false,
  profile = null,
  syncCloudEmployees = null,
} = {}) {
  const cacheKey = normalizeProfileKey(profile)

  if (!force && localEmployeeCache.has(cacheKey)) {
    return localEmployeeCache.get(cacheKey)
  }

  if (!force && inflightRuntimeRequests.has(cacheKey)) {
    return inflightRuntimeRequests.get(cacheKey)
  }

  const inflightPromise = engineClient.agents.list({ profile })
    .then(items => {
      const normalized = normalizeEmployees(items)
      if (normalized.length > 0) {
        localEmployeeCache.set(cacheKey, normalized)
        persistLocalEmployees(profile, normalized)
      } else {
        localEmployeeCache.delete(cacheKey)
      }
      if (typeof syncCloudEmployees === 'function') {
        Promise.resolve(syncCloudEmployees(normalized)).catch(error => {
          console.warn('Failed to sync Uniopc 引擎 agents to cloud', error)
        })
      }
      return normalized
    })
    .finally(() => {
      inflightRuntimeRequests.delete(cacheKey)
    })

  inflightRuntimeRequests.set(cacheKey, inflightPromise)
  return inflightPromise
}

export function getLocalEmployees(profile = null) {
  const cached = localEmployeeCache.get(normalizeProfileKey(profile))
  if (cached) return cached
  // Fall back to the disk snapshot so a fresh webview (reload / relaunch) still
  // has the last-known local agents before the first runtime fetch completes.
  const persisted = readPersistedLocalEmployees(profile)
  return persisted.length > 0 ? persisted : null
}

export function primeLocalEmployeesCache(items, profile = null) {
  localEmployeeCache.set(normalizeProfileKey(profile), normalizeEmployees(items))
}

export function invalidateLocalEmployeesCache(profile = null) {
  if (profile == null) {
    localEmployeeCache.clear()
    inflightRuntimeRequests.clear()
    return
  }

  const cacheKey = normalizeProfileKey(profile)
  localEmployeeCache.delete(cacheKey)
  inflightRuntimeRequests.delete(cacheKey)
}
