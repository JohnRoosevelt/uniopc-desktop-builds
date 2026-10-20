import { isGatewayAuthBlockedSnapshot } from './gatewayErrors.js'

export const LOCAL_ASSISTANT_LAUNCH_PATH = '/launching/local-assistant'

export function localAssistantLaunchSteps({ status, gatewayReady, startupError }) {
  const runtimeReady = Boolean(status?.installed && status?.supported !== false)
  const state = ready => ready ? 'done' : startupError ? 'failed' : 'active'
  return [
    { label: '检查运行环境', detail: '确认本机助手所需的运行组件', state: state(runtimeReady) },
    { label: '启动本地服务', detail: '准备工作配置与内置能力，建立本机连接',
      state: gatewayReady ? 'done' : runtimeReady ? state(false) : 'pending' },
    { label: '加载助手能力', detail: '同步你的工作台与可用能力',
      state: gatewayReady ? 'active' : 'pending' },
  ]
}

// Visiting diagnostics must never authorize another install or startup flight.
export function canAutoStartFromSetup({ diagnosticsOnly = false, startupError = null } = {}) {
  return !diagnosticsOnly && !startupError
}

export function localAssistantReturnPath(from, fallback = '/conversations') {
  const candidate = String(from || '').trim()
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback
  if (
    candidate === LOCAL_ASSISTANT_LAUNCH_PATH ||
    candidate.startsWith(`${LOCAL_ASSISTANT_LAUNCH_PATH}/`) ||
    candidate === '/login' ||
    candidate.startsWith('/setup/')
  ) return fallback
  return candidate
}

// Normal cold starts should enter the focused launch surface. This deliberately
// excludes configuration/diagnostic routes: those own their own readiness UI.
export function shouldOpenLocalAssistantLaunch({
  requiresLocalOpenClaw = false,
  ready = false,
  pathname = '',
} = {}) {
  return Boolean(
    requiresLocalOpenClaw &&
    !ready &&
    pathname !== LOCAL_ASSISTANT_LAUNCH_PATH &&
    !String(pathname).startsWith(`${LOCAL_ASSISTANT_LAUNCH_PATH}/`) &&
    !String(pathname).startsWith('/setup/'),
  )
}

// Missing/unsupported runtime and remote auth failures need the existing
// repair flow; a normal local process boot simply remains on the launch page.
export function localAssistantLaunchNeedsSetup({ status = null, connectionSnapshot = null } = {}) {
  return Boolean(
    (status && (status.installed === false || status.supported === false)) ||
    isGatewayAuthBlockedSnapshot(connectionSnapshot),
  )
}
