import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useAuth } from '../hooks/useAuth'
import { useActiveOpenClawProfile } from '../hooks/useActiveOpenClawProfile'
import {
  getGatewayConnectionSnapshot,
  isGatewayConnectionReady,
  useRuntimeStatusStore,
} from '../lib/runtimeStatus'
import {
  maybeBootstrapUniopcOfficialModel,
  connectUniopcOfficialModel,
  refreshUniopcOfficialModelToken,
  subscribeOfficialModelStatus,
} from '../lib/uniopcOfficialModel'

const FIRST_ATTEMPT_DELAY_MS = 0
const RETRY_DELAY_MS = 15000
const FAST_ATTEMPTS = 5
// Cap the backoff LOW (30s, was 5min). Existing official-model Profiles prewarm
// their token before Gateway readiness; fresh/damaged Profiles defer repair
// until the shared Gateway snapshot is ready.
const BACKOFF_CAP_MS = 30 * 1000

// Headless auto-connect + visible fallback: right after login, users with no
// configured model are connected to the Uniopc official model automatically
// (free trial credits included). Users who already configured their own
// provider are left untouched — the shared guard in uniopcOfficialModel.js
// makes this a no-op for them. It stays silent while the local Gateway starts,
// then retries model-specific failures and surfaces a retry banner if they keep
// failing, so a dropped config.patch cannot strand the user silently.
export default function OfficialModelBootstrap() {
  const { user } = useAuth()
  const { activeProfile, workspaceProfile } = useActiveOpenClawProfile()
  useRuntimeStatusStore()
  const gatewayPort = workspaceProfile?.gatewayPort || workspaceProfile?.gateway_port || null
  const gatewayReady = isGatewayConnectionReady(
    getGatewayConnectionSnapshot(activeProfile, gatewayPort),
  )
  const [status, setStatus] = useState({ state: 'idle', error: null })
  const [retrying, setRetrying] = useState(false)

  // Mirror the shared official-model status (fed by both the loop below and the
  // 401 self-heal in Conversations) into local render state.
  useEffect(() => subscribeOfficialModelStatus(setStatus), [])

  const timerRef = useRef(null)
  const attemptsRef = useRef(0)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    if (!user?.uid || !activeProfile) return undefined
    let cancelled = false
    attemptsRef.current = 0

    const attempt = async () => {
      if (cancelled) return
      attemptsRef.current += 1
      try {
        await maybeBootstrapUniopcOfficialModel({
          profile: activeProfile,
          allowGatewayRepair: gatewayReady,
        })
      } catch {
        if (cancelled) return
        const n = attemptsRef.current
        const delay =
          n < FAST_ATTEMPTS
            ? RETRY_DELAY_MS
            : Math.min(RETRY_DELAY_MS * 2 ** (n - FAST_ATTEMPTS + 1), BACKOFF_CAP_MS)
        timerRef.current = setTimeout(attempt, delay)
      }
    }

    timerRef.current = setTimeout(attempt, FIRST_ATTEMPT_DELAY_MS)

    // Transparent-refresh (Phase 2): the loopback proxy emits this when the
    // upstream 401s a live request (revoked token). Mint + hand the fresh token
    // straight to the proxy's memory (lightweight — no config.patch) so the
    // proxy, BLOCKED waiting on the new token, retries the same request and the
    // turn never dies. Single-flight, so concurrent 401s collapse into one mint.
    let unlistenRefresh = null
    listen('official-model-token-refresh-needed', () => {
      if (cancelled) return
      refreshUniopcOfficialModelToken({ profile: activeProfile }).catch(() => {
        /* proxy retry will surface the 401; Phase 1 self-heal + banner take over */
      })
    }).then(fn => {
      unlistenRefresh = fn
      if (cancelled && unlistenRefresh) unlistenRefresh()
    })

    return () => {
      cancelled = true
      clearTimer()
      if (unlistenRefresh) unlistenRefresh()
    }
  }, [user?.uid, activeProfile, gatewayReady])

  // Manual retry from the banner: force a direct reconnect. mint-llm-token is
  // device-idempotent (rotates this device's slot, doesn't append), so clicking
  // repeatedly is safe.
  const onRetry = useCallback(async () => {
    if (!activeProfile || retrying) return
    setRetrying(true)
    try {
      await connectUniopcOfficialModel({ profile: activeProfile })
    } catch {
      /* status already flipped to 'failed'; banner stays with the new error */
    } finally {
      setRetrying(false)
    }
  }, [activeProfile, retrying])

  // Only surface the banner once signed in with an active profile AND the
  // connect has actually failed — never during the normal startup window (that
  // is EngineStatusStrip's job).
  if (
    !user?.uid
    || !activeProfile
    || status.profile !== activeProfile
    || status.state !== 'failed'
    || !gatewayReady
  ) return null

  return (
    <div className="fixed inset-x-4 top-12 z-[90] mx-auto max-w-2xl flex items-center justify-between gap-3 rounded-lg border border-amber-300/70 bg-amber-50 px-3.5 py-2 text-xs text-amber-900">
      <span className="min-w-0 truncate">
        Uniopc 官方模型未接入{status.error ? `：${status.error}` : '，请重试'}
      </span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="shrink-0 rounded-md border border-amber-400 bg-white px-2.5 py-1 font-medium text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-60"
      >
        {retrying ? '接入中…' : '重试接入'}
      </button>
    </div>
  )
}
