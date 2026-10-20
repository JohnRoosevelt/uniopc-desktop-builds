import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginCloudAgentCatalogRequest,
  commitCloudAgentCatalogRequest,
  dynamicCloudAgentFunctionPath,
  invalidateCloudAgentCatalogRequests,
  isDynamicCloudAgentPluginId,
  replaceCloudAgentPluginCatalog,
} from './cloudAgentPluginCatalogRegistry.js'

const pluginX = {
  id: 'catalog-plugin-x',
  runtimePluginId: 'catalog-plugin-x-runtime',
  functionPath: 'catalog-plugin-x-function',
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

async function loadDeferredCatalog(scope, pending) {
  const request = beginCloudAgentCatalogRequest(scope)
  try {
    const rows = await pending.promise
    return commitCloudAgentCatalogRequest(request, () => {
      replaceCloudAgentPluginCatalog(rows)
    })
  } catch {
    return commitCloudAgentCatalogRequest(request, () => {
      replaceCloudAgentPluginCatalog([])
    })
  }
}

test('online catalog replacement removes plugins and paths omitted by the next snapshot', () => {
  replaceCloudAgentPluginCatalog([pluginX])
  assert.equal(isDynamicCloudAgentPluginId(pluginX.id), true)
  assert.equal(dynamicCloudAgentFunctionPath(pluginX.runtimePluginId), pluginX.functionPath)

  replaceCloudAgentPluginCatalog([])
  assert.equal(isDynamicCloudAgentPluginId(pluginX.id), false)
  assert.equal(dynamicCloudAgentFunctionPath(pluginX.runtimePluginId), '')
})

test('clearing after a fetch error removes the previous online snapshot', () => {
  replaceCloudAgentPluginCatalog([pluginX])
  replaceCloudAgentPluginCatalog([])

  assert.equal(isDynamicCloudAgentPluginId(pluginX.id), false)
  assert.equal(dynamicCloudAgentFunctionPath(pluginX.runtimePluginId), '')
})

test('a late A response cannot overwrite a newer empty or failed B request', async () => {
  const pendingA = deferred()
  const pendingB = deferred()
  const loadA = loadDeferredCatalog('user-a/profile-a', pendingA)
  const loadB = loadDeferredCatalog('user-a/profile-a', pendingB)

  pendingB.resolve([])
  assert.equal(await loadB, true)
  pendingA.resolve([pluginX])
  assert.equal(await loadA, false)
  assert.equal(isDynamicCloudAgentPluginId(pluginX.id), false)

  const nextA = deferred()
  const failedB = deferred()
  const nextLoadA = loadDeferredCatalog('user-a/profile-a', nextA)
  const failedLoadB = loadDeferredCatalog('user-a/profile-a', failedB)
  failedB.reject(new Error('offline'))
  assert.equal(await failedLoadB, true)
  nextA.resolve([pluginX])
  assert.equal(await nextLoadA, false)
  assert.equal(dynamicCloudAgentFunctionPath(pluginX.runtimePluginId), '')
})

test('logout or unmount invalidation prevents an in-flight response from committing', async () => {
  const pendingA = deferred()
  const loadA = loadDeferredCatalog('user-a/profile-a', pendingA)

  invalidateCloudAgentCatalogRequests()
  pendingA.resolve([pluginX])

  assert.equal(await loadA, false)
  assert.equal(isDynamicCloudAgentPluginId(pluginX.id), false)
  assert.equal(dynamicCloudAgentFunctionPath(pluginX.runtimePluginId), '')
})
