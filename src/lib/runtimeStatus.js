import { useSyncExternalStore } from 'react'
import { engineClient } from './engine/client.js'
import { normalizeEngineResponse } from './engine/contracts.js'

const RUNTIME_STATUS_STORAGE_KEY = 'imai.runtime-status.v1'

function loadPersistedRuntimeState() {
  if (typeof window === 'undefined' || !window.localStorage) return null
  try {
    const raw = window.localStorage.getItem(RUNTIME_STATUS_STORAGE_KEY)
    if (!raw) return null
    const persisted = JSON.parse(raw)
    return {
      ...persisted,
      openClaw: {
        ...persisted?.openClaw,
        status: normalizeEngineResponse(persisted?.openClaw?.status),
      },
      conversationBridge: {
        ...persisted?.conversationBridge,
        status: normalizeEngineResponse(persisted?.conversationBridge?.status),
      },
    }
  } catch {
    return null
  }
}

const persistedState = loadPersistedRuntimeState()

let runtimeState = {
  openClaw: {
    status: persistedState?.openClaw?.status ?? null,
    loading: false,
    lastCheckedAt: persistedState?.openClaw?.lastCheckedAt ?? null,
    error: null,
  },
  openClawProfiles: {
    statuses: {},
    loading: {},
    lastCheckedAt: {},
    errors: {},
  },
  gatewayConnection: {
    startupErrors: {},
    startupPreparing: {},
    snapshots: {},
    loading: {},
    lastCheckedAt: {},
    errors: {},
  },
  conversationBridge: {
    status: persistedState?.conversationBridge?.status ?? null,
    loading: false,
    lastCheckedAt: persistedState?.conversationBridge?.lastCheckedAt ?? null,
    error: null,
  },
}

const listeners = new Set()
// Each authoritative publication invalidates probes that began before it.
const gatewayRevisions = new Map()

function persistRuntimeState() {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(
      RUNTIME_STATUS_STORAGE_KEY,
      JSON.stringify({
        openClaw: {
          status: runtimeState.openClaw.status,
          lastCheckedAt: runtimeState.openClaw.lastCheckedAt,
        },
        conversationBridge: {
          status: runtimeState.conversationBridge.status,
          lastCheckedAt: runtimeState.conversationBridge.lastCheckedAt,
        },
      }),
    )
  } catch {
    // ignore localStorage persistence failures in desktop webviews
  }
}

function emitChange() {
  persistRuntimeState()
  for (const listener of listeners) {
    listener()
  }
}

function getErrorMessage(error, fallback) {
  return typeof error === 'string' ? error : error?.message || fallback
}

function setOpenClawState(next) {
  runtimeState = {
    ...runtimeState,
    openClaw: {
      ...runtimeState.openClaw,
      ...next,
    },
  }
  emitChange()
}

function setConversationBridgeState(next) {
  runtimeState = {
    ...runtimeState,
    conversationBridge: {
      ...runtimeState.conversationBridge,
      ...next,
    },
  }
  emitChange()
}

function profileRuntimeKey(profile, gatewayPort = null) {
  if (!profile) return ''
  return gatewayPort ? `${profile}:${gatewayPort}` : profile
}

export function gatewayPortFromSnapshot(snapshot) {
  const endpoint = snapshot?.endpointUrl || ''
  if (!endpoint) return null
  try {
    const url = new URL(endpoint)
    return url.port || null
  } catch {
    const matched = String(endpoint).match(/:(\d+)(?:\/|$)/)
    return matched?.[1] || null
  }
}

export function getGatewayConnectionRuntimeKey(profile, gatewayPort = null, snapshot = null) {
  return profileRuntimeKey(profile, gatewayPortFromSnapshot(snapshot) || gatewayPort)
}

function replaceProfileRuntimeEntry(collection, profile, key, value, shouldWrite) {
  if (!shouldWrite) return collection || {}
  const next = {}
  for (const [entryKey, entryValue] of Object.entries(collection || {})) {
    if (entryKey !== profile && !entryKey.startsWith(`${profile}:`)) {
      next[entryKey] = entryValue
    }
  }
  if (shouldWrite) next[key] = value
  return next
}

