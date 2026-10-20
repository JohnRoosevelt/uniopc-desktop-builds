import { invoke } from '@tauri-apps/api/core'
import { supabase } from './supabase'
import {
  dynamicCloudAgentFunctionPath,
  isDynamicCloudAgentPluginId,
  replaceCloudAgentPluginCatalog,
} from './cloudAgentPluginCatalogRegistry.js'
import { pluginRuntimeApiBaseEnvKey } from './pluginsRuntimeRouting.js'

export { replaceCloudAgentPluginCatalog } from './cloudAgentPluginCatalogRegistry.js'
export {
  beginCloudAgentCatalogRequest,
  commitCloudAgentCatalogRequest,
  invalidateCloudAgentCatalogRequests,
} from './cloudAgentPluginCatalogRegistry.js'

// 历史内置插件的静态登记(保底)。新增云插件不需要加进来:catalog 行的
// metadata.function_path 会通过 replaceCloudAgentPluginCatalog() 动态登记
// (见 cloudWorkspace.js 的 preset 构建),桌面因此零改动。
export const CLOUD_AGENT_PLUGIN_IDS = [
  'uniopc-cloud-workspace',
  'uniopc-socials',
  'uniopc-private-conversion',
  'uniopc-superip',
  // uniopc-wechat-mp 于 0.2.0 退出平台托管:凭据改由用户自持、请求本机直发微信,
  // 云函数已删除。留在这里会让它继续被铸 host credential 并把请求指向不存在的
  // /functions/v1/wechat-mp,而且永远弹不出 api-key 表单(静态表优先级高于
  // catalog 动态登记)。
]

const CLOUD_AGENT_PLUGIN_ID_SET = new Set(CLOUD_AGENT_PLUGIN_IDS)
const HOST_CREDENTIAL_STORAGE_PREFIX = 'IMAI_CLOUD_AGENT_HOST_CREDENTIAL'

const CLOUD_AGENT_RUNTIME_PLUGIN_ID_BY_APP_ID = new Map([
  ['uniopc-socials', 'uniopc-socials'],
  ['uniopc-private-conversion', 'uniopc-private-conversion'],
])

const CLOUD_AGENT_ISSUER_PLUGIN_ID_BY_RUNTIME_ID = new Map([
  ['uniopc-socials', 'uniopc-socials'],
  ['uniopc-private-conversion', 'uniopc-private-conversion'],
])

export function cloudAgentRuntimePluginId(pluginId) {
  const id = String(pluginId || '').trim()
  return CLOUD_AGENT_RUNTIME_PLUGIN_ID_BY_APP_ID.get(id) || id
}

function cloudAgentIssuerPluginId(pluginId) {
  const id = String(pluginId || '').trim()
  return CLOUD_AGENT_ISSUER_PLUGIN_ID_BY_RUNTIME_ID.get(id) || id
}

function pluginFunctionPath(pluginId) {
  const id = cloudAgentRuntimePluginId(pluginId)
  const dynamic = dynamicCloudAgentFunctionPath(id)
  if (dynamic) return dynamic
  if (id === 'uniopc-socials') return 'socials'
  if (id === 'uniopc-private-conversion') return 'private-conversion'
  if (id === 'uniopc-superip') return 'super-ip'
  if (id === 'uniopc-cloud-workspace') return 'uniopc-cloud-workspace'
  return ''
}

export function cloudAgentApiUrl(pluginId, env = import.meta.env || {}) {
  const id = cloudAgentRuntimePluginId(pluginId)
  const baseUrl = String(env[pluginRuntimeApiBaseEnvKey(id)] || '').trim().replace(/\/+$/, '')
  const functionPath = pluginFunctionPath(id)
  return baseUrl && functionPath ? `${baseUrl}/functions/v1/${functionPath}` : ''
}

export function issueRuntimeTokenUrl(env = import.meta.env || {}) {
  const baseUrl = String(env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '')
  return baseUrl ? `${baseUrl}/functions/v1/issue-agent-runtime-token` : ''
}

export function isCloudAgentPluginId(pluginId) {
  const id = String(pluginId || '').trim()
  return CLOUD_AGENT_PLUGIN_ID_SET.has(id) || isDynamicCloudAgentPluginId(id)
}

