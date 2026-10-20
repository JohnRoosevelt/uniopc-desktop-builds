import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const libSource = await readFile(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')
const commandSource = await readFile(new URL('../../src-tauri/src/commands/trusted_network.rs', import.meta.url), 'utf8')
const supabaseSource = await readFile(new URL('./supabase.js', import.meta.url), 'utf8')

test('the trusted plugin catalog command is registered with the desktop shell', () => {
  assert.match(libSource, /commands::trusted_network::trusted_plugin_catalog_fetch/)
})

test('the trusted catalog command exposes no generic URL parameter', () => {
  assert.match(commandSource, /pub async fn trusted_plugin_catalog_fetch\(/)
  const signature = commandSource.slice(
    commandSource.indexOf('pub async fn trusted_plugin_catalog_fetch('),
    commandSource.indexOf(') -> Result<TrustedCatalogResponse', commandSource.indexOf('pub async fn trusted_plugin_catalog_fetch(')),
  )
  assert.doesNotMatch(signature, /\burl\s*:/)
  assert.match(commandSource, /list_my_cloud_plugin_catalog/)
  assert.match(commandSource, /COMPILED_TRUSTED_SUPABASE_ORIGINS/)
})

test('the browser passes its actual offline signal without choosing a route', () => {
  assert.match(supabaseSource, /offline: typeof navigator !== 'undefined' && navigator\.onLine === false/)
  assert.doesNotMatch(supabaseSource, /systemProxy|explicitProxy|route:/)
})
