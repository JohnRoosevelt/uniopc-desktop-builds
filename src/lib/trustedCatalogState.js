export function trustedCatalogRowsForCurrentResponse(response) {
  return response?.source === 'online' && Array.isArray(response?.rows)
    ? response.rows
    : []
}

export function normalizeTrustedServiceError(error) {
  const knownCode = String(error?.code || '').trim()
  const code = [
    'trusted_service_offline',
    'trusted_service_timeout',
    'trusted_service_unavailable',
    'trusted_service_auth_required',
    'trusted_service_origin_denied',
    'trusted_service_unsafe_dns',
    'trusted_service_dns_unavailable',
    'trusted_service_redirect_denied',
    'trusted_catalog_response_too_large',
    'trusted_catalog_response_encoding_denied',
    'trusted_catalog_response_invalid',
  ].includes(knownCode) ? knownCode : 'trusted_service_unavailable'
  const messages = {
    trusted_service_offline: '当前处于离线状态。联网后可重试。',
    trusted_service_timeout: '服务响应超时，请稍后重试。',
    trusted_service_unavailable: '暂时无法连接服务，请稍后重试。',
    trusted_service_auth_required: '登录状态已失效，请重新登录后再试。',
    trusted_service_origin_denied: '当前服务地址不在可信列表中。',
    trusted_service_unsafe_dns: '服务网络地址未通过安全检查。',
    trusted_service_dns_unavailable: '暂时无法解析服务地址，请检查网络后重试。',
    trusted_service_redirect_denied: '服务返回了不允许的跳转。',
    trusted_catalog_response_too_large: '插件目录响应超过安全大小限制。',
    trusted_catalog_response_encoding_denied: '插件目录响应使用了不允许的压缩格式。',
    trusted_catalog_response_invalid: '插件目录响应格式无效。',
  }
  const retryable = [
    'trusted_service_offline',
    'trusted_service_timeout',
    'trusted_service_unavailable',
    'trusted_service_dns_unavailable',
  ].includes(code)
  const nextError = new Error(messages[code])
  nextError.code = code
  nextError.retryable = retryable
  return nextError
}