function setOpenClawProfileState(profile, gatewayPort, next) {
  const key = profileRuntimeKey(profile, gatewayPort)
  if (!key) return null
  runtimeState = {
    ...runtimeState,
    openClawProfiles: {
      ...runtimeState.openClawProfiles,
      statuses: {
        ...runtimeState.openClawProfiles.statuses,
        ...(Object.prototype.hasOwnProperty.call(next, 'status') ? { [key]: next.status } : {}),
      },
      loading: {
        ...runtimeState.openClawProfiles.loading,
        ...(Object.prototype.hasOwnProperty.call(next, 'loading') ? { [key]: next.loading } : {}),
      },
      lastCheckedAt: {
        ...runtimeState.openClawProfiles.lastCheckedAt,
        ...(Object.prototype.hasOwnProperty.call(next, 'lastCheckedAt') ? { [key]: next.lastCheckedAt } : {}),
      },
      errors: {
        ...runtimeState.openClawProfiles.errors,
        ...(Object.prototype.hasOwnProperty.call(next, 'error') ? { [key]: next.error } : {}),
      },
    },
  }
  emitChange()
  return runtimeState.openClawProfiles.statuses[key] || null
}

function setGatewayConnectionState(profile, gatewayPort, next) {
  const key = getGatewayConnectionRuntimeKey(profile, gatewayPort, next?.snapshot)
  if (!key) return null
  runtimeState = {
    ...runtimeState,
    gatewayConnection: {
      ...runtimeState.gatewayConnection,
      snapshots: replaceProfileRuntimeEntry(
        runtimeState.gatewayConnection.snapshots,
        profile,
        key,
        next.snapshot,
        Object.prototype.hasOwnProperty.call(next, 'snapshot'),
      ),
      loading: replaceProfileRuntimeEntry(
        runtimeState.gatewayConnection.loading,
        profile,
        key,
        next.loading,
        Object.prototype.hasOwnProperty.call(next, 'loading'),
      ),
      lastCheckedAt: replaceProfileRuntimeEntry(
        runtimeState.gatewayConnection.lastCheckedAt,
        profile,
        key,
        next.lastCheckedAt,
        Object.prototype.hasOwnProperty.call(next, 'lastCheckedAt'),
      ),
      errors: replaceProfileRuntimeEntry(
        runtimeState.gatewayConnection.errors,
        profile,
        key,
        next.error,
        Object.prototype.hasOwnProperty.call(next, 'error'),
      ),
    },
  }
  emitChange()
  return runtimeState.gatewayConnection.snapshots[key] || null
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return runtimeState
}

export function useRuntimeStatusStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function setOpenClawRuntimeStatus(status) {
  const normalizedStatus = normalizeEngineResponse(status)
  const previous = runtimeState.openClaw.status
  const nextStatus = normalizedStatus && previous?.installed && normalizedStatus.installed
    ? {
        ...normalizedStatus,
        latestVersion: normalizedStatus.latestVersion ?? previous.latestVersion,
        updateAvailable: normalizedStatus.updateAvailable ?? previous.updateAvailable,
        updateMessage: normalizedStatus.updateMessage ?? previous.updateMessage,
      }
    : normalizedStatus

  setOpenClawState({
    status: nextStatus,
    loading: false,
    lastCheckedAt: Date.now(),
    error: null,
  })
  return nextStatus
}

export function setConversationBridgeRuntimeStatus(status) {
  const normalizedStatus = normalizeEngineResponse(status)
  setConversationBridgeState({
    status: normalizedStatus,
    loading: false,
    lastCheckedAt: Date.now(),
    error: null,
  })
  return normalizedStatus
}

export function getOpenClawProfileRuntimeKey(profile, gatewayPort = null) {
  return profileRuntimeKey(profile, gatewayPort)
}

