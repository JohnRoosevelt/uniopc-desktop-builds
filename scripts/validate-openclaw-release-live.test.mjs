import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  LIVE_PHASES,
  checkReleaseValidationInputs,
  createLiveValidationDependencies,
  validateReleaseValidationExecutionInputs,
  validateReleaseLive,
} from './validate-openclaw-release-live.mjs'

const validOptions = {
  commit: '0123456789abcdef0123456789abcdef01234567',
  target: 'x86_64-pc-windows-msvc',
  validationRoot: 'E:\\Uniopc\\release-validation',
}

function registerImmediateAbortAndJoin(registerAbortAndJoin) {
  registerAbortAndJoin(async () => true)
}

function dependencies(calls, results = {}) {
  return {
    async runBoundedPhase(id) {
      calls.push(id)
      return results[id] || {
        ok: true,
        skipped: false,
        cleanupVerified: true,
        artifacts: [{ sha256: 'a'.repeat(64), kind: 'report' }],
      }
    },
  }
}

test('runs every required phase in order and records only sanitized schema-1 evidence', async () => {
  const calls = []
  const summary = await validateReleaseLive(validOptions, dependencies(calls))

  assert.deepEqual(calls, LIVE_PHASES)
  assert.equal(summary.schemaVersion, 1)
  assert.equal(summary.complete, true)
  assert.equal(summary.evidence.length, LIVE_PHASES.length)
  assert.equal(summary.evidence.every(item => item.ok && !item.skipped && item.cleanupVerified), true)
  assert.doesNotMatch(JSON.stringify(summary), /E:\\|token|password|https?:\/\//i)
})

test('a timeout, skip, cleanup leak, or missing artifact makes evidence incomplete and stops later phases', async () => {
  for (const [id, result] of Object.entries({
    'dev-normal': { ok: false, skipped: false, cleanupVerified: true, reason: 'timeout' },
    'dev-abnormal': { ok: true, skipped: true, cleanupVerified: true, artifacts: [{ sha256: 'a'.repeat(64), kind: 'report' }] },
    'dev-concurrent': { ok: true, skipped: false, cleanupVerified: false, artifacts: [{ sha256: 'a'.repeat(64), kind: 'report' }] },
    'package-windows': { ok: true, skipped: false, cleanupVerified: true, artifacts: [] },
  })) {
    const calls = []
    const summary = await validateReleaseLive(validOptions, dependencies(calls, { [id]: result }))
    assert.equal(summary.complete, false, id)
    assert.equal(calls.at(-1), id, id)
    assert.equal(summary.evidence.at(-1).id, id, id)
  }
})

test('explicit adapters restore cleanup after a failed network phase and use canonical package command', async () => {
  const calls = []
  const live = createLiveValidationDependencies({
    processController: {
      async snapshot() { calls.push('snapshot'); return { listenerIds: [] } },
      async cleanup() { calls.push('cleanup'); return true },
    },
    networkController: {
      async snapshot() { calls.push('network-snapshot'); return { mode: 'system' } },
      async apply(mode, { registerAbortAndJoin }) { calls.push(`network:${mode}`); registerImmediateAbortAndJoin(registerAbortAndJoin) },
      async restore(baseline) { calls.push(`restore:${baseline.mode}`); return true },
    },
    documentController: {
      async archivePhaseDocuments({ phase }) { calls.push(`archive:${phase}`) },
    },
    async runCase(id, _options, { registerAbortAndJoin }) {
      calls.push(`case:${id}`)
      registerImmediateAbortAndJoin(registerAbortAndJoin)
      throw new Error('controlled phase failure')
    },
    async runCommand(command, args, { registerAbortAndJoin }) {
      calls.push(`${command}:${args.join(' ')}`)
      registerImmediateAbortAndJoin(registerAbortAndJoin)
      return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'package' }] }
    },
  })

  const failed = await live.runBoundedPhase('network-offline', validOptions)
  assert.equal(failed.ok, false)
  assert.equal(failed.cleanupVerified, true)
  assert.deepEqual(calls, ['snapshot', 'network-snapshot', 'network:offline', 'case:network-offline', 'restore:system', 'archive:network-offline', 'cleanup'])

  calls.length = 0
  const packaged = await live.runBoundedPhase('package-windows', validOptions)
  assert.equal(packaged.ok, true)
  assert.deepEqual(calls, [
    'snapshot',
    'npm:run build:release -- --target x86_64-pc-windows-msvc',
    'archive:package-windows',
    'cleanup',
  ])
})

