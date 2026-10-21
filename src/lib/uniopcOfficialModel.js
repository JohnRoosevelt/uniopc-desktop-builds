// Uniopc official model (default token scheme, MVP).
//
// New users with no configured model are auto-connected to the Uniopc official
// model (served by the `llm-proxy` Supabase Edge Function, metered in credits).
// Users who already configured their own provider keep it — configured wins.

import { invoke } from '@tauri-apps/api/core'
import supabase, { callSupabaseFunctionViaClient } from './supabase'
import { isGatewayModelCredentialsUnavailable, shouldRecoverGatewayAuth } from './gatewayErrors'

export const UNIOPC_OFFICIAL_PROVIDER = 'uniopc-official'

// --- Connection status (drives the in-app "not connected · retry" banner) ---
// Both the headless bootstrap loop AND the 401 self-heal feed this single
// status, so the banner reflects the true state regardless of which path last
// ran. Without a visible signal, a connect that keeps failing (e.g. gateway
// still restarting, or a config.patch dropped mid-restart) is completely silent
// — the user only discovers it by sending a message and hitting "No API key".
let officialModelStatus = { state: 'idle', error: null, profile: null } // idle | connecting | connected | failed
const officialModelStatusListeners = new Set()
// The Rust proxy holds exactly one upstream token in memory. Track which
// Profile supplied it so switching accounts can never reuse another account's
// token. This is deliberately process-local: a fresh app process must inject a
// fresh token once, while routine model changes in the same Profile are free.
let activeOfficialProviderProfile = ''
// Model registrations owned by the active Profile. The Gateway snapshot can
// briefly lag behind a successful config.patch (and the conversation page can
// mount with a pre-bootstrap snapshot), so using only that snapshot made every
// click repeat the full repair path. A successful connect is a stronger,
// newer fact: Rust verifies the provider after patching before it returns.
let activeOfficialProviderModelRefs = new Set()

function normalizeOfficialModelRef(value) {
  const model = String(value || '').trim()
  if (!model) return ''
  return model.startsWith(`${UNIOPC_OFFICIAL_PROVIDER}/`)
    ? model
    : `${UNIOPC_OFFICIAL_PROVIDER}/${model}`
}

function rememberActiveOfficialProvider(profile, modelRefs = null) {
  const profileKey = String(profile || '').trim()
  if (activeOfficialProviderProfile !== profileKey) {
    activeOfficialProviderModelRefs = new Set()
  }
  activeOfficialProviderProfile = profileKey
  if (modelRefs) {
    for (const modelRef of modelRefs) {
      const normalized = normalizeOfficialModelRef(modelRef)
      if (normalized) activeOfficialProviderModelRefs.add(normalized)
    }
  }
}

function forgetActiveOfficialProvider(profile) {
  const profileKey = String(profile || '').trim()
  if (activeOfficialProviderProfile !== profileKey) return
  activeOfficialProviderProfile = ''
  activeOfficialProviderModelRefs = new Set()
}

function setOfficialModelStatus(state, error = null, profile = null) {
  officialModelStatus = {
    state,
    error: error ? String(error?.message || error) : null,
    profile: String(profile || '').trim() || null,
  }
  officialModelStatusListeners.forEach(listener => {
    try {
      listener(officialModelStatus)
    } catch {
      /* a broken subscriber must not break status propagation */
    }
  })
}

export function getOfficialModelStatus() {
  return officialModelStatus
}

export function isOfficialModelReadyForProfile(status, profile) {
  const profileKey = String(profile || '').trim()
  return Boolean(
    profileKey
      && status?.profile === profileKey
      && status?.state === 'connected',
  )
}

export function isOfficialModelPreparingForProfile(status, profile) {
  const profileKey = String(profile || '').trim()
  if (!profileKey) return false
  if (status?.profile !== profileKey) return true
  return status?.state === 'idle' || status?.state === 'connecting'
}

// Subscribe to official-model connection status. Fires immediately with the
// current value, returns an unsubscribe fn.
export function subscribeOfficialModelStatus(listener) {
  officialModelStatusListeners.add(listener)
  try {
    listener(officialModelStatus)
  } catch {
    /* ignore */
  }
  return () => officialModelStatusListeners.delete(listener)
}