export function setOpenClawProfileRuntimeStatus({ profile, gatewayPort = null }, status) {
  return setOpenClawProfileState(profile, gatewayPort, {
    status: normalizeEngineResponse(status),
    loading: false,
    lastCheckedAt: Date.now(),
    error: null,
  })
}

export async function refreshOpenClawProfileStatus({ profile, gatewayPort = null, silent = false } = {}) {
  if (!profile) return null
  if (!silent) {
    setOpenClawProfileState(profile, gatewayPort, {
      loading: true,
      error: null,
    })
  }

  try {
    const status = await engineClient.status.profile({
      input: {
        profile,
        gatewayPort: gatewayPort || null,
      },
    })
    return setOpenClawProfileRuntimeStatus({ profile, gatewayPort }, status)
  } catch (error) {
    if (!silent) {
      setOpenClawProfileState(profile, gatewayPort, {
        loading: false,
        error: getErrorMessage(error, '检测 Uniopc 引擎 profile 失败'),
      })
    }
    throw error
  }
}

// Transient UI state only: never persisted and never used as execution readiness.
export function setGatewayConnectionStartupPreparing({ profile }, preparing) {
  if (!profile || runtimeState.gatewayConnection.startupPreparing[profile] === preparing) return
  runtimeState = {
    ...runtimeState,
    gatewayConnection: {
      ...runtimeState.gatewayConnection,
      startupPreparing: { ...runtimeState.gatewayConnection.startupPreparing, [profile]: preparing },
    },
  }
  emitChange()
}

export function setGatewayConnectionStartupError({ profile }, error) {
  if (!profile) return
  if (error) setGatewayConnectionStartupPreparing({ profile }, false)
  runtimeState = {
    ...runtimeState,
    gatewayConnection: {
      ...runtimeState.gatewayConnection,
      startupErrors: {
        ...runtimeState.gatewayConnection.startupErrors,
        [profile]: error ? getErrorMessage(error, '本地引擎启动失败，请查看诊断并重试。') : null,
      },
    },
  }
  emitChange()
}

export function invalidateGatewayConnectionRuntimeSnapshot({ profile }) {
  if (!profile) return
  gatewayRevisions.set(profile, (gatewayRevisions.get(profile) || 0) + 1)
  setGatewayConnectionStartupPreparing({ profile }, false)
  setGatewayConnectionStartupError({ profile }, null)
  setGatewayConnectionState(profile, null, {
    snapshot: null,
    loading: false,
    lastCheckedAt: null,
    error: null,
  })
}

export function setGatewayConnectionRuntimeSnapshot({ profile, gatewayPort = null }, snapshot) {
  if (!profile) return null
  const normalizedSnapshot = normalizeEngineResponse(snapshot)
  gatewayRevisions.set(profile, (gatewayRevisions.get(profile) || 0) + 1)
  if (isGatewayConnectionReady(normalizedSnapshot)) {
    setGatewayConnectionStartupPreparing({ profile }, false)
    setGatewayConnectionStartupError({ profile }, null)
  }
  return setGatewayConnectionState(profile, gatewayPort, {
    snapshot: normalizedSnapshot,
    loading: false,
    lastCheckedAt: Date.now(),
    error: null,
  })
}

export async function refreshGatewayConnectionSnapshot({ profile, gatewayPort = null, silent = false } = {}) {
  if (!profile) return null
  const revision = (gatewayRevisions.get(profile) || 0) + 1
  gatewayRevisions.set(profile, revision)
  if (!silent) {
    setGatewayConnectionState(profile, gatewayPort, {
      loading: true,
      error: null,
    })
  }

  try {
    const snapshot = await engineClient.status.connection({
      input: {
        profile,
        gatewayPort: gatewayPort || null,
      },
    })
    if (gatewayRevisions.get(profile) !== revision) return getGatewayConnectionSnapshot(profile, gatewayPort)
    if (isGatewayConnectionReady(snapshot)) {
      setGatewayConnectionStartupPreparing({ profile }, false)
      setGatewayConnectionStartupError({ profile }, null)
    }
    return setGatewayConnectionState(profile, gatewayPort, {
      snapshot,
      loading: false,
      lastCheckedAt: Date.now(),
      error: null,
    })
  } catch (error) {
    if (!silent && gatewayRevisions.get(profile) === revision) {
      setGatewayConnectionState(profile, gatewayPort, {
        loading: false,
        error: getErrorMessage(error, '检测 Gateway Connection 失败'),
      })
    }
    throw error
  }
}

