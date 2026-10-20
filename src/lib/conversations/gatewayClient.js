import { isGatewayConnectionReady } from '../runtimeStatus'

export const GATEWAY_CLIENT_CAPABILITIES = {
  transport: 'gateway_websocket',
  implemented: true,
  methods: ['chat.history', 'chat.send', 'chat.abort', 'chat.inject'],
  summary: 'Uniopc 通过 Tauri Rust Gateway bridge 使用 Uniopc 引擎 WebSocket，对话 UI 不直接暴露 Gateway secret。',
}

export function getGatewayClientReadiness(openClawStatus = null, connectionSnapshot = null) {
  const gatewayInstalled = Boolean(openClawStatus?.installed)
  const gatewayRunning = isGatewayConnectionReady(connectionSnapshot)

  return {
    ...GATEWAY_CLIENT_CAPABILITIES,
    gatewayInstalled,
    gatewayRunning,
    connectionReady: gatewayInstalled && gatewayRunning,
    implementationReady: GATEWAY_CLIENT_CAPABILITIES.implemented,
  }
}
