import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import { LOCAL_ASSISTANT_LAUNCH_PATH } from '../lib/localAssistantLaunch'
import { useRuntimeStatusStore } from '../lib/runtimeStatus'

// Startup feedback is passive and shared across routes. The warmup owns its
// delay and lifecycle; this view never starts or probes the local engine.
export default function EngineStatusStrip() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const { activeProfile } = useActiveOpenClawProfile()
  const runtime = useRuntimeStatusStore()
  const error = runtime.gatewayConnection.startupErrors[activeProfile]
  const preparing = runtime.gatewayConnection.startupPreparing[activeProfile]
  if (
    location.pathname === LOCAL_ASSISTANT_LAUNCH_PATH ||
    !user?.uid ||
    !activeProfile ||
    (!error && !preparing)
  ) return null

  if (!error) return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-[90] flex justify-center" role="status">
      <span className="inline-flex max-w-[80vw] items-center gap-2 rounded-full border border-subtle bg-surface-raised px-3.5 py-1.5 text-xs text-secondary shadow-lg">
        <span aria-hidden="true" className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
        本地助手准备中 · 可先输入，消息会保存待发
      </span>
    </div>
  )

  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-[90] flex justify-center">
      <button
        type="button"
        onClick={() => navigate('/setup/openclaw')}
        className="pointer-events-auto inline-flex max-w-[80vw] items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/15 px-3.5 py-1.5 text-xs font-medium text-warning-text shadow-lg backdrop-blur transition-colors hover:bg-amber-400/25"
      >
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-amber-300/45 text-2xs">!</span>
        <span className="truncate">{error} · 查看诊断与重试</span>
      </button>
    </div>
  )
}