test('a delayed signal-ignoring network apply is joined before restore and cannot reapply after verified cleanup', async () => {
  const calls = []
  let state = 'system'
  let resolveApplied
  const applied = new Promise(resolvePromise => { resolveApplied = resolvePromise })
  const live = createLiveValidationDependencies({
    phaseTimeoutMs: 20,
    cleanupTimeoutMs: 100,
    processController: {
      async snapshot() { calls.push('snapshot'); return {} },
      async cleanup() { calls.push('cleanup'); return true },
    },
    networkController: {
      async snapshot() { calls.push('network-snapshot'); return { mode: 'system' } },
      async apply(mode, { registerAbortAndJoin } = {}) {
        calls.push('apply-start')
        if (registerAbortAndJoin) registerAbortAndJoin(async () => {
          await applied
          calls.push('apply-joined')
          return true
        })
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
        state = mode
        calls.push('apply-late')
        resolveApplied()
      },
      async restore(baseline) { state = baseline.mode; calls.push(`restore:${baseline.mode}`); return true },
    },
    documentController: { async archivePhaseDocuments() { calls.push('archive') } },
    async runCase(_id, _options, { registerAbortAndJoin }) { registerImmediateAbortAndJoin(registerAbortAndJoin); return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'report' }] } },
    async runCommand() { return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'report' }] } },
  })

  const result = await live.runBoundedPhase('network-offline', validOptions)
  assert.equal(result.ok, false)
  assert.equal(result.cleanupVerified, true)
  assert.equal(state, 'system')
  assert.deepEqual(calls, [
    'snapshot', 'network-snapshot', 'apply-start', 'apply-late', 'apply-joined',
    'restore:system', 'archive', 'cleanup',
  ])
})

test('a successful registered network apply is aborted and joined before restore', async () => {
  const calls = []
  let state = 'system'
  const live = createLiveValidationDependencies({
    phaseTimeoutMs: 100,
    cleanupTimeoutMs: 100,
    processController: {
      async snapshot() { calls.push('snapshot'); return {} },
      async cleanup() { calls.push('cleanup'); return true },
    },
    networkController: {
      async snapshot() { calls.push('network-snapshot'); return { mode: 'system' } },
      async apply(mode, { signal, registerAbortAndJoin } = {}) {
        calls.push('apply')
        state = mode
        registerAbortAndJoin(async () => {
          assert.equal(signal.aborted, true)
          calls.push('apply-joined')
          return true
        })
      },
      async restore(baseline) { state = baseline.mode; calls.push(`restore:${baseline.mode}`); return true },
    },
    documentController: { async archivePhaseDocuments() { calls.push('archive') } },
    async runCase(id, _options, { registerAbortAndJoin }) { calls.push(`case:${id}`); registerImmediateAbortAndJoin(registerAbortAndJoin); return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'report' }] } },
    async runCommand() { return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'report' }] } },
  })

  const result = await live.runBoundedPhase('network-offline', validOptions)
  assert.equal(result.ok, true)
  assert.equal(result.cleanupVerified, true)
  assert.equal(state, 'system')
  assert.deepEqual(calls, [
    'snapshot', 'network-snapshot', 'apply', 'case:network-offline', 'apply-joined',
    'restore:system', 'archive', 'cleanup',
  ])
})

test('a rejected network apply is aborted and joined before restore cannot reapply after verified cleanup', async () => {
  const calls = []
  let state = 'system'
  let applySignal
  let resolveApplied
  const applied = new Promise(resolvePromise => { resolveApplied = resolvePromise })
  const live = createLiveValidationDependencies({
    phaseTimeoutMs: 100,
    cleanupTimeoutMs: 100,
    processController: {
      async snapshot() { calls.push('snapshot'); return {} },
      async cleanup() { calls.push('cleanup'); return true },
    },
    networkController: {
      async snapshot() { calls.push('network-snapshot'); return { mode: 'system' } },
      async apply(mode, { signal, registerAbortAndJoin } = {}) {
        applySignal = signal
        calls.push('apply-start')
        registerAbortAndJoin(async () => {
          assert.equal(signal.aborted, true)
          await applied
          calls.push('apply-joined')
          return true
        })
        setTimeout(() => {
          state = mode
          calls.push('apply-late')
          resolveApplied()
        }, 50)
        throw new Error('apply-rejected-after-start')
      },
      async restore(baseline) { state = baseline.mode; calls.push(`restore:${baseline.mode}`); return true },
    },
    documentController: { async archivePhaseDocuments() { calls.push('archive') } },
    async runCase(_id, _options, { registerAbortAndJoin }) { registerImmediateAbortAndJoin(registerAbortAndJoin); return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'report' }] } },
    async runCommand() { return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'report' }] } },
  })

  const result = await live.runBoundedPhase('network-offline', validOptions)
  await applied
  assert.equal(result.ok, false)
  assert.equal(result.cleanupVerified, true)
  assert.equal(applySignal.aborted, true)
  assert.equal(state, 'system')
  assert.deepEqual(calls, [
    'snapshot', 'network-snapshot', 'apply-start', 'apply-late', 'apply-joined',
    'restore:system', 'archive', 'cleanup',
  ])
})