// Providers that mean "the user already set up a working model of their own".
function resolvedDefaultModel(snapshot) {
  return String(
    snapshot?.resolvedDefaultModel ||
      snapshot?.resolved_default_model ||
      snapshot?.primaryModel ||
      snapshot?.primary_model ||
      '',
  ).trim()
}

function hasReadyProvider(snapshot) {
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
  return providers.some(provider => provider?.ready)
}

// True when the profile already has a real, deliberately-configured model — the
// Uniopc official model or a provider the user set up themselves.
//
// Every managed/user model ref is `provider/model` (e.g. `uniopc-official/
// uniopc-default`, `openai-codex/gpt-5.5`). The OpenClaw runtime, however, ships
// with a baked-in baseline default that is a RAW upstream model id with no
// `provider/` prefix (e.g. the AWS Bedrock `anthropic.claude-3-haiku-20240307-v1:0`).
// That baseline is not a user choice — treating it as "configured" used to
// suppress the official-model bootstrap, stranding fresh profiles on the old
// Bedrock Haiku. A slash-less resolved default therefore counts as unconfigured
// so the Uniopc official model bootstraps and becomes the default instead.
export function hasConfiguredModel(snapshot) {
  const model = resolvedDefaultModel(snapshot)
  if (!model || !model.includes('/')) return false
  // The official model counts as configured only when its provider block is
  // actually present in config (has an apiKey) — NOT merely when it is the
  // resolved default. `agents.defaults.model.primary` can point at
  // `uniopc-official/*` while `models.providers["uniopc-official"]` is missing
  // (e.g. wiped by a config-patch merge): then every send fails with
  // "Unknown model". In that case fall through to reconnect so the provider is
  // repaired. `officialProviderConfigured` is true even before the provider is
  // runtime-`ready` (so a just-restarted gateway does NOT re-mint → the old
  // refresh-restart loop stays fixed); it is false only when the block is gone.
  if (model.startsWith(`${UNIOPC_OFFICIAL_PROVIDER}/`)) {
    return officialProviderConfigured(snapshot)
  }
  return hasReadyProvider(snapshot)
}

// True when the uniopc-official provider block exists in config (has an
// apiKey/baseUrl), regardless of runtime auth readiness. Uses the snapshot
// provider's `configured` flag (set by the Rust snapshot from the raw config) —
// distinct from `ready` (auth verified), so a set-up-but-not-yet-ready provider
// still counts, while a wiped provider block does not.
function officialProviderConfigured(snapshot) {
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
  return providers.some(
    provider => provider?.id === UNIOPC_OFFICIAL_PROVIDER && provider?.configured === true,
  )
}

function officialModelRegisteredForSelection(snapshot, modelRef) {
  const target = String(modelRef || '').trim()
  if (!target.startsWith(`${UNIOPC_OFFICIAL_PROVIDER}/`)) return false
  return officialModelRefsRegisteredInSnapshot(snapshot).has(target)
}

function officialModelRefsRegisteredInSnapshot(snapshot) {
  const refs = new Set()
  if (!officialProviderConfigured(snapshot)) return refs
  const models = Array.isArray(snapshot?.models) ? snapshot.models : []
  for (const model of models) {
    const ref = String(model?.modelRef || model?.model_ref || '').trim()
    const configured = model?.configured === true
    const catalogAvailable = model?.catalogAvailable ?? model?.catalog_available
    if (
      ref.startsWith(`${UNIOPC_OFFICIAL_PROVIDER}/`)
      && configured
      && catalogAvailable === true
    ) {
      refs.add(ref)
    }
  }
  return refs
}

// --- Official chat model catalog (mint's `models[]`) ---------------------
// Display metadata (name/tier/badge/multiplier) for the picker. Cached in
// localStorage so the picker has names on a cold start; refreshed on every
// successful connect (which runs once per app session when on the official
// model, because the loopback proxy's token must be re-injected each launch).
const OFFICIAL_CATALOG_STORAGE_KEY = 'uniopc.officialModelCatalog.v1'
const officialCatalogListeners = new Set()

