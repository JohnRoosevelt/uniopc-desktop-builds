// Desktop client for the plugin connector OAuth broker
// (uniopc-supabase/functions/plugin-oauth; docs/plugin-system-v2.md §4).
// The desktop only ever sees connection *status* — tokens stay cloud-side.
import { supabase } from './supabase'

const PLUGIN_OAUTH_POLL_INTERVAL_MS = 3000
const PLUGIN_OAUTH_POLL_TIMEOUT_MS = 120000

function pluginOauthUrl() {
  const baseUrl = String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
  return baseUrl ? `${baseUrl}/functions/v1/plugin-oauth` : ''
}

async function currentAccessToken() {
  const { data } = await supabase.auth.getSession()
  let token = data?.session?.access_token || ''
  if (token) return token
  const { data: refreshed } = await supabase.auth.refreshSession()
  token = refreshed?.session?.access_token || ''
  if (token) return token
  throw new Error('登录状态已过期，请重新登录后再连接账号。')
}

async function callPluginOauth(action, payload = {}) {
  const url = pluginOauthUrl()
  if (!url) throw new Error('缺少 VITE_SUPABASE_URL，无法访问插件授权服务。')
  const token = await currentAccessToken()
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: String(import.meta.env.VITE_SUPABASE_ANON_KEY || ''),
    },
    body: JSON.stringify({ action, ...payload }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const code = String(body?.error || `plugin_oauth_${response.status}`)
    if (code === 'provider_not_configured') throw new Error('该应用的授权通道尚未接入，请等待官方开通。')
    if (code === 'provider_unknown') throw new Error('未知的授权应用。')
    if (code === 'member_not_found') throw new Error('当前账号缺少组织成员身份，无法连接账号。')
    throw new Error(code)
  }
  return body || {}
}

export function startPluginConnectorOauth(pluginId, connectorId) {
  return callPluginOauth('oauth_start', { pluginId, connectorId })
}

export function pluginConnectorOauthStatus(pluginId, connectorId) {
  return callPluginOauth('status', { pluginId, connectorId })
}

export function disconnectPluginConnector(pluginId, connectorId) {
  return callPluginOauth('disconnect', { pluginId, connectorId })
}

// Poll until the browser round-trip lands (connected) or times out. Calls
// onTick(status) each round so the UI can show 授权中 progress.
export async function waitForPluginConnectorOauth(pluginId, connectorId, { onTick, timeoutMs = PLUGIN_OAUTH_POLL_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, PLUGIN_OAUTH_POLL_INTERVAL_MS))
    let status
    try {
      status = await pluginConnectorOauthStatus(pluginId, connectorId)
    } catch {
      continue
    }
    onTick?.(status)
    if (status?.status === 'connected') return status
    if (status?.status === 'error') throw new Error('授权失败，请重试。')
  }
  throw new Error('等待浏览器授权超时，请确认已在浏览器中完成授权后刷新状态。')
}