export function getGatewayConnectionSnapshot(profile, gatewayPort = null) {
  if (!profile) return null
  const snapshots = runtimeState.gatewayConnection.snapshots
  const key = getGatewayConnectionRuntimeKey(profile, gatewayPort)
  const exactSnapshot = key ? snapshots[key] : null
  if (exactSnapshot) return exactSnapshot
  const legacySnapshot = snapshots[profile]
  if (legacySnapshot) return legacySnapshot
  const fallbackKey = Object.keys(snapshots)
    .find(entryKey => entryKey.startsWith(`${profile}:`))
  return fallbackKey ? snapshots[fallbackKey] || null : null
}

export function isGatewayConnectionLoading(profile, gatewayPort = null) {
  const key = getGatewayConnectionRuntimeKey(profile, gatewayPort)
  return key ? Boolean(runtimeState.gatewayConnection.loading[key]) : false
}

export function isGatewayConnectionReady(connectionSnapshot) {
  return getGatewayConnectionReadiness(connectionSnapshot).ready
}

export function getGatewayConnectionReadiness(connectionSnapshot) {
  const snapshot = normalizeEngineResponse(connectionSnapshot)
  return {
    ready: snapshot?.status === 'connected',
    status: snapshot?.status || 'unknown',
    message: snapshot?.message || '',
  }
}

export function isOpenClawAppReady(status, connectionSnapshot = null) {
  if (typeof status?.appReady === 'boolean' && connectionSnapshot == null) return status.appReady
  return Boolean(status?.installed && status?.supported !== false && isGatewayConnectionReady(connectionSnapshot))
}

export function getOpenClawSetupStage(status) {
  if (status?.setupStage) return status.setupStage
  if (status?.supported === false) return 'unsupported'
  if (!status?.installed) return 'missing_openclaw'
  return 'ready'
}

export async function refreshOpenClawStatus(options = {}) {
  const silent = Boolean(options?.silent)
  if (!silent) {
    setOpenClawState({
      loading: true,
      error: null,
    })
  }

  try {
    const status = await engineClient.status.get({})
    return setOpenClawRuntimeStatus(status)
  } catch (error) {
    if (!silent) {
      setOpenClawState({
        loading: false,
        error: getErrorMessage(error, '检测 Uniopc 引擎 失败'),
      })
    }
    throw error
  }
}

export async function ensureOpenClawStatus() {
  if (
    runtimeState.openClaw.status &&
    typeof runtimeState.openClaw.status.installed === 'boolean' &&
    typeof runtimeState.openClaw.status.providerReady === 'boolean' &&
    runtimeState.openClaw.loading === false
  ) {
    return runtimeState.openClaw.status
  }
  if (runtimeState.openClaw.loading) {
    return runtimeState.openClaw.status
  }
  return refreshOpenClawStatus()
}

export async function refreshConversationBridgeStatus({ profile } = {}) {
  setConversationBridgeState({
    loading: true,
    error: null,
  })

  try {
    const status = await engineClient.status.bridge({ profile: profile || null })
    return setConversationBridgeRuntimeStatus(status)
  } catch (error) {
    setConversationBridgeState({
      loading: false,
      error: getErrorMessage(error, '检测对话桥接状态失败'),
    })
    throw error
  }
}

export async function ensureConversationBridgeStatus({ profile } = {}) {
  if (runtimeState.conversationBridge.status || runtimeState.conversationBridge.loading) {
    return runtimeState.conversationBridge.status
  }
  return refreshConversationBridgeStatus({ profile })
}