export function isCloudAgentRuntimeIssuerUnavailableError(error) {
  const message = String(error?.message || error || '')
  return message.includes('issue-agent-runtime-token')
    || message.includes('Cloud Agent Host Credential 签发服务')
    || message.includes('host credential request failed: 404')
}

export function isCloudAgentHostCredentialAlreadyExistsError(error) {
  const message = String(error?.message || error || '')
  return message.includes('host_credential_already_exists')
    || message.includes('Host Credential 已存在')
}

export function isCloudAgentHostCredentialResetRequiredError(error) {
  const message = String(error?.message || error || '')
  return isCloudAgentHostCredentialAlreadyExistsError(error)
    || message.includes('invalid_host_credential')
    || message.includes('Host Credential 已失效')
}

function hostCredentialStorageKey(profile, pluginId) {
  const value = String(profile || '').trim()
  const plugin = String(pluginId || '').trim()
  if (!value) throw new Error('缺少 Uniopc 引擎 Profile，无法读取 Cloud Agent Host Credential。')
  if (!plugin) throw new Error('缺少插件 ID，无法读取 Cloud Agent Host Credential。')
  return `${HOST_CREDENTIAL_STORAGE_PREFIX}:${value}:${plugin}`
}

function readHostCredential(profile, pluginId) {
  if (typeof window === 'undefined' || !window.localStorage) return ''
  try {
    return window.localStorage.getItem(hostCredentialStorageKey(profile, pluginId)) || ''
  } catch {
    return ''
  }
}

function persistHostCredential(profile, pluginId, hostCredential) {
  if (!hostCredential || typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(hostCredentialStorageKey(profile, pluginId), hostCredential)
  } catch {
    // Local persistence failures should surface on the next refresh attempt.
  }
}

function removeHostCredential(profile, pluginId) {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.removeItem(hostCredentialStorageKey(profile, pluginId))
  } catch {
    // A failed cache cleanup should not block a cloud reset attempt.
  }
}

async function currentSupabaseAccessToken() {
  const { data } = await supabase.auth.getSession()
  let token = data?.session?.access_token || ''
  if (!token) return ''

  const { data: userData, error: userError } = await supabase.auth.getUser(token)
  if (!userError && userData?.user) return token

  const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession()
  token = refreshed?.session?.access_token || ''
  if (!refreshError && token) return token
  throw new Error('登录状态已过期，请重新登录后再启用插件。')
}

