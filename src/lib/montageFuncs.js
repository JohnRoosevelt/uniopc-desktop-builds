/**
 * Desktop-native Smart Montage client.
 *
 * This talks to uniopc-funcs directly: copywriting owns scripts and
 * video-clips owns planning, rendering, progress, and caption revisions.
 * Media files remain in the generic media service; this module deliberately
 * has no dependency on the retired montage Edge Function or local plugin.
 */
import { directFetch, supabase } from './supabase'
import { freshAccessToken } from './voiceTranscription'

const text = value => String(value == null ? '' : value).trim()
const trimSlash = value => text(value).replace(/\/+$/, '')
const bearerToken = value => text(value).replace(/^Bearer\s+/i, '')

function errorFromResponse(response, data, label) {
  const source = data?.error && typeof data.error === 'object' ? data.error : data || {}
  const error = new Error(text(source.message || source.error || source.code) || `${label} 请求失败（HTTP ${response.status}）`)
  error.status = response.status
  error.code = text(source.code || data?.code)
  error.retryable = source.retryable === true || data?.retryable === true
  return error
}

export function montageFuncsConfig(env = import.meta.env || {}) {
  const copywritingUrl = trimSlash(env.VITE_COPYWRITING_API_URL)
  const videoClipsUrl = trimSlash(env.VITE_VIDEO_CLIPS_API_URL)
  const copywritingBearerToken = bearerToken(env.VITE_COPYWRITING_BEARER_TOKEN)
  const videoClipsBearerToken = bearerToken(env.VITE_VIDEO_CLIPS_BEARER_TOKEN)
  if (!copywritingUrl) throw new Error('缺少 VITE_COPYWRITING_API_URL，无法生成混剪文案。')
  if (!videoClipsUrl) throw new Error('缺少 VITE_VIDEO_CLIPS_API_URL，无法制作混剪视频。')
  if (!copywritingBearerToken) throw new Error('缺少 VITE_COPYWRITING_BEARER_TOKEN，无法通过文案服务网关认证。')
  if (!videoClipsBearerToken) throw new Error('缺少 VITE_VIDEO_CLIPS_BEARER_TOKEN，无法通过视频服务网关认证。')
  return { copywritingUrl, videoClipsUrl, copywritingBearerToken, videoClipsBearerToken }
}

async function userToken({ refresh = false } = {}) {
  // Match the mini-program: renew an about-to-expire user session before the
  // video service validates it through operator_get_access. A 401 still forces
  // one unconditional refresh below, so stale persisted sessions also recover.
  if (!refresh) return await freshAccessToken(supabase, 60)

  const result = await supabase.auth.refreshSession()
  const token = text(result?.data?.session?.access_token)
  if (!token) throw new Error(refresh ? '登录状态已过期，请重新登录后再试。' : '请先登录后使用智能混剪。')
  return token
}

async function request(url, { method = 'GET', body, label, headers = {} }) {
  const send = async token => directFetch(url, {
    method,
    headers: {
      u_token: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  let response = await send(await userToken())
  if (response.status === 401) response = await send(await userToken({ refresh: true }))
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.error) throw errorFromResponse(response, data, label)
  return data || {}
}

export function createMontageFuncsClient(config = montageFuncsConfig()) {
  const copywriting = (path, options = {}) => request(`${config.copywritingUrl}${path}`, {
    ...options,
    label: '文案服务',
    headers: { Authorization: `Bearer ${config.copywritingBearerToken}`, ...options.headers },
  })
  const videoClips = (path, options = {}) => request(`${config.videoClipsUrl}${path}`, {
    ...options,
    label: '视频制作服务',
    headers: { Authorization: `Bearer ${config.videoClipsBearerToken}`, ...options.headers },
  })
  return {
    generateScript(input) {
      return copywriting('/api/v1/copywriting/generate', { method: 'POST', body: input })
    },
    listCopywritingSkills() {
      return copywriting('/api/v1/skills')
    },
    planMontage(input) {
      return videoClips('/montage/plan', { method: 'POST', body: input })
    },
    listVoices() {
      return videoClips('/minimax/voices')
    },
    createJob(input, idempotencyKey) {
      return videoClips('/jobs', {
        method: 'POST',
        body: input,
        headers: text(idempotencyKey) ? { 'Idempotency-Key': text(idempotencyKey) } : {},
      })
    },
    listJobs(options = {}) {
      const query = new URLSearchParams({ limit: String(Math.min(50, Math.max(1, Number(options.limit) || 30))) })
      if (text(options.type)) query.set('type', text(options.type))
      if (text(options.status)) query.set('status', text(options.status))
      if (text(options.cursor)) query.set('cursor', text(options.cursor))
      return videoClips(`/jobs?${query.toString()}`)
    },
    getJob(jobId) {
      return videoClips(`/jobs/${encodeURIComponent(text(jobId))}`)
    },
    retryJob(jobId, acknowledgeBillingRisk = false) {
      return videoClips(`/jobs/${encodeURIComponent(text(jobId))}/retry`, { method: 'POST', body: { acknowledgeBillingRisk } })
    },
    refreshJob(jobId) {
      return videoClips(`/jobs/${encodeURIComponent(text(jobId))}/refresh`, { method: 'POST' })
    },
    cancelJob(jobId) {
      return videoClips(`/jobs/${encodeURIComponent(text(jobId))}/cancel`, { method: 'POST' })
    },
  }
}

export function smartMontageFuncs() {
  return createMontageFuncsClient()
}
