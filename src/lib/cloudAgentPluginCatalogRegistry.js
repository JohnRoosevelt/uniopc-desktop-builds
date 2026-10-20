let dynamicFunctionPathByPluginId = new Map()
let activeCatalogRequest = { generation: 0, scope: '' }

export function beginCloudAgentCatalogRequest(scope) {
  activeCatalogRequest = {
    generation: activeCatalogRequest.generation + 1,
    scope: String(scope || '').trim(),
  }
  replaceCloudAgentPluginCatalog([])
  return { ...activeCatalogRequest }
}

export function commitCloudAgentCatalogRequest(request, commit) {
  if (
    request?.generation !== activeCatalogRequest.generation
    || request?.scope !== activeCatalogRequest.scope
  ) return false
  commit()
  return true
}

export function invalidateCloudAgentCatalogRequests() {
  activeCatalogRequest = {
    generation: activeCatalogRequest.generation + 1,
    scope: '',
  }
  replaceCloudAgentPluginCatalog([])
}

export function replaceCloudAgentPluginCatalog(presets = []) {
  const replacement = new Map()
  for (const preset of Array.isArray(presets) ? presets : []) {
    const functionPath = String(
      preset?.functionPath
        || preset?.metadata?.function_path
        || preset?.metadata?.functionPath
        || '',
    ).trim()
    if (!functionPath) continue
    for (const key of [preset?.id, preset?.runtimePluginId]) {
      const id = String(key || '').trim()
      if (id) replacement.set(id, functionPath)
    }
  }
  dynamicFunctionPathByPluginId = replacement
}

export function dynamicCloudAgentFunctionPath(pluginId) {
  return dynamicFunctionPathByPluginId.get(String(pluginId || '').trim()) || ''
}

export function isDynamicCloudAgentPluginId(pluginId) {
  return dynamicFunctionPathByPluginId.has(String(pluginId || '').trim())
}
