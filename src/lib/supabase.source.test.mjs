import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./supabase.js', import.meta.url), 'utf8')
const stateSource = await readFile(new URL('./trustedCatalogState.js', import.meta.url), 'utf8')

test('Supabase client uses Tauri HTTP fetch to avoid WebView TLS failures', () => {
  assert.match(source, /import \{ fetch as tauriFetch \} from '@tauri-apps\/plugin-http'/)
  assert.match(source, /global:\s*\{\s*fetch:\s*supabaseFetch,?\s*\}/s)
})

test('Supabase source delegates route selection to the Rust HTTP boundary', () => {
  assert.doesNotMatch(source, /shouldBypassProxyForSupabase/)
  assert.doesNotMatch(source, /VITE_SUPABASE_DIRECT_CONNECT/)
  assert.doesNotMatch(source, /noProxy/)
  assert.doesNotMatch(source, /127\.0\.0\.1:1/)
  assert.match(source, /export const supabaseFetch = tauriFetch/)
})

test('cross-host requests do not gain a JavaScript proxy or SSRF exception', () => {
  assert.match(source, /export function directFetch\(/)
  assert.match(source, /return tauriFetch\(input, init\)/)
  assert.doesNotMatch(source, /typeof input === 'string'/)
})

test('trusted-service transport errors expose a stable retryable code without raw fetch details', () => {
  assert.match(source, /normalizeTrustedServiceError[\s\S]*from '\.\/trustedCatalogState'/)
  assert.match(stateSource, /nextError\.code = code/)
  assert.match(stateSource, /\? knownCode : 'trusted_service_unavailable'/)
  assert.match(stateSource, /nextError\.retryable = retryable/)
  assert.doesNotMatch(stateSource, /FetchError/)
  assert.match(stateSource, /trusted_service_auth_required/)
})

test('plugin catalog uses the fixed trusted Rust command instead of Supabase browser RPC', () => {
  assert.match(source, /import \{ invoke \} from '@tauri-apps\/api\/core'/)
  assert.match(source, /export async function fetchTrustedPluginCatalog\(/)
  assert.match(source, /invoke\('trusted_plugin_catalog_fetch'/)
  assert.match(source, /serviceOrigin: new URL\(supabaseUrl\)\.origin/)
  assert.doesNotMatch(source, /trusted_plugin_catalog_fetch[\s\S]*proxy:/)
})
