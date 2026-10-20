import { useEffect } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { warmUpLocalGateway, invalidateGatewayWarmup } from '../lib/gatewayWarmup'
import { refreshOpenClawStatus } from '../lib/runtimeStatus'

// Mounted above Routes: profile identity is the only startup prerequisite.
// start_local joins Rust's app-owned StartupCoordinator and returns its shared
// verified snapshot; this component never owns process lifecycle correctness.
export default function LocalEngineBootstrap() {
  const { user } = useAuth()
  const { activeProfile, workspaceProfile } = useActiveOpenClawProfile()
  const gatewayPort = workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null

  useEffect(() => {
    if (!user?.uid || !activeProfile) return undefined
    let cancelled = false
    warmUpLocalGateway({ profile: activeProfile, gatewayPort })
      .catch(() => null) // Profile-scoped startup errors stay in runtimeStatus.
      .finally(() => {
        if (!cancelled) refreshOpenClawStatus({ silent: true }).catch(() => null)
      })
    return () => {
      cancelled = true
      invalidateGatewayWarmup({ profile: activeProfile })
    }
  }, [user?.uid, activeProfile, gatewayPort])

  return null
}