test('an immediately rejected unacknowledged network apply remains fenced before its delayed offline side effect', async () => {
  const calls = []
  let state = 'system'
  let resolveApplied
  const applied = new Promise(resolvePromise => { resolveApplied = resolvePromise })
  const live = createLiveValidationDependencies({
    phaseTimeoutMs: 100,
    cleanupTimeoutMs: 20,
    processController: {
      async snapshot() { calls.push('snapshot'); return {} },
      async cleanup() { calls.push('cleanup'); return true },
    },
    networkController: {
      async snapshot() { calls.push('network-snapshot'); return { mode: 'system' } },
      async apply(mode) {
        calls.push('apply-start')
        setTimeout(() => {
          state = mode
          calls.push('apply-late')
          resolveApplied()
        }, 50)
        throw new Error('apply-rejected-without-acknowledgement')
      },
      async restore(baseline) { state = baseline.mode; calls.push(`restore:${baseline.mode}`); return true },
    },
    documentController: { async archivePhaseDocuments() { calls.push('archive') } },
    async runCase() { return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'report' }] } },
    async runCommand() { return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'report' }] } },
  })

  const result = await live.runBoundedPhase('network-offline', validOptions)
  await applied
  assert.equal(result.ok, false)
  assert.equal(result.cleanupVerified, false)
  assert.equal(state, 'offline')
  assert.deepEqual(calls, ['snapshot', 'network-snapshot', 'apply-start', 'archive', 'apply-late'])
})

test('an unacknowledged timed-out mutating operation is unsafe: no restore or process cleanup is claimed', async () => {
  const calls = []
  const live = createLiveValidationDependencies({
    phaseTimeoutMs: 20,
    cleanupTimeoutMs: 20,
    processController: {
      async snapshot() { calls.push('snapshot'); return {} },
      async cleanup() { calls.push('cleanup'); return true },
    },
    networkController: {
      async snapshot() { calls.push('network-snapshot'); return { mode: 'system' } },
      async apply() { calls.push('apply'); return new Promise(() => {}) },
      async restore() { calls.push('restore'); return true },
    },
    documentController: { async archivePhaseDocuments() { calls.push('archive') } },
    async runCase() { return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'report' }] } },
    async runCommand() { return { ok: true, skipped: false, artifacts: [{ sha256: 'b'.repeat(64), kind: 'report' }] } },
  })

  const result = await live.runBoundedPhase('network-offline', validOptions)
  assert.equal(result.ok, false)
  assert.equal(result.cleanupVerified, false)
  assert.deepEqual(calls, ['snapshot', 'network-snapshot', 'apply', 'archive'])
})

