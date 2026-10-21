import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('official-model bootstrap and recovery are isolated by Uniopc Profile', () => {
  const source = fs.readFileSync(new URL('./uniopcOfficialModel.js', import.meta.url), 'utf8')

  assert.match(source, /const bootstrapStateByProfile = new Map\(\)/)
  assert.match(source, /const bootstrapTasksByProfile = new Map\(\)/)
  assert.match(source, /bootstrapStateByProfile\.get\(profileKey\) === 'done'/)
  assert.match(source, /bootstrapTasksByProfile\.get\(profileKey\)/)
  assert.doesNotMatch(source, /let bootstrapState = 'idle'/)
  assert.match(source, /const lastOfficialModelRecoveryAtByProfile = new Map\(\)/)
  assert.match(source, /looksLikeOfficialModelConfigurationFailure/)
  assert.match(source, /unknown model: uniopc-official\//)
})

test('official-model readiness belongs to the active Profile', () => {
  const source = fs.readFileSync(new URL('./uniopcOfficialModel.js', import.meta.url), 'utf8')

  assert.match(source, /let officialModelStatus = \{ state: 'idle', error: null, profile: null \}/)
  assert.match(source, /export function isOfficialModelReadyForProfile/)
  assert.match(source, /status\?\.profile === profileKey/)
  assert.match(source, /setOfficialModelStatus\('connecting', null, profileKey\)/)
  assert.match(source, /setOfficialModelStatus\('connected', null, profileKey\)/)
  assert.match(source, /setOfficialModelStatus\('failed', error, profileKey\)/)
})

test('official-model picker reuses the active provider and only repairs missing state', () => {
  const source = fs.readFileSync(new URL('./uniopcOfficialModel.js', import.meta.url), 'utf8')

  assert.match(source, /let activeOfficialProviderProfile = ''/)
  assert.match(source, /let activeOfficialProviderModelRefs = new Set\(\)/)
  assert.match(source, /activeOfficialProviderModelRefs\.has\(target\)/)
  assert.match(source, /let officialProviderMutationQueue = Promise\.resolve\(\)/)
  assert.match(source, /enqueueOfficialProviderMutation/)
  assert.match(source, /export async function prepareUniopcOfficialModelForSelection/)
  assert.match(source, /officialModelRegisteredForSelection\(snapshot, modelRef\)/)
  assert.match(source, /activeOfficialProviderProfile === profileKey/)
  assert.match(source, /await refreshUniopcOfficialModelToken\(\{ profile: profileKey \}\)/)
  assert.match(source, /await connectUniopcOfficialModel\(\{ profile: profileKey \}\)/)
})

test('official-model single-flight merges a late model-preservation request', () => {
  const source = fs.readFileSync(new URL('./uniopcOfficialModel.js', import.meta.url), 'utf8')

  assert.match(source, /const existing = inflightConnects\.get\(key\)/)
  assert.match(source, /if \(model\) existing\.request\.model = model/)
  assert.match(source, /connectUniopcOfficialModelUnguarded\(request\)/)
  assert.match(source, /const selectedModel = request\.model \|\| data\.model \|\| undefined/)
  assert.match(source, /rememberActiveOfficialProvider\(profileKey, \[[\s\S]*?selectedModel,/)
})

test('official-model token readiness cannot leak across Profiles', () => {
  const source = fs.readFileSync(new URL('./uniopcOfficialModel.js', import.meta.url), 'utf8')

  assert.match(
    source,
    /bootstrapStateByProfile\.get\(profileKey\) === 'done'\s*&& activeOfficialProviderProfile === profileKey/,
  )
  assert.match(
    source,
    /activeOfficialProviderProfile === profileKey\s*&& await invoke\('official_model_upstream_ready'\)/,
  )
})

test('official-model bootstrap prewarms configured Profiles before Gateway repair is available', () => {
  const source = fs.readFileSync(new URL('../components/OfficialModelBootstrap.jsx', import.meta.url), 'utf8')
  const modelSource = fs.readFileSync(new URL('./uniopcOfficialModel.js', import.meta.url), 'utf8')

  assert.match(source, /useRuntimeStatusStore/)
  assert.match(source, /getGatewayConnectionSnapshot/)
  assert.match(source, /isGatewayConnectionReady/)
  assert.match(source, /const FIRST_ATTEMPT_DELAY_MS = 0/)
  assert.match(source, /if \(!user\?\.uid \|\| !activeProfile\) return undefined/)
  assert.doesNotMatch(source, /if \(!user\?\.uid \|\| !activeProfile \|\| !gatewayReady\) return undefined/)
  assert.match(source, /allowGatewayRepair: gatewayReady/)
  assert.match(modelSource, /invoke\('official_model_local_profile_state'/)
  assert.match(modelSource, /if \(!allowGatewayRepair\)/)
  assert.match(modelSource, /deferred: true/)
  assert.match(
    source,
    /status\.profile !== activeProfile[\s\S]*?\|\| status\.state !== 'failed'[\s\S]*?\|\| !gatewayReady/,
  )
})

test('official-model recovery recognizes OpenClaw auth aggregation caused by a local proxy outage', () => {
  const source = fs.readFileSync(new URL('./uniopcOfficialModel.js', import.meta.url), 'utf8')

  assert.match(
    source,
    /message\.includes\('provider uniopc-official has auth issue'\)/,
  )
})

test('official-model recovery clears a persisted provider billing circuit after re-minting', () => {
  const source = fs.readFileSync(new URL('./uniopcOfficialModel.js', import.meta.url), 'utf8')
  const rustSource = fs.readFileSync(new URL('../../src-tauri/src/commands/model/models.rs', import.meta.url), 'utf8')

  assert.match(source, /isGatewayModelCredentialsUnavailable/)
  assert.match(source, /&& !isGatewayModelCredentialsUnavailable\(gatewayError\)/)
  assert.match(source, /await connectUniopcOfficialModel\(\{ profile \}\)/)
  assert.match(rustSource, /clear_openclaw_provider_auth_failure_state\([\s\S]*?OPENCLAW_UNIOPC_OFFICIAL_PROVIDER/)
})

test('official loopback proxy binds before the desktop starts background engine work', () => {
  const source = fs.readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')

  assert.match(
    source,
    /tauri::async_runtime::block_on\(\s*services::official_model_proxy::start\(app\.handle\(\)\.clone\(\)\),\s*\)/,
  )
})

test('official-model bootstrap repairs a configured stale loopback endpoint', () => {
  const source = fs.readFileSync(new URL('./uniopcOfficialModel.js', import.meta.url), 'utf8')

  assert.match(source, /const localProxyMismatch = localState\?\.configured === true\s*&& localState\?\.runtimeReady !== true/)
  assert.match(source, /if \(onOfficial && localProxyMismatch\) \{[\s\S]*?await connectUniopcOfficialModel\(\{ profile, model: localPrimaryModel \}\)/)
  assert.match(source, /model: selectedModel/)
})

async function loadOfficialModelForBehavior(invoke, mint = async () => ({ baseUrl: 'https://example.test', apiKey: 'test', model: 'uniopc-default' })) {
  const source = fs.readFileSync(new URL('./uniopcOfficialModel.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
  return new Function('invoke', 'callSupabaseFunctionViaClient', 'supabase',
    'isGatewayModelCredentialsUnavailable', 'shouldRecoverGatewayAuth',
    `${source}\nreturn { maybeBootstrapUniopcOfficialModel, connectUniopcOfficialModel, getOfficialModelStatus, hasConfiguredModel };`,
  )(invoke, mint, {}, () => false, () => false)
}

test('bootstrap invokes the dedicated snapshot with top-level profile and preserves supplied snapshots', async () => {
  const calls = []
  const api = await loadOfficialModelForBehavior(async (command, args) => {
    calls.push([command, args])
    if (command === 'official_model_local_profile_state') return null
    if (command === 'openclaw_official_bootstrap_snapshot') return {
      resolvedDefaultModel: 'custom-test/test', providers: [{ id: 'custom-test', ready: true, configured: true }],
    }
    throw new Error(`unexpected ${command}`)
  })
  await api.maybeBootstrapUniopcOfficialModel({ profile: 'profile-a' })
  assert.deepEqual(calls.filter(([command]) => command.includes('snapshot')), [
    ['openclaw_official_bootstrap_snapshot', { profile: 'profile-a' }],
  ])
  const before = calls.length
  await api.maybeBootstrapUniopcOfficialModel({ profile: 'profile-b', snapshot: {
    resolvedDefaultModel: 'custom-test/test', providers: [{ id: 'custom-test', ready: true, configured: true }],
  } })
  assert.equal(calls.length, before)
})

test('bootstrap shares one full connect per profile, serializes token owners, and propagates RPC failure', async () => {
  let connects = 0
  let mints = 0
  const calls = []
  const api = await loadOfficialModelForBehavior(async (command, args) => {
    calls.push([command, args])
    if (command === 'official_model_local_profile_state') return null
    if (command === 'openclaw_official_bootstrap_snapshot') return {}
    if (command === 'openclaw_use_uniopc_official_model') { connects += 1; return {} }
    throw new Error(`unexpected ${command}`)
  }, async () => { mints += 1; return { baseUrl: 'https://example.test', apiKey: 'test', model: 'uniopc-default' } })
  await Promise.all([
    api.maybeBootstrapUniopcOfficialModel({ profile: 'a' }),
    api.maybeBootstrapUniopcOfficialModel({ profile: 'a' }),
    api.maybeBootstrapUniopcOfficialModel({ profile: 'b' }),
  ])
  assert.equal(connects, 2)
  assert.equal(mints, 2)
  assert.deepEqual(calls.filter(([command]) => command === 'openclaw_use_uniopc_official_model').map(([, args]) => args.req.profile), ['a', 'b'])
  const failing = await loadOfficialModelForBehavior(async command => {
    if (command === 'official_model_local_profile_state') return null
    throw new Error('rpc failed')
  })
  await assert.rejects(failing.maybeBootstrapUniopcOfficialModel({ profile: 'failed' }), /rpc failed/)
  assert.notEqual(failing.getOfficialModelStatus().state, 'connected')
})


test('official snapshot classification retains missing-provider bootstrap and final default truthiness', async () => {
  const api = await loadOfficialModelForBehavior(async () => { throw new Error('unexpected IPC') })
  for (const snapshot of [{}, { primaryModel: 'raw' }, { resolvedDefaultModel: '  ', primaryModel: 'custom-test/test' }]) {
    assert.equal(api.hasConfiguredModel(snapshot), false)
  }
  assert.equal(api.hasConfiguredModel({ primaryModel: 'uniopc-official/test', providers: [] }), false)
  assert.equal(api.hasConfiguredModel({ primaryModel: 'uniopc-official/test', providers: [{ id: 'uniopc-official', configured: true }] }), true)
})

test('late selected model merges into one queued connect exactly once', async () => {
  let releaseMint
  let mintEntered
  const entered = new Promise(resolve => { mintEntered = resolve })
  const barrier = new Promise(resolve => { releaseMint = resolve })
  const requests = []
  const api = await loadOfficialModelForBehavior(async (command, args) => {
    if (command === 'openclaw_use_uniopc_official_model') { requests.push(args.req); return {} }
    throw new Error(`unexpected ${command}`)
  }, async () => {
    mintEntered()
    await barrier
    return { baseUrl: 'https://example.test', apiKey: 'test', model: 'default' }
  })
  const first = api.connectUniopcOfficialModel({ profile: 'a' })
  await entered
  const late = api.connectUniopcOfficialModel({ profile: 'a', model: 'uniopc-official/selected' })
  releaseMint()
  await Promise.all([first, late])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'uniopc-official/selected')
})
