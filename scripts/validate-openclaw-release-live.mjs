#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LIVE_PHASES = Object.freeze([
  'updater-pre', 'backend-smoke-pre', 'matrix-attestation',
  'dev-normal', 'dev-abnormal', 'dev-concurrent',
  'package-windows', 'portable-e-drive', 'installer-e-drive',
  'runtime-rollback', 'network-system', 'network-direct',
  'network-offline', 'network-tun-fake-ip', 'log-audit', 'updater-post',
])

const FIXTURE_KEYS = Object.freeze([
  'IMAI_E2E_EMAIL', 'IMAI_E2E_PASSWORD', 'IMAI_E2E_PROFILE', 'IMAI_E2E_AGENT_ID',
  'IMAI_E2E_MAIN_SESSION_KEY', 'IMAI_E2E_CRON_SESSION_KEY', 'IMAI_E2E_EXPECTED_MODEL',
  'IMAI_E2E_EXPECTED_MODEL_LABEL', 'IMAI_E2E_FAILURE_KIND', 'IMAI_E2E_FAILURE_PROMPT',
  'IMAI_E2E_FAILURE_EXPECTED_TEXT', 'IMAI_E2E_LOCAL_WORKSPACE_PROMPT',
])
const SECRET_KEYS = Object.freeze([
  'UNIOPC_RELEASE_PREPARE_URL', 'UNIOPC_RELEASE_PREPARE_TOKEN',
  'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY', 'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY',
  'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID', 'UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE',
])
const SAFE_ARTIFACT_KINDS = new Set(['report', 'matrix', 'attestation', 'package', 'portable', 'installer', 'log'])

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function requiredText(value, code) {
  const text = String(value || '').trim()
  if (!text || /[\r\n\0]/.test(text)) throw new Error(code)
  return text
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('release_validation_options_invalid')
  const commit = requiredText(options.commit, 'release_validation_commit_invalid')
  const target = requiredText(options.target, 'release_validation_target_invalid')
  const validationRoot = requiredText(options.validationRoot, 'release_validation_root_invalid')
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('release_validation_commit_invalid')
  if (target !== 'x86_64-pc-windows-msvc') throw new Error('release_validation_target_invalid')
  const windowsEPath = /^[eE]:[\\/][^\0\r\n]*$/.test(validationRoot)
  if (!windowsEPath && !isAbsolute(validationRoot)) throw new Error('release_validation_root_invalid')
  if (!windowsEPath) throw new Error('release_validation_root_invalid')
  return { commit: commit.toLowerCase(), target, validationRoot }
}

function sanitizeArtifacts(value) {
  if (!Array.isArray(value) || value.length === 0) return []
  const artifacts = []
  for (const item of value) {
    const kind = String(item?.kind || '')
    const sha256 = String(item?.sha256 || '')
    if (!SAFE_ARTIFACT_KINDS.has(kind) || !/^[0-9a-f]{64}$/.test(sha256)) return []
    artifacts.push({ kind, sha256 })
  }
  return artifacts
}

export function sanitizePhaseEvidence(id, result) {
  if (!LIVE_PHASES.includes(id)) throw new Error('release_validation_phase_invalid')
  const artifacts = sanitizeArtifacts(result?.artifacts)
  const ok = result?.ok === true && artifacts.length > 0
  return {
    id,
    ok,
    skipped: result?.skipped === true,
    cleanupVerified: result?.cleanupVerified === true,
    artifacts,
  }
}

export async function validateReleaseLive(options, dependencies) {
  const safeOptions = validateOptions(options)
  if (typeof dependencies?.runBoundedPhase !== 'function') throw new Error('release_validation_dependencies_invalid')
  const evidence = []
  for (const id of LIVE_PHASES) {
    let result
    try {
      result = await dependencies.runBoundedPhase(id, safeOptions)
    } catch {
      result = { ok: false, skipped: false, cleanupVerified: false, artifacts: [] }
    }
    const item = sanitizePhaseEvidence(id, result)
    evidence.push(item)
    if (!item.ok || item.skipped || !item.cleanupVerified) break
  }
  return {
    schemaVersion: 1,
    complete: evidence.length === LIVE_PHASES.length
      && evidence.every(item => item.ok && !item.skipped && item.cleanupVerified),
    commit: safeOptions.commit,
    target: safeOptions.target,
    evidence,
  }
}

function parseEnvironment(text, expectedKeys) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error('release_validation_input_invalid')
    const name = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (Object.hasOwn(values, name) || !value || /[\r\n\0]/.test(value)) throw new Error('release_validation_input_invalid')
    values[name] = value
  }
  if (!exactKeys(values, expectedKeys)) throw new Error('release_validation_input_invalid')
  return values
}

