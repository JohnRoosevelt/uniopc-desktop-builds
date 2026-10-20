function text(value) {
  return String(value == null ? '' : value).trim()
}

function runtimeEnv() {
  return import.meta.env || {}
}

export function uniopcAuthConfig(env = runtimeEnv()) {
  const serverBaseUrl = text(env.VITE_SUPABASE_URL).replace(/\/+$/, '')
  const serverBaseAnonKey = text(env.VITE_SUPABASE_ANON_KEY)
  if (!serverBaseUrl || !serverBaseAnonKey) throw new Error('缺少 UniOPC Server Base 登录配置。')
  return { serverBaseUrl, serverBaseAnonKey }
}

export function uniopcAuthUrl(config = uniopcAuthConfig()) {
  return `${config.serverBaseUrl}/functions/v1/auth`
}

export function uniopcAuthHeaders(userToken, config = uniopcAuthConfig()) {
  const token = text(userToken).replace(/^Bearer\s+/i, '')
  if (!token) throw new Error('请先登录后再读取 UniOPC 身份权限。')
  return {
    apikey: config.serverBaseAnonKey,
    Authorization: `Bearer ${config.serverBaseAnonKey}`,
    'Content-Type': 'application/json',
    u_token: token,
  }
}

async function currentAccessToken(client) {
  const { data } = await client.auth.getSession()
  const token = text(data?.session?.access_token)
  if (!token) throw new Error('请先登录后再读取 UniOPC 身份权限。')
  return token
}

async function defaultDependencies() {
  return await import('./supabase.js')
}

export async function callUniopcAuthAction(action, payload = {}, options = {}) {
  const dependencies = options.client && options.request ? null : await defaultDependencies()
  const client = options.client || dependencies.supabase
  const config = options.config || uniopcAuthConfig()
  const request = options.request || dependencies.directFetch
  const response = await request(uniopcAuthUrl(config), {
    method: 'POST',
    headers: uniopcAuthHeaders(await currentAccessToken(client), config),
    body: JSON.stringify({ action, payload }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.error) {
    throw new Error(text(data?.error || data?.message || data?.msg) || `Auth 服务返回 ${response.status}`)
  }
  return data || {}
}
