// Structured gateway error codes — the JS mirror of
// `GatewayConnectionSnapshot.lastErrorCode`, classified in one place on the
// Rust side (`classify_gateway_connection_error` in
// src-tauri/src/services/openclaw_connection.rs). Branch on these codes, never
// on `lastError` / `message` text.

// Gateway rejected our token outright. Remote credentials need user action;
// local credentials are app-owned and are repaired by start_local.
export const GATEWAY_AUTH_TOKEN_MISMATCH = 'auth_token_mismatch'
// Token or device identity missing — repairable: start_local re-provisions.
export const GATEWAY_AUTH_TOKEN_MISSING = 'auth_token_missing'
// Bare unauthorized with no more specific cause.
export const GATEWAY_AUTH_UNAUTHORIZED = 'auth_unauthorized'
export const GATEWAY_MODEL_CREDENTIALS_UNAVAILABLE = 'MODEL_AUTH_OR_BILLING'

// Codes where a REMOTE gateway cannot be repaired automatically. Local gateway
// auth is single-writer/app-owned, so start_local can reclaim an orphan process,
// clear stale auth config, and re-provision all of these states.
export const GATEWAY_AUTH_BLOCK_CODES = new Set([
  GATEWAY_AUTH_TOKEN_MISMATCH,
  GATEWAY_AUTH_UNAUTHORIZED,
])

// True when a gateway connection snapshot carries an auth error that blocks
// automatic recovery.
export function isGatewayAuthBlockedSnapshot(snapshot) {
  if (snapshot?.mode === 'local') return false
  return GATEWAY_AUTH_BLOCK_CODES.has(snapshot?.lastErrorCode)
}

const GATEWAY_STREAM_RECOVERY_MESSAGES = Object.freeze({
  retry: '连接暂时不可用，请稍后重试。',
  pairDevice: '当前设备需要重新授权，请完成授权后再试。',
  reviewPermissions: '连接授权已失效，请重新授权后再试。',
  reviewRequest: '请求未被接受，请检查后重试。',
  selectModel: '当前模型凭据暂不可用（认证或计费异常）。请切换模型，或稍后再试。',
  upgradeRuntime: '当前版本暂不兼容，请更新应用后再试。',
  // GATEWAY_ERROR also covers provider/model failures whose raw details are
  // deliberately removed at the Rust boundary. Calling every such failure a
  // connection outage is misleading (for example, an exhausted model quota).
  openRuntime: 'AI 服务本轮未能完成，请检查模型状态或引擎日志后重试。',
})

export function gatewayStreamErrorMessage(error) {
  const recoveryAction = typeof error?.recoveryAction === 'string' ? error.recoveryAction : ''
  return GATEWAY_STREAM_RECOVERY_MESSAGES[recoveryAction] || '对话已停止，请稍后重试。'
}

export function isGatewayModelCredentialsUnavailable(error) {
  if (error?.code === GATEWAY_MODEL_CREDENTIALS_UNAVAILABLE
    && error?.recoveryAction === 'selectModel') return true
  // Conversation state stores the white-label message, not the raw Gateway
  // error object. This is safe to recognize because it is our own fixed copy.
  return String(error || '').includes('当前模型凭据暂不可用（认证或计费异常）')
}

export function shouldRecoverGatewayAuth(error) {
  return error?.recoveryAction === 'reviewPermissions'
    && ['UNAUTHORIZED', 'AUTH_TOKEN_MISMATCH'].includes(error?.code)
}