function icacls(path) {
  return new Promise((resolvePromise, reject) => {
    execFile('icacls', [path], { windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error('release_validation_input_permissions_invalid'))
      else resolvePromise(stdout)
    })
  })
}

async function assertOwnerOnly(path, { statFile = stat, platform = process.platform } = {}) {
  const file = await statFile(path).catch(() => { throw new Error('release_validation_input_missing') })
  if (!file.isFile()) throw new Error('release_validation_input_missing')
  if (platform === 'win32') {
    const acl = await icacls(path)
    const accessLines = acl.split(/\r?\n/).filter(line => /:\((?:I\))?[A-Z]+\)/i.test(line))
    if (accessLines.length !== 1 || !/:\(F\)/i.test(accessLines[0])) {
      throw new Error('release_validation_input_permissions_invalid')
    }
    return
  }
  if ((file.mode & 0o777) !== 0o600) throw new Error('release_validation_input_permissions_invalid')
}

async function inputFileMetadata(path, { statFile, platform }) {
  const file = await statFile(path).catch(() => null)
  if (!file?.isFile()) return false
  // `icacls` is deliberately unavailable in readiness mode. Windows ACLs
  // cannot be proven owner-only with the Node stat metadata, so stay fail-closed.
  return platform !== 'win32' && (file.mode & 0o777) === 0o600
}

export async function checkReleaseValidationInputs({ fixtureEnv, secretsEnv, validationRoot, statFile = stat, platform = process.platform } = {}) {
  const fixture = requiredText(fixtureEnv, 'release_validation_input_missing')
  const secrets = requiredText(secretsEnv, 'release_validation_input_missing')
  const root = requiredText(validationRoot, 'release_validation_root_invalid')
  if (!isAbsolute(root) || !(await statFile(root).catch(() => null))?.isDirectory()) {
    throw new Error('release_validation_root_invalid')
  }
  const [fixtureReady, secretsReady] = await Promise.all([
    inputFileMetadata(fixture, { statFile, platform }),
    inputFileMetadata(secrets, { statFile, platform }),
  ])
  return {
    schemaVersion: 1,
    complete: false,
    mode: 'check-inputs',
    inputs: { fixture: fixtureReady, secrets: secretsReady, validationRoot: true },
  }
}

export async function validateReleaseValidationExecutionInputs({ fixtureEnv, secretsEnv, validationRoot } = {}) {
  const fixture = requiredText(fixtureEnv, 'release_validation_input_missing')
  const secrets = requiredText(secretsEnv, 'release_validation_input_missing')
  const root = requiredText(validationRoot, 'release_validation_root_invalid')
  if (!isAbsolute(root) || !(await stat(root).catch(() => null))?.isDirectory()) {
    throw new Error('release_validation_root_invalid')
  }
  await assertOwnerOnly(fixture)
  await assertOwnerOnly(secrets)
  parseEnvironment(await readFile(fixture, 'utf8'), FIXTURE_KEYS)
  parseEnvironment(await readFile(secrets, 'utf8'), SECRET_KEYS)
}

function boundedTimeout(value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > 600_000) throw new Error('release_validation_timeout_invalid')
  return value
}

