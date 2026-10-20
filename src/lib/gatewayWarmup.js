// Fire-and-forget local gateway warm-up (Phase 2 of "点开即用").
//
// The gateway used to start only after the user was redirected into the
// Uniopc 引擎 setup gate, serializing login → guard check → gate → start →
// poll. Warming up as soon as the guard knows the target profile lets the
// gateway boot in parallel with the user's login/navigation, the same way
// Accio starts its runtime alongside the login window.
//
// This per-profile promise coalesces UI state publication only. Startup
// correctness lives in Rust's app-owned StartupCoordinator, so bootstrap,
// page and runtime-recovery callers still share one inspect/repair/spawn flight
// even when they originate from different JavaScript module instances.

import { invoke } from '@tauri-apps/api/core'
import { getGatewayConnectionSnapshot, isGatewayConnectionReady, setGatewayConnectionStartupPreparing, setGatewayConnectionRuntimeSnapshot, setGatewayConnectionStartupError, invalidateGatewayConnectionRuntimeSnapshot } from './runtimeStatus'

const inFlightWarmups = new Map()
const preparingTimers = new Map()

function warmupKey(profile) {
  return String(profile || '').trim()
}

export function warmUpLocalGateway({ profile, gatewayPort = null } = {}) {
  const normalizedProfile = String(profile || '').trim()
  if (!normalizedProfile) {
    return Promise.reject(new Error('Uniopc 引擎 Profile 尚未就绪，无法启动 Gateway。'))
  }

  const key = warmupKey(normalizedProfile)
  const existing = inFlightWarmups.get(key)
  if (existing) return existing

  setGatewayConnectionStartupError({ profile: normalizedProfile, gatewayPort }, null)
  const task = (async () => {
    const snapshot = await invoke('openclaw_connection_start_local', {
      input: {
        profile: normalizedProfile,
        gatewayPort: gatewayPort || null,
      },
    })
    if (inFlightWarmups.get(key) !== task) return null
    setGatewayConnectionRuntimeSnapshot({ profile: normalizedProfile, gatewayPort }, snapshot)
    if (snapshot?.status !== 'connected') {
      setGatewayConnectionStartupError({ profile: normalizedProfile, gatewayPort },
        snapshot?.error || snapshot?.lastError || snapshot?.statusMessage || '本地引擎尚未连接，请查看诊断并重试。')
    }
    return snapshot
  })()

  inFlightWarmups.set(key, task)
  // Passive feedback after a brief grace period; fast reuse never flashes and
  // the composer stays usable throughout. The timer cannot authorize a send.
  const timer = setTimeout(() => {
    if (inFlightWarmups.get(key) !== task) return
    if (!isGatewayConnectionReady(getGatewayConnectionSnapshot(normalizedProfile))) {
      setGatewayConnectionStartupPreparing({ profile: normalizedProfile }, true)
    }
  }, 1000)
  preparingTimers.set(key, timer)
  const finish = () => {
    clearTimeout(timer)
    if (preparingTimers.get(key) === timer) preparingTimers.delete(key)
    if (inFlightWarmups.get(key) !== task) return
    setGatewayConnectionStartupPreparing({ profile: normalizedProfile }, false)
    inFlightWarmups.delete(key)
  }
  task.then(() => {
    finish()
  }, error => {
    if (inFlightWarmups.get(key) !== task) return
    setGatewayConnectionStartupError({ profile: normalizedProfile, gatewayPort }, error)
    finish()
  })
  return task
}

export function isGatewayWarmupInFlight({ profile, gatewayPort = null } = {}) {
  return inFlightWarmups.has(warmupKey(profile))
}

// Logout/Profile cleanup releases this session's singleflight. Rust owns child
// lifecycle; a later login must issue its own start, even if this one is pending.
export function invalidateGatewayWarmup({ profile } = {}) {
  const key = warmupKey(profile)
  if (!key) return
  clearTimeout(preparingTimers.get(key))
  preparingTimers.delete(key)
  inFlightWarmups.delete(key)
  invalidateGatewayConnectionRuntimeSnapshot({ profile: key })
}
