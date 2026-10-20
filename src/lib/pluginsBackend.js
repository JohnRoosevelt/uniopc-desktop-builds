function text(value) {
  return String(value == null ? '' : value).trim()
}

function runtimeEnv() {
  return import.meta.env || {}
}

function responseError(response, data, label) {
  const message = text(data?.error || data?.message || data?.msg) || `${label} 返回 ${response.status}`
  const error = new Error(message)
  error.status = response.status
  error.code = text(data?.code)
  return error
}

async function responseData(response, label) {
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.error) throw responseError(response, data, label)
  return data || {}
}

export function pluginsConfig(env = runtimeEnv()) {
  const pluginsUrl = text(env.VITE_PLUGINS_SUPABASE_URL).replace(/\/+$/, '')
  const pluginsAnonKey = text(env.VITE_PLUGINS_SUPABASE_ANON_KEY)
  if (!pluginsUrl) throw new Error('缺少 VITE_PLUGINS_SUPABASE_URL，无法访问私域 Plugins 服务。')
  if (!pluginsAnonKey) throw new Error('缺少 VITE_PLUGINS_SUPABASE_ANON_KEY，无法访问私域 Plugins 服务。')
  return { pluginsUrl, pluginsAnonKey }
}

export function pluginsFunctionUrl(name, config = pluginsConfig()) {
  const functionName = text(name)
  if (!functionName) throw new Error('Plugins Edge Function 名称不能为空。')
  return `${config.pluginsUrl}/functions/v1/${encodeURIComponent(functionName)}`
}

export function pluginsRequestHeaders(userToken, config = pluginsConfig()) {
  const token = text(userToken).replace(/^Bearer\s+/i, '')
  if (!token) throw new Error('请先登录后再使用私域服务。')
  return {
    apikey: config.pluginsAnonKey,
    Authorization: `Bearer ${config.pluginsAnonKey}`,
    'Content-Type': 'application/json',
    u_token: token,
  }
}

async function currentAccessToken(client) {
  const { data } = await client.auth.getSession()
  const token = text(data?.session?.access_token)
  if (!token) throw new Error('请先登录后再使用私域服务。')
  return token
}

async function refreshedAccessToken(client) {
  const { data, error } = await client.auth.refreshSession()
  const token = text(data?.session?.access_token)
  if (error || !token) throw new Error('登录状态已过期，请重新登录后再试。')
  return token
}

async function defaultDependencies() {
  return await import('./supabase.js')
}

export async function callPluginsFunction(name, body = {}, options = {}) {
  const dependencies = options.client && options.request ? null : await defaultDependencies()
  const client = options.client || dependencies.supabase
  const config = options.config || pluginsConfig()
  const request = options.request || dependencies.directFetch
  const url = pluginsFunctionUrl(name, config)
  const send = async (token) => request(url, {
    method: 'POST',
    headers: pluginsRequestHeaders(token, config),
    body: JSON.stringify(body),
  })

  let response = await send(await currentAccessToken(client))
  if (response.status === 401) response = await send(await refreshedAccessToken(client))
  return responseData(response, `${text(name) || 'Plugins'} 服务`)
}
