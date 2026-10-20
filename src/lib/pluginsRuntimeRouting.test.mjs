import test from 'node:test'
import assert from 'node:assert/strict'
import { pluginRuntimeApiBaseEnvKey, usesPluginsRuntimeBackend } from './pluginsRuntimeRouting.js'

test('migrated runtime plugins use the Plugins backend', () => {
  for (const pluginId of [
    'uniopc-socials',
    'uniopc-private-conversion',
    'uniopc-superip',
    'uniopc-montage',
  ]) {
    assert.equal(usesPluginsRuntimeBackend(pluginId), true, pluginId)
    assert.equal(pluginRuntimeApiBaseEnvKey(pluginId), 'VITE_PLUGINS_SUPABASE_URL', pluginId)
  }
})

test('desktop base plugins retain the Server Base backend', () => {
  assert.equal(usesPluginsRuntimeBackend('uniopc-cloud-workspace'), false)
  assert.equal(pluginRuntimeApiBaseEnvKey('uniopc-cloud-workspace'), 'VITE_SUPABASE_URL')
})
