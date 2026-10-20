const PLUGINS_RUNTIME_PLUGIN_IDS = new Set([
  'uniopc-socials',
  'uniopc-private-conversion',
  'uniopc-superip',
  'uniopc-montage',
  // Cloud-distributed copywriting uses the plugin Supabase project too.  If
  // omitted it is pointed at the workspace project (`/functions/v1/copywriting`)
  // and never receives its host-credential configuration.
  'uniopc-copywriting',
])

export function usesPluginsRuntimeBackend(pluginId) {
  return PLUGINS_RUNTIME_PLUGIN_IDS.has(String(pluginId || '').trim())
}

export function pluginRuntimeApiBaseEnvKey(pluginId) {
  return usesPluginsRuntimeBackend(pluginId)
    ? 'VITE_PLUGINS_SUPABASE_URL'
    : 'VITE_SUPABASE_URL'
}
