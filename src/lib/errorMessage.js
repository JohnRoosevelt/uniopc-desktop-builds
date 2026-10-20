export function errorMessage(error, fallback = '操作失败，请稍后重试') {
  if (!error) return fallback
  if (typeof error === 'string') return error

  const directMessage =
    error.message ||
    error.errMsg ||
    error.errorMessage ||
    error.msg ||
    error.detail ||
    error.reason ||
    error.description
  const code = error.code || error.errCode || error.errorCode || error.requestId

  if (directMessage && code) return `${directMessage}（${code}）`
  if (directMessage) return directMessage

  try {
    const serialized = JSON.stringify(error)
    if (serialized && serialized !== '{}') return serialized
  } catch {
    // Fall through to String below.
  }

  const normalized = String(error)
  return normalized && normalized !== '[object Object]' ? normalized : fallback
}