function normalizeOfficialModelCatalog(models) {
  if (!Array.isArray(models)) return []
  const seen = new Set()
  return models
    .map(entry => ({
      id: String(entry?.id || '').trim(),
      displayName: String(entry?.displayName || '').trim(),
      tier: String(entry?.tier || '').trim(),
      badge: String(entry?.badge || '').trim(),
      creditMultiplier: Number.isFinite(Number(entry?.creditMultiplier))
        ? Number(entry.creditMultiplier)
        : 1,
      isDefault: entry?.isDefault === true,
      // Declared capabilities, kept TRI-STATE on purpose: `undefined` means
      // "this backend predates the capability columns", which Rust answers
      // with the pre-declaration defaults. Coercing absent to `false` here
      // would read as "declared text-only" and silently kill image input.
      supportsVision: typeof entry?.supportsVision === 'boolean' ? entry.supportsVision : undefined,
      supportsReasoning:
        typeof entry?.supportsReasoning === 'boolean' ? entry.supportsReasoning : undefined,
      thinkingFormat:
        typeof entry?.thinkingFormat === 'string' ? entry.thinkingFormat.trim() : undefined,
    }))
    .filter(entry => {
      if (!entry.id || seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })
}

let officialModelCatalog = (() => {
  try {
    return normalizeOfficialModelCatalog(
      JSON.parse(localStorage.getItem(OFFICIAL_CATALOG_STORAGE_KEY) || '[]'),
    )
  } catch {
    return []
  }
})()

export function getOfficialModelCatalog() {
  return officialModelCatalog
}

// Fires immediately with the current catalog; returns an unsubscribe fn.
export function subscribeOfficialModelCatalog(listener) {
  officialCatalogListeners.add(listener)
  try {
    listener(officialModelCatalog)
  } catch {
    /* ignore */
  }
  return () => officialCatalogListeners.delete(listener)
}

function saveOfficialModelCatalog(models) {
  const catalog = normalizeOfficialModelCatalog(models)
  // mint always includes the default entry; an empty/missing list means an old
  // backend — keep whatever we had rather than blanking the picker.
  if (catalog.length === 0) return
  officialModelCatalog = catalog
  try {
    localStorage.setItem(OFFICIAL_CATALOG_STORAGE_KEY, JSON.stringify(catalog))
  } catch {
    /* ignore */
  }
  officialCatalogListeners.forEach(listener => {
    try {
      listener(catalog)
    } catch {
      /* ignore */
    }
  })
}

// Mint a token from Supabase and patch it into the Uniopc 引擎 profile config as
// the `uniopc-official` provider. Returns { balance, model }.
//
// Single-flight per profile: concurrent callers (auto-bootstrap, settings page,
// picker) share one in-flight connect instead of racing mints.
const inflightConnects = new Map()
// The Rust loopback proxy has one mutable upstream-token slot for the whole
// process. Serialize every write to that slot across Profiles so an older,
// slower config patch cannot finish after a newer account refresh and make our
// JS ownership marker disagree with the token that is actually live.
let officialProviderMutationQueue = Promise.resolve()

function enqueueOfficialProviderMutation(task) {
  const run = officialProviderMutationQueue.then(task, task)
  officialProviderMutationQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// Stable per-install device id: lets mint-llm-token rotate THIS device's
// token slot instead of appending (appending + newest-8 trimming used to
// silently revoke keys still baked into other desktops' engine configs).
const DEVICE_ID_STORAGE_KEY = 'uniopc.llmDeviceId.v1'

function officialModelDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY)
    if (!id) {
      id = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`)
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, id)
    }
    return id
  } catch {
    return ''
  }
}

export function connectUniopcOfficialModel({ profile, model } = {}) {
  const key = String(profile || '').trim()
  const existing = inflightConnects.get(key)
  if (existing) {
    // A startup repair can discover the Profile's selected model after a token
    // refresh has already entered the single-flight. Merge that stronger intent
    // into the live request so the first config.patch never resets the model.
    if (model) existing.request.model = model
    return existing.promise
  }
  const request = { profile: key, model }
  const promise = enqueueOfficialProviderMutation(
    () => connectUniopcOfficialModelUnguarded(request),
  ).finally(() => {
    if (inflightConnects.get(key)?.promise === promise) {
      inflightConnects.delete(key)
    }
  })
  inflightConnects.set(key, { request, promise })
  return promise
}

async function connectUniopcOfficialModelUnguarded(request = {}) {
  const profile = request.profile
  const profileKey = String(profile || '').trim()
  setOfficialModelStatus('connecting', null, profileKey)
  const started = Date.now()
  let mintMs = 0
  let mintCount = 0
  try {
    // callSupabaseFunctionViaClient returns the payload directly and throws on error.
    let data
    try {
      const mintStarted = Date.now()
      mintCount += 1
      try {
        data = await callSupabaseFunctionViaClient('mint-llm-token', { deviceId: officialModelDeviceId() })
      } finally {
        mintMs = Date.now() - mintStarted
      }
    } catch (error) {
      throw new Error(error?.message || '无法连接 Uniopc 官方模型：令牌签发失败。')
    }
    if (!data?.baseUrl || !data?.apiKey) {
      throw new Error(data?.error || '官方模型令牌签发返回无效。')
    }

    // Chat model catalog: cache for the picker (names/badges/multipliers) and
    // hand the ids to Rust so every official model gets registered under the
    // uniopc-official provider — all routed through the same loopback proxy.
    saveOfficialModelCatalog(data.models)
    // Capabilities ride along to Rust, which writes them straight into the
    // gateway model entry (input / reasoning / compat.thinkingFormat). Rust
    // must never re-derive them from the id: the alias is operator-editable in
    // the admin console, and renaming the default row once already dropped
    // image input for everyone.
    const catalogModels = normalizeOfficialModelCatalog(data.models).map(entry => ({
      id: entry.id,
      displayName: entry.displayName || undefined,
      supportsVision: entry.supportsVision,
      supportsReasoning: entry.supportsReasoning,
      thinkingFormat: entry.thinkingFormat || undefined,
    }))

    // Rust now verifies the `uniopc-official` provider block actually landed in
    // config before returning Ok — a config.patch dropped in a gateway-restart
    // window throws here instead of reporting a phantom success (the half-write
    // that left the token file on disk but stranded the agent on "No API key
    // found for provider openai"). A throw here flips status to 'failed', which
    // the retry loop + banner pick up.
    const selectedModel = request.model || data.model || undefined
    await invoke('openclaw_use_uniopc_official_model', {
      req: {
        baseUrl: data.baseUrl,
        apiKey: data.apiKey,
        model: selectedModel,
        profile: profile || undefined,
        models: catalogModels.length > 0 ? catalogModels : undefined,
      },
    })

    rememberActiveOfficialProvider(profileKey, [
      ...catalogModels.map(model => model.id),
      selectedModel,
      data.model || 'uniopc-default',
    ])
    setOfficialModelStatus('connected', null, profileKey)
    return { balance: Number(data.balance ?? 0), model: data.model || null }
  } catch (error) {
    forgetActiveOfficialProvider(profileKey)
    setOfficialModelStatus('failed', error, profileKey)
    throw error
  } finally {
    console.info('[official-model] connect timing', { mintMs, mintCount, totalMs: Date.now() - started })
  }
}

// Lightweight token refresh for the loopback proxy's transparent 401 recovery.
// Mints a fresh token and hands it STRAIGHT to the in-memory proxy via the
// `official_model_refresh_token` command — no config.patch / gateway-ready wait
// (config already points at the proxy; only the memory token is stale). This is
// what keeps the blocked request's recovery to ~mint latency instead of the full
// connect path. Single-flight so a burst of proxy 401s collapses into one mint.
const inflightRefreshes = new Map()

export function refreshUniopcOfficialModelToken({ profile } = {}) {
  const key = String(profile || '').trim()
  const existing = inflightRefreshes.get(key)
  if (existing) return existing
  const run = enqueueOfficialProviderMutation(refreshUniopcOfficialModelTokenUnguarded)
    .then(result => {
      rememberActiveOfficialProvider(key)
      return result
    })
    .finally(() => inflightRefreshes.delete(key))
  inflightRefreshes.set(key, run)
  return run
}

async function refreshUniopcOfficialModelTokenUnguarded() {
  const data = await callSupabaseFunctionViaClient('mint-llm-token', {
    deviceId: officialModelDeviceId(),
  })
  if (!data?.baseUrl || !data?.apiKey) {
    throw new Error(data?.error || '官方模型令牌签发返回无效。')
  }
  saveOfficialModelCatalog(data.models)
  await invoke('official_model_refresh_token', { baseUrl: data.baseUrl, apiKey: data.apiKey })
  return { balance: Number(data.balance ?? 0) }
}

// Prepare an official model selected in the conversation picker with the
// cheapest safe path:
//   1. registered model + this Profile already owns the proxy token: no work;
//   2. registered model + token missing/owned by another Profile: token-only
//      refresh (no config.patch / Gateway readiness wait);
//   3. missing provider or catalog registration: full connect/repair once.
export async function prepareUniopcOfficialModelForSelection({ profile, snapshot, modelRef } = {}) {
  const profileKey = String(profile || '').trim()
  const target = String(modelRef || '').trim()
  if (!profileKey || !target.startsWith(`${UNIOPC_OFFICIAL_PROVIDER}/`)) {
    return { connected: false, snapshotRefreshNeeded: false }
  }

  // This is the normal hot path. A completed connect already registered the
  // mint catalog and Rust verified the provider; do not let an older/null page
  // snapshot force another mint + config.patch.
  if (
    activeOfficialProviderProfile === profileKey
    && activeOfficialProviderModelRefs.has(target)
  ) {
    setOfficialModelStatus('connected', null, profileKey)
    return { connected: false, reused: true, snapshotRefreshNeeded: false }
  }

  if (!officialModelRegisteredForSelection(snapshot, modelRef)) {
    const result = await connectUniopcOfficialModel({ profile: profileKey })
    return { ...result, connected: true, snapshotRefreshNeeded: true }
  }

  if (activeOfficialProviderProfile === profileKey) {
    rememberActiveOfficialProvider(profileKey, [target])
    setOfficialModelStatus('connected', null, profileKey)
    return { connected: false, reused: true, snapshotRefreshNeeded: false }
  }

  setOfficialModelStatus('connecting', null, profileKey)
  try {
    const result = await refreshUniopcOfficialModelToken({ profile: profileKey })
    rememberActiveOfficialProvider(
      profileKey,
      officialModelRefsRegisteredInSnapshot(snapshot),
    )
    setOfficialModelStatus('connected', null, profileKey)
    return { ...result, connected: true, tokenRefreshed: true, snapshotRefreshNeeded: false }
  } catch (error) {
    forgetActiveOfficialProvider(profileKey)
    setOfficialModelStatus('failed', error, profileKey)
    throw error
  }
}

// Self-heal an expired official-model key OR a partially initialized provider.
// The latter is most visible after an account switch: config can retain the
// `uniopc-official/*` default while the provider registration is absent.
// Reconnect is single-flight per Profile and cooldown-limited per Profile, so
// one account's failure never suppresses recovery for another account.
const AUTH_RECOVERY_COOLDOWN_MS = 60000
const lastOfficialModelRecoveryAtByProfile = new Map()

export function looksLikeOfficialModelAuthFailure(errorText) {
  const message = String(errorText || '').toLowerCase()
  return message.includes('invalid_token')
    || message.includes('invalid token')
    || message.includes('unauthorized')
    || message.includes(' 401')
    || message.includes('(401')
    || message.includes('status 401')
    // OpenClaw labels every exhausted provider attempt as an auth issue. A
    // refused connection to our loopback proxy takes that path too, even though
    // the account token is valid. Reconnect once so a stale port/config is
    // repaired for the next turn rather than leaving the user stranded.
    || message.includes('provider uniopc-official has auth issue')
}

export function looksLikeOfficialModelConfigurationFailure(errorText) {
  const message = String(errorText || '').toLowerCase()
  return message.includes('unknown model: uniopc-official/')
    || (
      message.includes('uniopc-official')
      && message.includes('models.providers')
      && message.includes('models')
    )
}

export async function recoverOfficialModelAuth({ profile, errorText, gatewayError, currentModel } = {}) {
  if (!profile) return false
  if (
    !shouldRecoverGatewayAuth(gatewayError)
    // A prior 402 is persisted by OpenClaw against the proxy's stable inline
    // key. Re-minting through the full connect path also clears that persisted
    // failure state; the lightweight in-memory token refresh cannot.
    && !isGatewayModelCredentialsUnavailable(gatewayError)
    && !looksLikeOfficialModelAuthFailure(errorText)
    && !looksLikeOfficialModelConfigurationFailure(errorText)
  ) return false
  const model = String(currentModel || '').trim()
  if (model && !model.startsWith(`${UNIOPC_OFFICIAL_PROVIDER}/`)) return false
  const profileKey = String(profile).trim()
  if (!profileKey) return false
  const now = Date.now()
  if (now - (lastOfficialModelRecoveryAtByProfile.get(profileKey) || 0) < AUTH_RECOVERY_COOLDOWN_MS) return false
  lastOfficialModelRecoveryAtByProfile.set(profileKey, now)
  try {
    await connectUniopcOfficialModel({ profile })
    return true
  } catch (error) {
    console.warn('official model auth recovery failed', error)
    return false
  }
}

// Read the current credit balance for the signed-in user (RLS scopes to self).
export async function fetchLlmCreditBalance() {
  const { data, error } = await supabase
    .from('llm_credit_wallet')
    .select('balance_credits')
    .maybeSingle()
  if (error) return null
  return data ? Number(data.balance_credits ?? 0) : null
}

// Auto-connect the official model only when nothing is configured yet.
// Returns { connected: boolean, balance? } — connected=false means the user's
// own model was kept untouched.
//
// Bootstrap state is scoped to the engine Profile, not the desktop process.
// Each signed-in account has an isolated engine state directory, so allowing
// account A's successful bootstrap to suppress account B would leave B with a
// dangling `uniopc-official/*` default and no provider registration.
// Concurrent callers for the SAME Profile share a promise; failures return that
// Profile to idle so a gateway that is still starting can recover on retry.
const bootstrapStateByProfile = new Map() // profile -> 'running' | 'done'
const bootstrapTasksByProfile = new Map() // profile -> Promise<{ connected, balance? }>

export async function maybeBootstrapUniopcOfficialModel({
  snapshot,
  profile,
  allowGatewayRepair = true,
} = {}) {
  const profileKey = String(profile || '').trim()
  if (!profileKey) return { connected: false }
  if (
    bootstrapStateByProfile.get(profileKey) === 'done'
    && activeOfficialProviderProfile === profileKey
  ) {
    setOfficialModelStatus('connected', null, profileKey)
    return { connected: false }
  }
  // A completed Profile may become stale after another account replaces the
  // process-global proxy token. Re-evaluate it instead of letting the old
  // once-per-Profile marker suppress token injection when the user switches
  // back. Profiles using their own provider simply take the cheap snapshot
  // no-op path below.
  if (bootstrapStateByProfile.get(profileKey) === 'done') {
    bootstrapStateByProfile.delete(profileKey)
  }
  const existing = bootstrapTasksByProfile.get(profileKey)
  if (existing) return await existing

  bootstrapStateByProfile.set(profileKey, 'running')
  const task = (async () => {
    // Established official-model Profiles can be recognized directly from the
    // local config in milliseconds. Pre-warm their process-local token while
    // the engine is still loading plugins; Gateway RPC is unnecessary because
    // no config mutation is needed.
    const localState = snapshot
      ? null
      : await invoke('official_model_local_profile_state', { profile }).catch(() => null)
    const localModelRefs = Array.isArray(localState?.modelRefs)
      ? localState.modelRefs.map(normalizeOfficialModelRef).filter(Boolean)
      : []
    const localPrimaryModel = normalizeOfficialModelRef(localState?.primaryModel)
    const canPrewarmFromLocalConfig = Boolean(
      localState?.configured === true
      && localState?.runtimeReady === true
      && localState?.selected === true
      && localPrimaryModel
      && localModelRefs.includes(localPrimaryModel),
    )
    // A previous app process can leave config targeting a loopback port
    // that this process could not reclaim. Token-only refresh would mark
    // the model connected while Gateway still calls that stale endpoint.
    // Once Gateway is available, do the one full connect that patches the
    // provider to this process's live proxy port.
    const localProxyMismatch = localState?.configured === true
      && localState?.runtimeReady !== true
    if (canPrewarmFromLocalConfig) {
      const upstreamReady = activeOfficialProviderProfile === profileKey
        && await invoke('official_model_upstream_ready').catch(() => false)
      if (!upstreamReady) {
        setOfficialModelStatus('connecting', null, profileKey)
        try {
          const result = await refreshUniopcOfficialModelToken({ profile: profileKey })
          rememberActiveOfficialProvider(profileKey, localModelRefs)
          setOfficialModelStatus('connected', null, profileKey)
          return { connected: true, balance: result.balance, tokenRefreshed: true, locallyPrewarmed: true }
        } catch (error) {
          forgetActiveOfficialProvider(profileKey)
          setOfficialModelStatus('failed', error, profileKey)
          throw error
        }
      }
      rememberActiveOfficialProvider(profileKey, localModelRefs)
      setOfficialModelStatus('connected', null, profileKey)
      return { connected: false, locallyPrewarmed: true }
    }

    // Before Gateway readiness there is nothing useful to repair for a fresh,
    // dangling, or third-party Profile. Return without poisoning the once-only
    // bootstrap marker; the gatewayReady dependency calls us again later.
    if (!allowGatewayRepair) {
      return { connected: false, deferred: true }
    }

    const effectiveSnapshot = snapshot || (await invoke('openclaw_official_bootstrap_snapshot', { profile }))
    if (hasConfiguredModel(effectiveSnapshot)) {
      // The user's own provider is configured, or the official provider is
      // already in config. For the official case the upstream token lives only
      // in the Rust loopback proxy's memory and does NOT survive an app restart.
      // Refill that one memory slot with the lightweight refresh command; the
      // provider/catalog is already registered, so a config.get → config.patch
      // → readiness/verification cycle would only add startup latency.
      const onOfficial = String(resolvedDefaultModel(effectiveSnapshot)).startsWith(
        `${UNIOPC_OFFICIAL_PROVIDER}/`,
      )
      // Fail SAFE: if the readiness probe itself errors (e.g. a dev binary
      // without the command), assume NOT ready and perform the lightweight
      // token refresh. The opposite mistake would strand the session on a proxy
      // 503 with no self-heal (the auth matcher only recognizes 401 failures).
      // `official_model_upstream_ready` is process-global because the Rust
      // loopback proxy owns one token. A `true` value can therefore belong to
      // the account that was active immediately before this one. Only reuse it
      // when the JS-side owner matches this Profile; otherwise reconnect and
      // inject this account's token before declaring the model ready.
      const upstreamReady = onOfficial
        ? activeOfficialProviderProfile === profileKey
          && await invoke('official_model_upstream_ready').catch(() => false)
        : true
      if (onOfficial && localProxyMismatch) {
        // Repair only the stale process-local proxy endpoint. Keep the model the
        // user selected in this Profile instead of resetting it to the mint
        // service's default and forcing a second Gateway reload after startup.
        const result = await connectUniopcOfficialModel({ profile, model: localPrimaryModel })
        return { connected: true, balance: result.balance, proxyRepaired: true }
      }
      if (!onOfficial || upstreamReady) {
        // Own provider, or official token already live — nothing to do; clear
        // any stale 'failed' banner.
        if (onOfficial && upstreamReady) {
          rememberActiveOfficialProvider(
            profileKey,
            officialModelRefsRegisteredInSnapshot(effectiveSnapshot),
          )
        }
        setOfficialModelStatus('connected', null, profileKey)
        return { connected: false }
      }
      // Official provider is already valid; only its process-local upstream
      // token is absent or belongs to another Profile. Mint + inject directly,
      // without touching Gateway config or waiting for plugin readiness.
      setOfficialModelStatus('connecting', null, profileKey)
      try {
        const result = await refreshUniopcOfficialModelToken({ profile: profileKey })
        rememberActiveOfficialProvider(
          profileKey,
          officialModelRefsRegisteredInSnapshot(effectiveSnapshot),
        )
        setOfficialModelStatus('connected', null, profileKey)
        return { connected: true, balance: result.balance, tokenRefreshed: true }
      } catch (error) {
        forgetActiveOfficialProvider(profileKey)
        setOfficialModelStatus('failed', error, profileKey)
        throw error
      }
    }
    const result = await connectUniopcOfficialModel({ profile })
    return { connected: true, balance: result.balance }
  })()

  bootstrapTasksByProfile.set(profileKey, task)
  try {
    const result = await task
    if (result?.deferred) {
      bootstrapStateByProfile.delete(profileKey)
    } else {
      bootstrapStateByProfile.set(profileKey, 'done')
    }
    return result
  } catch (error) {
    bootstrapStateByProfile.delete(profileKey)
    throw error
  } finally {
    if (bootstrapTasksByProfile.get(profileKey) === task) {
      bootstrapTasksByProfile.delete(profileKey)
    }
  }
}
