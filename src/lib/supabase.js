import { createClient } from '@supabase/supabase-js'
import { invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { normalizeTrustedServiceError } from './trustedCatalogState'
import { desktopAuthStorage } from './authSessionStorage'

export {
  normalizeTrustedServiceError,
  trustedCatalogRowsForCurrentResponse,
} from './trustedCatalogState'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // Keep this explicit so overseas builds fail with a useful setup error.
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
}

// JavaScript supplies request intent only. Proxy/direct/TUN selection belongs
// to the trusted Rust HTTP boundary and must never be inferred from a hostname
// or an environment flag in React code.
export const supabaseFetch = tauriFetch

// Kept as a compatibility name for existing upload callers. It intentionally
// adds no proxy or special-address exception for arbitrary cross-host URLs.
export function directFetch(input, init = {}) {
  return tauriFetch(input, init)
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: desktopAuthStorage(),
  },
  global: {
    fetch: supabaseFetch,
  },
})

export async function fetchTrustedPluginCatalog() {
  const { data: sessionData } = await supabase.auth.getSession()
  const accessToken = sessionData.session?.access_token
  if (!accessToken) throw new Error('请先登录')
  return invoke('trusted_plugin_catalog_fetch', {
    serviceOrigin: new URL(supabaseUrl).origin,
    accessToken,
    anonKey: supabaseAnonKey,
    offline: typeof navigator !== 'undefined' && navigator.onLine === false,
  })
}

export async function callSupabaseFunction(name, body = {}) {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) throw new Error('请先登录')

  let response
  try {
    response = await supabaseFetch(`${supabaseUrl.replace(/\/+$/, '')}/functions/v1/${name}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
        'Content-Type': 'application/json',
      },
    })
  } catch (error) {
    throw normalizeTrustedServiceError(error)
  }

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const nextError = new Error(data?.error || data?.message || `${name} 返回 ${response.status}`)
    nextError.code = data?.code || null
    nextError.quota = data?.quota || null
    throw nextError
  }
  if (data?.error) {
    const nextError = new Error(data.error)
    nextError.code = data.code
    nextError.quota = data.quota || null
    throw nextError
  }
  return data
}

export async function callSupabaseFunctionViaClient(name, body = {}) {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) throw new Error('请先登录')

  const { data, error } = await supabase.functions.invoke(name, {
    body,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  if (error) {
    const functionError = await normalizeFunctionError(error)
    throw functionError
  }
  if (data?.error) {
    const nextError = new Error(data.error)
    nextError.code = data.code
    nextError.quota = data.quota || null
    throw nextError
  }
  return data
}

async function normalizeFunctionError(error) {
  const payload = await readFunctionErrorContext(error)
  if (!payload?.error) return error

  const nextError = new Error(payload.error)
  nextError.code = payload.code
  nextError.quota = payload.quota || null
  nextError.cause = error
  return nextError
}

async function readFunctionErrorContext(error) {
  const context = error.context
  if (!context) return null

  try {
    if (typeof context.json === 'function') {
      return await context.json()
    }
    if (typeof context === 'string') {
      return JSON.parse(context)
    }
    if (typeof context === 'object') {
      return context
    }
  } catch {
    return null
  }
  return null
}

export default supabase
