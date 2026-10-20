import { connectToBridge } from './e2e-tauri.mjs'
import { createAuthenticatedAdminApi as createControlAdapter } from './release-validation-control-adapter.mjs'

function requiredText(value) {
  const text = String(value || '').trim()
  if (!text || /[\r\n\0]/.test(text)) throw new Error('release_validation_operator_bridge_invalid')
  return text
}

function explicitBridgeConfiguration(environment) {
  const host = requiredText(environment?.UNIOPC_RELEASE_VALIDATION_TAURI_BRIDGE_HOST)
  const portText = requiredText(environment?.UNIOPC_RELEASE_VALIDATION_TAURI_BRIDGE_PORT)
  const basePort = Number(portText)
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isSafeInteger(basePort) || basePort < 1 || basePort > 65535) {
    throw new Error('release_validation_operator_bridge_invalid')
  }
  return { host, basePort }
}

// This adapter is intentionally inert until an operator explicitly supplies
// both loopback bridge coordinates and the separately controlled Edge token.
// It neither starts a desktop process nor scans a port range.
export async function createAuthenticatedAdminApi({
  environment = process.env,
  fetchFn = globalThis.fetch,
  connectToBridgeFn = connectToBridge,
} = {}) {
  const { host, basePort } = explicitBridgeConfiguration(environment)
  if (typeof connectToBridgeFn !== 'function') throw new Error('release_validation_operator_bridge_invalid')
  const logger = { write: async () => {} }
  const bridge = await connectToBridgeFn({ host, basePort, scanCount: 1, timeoutMs: 30_000, logger })
  if (!bridge || typeof bridge.invoke !== 'function' || typeof bridge.close !== 'function') {
    try { bridge?.close?.() } catch {}
    throw new Error('release_validation_operator_bridge_invalid')
  }
  try {
    const adapter = await createControlAdapter({ environment, fetchFn, invoke: bridge.invoke.bind(bridge) })
    return { ...adapter, close: async () => bridge.close() }
  } catch (error) {
    try { bridge.close() } catch {}
    throw error
  }
}
