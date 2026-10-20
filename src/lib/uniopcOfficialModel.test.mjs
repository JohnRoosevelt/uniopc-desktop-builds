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
