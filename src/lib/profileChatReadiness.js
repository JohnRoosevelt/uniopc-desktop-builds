const FALLBACK_MODEL_LABEL = 'Uniopc 官方模型'

function readiness({ phase, loading, sendReady, failed = false, label, detail, error = null }) {
  return {
    phase,
    loading,
    sendReady,
    failed,
    label: label || FALLBACK_MODEL_LABEL,
    detail,
    error,
  }
}

/**
 * Derive the single, user-visible readiness chain for a profile conversation.
 *
 * Gateway availability is necessary but not sufficient: the profile's Uniopc
 * official model must also be connected before a message can be sent. Keeping
 * this as a pure function makes every surface narrate the same state.
 */
export function deriveProfileChatReadiness({
  activeProfile,
  gatewayReady,
  officialModelState,
  officialModelProfile,
  officialModelError = null,
  modelLabel = FALLBACK_MODEL_LABEL,
} = {}) {
  const label = modelLabel || FALLBACK_MODEL_LABEL

  if (!activeProfile) {
    return readiness({
      phase: 'profile_pending',
      loading: true,
      sendReady: false,
      label,
      detail: '正在确认 Uniopc 引擎 Profile',
    })
  }

  if (!gatewayReady) {
    return readiness({
      phase: 'gateway_starting',
      loading: true,
      sendReady: false,
      label,
      detail: '正在启动 Uniopc 引擎',
    })
  }

  const modelMatchesProfile = officialModelProfile === activeProfile

  if (modelMatchesProfile && officialModelState === 'failed') {
    return readiness({
      phase: 'failed',
      loading: false,
      sendReady: false,
      failed: true,
      label,
      detail: 'Uniopc 官方模型连接失败',
      error: officialModelError,
    })
  }

  if (modelMatchesProfile && officialModelState === 'connected') {
    return readiness({
      phase: 'ready',
      loading: false,
      sendReady: true,
      label,
      detail: '可用',
    })
  }

  return readiness({
    phase: 'official_model_connecting',
    loading: true,
    sendReady: false,
    label,
    detail: '正在连接 Uniopc 官方模型',
  })
}
