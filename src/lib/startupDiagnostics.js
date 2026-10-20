const ALLOWED_STAGES = new Set([
  'gateway_startup',
  'gateway_first_probe',
  'gateway_preflight',
  'gateway_readiness_wait',
  'gateway_spawn',
  'profile_provision',
  'runtime_preparation',
])

export function buildStartupFailureReport({
  startupMetrics,
  startupEvents,
  appVersion = 'unknown',
  platform = '',
  submissionMode = 'authenticated',
  loginFailure = '',
}) {
  const recentMetric = Array.isArray(startupMetrics) ? startupMetrics.at(-1) : null
  const rawEvents = String(startupEvents?.content || '').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
  const latestStartIndex = rawEvents.map(event => event.phase).lastIndexOf('startup_requested')
  const attemptEvents = rawEvents.slice(Math.max(0, latestStartIndex))
  const finished = [...attemptEvents].reverse().find(event => event.phase === 'startup_finished')
  const attemptStartedAt = new Date(attemptEvents.find(event => event.phase === 'startup_requested')?.recordedAt || '')
  const metricRecordedAt = new Date(recentMetric?.recordedAt || '')
  const metricMatchesAttempt = !Number.isFinite(attemptStartedAt.getTime())
    || (Number.isFinite(metricRecordedAt.getTime()) && metricRecordedAt.getTime() >= attemptStartedAt.getTime() - 1_000)
  const currentMetric = metricMatchesAttempt ? recentMetric : null
  const failureText = String(currentMetric?.failure || (finished?.outcome === 'failed' ? finished.detail : '') || '')
  const hasStartupFailure = Boolean(failureText || finished?.outcome === 'failed')
  if (!hasStartupFailure && !loginFailure) return null

  if (!hasStartupFailure) {
    return {
      clientReportId: crypto.randomUUID(),
      appVersion,
      operatingSystem: /win/i.test(platform) ? 'windows'
        : /mac/i.test(platform) ? 'macos'
          : /linux/i.test(platform) ? 'linux' : 'unknown',
      failureStage: 'login',
      failureCategory: /network|timeout|connection|fetch|offline/i.test(loginFailure)
        ? 'login_network_failed' : 'login_failed',
      durationMs: 0,
      events: [],
      consentedAt: new Date().toISOString(),
      submissionMode,
    }
  }

  const failedEvent = [...attemptEvents].reverse().find(event => event.outcome === 'failed' && event.phase !== 'startup_finished')
  const requestedStage = String(failedEvent?.phase || 'gateway_startup').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64)
  const failureStage = ALLOWED_STAGES.has(requestedStage) ? requestedStage : 'gateway_startup'
  const failureCategory = /10061|connection refused|actively refused/i.test(failureText)
    ? 'connection_refused'
    : /timed?\s*out|timeout/i.test(failureText)
      ? 'timeout'
      : /runtime|node|provision/i.test(`${failureStage} ${failureText}`)
        ? 'runtime_prepare_failed'
        : /spawn|child process/i.test(`${failureStage} ${failureText}`)
          ? 'gateway_spawn_failed'
          : 'startup_failed'
  const events = attemptEvents.slice(-60).map(event => ({
    recordedAt: event.recordedAt,
    phase: String(event.phase || '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64),
    outcome: ['connected', 'success', 'ready', 'spawned', 'completed'].includes(event.outcome)
      ? 'success'
      : event.outcome === 'failed' ? 'failed' : 'warning',
    elapsedMs: Math.min(900_000, Math.max(0, Number(event.elapsedMs) || 0)),
  }))
  return {
    clientReportId: crypto.randomUUID(),
    appVersion,
    operatingSystem: /win/i.test(platform) ? 'windows'
      : /mac/i.test(platform) ? 'macos'
        : /linux/i.test(platform) ? 'linux' : 'unknown',
    failureStage,
    failureCategory,
    durationMs: Math.min(900_000, Math.max(0, Number(currentMetric?.totalMs) || Number(finished?.elapsedMs) || 0)),
    events,
    consentedAt: new Date().toISOString(),
    submissionMode,
  }
}