test('a never-settling network case is cancelled, bounded, fenced unsafe, and stops the sequence', async () => {
  const calls = []
  let caseSignal
  const live = createLiveValidationDependencies({
    phaseTimeoutMs: 20,
    cleanupTimeoutMs: 20,
    processController: {
      async snapshot() { calls.push('snapshot'); return { listenerIds: [] } },
      async cleanup() { calls.push('cleanup'); return true },
    },
    networkController: {
      async snapshot() { calls.push('network-snapshot'); return { mode: 'system' } },
      async apply(mode, { registerAbortAndJoin }) {
        calls.push(`network:${mode}`)
        if (mode !== 'offline') registerImmediateAbortAndJoin(registerAbortAndJoin)
      },
      async restore(baseline) { calls.push(`restore:${baseline.mode}`); return true },
    },
    documentController: {
      async archivePhaseDocuments({ phase }) { calls.push(`archive:${phase}`) },
    },
    async runCase(id, _options, { signal, registerAbortAndJoin }) {
      calls.push(`case:${id}`)
      if (id !== 'network-offline') {
        registerImmediateAbortAndJoin(registerAbortAndJoin)
        return { ok: true, skipped: false, artifacts: [{ sha256: 'c'.repeat(64), kind: 'report' }] }
      }
      caseSignal = signal
      return new Promise(() => {})
    },
    async runCommand(command, args, { registerAbortAndJoin }) {
      calls.push(`${command}:${args.join(' ')}`)
      registerImmediateAbortAndJoin(registerAbortAndJoin)
      return { ok: true, skipped: false, artifacts: [{ sha256: 'd'.repeat(64), kind: 'package' }] }
    },
  })

  const invoked = []
  const summary = await validateReleaseLive(validOptions, {
    async runBoundedPhase(id, options) {
      invoked.push(id)
      return live.runBoundedPhase(id, options)
    },
  })

  assert.equal(summary.complete, false)
  assert.equal(summary.evidence.at(-1).id, 'network-offline')
  assert.equal(summary.evidence.at(-1).ok, false)
  assert.equal(summary.evidence.at(-1).cleanupVerified, false)
  assert.equal(caseSignal.aborted, true)
  assert.equal(invoked.includes('network-tun-fake-ip'), false)
  assert.deepEqual(calls.slice(-5), [
    'snapshot',
    'network-snapshot',
    'network:offline',
    'case:network-offline',
    'archive:network-offline',
  ])
})

test('a never-settling package command receives cancellation but cannot claim cleanup without a join acknowledgement', async () => {
  const calls = []
  let commandSignal
  const live = createLiveValidationDependencies({
    phaseTimeoutMs: 20,
    cleanupTimeoutMs: 20,
    processController: {
      async snapshot() { calls.push('snapshot'); return {} },
      async cleanup() { calls.push('cleanup'); return true },
    },
    networkController: {
      async snapshot() { return {} },
      async apply() {},
      async restore() { return true },
    },
    documentController: {
      async archivePhaseDocuments() { calls.push('archive') },
    },
    async runCase() {
      return { ok: true, skipped: false, artifacts: [{ sha256: 'd'.repeat(64), kind: 'report' }] }
    },
    async runCommand(_command, _args, { signal }) {
      calls.push('package-command')
      commandSignal = signal
      return new Promise(() => {})
    },
  })

  const result = await live.runBoundedPhase('package-windows', validOptions)
  assert.equal(result.ok, false)
  assert.equal(result.cleanupVerified, false)
  assert.equal(commandSignal.aborted, true)
  assert.deepEqual(calls, ['snapshot', 'package-command', 'archive'])
})

test('hung cleanup is bounded and still reaches subsequent cleanup steps', async () => {
  const calls = []
  const live = createLiveValidationDependencies({
    phaseTimeoutMs: 20,
    cleanupTimeoutMs: 20,
    processController: {
      async snapshot() { return {} },
      async cleanup() { calls.push('process-cleanup'); return true },
    },
    networkController: {
      async snapshot() { return {} },
      async apply() {},
      async restore() { return true },
    },
    documentController: {
      async archivePhaseDocuments() { calls.push('archive'); return new Promise(() => {}) },
    },
    async runCase(_id, _options, { registerAbortAndJoin }) {
      registerImmediateAbortAndJoin(registerAbortAndJoin)
      return { ok: true, skipped: false, artifacts: [{ sha256: 'e'.repeat(64), kind: 'report' }] }
    },
    async runCommand() {
      return { ok: true, skipped: false, artifacts: [{ sha256: 'e'.repeat(64), kind: 'report' }] }
    },
  })

  const result = await live.runBoundedPhase('updater-pre', validOptions)
  assert.equal(result.ok, true)
  assert.equal(result.cleanupVerified, false)
  assert.deepEqual(calls, ['archive', 'process-cleanup'])
})

test('completed cleanup does not retain its timeout handle', () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'validate-openclaw-release-live.mjs')).href
  const child = `
    import { createLiveValidationDependencies } from ${JSON.stringify(moduleUrl)};
    const live = createLiveValidationDependencies({
      cleanupTimeoutMs: 1000,
      processController: { snapshot: async () => ({}), cleanup: async () => true },
      networkController: { snapshot: async () => ({}), apply: async () => {}, restore: async () => true },
      documentController: { archivePhaseDocuments: async () => {} },
      runCase: async (_id, _options, { registerAbortAndJoin }) => { registerAbortAndJoin(async () => true); return { ok: true, skipped: false, artifacts: [{ kind: 'report', sha256: 'f'.repeat(64) }] } },
      runCommand: async () => ({ ok: true, skipped: false, artifacts: [{ kind: 'report', sha256: 'f'.repeat(64) }] }),
    });
    await live.runBoundedPhase('updater-pre', { commit: '0123456789abcdef0123456789abcdef01234567', target: 'x86_64-pc-windows-msvc', validationRoot: 'E:\\\\Uniopc\\\\release-validation' });
  `
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', child], {
    timeout: 400,
    windowsHide: true,
  }))
})