function phaseDeadline(timeoutMs) {
  const controller = new AbortController()
  let rejectTimedOut
  const activeOperations = new Set()
  const timedOut = new Promise((_, reject) => { rejectTimedOut = reject })
  const timer = setTimeout(() => {
    controller.abort()
    rejectTimedOut(new Error('release_validation_phase_timeout'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    // Stateful or child-owning operations must call registerAbortAndJoin during
    // startup. Its callback must resolve true only after cancellation has been
    // acknowledged and every process/network side effect it owns is fenced.
    // Promise settlement alone is not accepted as that acknowledgement.
    async run(operation, { requiresAbortAndJoin = false } = {}) {
      if (controller.signal.aborted) throw new Error('release_validation_phase_timeout')
      let abortAndJoin = null
      let active
      const registerAbortAndJoin = candidate => {
        if (typeof candidate !== 'function' || abortAndJoin) throw new Error('release_validation_abort_join_invalid')
        abortAndJoin = candidate
      }
      const promise = Promise.resolve().then(() => operation({
        signal: controller.signal, timeoutMs, registerAbortAndJoin,
      }))
      active = { promise, requiresAbortAndJoin, get abortAndJoin() { return abortAndJoin } }
      activeOperations.add(active)
      const result = await Promise.race([
        promise.then(value => ({ value }), error => ({ error })),
        timedOut.then(() => ({ timedOut: true }), error => ({ timedOut: true, error })),
      ])
      if (result.timedOut) throw result.error || new Error('release_validation_phase_timeout')
      // Only stateless operations may leave the fence when they settle without
      // an acknowledgement. A state-changing or child-owning operation that
      // requires abort/join remains unsafe until teardown rejects the missing
      // acknowledgement, including when its promise rejected after startup.
      if (!active.requiresAbortAndJoin && typeof active.abortAndJoin !== 'function') activeOperations.delete(active)
      if (result.error) throw result.error
      return result.value
    },
    async abortAndJoin(timeoutMs) {
      const active = [...activeOperations]
      if (!active.length) return true
      controller.abort()
      const joined = await awaitBounded(Promise.all(active.map(operation => {
        if (operation.requiresAbortAndJoin && typeof operation.abortAndJoin !== 'function') return false
        return Promise.all([
          operation.promise.then(() => true, () => true),
          typeof operation.abortAndJoin === 'function'
            ? Promise.resolve().then(() => operation.abortAndJoin({ signal: controller.signal, timeoutMs })).then(value => value === true)
            : true,
        ]).then(values => values.every(Boolean))
      })).then(values => values.every(Boolean)), timeoutMs)
      if (joined.completed && joined.result === true) {
        for (const operation of active) activeOperations.delete(operation)
      }
      return joined.completed && joined.result === true
    },
    dispose() { clearTimeout(timer) },
  }
}

async function awaitBounded(promise, timeoutMs) {
  let timer
  const timeout = new Promise(resolvePromise => {
    timer = setTimeout(() => resolvePromise({ timedOut: true }), timeoutMs)
  })
  try {
    const outcome = await Promise.race([
      Promise.resolve(promise).then(result => ({ result }), () => ({ failed: true })),
      timeout,
    ])
    return { completed: !outcome.timedOut && !outcome.failed, result: outcome.result }
  } finally {
    clearTimeout(timer)
  }
}

async function boundedCleanup(operation, timeoutMs) {
  const controller = new AbortController()
  let abortAndJoin = null
  const registerAbortAndJoin = candidate => {
    if (typeof candidate !== 'function' || abortAndJoin) throw new Error('release_validation_abort_join_invalid')
    abortAndJoin = candidate
  }
  const pending = Promise.resolve().then(() => operation({
    signal: controller.signal, timeoutMs, registerAbortAndJoin,
  }))
  const initial = await awaitBounded(pending, timeoutMs)
  if (initial.completed) return initial

  controller.abort()
  if (typeof abortAndJoin !== 'function') return { completed: false }
  const joined = await awaitBounded(Promise.all([
    pending.then(() => true, () => true),
    Promise.resolve().then(() => abortAndJoin({ signal: controller.signal, timeoutMs })).then(value => value === true),
  ]).then(values => values.every(Boolean)), timeoutMs)
  return { completed: joined.completed && joined.result === true, result: joined.result }
}

// Every adapter operation receives `{ signal, timeoutMs, registerAbortAndJoin }`.
// Stateful and child-owning operations must register an acknowledgement before
// they can mutate state or launch a child. It must resolve true only after their
// cancellation has stopped the owned process tree or fenced the network change.
// On timeout this acknowledgement and the operation promise are both joined
// before restore/process cleanup; missing or non-cooperative joins fail closed.
export function createLiveValidationDependencies({
  processController, networkController, documentController, runCase, runCommand,
  phaseTimeoutMs, cleanupTimeoutMs,
} = {}) {
  if (typeof processController?.snapshot !== 'function' || typeof processController?.cleanup !== 'function'
    || typeof networkController?.snapshot !== 'function' || typeof networkController?.apply !== 'function'
    || typeof networkController?.restore !== 'function' || typeof documentController?.archivePhaseDocuments !== 'function'
    || typeof runCase !== 'function' || typeof runCommand !== 'function') {
    throw new Error('release_validation_adapter_invalid')
  }
  const phaseTimeout = boundedTimeout(phaseTimeoutMs, 15 * 60 * 1000)
  const cleanupTimeout = boundedTimeout(cleanupTimeoutMs, 60 * 1000)
  return {
    async runBoundedPhase(id, options) {
      const deadline = phaseDeadline(phaseTimeout)
      let baseline = null
      const networkMode = id.startsWith('network-') ? id.slice('network-'.length) : null
      let networkBaseline = null
      let outcome = { ok: false, skipped: false, artifacts: [] }
      let networkRestored = !networkMode
      let documentsArchived = false
      let processesCleaned = false
      let operationFenced = false
      try {
        baseline = await deadline.run(({ signal, timeoutMs }) => processController.snapshot({
          validationRoot: options.validationRoot, phase: id, signal, timeoutMs,
        }))
        if (networkMode) {
          networkBaseline = await deadline.run(({ signal, timeoutMs }) => networkController.snapshot({
            validationRoot: options.validationRoot, phase: id, signal, timeoutMs,
          }))
          await deadline.run(({ signal, timeoutMs, registerAbortAndJoin }) => networkController.apply(networkMode, {
            validationRoot: options.validationRoot, phase: id, signal, timeoutMs, registerAbortAndJoin,
          }), { requiresAbortAndJoin: true })
        }
        const work = async ({ signal, timeoutMs, registerAbortAndJoin }) => {
          if (id === 'package-windows') {
            return runCommand('npm', ['run', 'build:release', '--', '--target', options.target], {
              validationRoot: options.validationRoot, phase: id, signal, timeoutMs, registerAbortAndJoin,
            })
          }
          if (id.startsWith('dev-')) {
            return runCommand('npm', ['run', 'test:e2e:tauri'], {
              validationRoot: options.validationRoot, phase: id, signal, timeoutMs, registerAbortAndJoin,
            })
          }
          return runCase(id, options, { signal, timeoutMs, registerAbortAndJoin })
        }
        outcome = await deadline.run(({ signal, timeoutMs, registerAbortAndJoin }) => work({
          signal, timeoutMs, registerAbortAndJoin,
        }), { requiresAbortAndJoin: true })
      } catch {
        outcome = { ok: false, skipped: false, artifacts: [] }
      } finally {
        deadline.dispose()
        operationFenced = await deadline.abortAndJoin(cleanupTimeout)
        if (networkBaseline && operationFenced) {
          try {
            const cleanup = await boundedCleanup(({ signal, timeoutMs }) => networkController.restore(networkBaseline, {
              validationRoot: options.validationRoot, phase: id, signal, timeoutMs,
            }), cleanupTimeout)
            networkRestored = cleanup.completed && cleanup.result === true
          } catch {
            networkRestored = false
          }
        }
        try {
          const cleanup = await boundedCleanup(({ signal, timeoutMs }) => documentController.archivePhaseDocuments({
            validationRoot: options.validationRoot, phase: id, signal, timeoutMs,
          }), cleanupTimeout)
          documentsArchived = cleanup.completed
        } catch {}
        if (operationFenced) try {
          const cleanup = await boundedCleanup(({ signal, timeoutMs }) => processController.cleanup({
            baseline, validationRoot: options.validationRoot, phase: id, signal, timeoutMs,
          }), cleanupTimeout)
          processesCleaned = cleanup.completed && cleanup.result === true
        } catch {}
      }
      return { ...outcome, cleanupVerified: operationFenced && networkRestored && documentsArchived && processesCleaned }
    },
  }
}

function parseArgs(argv) {
  const args = { checkInputs: false, execute: false }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return { help: true }
    if (option === '--check-inputs' || option === '--execute') {
      args[option === '--check-inputs' ? 'checkInputs' : 'execute'] = true
      continue
    }
    if (!['--fixture-env', '--secrets-env', '--validation-root', '--commit', '--target', '--adapter'].includes(option)
      || !argv[index + 1]) throw new Error('release_validation_arguments_invalid')
    const key = option.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (args[key]) throw new Error('release_validation_arguments_invalid')
    args[key] = argv[index + 1]
    index += 1
  }
  if (!args.fixtureEnv || !args.secretsEnv || !args.validationRoot) throw new Error('release_validation_arguments_invalid')
  if (args.checkInputs && args.execute) throw new Error('release_validation_arguments_invalid')
  if (args.execute && (!args.commit || !args.target || !args.adapter)) throw new Error('release_validation_arguments_invalid')
  return args
}

async function loadExplicitAdapter(adapterPath, input) {
  const module = await import(pathToFileURL(resolve(adapterPath)).href)
  if (typeof module.createLiveValidationDependencies !== 'function') throw new Error('release_validation_adapter_invalid')
  const dependencies = await module.createLiveValidationDependencies(input)
  if (typeof dependencies?.runBoundedPhase !== 'function') throw new Error('release_validation_adapter_invalid')
  return dependencies
}

function usage() {
  return 'Usage: node scripts/validate-openclaw-release-live.mjs --check-inputs --fixture-env FILE --secrets-env FILE --validation-root E:\\release-validation\n\nExecution additionally requires --execute --commit SHA --target x86_64-pc-windows-msvc --adapter FILE. Without --execute, this command only reads input metadata and reports incomplete validation.'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!args.execute) {
    console.log(JSON.stringify(await checkReleaseValidationInputs(args)))
    return
  }
  await validateReleaseValidationExecutionInputs(args)
  const dependencies = await loadExplicitAdapter(args.adapter, {
    fixtureEnv: resolve(args.fixtureEnv),
    secretsEnv: resolve(args.secretsEnv),
    validationRoot: resolve(args.validationRoot),
  })
  console.log(JSON.stringify(await validateReleaseLive(args, dependencies)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message || error)
    process.exitCode = 1
  })
}