export async function currentCloudAgentRuntimeAuthEnv({
  profile,
  agentId,
  pluginIds = CLOUD_AGENT_PLUGIN_IDS,
  resetHostCredential = false,
  replaceExistingHostCredential = false,
} = {}) {
  const normalizedProfile = String(profile || '').trim()
  if (!normalizedProfile) throw new Error('缺少 Uniopc 引擎 Profile，无法为 Cloud Agent 插件签发 Host Credential。')
  const runtimePluginId = cloudAgentRuntimePluginId((Array.isArray(pluginIds) ? pluginIds[0] : pluginIds) || '')
  const issuerPluginId = cloudAgentIssuerPluginId(runtimePluginId)
  const requiredKey = pluginRuntimeApiBaseEnvKey(runtimePluginId)
  const runtimeEnv = import.meta.env || {}
  if (!String(runtimeEnv[requiredKey] || '').trim()) {
    throw new Error(`缺少 ${requiredKey}，无法生成 Cloud Agent API URL。`)
  }
  if (!pluginFunctionPath(runtimePluginId)) {
    throw new Error(`插件 ${runtimePluginId} 缺少 function_path；请刷新应用中心目录后重试。`)
  }
  const apiUrl = cloudAgentApiUrl(runtimePluginId)
  if (!apiUrl) throw new Error(`无法生成插件 ${runtimePluginId} 的 Cloud Agent API URL。`)
  const issueUrl = issueRuntimeTokenUrl()
  if (!issueUrl) throw new Error('缺少 VITE_SUPABASE_URL，无法签发 Cloud Agent Host Credential。')
  if (!runtimePluginId) throw new Error('缺少插件 ID，无法签发 Cloud Agent Host Credential。')
  const hostCredential = resetHostCredential ? '' : readHostCredential(normalizedProfile, runtimePluginId)

  async function requestCredential({ forceReset = false, cachedHostCredential = '' } = {}) {
    let accessToken = ''
    if (cachedHostCredential && !forceReset) {
      accessToken = ''
    } else {
      accessToken = await currentSupabaseAccessToken()
      if (!accessToken) throw new Error('请先登录，才能为 Cloud Agent 插件注册 Host Credential。')
    }
    try {
      // Credential issuance is security-sensitive and must also bypass ambient
      // proxy/VPN routes. The bounded Rust command pins the target to a compiled
      // Supabase origin and uses a direct reqwest client.
      const result = await invoke('trusted_host_credential_issue', {
        input: {
          serviceOrigin: new URL(issueUrl).origin,
          accessToken,
          hostCredential: cachedHostCredential,
          profile: normalizedProfile,
          pluginId: issuerPluginId,
          agentId,
          resetHostCredential: forceReset,
        },
      })
      const status = Number(result?.status || 0)
      const response = { status, ok: status >= 200 && status < 300 }
      const payload = result?.payload || {}
      return { response, payload }
    } catch (error) {
      if (error?.code === 'trusted_service_timeout') {
        throw new Error(`Cloud Agent Host Credential 签发超时，请检查 Supabase Edge Function issue-agent-runtime-token 是否可用。`)
      }
      throw new Error('无法访问 Cloud Agent Host Credential 签发服务；请先部署 Supabase Edge Function issue-agent-runtime-token，并确认当前网络可用。')
    }
  }

  let { response, payload } = await requestCredential({
    forceReset: resetHostCredential,
    cachedHostCredential: hostCredential,
  })
  const shouldReplaceExisting = replaceExistingHostCredential || resetHostCredential
  const credentialMismatch = hostCredential && (
    response.status === 401 ||
    payload?.code === 'invalid_host_credential'
  )
  if (
    (!response.ok || !payload?.hostCredential) &&
    shouldReplaceExisting &&
    !resetHostCredential &&
    (payload?.code === 'host_credential_already_exists' || credentialMismatch)
  ) {
    if (credentialMismatch) removeHostCredential(normalizedProfile, runtimePluginId)
    ;({ response, payload } = await requestCredential({ forceReset: true }))
  }

  if (!response.ok || !payload?.hostCredential) {
    if (response.status === 401 && payload?.code === 'invalid_authorization') {
      throw new Error('登录状态已过期，请重新登录后再重试插件授权。')
    }
    if (response.status === 401 && payload?.code === 'missing_authorization') {
      throw new Error('请先登录，才能重试插件授权。')
    }
    if (hostCredential && (response.status === 401 || payload?.code === 'invalid_host_credential')) {
      throw new Error('Host Credential 已失效或不属于当前 Profile/插件。为避免自动轮换导致 Host 与云端不一致，请使用显式重置流程重新生成并写入 Uniopc 引擎。')
    }
    if (payload?.code === 'host_credential_already_exists') {
      throw new Error('Host Credential 已存在。为避免覆盖长期凭证，Uniopc 不会自动重新签发；请使用当前 Host 中保存的凭证，或走显式重置流程。')
    }
    if (response.status >= 500) {
      throw new Error(`Cloud Agent Host Credential 签发服务暂时不可用：issue-agent-runtime-token 返回 ${response.status}。请稍后重试或检查 Supabase Edge Function 日志。`)
    }
    throw new Error(String(payload?.error || payload?.code || `host credential request failed: ${response.status}`))
  }
  persistHostCredential(normalizedProfile, runtimePluginId, payload.hostCredential)

  return {
    cloudAgentApiUrl: apiUrl,
    cloudAgentHostCredential: payload.hostCredential,
  }
}

export async function optionalCloudAgentRuntimeAuthEnv(input = {}) {
  try {
    return await currentCloudAgentRuntimeAuthEnv(input)
  } catch {
    return {}
  }
}

export async function cloudWorkspacePluginSetRequest(profile) {
  return {
    profile,
    pluginId: 'uniopc-cloud-workspace',
    enabled: true,
    ...await currentCloudAgentRuntimeAuthEnv({
      profile,
      pluginIds: ['uniopc-cloud-workspace'],
    }),
  }
}