test('check-inputs examines metadata only and leaves body and ACL validation to the explicit execute boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-live-validation-'))
  const fixtureEnv = join(root, 'fixture.env')
  const secretsEnv = join(root, 'secrets.env')
  await writeFile(fixtureEnv, 'fixture-password-and-invalid-body')
  await writeFile(secretsEnv, 'release-token-and-invalid-body')
  if (process.platform !== 'win32') {
    await chmod(fixtureEnv, 0o600)
    await chmod(secretsEnv, 0o600)
  } else {
    const owner = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    for (const file of [fixtureEnv, secretsEnv]) {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${owner}:(F)`], { windowsHide: true })
    }
  }

  const checked = await checkReleaseValidationInputs({ fixtureEnv, secretsEnv, validationRoot: root })
  assert.equal(checked.schemaVersion, 1)
  assert.equal(checked.complete, false)
  assert.equal(checked.mode, 'check-inputs')
  assert.equal(checked.inputs.validationRoot, true)
  assert.equal(checked.inputs.fixture, process.platform !== 'win32')
  assert.equal(checked.inputs.secrets, process.platform !== 'win32')
  assert.doesNotMatch(JSON.stringify(checked), /password|token|private-key|release-validation@example/i)

  if (process.platform !== 'win32') {
    await assert.rejects(
      () => validateReleaseValidationExecutionInputs({ fixtureEnv, secretsEnv, validationRoot: root }),
      /release_validation_input_invalid/,
    )

    await chmod(secretsEnv, 0o644)
    await assert.rejects(
      () => validateReleaseValidationExecutionInputs({ fixtureEnv, secretsEnv, validationRoot: root }),
      /release_validation_input_permissions_invalid/,
    )
  }
})

test('execute parses protected input bodies before loading an adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-live-validation-execute-'))
  const fixtureEnv = join(root, 'fixture.env')
  const secretsEnv = join(root, 'secrets.env')
  await writeFile(fixtureEnv, 'invalid-fixture-body')
  await writeFile(secretsEnv, 'invalid-secret-body')
  if (process.platform !== 'win32') {
    await chmod(fixtureEnv, 0o600)
    await chmod(secretsEnv, 0o600)
  } else {
    const owner = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    for (const file of [fixtureEnv, secretsEnv]) {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${owner}:(F)`], { windowsHide: true })
    }
  }

  assert.throws(() => execFileSync(process.execPath, [
    join(process.cwd(), 'scripts', 'validate-openclaw-release-live.mjs'),
    '--execute',
    '--fixture-env', fixtureEnv,
    '--secrets-env', secretsEnv,
    '--validation-root', root,
    '--commit', '0123456789abcdef0123456789abcdef01234567',
    '--target', 'x86_64-pc-windows-msvc',
    '--adapter', join(root, 'not-loaded.mjs'),
  ], { encoding: 'utf8', windowsHide: true }), error => {
    assert.match(String(error.stderr), /release_validation_input_invalid/)
    return true
  })
})

test('check-inputs uses only injected stat metadata and Windows returns incomplete without spawning ACL inspection', async () => {
  const calls = []
  const file = { isFile: () => true, isDirectory: () => false, mode: 0o600 }
  const directory = { isFile: () => false, isDirectory: () => true, mode: 0o700 }
  const checked = await checkReleaseValidationInputs({
    fixtureEnv: 'E:\\release-validation\\fixture.env',
    secretsEnv: 'E:\\release-validation\\secrets.env',
    validationRoot: 'E:\\release-validation',
    platform: 'win32',
    statFile: async (path) => {
      calls.push(path)
      return path.endsWith('release-validation') ? directory : file
    },
  })

  assert.deepEqual(calls, [
    'E:\\release-validation',
    'E:\\release-validation\\fixture.env',
    'E:\\release-validation\\secrets.env',
  ])
  assert.deepEqual(checked, {
    schemaVersion: 1,
    complete: false,
    mode: 'check-inputs',
    inputs: { fixture: false, secrets: false, validationRoot: true },
  })
})
